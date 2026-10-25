/**
 * Generic OpenAI-compatible provider adapter for the agentic harness.
 *
 * Supports providers that implement the standard OpenAI Chat Completions API:
 * Groq, Mistral, OpenRouter, DeepSeek, Moonshot, xAI, Cerebras, Custom/Local (Ollama, LM Studio).
 *
 * Resolves credentials securely from loadByokEnv() using the provider's envVar,
 * handles tool calls, timeouts, retries, <think> tag extraction, and streaming SSE.
 *
 * This module also exports the pieces the NanoGPT adapter shares (message sanitising,
 * SSE stream reader, JSON response reader, idle timeout) so both fix bugs in one place.
 */
import { randomUUID } from 'node:crypto'
import { loadByokEnv } from '../../keys'
import { catalogByProvider } from '../../providerCatalog'
import { ThinkTagStreamer, extractThinkTags } from './thinkTagStreamer'
import type {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  ChatDelta,
  ChatMessage,
  ToolCall
} from './adapter'

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const MAX_RETRIES = 2
/** Max wait for response headers AND max silence between two stream chunks (not a total-duration cap). */
const REQUEST_TIMEOUT_MS = 120_000

/**
 * Providers whose docs require the model's reasoning to be echoed back on assistant
 * messages: DeepSeek ("reasoning_content must be fully passed back" when tools are present,
 * else HTTP 400) and Moonshot/Kimi K2 thinking ("keep all of the reasoning content" during
 * multi-step tool calls). Every other compatible server (Mistral validates strictly) gets
 * no extra fields.
 */
const ECHO_REASONING_PROVIDERS = new Set(['deepseek', 'moonshot'])

export type OpenAiCompatibleConfig = {
  providerId: string
  baseUrl: string
  /** Other official API base URLs of this provider; their origins may also receive its key. */
  officialBaseUrls?: string[]
  chatPath?: string
  probePath?: string
  defaultHeaders?: Record<string, string>
}

export const OPENAI_COMPATIBLE_CONFIGS: Record<string, OpenAiCompatibleConfig> = {
  groq: {
    providerId: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    chatPath: '/chat/completions',
    probePath: '/models'
  },
  mistral: {
    providerId: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    chatPath: '/chat/completions',
    probePath: '/models'
  },
  openrouter: {
    providerId: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatPath: '/chat/completions',
    probePath: '/models',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/Boss720/Open-Sauce-Coder',
      'X-Title': 'OpenCode Desktop'
    }
  },
  deepseek: {
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    probePath: '/models'
  },
  moonshot: {
    providerId: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    officialBaseUrls: ['https://api.moonshot.ai/v1'],
    chatPath: '/chat/completions',
    probePath: '/models'
  },
  xai: {
    providerId: 'xai',
    baseUrl: 'https://api.x.ai/v1',
    chatPath: '/chat/completions',
    probePath: '/models'
  },
  cerebras: {
    providerId: 'cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    chatPath: '/chat/completions',
    probePath: '/models'
  },
  custom: {
    providerId: 'custom',
    baseUrl: 'http://localhost:11434/v1',
    chatPath: '/chat/completions',
    probePath: '/models'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A failure retrying cannot fix (HTTP 4xx, content filter): the adapter fails fast instead of re-sending. */
export class FatalRequestError extends Error {}

// ── Base URL handling ──

function parseHttpUrl(raw: string): URL {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    // Deliberately do not echo the value: it may carry credentials or a query-string key.
    throw new Error('Invalid base URL: expected an absolute http:// or https:// URL.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid base URL: only http:// and https:// are supported.')
  }
  return parsed
}

/**
 * Join a base URL and an endpoint path exactly once: trailing slashes on the base are
 * dropped and a pasted full endpoint ("…/v1/chat/completions") is not doubled. A query
 * string on the base (e.g. "?api-version=…") stays at the end of the final URL.
 */
