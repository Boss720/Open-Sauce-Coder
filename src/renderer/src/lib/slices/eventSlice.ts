/**
 * `applyEvent` — the single SSE reducer.
 *
 * WHY THIS IS NOT SHARDED INTO THE SLICES. One event routinely cuts across several of them:
 * a `session.error` touches sessions (busy), routing (ledger + failover), messages (the
 * side-effect notice) and permissions; `session.idle` records a ledger success AND drains the
 * prompt queue. Splitting it into per-slice handlers would give each handler a partial view of
 * the event and let them race against a ledger snapshot taken before a sibling handler ran.
 * So the reducer stays whole and lives in its own module that COMPOSES over the slices: it only
 * ever touches state through the shared `set`/`get` and the attempt-machine accessors.
 *
 * The one deliberate exception is compare traffic, which is consumed by `applyCompareEvent`
 * before the switch is reached — see the note there. Subagent (Task-tool child session)
 * traffic gets the same treatment from `applySubagentEvent`, invoked right beside it.
 */

import { classifyError, isTokenThroughputLimit } from '../rotation'
import { saveLedger, record429, recordSuccess, recordFailure, recordTokens, recordInputTokens, nextAvailableAt } from '../routing'
import { lastAssistantTokenTotal, lastAssistantInputTokenCount } from '../aggregate'
import type { Ledger } from '../routing'
import { FREE_PROVIDER_CAPS } from '../freeTier'
import type { ErrorClass } from '../attempts'

/**
 * Replace a raw provider rate-limit message with the one fact the user can act on:
 * when a model frees up again. Only for rate-limit classes — every other error's own
 * message is more informative than a wait time would be.
 *
 * The pool is the ledger's own keys, i.e. models this install has actually used. A
 * model never tried has no send history, so it could not have been the thing keeping
 * failover from finding a route.
 */
