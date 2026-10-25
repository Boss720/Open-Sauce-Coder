/**
 * Anthropic Claude provider adapter for the agentic harness.
 *
 * Implements the native Anthropic Messages API (/v1/messages) over raw fetch +
 * SSE (no SDK): tool use, extended/adaptive thinking with signature round-trip,
 * refusal handling, bounded retry, and credential resolution.
 *
 * SECURITY: the API key is resolved transiently via `loadByokEnv()` — never
 * cached, never logged, never returned across IPC. All error messages are
 * routed through `safeError` before leaving this module.
 */
import { loadByokEnv } from '../../keys'
import type {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  ChatDelta,
  ChatMessage,
  ContentPart,
  FunctionDefinition,
  ProviderReplay,
  ToolCall
} from './adapter'

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION = '2023-06-01'
/** No response headers / no stream bytes for this long aborts the attempt (Anthropic sends pings while thinking). */
const IDLE_TIMEOUT_MS = 120_000
/** max_tokens is required by the API; 4096 starves the answer once thinking is on. We stream, so large values are safe. */
const DEFAULT_MAX_TOKENS = 16_000
const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 750
/** A `retry-after` longer than this is surfaced to the user instead of silently waited out. */
const MAX_RETRY_AFTER_MS = 30_000
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529])
const RETRYABLE_ERROR_TYPES = new Set(['overloaded_error', 'api_error', 'rate_limit_error'])
const REFUSAL_NOTICE = '[Claude declined this request]'
const REPLAY_KEY = 'anthropic'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getApiKey(): string {
  const env = loadByokEnv()
  const key = env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('No Anthropic API key is configured. Add Anthropic under Providers first.')
  return key
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

// ── Model traits ──

export type AnthropicModelTraits = {
  /** true → `thinking: {type:'adaptive'}`; false → `{type:'enabled', budget_tokens}` (pre-4.6 models). */
  adaptiveThinking: boolean
  /** false → temperature/top_p/top_k must be omitted (the API answers 400 for them). */
  samplingAllowed: boolean
}

const FAMILY_RE = /claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-(\d{1,2})(?!\d))?/
const LEGACY_RE = /claude-(\d{1,2})(?:-(\d{1,2})(?!\d))?-(?:opus|sonnet|haiku)/

/**
 * Derive request-shape traits from a model id. Handles `claude-opus-5-5`,
 * `claude-sonnet-4-20250514` (an 8-digit number is a date, never a minor
 * version), `claude-3-7-sonnet-latest`, and provider-prefixed ids. Unknown or
 * unparseable ids get the modern behaviour (adaptive thinking, no sampling
 * params), which is the safest superset for current models.
 */
export function anthropicModelTraits(model: string): AnthropicModelTraits {
  const id = model.trim().toLowerCase()

  const legacy = LEGACY_RE.exec(id)
  if (legacy && Number(legacy[1]) <= 3) {
    return { adaptiveThinking: false, samplingAllowed: true }
  }

  const match = FAMILY_RE.exec(id)
  if (!match) return { adaptiveThinking: true, samplingAllowed: false }

  const family = match[1]
  if (family === 'fable' || family === 'mythos') {
    return { adaptiveThinking: true, samplingAllowed: false }
  }
  const version = Number(match[2]) * 100 + (match[3] !== undefined ? Number(match[3]) : 0)
  return {
    // Adaptive thinking starts at 4.6; 4.5 and older (incl. claude-haiku-4-5) need budget_tokens.
    adaptiveThinking: version >= 406,
    // Sampling parameters are still accepted up to and including 4.6.
    samplingAllowed: version <= 406
  }
}

// ── Request conversion ──

/** Convert our FunctionDefinition[] to Anthropic tool declarations. */
function toAnthropicTools(tools: FunctionDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }))
}

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
  }
  return ''
}

function toAnthropicImage(url: string): Record<string, unknown> | null {
  if (url.startsWith('data:')) {
    const marker = ';base64,'
    const split = url.indexOf(marker)
    if (split < 0) return null
    let mediaType = url.slice('data:'.length, split).toLowerCase()
    if (mediaType === 'image/jpg') mediaType = 'image/jpeg'
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) return null
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: url.slice(split + marker.length) }
    }
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: 'image', source: { type: 'url', url } }
  }
  return null
}

