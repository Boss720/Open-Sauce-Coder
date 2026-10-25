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
  FunctionDefinition,
  ToolCall
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

/** Maximum characters of a tool's error text kept ahead of the loop guidance. */
const MAX_TOOL_ERROR_CHARS = 10_000

/** Maximum characters of malformed raw arguments echoed back to the model. */
const MAX_RAW_ARGS_ECHO_CHARS = 500

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

export function truncateToolOutput(output: string, limit: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (output.length <= limit) return output
  return (
    output.slice(0, limit) +
    `\n\n[Output truncated: showing first ${limit.toLocaleString()} of ${output.length.toLocaleString()} characters...]`
  )
}

function loopWarning(toolName: string): string {
  return `System Warning: You have called "${toolName}" with identical arguments ${REPETITIVE_CALL_LIMIT} times without progress. Please choose an alternative approach or explain the blocker.`
}

function toUsageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
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
    // Abort the shared signal first: it reaches request.signal and every ToolContext.abortSignal
    // even if an adapter's own abort() misbehaves.
    this.abortController.abort()
    const requestIds = this.activeRequestId ? [this.activeRequestId, this.id] : [this.id]
    for (const requestId of requestIds) {
      try {
        this.adapter.abort(requestId)
      } catch {
        // An adapter failing to cancel must never stop the runner from cancelling.
      }
    }
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
    const signal = this.abortController.signal

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

    /**
     * Report one tool call's outcome: emit the UI event and append exactly one tool message for
     * the call. Every path that answers a tool_call id goes through here so the 30k context
     * guard can never be bypassed.
     */
    const answerToolCall = (
      tc: ToolCall,
      toolName: string,
      content: string,
      event: { output: string; error?: string }
    ): void => {
      onEvent({
        type: 'tool_result',
        name: toolName,
        output: event.output.slice(0, 2000),
        ...(event.error !== undefined ? { error: truncateToolOutput(event.error) } : {})
      })
      messages.push({
        role: 'tool',
        content: truncateToolOutput(content),
        tool_call_id: tc.id
      })
    }

    try {
      while (this.turns < maxTurns) {
        if (signal.aborted) {
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
          signal,
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
          baseUrl: this.profile.baseUrl,
          directory: this.directory
        }

        let streamedThinking = false
        let streamedText = false

        const onDelta = (delta: ChatDelta): void => {
          if (signal.aborted || !this.running) return
          if (delta.thinkingContent && delta.thinkingContent.length > 0) {
            streamedThinking = true
            onEvent({ type: 'thinking', content: delta.thinkingContent })
          }
          if (delta.content && delta.content.length > 0) {
            streamedText = true
            onEvent({ type: 'text', delta: delta.content })
          }
        }

        // Call provider. Racing the abort signal keeps Stop responsive even if an adapter
        // does not honour request.signal.
        let response: ChatResponse
        try {
          response = await this.raceAbort(this.adapter.chat(request, onDelta))
        } finally {
          this.activeRequestId = null
        }

        // A response that came back was billed: account for it even if abort raced it.
        this.turns++
        this.addUsage(response.usage)

        if (signal.aborted) {
          return this.finish('aborted', '', toolCallCount, onEvent)
        }

        const content = typeof response.content === 'string' ? response.content : ''
        const toolCalls = response.toolCalls ?? []

        // Emit thinking content if present and not already streamed via deltas
        if (response.thinkingContent && !streamedThinking) {
          onEvent({ type: 'thinking', content: response.thinkingContent })
        }

        // Emit text content if present and not already streamed via deltas
        if (content.length > 0 && !streamedText) {
          onEvent({ type: 'text', delta: content })
        }

        // No tool calls → agent is done (or the provider reported a failure)
        if (toolCalls.length === 0) {
          if (response.finishReason === 'error') {
            const message = 'Provider returned an error response (finish reason "error") with no content or tool calls to act on.'
            onEvent({ type: 'error', message })
            return this.finish('error', content, toolCallCount, onEvent, message)
          }
          return this.finish('complete', content, toolCallCount, onEvent)
        }

        // Append assistant message with tool calls. Tool calls are honoured whatever finish
        // reason the provider chose (Gemini and some OpenAI-compatible servers report "stop").
        messages.push({
          role: 'assistant',
          content: content.length > 0 ? content : null,
          tool_calls: toolCalls,
          ...(response.providerReplay ? { providerReplay: response.providerReplay } : {})
        })

        // Output-limit cut-off: the arguments are likely incomplete, so execute nothing. Every
        // call still gets its tool message so the model can retry with a smaller call.
        if (response.finishReason === 'length') {
          for (const tc of toolCalls) {
            toolCallCount++
            const toolName = tc.function.name
            const cutOff = `Error: Your response hit the output token limit while generating the "${toolName}" tool call, so the call was cut off and was NOT executed (its arguments are likely incomplete). Retry with a smaller call, for example by splitting large content across several calls.`
            answerToolCall(tc, toolName, cutOff, { output: '', error: cutOff })
          }
          continue
        }

        // Execute each tool call
        for (const tc of toolCalls) {
          if (signal.aborted) {
            return this.finish('aborted', '', toolCallCount, onEvent)
          }

          const toolName = tc.function.name

          // Validate JSON tool arguments
          const parseResult = parseToolArgs(tc.function.arguments)
          if (!parseResult.ok) {
            toolCallCount++
            const failures = this.recordFailure(`${toolName}:!malformed:${parseResult.raw}`)
            const rawEcho = parseResult.raw.length > MAX_RAW_ARGS_ECHO_CHARS
              ? `${parseResult.raw.slice(0, MAX_RAW_ARGS_ECHO_CHARS)}... [${parseResult.raw.length.toLocaleString()} characters total]`
              : parseResult.raw
            let malformedError = `Error: Tool arguments were not valid JSON (${parseResult.error}): "${rawEcho}". Please retry with valid JSON parameters matching the "${toolName}" schema.`
            if (failures >= REPETITIVE_CALL_LIMIT) malformedError += `\n\n${loopWarning(toolName)}`
            answerToolCall(tc, toolName, malformedError, { output: '', error: malformedError })
            continue
          }

          const args = parseResult.args
          const callSignature = `${toolName}:${canonicalJson(args)}`

          // Repetitive failing tool call loop: after 3 identical failures, stop executing the
          // call and answer with guidance until the model changes approach.
          if (callSignature === this.lastCallSignature && this.consecutiveFailureCount >= REPETITIVE_CALL_LIMIT) {
            toolCallCount++
            const warning = loopWarning(toolName)
            answerToolCall(tc, toolName, warning, { output: '', error: warning })
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
            let policyError = truncateToolOutput(policyViolation, MAX_TOOL_ERROR_CHARS)
            if (this.recordFailure(callSignature) >= REPETITIVE_CALL_LIMIT) {
              policyError += `\n\n${loopWarning(toolName)}`
            }
            answerToolCall(tc, toolName, `Error: ${policyError}`, { output: '', error: policyError })
            continue
          }

          onEvent({ type: 'tool_call', name: toolName, args })
          toolCallCount++

          const context: ToolContext = {
            directory: this.directory,
            agentId: this.profile.id,
            runId: this.id,
            abortSignal: signal,
            profile: this.profile
          }

          const result = await this.tools.execute(toolName, args, context)

          if (signal.aborted) {
            return this.finish('aborted', '', toolCallCount, onEvent)
          }

          const output = typeof result.output === 'string' ? result.output : String(result.output ?? '')
          let error: string | undefined
          if (result.error) {
            error = truncateToolOutput(String(result.error), MAX_TOOL_ERROR_CHARS)
            // Loop failure detection tracking
            if (this.recordFailure(callSignature) >= REPETITIVE_CALL_LIMIT) {
              error += `\n\n${loopWarning(toolName)}`
            }
          } else {
            // Successful execution resets failure tracking
            this.recordSuccess()
          }

          // Append tool result as a tool message with 30k char context window protection
          answerToolCall(tc, toolName, error ? `Error: ${error}\n${output}` : output, { output, error })
        }
      }

      // Exhausted tool rounds
      return this.finish('max_turns', '', toolCallCount, onEvent)

    } catch (error) {
      if (signal.aborted) {
        return this.finish('aborted', '', toolCallCount, onEvent)
      }
      // Provider messages are passed through unchanged (adapters already redact secrets).
      const message = error instanceof Error
        ? (error.message || error.name || 'Unknown error')
        : (String(error) || 'Unknown error')
      onEvent({ type: 'error', message })
      return this.finish('error', '', toolCallCount, onEvent, message)
    } finally {
      this.running = false
    }
  }

  /** Reject as soon as the run is aborted, even if the wrapped promise never settles. */
  private raceAbort<T>(promise: Promise<T>): Promise<T> {
    const signal = this.abortController.signal
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new Error('Run aborted'))
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      // Always attach handlers so a late rejection of an abandoned promise is never unhandled.
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        }
      )
    })
  }

  private addUsage(usage: ChatResponse['usage'] | undefined): void {
    this.totalUsage.input += toUsageNumber(usage?.input)
    this.totalUsage.output += toUsageNumber(usage?.output)
    this.totalUsage.reasoning += toUsageNumber(usage?.reasoning)
  }

  private recordFailure(signature: string): number {
    if (signature === this.lastCallSignature) {
      this.consecutiveFailureCount++
    } else {
      this.lastCallSignature = signature
      this.consecutiveFailureCount = 1
    }
    return this.consecutiveFailureCount
  }

  private recordSuccess(): void {
    this.consecutiveFailureCount = 0
    this.lastCallSignature = ''
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
