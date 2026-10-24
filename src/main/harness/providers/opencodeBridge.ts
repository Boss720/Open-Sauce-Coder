/**
 * OpenCode Serve Bridge Provider Adapter for the agentic harness.
 *
 * Connects harness agent turns directly to the local supervised `opencode serve`
 * server instance managed in `src/main/server.ts`.
 *
 * Implements the ProviderAdapter interface with token and thinking delta streaming,
 * ephemeral session isolation, request aborting, and cleanup.
 */
import type { Event as OpencodeEvent, OpencodeClient } from '@opencode-ai/sdk'
import type { ServerStatus } from '../../server'
import { getStatus, getClient, onEvent } from '../../server'
import type {
  ProviderAdapter,
  ChatRequest,
  ChatResponse,
  ChatDelta,
  ChatMessage
} from './adapter'

export interface OpencodeBridgeServerSeam {
  getStatus: () => ServerStatus
  getClient: () => OpencodeClient
  onEvent: (cb: (event: OpencodeEvent) => void) => () => void
}

export interface OpencodeBridgeAdapterOptions {
  serverSeam?: OpencodeBridgeServerSeam
  timeoutMs?: number
  /** Interval for the message-polling completion fallback. */
  completionPollMs?: number
}

function safeSerializeSessionError(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message || err.name
  if (typeof err === 'object' && err !== null) {
    const record = err as Record<string, unknown>
    if (typeof record.data === 'object' && record.data !== null) {
      const dataRecord = record.data as Record<string, unknown>
      if (typeof dataRecord.message === 'string' && dataRecord.message) {
        return dataRecord.message
      }
    }
    if (typeof record.message === 'string' && record.message) {
      return record.message
    }
    if (typeof record.error === 'string' && record.error) {
      return record.error
    }
    try {
      const seen = new WeakSet()
      const json = JSON.stringify(err, (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]'
          seen.add(value)
        }
        return value
      })
      if (json && json !== '{}') return json
    } catch {
      /* ignore serialization failure */
    }
    try {
      const str = String(err)
      if (str && str !== '[object Object]') return str
    } catch {
      /* ignore toString failure */
    }
  }
  return typeof err === 'number' || typeof err === 'boolean'
    ? String(err)
    : 'Unknown session error'
}

/** How often the completion fallback polls the session for a finished turn. */
const DEFAULT_COMPLETION_POLL_MS = 1_000

interface ActiveRequestEntry {
  requestId: string
  sessionId: string
  directory: string
  abortController: AbortController
}

const DEFAULT_TIMEOUT_MS = 120_000

export class OpencodeBridgeAdapter implements ProviderAdapter {
  readonly id = 'opencode'
  private readonly serverSeam: OpencodeBridgeServerSeam
  private readonly timeoutMs: number
  private readonly completionPollMs: number
  private readonly activeRequests = new Map<string, ActiveRequestEntry>()

