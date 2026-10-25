/**
 * Google Gemini provider adapter for the agentic harness.
 *
 * Uses the @google/genai SDK (already a dependency for Gemini Live) to call
 * Gemini models directly. Supports function calling via the SDK's native
 * tool mechanism.
 *
 * Gemini specifics handled here:
 * - Thought signatures: `thoughtSignature` on response parts is captured while streaming and
 *   echoed verbatim, on the same parts and in the original order, when the assistant turn is
 *   replayed (Gemini 3 rejects a function-call turn without them with HTTP 400; Gemini 2.5
 *   loses reasoning quality). They travel in `providerReplay.gemini`. Gemini 3 turns that have
 *   no signature to echo (other provider, gemini-2.5, no replay) get a documented dummy instead.
 * - `finishReason` is "STOP" even when function calls were returned, so tool calls win.
 * - Function calls frequently carry no `id`; unique ids are synthesised and responses are
 *   matched to calls by id -> function name.
 * - Gemini 3 takes `thinkingConfig.thinkingLevel`, 2.5 takes `thinkingBudget` (never both).
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
  ChatDelta,
  ChatMessage,
  FunctionDefinition,
  ProviderReplay,
  ToolCall
} from './adapter'

/** Prefix of tool-call ids this adapter invents when Gemini supplies none. Never sent back to Gemini. */
const SYNTHETIC_ID_PREFIX = 'gemini-call-'

/**
 * Google's documented placeholder for function calls Gemini 3 did not sign itself (history from
 * another provider or from gemini-2.5). Verified live 2026-10-25 on gemini-3.5-flash: a functionCall
 * without a signature -> HTTP 400, with this value -> HTTP 200.
 */
const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

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

function safeError(error: unknown, key?: string): string {
  let message = error instanceof Error ? error.message : String(error)
  if (key && key.length > 0) message = message.split(key).join('[redacted]')
  return message.replace(/([?&](?:key|api_key|apiKey)=)[^&\s]+/gi, '$1[redacted]')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSyntheticId(id: string): boolean {
  return id.startsWith(SYNTHETIC_ID_PREFIX)
}

function geminiModelId(model: string): string {
  return model.toLowerCase().replace(/^models\//, '')
}

function isGemini3(model: string): boolean {
  return geminiModelId(model).includes('gemini-3')
}

// ── Replay (thought signatures) ──

/** One model-turn part as Gemini returned it, reduced to what must be echoed back. */
export type GeminiReplayPart = {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name: string; args: Record<string, unknown> }
  /** Id of the harness ToolCall this functionCall was surfaced as. */
  callId?: string
}

function readGeminiReplay(replay: ProviderReplay | undefined): GeminiReplayPart[] | null {
  const raw = replay?.gemini
  if (!isRecord(raw) || !Array.isArray(raw.parts)) return null
  const parts: GeminiReplayPart[] = []
  for (const item of raw.parts) {
    if (!isRecord(item)) continue
    const part: GeminiReplayPart = {}
    if (typeof item.text === 'string') part.text = item.text
    if (item.thought === true) part.thought = true
    if (typeof item.thoughtSignature === 'string' && item.thoughtSignature.length > 0) part.thoughtSignature = item.thoughtSignature
    if (typeof item.callId === 'string') part.callId = item.callId
    if (isRecord(item.functionCall) && typeof item.functionCall.name === 'string') {
      part.functionCall = {
        name: item.functionCall.name,
        args: isRecord(item.functionCall.args) ? item.functionCall.args : {},
        ...(typeof item.functionCall.id === 'string' && item.functionCall.id.length > 0 ? { id: item.functionCall.id } : {})
      }
    }
    parts.push(part)
  }
  return parts
}

/** Turn replay parts back into SDK parts, dropping thought summaries that carry no signature. */
function replayToParts(replay: GeminiReplayPart[]): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const p of replay) {
    if (p.functionCall) {
      parts.push({
        functionCall: {
          ...(p.functionCall.id ? { id: p.functionCall.id } : {}),
          name: p.functionCall.name,
          args: p.functionCall.args
        },
        ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {})
      })
      continue
    }
    if (typeof p.text !== 'string') continue
    if (!p.thoughtSignature && (p.thought || p.text.length === 0)) continue
    parts.push({
      text: p.text,
      ...(p.thought ? { thought: true } : {}),
      ...(p.thoughtSignature ? { thoughtSignature: p.thoughtSignature } : {})
    })
  }
  return parts
}

