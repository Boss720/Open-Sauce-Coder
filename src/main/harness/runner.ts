/**
 * Single-agent execution loop for the agentic harness.
 *
 * Manages the conversation, tool-call cycles, budget tracking, and abort
 * semantics. Each AgentRunner instance handles ONE agent run.
 */
import type { AgentProfile } from './profiles'
import type {
  ProviderAdapter,
  ChatMessage,
  ChatRequest,
  ChatResponse,
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

/** Maximum tool-call rounds per run — safety cap against infinite loops. */
const MAX_TOOL_ROUNDS = 20

/** Default max turns when the profile doesn't specify one. */
const DEFAULT_MAX_TURNS = 50

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
    return {}
  } catch {
    return {}
  }
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
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (this.abortController.signal.aborted) {
          return this.finish('aborted', '', toolCallCount, onEvent)
        }

        // Budget check before each turn
        if (this.profile.tokenBudget && this.totalUsage.input >= this.profile.tokenBudget) {
          onEvent({ type: 'budget_warning', field: 'tokenBudget', used: this.totalUsage.input, limit: this.profile.tokenBudget })
          return this.finish('budget_exceeded', '', toolCallCount, onEvent)
        }
        if (this.turns >= maxTurns) {
          return this.finish('max_turns', '', toolCallCount, onEvent)
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
          billingRoute: this.profile.billingRoute
        }

        // Call provider
        let response: ChatResponse
        try {
          response = await this.adapter.chat(request)
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

        // Emit thinking content if present
        if (response.thinkingContent) {
          onEvent({ type: 'thinking', content: response.thinkingContent })
        }

        // Emit text content
        if (response.content.length > 0) {
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
            onEvent({
              type: 'tool_result',
              name: toolName,
              output: '',
              error: policyViolation
            })
            messages.push({
              role: 'tool',
              content: `Error: ${policyViolation}`,
              tool_call_id: tc.id
            })
            continue
          }

          const args = parseToolArgs(tc.function.arguments)
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

          onEvent({
            type: 'tool_result',
            name: toolName,
            output: result.output.slice(0, 2000),
            error: result.error
          })

          // Append tool result as a tool message
          messages.push({
            role: 'tool',
            content: result.error
              ? `Error: ${result.error}\n${result.output}`
              : result.output,
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
