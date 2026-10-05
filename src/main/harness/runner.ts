/**
 * Single-agent execution loop for the agentic harness.
 *
 * Manages the conversation, tool-call cycles, budget tracking, streaming deltas,
 * repetitive loop detection, context window protection, and abort semantics.
 * Each AgentRunner instance handles ONE agent run.
 */
import type { AgentProfile } from './profiles'
import type {
  ProviderAdapter,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatDelta,
  FunctionDefinition
} from './providers/adapter'
import type { ToolRegistry, ToolContext } from './tools/registry'
import { policyBroker } from '../policyBroker'

export type RunnerEvent =
  | { type: 'thinking'; content: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; output: string; error?: string }
  | { type: 'error'; message: string }
  | { type: 'done'; result: RunnerResult }
  | { type: 'budget_warning'; field: string; used: number; limit: number }

export type RunnerResult = {
  content: string
  toolCallCount: number
  usage: { input: number; output: number; reasoning?: number }
  turns: number
  finishReason: 'complete' | 'budget_exceeded' | 'max_turns' | 'aborted' | 'error'
  error?: string
}

/** Default max turns when the profile doesn't specify one. */
const DEFAULT_MAX_TURNS = 50

/** Maximum characters per tool output inserted into message history. */
const MAX_TOOL_OUTPUT_CHARS = 30_000

/** Consecutive identical failing calls before loop guidance warning. */
const REPETITIVE_CALL_LIMIT = 3

export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj) ?? 'null'
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']'
  }
  const record = obj as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const entries: string[] = []
  for (const k of keys) {
    const v = record[k]
    if (v !== undefined) {
      entries.push(JSON.stringify(k) + ':' + canonicalJson(v))
    }
  }
  return '{' + entries.join(',') + '}'
}