/**
 * Gemini 3 rejects a model turn whose function calls carry no signature. When none of the turn's
 * calls is signed, put the dummy on the first call only (Gemini signs only the first of a parallel set).
 */
function withDummySignature(parts: GeminiPart[]): GeminiPart[] {
  const first = parts.findIndex((p) => p.functionCall)
  if (first === -1 || parts.some((p) => p.functionCall && p.thoughtSignature)) return parts
  return parts.map((p, i) => (i === first ? { ...p, thoughtSignature: DUMMY_THOUGHT_SIGNATURE } : p))
}

// ── Message conversion ──

/**
 * Convert our ChatMessage[] to Gemini SDK Content[]. `model` only matters for Gemini 3, where
 * unsigned function-call turns get a placeholder signature; without it nothing is added.
 */
export function toGeminiContents(
  messages: ChatMessage[],
  tools?: FunctionDefinition[],
  model?: string
): { systemInstruction?: string; contents: Content[] } {
  const systemSegments: string[] = []
  const contents: Content[] = []
  const signCalls = (parts: GeminiPart[]): GeminiPart[] =>
    model !== undefined && isGemini3(model) ? withDummySignature(parts) : parts

  const declaredToolNames = new Set<string>()
  if (tools) {
    for (const t of tools) {
      if (t.function?.name) {
        declaredToolNames.add(t.function.name)
      }
    }
  }

  // Whole-conversation fallback (id -> name) for tool results whose call is not in the preceding turn.
  const toolCallNames = new Map<string, string>()
  for (const message of messages) {
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        if (tc.id) {
          toolCallNames.set(tc.id, tc.function.name)
        }
        if (tc.function?.name) {
          toolCallNames.set(tc.function.name, tc.function.name)
        }
      }
    }
  }

  // Calls of the most recent assistant turn: harness id -> function name, Gemini's own id, position.
  let turnCalls = new Map<string, { name: string; geminiId?: string; order: number }>()

  function resolveFunctionName(callId?: string, explicitName?: string): string {
    if (callId) {
      const fromTurn = turnCalls.get(callId)
      if (fromTurn) return fromTurn.name
      const fromMap = toolCallNames.get(callId)
      if (fromMap) return fromMap
    }
    if (explicitName && (declaredToolNames.has(explicitName) || declaredToolNames.size === 0)) {
      return explicitName
    }
    if (callId) {
      if (declaredToolNames.has(callId)) return callId
      for (const declared of declaredToolNames) {
        if (callId.includes(declared)) return declared
      }
    }
    if (explicitName) return explicitName
    if (declaredToolNames.size === 1) {
      return Array.from(declaredToolNames)[0]
    }
    return callId || 'unknown'
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    if (message.role === 'system') {
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((p) => p.type === 'text').map((p) => 'text' in p ? p.text : '').join('\n')
          : ''
      if (text.length > 0) systemSegments.push(text)
      continue
    }

    if (message.role === 'tool') {
      // All results answering one model turn travel together in a single user turn.
      const collected: { part: GeminiPart; order: number }[] = []
      while (i < messages.length && messages[i].role === 'tool') {
        const toolMsg = messages[i]
        const responseContent = typeof toolMsg.content === 'string'
          ? toolMsg.content
          : toolMsg.content === null || toolMsg.content === undefined
            ? ''
            : JSON.stringify(toolMsg.content)

        let parsedResponse: Record<string, unknown>
        try {
          const parsed: unknown = JSON.parse(responseContent)
          // functionResponse.response must be a JSON object: wrap arrays and primitives.
          parsedResponse = isRecord(parsed) && !Array.isArray(parsed) ? parsed : { result: parsed }
        } catch {
          parsedResponse = { result: responseContent }
        }

        const callId = toolMsg.tool_call_id
        const call = callId ? turnCalls.get(callId) : undefined
        const functionName = call
          ? call.name
          : resolveFunctionName(callId, (toolMsg as { name?: string }).name)

        const functionResponse: { name: string; response: Record<string, unknown>; id?: string } = {
          name: functionName,
          response: parsedResponse
        }
        // Echo Gemini's own id only; ids we synthesised mean nothing to the API.
        const responseId = call ? call.geminiId : (callId && !isSyntheticId(callId) ? callId : undefined)
        if (responseId) functionResponse.id = responseId

        collected.push({ part: { functionResponse }, order: call?.order ?? Number.POSITIVE_INFINITY })
        i++
      }
      i-- // adjust because for-loop increments i

      if (collected.length > 0) {
        // Keep results in the same order as the calls they answer when every call is known.
        if (collected.every((c) => Number.isFinite(c.order))) collected.sort((a, b) => a.order - b.order)
        contents.push({
          role: 'user',
          parts: collected.map((c) => c.part)
        })
      }
      continue
    }

    const role = message.role === 'assistant' ? 'model' : 'user'

    if (message.role === 'assistant') {
      const toolCalls = message.tool_calls ?? []
      const replay = readGeminiReplay(message.providerReplay)

      if (toolCalls.length > 0) {
        turnCalls = new Map()
        const replayCalls = replay?.filter((p) => p.functionCall) ?? []
        const replayUsable =
          replay !== null &&
          replayCalls.length === toolCalls.length &&
          replayCalls.every((p) => p.callId !== undefined && toolCalls.some((tc) => tc.id === p.callId))

        if (replayUsable && replay) {
          // Exact echo: same parts, same order, signatures attached where Gemini put them.
          toolCalls.forEach((tc, order) => {
            const original = replayCalls.find((p) => p.callId === tc.id)?.functionCall
            turnCalls.set(tc.id, { name: tc.function.name, geminiId: original?.id, order })
          })
          const parts = replayToParts(replay)
          if (parts.length > 0) {
            contents.push({ role, parts: signCalls(parts) })
            continue
          }
        }

        // No (usable) replay: rebuild from the harness message. No real signatures are available here.
        turnCalls = new Map()
        const parts: GeminiPart[] = []
        if (typeof message.content === 'string' && message.content.length > 0) {
          parts.push({ text: message.content })
        }
        toolCalls.forEach((tc, order) => {
          let args: Record<string, unknown> = {}
          try {
            const parsed: unknown = JSON.parse(tc.function.arguments)
            if (isRecord(parsed) && !Array.isArray(parsed)) args = parsed
          } catch { /* leave empty */ }
          const geminiId = tc.id && !isSyntheticId(tc.id) ? tc.id : undefined
          turnCalls.set(tc.id, { name: tc.function.name, geminiId, order })
          parts.push({
            functionCall: {
              ...(geminiId ? { id: geminiId } : {}),
              name: tc.function.name,
              args
            }
          })
        })
        contents.push({ role, parts: signCalls(parts) })
        continue
      }

      // Text-only assistant turn: echo signed parts too, provided the text is unchanged.
      if (replay && typeof message.content === 'string') {
        const replayText = replay.filter((p) => !p.thought && !p.functionCall).map((p) => p.text ?? '').join('')
        if (replayText === message.content && replay.some((p) => p.thoughtSignature)) {
          const parts = replayToParts(replay)
          if (parts.length > 0) {
            contents.push({ role, parts })
            continue
          }
        }
      }
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

  const systemInstruction = systemSegments.length > 0 ? systemSegments.join('\n\n') : undefined
  return { systemInstruction, contents }
}

/** Convert our FunctionDefinition[] to Gemini SDK Tool[]. */
export function toGeminiTools(tools: FunctionDefinition[]): Tool[] {
  const declarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters as Record<string, unknown>
  }))
  return [{ functionDeclarations: declarations }]
}

