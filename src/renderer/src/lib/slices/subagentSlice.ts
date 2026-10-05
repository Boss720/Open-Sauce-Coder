/**
 * Subagent viewing tabs — watch Task-tool child sessions without leaving the parent chat.
 *
 * A Task tool call spawns a real child session whose SSE traffic arrives on the same stream
 * but is dropped by the main reducer (everything is filtered to the active session). This
 * slice keeps a per-child transcript/busy/error record, filled by its own event path
 * (`applySubagentEvent`, invoked from `applyEvent` right beside the compare routing), plus
 * the open/active tab list the chat column renders.
 *
 * Like compare runs, child-session traffic stays clear of the attempt machine, the routing
 * ledger, and `beginFailover` — those model ONE in-flight exchange for the parent session.
 * Child permission requests are deliberately NOT handled here: they flow through the main
 * reducer's descendant check so the prompt stack surfaces in the parent's chat.
 */

import { eventSessionID } from '../compare'
import { isDescendantOf, sideChatTitle } from '../subagents'
import { isAssistant } from '../types'
import {
  sortMessages,
  upsertMessage,
  removeMessage,
  upsertPart,
  removePart
} from '../collections'
import { api, errText } from './api'
import { harnessPromptFields } from './sessionSlice'
import type { AppState, SetState, GetState } from './types'
import type { Message, MessageWithParts, OcEvent, Part, Session } from '../types'

export type SubagentSlice = Pick<
  AppState,
  | 'subagentTabs'
  | 'activeSubagentTab'
  | 'subagentMessages'
  | 'subagentBusy'
  | 'subagentError'
  | 'openSubagentTab'
  | 'closeSubagentTab'
  | 'setActiveSubagentTab'
  | 'stopSubagent'
  | 'promptSubagent'
  | 'startSideChat'
  | 'clearSubagents'
>

