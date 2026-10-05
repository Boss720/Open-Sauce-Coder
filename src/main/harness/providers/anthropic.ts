/**
 * Anthropic Claude provider adapter for the agentic harness.
 *
 * Implements native Anthropic Messages API (/v1/messages) with tool use,
 * thinking blocks, streaming SSE, and credential resolution.
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
  FunctionDefinition,
  ToolCall
} from './adapter'

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1'
const ANTHROPIC_VERSION = '2023-06-01'
const REQUEST_TIMEOUT_MS = 120_000

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

/** Convert our FunctionDefinition[] to Anthropic tool declarations. */
function toAnthropicTools(tools: FunctionDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }))
}

/** Convert our ChatMessage[] to Anthropic system and messages payload. */
function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string
  messages: Record<string, unknown>[]
} {
  const systemParts: string[] = []
  const anthropicMessages: Record<string, unknown>[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    if (message.role === 'system') {
      if (typeof message.content === 'string') {
        systemParts.push(message.content)
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part.type === 'text') systemParts.push(part.text)
        }
      }
      continue
    }

    function appendUserContent(content: string | unknown[]) {
      const last = anthropicMessages[anthropicMessages.length - 1]
      if (last && last.role === 'user') {
        const lastContent = last.content
        if (typeof lastContent === 'string' && typeof content === 'string') {
          last.content = `${lastContent}\n\n${content}`
        } else {
          const lastBlocks = Array.isArray(lastContent)
            ? lastContent
            : [{ type: 'text', text: String(lastContent) }]
          const newBlocks = Array.isArray(content)
            ? content
            : [{ type: 'text', text: String(content) }]
          last.content = [...lastBlocks, ...newBlocks]
        }
      } else {
        anthropicMessages.push({ role: 'user', content })
      }
    }

    if (message.role === 'tool') {
      // Group contiguous tool result messages into a single user message with tool_result blocks
      const toolResults: Record<string, unknown>[] = []
      let j = i
      while (j < messages.length && messages[j].role === 'tool') {
        const cur = messages[j]
        const toolContent = typeof cur.content === 'string'
          ? cur.content
          : JSON.stringify(cur.content ?? '')
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
      if (message.tool_calls && message.tool_calls.length > 0) {
        const contentBlocks: Record<string, unknown>[] = []
        if (typeof message.content === 'string' && message.content.length > 0) {
          contentBlocks.push({ type: 'text', text: message.content })
        }
        for (const tc of message.tool_calls) {
          let input: Record<string, unknown> = {}
          try {
            input = JSON.parse(tc.function.arguments) as Record<string, unknown>
          } catch {
            input = {}
          }
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input
          })
        }
        anthropicMessages.push({
          role: 'assistant',
          content: contentBlocks
        })
      } else {
        anthropicMessages.push({
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : ''
        })
      }
      continue
    }

    // Role is user
    if (typeof message.content === 'string' || Array.isArray(message.content)) {
      appendUserContent(message.content)
    }
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
  return { system, messages: anthropicMessages }
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic'

  private inflight = new Map<string, AbortController>()

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const key = getApiKey()
    const url = `${request.baseUrl ?? ANTHROPIC_BASE_URL}/messages`

    const { system, messages } = toAnthropicMessages(request.messages)
    const maxTokens = request.maxTokens ?? 4096

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: maxTokens,
      stream: true
    }

    if (system) body.system = system
    if (request.tools && request.tools.length > 0) {
      body.tools = toAnthropicTools(request.tools)
    }

    if (request.thinking?.enabled) {
      // Anthropic requires budget_tokens >= 1024 and max_tokens > budget_tokens.
      // Crucially, temperature and top_p must NOT be set when extended thinking is enabled.
      const budget = Math.max(1024, request.thinking.budget ?? 2048)
      body.thinking = {
        type: 'enabled',
        budget_tokens: budget
      }
      if (maxTokens <= budget) {
        body.max_tokens = budget + 4096
      }
    } else {
      if (request.temperature !== undefined) body.temperature = request.temperature
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
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify(body),
        signal: abort.signal.aborted
          ? AbortSignal.abort()
          : AbortSignal.any([abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      })
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Request aborted.')
      throw new Error(`Unable to reach Anthropic: ${safeError(error)}`)
    }

    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 300)
      } catch { /* ignore */ }
      throw new Error(`Anthropic harness request failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
    }

    if (!res.body) throw new Error('Anthropic returned an empty response body.')

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    let fullText = ''
    let fullThinking = ''
    let responseId = requestId
    let finishReason: ChatResponse['finishReason'] = 'stop'
    let inputTokens = 0
    let outputTokens = 0

    // Tool use tracking during stream
    const toolCallsMap = new Map<number, { id: string; name: string; argsJson: string }>()

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

          let eventData: Record<string, unknown>
          try {
            eventData = JSON.parse(dataStr) as Record<string, unknown>
          } catch {
            continue
          }

          const type = typeof eventData.type === 'string' ? eventData.type : ''

          if (type === 'message_start' && isRecord(eventData.message)) {
            const msg = eventData.message
            if (typeof msg.id === 'string') responseId = msg.id
            if (isRecord(msg.usage) && typeof msg.usage.input_tokens === 'number') {
              inputTokens = msg.usage.input_tokens
            }
          } else if (type === 'content_block_start') {
            const idx = typeof eventData.index === 'number' ? eventData.index : 0
            if (isRecord(eventData.content_block)) {
              const cb = eventData.content_block
              if (cb.type === 'tool_use') {
                toolCallsMap.set(idx, {
                  id: typeof cb.id === 'string' ? cb.id : `call_${idx}`,
                  name: typeof cb.name === 'string' ? cb.name : '',
                  argsJson: ''
                })
              }
            }
          } else if (type === 'content_block_delta' && isRecord(eventData.delta)) {
            const idx = typeof eventData.index === 'number' ? eventData.index : 0
            const delta = eventData.delta
            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              fullText += delta.text
              onDelta?.({ content: delta.text })
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
              fullThinking += delta.thinking
              onDelta?.({ thinkingContent: delta.thinking })
            } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
              const current = toolCallsMap.get(idx)
              if (current) {
                current.argsJson += delta.partial_json
              }
            }
          } else if (type === 'message_delta') {
            if (isRecord(eventData.delta) && typeof eventData.delta.stop_reason === 'string') {
              const sr = eventData.delta.stop_reason
              if (sr === 'tool_use') finishReason = 'tool_calls'
              else if (sr === 'max_tokens') finishReason = 'length'
              else finishReason = 'stop'
            }
            if (isRecord(eventData.usage) && typeof eventData.usage.output_tokens === 'number') {
              outputTokens = eventData.usage.output_tokens
            }
          } else if (type === 'error' && isRecord(eventData.error)) {
            const msg = typeof eventData.error.message === 'string' ? eventData.error.message : 'Unknown stream error'
            throw new Error(`Anthropic stream error: ${msg}`)
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const toolCalls: ToolCall[] = []
    for (const item of toolCallsMap.values()) {
      toolCalls.push({
        id: item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.argsJson || '{}'
        }
      })
    }

    if (toolCalls.length > 0) {
      finishReason = 'tool_calls'
    }

    return {
      id: responseId,
      content: fullText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage: { input: inputTokens, output: outputTokens },
      thinkingContent: fullThinking.length > 0 ? fullThinking : undefined
    }
  }
}
