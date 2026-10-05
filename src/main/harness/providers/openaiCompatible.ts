/**
 * Generic OpenAI-compatible provider adapter for the agentic harness.
 *
 * Supports providers that implement the standard OpenAI Chat Completions API:
 * Groq, Mistral, OpenRouter, DeepSeek, Moonshot, xAI, Cerebras, Custom/Local (Ollama, LM Studio).
 *
 * Resolves credentials securely from loadByokEnv() using the provider's envVar,
 * handles tool calls, timeouts, retries, <think> tag extraction, and streaming SSE.
 */
import { loadByokEnv } from '../../keys'
import { catalogByProvider } from '../../providerCatalog'
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
  deepseek: {
    providerId: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    probePath: '/models'
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

/** Sanitize messages: ensure assistant messages with tool calls use empty string content, not null. */
function sanitizeMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    const role = m.role
    const content = m.content ?? ''

    if (role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content,
        tool_calls: m.tool_calls
      }
    }

    if (role === 'tool') {
      return {
        role: 'tool',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        tool_call_id: m.tool_call_id
      }
    }

    return {
      role,
      content
    }
  })
}

import { ThinkTagStreamer } from './thinkTagStreamer'

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly id: string
  private readonly config: OpenAiCompatibleConfig
  private inflight = new Map<string, AbortController>()

  constructor(config: OpenAiCompatibleConfig) {
    this.id = config.providerId
    this.config = config
  }

  private getApiKey(): string | null {
    if (this.id === 'custom') {
      const env = loadByokEnv()
      return env.CUSTOM_API_KEY ?? process.env.CUSTOM_API_KEY ?? null
    }

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

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const key = this.getApiKey()
    const baseUrl = request.baseUrl ?? this.config.baseUrl
    const chatPath = this.config.chatPath ?? '/chat/completions'
    const url = `${baseUrl}${chatPath}`

    const body: Record<string, unknown> = {
      model: request.model,
      messages: sanitizeMessages(request.messages),
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
      return await this.fetchWithRetry(url, key, body, request.requestId, abort, onDelta)
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
    onDelta?: (delta: ChatDelta) => void
  ): Promise<ChatResponse> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (abort.signal.aborted) {
        throw new Error(`Request ${requestId} was cancelled.`)
      }

      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const combined = AbortSignal.any([abort.signal, timeout])

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

        if (!res.body) throw new Error(`${this.id} API returned an empty response body.`)

        const reader = res.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let buffer = ''

        let fullText = ''
        let fullThinking = ''
        let responseId = requestId
        let finishReason: ChatResponse['finishReason'] = 'stop'
        let inputTokens = 0
        let outputTokens = 0
        let reasoningTokens: number | undefined

        const toolCallsMap = new Map<number, { id: string; name: string; args: string }>()
        const thinkStreamer = new ThinkTagStreamer()

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() ?? ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || !trimmed.startsWith('data:')) continue
              const dataStr = trimmed.slice(5).trim()
              if (dataStr === '[DONE]') continue

              let chunk: Record<string, unknown>
              try {
                chunk = JSON.parse(dataStr) as Record<string, unknown>
              } catch {
                continue
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
              if (choices.length === 0) continue

              const choice = choices[0]
              if (!isRecord(choice)) continue

              if (typeof choice.finish_reason === 'string') {
                const fr = choice.finish_reason
                if (fr === 'tool_calls') finishReason = 'tool_calls'
                else if (fr === 'length') finishReason = 'length'
                else if (fr === 'stop') finishReason = 'stop'
              }

              const delta = isRecord(choice.delta) ? choice.delta : {}

              // Direct reasoning content if provided by endpoint (e.g. DeepSeek / OpenRouter)
              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
                fullThinking += delta.reasoning_content
                onDelta?.({ thinkingContent: delta.reasoning_content })
              }

              // Text content delta with <think> tag extraction
              if (typeof delta.content === 'string' && delta.content.length > 0) {
                const { text: processedText, thinking: processedThinking } = thinkStreamer.process(delta.content, onDelta)
                fullText += processedText
                fullThinking += processedThinking
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
          }

          // Flush any buffered text or thoughts in thinkStreamer
          const flushed = thinkStreamer.flush(onDelta)
          fullText += flushed.text
          fullThinking += flushed.thinking
        } finally {
          reader.releaseLock()
        }

        const toolCalls: ToolCall[] = []
        for (const item of toolCallsMap.values()) {
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

        const usage = reasoningTokens !== undefined
          ? { input: inputTokens, output: outputTokens, reasoning: reasoningTokens }
          : { input: inputTokens, output: outputTokens }

        return {
          id: responseId,
          content: fullText,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          finishReason,
          usage,
          thinkingContent: fullThinking.length > 0 ? fullThinking : undefined
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
