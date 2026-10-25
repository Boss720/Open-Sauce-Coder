/**
 * OpenAI provider adapter for the agentic harness.
 *
 * Implements native OpenAI Chat Completions API with tool calling,
 * support for standard models (GPT-4o) and reasoning models (o-series, GPT-5)
 * with max_completion_tokens adaptation, streaming SSE, and credential resolution.
 *
 * SECURITY: the API key is resolved transiently via `loadByokEnv()` — never
 * cached, never logged, never returned across IPC. All error messages are
 * routed through `safeError` before leaving this module.
 */
import { loadByokEnv } from '../../keys'
import { sameOrigin } from './openaiCompatible'
import type {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  ChatDelta,
  ChatMessage,
  ToolCall
} from './adapter'

const OPENAI_BASE_URL = 'https://api.openai.com/v1'
/** No response headers / no stream bytes for this long aborts the request. Streams themselves may run far longer. */
const IDLE_TIMEOUT_MS = 120_000
const CONTENT_FILTER_NOTICE = '[OpenAI withheld this response (content filter)]'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getApiKey(): string {
  const env = loadByokEnv()
  const key = env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
  if (!key) throw new Error('No OpenAI API key is configured. Add OpenAI under Providers first.')
  return key
}

/**
 * Credential for one request. OpenAI's key is never forwarded to a host it was not issued
 * for: a base URL on another origin (proxy, local server) is sent no key and needs none.
 */
function resolveKey(baseUrl: string): string | null {
  return sameOrigin(baseUrl, OPENAI_BASE_URL) ? getApiKey() : null
}

function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error)
  let key: string | undefined
  try {
    key = getApiKey()
  } catch {
    key = undefined
  }
  if (key && key.length > 0) {
    message = message.split(key).join('[redacted]')
  }
  message = message.replace(/([?&](?:key|api_key|apiKey)=)[^&\s]+/gi, '$1[redacted]')
  return message
}

/**
 * Reasoning models (o1/o3/o4 series and GPT-5 onward, except `-chat` variants)
 * take `max_completion_tokens` and `reasoning_effort`, and reject non-default
 * temperature / top_p.
 */
export function isOpenAiReasoningModel(model: string): boolean {
  const lower = model.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  if (/^o\d/.test(base)) return true
  const gpt = /^gpt-(\d+)/.exec(base)
  if (gpt) return Number(gpt[1]) >= 5 && !base.includes('-chat')
  return lower.includes('reasoner')
}

/** o1-mini / o1-preview predate `reasoning_effort` and reject it. */
function supportsReasoningEffort(model: string): boolean {
  const lower = model.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  return !/^o1-(mini|preview)/.test(base)
}

function toolMessageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter((t) => t.length > 0)
      .join('\n')
  }
  return ''
}

function hasContent(content: ChatMessage['content']): boolean {
  if (typeof content === 'string') return content.length > 0
  return Array.isArray(content) && content.length > 0
}

/**
 * Sanitize messages for OpenAI. Assistant messages that carry tool_calls and no
 * text send `content: null` (strict servers reject an empty string); an
 * assistant message with neither text nor tool_calls is invalid and dropped.
 */
export function sanitizeOpenAiMessages(messages: ChatMessage[], isReasoning = false): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    let role: string = m.role
    if (isReasoning && role === 'system') {
      role = 'developer'
    }

    if (role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        out.push({
          role: 'assistant',
          content: hasContent(m.content) ? m.content : null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments }
          }))
        })
      } else if (hasContent(m.content)) {
        out.push({ role: 'assistant', content: m.content })
      }
      continue
    }

    if (role === 'tool') {
      out.push({
        role: 'tool',
        content: toolMessageText(m.content),
        tool_call_id: m.tool_call_id
      })
      continue
    }

    out.push({ role, content: m.content ?? '' })
  }
  return out
}

function describeHttpError(status: number, statusText: string, bodyText: string): string {
  let detail = bodyText.trim()
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const parts = [parsed.error.code ?? parsed.error.type, parsed.error.message]
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
      if (parts.length > 0) detail = parts.join(': ')
    }
  } catch {
    // plain-text body: use as is
  }
  return `OpenAI harness request failed: ${status} ${statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`
}

/** Abort controller that follows the caller's signal and fires after `ms` without progress. */
class Watchdog {
  readonly controller = new AbortController()
  timedOut = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly onParentAbort = (): void => this.controller.abort()

  constructor(
    private readonly parent: AbortSignal,
    private readonly ms: number
  ) {
    if (parent.aborted) this.controller.abort()
    else parent.addEventListener('abort', this.onParentAbort, { once: true })
    this.touch()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  touch(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort()
    }, this.ms)
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.parent.removeEventListener('abort', this.onParentAbort)
  }
}