export function buildEndpointUrl(baseUrl: string, endpointPath: string): string {
  const parsed = parseHttpUrl(baseUrl)
  const path = (endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`).replace(/\/+$/, '')
  let basePath = parsed.pathname.replace(/\/+$/, '')
  if (basePath.toLowerCase().endsWith(path.toLowerCase())) basePath = basePath.slice(0, basePath.length - path.length)
  return `${parsed.origin}${basePath}${path}${parsed.search}`
}

/** True for localhost, 127.0.0.0/8, ::1 and *.localhost — servers that never need a cloud API key. */
export function isLoopbackUrl(raw: string): boolean {
  let host: string
  try {
    host = new URL(raw.trim()).hostname.toLowerCase()
  } catch {
    return false
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a.trim()).origin === new URL(b.trim()).origin
  } catch {
    return false
  }
}

// ── Message conversion ──

function hasContent(content: ChatMessage['content']): boolean {
  if (typeof content === 'string') return content.length > 0
  return Array.isArray(content) && content.length > 0
}

/**
 * Convert harness messages to the OpenAI wire shape.
 *
 * - An assistant message that carries tool_calls and no text sends `content: null`;
 *   strict servers (Groq, Mistral, vLLM) reject `''` there.
 * - A plain assistant/user/system message never sends null (`''` instead).
 * - `echoReasoning` re-sends captured provider reasoning as `reasoning_content` (DeepSeek, Moonshot only).
 */
export function sanitizeMessages(
  messages: ChatMessage[],
  options: { echoReasoning?: boolean } = {}
): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'assistant') {
      const hasToolCalls = Boolean(m.tool_calls && m.tool_calls.length > 0)
      const out: Record<string, unknown> = {
        role: 'assistant',
        content: hasToolCalls ? (hasContent(m.content) ? m.content : null) : (m.content ?? '')
      }
      if (hasToolCalls) out.tool_calls = m.tool_calls
      if (options.echoReasoning) {
        const replay = m.providerReplay?.openaiCompat
        if (isRecord(replay) && typeof replay.reasoningContent === 'string' && replay.reasoningContent.length > 0) {
          out.reasoning_content = replay.reasoningContent
        }
      }
      return out
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        tool_call_id: m.tool_call_id
      }
    }

    return { role: m.role, content: m.content ?? '' }
  })
}

// ── Idle timeout ──

export type IdleGuard = {
  signal: AbortSignal
  /** Call whenever data arrives; restarts the idle timer. */
  touch(): void
  readonly timedOut: boolean
  dispose(): void
}

/**
 * An abort signal that fires when `parent` aborts OR when nothing has happened for `ms`.
 * Unlike AbortSignal.timeout this does not cap total duration, so a long reasoning stream
 * that keeps producing chunks is never cut off.
 */
export function createIdleGuard(parent: AbortSignal, ms: number): IdleGuard {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const onParentAbort = (): void => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onParentAbort, { once: true })

  const touch = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)
    timer.unref?.()
  }
  touch()

  return {
    signal: controller.signal,
    touch,
    get timedOut() {
      return timedOut
    },
    dispose() {
      if (timer) clearTimeout(timer)
      parent.removeEventListener('abort', onParentAbort)
    }
  }
}

// ── Streaming response reader ──

type ToolAcc = { index: number; id: string; name: string; args: string }

/**
 * Fold one streamed `tool_calls[]` entry into the accumulator.
 *
 * Handles the real-world variations: arguments streamed in fragments, the whole call in a
 * single chunk, `id` only on the first fragment, no `index` at all, and servers that reuse
 * index 0 for every parallel call but give each a distinct id.
 */
function applyToolCallDelta(calls: ToolAcc[], delta: Record<string, unknown>): void {
  const index = typeof delta.index === 'number' ? delta.index : undefined
  const id = typeof delta.id === 'string' ? delta.id : ''
  const fn = isRecord(delta.function) ? delta.function : {}
  const name = typeof fn.name === 'string' ? fn.name : ''

  let target: ToolAcc | undefined
  if (index !== undefined) {
    for (let i = calls.length - 1; i >= 0; i--) {
      if (calls[i].index === index) {
        target = calls[i]
        break
      }
    }
    // Same index but a different id => a new call that reuses the index.
    if (target && id && target.id && target.id !== id) target = undefined
  } else if (id) {
    target = calls.find((c) => c.id === id)
  } else if (calls.length > 0) {
    const last = calls[calls.length - 1]
    // A fresh name with no id/index starts a new call once the previous one is already named.
    if (!(name && last.name && name !== last.name)) target = last
  }

  if (!target) {
    target = { index: index ?? calls.length, id: '', name: '', args: '' }
    calls.push(target)
  }
  if (id && !target.id) target.id = id
  // Some servers repeat the full name on every fragment; real name fragments never equal the whole name.
  if (name && name !== target.name) target.name += name

  if (typeof fn.arguments === 'string') {
    target.args += fn.arguments
  } else if (isRecord(fn.arguments) && target.args.length === 0) {
    target.args = JSON.stringify(fn.arguments)
  }
}

function finalizeToolCalls(calls: ToolAcc[]): ToolCall[] {
  const used = new Set<string>()
  const result: ToolCall[] = []
  for (const call of calls) {
    if (!call.name) continue
    let id = call.id || `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    if (used.has(id)) {
      let n = 2
      while (used.has(`${id}_${n}`)) n++
      id = `${id}_${n}`
    }
    used.add(id)
    result.push({
      id,
      type: 'function',
      function: { name: call.name, arguments: call.args.trim().length > 0 ? call.args : '{}' }
    })
  }
  return result
}

