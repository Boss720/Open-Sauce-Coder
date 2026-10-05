/**
 * Google Gemini provider adapter for the agentic harness.
 *
 * Uses the @google/genai SDK (already a dependency for Gemini Live) to call
 * Gemini models directly. Supports function calling via the SDK's native
 * tool mechanism.
 *
 * SECURITY: the API key is resolved transiently via `loadByokEnv()` — never
 * cached, never logged. Error messages are redacted via `safeError`.
 */
import {
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Part as GeminiPart,
  type Tool
} from '@google/genai'
import { loadByokEnv } from '../../keys'
import type {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  ChatMessage,
  FunctionDefinition,
  ToolCall
} from './adapter'

function getApiKey(): string {
  const env = loadByokEnv()
  const key =
    env.GEMINI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GOOGLE_API_KEY
  if (!key) throw new Error('No Google API key is configured. Add Google under Providers first.')
  return key
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Convert our ChatMessage[] to Gemini SDK Content[]. */
function toGeminiContents(messages: ChatMessage[]): { systemInstruction?: string; contents: Content[] } {
  let systemInstruction: string | undefined
  const contents: Content[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      systemInstruction = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((p) => p.type === 'text').map((p) => 'text' in p ? p.text : '').join('\n')
          : undefined
      continue
    }

    const role = message.role === 'assistant' ? 'model' : 'user'

    if (message.role === 'tool' && message.tool_call_id) {
      const responseContent = typeof message.content === 'string' ? message.content : ''
      let parsedResponse: Record<string, unknown>
      try {
        parsedResponse = JSON.parse(responseContent) as Record<string, unknown>
      } catch {
        parsedResponse = { result: responseContent }
      }
      contents.push({
        role: 'function',
        parts: [{
          functionResponse: {
            name: message.tool_call_id,
            response: parsedResponse
          }
        }]
      })
      continue
    }

    if (message.tool_calls && message.tool_calls.length > 0) {
      const parts: GeminiPart[] = []
      if (typeof message.content === 'string' && message.content.length > 0) {
        parts.push({ text: message.content })
      }
      for (const tc of message.tool_calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>
        } catch { /* leave empty */ }
        parts.push({
          functionCall: {
            name: tc.function.name,
            args
          }
        })
      }
      contents.push({ role, parts })
      continue
    }

    const parts: GeminiPart[] = []
    if (typeof message.content === 'string') {
      parts.push({ text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text })
        }
      }
    }
    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return { systemInstruction, contents }
}

/** Convert our FunctionDefinition[] to Gemini SDK Tool[]. */
function toGeminiTools(tools: FunctionDefinition[]): Tool[] {
  const declarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as Record<string, unknown>
  }))
  return [{ functionDeclarations: declarations }]
}

/** Extract tool calls from a Gemini response. */
function extractGeminiToolCalls(response: GenerateContentResponse): ToolCall[] | undefined {
  const candidates = response.candidates
  if (!candidates || candidates.length === 0) return undefined

  const parts = candidates[0].content?.parts
  if (!parts) return undefined

  const toolCalls: ToolCall[] = []
  for (const part of parts) {
    const fc = part.functionCall as FunctionCall | undefined
    if (fc && fc.name) {
      toolCalls.push({
        id: fc.name,
        type: 'function',
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args ?? {})
        }
      })
    }
  }
  return toolCalls.length > 0 ? toolCalls : undefined
}

/** Extract text content from a Gemini response. */
function extractGeminiText(response: GenerateContentResponse): string {
  const candidates = response.candidates
  if (!candidates || candidates.length === 0) return ''

  const parts = candidates[0].content?.parts
  if (!parts) return ''

  return parts
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
}

/** Extract usage metrics from a Gemini response. */
function extractGeminiUsage(response: GenerateContentResponse): { input: number; output: number; reasoning?: number } {
  const metadata = response.usageMetadata
  if (!metadata) return { input: 0, output: 0 }
  const input = metadata.promptTokenCount ?? 0
  const output = metadata.candidatesTokenCount ?? 0
  const thinking = isRecord(metadata) && typeof (metadata as Record<string, unknown>).thoughtsTokenCount === 'number'
    ? (metadata as Record<string, unknown>).thoughtsTokenCount as number
    : undefined
  return thinking !== undefined ? { input, output, reasoning: thinking } : { input, output }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'google'

  private inflight = new Map<string, AbortController>()

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const key = getApiKey()
    const client = new GoogleGenAI({ apiKey: key })

    const { systemInstruction, contents } = toGeminiContents(request.messages)
    const abort = new AbortController()
    if (request.signal) {
      if (request.signal.aborted) abort.abort()
      else request.signal.addEventListener('abort', () => abort.abort(), { once: true })
    }
    this.inflight.set(request.requestId, abort)

    try {
      const config: Record<string, unknown> = {}
      if (request.temperature !== undefined) config.temperature = request.temperature
      if (request.maxTokens !== undefined) config.maxOutputTokens = request.maxTokens
      if (request.topP !== undefined) config.topP = request.topP
      if (request.thinking?.enabled) {
        config.thinkingConfig = {
          thinkingBudget: request.thinking.budget ?? 8192
        }
      }

      const tools = request.tools && request.tools.length > 0
        ? toGeminiTools(request.tools)
        : undefined

      const response = await client.models.generateContent({
        model: request.model,
        contents,
        config: {
          ...config,
          abortSignal: abort.signal,
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(tools ? { tools } : {})
        }
      })

      const toolCalls = extractGeminiToolCalls(response)
      const content = extractGeminiText(response)
      const usage = extractGeminiUsage(response)
      const finishReason: ChatResponse['finishReason'] = toolCalls
        ? 'tool_calls'
        : (response.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop')

      return {
        id: request.requestId,
        content,
        toolCalls,
        finishReason,
        usage
      }
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Request aborted.')
      throw new Error(`Gemini harness request failed: ${safeError(error)}`)
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
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`,
        { signal: AbortSignal.timeout(5000) }
      )
      return res.ok
    } catch {
      return false
    }
  }
}