export type OpenAiAdapterOptions = {
  /** Abort a request after this long without response headers or stream bytes. */
  idleTimeoutMs?: number
}

export class OpenAiAdapter implements ProviderAdapter {
  readonly id = 'openai'

  private inflight = new Map<string, AbortController>()
  private readonly idleTimeoutMs: number

  constructor(options: OpenAiAdapterOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  }

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const baseUrl = (request.baseUrl?.trim() || OPENAI_BASE_URL).replace(/\/+$/, '')
    const key = resolveKey(baseUrl)
    const url = `${baseUrl}/chat/completions`

    const reasoning = isOpenAiReasoningModel(request.model)
    const body: Record<string, unknown> = {
      model: request.model,
      messages: sanitizeOpenAiMessages(request.messages, reasoning),
      stream: true,
      stream_options: { include_usage: true }
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
    }

    if (reasoning) {
      // Reasoning models use max_completion_tokens and reject non-default temperature / top_p.
      if (request.maxTokens !== undefined) {
        body.max_completion_tokens = request.maxTokens
      }
      if (request.thinking?.enabled && supportsReasoningEffort(request.model)) {
        body.reasoning_effort = 'medium'
      }
    } else {
      if (request.temperature !== undefined) body.temperature = request.temperature
      if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
      if (request.topP !== undefined) body.top_p = request.topP
    }

    const abort = new AbortController()
    if (request.signal) {
      if (request.signal.aborted) abort.abort()
      else request.signal.addEventListener('abort', () => abort.abort(), { once: true })
    }
    this.inflight.set(request.requestId, abort)

