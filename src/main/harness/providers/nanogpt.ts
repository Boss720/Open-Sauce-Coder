/**
 * NanoGPT provider adapter for the agentic harness.
 *
 * Implements the ProviderAdapter interface against NanoGPT's OpenAI-compatible
 * `/api/v1/chat/completions` endpoint (standard billing) or
 * `/api/subscription/v1/chat/completions` (subscription billing).
 *
 * Supports tool calling, reasoning tokens, and streaming SSE.
 *
 * SECURITY: the API key is resolved transiently via `loadByokEnv()` — never
 * cached, never logged, never returned across IPC. All error messages are
 * routed through `safeError` before leaving this module.
 */
import { loadByokEnv } from '../../keys'
import { nanogptLimiter } from '../../nanogptLimiter'
import {
  createIdleGuard,
  readChatCompletionJson,
  readChatCompletionStream,
  sanitizeMessages
} from './openaiCompatible'
import type {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  ChatDelta
} from './adapter'

const BASE = 'https://nano-gpt.com'

const SUBSCRIPTION_PATH = '/api/subscription/v1/chat/completions'
const STANDARD_PATH = '/api/v1/chat/completions'

/** HTTP statuses safe to retry per NanoGPT contract. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 503])
const MAX_RETRIES = 2
const REQUEST_TIMEOUT_MS = 120_000

function getApiKey(): string {
  const env = loadByokEnv()
  const key = env.NANOGPT_API_KEY ?? process.env.NANOGPT_API_KEY
  if (!key) throw new Error('No NanoGPT API key is configured. Add NanoGPT under Providers first.')
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

function backoffWithJitter(attempt: number): number {
  const base = 500 * 2 ** attempt
  return base + Math.random() * base * 0.5
}

export class NanoGptAdapter implements ProviderAdapter {
  readonly id = 'nanogpt'

  private inflight = new Map<string, AbortController>()

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const key = getApiKey()
    const path = request.billingRoute === 'standard' ? STANDARD_PATH : SUBSCRIPTION_PATH
    const modelId = request.routingSuffix
      ? `${request.model}${request.routingSuffix}`
      : request.model

    const isStreaming = Boolean(onDelta)
    const body: Record<string, unknown> = {
      model: modelId,
      messages: sanitizeMessages(request.messages),
      stream: isStreaming
    }
    if (request.tools && request.tools.length > 0) body.tools = request.tools
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.topP !== undefined) body.top_p = request.topP
    if (request.caching) body.caching = true

    const abort = new AbortController()
    if (request.signal) {
      if (request.signal.aborted) abort.abort()
      else request.signal.addEventListener('abort', () => abort.abort(), { once: true })
    }
    this.inflight.set(request.requestId, abort)

    const release = await nanogptLimiter.acquireSlot()
    try {
      return await this.fetchWithRetry(path, key, body, request.requestId, abort, onDelta)
    } finally {
      release()
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
      const res = await fetch(`${BASE}/api/subscription/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  private async fetchWithRetry(
    path: string,
    key: string,
    body: Record<string, unknown>,
    requestId: string,
    abort: AbortController,
    onDelta?: (delta: ChatDelta) => void
  ): Promise<ChatResponse> {
    let attempt = 0
    for (;;) {
      // The idle guard replaces a fixed total timeout: it only fires when the server goes
      // silent, so long reasoning streams are never cut off mid-answer.
      const guard = createIdleGuard(abort.signal, REQUEST_TIMEOUT_MS)
      let retryDelay: number | null = null
      try {
        let res: Response | undefined
        try {
          res = await fetch(`${BASE}${path}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal: guard.signal
          })
        } catch (error) {
          if (abort.signal.aborted) throw new Error('Request aborted.')
          if (attempt >= MAX_RETRIES) throw new Error(`Unable to reach NanoGPT: ${safeError(error)}`)
          retryDelay = backoffWithJitter(attempt)
        }

        if (res && !res.ok) {
          if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
            retryDelay = backoffWithJitter(attempt)
          } else {
            let detail = ''
            try {
              detail = (await res.text()).slice(0, 200)
            } catch { /* ignore */ }
            throw new Error(safeError(
              new Error(`NanoGPT harness request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
            ))
          }
        } else if (res) {
          const options = { requestId, label: 'NanoGPT', onDelta }
          try {
            // Streaming SSE response
            const contentType = res.headers.get('content-type') ?? ''
            if (body.stream && res.body && (contentType.includes('event-stream') || !contentType.includes('json'))) {
              return await readChatCompletionStream(res.body, { ...options, onActivity: guard.touch })
            }

            // Non-streaming JSON response
            let payload: unknown
            try {
              payload = await res.json()
            } catch (error) {
              throw new Error(`Unable to parse NanoGPT response: ${safeError(error)}`)
            }
            return readChatCompletionJson(payload, options)
          } catch (error) {
            if (abort.signal.aborted) throw new Error('Request aborted.')
            // Mid-stream failures are final: a retry would replay deltas the caller already received.
            if (guard.timedOut) throw new Error(`NanoGPT stream stalled: no data for ${REQUEST_TIMEOUT_MS / 1000}s.`)
            throw new Error(safeError(error))
          }
        }
      } finally {
        guard.dispose()
      }

      if (retryDelay !== null) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay))
        attempt++
      }
    }
  }
}