type RawFinish = 'stop' | 'length' | 'tool_calls' | 'content_filter'

function mapFinish(raw: unknown): RawFinish | undefined {
  if (raw === 'tool_calls' || raw === 'function_call') return 'tool_calls'
  if (raw === 'length') return 'length'
  if (raw === 'content_filter') return 'content_filter'
  if (raw === 'stop') return 'stop'
  return undefined
}

function reasoningFrom(source: Record<string, unknown>): string {
  // DeepSeek / Moonshot / vLLM use reasoning_content; OpenRouter / Groq use reasoning. Never take both.
  if (typeof source.reasoning_content === 'string' && source.reasoning_content.length > 0) return source.reasoning_content
  if (typeof source.reasoning === 'string' && source.reasoning.length > 0) return source.reasoning
  return ''
}

function readUsage(usage: unknown): { input?: number; output?: number; reasoning?: number } {
  if (!isRecord(usage)) return {}
  const out: { input?: number; output?: number; reasoning?: number } = {}
  if (typeof usage.prompt_tokens === 'number') out.input = usage.prompt_tokens
  if (typeof usage.completion_tokens === 'number') out.output = usage.completion_tokens
  if (isRecord(usage.completion_tokens_details) && typeof usage.completion_tokens_details.reasoning_tokens === 'number') {
    out.reasoning = usage.completion_tokens_details.reasoning_tokens
  } else if (typeof usage.reasoning_tokens === 'number') {
    out.reasoning = usage.reasoning_tokens
  }
  return out
}

export type ResponseReadOptions = {
  requestId: string
  /** Name used in error messages, e.g. "groq". */
  label: string
  onDelta?: (delta: ChatDelta) => void
  /** Echo provider reasoning back on later turns (see ECHO_REASONING_PROVIDERS). */
  captureReplay?: boolean
}

type Finish = {
  text: string
  thinking: string
  reasoningField: string
  responseId: string
  rawFinish: RawFinish | undefined
  calls: ToolAcc[]
  input: number
  output: number
  reasoning: number | undefined
}

function buildResponse(state: Finish, options: ResponseReadOptions): ChatResponse {
  const toolCalls = finalizeToolCalls(state.calls)
  if (toolCalls.length === 0 && state.rawFinish === 'content_filter' && state.text.length === 0) {
    throw new FatalRequestError(`${options.label} blocked the response (finish_reason: content_filter).`)
  }
  const finishReason: ChatResponse['finishReason'] =
    toolCalls.length > 0 ? 'tool_calls' : state.rawFinish === 'length' ? 'length' : 'stop'
  const usage = state.reasoning !== undefined
    ? { input: state.input, output: state.output, reasoning: state.reasoning }
    : { input: state.input, output: state.output }

  return {
    id: state.responseId,
    content: state.text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    usage,
    thinkingContent: state.thinking.length > 0 ? state.thinking : undefined,
    ...(options.captureReplay && state.reasoningField.length > 0
      ? { providerReplay: { openaiCompat: { reasoningContent: state.reasoningField } } }
      : {})
  }
}

