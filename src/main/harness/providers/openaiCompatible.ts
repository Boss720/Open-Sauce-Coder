/**
 * Generic OpenAI-compatible provider adapter for the agentic harness.
 *
 * Supports providers that implement the standard OpenAI Chat Completions API:
 * Groq, Mistral, OpenRouter, Moonshot, xAI, Cerebras, etc.
 *
 * Resolves credentials securely from loadByokEnv() using the provider's envVar,
 * handles tool calls, timeouts, retries, and transport aborts.
 */
import { loadByokEnv } from '../../keys'
import { catalogByProvider } from '../../providerCatalog'
import type {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  ToolCall
} from './adapter'

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const MAX_RETRIES = 2
const REQUEST_TIMEOUT_MS = 120_000

export type OpenAiCompatibleConfig = {
  providerId: string
  baseUrl: string
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
      'HTTP-Referer': 'https://github.com/bosscube1/OPENCCODE',
      'X-Title': 'OpenCode Desktop'
    }
  },
  moonshot: {
    providerId: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
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
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: string
  private readonly config: OpenAiCompatibleConfig
  private inflight = new Map<string, AbortController>()

  constructor(config: OpenAiCompatibleConfig) {
    this.id = config.providerId
    this.config = config
  }

  private getApiKey(): string {
    const entry = catalogByProvider(this.id)
    if (!entry) throw new Error(`Unknown provider catalog entry for: ${this.id}`)
    const env = loadByokEnv()
    const key = env[entry.envVar] ?? process.env[entry.envVar]
    if (!key) throw new Error(`No API key configured for ${entry.label}. Add it under Providers first.`)
    return key
  }

  private safeError(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error)
    try {
      const key = this.getApiKey()
      if (key && key.length > 0) {
        message = message.split(key).join('[redacted]')
      }
    } catch {
      // Ignored if key not present
    }
    message = message.replace(/([?&](?:key|api_key|apiKey)=)[^&\s]+/gi, '$1[redacted]')
    return message
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const key = this.getApiKey()
    const chatPath = this.config.chatPath ?? '/chat/completions'
    const url = `${this.config.baseUrl}${chatPath}`

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false
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
      return await this.fetchWithRetry(url, key, body, request.requestId, abort)
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
      const key = this.getApiKey()
      const probePath = this.config.probePath ?? '/models'
      const url = `${this.config.baseUrl}${probePath}`
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${key}`,
          ...(this.config.defaultHeaders ?? {})
        },
        signal: AbortSignal.timeout(5000)
      })
      return res.ok
    } catch {
      return false
    }
  }

  private async fetchWithRetry(
    url: string,
    key: string,
    body: Record<string, unknown>,
    requestId: string,
    abort: AbortController
  ): Promise<ChatResponse> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (abort.signal.aborted) {
        throw new Error(`Request ${requestId} was cancelled.`)
      }

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const combined = AbortSignal.any([abort.signal, timeout])

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
            ...(this.config.defaultHeaders ?? {})
          },
          body: JSON.stringify(body),
          signal: combined
        })

        if (!res.ok) {
          const status = res.status
          let text = ''
          try {
            text = await res.text()
          } catch {
            // body read failure
          }

          if (RETRYABLE_STATUSES.has(status) && attempt < MAX_RETRIES) {
            const delay = 500 * 2 ** attempt
            await new Promise((resolve) => setTimeout(resolve, delay))
            continue
          }

          throw new Error(
            `${this.id} API returned ${status}: ${text.slice(0, 300)}`
          )
        }

        const data: unknown = await res.json()
        if (!isRecord(data)) {
          throw new Error(`Invalid JSON response from ${this.id} API.`)
        }

        const choices = Array.isArray(data.choices) ? data.choices : []
        const toolCalls = extractToolCalls(choices)
        const choice = choices[0]
        const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {}
        const content = typeof message.content === 'string' ? message.content : ''
        const finishReason = extractFinishReason(choices)
        const usage = extractUsage(data)

        return {
          id: typeof data.id === 'string' ? data.id : requestId,
          content,
          toolCalls,
          finishReason,
          usage
        }
      } catch (err) {
        if (abort.signal.aborted) {
          throw new Error(`Request ${requestId} was cancelled.`)
        }
        lastError = new Error(this.safeError(err))
        if (attempt === MAX_RETRIES) break
      }
    }

    throw lastError ?? new Error(`Request ${requestId} failed after ${MAX_RETRIES} retries.`)
  }
}