  constructor(options: OpencodeBridgeAdapterOptions = {}) {
    this.serverSeam = options.serverSeam ?? {
      getStatus,
      getClient,
      onEvent
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.completionPollMs = options.completionPollMs ?? DEFAULT_COMPLETION_POLL_MS
  }

  /**
   * Health check — returns true if the OpenCode server is running, false otherwise.
   */
  async probe(): Promise<boolean> {
    try {
      const status = this.serverSeam.getStatus()
      return Boolean(status && status.running)
    } catch {
      return false
    }
  }

  /**
   * Abort in-flight requests by correlation ID, run ID prefix, or session ID.
   */
  abort(requestIdOrRunId: string): void {
    const toAbort: ActiveRequestEntry[] = []

    for (const [key, entry] of this.activeRequests.entries()) {
      if (
        entry.requestId === requestIdOrRunId ||
        entry.requestId.startsWith(`${requestIdOrRunId}-`) ||
        entry.sessionId === requestIdOrRunId
      ) {
        toAbort.push(entry)
        this.activeRequests.delete(key)
      }
    }

    for (const entry of toAbort) {
      entry.abortController.abort()

      try {
        const client = this.serverSeam.getClient()
        void client.session
          .abort({
            path: { id: entry.sessionId },
            query: { directory: entry.directory }
          })
          .catch(() => {
            /* ignore background abort failure */
          })
      } catch {
        /* ignore client resolution failure during abort */
      }
    }
  }

  /**
   * Execute a chat turn through the local OpenCode server.
   */
  async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
    const status = this.serverSeam.getStatus()
    if (!status || !status.running) {
      throw new Error('OpenCode server is not running. Please start the server or wait for initialization.')
    }

    if (request.signal?.aborted) {
      throw new Error(`Request ${request.requestId} was aborted prior to execution.`)
    }

    // This adapter returns text only; every OpenCode tool is disabled and the
    // harness ToolRegistry cannot be reached from here. Silently dropping the
    // request's tools would run the agent without them and still report success.
    if (request.tools && request.tools.length > 0) {
      throw new Error(
        'The opencode provider does not support harness tools. Use a profile with no tools ' +
          `(request carried ${request.tools.length}).`
      )
    }

    const client = this.serverSeam.getClient()
    const directory =
      request.directory ||
      (request.baseUrl && !/^https?:\/\//i.test(request.baseUrl)
        ? request.baseUrl
        : process.cwd())

    // 1. Create ephemeral session for this turn
    const createRes = await client.session.create({
      query: { directory },
      body: { title: `Harness [${request.requestId}]` }
    })
    const sessionId = (createRes as { data?: { id?: string } })?.data?.id ?? (createRes as { id?: string })?.id
    if (!sessionId) {
      throw new Error('Failed to create ephemeral OpenCode session')
    }

    const abortController = new AbortController()
    const instanceKey = `${request.requestId}::${sessionId}`
    this.activeRequests.set(instanceKey, {
      requestId: request.requestId,
      sessionId,
      directory,
      abortController
    })

    let unsubscribe: (() => void) | null = null
    let timer: NodeJS.Timeout | null = null
    let pollTimer: NodeJS.Timeout | null = null
    let onAbort: (() => void) | null = null

    try {
      let accumulatedText = ''
      let accumulatedThinking = ''
      let resolveIdle: () => void = () => {}
      let rejectIdle: (reason?: unknown) => void = () => {}

      const idlePromise = new Promise<void>((resolve, reject) => {
        resolveIdle = resolve
        rejectIdle = reject
      })
      // session.error can arrive while we are still awaiting client.tool.ids or
      // promptAsync, i.e. before Promise.race attaches a handler. Without this
      // the rejection surfaces as an unhandled promise rejection.
      idlePromise.catch(() => {})

      // The session's own user message streams a text part too. Parts carry the
      // id of the message they belong to, so remember the user message ids and
      // drop their parts, otherwise the prompt is echoed back as model output.
      const userMessageIds = new Set<string>()
      // Last full text seen per part, so an update without a `delta` appends only
      // what is new instead of re-appending the whole text on every update.
      const partTextSeen = new Map<string, string>()
      const increment = (
        kind: 'text' | 'reasoning',
        part: { id?: string; text?: string },
        delta: string | undefined
      ): string => {
        const key = `${kind}:${part.id ?? ''}`
        const prev = partTextSeen.get(key) ?? ''
        if (delta) {
          partTextSeen.set(key, typeof part.text === 'string' ? part.text : prev + delta)
          return delta
        }
        const full = part.text ?? ''
        partTextSeen.set(key, full)
        return full.startsWith(prev) ? full.slice(prev.length) : full
      }

      // 2. Subscribe to server events before dispatching prompt
      unsubscribe = this.serverSeam.onEvent((evt: OpencodeEvent) => {
        if (!evt) return

        if (evt.type === 'message.updated') {
          const info = (evt as { properties?: { info?: { id?: string; role?: string; sessionID?: string } } })
            .properties?.info
          if (info?.sessionID === sessionId && info.role === 'user' && info.id) {
            userMessageIds.add(info.id)
          }
        } else if (evt.type === 'message.part.updated') {
          const part = (
            evt as {
              properties?: {
                part?: { id?: string; messageID?: string; sessionID?: string; type?: string; text?: string }
              }
            }
          ).properties?.part
          const delta = (evt as { properties?: { delta?: string } }).properties?.delta

          if (
            part &&
            part.sessionID === sessionId &&
            !(part.messageID && userMessageIds.has(part.messageID))
          ) {
            if (part.type === 'reasoning') {
              const text = increment('reasoning', part, delta)
              if (text) {
                accumulatedThinking += text
                onDelta?.({ thinkingContent: text })
              }
            } else if (part.type === 'text') {
              const text = increment('text', part, delta)
              if (text) {
                accumulatedText += text
                onDelta?.({ content: text })
              }
            }
          }
        } else if (evt.type === 'session.idle') {
          const sid = (evt as { properties?: { sessionID?: string } }).properties?.sessionID
          if (sid === sessionId) {
            resolveIdle()
          }
        } else if (evt.type === 'session.error') {
          const sid = (evt as { properties?: { sessionID?: string } }).properties?.sessionID
          if (sid === sessionId) {
            const err = (evt as { properties?: { error?: unknown } }).properties?.error
            const message = safeSerializeSessionError(err)
            rejectIdle(new Error(`OpenCode session error: ${message}`))
          }
        }
      })

      // 3. Format prompt and options
      const { promptText, systemPrompt } = this.formatPrompt(request.messages)
      const promptParts = [{ type: 'text' as const, text: promptText }]

      let promptModel: { providerID: string; modelID: string } | undefined
      if (request.model && request.model !== 'default') {
        if (request.model.includes('/')) {
          const slashIdx = request.model.indexOf('/')
          promptModel = {
            providerID: request.model.slice(0, slashIdx),
            modelID: request.model.slice(slashIdx + 1)
          }
        } else {
          promptModel = {
            providerID: request.model,
            modelID: request.model
          }
        }
      }

      // 4. Pre-promptAsync abort guard
      if (abortController.signal.aborted || request.signal?.aborted) {
        throw new Error(`Request ${request.requestId} was aborted.`)
      }

      // 5. Wire abort signals
      const abortPromise = new Promise<never>((_, reject) => {
        onAbort = (): void => {
          reject(new Error(`Request ${request.requestId} was aborted.`))
        }

        abortController.signal.addEventListener('abort', onAbort, { once: true })
        request.signal?.addEventListener('abort', onAbort, { once: true })
      })
      // Prevent unhandled rejection warning if abort fires during or after resolution
      abortPromise.catch(() => {})

      // 6. Wire execution timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`OpenCode request ${request.requestId} timed out after ${this.timeoutMs}ms.`))
        }, this.timeoutMs)
      })
      timeoutPromise.catch(() => {})

      // This adapter only returns text to the harness; it cannot route OpenCode
      // tool calls through the harness ToolRegistry or policy broker. Disable
      // every tool known to the server before dispatching the prompt.
      const toolIdsResult = await client.tool.ids({ query: { directory } })
      const toolIds = (toolIdsResult as { data?: unknown })?.data ?? toolIdsResult
      if (!Array.isArray(toolIds) || toolIds.length === 0 || !toolIds.every((id) => typeof id === 'string')) {
        throw new Error('Could not determine OpenCode tools to disable; refusing to run the harness request.')
      }
      const disabledTools = Object.fromEntries(toolIds.map((id: string) => [id, false]))

      if (abortController.signal.aborted || request.signal?.aborted) {
        throw new Error(`Request ${request.requestId} was aborted.`)
      }

      // 7. Dispatch prompt asynchronously
      await client.session.promptAsync({
        path: { id: sessionId },
        query: { directory },
        body: {
          parts: promptParts,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          ...(promptModel ? { model: promptModel } : {}),
          tools: disabledTools
        }
      })

      // 8. Await turn completion.
      //
      // session.idle is the fast path, but it cannot be the only one: the SSE
      // stream in server.ts is scoped to a single directory via
      // setEventDirectory(), so a run whose `directory` differs from the
      // stream's — or one that spans a stream restart caused by a project
      // switch — would never see the event and would burn the full timeout
      // before throwing, even though the model had already finished. Poll the
      // session's messages as an independent completion signal and take
      // whichever arrives first.
      const completionPromise = new Promise<void>((resolve, reject) => {
        const check = async (): Promise<void> => {
          try {
            const res = await client.session.messages({
              path: { id: sessionId },
              query: { directory }
            })
            const msgs = (res as { data?: unknown })?.data ?? res
            if (!Array.isArray(msgs)) return
            const assistantMsgs = msgs.filter((m) => m?.info?.role === 'assistant')
            const last = assistantMsgs[assistantMsgs.length - 1]
            if (!last?.info) return
            const info = last.info as {
              error?: unknown
              finish?: unknown
              time?: { completed?: unknown }
            }
            if (info.error) {
              reject(new Error(`OpenCode session error: ${safeSerializeSessionError(info.error)}`))
              return
            }
            if (info.time?.completed || info.finish) {
              resolve()
            }
          } catch {
            // Transient lookup failure: keep polling until the turn completes
            // or the request timeout fires.
          }
        }
        pollTimer = setInterval(() => {
          void check()
        }, this.completionPollMs)
      })
      completionPromise.catch(() => {})

      await Promise.race([idlePromise, completionPromise, abortPromise, timeoutPromise])

      // 9. Collect final message content and token usage
      let content = accumulatedText
      let thinkingContent: string | undefined = accumulatedThinking || undefined
      let usage = { input: 0, output: 0, reasoning: 0 }
      let finishReason: ChatResponse['finishReason'] = 'stop'

      try {
        const messagesResult = await client.session.messages({
          path: { id: sessionId },
          query: { directory }
        })
        const msgs = (messagesResult as { data?: unknown })?.data ?? messagesResult

        if (Array.isArray(msgs) && msgs.length > 0) {
          const assistantMsgs = msgs.filter((m) => m?.info?.role === 'assistant')
          const lastAssistant = assistantMsgs[assistantMsgs.length - 1]

          if (lastAssistant) {
            if (lastAssistant.info?.tokens) {
              usage = {
                input: Number(lastAssistant.info.tokens.input ?? 0),
                output: Number(lastAssistant.info.tokens.output ?? 0),
                reasoning: Number(lastAssistant.info.tokens.reasoning ?? 0)
              }
            }

            if (lastAssistant.info?.finish) {
              const f = lastAssistant.info.finish
              if (f === 'stop' || f === 'tool_calls' || f === 'length' || f === 'error') {
                finishReason = f
              }
            }

            if (Array.isArray(lastAssistant.parts)) {
              let msgText = ''
              let msgThinking = ''
              for (const p of lastAssistant.parts) {
                if (p.type === 'text' && typeof p.text === 'string') {
                  msgText += p.text
                } else if (p.type === 'reasoning' && typeof p.text === 'string') {
                  msgThinking += p.text
                }
              }
              if (msgText) content = msgText
              if (msgThinking) thinkingContent = msgThinking
            }
          }
        }
      } catch {
        /* fallback to accumulated parts if messages lookup fails */
      }

      if (!content && !thinkingContent && finishReason !== 'tool_calls') {
        throw new Error('OpenCode server session ended without producing an assistant response.')
      }

      if (usage.input === 0 && usage.output === 0) {
        usage = {
          input: Math.ceil((promptText.length || 1) / 4),
          output: Math.ceil(content.length / 4),
          reasoning: thinkingContent ? Math.ceil(thinkingContent.length / 4) : 0
        }
      }

      return {
        id: sessionId,
        content,
        thinkingContent: thinkingContent || undefined,
        finishReason,
        usage
      }
    } finally {
      if (timer) clearTimeout(timer)
      if (pollTimer) clearInterval(pollTimer)
      if (unsubscribe) unsubscribe()
      if (onAbort) {
        abortController.signal.removeEventListener('abort', onAbort)
        request.signal?.removeEventListener('abort', onAbort)
      }
      this.activeRequests.delete(instanceKey)

      try {
        await client.session.delete({
          path: { id: sessionId },
          query: { directory }
        })
      } catch {
        /* ignore ephemeral session deletion error */
      }
    }
  }

  private formatPrompt(messages: ChatMessage[]): { promptText: string; systemPrompt?: string } {
    const systemMessage = messages.find((m) => m.role === 'system')
    const systemPrompt =
      typeof systemMessage?.content === 'string'
        ? systemMessage.content
        : Array.isArray(systemMessage?.content)
          ? systemMessage.content.map((p) => ('text' in p ? p.text : '')).join('\n')
          : undefined

    const nonSystem = messages.filter((m) => m.role !== 'system')
    let promptText = ''

    if (nonSystem.length === 1 && nonSystem[0].role === 'user') {
      const content = nonSystem[0].content
      promptText =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((p) => ('text' in p ? p.text : '')).join('\n')
            : ''
    } else if (nonSystem.length > 0) {
      promptText = nonSystem
        .map((m) => {
          const content =
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content.map((p) => ('text' in p ? p.text : '')).join('\n')
                : ''
          return `${m.role.toUpperCase()}:\n${content}`
        })
        .join('\n\n')
    }

    if (!promptText.trim()) {
      promptText = 'Hello'
    }

    return { promptText, systemPrompt }
  }
}