export function createSubagentSlice(set: SetState, get: GetState): SubagentSlice {
  return {
    subagentTabs: [],
    activeSubagentTab: null,
    subagentMessages: {},
    subagentBusy: {},
    subagentError: {},

    async openSubagentTab(sessionID: string): Promise<void> {
      if (!sessionID) return
      set((state) => ({
        subagentTabs: state.subagentTabs.includes(sessionID)
          ? state.subagentTabs
          : [...state.subagentTabs, sessionID],
        activeSubagentTab: sessionID
      }))

      // Backfill history once; live SSE events keep it current from there.
      if (get().subagentMessages[sessionID] !== undefined) return
      const directory = get().directory
      if (!directory) return
      try {
        const loaded = await api().messages(directory, sessionID)
        // The tab may have been closed (or the session switched) while the fetch flew.
        if (!get().subagentTabs.includes(sessionID)) return
        const fetched = sortMessages(loaded ?? [])
        const last = fetched.length > 0 ? fetched[fetched.length - 1] : undefined
        const info = last?.info
        const stillRunning =
          info !== undefined &&
          isAssistant(info) &&
          info.time.completed === undefined &&
          info.error === undefined
        set((state) => {
          // Events that streamed in during the fetch win over the snapshot — every
          // message/part upsert is keyed by id, so merging is exact.
          let merged = fetched
          const live = state.subagentMessages[sessionID] ?? []
          for (const message of live) {
            merged = upsertMessage(merged, message.info)
            for (const part of message.parts) merged = upsertPart(merged, part)
          }
          return {
            subagentMessages: { ...state.subagentMessages, [sessionID]: merged },
            // A live session.status already owns the flag; only derive from the
            // transcript when no event has touched it yet.
            subagentBusy:
              state.subagentBusy[sessionID] === undefined
                ? { ...state.subagentBusy, [sessionID]: stillRunning }
                : state.subagentBusy
          }
        })
      } catch (e) {
        set((state) => ({
          subagentError: { ...state.subagentError, [sessionID]: errText(e) }
        }))
      }
    },

    closeSubagentTab(sessionID: string): void {
      set((state) => {
        if (!state.subagentTabs.includes(sessionID)) return {}
        const messages = { ...state.subagentMessages }
        const busy = { ...state.subagentBusy }
        const errors = { ...state.subagentError }
        delete messages[sessionID]
        delete busy[sessionID]
        delete errors[sessionID]
        return {
          subagentTabs: state.subagentTabs.filter((id) => id !== sessionID),
          subagentMessages: messages,
          subagentBusy: busy,
          subagentError: errors,
          // Closing the viewed tab falls back to the main transcript.
          activeSubagentTab: state.activeSubagentTab === sessionID ? null : state.activeSubagentTab
        }
      })
    },

    setActiveSubagentTab(sessionID: string | null): void {
      // Ignore ids that are not open tabs; null returns to the main transcript.
      if (sessionID !== null && !get().subagentTabs.includes(sessionID)) return
      set({ activeSubagentTab: sessionID })
    },

    async stopSubagent(sessionID: string): Promise<void> {
      const directory = get().directory
      if (!directory || !sessionID) return
      try {
        await api().abort(directory, sessionID)
        // The resulting session.idle / session.error event clears the busy flag.
      } catch (e) {
        set((state) => ({
          subagentError: { ...state.subagentError, [sessionID]: errText(e) }
        }))
      }
    },

    /**
     * Send a follow-up prompt to a child session from its tab. Uses the parent's currently
     * selected provider/model — the same choice `startSideChat` makes — because a child
     * session carries no model selection of its own in this UI. Refuses to double-prompt a
     * busy child; the follow-up can be queued by stopping the subagent first.
     *
     * Like `startSideChat`, this deliberately stays clear of the main session's attempt
     * machine, busy flag, and routing ledger: the child's `session.status` / `session.idle`
     * events own `subagentBusy` from here.
     */
    async promptSubagent(sessionID: string, text: string): Promise<void> {
      const { directory, providerID, modelID } = get()
      const trimmed = text.trim()
      if (!directory || !sessionID || trimmed.length === 0 || !providerID || !modelID) return
      if (!get().subagentTabs.includes(sessionID)) return
      if (get().subagentBusy[sessionID] === true) return

      set((state) => ({
        subagentBusy: { ...state.subagentBusy, [sessionID]: true },
        subagentError: { ...state.subagentError, [sessionID]: null }
      }))
      const childSession = get().sessions?.find((s) => s.id === sessionID)
      const parentID = childSession?.parentID
      if (parentID && get().sessionReadOnly?.[parentID]) {
        get().setSessionReadOnly?.(sessionID, true)
        set((state) => ({ sessionReadOnly: { ...state.sessionReadOnly, [sessionID]: true } }))
      }
      if (parentID && get().sessionAgents?.[parentID]) {
        const agent = get().sessionAgents[parentID]
        get().setSessionAgent?.(sessionID, agent)
        set((state) => ({ sessionAgents: { ...state.sessionAgents, [sessionID]: agent } }))
      }
      const policy = harnessPromptFields(get, sessionID)

      try {
        await api().prompt({
          directory,
          sessionID,
          providerID,
          modelID,
          text: trimmed,
          ...policy
        })
      } catch (e) {
        set((state) => ({
          subagentBusy: { ...state.subagentBusy, [sessionID]: false },
          subagentError: { ...state.subagentError, [sessionID]: errText(e) }
        }))
      }
    },

    /**
     * `/btw <question>` — ask a tangent without derailing the main session.
     *
     * The side chat is a real CHILD session (`parentID = activeSessionID`), which is what
     * makes this cheap: `applySubagentEvent` already intercepts strict-descendant traffic
     * before the main reducer's filters, so the answer streams into `subagentMessages`
     * and the main transcript never sees it. The tab appears through the same path a
     * Task-tool subagent uses — the only difference is the title marker and that we focus
     * it, because the user typed this themselves and wants to watch it.
     *
     * Deliberately does NOT touch `busy`, `activeAttempt`, `lastPrompt`, the stall
     * watchdog, or the routing ledger. Those model the ONE in-flight exchange belonging to
     * the main session; writing them from here would make the main chat think a side chat's
     * reply was its own, and could trigger a failover that reverts the wrong session.
     * Failover and auto-rotation therefore do not apply to side chats — an error is simply
     * recorded against the tab.
     */
    async startSideChat(question: string): Promise<void> {
      const { directory, activeSessionID, providerID, modelID } = get()
      if (!directory || !activeSessionID || !providerID || !modelID) return

      const trimmed = question.trim()
      if (trimmed.length === 0) return

      let child: Session
      try {
        child = await api().sessions.create(directory, sideChatTitle(trimmed), activeSessionID)
      } catch (e) {
        set({ error: errText(e) })
        return
      }

      // Surface the session immediately: `session.created` also arrives over SSE, but the
      // tab should be there the moment the command returns, not a round-trip later.
      set((state) => ({
        sessions: state.sessions.some((s) => s.id === child.id)
          ? state.sessions
          : [child, ...state.sessions],
        subagentBusy: { ...state.subagentBusy, [child.id]: true }
      }))
      await get().openSubagentTab(child.id)

      if (get().sessionReadOnly?.[activeSessionID]) {
        get().setSessionReadOnly?.(child.id, true)
        set((state) => ({ sessionReadOnly: { ...state.sessionReadOnly, [child.id]: true } }))
      }
      if (get().sessionAgents?.[activeSessionID]) {
        const agent = get().sessionAgents[activeSessionID]
        get().setSessionAgent?.(child.id, agent)
        set((state) => ({ sessionAgents: { ...state.sessionAgents, [child.id]: agent } }))
      }
      const policy = harnessPromptFields(get, child.id)

      try {
        await api().prompt({
          directory,
          sessionID: child.id,
          providerID,
          modelID,
          text: trimmed,
          ...policy
        })
      } catch (e) {
        set((state) => ({
          subagentBusy: { ...state.subagentBusy, [child.id]: false },
          subagentError: { ...state.subagentError, [child.id]: errText(e) }
        }))
      }
    },

    clearSubagents(): void {
      set({
        subagentTabs: [],
        activeSubagentTab: null,
        subagentMessages: {},
        subagentBusy: {},
        subagentError: {}
      })
    }
  }
}