function rateLimitedMessage(
  errClass: ErrorClass,
  fallback: string,
  now: number,
  ledger: Ledger
): string {
  if (errClass !== 'rpm-wait' && errClass !== 'rpd-drop' && errClass !== 'tpm-drop') return fallback
  const next = nextAvailableAt(Object.keys(ledger), ledger, FREE_PROVIDER_CAPS, now)
  if (next === null || next.at <= now) return fallback
  const minutes = Math.ceil((next.at - now) / 60_000)
  const when = minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)}h`
  return `Every free model is rate-limited right now. Next available in ~${when} (${next.key}).`
}
import {
  sortMessages,
  upsertMessage,
  removeMessage,
  upsertPart,
  removePart,
  samePath,
  upsertSession,
  makeNotice
} from '../collections'
import { api } from './api'
import { applyCompareEvent } from './compareSlice'
import { applySubagentEvent } from './subagentSlice'
import { isSelfOrDescendant } from '../subagents'
import {
  armStallWatchdog,
  beginFailover,
  clearActiveAttempt,
  getAbortForRecoverySessionID,
  getActiveAttempt,
  getLastPrompt,
  getLedger,
  markPermissionAsked,
  markPermissionReplied,
  markToolCompleted,
  markToolStarted,
  parseRetryAfterMs,
  resetRotateRetries,
  setAbortForRecoverySessionID,
  setLastPrompt,
  setLastSendStartTime,
  setLedger,
  touchActiveAttempt
} from './attemptMachine'
import type { AppState, SetState, GetState } from './types'
import type { Message, OcEvent, Part, Permission, Session } from '../types'

export type EventSlice = Pick<AppState, 'applyEvent'>

/** True when the event's session is the active one, or a subagent of it. */
function isActiveOrDescendant(
  state: Pick<AppState, 'activeSessionID' | 'sessions'>,
  sessionID: string | undefined | null
): boolean {
  return isSelfOrDescendant(state.sessions, state.activeSessionID, sessionID)
}

export function createEventSlice(set: SetState, get: GetState): EventSlice {
  return {
    applyEvent(e: OcEvent): void {
      if (!e || typeof e.type !== 'string') return
      const state = get()
      const props = (e.properties ?? {}) as Record<string, unknown>

      // Compare-run traffic is handled entirely separately and returns before the switch below, so it
      // can never reach the single-slot attempt machine, the routing ledger, or beginFailover.
      if (applyCompareEvent(e, set, get)) return

      // Subagent (Task-tool child session) traffic gets the same isolation: per-child
      // transcripts/busy/error live in the subagent slice. session.created/.deleted are only
      // OBSERVED there and still fall through to the switch — the sessions list stays the
      // parentID authority.
      if (applySubagentEvent(e, set, get)) return

      switch (e.type) {
        case 'message.updated': {
          const info = props.info as Message | undefined
          if (!info || typeof info.id !== 'string') return
          if (info.sessionID !== state.activeSessionID) return
          set({ messages: upsertMessage(state.messages, info) })
          return
        }

        case 'message.part.updated': {
          const part = props.part as Part | undefined
          if (!part || typeof part.id !== 'string') return
          if (part.sessionID !== state.activeSessionID) return

          // Capture the opening user message ID for transactional revert
          const anyPart = part as any
          const lastPrompt = getLastPrompt()
          if (anyPart.messageID && lastPrompt?.sessionID === part.sessionID && !lastPrompt.userMessageID) {
            // Only capture the FIRST message id (the user turn opener)
            const msg = state.messages.find((m) => m.info.id === anyPart.messageID)
            if (msg?.info.role === 'user') {
              setLastPrompt({ ...lastPrompt, userMessageID: anyPart.messageID })
              const activeAttempt = getActiveAttempt()
              if (activeAttempt && activeAttempt.userMessageID === null) {
                activeAttempt.userMessageID = anyPart.messageID
              }
            }
          }

          // Tool part lifecycle → pause/resume stall watchdog
          if (part.type === 'tool') {
            const toolState = (part as any).state?.status
            if (toolState === 'pending' || toolState === 'running') {
              markToolStarted(part.sessionID)
            } else if (toolState === 'completed' || toolState === 'error') {
              markToolCompleted(part.sessionID)
            }
          } else if (part.type === 'text' || part.type === 'reasoning') {
            // Real streaming token → clear TTFT, arm stall
            touchActiveAttempt(part.sessionID)
          }

          const messages = upsertPart(state.messages, part)
          if (messages !== state.messages) set({ messages })
          return
        }

        case 'message.removed': {
          const sessionID = props.sessionID as string | undefined
          const messageID = props.messageID as string | undefined
          if (!messageID || sessionID !== state.activeSessionID) return
          const messages = removeMessage(state.messages, messageID)
          if (messages !== state.messages) set({ messages })
          return
        }

        case 'message.part.removed': {
          const sessionID = props.sessionID as string | undefined
          const messageID = props.messageID as string | undefined
          const partID = props.partID as string | undefined
          if (!messageID || !partID || sessionID !== state.activeSessionID) return
          const messages = removePart(state.messages, messageID, partID)
          if (messages !== state.messages) set({ messages })
          return
        }

        case 'permission.updated': {
          const permission = e.properties as Permission | undefined
          if (!permission || typeof permission.id !== 'string') return
          if (!isActiveOrDescendant(state, permission.sessionID)) return
          if (state.permissions.some((p) => p.id === permission.id)) return
          markPermissionAsked(permission.sessionID)
          set({ permissions: [...state.permissions, permission] })
          return
        }

        case 'permission.replied': {
          const permissionID = props.permissionID as string | undefined
          if (!permissionID) return
          if (!state.permissions.some((p) => p.id === permissionID)) return
          // Locate its sessionID before removing
          const p = state.permissions.find((x) => x.id === permissionID)
          if (p) markPermissionReplied(p.sessionID)
          set({ permissions: state.permissions.filter((x) => x.id !== permissionID) })
          return
        }

        case 'session.status': {
          const sessionID = props.sessionID as string | undefined
          const status = props.status as { type?: string } | undefined
          if (!sessionID || sessionID !== state.activeSessionID) return
          // Pause stall watchdog during server-side retry so it doesn't fire
          const activeAttempt = getActiveAttempt()
          if (status?.type === 'retry' && activeAttempt?.sessionID === sessionID) {
            if (activeAttempt.stallTimer) clearTimeout(activeAttempt.stallTimer)
            activeAttempt.stallTimer = null
          } else if (status?.type === 'busy' && activeAttempt?.sessionID === sessionID) {
            armStallWatchdog()
          }
          const busy = status?.type === 'busy' || status?.type === 'retry'
          if (busy !== state.busy) set({ busy })
          return
        }

        case 'session.idle': {
          const sessionID = props.sessionID as string | undefined
          if (sessionID !== state.activeSessionID) return
          if (state.busy) set({ busy: false })

          const now = Date.now()
          const attempt = getActiveAttempt()
          const cleanCompletion = attempt?.sessionID === sessionID && !attempt.failoverInFlight
          if (attempt?.sessionID === sessionID) {
            const latencyMs = Math.max(50, now - attempt.startedAt)
            clearActiveAttempt(sessionID)
            setLastSendStartTime(null)
            const modelKey = `${attempt.providerID}/${attempt.modelID}`
            setLedger(recordSuccess(getLedger(), modelKey, latencyMs, now))
            // TPM is the cap that actually binds on Google Flash (250K/min against a
            // 20/day request allowance), so the token cost of the run has to land in
            // the ledger or the router throttles on the wrong dimension entirely.
            const spent = lastAssistantTokenTotal(get().messages)
            if (spent > 0) setLedger(recordTokens(getLedger(), modelKey, spent, now))
            const inputSpent = lastAssistantInputTokenCount(get().messages)
            if (inputSpent > 0) setLedger(recordInputTokens(getLedger(), modelKey, inputSpent, now))
            saveLedger(getLedger())
          }
          // R2: reset per-exchange retry counter ONLY on clean completion
          if (cleanCompletion) resetRotateRetries()
          if (getLastPrompt()?.sessionID === sessionID) setLastPrompt(null)

          const queue = get().queuedPrompts
          if (queue.length > 0) {
            const next = queue[0]
            set({ queuedPrompts: queue.slice(1) })
            void get().send(next.text, next.parts)
          }
          return
        }

        case 'session.error': {
          const sessionID = props.sessionID as string | undefined
          // Never associate an unscoped server error with the current request:
          // doing so could replay a stale prompt into an unrelated session.
          if (!sessionID || sessionID !== state.activeSessionID) return
          // Widened cast — the SDK's ApiError already exposes responseHeaders/
          // statusCode/isRetryable; the previous cast discarded them.
          const error = props.error as
            | {
                name?: string
                data?: {
                  message?: string
                  statusCode?: number
                  isRetryable?: boolean
                  responseHeaders?: Record<string, string>
                  responseBody?: string
                }
              }
            | undefined

          if (error?.name === 'MessageAbortedError') {
            if (getAbortForRecoverySessionID() === sessionID) {
              setAbortForRecoverySessionID(null)
              return
            }
            clearActiveAttempt(sessionID)
            set({ busy: false })
            setLastSendStartTime(null)
            return
          }
          const message =
            error?.data?.message ?? error?.name ?? 'The session reported an error.'

          const now = Date.now()
          const retryAfterMs = parseRetryAfterMs(error?.data?.responseHeaders ?? null)
          const errClass = classifyError(message, {
            statusCode: error?.data?.statusCode,
            isRetryable: error?.data?.isRetryable,
            retryAfterMs,
          })

          const live = getActiveAttempt()
          const attempt = live?.sessionID === sessionID ? live : null
          const failedProviderID = isTokenThroughputLimit(message) ? attempt?.providerID : undefined
          const attemptSafe = !attempt?.toolExecuted && !attempt?.hasStreamed
          clearActiveAttempt(sessionID)
          setLastSendStartTime(null)

          if (attempt) {
            if (errClass === 'rpm-wait' || errClass === 'rpd-drop') {
              setLedger(record429(getLedger(), `${attempt.providerID}/${attempt.modelID}`, now, retryAfterMs, {
                daily: errClass === 'rpd-drop',
                caps: FREE_PROVIDER_CAPS
              }))
            } else {
              setLedger(recordFailure(getLedger(), `${attempt.providerID}/${attempt.modelID}`, now))
            }
            saveLedger(getLedger())
          }

          const lastPrompt = getLastPrompt()
          const capturedPrompt = lastPrompt?.sessionID === sessionID ? lastPrompt : null
          const canFailover =
            state.routingMode !== 'locked' &&
            (errClass === 'rpm-wait' || errClass === 'rpd-drop' || errClass === 'tpm-drop' || errClass === 'timeout' || errClass === 'transient')

          if (canFailover && attemptSafe && capturedPrompt && state.directory) {
            void (async () => {
              const failedOver = await beginFailover(
                sessionID,
                state.directory!,
                capturedPrompt.text,
                capturedPrompt.parts,
                `${errClass}: ${message.slice(0, 80)}`,
                attempt ? `${attempt.providerID}/${attempt.modelID}` : undefined,
                failedProviderID,
              )
              if (!failedOver) {
                // Failover found nothing. For a rate-limit class that means every
                // candidate is capped or cooling, and the raw provider message says
                // nothing about when to try again — so say when instead.
                set({ busy: false, error: rateLimitedMessage(errClass, message, Date.now(), getLedger()) })
              }
            })()
            return
          }

          if (!attemptSafe) {
            state.addSystemNotice(
              `⚠️ **Auto-retry blocked: side effects already committed** (tools ran or tokens streamed). Send again to try a different model.`
            )
          }

          set({ busy: false, error: message })
          return
        }

        case 'session.created':
        case 'session.updated': {
          const info = props.info as Session | undefined
          if (!info || typeof info.id !== 'string') return
          const known = state.sessions.some((s) => s.id === info.id)
          if (!known && !samePath(info.directory, state.directory)) return

          if (info.parentID && state.sessionReadOnly?.[info.parentID]) {
            set((s) => ({
              sessionReadOnly: { ...s.sessionReadOnly, [info.id]: true },
              sessions: upsertSession(s.sessions, info)
            }))
            return
          }

          set({ sessions: upsertSession(state.sessions, info) })
          return
        }

        case 'session.deleted': {
          const info = props.info as Session | undefined
          const id = info?.id
          if (!id) return
          if (!state.sessions.some((s) => s.id === id) && state.activeSessionID !== id) {
            return
          }
          const wasActive = state.activeSessionID === id
          set({
            sessions: state.sessions.filter((s) => s.id !== id),
            activeSessionID: wasActive ? null : state.activeSessionID,
            messages: wasActive ? [] : state.messages,
            permissions: wasActive
              ? []
              : state.permissions.filter((p) => p.sessionID !== id),
            busy: wasActive ? false : state.busy
          })
          return
        }

        case 'todo.updated': {
          const sessionID = props.sessionID as string | undefined
          if (sessionID !== state.activeSessionID) return
          const directory = state.directory
          if (!directory || !sessionID) return
          void (async () => {
            try {
              const todos = await api().sessions.todos(directory, sessionID)
              if (get().activeSessionID === sessionID) set({ todos: todos ?? [] })
            } catch { /* ignore */ }
          })()
          return
        }

        case 'vcs.branch.updated': {
          const branch = props.branch as string | undefined
          if (branch !== undefined) set({ branch: branch || null })
          return
        }

        case 'session.compacted': {
          const sessionID = props.sessionID as string | undefined
          if (sessionID !== state.activeSessionID) return
          const directory = state.directory
          if (!directory || !sessionID) return
          void (async () => {
            try {
              const loaded = await api().messages(directory, sessionID)
              if (get().activeSessionID !== sessionID) return
              const messages = sortMessages(loaded ?? [])
              set({ messages: sortMessages([...messages, makeNotice(sessionID, 'Context compacted.')]) })
            } catch { /* ignore */ }
          })()
          return
        }

        case 'file.edited': {
          // The agent edited a file on disk. The git panel must reflect this without
          // polling; refreshGit() is debounced (~300ms) internally so a burst of edits
          // collapses into a single status/branches round-trip.
          void get().refreshGit()
          // Same reasoning for the tree: an agent that creates or deletes a file must
          // not require a manual reload to show it. Also debounced (~300ms).
          void get().refreshTree()
          return
        }

        default:
          // server.connected, todo.updated, tui.* … nothing to reduce.
          return
      }
    }
  }
}
