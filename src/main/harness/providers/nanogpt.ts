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
import { ThinkTagStreamer, extractThinkTags } from './thinkTagStreamer'
import type {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  ChatDelta,
  ChatMessage,
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

      // Handle streaming SSE response
      const contentType = res.headers.get('content-type') ?? ''
      if (body.stream && res.body && (contentType.includes('event-stream') || !contentType.includes('json'))) {
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
                if (typeof chunk.usage.reasoning_tokens === 'number') reasoningTokens = chunk.usage.reasoning_tokens
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

              if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
                fullThinking += delta.reasoning_content
                onDelta?.({ thinkingContent: delta.reasoning_content })
              }

              if (typeof delta.content === 'string' && delta.content.length > 0) {
                const { text: processedText, thinking: processedThinking } = thinkStreamer.process(delta.content, onDelta)
                fullText += processedText
                fullThinking += processedThinking
              }

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

        if (toolCalls.length > 0) finishReason = 'tool_calls'

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
      }

      // Handle non-streaming JSON response
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
      let thinkingContent: string | undefined
      if (choices.length > 0) {
        const choice = choices[0] as Record<string, unknown>
        const message = isRecord(choice.message) ? choice.message : {}
        if (typeof message.reasoning_content === 'string') {
          thinkingContent = message.reasoning_content
        }
        if (typeof message.content === 'string') {
          const extracted = extractThinkTags(message.content)
          content = extracted.text
          if (extracted.thinking) {
            thinkingContent = (thinkingContent ? `${thinkingContent}\n` : '') + extracted.thinking
          }
        }
      }

      return {
        id: typeof payload.id === 'string' ? payload.id : requestId,
        content,
        toolCalls,
        finishReason,
        usage: extractUsage(payload),
        thinkingContent
      }
    }
  }
}