/** Read an OpenAI-style SSE body to completion. */
export async function readChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  options: ResponseReadOptions & { onActivity?: () => void }
): Promise<ChatResponse> {
  const { onDelta } = options
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  const think = new ThinkTagStreamer()
  const state: Finish = {
    text: '',
    thinking: '',
    reasoningField: '',
    responseId: options.requestId,
    rawFinish: undefined,
    calls: [],
    input: 0,
    output: 0,
    reasoning: undefined
  }
  let buffer = ''

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return
    const dataStr = trimmed.slice(5).trim()
    if (!dataStr || dataStr === '[DONE]') return

    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(dataStr) as Record<string, unknown>
    } catch {
      return
    }
    if (!isRecord(chunk)) return

    // In-band error event (OpenRouter and others send these mid-stream with HTTP 200).
    if (typeof chunk.error === 'string' || isRecord(chunk.error)) {
      const detail = typeof chunk.error === 'string'
        ? chunk.error
        : typeof chunk.error.message === 'string' ? chunk.error.message : 'unknown error'
      throw new Error(`${options.label} stream error: ${detail.slice(0, 300)}`)
    }

    if (typeof chunk.id === 'string') state.responseId = chunk.id
    const usage = readUsage(chunk.usage)
    if (usage.input !== undefined) state.input = usage.input
    if (usage.output !== undefined) state.output = usage.output
    if (usage.reasoning !== undefined) state.reasoning = usage.reasoning

    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const choice = choices[0]
    if (!isRecord(choice)) return

    const finish = mapFinish(choice.finish_reason)
    if (finish) state.rawFinish = finish

    const delta = isRecord(choice.delta) ? choice.delta : {}

    const reasoning = reasoningFrom(delta)
    if (reasoning) {
      state.thinking += reasoning
      state.reasoningField += reasoning
      onDelta?.({ thinkingContent: reasoning })
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      const processed = think.process(delta.content, onDelta)
      state.text += processed.text
      state.thinking += processed.thinking
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tcDelta of delta.tool_calls) {
        if (isRecord(tcDelta)) applyToolCallDelta(state.calls, tcDelta)
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      options.onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    }
    buffer += decoder.decode()
    if (buffer.trim()) handleLine(buffer)

    const flushed = think.flush(onDelta)
    state.text += flushed.text
    state.thinking += flushed.thinking
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }

  return buildResponse(state, options)
}

/** Read a non-streaming chat.completion JSON payload (also used when a server ignores `stream: true`). */
export function readChatCompletionJson(
  payload: unknown,
  options: ResponseReadOptions
): ChatResponse {
  if (!isRecord(payload)) throw new Error(`${options.label} returned a non-object response.`)
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {}

  const calls: ToolAcc[] = []
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tc, i) => {
      if (isRecord(tc)) applyToolCallDelta(calls, { ...tc, index: typeof tc.index === 'number' ? tc.index : i })
    })
  }

  const reasoningField = reasoningFrom(message)
  let text = ''
  let thinking = reasoningField
  if (typeof message.content === 'string') {
    const extracted = extractThinkTags(message.content)
    text = extracted.text
    if (extracted.thinking) thinking = thinking ? `${thinking}\n${extracted.thinking}` : extracted.thinking
  }

  const usage = readUsage(payload.usage)
  return buildResponse(
    {
      text,
      thinking,
      reasoningField,
      responseId: typeof payload.id === 'string' ? payload.id : options.requestId,
      rawFinish: isRecord(choice) ? mapFinish(choice.finish_reason) : undefined,
      calls,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      reasoning: usage.reasoning
    },
    options
  )
}