    try {
      return await this.executeStream(url, key, body, request.requestId, abort, onDelta)
    } finally {
      this.inflight.delete(request.requestId)
    }
  }

  abort(requestIdOrRunId: string): void {
    const controller = this.inflight.get(requestIdOrRunId)
    if (controller) {
      controller.abort()
      this.inflight.delete(requestIdOrRunId)
      return
    }
    for (const [id, ctrl] of this.inflight.entries()) {
      if (id === requestIdOrRunId || id.startsWith(`${requestIdOrRunId}-`)) {
        ctrl.abort()
        this.inflight.delete(id)
      }
    }
  }

  async probe(): Promise<boolean> {
    try {
      const key = getApiKey()
      const res = await fetch(`${OPENAI_BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  private async executeStream(
    url: string,
    key: string | null,
    body: Record<string, unknown>,
    requestId: string,
    abort: AbortController,
    onDelta?: (delta: ChatDelta) => void
  ): Promise<ChatResponse> {
    if (abort.signal.aborted) throw new Error('Request aborted.')
    const watchdog = new Watchdog(abort.signal, this.idleTimeoutMs)
    const interruption = (): Error | null => {
      if (abort.signal.aborted) return new Error('Request aborted.')
      if (watchdog.timedOut) {
        return new Error(`OpenAI stopped responding (no data for ${Math.round(this.idleTimeoutMs / 1000)}s).`)
      }
      return null
    }

    try {
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(key ? { Authorization: `Bearer ${key}` } : {})
          },
          body: JSON.stringify(body),
          signal: watchdog.signal
        })
      } catch (error) {
        throw interruption() ?? new Error(`Unable to reach OpenAI: ${safeError(error)}`)
      }
      watchdog.touch()

      if (!res.ok) {
        let bodyText = ''
        try {
          bodyText = await res.text()
        } catch { /* ignore */ }
        throw new Error(safeError(new Error(describeHttpError(res.status, res.statusText, bodyText))))
      }

      if (!res.body) throw new Error('OpenAI returned an empty response body.')

      const reader = res.body.getReader()
      const cancelReader = (): void => {
        reader.cancel().catch(() => undefined)
      }
      if (watchdog.signal.aborted) cancelReader()
      else watchdog.signal.addEventListener('abort', cancelReader, { once: true })

      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      let fullText = ''
      let fullThinking = ''
      let refusalText = ''
      let responseId = requestId
      let finishReason: ChatResponse['finishReason'] = 'stop'
      let contentFiltered = false
      let inputTokens = 0
      let outputTokens = 0
      let reasoningTokens: number | undefined

      // Tool call accumulation map indexed by stream index
      const toolCallsMap = new Map<number, { id: string; name: string; args: string }>()

      const handleLine = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) return
        const dataStr = trimmed.slice(5).trim()
        if (dataStr === '[DONE]') return

        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(dataStr) as Record<string, unknown>
        } catch {
          return
        }
        if (!isRecord(chunk)) return

        // In-stream error object (e.g. server_error mid-response)
        if (isRecord(chunk.error)) {
          const msg = typeof chunk.error.message === 'string' ? chunk.error.message : 'Unknown stream error'
          throw new Error(safeError(new Error(`OpenAI stream error: ${msg}`)))
        }

        if (typeof chunk.id === 'string') responseId = chunk.id

        if (isRecord(chunk.usage)) {
          if (typeof chunk.usage.prompt_tokens === 'number') inputTokens = chunk.usage.prompt_tokens
          if (typeof chunk.usage.completion_tokens === 'number') outputTokens = chunk.usage.completion_tokens
          if (isRecord(chunk.usage.completion_tokens_details) && typeof chunk.usage.completion_tokens_details.reasoning_tokens === 'number') {
            reasoningTokens = chunk.usage.completion_tokens_details.reasoning_tokens
          }
        }

        const choices = Array.isArray(chunk.choices) ? chunk.choices : []
        if (choices.length === 0) return

        const choice = choices[0]
        if (!isRecord(choice)) return

        if (typeof choice.finish_reason === 'string') {
          const fr = choice.finish_reason
          if (fr === 'tool_calls' || fr === 'function_call') finishReason = 'tool_calls'
          else if (fr === 'length') finishReason = 'length'
          else if (fr === 'stop') finishReason = 'stop'
          else if (fr === 'content_filter') contentFiltered = true
        }

        const delta = isRecord(choice.delta) ? choice.delta : {}

        // Text content delta
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          fullText += delta.content
          onDelta?.({ content: delta.content })
        }

        // Reasoning content delta (compatible servers; native o-series does not stream reasoning text)
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          fullThinking += delta.reasoning_content
          onDelta?.({ thinkingContent: delta.reasoning_content })
        }

        // Structured safety refusal
        if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
          refusalText += delta.refusal
        }

        // Tool calls delta
        if (Array.isArray(delta.tool_calls)) {
          for (const tcDelta of delta.tool_calls) {
            if (!isRecord(tcDelta)) continue
            const idx = typeof tcDelta.index === 'number' ? tcDelta.index : 0
            const existing = toolCallsMap.get(idx) ?? { id: '', name: '', args: '' }

            if (typeof tcDelta.id === 'string' && tcDelta.id.length > 0) {
              existing.id = tcDelta.id
            }
            if (isRecord(tcDelta.function)) {
              if (typeof tcDelta.function.name === 'string') {
                existing.name += tcDelta.function.name
              }
              if (typeof tcDelta.function.arguments === 'string') {
                existing.args += tcDelta.function.arguments
              }
            }

            toolCallsMap.set(idx, existing)
          }
        }
      }

      let drained = false
      try {
        while (true) {
          let chunk: Awaited<ReturnType<typeof reader.read>>
          try {
            chunk = await reader.read()
          } catch (error) {
            throw interruption() ?? new Error(`OpenAI stream failed: ${safeError(error)}`)
          }
          if (chunk.done) break
          watchdog.touch()
          buffer += decoder.decode(chunk.value, { stream: true })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''
          for (const line of lines) handleLine(line)
        }
        buffer += decoder.decode()
        if (buffer.length > 0) handleLine(buffer)
        drained = true
      } finally {
        watchdog.signal.removeEventListener('abort', cancelReader)
        // On any failure, close the connection instead of leaving the body dangling.
        if (!drained) cancelReader()
        reader.releaseLock()
      }

      const interrupted = interruption()
      if (interrupted) throw interrupted

      const toolCalls: ToolCall[] = []
      const orderedCalls = [...toolCallsMap.entries()].sort((a, b) => a[0] - b[0])
      for (const [, item] of orderedCalls) {
        if (item.name) {
          toolCalls.push({
            id: item.id || `call_${toolCalls.length}`,
            type: 'function',
            function: {
              name: item.name,
              arguments: item.args || '{}'
            }
          })
        }
      }

      if (toolCalls.length > 0) {
        finishReason = 'tool_calls'
      }

      let content = fullText
      if (content.length === 0 && toolCalls.length === 0) {
        if (refusalText.length > 0) content = refusalText
        else if (contentFiltered) content = CONTENT_FILTER_NOTICE
      }

      const usage = reasoningTokens !== undefined
        ? { input: inputTokens, output: outputTokens, reasoning: reasoningTokens }
        : { input: inputTokens, output: outputTokens }

      return {
        id: responseId,
        content,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        usage,
        thinkingContent: fullThinking.length > 0 ? fullThinking : undefined
      }
    } finally {
      watchdog.dispose()
    }
  }
}