export function parseToolArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; raw: string; error: string } {
  try {
    if (!raw || raw.trim().length === 0) {
      return { ok: true, args: {} }
    }
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, args: parsed as Record<string, unknown> }
    }
    const receivedType = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed
    return {
      ok: false,
      raw,
      error: `Expected a JSON object, but received ${receivedType}`
    }
  } catch (err) {
    return {
      ok: false,
      raw,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export function truncateToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output
  return (
    output.slice(0, MAX_TOOL_OUTPUT_CHARS) +
    `\n\n[Output truncated: showing first ${MAX_TOOL_OUTPUT_CHARS.toLocaleString()} of ${output.length.toLocaleString()} characters...]`
  )
}

export class AgentRunner {
  readonly id: string

  private readonly profile: AgentProfile
  private readonly adapter: ProviderAdapter
  private readonly tools: ToolRegistry
  private readonly directory: string
  private readonly abortController = new AbortController()
  private activeRequestId: string | null = null
  private turns = 0
  private totalUsage = { input: 0, output: 0, reasoning: 0 }
  private running = false

  // Repetitive call loop tracking
  private lastCallSignature = ''
  private consecutiveFailureCount = 0

  constructor(params: {
    id: string
    profile: AgentProfile
    adapter: ProviderAdapter
    tools: ToolRegistry
    directory: string
  }) {
    this.id = params.id
    this.profile = params.profile
    this.adapter = params.adapter
    this.tools = params.tools
    this.directory = params.directory
  }

  abort(): void {
    this.abortController.abort()
    if (this.activeRequestId) {
      this.adapter.abort(this.activeRequestId)
    }
    this.adapter.abort(this.id)
  }

  getStatus(): { turns: number; usage: { input: number; output: number; reasoning?: number }; running: boolean } {
    const usage = this.totalUsage.reasoning > 0
      ? { input: this.totalUsage.input, output: this.totalUsage.output, reasoning: this.totalUsage.reasoning }
      : { input: this.totalUsage.input, output: this.totalUsage.output }
    return { turns: this.turns, usage, running: this.running }
  }

  async run(task: string, onEvent: (e: RunnerEvent) => void): Promise<RunnerResult> {
    this.running = true
    let toolCallCount = 0
    const maxTurns = this.profile.maxTurns ?? DEFAULT_MAX_TURNS

    // Build initial messages
    const messages: ChatMessage[] = []
    const systemPrompt = this.profile.systemPrompt
    if (systemPrompt && systemPrompt.length > 0) {
      messages.push({ role: 'system', content: systemPrompt })
    }
    messages.push({ role: 'user', content: task })

    // Get tool schemas filtered by profile
    const toolDefinitions = this.tools.forProfile(this.profile)
    const toolSchemas: FunctionDefinition[] = toolDefinitions.map((def) => ({
      type: 'function' as const,
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters
      }
    }))

    try {
      while (this.turns < maxTurns) {
        if (this.abortController.signal.aborted) {
          return this.finish('aborted', '', toolCallCount, onEvent)
        }

        // Budget check before each turn
        if (this.profile.tokenBudget && this.totalUsage.input >= this.profile.tokenBudget) {
          onEvent({ type: 'budget_warning', field: 'tokenBudget', used: this.totalUsage.input, limit: this.profile.tokenBudget })
          return this.finish('budget_exceeded', '', toolCallCount, onEvent)
        }

        // Build request
        const requestId = `${this.id}-turn-${this.turns}`
        this.activeRequestId = requestId
        const request: ChatRequest = {
          requestId,
          signal: this.abortController.signal,
          model: this.profile.model,
          messages: [...messages],
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          temperature: this.profile.temperature,
          maxTokens: this.profile.maxTokens,
          topP: this.profile.topP,
          thinking: this.profile.thinking,
          routingSuffix: this.profile.routingSuffix,
          caching: this.profile.caching,
          billingRoute: this.profile.billingRoute,
          baseUrl: this.profile.baseUrl
        }

        let streamedThinking = false
        let streamedText = false

        const onDelta = (delta: ChatDelta): void => {
          if (this.abortController.signal.aborted || !this.running) return
          if (delta.thinkingContent && delta.thinkingContent.length > 0) {
            streamedThinking = true
            onEvent({ type: 'thinking', content: delta.thinkingContent })
          }
          if (delta.content && delta.content.length > 0) {
            streamedText = true
            onEvent({ type: 'text', delta: delta.content })
          }
        }

        // Call provider
        let response: ChatResponse
        try {
          response = await this.adapter.chat(request, onDelta)
        } finally {
          this.activeRequestId = null
        }

        if (this.abortController.signal.aborted) {
          return this.finish('aborted', '', toolCallCount, onEvent)
        }

        this.turns++

        // Track usage
        this.totalUsage.input += response.usage.input
        this.totalUsage.output += response.usage.output
        if (response.usage.reasoning) {
          this.totalUsage.reasoning += response.usage.reasoning
        }

        // Emit thinking content if present and not already streamed via deltas
        if (response.thinkingContent && !streamedThinking) {
          onEvent({ type: 'thinking', content: response.thinkingContent })
        }

        // Emit text content if present and not already streamed via deltas
        if (response.content.length > 0 && !streamedText) {
          onEvent({ type: 'text', delta: response.content })
        }

        // No tool calls → agent is done
        if (response.finishReason !== 'tool_calls' || !response.toolCalls || response.toolCalls.length === 0) {
          return this.finish('complete', response.content, toolCallCount, onEvent)
        }

        // Append assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: response.content.length > 0 ? response.content : null,
          tool_calls: response.toolCalls
        })

        // Execute each tool call
        for (const tc of response.toolCalls) {
          if (this.abortController.signal.aborted) {
            return this.finish('aborted', '', toolCallCount, onEvent)
          }

          const toolName = tc.function.name

          // Validate JSON tool arguments
          const parseResult = parseToolArgs(tc.function.arguments)
          if (!parseResult.ok) {
            toolCallCount++
            const malformedError = `Error: Tool arguments were not valid JSON (${parseResult.error}): "${parseResult.raw}". Please retry with valid JSON parameters matching the "${toolName}" schema.`
            onEvent({
              type: 'tool_result',
              name: toolName,
              output: '',
              error: malformedError
            })
            messages.push({
              role: 'tool',
              content: malformedError,
              tool_call_id: tc.id
            })
            continue
          }

          const args = parseResult.args
          const callSignature = `${toolName}:${canonicalJson(args)}`

          // Check for repetitive failing tool call loop (3+ consecutive identical failures)
          if (callSignature === this.lastCallSignature && this.consecutiveFailureCount >= REPETITIVE_CALL_LIMIT) {
            toolCallCount++
            const loopWarning = `System Warning: You have called "${toolName}" with identical arguments 3 times without progress. Please choose an alternative approach or explain the blocker.`
            onEvent({
              type: 'tool_result',
              name: toolName,
              output: '',
              error: loopWarning
            })
            messages.push({
              role: 'tool',
              content: loopWarning,
              tool_call_id: tc.id
            })
            continue
          }

          const resolvedTool = this.tools.resolve(toolName)
          let policyViolation: string | null = null

          if (!resolvedTool) {
            policyViolation = `Tool not found: ${toolName}`
          } else {
            const evaluation = await policyBroker.evaluate(resolvedTool.definition, {
              directory: this.directory,
              profile: this.profile
            })
            if (!evaluation.allowed) {
              policyViolation = evaluation.reason ?? `Tool "${toolName}" is not permitted by project policy.`
            }
          }

          if (policyViolation) {
            // Track failure
            if (callSignature === this.lastCallSignature) {
              this.consecutiveFailureCount++
            } else {
              this.lastCallSignature = callSignature
              this.consecutiveFailureCount = 1
            }

            let policyError = policyViolation
            if (this.consecutiveFailureCount >= REPETITIVE_CALL_LIMIT) {
              const warning = `\n\nSystem Warning: You have called "${toolName}" with identical arguments 3 times without progress. Please choose an alternative approach or explain the blocker.`
              policyError += warning
            }

            onEvent({
              type: 'tool_result',
              name: toolName,
              output: '',
              error: policyError
            })
            messages.push({
              role: 'tool',
              content: truncateToolOutput(`Error: ${policyError}`),
              tool_call_id: tc.id
            })
            continue
          }

          onEvent({ type: 'tool_call', name: toolName, args })
          toolCallCount++

          const context: ToolContext = {
            directory: this.directory,
            agentId: this.profile.id,
            runId: this.id,
            abortSignal: this.abortController.signal,
            profile: this.profile
          }

          const result = await this.tools.execute(toolName, args, context)

          if (this.abortController.signal.aborted) {
            return this.finish('aborted', '', toolCallCount, onEvent)
          }

          // Loop failure detection tracking
          if (result.error) {
            if (callSignature === this.lastCallSignature) {
              this.consecutiveFailureCount++
            } else {
              this.lastCallSignature = callSignature
              this.consecutiveFailureCount = 1
            }

            if (this.consecutiveFailureCount >= REPETITIVE_CALL_LIMIT) {
              const warning = `\n\nSystem Warning: You have called "${toolName}" with identical arguments 3 times without progress. Please choose an alternative approach or explain the blocker.`
              result.error += warning
            }
          } else {
            // Successful execution resets failure tracking
            this.consecutiveFailureCount = 0
            this.lastCallSignature = ''
          }

          onEvent({
            type: 'tool_result',
            name: toolName,
            output: result.output.slice(0, 2000),
            error: result.error
          })

          // Append tool result as a tool message with 30k char context window protection
          const toolMessageContent = result.error
            ? `Error: ${result.error}\n${result.output}`
            : result.output

          messages.push({
            role: 'tool',
            content: truncateToolOutput(toolMessageContent),
            tool_call_id: tc.id
          })
        }
      }

      // Exhausted tool rounds
      return this.finish('max_turns', '', toolCallCount, onEvent)

    } catch (error) {
      if (this.abortController.signal.aborted) {
        return this.finish('aborted', '', toolCallCount, onEvent)
      }
      const message = error instanceof Error ? error.message : String(error)
      onEvent({ type: 'error', message })
      return this.finish('error', '', toolCallCount, onEvent, message)
    } finally {
      this.running = false
    }
  }

  private finish(
    finishReason: RunnerResult['finishReason'],
    content: string,
    toolCallCount: number,
    onEvent: (e: RunnerEvent) => void,
    error?: string
  ): RunnerResult {
    const usage = this.totalUsage.reasoning > 0
      ? { input: this.totalUsage.input, output: this.totalUsage.output, reasoning: this.totalUsage.reasoning }
      : { input: this.totalUsage.input, output: this.totalUsage.output }

    const result: RunnerResult = {
      content,
      toolCallCount,
      usage,
      turns: this.turns,
      finishReason
    }
    if (error) result.error = error

    onEvent({ type: 'done', result })
    return result
  }
}