/* ------------------------------------------------------------------ *
 * Subagent event routing
 * ------------------------------------------------------------------ */

/**
 * Event types the subagent path consumes. Mirrors the compare set MINUS
 * `permission.updated`: a child's permission request must reach the main reducer, whose
 * descendant check surfaces it in the parent's chat. `session.created` / `.updated` /
 * `.deleted` are also excluded — the main reducer owns `state.sessions` (the parentID
 * authority); the two lifecycle events the tabs care about are observed below, never
 * consumed.
 */
const SUBAGENT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'message.updated',
  'message.part.updated',
  'message.removed',
  'message.part.removed',
  'session.idle',
  'session.status',
  'session.error'
])

/** Drop every record for one child session (shared by close-on-delete). */
function withoutChild(state: AppState, sessionID: string): Partial<AppState> {
  const messages = { ...state.subagentMessages }
  const busy = { ...state.subagentBusy }
  const errors = { ...state.subagentError }
  delete messages[sessionID]
  delete busy[sessionID]
  delete errors[sessionID]
  return {
    subagentTabs: state.subagentTabs.filter((id) => id !== sessionID),
    subagentMessages: messages,
    subagentBusy: busy,
    subagentError: errors,
    activeSubagentTab: state.activeSubagentTab === sessionID ? null : state.activeSubagentTab
  }
}

/** Fold one message/part event into a child's transcript record. */
function withChildMessages(
  state: AppState,
  sessionID: string,
  fold: (messages: MessageWithParts[]) => MessageWithParts[]
): Partial<AppState> {
  const current = state.subagentMessages[sessionID] ?? []
  const next = fold(current)
  if (next === current) return {}
  return { subagentMessages: { ...state.subagentMessages, [sessionID]: next } }
}

/**
 * Apply an SSE event to the subagent-tab records. Returns true when the event was consumed
 * here and must not reach the main reducer.
 *
 * WHY A SEPARATE PATH (same reasoning as `applyCompareEvent`). The main reducer assumes one
 * in-flight exchange bound to the active session: it early-returns on every event whose
 * sessionID differs, and the parts it runs first (attempt machine, stall watchdog, ledger)
 * must never see child traffic either. Child events are therefore routed here, before those
 * filters, into per-child records the tabs read.
 *
 * Consumed events belong to sessions that are STRICT descendants of the active session —
 * active-session and unrelated-session events return false untouched. `session.created`
 * (auto-open a tab, without stealing focus) and `session.deleted` (drop the tab) are
 * observed and then deliberately let through so the sessions list stays consistent.
 */