/**
 * Build `generationConfig.thinkingConfig` for a model.
 * - Gemini 3: `thinkingLevel` (LOW/HIGH are valid on every Gemini 3 model). Combining it with
 *   `thinkingBudget` is rejected with HTTP 400, so the budget is only used to pick the level.
 * - Gemini 2.5 (and unknown names): `thinkingBudget` in tokens.
 * - Gemini 1.x / 2.0 (non-"thinking"): no thinking support, so no config is sent.
 * `includeThoughts` makes the model return thought summaries as `part.thought === true` parts.
 */
export function buildGeminiThinkingConfig(
  model: string,
  thinking: ChatRequest['thinking']
): Record<string, unknown> | undefined {
  if (!thinking?.enabled) return undefined
  const id = geminiModelId(model)
  if (isGemini3(model)) {
    return {
      includeThoughts: true,
      ...(thinking.budget !== undefined ? { thinkingLevel: thinking.budget <= 4096 ? 'LOW' : 'HIGH' } : {})
    }
  }
  if (/gemini-(?:1\.|2\.0)/.test(id) && !id.includes('thinking')) return undefined
  const ceiling = id.includes('pro') ? 32768 : 24576
  return {
    includeThoughts: true,
    thinkingBudget: Math.min(ceiling, Math.max(512, Math.round(thinking.budget ?? 8192)))
  }
}