/** Convert user content parts into Anthropic blocks. Empty/whitespace text blocks are rejected by the API, so they are dropped. */
function toUserBlocks(content: ContentPart[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.trim().length > 0) blocks.push({ type: 'text', text: part.text })
    } else if (part.type === 'image_url') {
      const image = toAnthropicImage(part.image_url.url)
      blocks.push(image ?? { type: 'text', text: '[unsupported image omitted]' })
    }
  }
  return blocks
}

/** Read this adapter's thinking blocks back out of an assistant message's replay payload. */
function readThinkingReplay(replay: ProviderReplay | undefined): Record<string, unknown>[] {
  const own = replay?.[REPLAY_KEY]
  if (!isRecord(own) || !Array.isArray(own.thinking)) return []
  const blocks: Record<string, unknown>[] = []
  for (const raw of own.thinking) {
    if (!isRecord(raw)) continue
    if (raw.type === 'thinking' && typeof raw.thinking === 'string' && typeof raw.signature === 'string') {
      blocks.push({ type: 'thinking', thinking: raw.thinking, signature: raw.signature })
    } else if (raw.type === 'redacted_thinking' && typeof raw.data === 'string') {
      blocks.push({ type: 'redacted_thinking', data: raw.data })
    }
  }
  return blocks
}

function parseToolInput(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args)
    return isRecord(parsed) && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Convert our ChatMessage[] to Anthropic system and messages payload. */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string
  messages: Record<string, unknown>[]
} {
  const systemParts: string[] = []
  const anthropicMessages: Record<string, unknown>[] = []

  function appendUserContent(content: string | Record<string, unknown>[]): void {
    // Empty / whitespace-only text blocks are rejected by the API.
    if (typeof content === 'string' ? content.trim().length === 0 : content.length === 0) return
    const last = anthropicMessages[anthropicMessages.length - 1]
    if (last && last.role === 'user') {
      const lastContent = last.content
      if (typeof lastContent === 'string' && typeof content === 'string') {
        last.content = `${lastContent}\n\n${content}`
      } else {
        const lastBlocks = Array.isArray(lastContent)
          ? (lastContent as Record<string, unknown>[])
          : [{ type: 'text', text: String(lastContent) }]
        const newBlocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
        last.content = [...lastBlocks, ...newBlocks]
      }
    } else {
      anthropicMessages.push({ role: 'user', content })
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    if (message.role === 'system') {
      const text = textOf(message.content)
      if (text.trim().length > 0) systemParts.push(text)
      continue
    }

    if (message.role === 'tool') {
      // All tool results for one assistant turn belong in ONE user message;
      // splitting them degrades parallel tool use.
      const toolResults: Record<string, unknown>[] = []
      let j = i
      while (j < messages.length && messages[j].role === 'tool') {
        const cur = messages[j]
        const toolContent = typeof cur.content === 'string'
          ? cur.content
          : Array.isArray(cur.content)
            ? textOf(cur.content)
            : ''
        toolResults.push({
          type: 'tool_result',
          tool_use_id: cur.tool_call_id ?? 'unknown',
          content: toolContent
        })
        j++
      }
      i = j - 1 // Advance outer loop
      appendUserContent(toolResults)
      continue
    }

    if (message.role === 'assistant') {
      const blocks: Record<string, unknown>[] = readThinkingReplay(message.providerReplay)
      const hasReplay = blocks.length > 0
      const text = textOf(message.content)
      if (text.trim().length > 0) blocks.push({ type: 'text', text })
      const toolCalls = message.tool_calls ?? []
      for (const tc of toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parseToolInput(tc.function.arguments)
        })
      }
      if (blocks.length === 0) continue // an empty assistant turn is invalid; consecutive user turns are merged server-side
      if (toolCalls.length === 0 && !hasReplay) {
        anthropicMessages.push({ role: 'assistant', content: text })
      } else {
        anthropicMessages.push({ role: 'assistant', content: blocks })
      }
      continue
    }

    // Role is user
    if (typeof message.content === 'string') {
      appendUserContent(message.content)
    } else if (Array.isArray(message.content)) {
      appendUserContent(toUserBlocks(message.content))
    }
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  return { system, messages: anthropicMessages }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function buildBody(request: ChatRequest): Record<string, unknown> {
  const traits = anthropicModelTraits(request.model)
  const { system, messages } = toAnthropicMessages(request.messages)
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    max_tokens: maxTokens,
    stream: true
  }

  if (system) body.system = system
  // tool_choice is never sent: forced choices ('any' / 'tool') are rejected on current models.
  if (request.tools && request.tools.length > 0) {
    body.tools = toAnthropicTools(request.tools)
  }

  if (request.thinking?.enabled) {
    if (traits.adaptiveThinking) {
      // 4.7+ and 5.x default to an omitted (empty) thinking display; ask for summaries so the UI has text.
      body.thinking = { type: 'adaptive', display: 'summarized' }
    } else {
      // Pre-4.6 models: budget_tokens >= 1024 and strictly less than max_tokens.
      const budget = Math.max(1024, Math.floor(request.thinking.budget ?? 2048))
      body.thinking = { type: 'enabled', budget_tokens: budget }
      if (maxTokens <= budget) body.max_tokens = budget + 4096
    }
    // Sampling parameters are never sent alongside thinking. `{type:'disabled'}` is never sent either.
  } else if (traits.samplingAllowed) {
    if (request.temperature !== undefined) {
      body.temperature = clamp01(request.temperature)
    } else if (request.topP !== undefined) {
      // Newer models reject temperature and top_p together; temperature wins when both are set.
      body.top_p = clamp01(request.topP)
    }
  }

  return body
}