// ── Adapter ──

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: string
  private readonly config: OpenAiCompatibleConfig
  private inflight = new Map<string, AbortController>()

  constructor(config: OpenAiCompatibleConfig) {
    this.id = config.providerId
    this.config = config
  }

  /** Effective base URL for a request: the profile override when set, else the provider default. */
  private effectiveBaseUrl(override?: string): string {
    const trimmed = override?.trim()
    return trimmed ? trimmed : this.config.baseUrl
  }

  /**
   * Resolve the credential for one request (never cached). Returns null when none is needed:
   * - `custom` endpoints use the optional CUSTOM_API_KEY;
   * - a built-in provider pointed at an origin other than its own API hosts (`baseUrl` and
   *   `officialBaseUrls`) gets no key (its key is never forwarded to a host it was not issued
   *   for), which also covers loopback servers.
   * A built-in provider talking to its own API without a key is a configuration error.
   */
  private resolveKey(baseUrl: string): string | null {
    if (this.id === 'custom') {
      const env = loadByokEnv()
      return env.CUSTOM_API_KEY ?? process.env.CUSTOM_API_KEY ?? null
    }

    const entry = catalogByProvider(this.id)
    if (!entry) throw new Error(`Unknown provider catalog entry for: ${this.id}`)
    const official = [this.config.baseUrl, ...(this.config.officialBaseUrls ?? [])]
    if (!official.some((url) => sameOrigin(baseUrl, url))) return null
    const env = loadByokEnv()
    const key = env[entry.envVar] ?? process.env[entry.envVar]
    if (!key) {
      if (isLoopbackUrl(baseUrl)) return null
      throw new Error(`No API key configured for ${entry.label}. Add it under Providers first.`)
    }
    return key
  }

  private safeError(error: unknown, key: string | null): string {
    let message = error instanceof Error ? error.message : String(error)
    if (key && key.length > 0) {
      message = message.split(key).join('[redacted]')
    }
    message = message.replace(/([?&](?:key|api_key|apiKey)=)[^&\s]+/gi, '$1[redacted]')
    return message
  }

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const baseUrl = this.effectiveBaseUrl(request.baseUrl)
    const key = this.resolveKey(baseUrl)
    const url = buildEndpointUrl(baseUrl, this.config.chatPath ?? '/chat/completions')
    const echoReasoning = ECHO_REASONING_PROVIDERS.has(this.id)

    const body: Record<string, unknown> = {
      model: request.model,
      messages: sanitizeMessages(request.messages, { echoReasoning }),
      stream: true
    }
    if (request.tools && request.tools.length > 0) body.tools = request.tools
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.topP !== undefined) body.top_p = request.topP

    const abort = new AbortController()
    if (request.signal) {
      if (request.signal.aborted) abort.abort()
      else request.signal.addEventListener('abort', () => abort.abort(), { once: true })
    }
    this.inflight.set(request.requestId, abort)

    try {
      return await this.fetchWithRetry(url, key, body, request.requestId, abort, echoReasoning, onDelta)
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
      const key = this.resolveKey(this.config.baseUrl)
      const url = buildEndpointUrl(this.config.baseUrl, this.config.probePath ?? '/models')
      const headers: Record<string, string> = {
        ...(this.config.defaultHeaders ?? {})
      }
      if (key) {
        headers.Authorization = `Bearer ${key}`
      }
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(5000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  private async fetchWithRetry(
    url: string,
    key: string | null,
    body: Record<string, unknown>,
    requestId: string,
    abort: AbortController,
    echoReasoning: boolean,
    onDelta?: (delta: ChatDelta) => void
  ): Promise<ChatResponse> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (abort.signal.aborted) {
        throw new Error(`Request ${requestId} was cancelled.`)
      }

      const guard = createIdleGuard(abort.signal, REQUEST_TIMEOUT_MS)
      // Once any delta reached the caller a retry would replay it, so mid-stream failures are final.
      let outputStarted = false
      const trackedDelta = onDelta
        ? (delta: ChatDelta): void => {
            outputStarted = true
            onDelta(delta)
          }
        : undefined

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          ...(this.config.defaultHeaders ?? {})
        }
        if (key) {
          headers.Authorization = `Bearer ${key}`
        }

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: guard.signal
        })

        if (!res.ok) {
          let text = ''
          try {
            text = await res.text()
          } catch {
            // body read failure
          }
          const message = `${this.id} API returned ${res.status}: ${text.slice(0, 300)}`
          if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
            lastError = new Error(message)
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
            continue
          }
          // Non-retryable (400/401/403/404/422…) or retries exhausted: fail fast, do not hammer the server.
          throw new FatalRequestError(message)
        }

        if (!res.body) throw new Error(`${this.id} API returned an empty response body.`)

        const options = { requestId, label: this.id, onDelta: trackedDelta, captureReplay: echoReasoning }
        const contentType = res.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          // Server ignored `stream: true` and answered with a plain chat.completion.
          const response = readChatCompletionJson(await res.json(), options)
          if (response.thinkingContent) onDelta?.({ thinkingContent: response.thinkingContent })
          if (response.content) onDelta?.({ content: response.content })
          return response
        }
        return await readChatCompletionStream(res.body, { ...options, onActivity: guard.touch })
      } catch (err) {
        if (abort.signal.aborted) {
          throw new Error(`Request ${requestId} was cancelled.`)
        }
        const detail = guard.timedOut
          ? new Error(`${this.id} stalled: no data for ${REQUEST_TIMEOUT_MS / 1000}s.`)
          : err
        lastError = new Error(this.safeError(detail, key))
        if (err instanceof FatalRequestError || outputStarted || attempt === MAX_RETRIES) break
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
      } finally {
        guard.dispose()
      }
    }

    throw lastError ?? new Error(`Request ${requestId} failed after ${MAX_RETRIES} retries.`)
  }
}