// ── Response helpers ──

/** Extract tool calls from a Gemini response. Calls without an id get a unique synthesised one. */
export function extractGeminiToolCalls(
  response: GenerateContentResponse,
  idSeed = 'response'
): ToolCall[] | undefined {
  const candidates = response.candidates
  if (!candidates || candidates.length === 0) return undefined

  const parts = candidates[0].content?.parts
  if (!parts) return undefined

  const toolCalls: ToolCall[] = []
  for (const part of parts) {
    const fc = part.functionCall as FunctionCall | undefined
    if (fc && fc.name) {
      toolCalls.push({
        id: fc.id || `${SYNTHETIC_ID_PREFIX}${idSeed}-${toolCalls.length}`,
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

/** Extract answer text (thought summaries excluded) from a Gemini response. */
export function extractGeminiText(response: GenerateContentResponse): string {
  const candidates = response.candidates
  if (!candidates || candidates.length === 0) return ''

  const parts = candidates[0].content?.parts
  if (!parts) return ''

  return parts
    .filter((p) => typeof p.text === 'string' && (p as Record<string, unknown>).thought !== true)
    .map((p) => p.text)
    .join('')
}

/** Extract usage metrics from a Gemini response. */
export function extractGeminiUsage(response: GenerateContentResponse): { input: number; output: number; reasoning?: number } {
  const metadata = response.usageMetadata
  if (!metadata) return { input: 0, output: 0 }
  const input = metadata.promptTokenCount ?? 0
  const output = metadata.candidatesTokenCount ?? 0
  const thinking = isRecord(metadata) && typeof (metadata as Record<string, unknown>).thoughtsTokenCount === 'number'
    ? (metadata as Record<string, unknown>).thoughtsTokenCount as number
    : undefined
  return thinking !== undefined ? { input, output, reasoning: thinking } : { input, output }
}

/** finishReason values that end a turn normally. Anything else without usable output is an error. */
const NORMAL_FINISH = new Set(['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'])
/** Reasons that mean the output was withheld; surfaced even when some text had already streamed. */
const WITHHELD_FINISH = new Set(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY'])

const STOP_DESCRIPTIONS: Record<string, string> = {
  SAFETY: 'the response was blocked by Gemini safety filters',
  RECITATION: 'the response was blocked because it would recite protected material',
  PROHIBITED_CONTENT: 'the response was blocked as prohibited content',
  BLOCKLIST: 'the response was blocked because it contained blocklisted terms',
  SPII: 'the response was blocked because it may contain sensitive personal information',
  LANGUAGE: 'the model does not support the language used',
  MALFORMED_FUNCTION_CALL: 'the model produced a malformed function call',
  UNEXPECTED_TOOL_CALL: 'the model called a tool that was not enabled',
  TOO_MANY_TOOL_CALLS: 'the model made too many tool calls in a row',
  MISSING_THOUGHT_SIGNATURE: 'a thought signature was missing from the conversation history'
}

class GeminiStopError extends Error {}

function describeStop(reason: string): string {
  return `Gemini stopped without a usable answer (${reason}): ${STOP_DESCRIPTIONS[reason] ?? 'no further detail was provided'}.`
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'google'

  private inflight = new Map<string, AbortController>()

  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const key = getApiKey()
    const client = new GoogleGenAI({ apiKey: key })

    const { systemInstruction, contents } = toGeminiContents(request.messages, request.tools, request.model)
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
      const thinkingConfig = buildGeminiThinkingConfig(request.model, request.thinking)
      if (thinkingConfig) config.thinkingConfig = thinkingConfig

      const tools = request.tools && request.tools.length > 0
        ? toGeminiTools(request.tools)
        : undefined

      const responseStream = await client.models.generateContentStream({
        model: request.model,
        contents,
        config: {
          ...config,
          abortSignal: abort.signal,
          ...(systemInstruction ? { systemInstruction } : {}),
          ...(tools ? { tools } : {})
        }
      })

      let fullText = ''
      let fullThinking = ''
      const toolCalls: ToolCall[] = []
      const replayParts: GeminiReplayPart[] = []
      let openText: GeminiReplayPart | null = null
      let usageChunk: GenerateContentResponse | null = null
      let finishRaw: string | undefined
      let blockReason: string | undefined

      for await (const chunk of responseStream) {
        if (chunk.usageMetadata) usageChunk = chunk
        const promptBlock = chunk.promptFeedback?.blockReason
        if (promptBlock) blockReason = String(promptBlock)
        const candidate = chunk.candidates?.[0]
        if (candidate?.finishReason) finishRaw = String(candidate.finishReason)

        for (const part of candidate?.content?.parts ?? []) {
          const isThought = (part as Record<string, unknown>).thought === true
          const signature = typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0
            ? part.thoughtSignature
            : undefined
          const fc = part.functionCall as FunctionCall | undefined

          if (fc && fc.name) {
            openText = null
            const callId = fc.id || `${SYNTHETIC_ID_PREFIX}${request.requestId}-${toolCalls.length}`
            const args = isRecord(fc.args) ? fc.args : {}
            toolCalls.push({
              id: callId,
              type: 'function',
              function: { name: fc.name, arguments: JSON.stringify(args) }
            })
            replayParts.push({
              functionCall: { ...(fc.id ? { id: fc.id } : {}), name: fc.name, args },
              callId,
              ...(signature ? { thoughtSignature: signature } : {})
            })
            continue
          }

          if (typeof part.text === 'string') {
            if (part.text.length > 0) {
              if (isThought) {
                fullThinking += part.text
                onDelta?.({ thinkingContent: part.text })
              } else {
                fullText += part.text
                onDelta?.({ content: part.text })
              }
            }
            // Adjacent same-kind text chunks form one part; a signature closes it so signed and
            // unsigned text are never merged (the signature belongs to exactly that text).
            if (!openText || Boolean(openText.thought) !== isThought) {
              openText = { text: '', ...(isThought ? { thought: true } : {}) }
              replayParts.push(openText)
            }
            openText.text = (openText.text ?? '') + part.text
            if (signature) {
              openText.thoughtSignature = signature
              openText = null
            }
            continue
          }

          if (signature) {
            // Signature on a part with no text/call (can arrive alone in the final streamed chunk).
            if (openText) {
              openText.thoughtSignature = signature
              openText = null
            } else {
              replayParts.push({ text: '', thoughtSignature: signature })
            }
          }
        }
      }

      const stopReason = blockReason ?? finishRaw
      if (toolCalls.length === 0 && stopReason && !NORMAL_FINISH.has(stopReason) && fullText.length === 0) {
        throw new GeminiStopError(describeStop(stopReason))
      }
      if (finishRaw && WITHHELD_FINISH.has(finishRaw) && toolCalls.length === 0) {
        throw new GeminiStopError(describeStop(finishRaw))
      }

      const usage = usageChunk ? extractGeminiUsage(usageChunk) : { input: 0, output: 0 }
      // Gemini reports "STOP" even when it returned function calls, so calls take precedence.
      const finishReason: ChatResponse['finishReason'] = toolCalls.length > 0
        ? 'tool_calls'
        : (finishRaw === 'MAX_TOKENS' ? 'length' : 'stop')

      const keptReplay = replayParts.filter((p) =>
        p.functionCall || p.thoughtSignature || (!p.thought && (p.text ?? '').length > 0)
      )
      const needsReplay = keptReplay.some((p) => p.functionCall || p.thoughtSignature)

      return {
        id: request.requestId,
        content: fullText,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        usage,
        thinkingContent: fullThinking.length > 0 ? fullThinking : undefined,
        ...(needsReplay ? { providerReplay: { gemini: { parts: keptReplay } } } : {})
      }
    } catch (error) {
      if (abort.signal.aborted) throw new Error('Request aborted.')
      if (error instanceof GeminiStopError) throw error
      throw new Error(`Gemini harness request failed: ${safeError(error, key)}`)
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
      // Key goes in a header, never in the URL.
      const res = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models',
        { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(5000) }
      )
      return res.ok
    } catch {
      return false
    }
  }
}
