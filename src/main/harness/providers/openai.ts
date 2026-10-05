/**
 * OpenAI provider adapter for the agentic harness.
 *
 * Implements native OpenAI Chat Completions API with tool calling,
 * support for standard models (GPT-4o) and reasoning models (o1, o3-mini)
 * with max_completion_tokens adaptation, streaming SSE, and credential resolution.
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
  ToolCall
} from './adapter'

const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const REQUEST_TIMEOUT_MS = 120_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getApiKey(): string {
  const env = loadByokEnv()
  const key = env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
  if (!key) throw new Error('No OpenAI API key is configured. Add OpenAI under Providers first.')
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

function isReasoningModel(model: string): boolean {
  const lower = model.toLowerCase()
  const base = lower.split('/').pop() ?? lower
  return base.startsWith('o1') || base.startsWith('o3') || base.startsWith('o4') || lower.includes('reasoner')
}

/** Sanitize messages for OpenAI: ensure assistant tool-calling messages use empty string, not null. */
function sanitizeMessages(messages: ChatMessage[], isReasoning = false): Record<string, unknown>[] {
  return messages.map((m) => {
    let role: string = m.role
    if (isReasoning && role === 'system') {
      role = 'developer'
    }
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

export class OpenAiAdapter implements ProviderAdapter {
  readonly id = 'openai'

  private inflight = new Map<string, AbortController>()

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const key = getApiKey()
    const baseUrl = request.baseUrl ?? OPENAI_BASE_URL
    const url = `${baseUrl}/chat/completions`

    const reasoning = isReasoningModel(request.model)
    const body: Record<string, unknown> = {
      model: request.model,
      messages: sanitizeMessages(request.messages, reasoning),
      stream: true,
      stream_options: { include_usage: true }
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
    }

    if (reasoning) {
      // Reasoning models (o1, o3-mini) use max_completion_tokens and do not accept temperature
      if (request.maxTokens !== undefined) {
        body.max_completion_tokens = request.maxTokens
      }
      if (request.thinking?.enabled) {
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
    key: string,
    body: Record<string, unknown>,
    requestId: string,
    abort: AbortController,
    onDelta?: (delta: ChatDelta) => void
  ): Promise<ChatResponse> {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify(body),
        signal: abort.signal.aborted
          ? AbortSignal.abort()
          : AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      })
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Request aborted.')
      throw new Error(`Unable to reach OpenAI: ${safeError(error)}`)
    }

    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 300)
      } catch { /* ignore */ }
      throw new Error(`OpenAI harness request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }

    if (!res.body) throw new Error('OpenAI returned an empty response body.')

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

    // Tool call accumulation map indexed by stream index
    const toolCallsMap = new Map<number, { id: string; name: string; args: string }>()

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

          // Text content delta
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            fullText += delta.content
            onDelta?.({ content: delta.content })
          }

          // Reasoning content delta (o1/o3-mini or deepseek-style)
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
            fullThinking += delta.reasoning_content
            onDelta?.({ thinkingContent: delta.reasoning_content })
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
  }
}
