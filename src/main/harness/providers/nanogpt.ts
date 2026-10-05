/**
 * NanoGPT provider adapter for the agentic harness.
 *
 * Implements the ProviderAdapter interface against NanoGPT's OpenAI-compatible
 * `/api/v1/chat/completions` endpoint (standard billing) or
 * `/api/subscription/v1/chat/completions` (subscription billing).
 *
 * SECURITY: the API key is resolved transiently via `loadByokEnv()` — never
 * cached, never logged, never returned across IPC. All error messages are
 * routed through `safeError` before leaving this module.
 */
import { loadByokEnv } from '../../keys'
import { nanogptLimiter } from '../../nanogptLimiter'
import type {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  ToolCall
} from './adapter'

const BASE = 'https://nano-gpt.com'

const SUBSCRIPTION_PATH = '/api/subscription/v1/chat/completions'
const STANDARD_PATH = '/api/v1/chat/completions'

/** HTTP statuses safe to retry per NanoGPT contract. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 503])
const MAX_RETRIES = 2
const REQUEST_TIMEOUT_MS = 120_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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

function extractToolCalls(choices: unknown[]): ToolCall[] | undefined {
  if (choices.length === 0) return undefined
  const choice = choices[0]
  if (!isRecord(choice)) return undefined
  const message = isRecord(choice.message) ? choice.message : undefined
  if (!message) return undefined
  if (!Array.isArray(message.tool_calls)) return undefined

  const toolCalls: ToolCall[] = []
  for (const tc of message.tool_calls) {
    if (!isRecord(tc)) continue
    if (typeof tc.id !== 'string') continue
    if (!isRecord(tc.function)) continue
    if (typeof tc.function.name !== 'string') continue
    toolCalls.push({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : '{}'
      }
    })
  }
  return toolCalls.length > 0 ? toolCalls : undefined
}

function extractFinishReason(choices: unknown[]): ChatResponse['finishReason'] {
  if (choices.length === 0) return 'error'
  const choice = choices[0]
  if (!isRecord(choice)) return 'error'
  const reason = choice.finish_reason
  if (reason === 'stop') return 'stop'
  if (reason === 'tool_calls') return 'tool_calls'
  if (reason === 'length') return 'length'
  return 'stop'
}

function extractUsage(payload: Record<string, unknown>): { input: number; output: number; reasoning?: number } {
  const usage = isRecord(payload.usage) ? payload.usage : {}
  const input = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const output = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const reasoning = typeof usage.reasoning_tokens === 'number' ? usage.reasoning_tokens : undefined
  return reasoning !== undefined ? { input, output, reasoning } : { input, output }
}

export class NanoGptAdapter implements ProviderAdapter {
  readonly id = 'nanogpt'

  private inflight = new Map<string, AbortController>()

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const key = getApiKey()
    const path = request.billingRoute === 'standard' ? STANDARD_PATH : SUBSCRIPTION_PATH
    const modelId = request.routingSuffix
      ? `${request.model}${request.routingSuffix}`
      : request.model

    const body: Record<string, unknown> = {
      model: modelId,
      messages: request.messages,
      stream: false
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
      return await this.fetchWithRetry(path, key, body, request.requestId, abort)
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
    abort: AbortController
  ): Promise<ChatResponse> {
    let attempt = 0
    for (;;) {
      let res: Response
      try {
        res = await fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body),
          signal: abort.signal.aborted
            ? AbortSignal.abort()
            : AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        })
      } catch (error) {
        if (abort.signal.aborted) throw new Error('Request aborted.')
        if (attempt >= MAX_RETRIES) throw new Error(`Unable to reach NanoGPT: ${safeError(error)}`)
        await new Promise((resolve) => setTimeout(resolve, backoffWithJitter(attempt)))
        attempt++
        continue
      }

      if (!res.ok) {
        if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, backoffWithJitter(attempt)))
          attempt++
          continue
        }
        let detail = ''
        try {
          detail = (await res.text()).slice(0, 200)
        } catch { /* ignore */ }
        throw new Error(safeError(
          new Error(`NanoGPT harness request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
        ))
      }

      let payload: unknown
      try {
        payload = await res.json()
      } catch (error) {
        throw new Error(`Unable to parse NanoGPT response: ${safeError(error)}`)
      }
      if (!isRecord(payload)) throw new Error('NanoGPT returned a non-object response.')

      const choices = Array.isArray(payload.choices) ? payload.choices : []
      const toolCalls = extractToolCalls(choices)
      const finishReason = toolCalls ? 'tool_calls' : extractFinishReason(choices)

      let content = ''
      if (choices.length > 0) {
        const choice = choices[0] as Record<string, unknown>
        const message = isRecord(choice.message) ? choice.message : {}
        if (typeof message.content === 'string') content = message.content
      }

      return {
        id: typeof payload.id === 'string' ? payload.id : requestId,
        content,
        toolCalls,
        finishReason,
        usage: extractUsage(payload)
      }
    }
  }
}