export function applySubagentEvent(
  e: OcEvent,
  set: SetState,
  get: GetState
): boolean {
  const props = (e.properties ?? {}) as Record<string, unknown>

  if (e.type === 'session.created') {
    const info = props.info as Session | undefined
    const state = get()
    if (
      info &&
      typeof info.id === 'string' &&
      typeof info.parentID === 'string' &&
      info.parentID === state.activeSessionID
    ) {
      // A subagent just started: surface a live tab immediately, keep viewing Main.
      set((s) => ({
        subagentTabs: s.subagentTabs.includes(info.id) ? s.subagentTabs : [...s.subagentTabs, info.id],
        subagentBusy: { ...s.subagentBusy, [info.id]: true }
      }))
    }
    return false
  }

  if (e.type === 'session.deleted') {
    const info = props.info as Session | undefined
    const id = info?.id
    if (typeof id !== 'string') return false
    const state = get()
    if (id === state.activeSessionID) {
      // The parent went away; its tabs are meaningless. The main reducer clears the rest.
      set({
        subagentTabs: [],
        activeSubagentTab: null,
        subagentMessages: {},
        subagentBusy: {},
        subagentError: {}
      })
    } else if (state.subagentTabs.includes(id)) {
      set((s) => withoutChild(s, id))
    }
    return false
  }

  if (!SUBAGENT_EVENT_TYPES.has(e.type)) return false

  const state = get()
  const sessionID = eventSessionID(e.type, e.properties)
  if (sessionID === null || !isDescendantOf(state.sessions, state.activeSessionID, sessionID)) {
    return false
  }

  switch (e.type) {
    case 'message.updated': {
      const info = props.info as Message | undefined
      if (!info || typeof info.id !== 'string') return true
      set((s) => withChildMessages(s, sessionID, (messages) => upsertMessage(messages, info)))
      return true
    }

    case 'message.part.updated': {
      // Every update carries the full part snapshot (the `delta` field is redundant for
      // rendering), so a plain id-keyed upsert keeps the transcript current — exactly the
      // compare path's approach.
      const part = props.part as Part | undefined
      if (!part || typeof part.id !== 'string') return true
      set((s) => withChildMessages(s, sessionID, (messages) => upsertPart(messages, part)))
      return true
    }

    case 'message.removed': {
      const messageID = props.messageID as string | undefined
      if (!messageID) return true
      set((s) => withChildMessages(s, sessionID, (messages) => removeMessage(messages, messageID)))
      return true
    }

    case 'message.part.removed': {
      const messageID = props.messageID as string | undefined
      const partID = props.partID as string | undefined
      if (!messageID || !partID) return true
      set((s) =>
        withChildMessages(s, sessionID, (messages) => removePart(messages, messageID, partID))
      )
      return true
    }

    case 'session.status': {
      const status = props.status as { type?: string } | undefined
      const busy = status?.type === 'busy' || status?.type === 'retry'
      set((s) =>
        s.subagentBusy[sessionID] === busy
          ? {}
          : { subagentBusy: { ...s.subagentBusy, [sessionID]: busy } }
      )
      return true
    }

    case 'session.idle': {
      set((s) => ({ subagentBusy: { ...s.subagentBusy, [sessionID]: false } }))
      return true
    }

    case 'session.error': {
      const error = props.error as { name?: string; data?: { message?: string } } | undefined
      // An aborted child is not an error — mirror the main reducer's MessageAbortedError path.
      if (error?.name === 'MessageAbortedError') {
        set((s) => ({ subagentBusy: { ...s.subagentBusy, [sessionID]: false } }))
        return true
      }
      const detail = error?.data?.message ?? error?.name ?? 'The subagent reported an error.'
      set((s) => ({
        subagentBusy: { ...s.subagentBusy, [sessionID]: false },
        subagentError: { ...s.subagentError, [sessionID]: detail }
      }))
      return true
    }

    default:
      return false
  }
}