// ── Transport helpers ──

class AnthropicApiError extends Error {
  readonly retryable: boolean
  readonly retryAfterMs?: number
  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message)
    this.name = 'AnthropicApiError'
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Request aborted.'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Request aborted.'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Per-attempt abort controller: follows the caller's signal and fires after `ms` without progress. */
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

function describeHttpError(status: number, statusText: string, bodyText: string): string {
  let detail = bodyText.trim()
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const parts = [parsed.error.type, parsed.error.message].filter((p): p is string => typeof p === 'string' && p.length > 0)
      if (parts.length > 0) detail = parts.join(': ')
    }
  } catch {
    // plain-text body: use as is
  }
  return `Anthropic harness request failed: ${status} ${statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`
}

// ── Streaming state ──

type StreamBlock =
  | { kind: 'text' }
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'redacted'; data: string }
  | { kind: 'tool'; id: string; name: string; argsJson: string; startInput?: Record<string, unknown> }

export type AnthropicAdapterOptions = {
  /** Base delay for retry backoff (doubles per attempt). Tests set this to ~0. */
  retryBaseDelayMs?: number
  /** Abort an attempt after this long without response headers or stream bytes. */
  idleTimeoutMs?: number
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic'

  private inflight = new Map<string, AbortController>()
  private readonly retryBaseDelayMs: number
  private readonly idleTimeoutMs: number

  constructor(options: AnthropicAdapterOptions = {}) {
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  }

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const key = getApiKey()
    const url = `${(request.baseUrl ?? ANTHROPIC_BASE_URL).replace(/\/+$/, '')}/messages`
    const body = buildBody(request)

    const abort = new AbortController()
    if (request.signal) {
      if (request.signal.aborted) abort.abort()
      else request.signal.addEventListener('abort', () => abort.abort(), { once: true })
    }
    this.inflight.set(request.requestId, abort)

    try {
      return await this.executeWithRetry(url, key, body, request.requestId, abort, onDelta)
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
      const res = await fetch(`${ANTHROPIC_BASE_URL}/models`, {
        headers: {
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION
        },
        signal: AbortSignal.timeout(5000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** Retries retryable failures (at most MAX_RETRIES) as long as no delta reached the caller and the request is live. */
  private async executeWithRetry(
    url: string,
    key: string,
    body: Record<string, unknown>,
    requestId: string,
    abort: AbortController,
    onDelta?: (delta: ChatDelta) => void
  ): Promise<ChatResponse> {
    let emitted = false
    const emit = (delta: ChatDelta): void => {
      emitted = true
      onDelta?.(delta)
    }

    for (let attempt = 0; ; attempt++) {
      if (abort.signal.aborted) throw new Error('Request aborted.')
      try {
        return await this.executeStream(url, key, body, requestId, abort, emit)
      } catch (error) {
        if (abort.signal.aborted) throw new Error('Request aborted.')
        if (!(error instanceof AnthropicApiError) || !error.retryable || emitted || attempt >= MAX_RETRIES) {
          throw error
        }
        await sleep(error.retryAfterMs ?? this.retryBaseDelayMs * 2 ** attempt, abort.signal)
      }
    }
  }

  private async executeStream(
    url: string,
    key: string,
    body: Record<string, unknown>,
    requestId: string,
    abort: AbortController,
    emit: (delta: ChatDelta) => void
  ): Promise<ChatResponse> {
    const watchdog = new Watchdog(abort.signal, this.idleTimeoutMs)
    const interruption = (): Error | null => {
      if (abort.signal.aborted) return new Error('Request aborted.')
      if (watchdog.timedOut) {
        return new Error(`Anthropic stopped responding (no data for ${Math.round(this.idleTimeoutMs / 1000)}s).`)
      }
      return null
    }

    try {
      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': ANTHROPIC_VERSION
          },
          body: JSON.stringify(body),
          signal: watchdog.signal
        })
      } catch (error) {
        throw interruption() ?? new Error(`Unable to reach Anthropic: ${safeError(error)}`)
      }
      watchdog.touch()

      if (!res.ok) {
        let bodyText = ''
        try {
          bodyText = await res.text()
        } catch { /* ignore */ }
        const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'))
        const retryable = RETRYABLE_STATUSES.has(res.status) &&
          (retryAfterMs === undefined || retryAfterMs <= MAX_RETRY_AFTER_MS)
        throw new AnthropicApiError(
          safeError(new Error(describeHttpError(res.status, res.statusText, bodyText))),
          retryable,
          retryAfterMs
        )
      }

      if (!res.body) throw new Error('Anthropic returned an empty response body.')

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
      let responseId = requestId
      let stopReason: string | undefined
      let sawMessageStop = false
      let outputTokens = 0
      const inputUsage = { input: 0, cacheRead: 0, cacheCreation: 0 }
      const blocks = new Map<number, StreamBlock>()

      const readUsage = (usage: unknown): void => {
        if (!isRecord(usage)) return
        if (typeof usage.input_tokens === 'number') inputUsage.input = usage.input_tokens
        if (typeof usage.cache_read_input_tokens === 'number') inputUsage.cacheRead = usage.cache_read_input_tokens
        if (typeof usage.cache_creation_input_tokens === 'number') inputUsage.cacheCreation = usage.cache_creation_input_tokens
        if (typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens
      }

      const handleEvent = (eventData: Record<string, unknown>): void => {
        const type = typeof eventData.type === 'string' ? eventData.type : ''
        const idx = typeof eventData.index === 'number' ? eventData.index : 0

        if (type === 'message_start' && isRecord(eventData.message)) {
          const msg = eventData.message
          if (typeof msg.id === 'string') responseId = msg.id
          readUsage(msg.usage)
        } else if (type === 'content_block_start' && isRecord(eventData.content_block)) {
          const cb = eventData.content_block
          if (cb.type === 'text') {
            blocks.set(idx, { kind: 'text' })
            if (typeof cb.text === 'string' && cb.text.length > 0) {
              fullText += cb.text
              emit({ content: cb.text })
            }
          } else if (cb.type === 'thinking') {
            blocks.set(idx, {
              kind: 'thinking',
              thinking: typeof cb.thinking === 'string' ? cb.thinking : '',
              signature: typeof cb.signature === 'string' ? cb.signature : ''
            })
          } else if (cb.type === 'redacted_thinking') {
            blocks.set(idx, { kind: 'redacted', data: typeof cb.data === 'string' ? cb.data : '' })
          } else if (cb.type === 'tool_use') {
            blocks.set(idx, {
              kind: 'tool',
              id: typeof cb.id === 'string' ? cb.id : `call_${idx}`,
              name: typeof cb.name === 'string' ? cb.name : '',
              argsJson: '',
              startInput: isRecord(cb.input) ? cb.input : undefined
            })
          }
        } else if (type === 'content_block_delta' && isRecord(eventData.delta)) {
          const delta = eventData.delta
          const block = blocks.get(idx)
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            if (!block) blocks.set(idx, { kind: 'text' })
            if (delta.text.length > 0) {
              fullText += delta.text
              emit({ content: delta.text })
            }
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            if (block?.kind === 'thinking') block.thinking += delta.thinking
            else if (!block) blocks.set(idx, { kind: 'thinking', thinking: delta.thinking, signature: '' })
            if (delta.thinking.length > 0) {
              fullThinking += delta.thinking
              emit({ thinkingContent: delta.thinking })
            }
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            if (block?.kind === 'thinking') block.signature += delta.signature
            else if (!block) blocks.set(idx, { kind: 'thinking', thinking: '', signature: delta.signature })
          } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            if (block?.kind === 'tool') block.argsJson += delta.partial_json
          }
        } else if (type === 'message_delta') {
          if (isRecord(eventData.delta) && typeof eventData.delta.stop_reason === 'string') {
            stopReason = eventData.delta.stop_reason
          }
          readUsage(eventData.usage)
        } else if (type === 'message_stop') {
          sawMessageStop = true
        } else if (type === 'error' && isRecord(eventData.error)) {
          const errType = typeof eventData.error.type === 'string' ? eventData.error.type : ''
          const msg = typeof eventData.error.message === 'string' ? eventData.error.message : 'Unknown stream error'
          throw new AnthropicApiError(
            safeError(new Error(`Anthropic stream error${errType ? ` (${errType})` : ''}: ${msg}`)),
            RETRYABLE_ERROR_TYPES.has(errType)
          )
        }
      }

      const handleLine = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) return
        const dataStr = trimmed.slice(5).trim()
        if (dataStr === '[DONE]') return
        let eventData: unknown
        try {
          eventData = JSON.parse(dataStr)
        } catch {
          return
        }
        if (isRecord(eventData)) handleEvent(eventData)
      }

      let drained = false
      try {
        while (true) {
          let chunk: Awaited<ReturnType<typeof reader.read>>
          try {
            chunk = await reader.read()
          } catch (error) {
            throw interruption() ?? new Error(`Anthropic stream failed: ${safeError(error)}`)
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

      if (stopReason === undefined && !sawMessageStop) {
        // Connection dropped mid-response: never present a truncated turn as a completed one.
        throw new AnthropicApiError('Anthropic stream ended before the message completed.', true)
      }

      // Assemble in content-block order.
      const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block)
      const toolCalls: ToolCall[] = []
      const replayBlocks: Record<string, unknown>[] = []
      for (const block of ordered) {
        if (block.kind === 'tool') {
          const hasDeltas = block.argsJson.length > 0
          const startArgs = block.startInput && Object.keys(block.startInput).length > 0
            ? JSON.stringify(block.startInput)
            : '{}'
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: hasDeltas ? block.argsJson : startArgs }
          })
        } else if (block.kind === 'thinking') {
          // A thinking block without a signature cannot be passed back (the API would reject it).
          if (block.signature.length > 0) {
            replayBlocks.push({ type: 'thinking', thinking: block.thinking, signature: block.signature })
          }
        } else if (block.kind === 'redacted' && block.data.length > 0) {
          replayBlocks.push({ type: 'redacted_thinking', data: block.data })
        }
      }

      let finishReason: ChatResponse['finishReason'] = 'stop'
      let content = fullText
      let finalToolCalls: ToolCall[] | undefined = toolCalls.length > 0 ? toolCalls : undefined

      if (stopReason === 'refusal') {
        // Safety decline arrives as HTTP 200: surface it, and never act on a partial tool call.
        finalToolCalls = undefined
        if (content.trim().length === 0) content = REFUSAL_NOTICE
      } else if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
        // Tool calls stay attached: the runner answers each one as cut off instead of executing it.
        finishReason = 'length'
      } else if (finalToolCalls) {
        finishReason = 'tool_calls'
      }

      const providerReplay: ProviderReplay | undefined = replayBlocks.length > 0
        ? { [REPLAY_KEY]: { thinking: replayBlocks } }
        : undefined

      return {
        id: responseId,
        content,
        toolCalls: finalToolCalls,
        finishReason,
        usage: {
          input: inputUsage.input + inputUsage.cacheRead + inputUsage.cacheCreation,
          output: outputTokens
        },
        thinkingContent: fullThinking.length > 0 ? fullThinking : undefined,
        ...(providerReplay ? { providerReplay } : {})
      }
    } finally {
      watchdog.dispose()
    }
  }
}
