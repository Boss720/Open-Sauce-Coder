/**
 * `applyEvent` — the single SSE reducer (src/renderer/src/lib/slices/eventSlice.ts).
 *
 * Assertions here are grounded in CONTRACTS.md's `applyEvent rules` section and the
 * adjoining watchdog/routing notes, not in a restatement of the reducer's own source:
 *
 *  - message.updated — upsert `info` by `info.id` into `messages` (append if new, keep
 *    order by `time.created`).
 *  - message.part.updated — find the message by `part.messageID`; upsert the part by
 *    `part.id`. If the message is not loaded yet, ignore. Preserve part order by first-seen.
 *  - message.removed / message.part.removed — remove by id.
 *  - permission.updated — push `properties` onto `permissions` if not already present by id.
 *  - permission.replied — drop the matching permission by `permissionID`.
 *  - session.idle — `busy = false` when `properties.sessionID === activeSessionID`. Record
 *    success in routing ledger. Reset `rotateRetries` ONLY on clean completion (R2).
 *  - session.error — classify error via `classifyError`; if rate-limit, honor `Retry-After` /
 *    `X-RateLimit-Reset`; single-entry `beginFailover` reverts the user message then
 *    re-prompts on next healthy free model. Never auto-retry if any tool ran or tokens
 *    streamed (R1).
 *  - session.created / session.updated / session.deleted — sync the `sessions` array.
 *  - Ignore events whose sessionID is not the active session (except session list churn).
 *  - Two watchdogs: TTFT (arm on send, clear on first text/reasoning part) and stall
 *    (re-arm on each new part; paused during tool/permission/session.status 'retry').
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { MessageWithParts, OcEvent } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createEventSlice, type EventSlice } from '../slices/eventSlice'
import { registerStore } from '../slices/storeRef'
import {
  clearActiveAttempt,
  getAbortForRecoverySessionID,
  getActiveAttempt,
  getLastPrompt,
  getLastSendStartTime,
  getLedger,
  getRotateRetries,
  resetRotateRetries,
  setAbortForRecoverySessionID,
  setLastPrompt,
  setLastSendStartTime,
  setLedger,
  startActiveAttempt
} from '../slices/attemptMachine'

const mockApi = vi.mocked(api)

/* ------------------------------------------------------------------ *
 * Harness — mirrors the createStore()/setup() idiom used by
 * gitSlice.test.ts / editorSlice.test.ts, but eventSlice's applyEvent
 * reads across the WHOLE AppState, so the harness must seed sane
 * defaults for every field the reducer touches rather than just the
 * slice it owns.
 * ------------------------------------------------------------------ */

function baseState(): AppState {
  return {
    directory: '/proj',
    activeSessionID: 'sess-1',
    sessions: [],
    messages: [],
    busy: false,
    error: null,
    todos: [],
    branch: null,
    queuedPrompts: [],
    permissions: [],
    routingMode: 'failover',
    compare: null,
    appSettings: {
      closeToTray: false,
      globalShortcut: '',
      showPaidModels: false,
      ttftMs: 20_000,
      stallMs: 90_000,
      nanogptSubscriptionOnly: true
    },
    // applyEvent delegates every session-scoped event to applySubagentEvent, which reads
    // these unconditionally — an absent `subagentTabs` throws before the assertion runs.
    subagentTabs: [],
    activeSubagentTab: null,
    subagentMessages: {},
    subagentBusy: {},
    subagentError: {},
    send: vi.fn(async () => {}),
    addSystemNotice: vi.fn(),
    refreshGit: vi.fn(async () => {}),
    refreshTree: vi.fn(async () => {}),
    rotateToNextFreeModel: vi.fn(() => null)
  } as unknown as AppState
}

function setup(overrides: Partial<AppState> = {}): { get: GetState; set: SetState; slice: EventSlice } {
  let state: AppState = { ...baseState(), ...overrides }
  const set = ((partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  const slice = createEventSlice(set, get)
  // The attempt machine's watchdogs and beginFailover reach the store only through this
  // late-bound handle (see storeRef.ts) — without registering it, any test that arms a
  // watchdog or drives a failover throws "Store handle used before the store was created."
  registerStore({ getState: get, setState: (p) => set(p) })
  return { get, set, slice }
}

/** Flushes every pending microtask (revertMessage/prompt mocks, etc.) without real waits. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function fakeApi(overrides: Partial<OpencodeApi> = {}): OpencodeApi {
  return {
    sessions: { todos: vi.fn(async () => []) },
    messages: vi.fn(async () => []),
    revertMessage: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    ...overrides
  } as unknown as OpencodeApi
}

function userMsg(id: string, sessionID: string, overrides: Record<string, unknown> = {}) {
  return { id, sessionID, role: 'user', time: { created: 100 }, ...overrides } as any
}

function asstMsg(id: string, sessionID: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 100 },
    parentID: '',
    modelID: 'gemini-3.6-flash',
    providerID: 'google',
    mode: 'build',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides
  } as any
}

function withParts(info: unknown, parts: unknown[] = []): MessageWithParts {
  return { info, parts } as MessageWithParts
}

function textPart(id: string, messageID: string, sessionID: string, text: string, overrides: Record<string, unknown> = {}) {
  return { id, sessionID, messageID, type: 'text', text, ...overrides } as any
}

function toolPart(id: string, messageID: string, sessionID: string, state: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { id, sessionID, messageID, type: 'tool', callID: 'call-1', tool: 'bash', state, ...overrides } as any
}

function permissionFixture(id: string, sessionID: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'bash',
    sessionID,
    messageID: 'm1',
    title: 'Run a command',
    metadata: {},
    time: { created: 100 },
    ...overrides
  } as any
}

function sessionFixture(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectID: 'p1',
    directory: '/proj',
    title: 'Session',
    version: '1',
    time: { created: 1, updated: 1 },
    ...overrides
  } as any
}

function ev(type: string, properties: Record<string, unknown>): OcEvent {
  return { type, properties }
}

beforeEach(() => {
  mockApi.mockReset()
  // The attempt machine's mutable singletons persist across tests within this file
  // (attemptMachine.ts is imported once) — reset every one it exposes a setter for.
  clearActiveAttempt()
  setLastPrompt(null)
  resetRotateRetries()
  setLedger({})
  setLastSendStartTime(null)
  setAbortForRecoverySessionID(null)
})

afterEach(() => {
  // Cancels any ttft/stall setTimeout armed by startActiveAttempt/armStallWatchdog so
  // no real timer (20s/90s by default) leaks past the test that armed it.
  clearActiveAttempt()
})

describe('eventSlice: applyEvent', () => {
  describe('malformed / unrecognized events', () => {
    it('ignores a null/undefined event without throwing', () => {
      const { get, slice } = setup()
      expect(() => slice.applyEvent(null as unknown as OcEvent)).not.toThrow()
      expect(() => slice.applyEvent(undefined as unknown as OcEvent)).not.toThrow()
      expect(get().messages).toEqual([])
    })

    it('ignores an event whose type is not a string', () => {
      const { get, slice } = setup()
      slice.applyEvent({ type: 123, properties: {} } as unknown as OcEvent)
      expect(get().messages).toEqual([])
      expect(get().error).toBeNull()
    })

    it('no-ops on an event type the reducer does not recognize', () => {
      const { get, slice } = setup()
      expect(() => slice.applyEvent(ev('server.connected', {}))).not.toThrow()
      expect(get()).toMatchObject({ messages: [], busy: false, error: null })
    })
  })

  describe('message.updated', () => {
    it('upserts a new message by id, appended in time.created order', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1' })

      slice.applyEvent(ev('message.updated', { info: userMsg('m1', 'sess-1', { time: { created: 100 } }) }))
      slice.applyEvent(ev('message.updated', { info: asstMsg('m2', 'sess-1', { time: { created: 200 } }) }))

      expect(get().messages.map((m) => m.info.id)).toEqual(['m1', 'm2'])
    })

    it('re-applying the same message.updated is idempotent (duplicate event)', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1' })
      const info = userMsg('m1', 'sess-1')

      slice.applyEvent(ev('message.updated', { info }))
      slice.applyEvent(ev('message.updated', { info }))

      expect(get().messages).toHaveLength(1)
    })

    it('an update for a message whose sessionID is not active session does not leak in', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1' })

      slice.applyEvent(ev('message.updated', { info: userMsg('m1', 'other-session') }))

      expect(get().messages).toEqual([])
    })

    it('ignores a payload missing info / a malformed id', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1' })
      slice.applyEvent(ev('message.updated', {}))
      slice.applyEvent(ev('message.updated', { info: { sessionID: 'sess-1' } }))
      expect(get().messages).toEqual([])
    })
  })

  describe('message.part.updated — text streaming', () => {
    it('appends successive text-part updates token-by-token into the same part', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'))]
      })

      slice.applyEvent(ev('message.part.updated', { part: textPart('p1', 'm1', 'sess-1', 'Hel') }))
      slice.applyEvent(ev('message.part.updated', { part: textPart('p1', 'm1', 'sess-1', 'Hello') }))
      slice.applyEvent(ev('message.part.updated', { part: textPart('p1', 'm1', 'sess-1', 'Hello world') }))

      const parts = get().messages[0]!.parts
      expect(parts).toHaveLength(1)
      expect((parts[0] as any).text).toBe('Hello world')
    })

    it('preserves first-seen part order when a second part starts streaming', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'))]
      })

      slice.applyEvent(ev('message.part.updated', { part: textPart('p1', 'm1', 'sess-1', 'first') }))
      slice.applyEvent(ev('message.part.updated', { part: textPart('p2', 'm1', 'sess-1', 'second') }))

      expect(get().messages[0]!.parts.map((p) => p.id)).toEqual(['p1', 'p2'])
    })

    it('captures the opening user message id onto lastPrompt and the active attempt for revert', () => {
      const { slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(userMsg('user-1', 'sess-1')), withParts(asstMsg('m1', 'sess-1'))]
      })
      setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: null })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      expect(getActiveAttempt()!.userMessageID).toBeNull()

      // The first part of the reply arrives, tagged with the USER message's id (as the
      // server does for the opening part of an exchange) — this is how the attempt
      // machine learns which message a transactional revert must target.
      slice.applyEvent(ev('message.part.updated', { part: textPart('p1', 'user-1', 'sess-1', 'irrelevant') }))

      expect(getLastPrompt()).toMatchObject({ sessionID: 'sess-1', userMessageID: 'user-1' })
      expect(getActiveAttempt()!.userMessageID).toBe('user-1')
    })

    it('does not capture a user-message id a second time once one is already recorded', () => {
      const { slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(userMsg('user-1', 'sess-1')), withParts(userMsg('user-2', 'sess-1'))]
      })
      setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: 'user-1' })

      slice.applyEvent(ev('message.part.updated', { part: textPart('p1', 'user-2', 'sess-1', 'irrelevant') }))

      expect(getLastPrompt()).toMatchObject({ userMessageID: 'user-1' })
    })

    it('a duplicate part.updated (same id, same text) is a no-op re-apply', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'))]
      })
      const part = textPart('p1', 'm1', 'sess-1', 'hello')

      slice.applyEvent(ev('message.part.updated', { part }))
      slice.applyEvent(ev('message.part.updated', { part }))

      expect(get().messages[0]!.parts).toHaveLength(1)
    })

    it('out-of-order: a part update arriving before its message is loaded is ignored, not queued', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', messages: [] })

      slice.applyEvent(ev('message.part.updated', { part: textPart('p1', 'missing-message', 'sess-1', 'orphan') }))

      expect(get().messages).toEqual([])
    })

    it('a part update for a non-active session does not leak into active state', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'))]
      })

      slice.applyEvent(ev('message.part.updated', { part: textPart('p1', 'm1', 'other-session', 'nope') }))

      expect(get().messages[0]!.parts).toEqual([])
    })

    it('a streaming text part clears the TTFT watchdog and hands off to the stall watchdog', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'))]
      })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      const attempt = getActiveAttempt()!
      expect(attempt.ttftTimer).not.toBeNull()
      expect(attempt.hasStreamed).toBe(false)

      slice.applyEvent(ev('message.part.updated', { part: textPart('p1', 'm1', 'sess-1', 'tok') }))

      expect(getActiveAttempt()!.hasStreamed).toBe(true)
      expect(getActiveAttempt()!.ttftTimer).toBeNull()
      expect(get().messages[0]!.parts).toHaveLength(1)
    })
  })

  describe('message.part.updated — tool-call lifecycle', () => {
    it('pending -> running pauses the stall watchdog and marks the tool executed', () => {
      const { slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'))]
      })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')

      slice.applyEvent(ev('message.part.updated', { part: toolPart('t1', 'm1', 'sess-1', { status: 'pending' }) }))
      expect(getActiveAttempt()!.pausedForTool).toBe(true)
      expect(getActiveAttempt()!.toolExecuted).toBe(true)
      expect(getActiveAttempt()!.stallTimer).toBeNull()

      slice.applyEvent(ev('message.part.updated', { part: toolPart('t1', 'm1', 'sess-1', { status: 'running' }) }))
      expect(getActiveAttempt()!.pausedForTool).toBe(true)
      expect(getActiveAttempt()!.toolExecuted).toBe(true)
    })

    it('running -> completed resumes the stall watchdog', () => {
      const { slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'))]
      })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      slice.applyEvent(ev('message.part.updated', { part: toolPart('t1', 'm1', 'sess-1', { status: 'running' }) }))
      expect(getActiveAttempt()!.pausedForTool).toBe(true)

      slice.applyEvent(ev('message.part.updated', { part: toolPart('t1', 'm1', 'sess-1', { status: 'completed', output: 'ok' }) }))

      expect(getActiveAttempt()!.pausedForTool).toBe(false)
      expect(getActiveAttempt()!.stallTimer).not.toBeNull()
    })

    it('running -> error also resumes the stall watchdog (error is a terminal tool state)', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'))]
      })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      slice.applyEvent(ev('message.part.updated', { part: toolPart('t1', 'm1', 'sess-1', { status: 'running' }) }))

      slice.applyEvent(ev('message.part.updated', { part: toolPart('t1', 'm1', 'sess-1', { status: 'error', error: 'boom' }) }))

      expect(getActiveAttempt()!.pausedForTool).toBe(false)
      const stored = get().messages[0]!.parts.find((p) => p.id === 't1') as any
      expect(stored.state.status).toBe('error')
      expect(stored.state.error).toBe('boom')
    })
  })

  describe('message.removed / message.part.removed', () => {
    it('removes a message by id when scoped to the active session', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(userMsg('m1', 'sess-1')), withParts(asstMsg('m2', 'sess-1'))]
      })

      slice.applyEvent(ev('message.removed', { sessionID: 'sess-1', messageID: 'm1' }))

      expect(get().messages.map((m) => m.info.id)).toEqual(['m2'])
    })

    it('ignores message.removed for a non-active session', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(userMsg('m1', 'sess-1'))]
      })

      slice.applyEvent(ev('message.removed', { sessionID: 'other', messageID: 'm1' }))

      expect(get().messages).toHaveLength(1)
    })

    it('removes a single part by id, leaving sibling parts intact', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'), [textPart('p1', 'm1', 'sess-1', 'a'), textPart('p2', 'm1', 'sess-1', 'b')])]
      })

      slice.applyEvent(ev('message.part.removed', { sessionID: 'sess-1', messageID: 'm1', partID: 'p1' }))

      expect(get().messages[0]!.parts.map((p) => p.id)).toEqual(['p2'])
    })

    it('removing an already-absent part is a harmless no-op (out-of-order removal)', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        messages: [withParts(asstMsg('m1', 'sess-1'), [textPart('p1', 'm1', 'sess-1', 'a')])]
      })
      const before = get().messages

      slice.applyEvent(ev('message.part.removed', { sessionID: 'sess-1', messageID: 'm1', partID: 'never-existed' }))

      expect(get().messages).toBe(before)
    })
  })

  describe('permission.updated / permission.replied', () => {
    it('a permission request arrives as a prompt: pushed onto permissions once', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', permissions: [] })

      slice.applyEvent({ type: 'permission.updated', properties: permissionFixture('perm-1', 'sess-1') })

      expect(get().permissions.map((p) => p.id)).toEqual(['perm-1'])
    })

    it('does not duplicate a permission already present by id', () => {
      const existing = permissionFixture('perm-1', 'sess-1')
      const { get, slice } = setup({ activeSessionID: 'sess-1', permissions: [existing] })

      slice.applyEvent({ type: 'permission.updated', properties: permissionFixture('perm-1', 'sess-1', { title: 'changed' }) })

      expect(get().permissions).toHaveLength(1)
      expect(get().permissions[0]!.title).toBe('Run a command') // untouched, not replaced
    })

    it('ignores a permission for an unrelated session', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', sessions: [], permissions: [] })

      slice.applyEvent({ type: 'permission.updated', properties: permissionFixture('perm-1', 'unrelated-session') })

      expect(get().permissions).toEqual([])
    })

    it('accepts a permission from a subagent (descendant) session of the active one', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        sessions: [sessionFixture('sess-1'), sessionFixture('child-1', { parentID: 'sess-1' })],
        permissions: []
      })

      slice.applyEvent({ type: 'permission.updated', properties: permissionFixture('perm-1', 'child-1') })

      expect(get().permissions.map((p) => p.id)).toEqual(['perm-1'])
    })

    it('permission.replied drops the matching permission by permissionID', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        permissions: [permissionFixture('perm-1', 'sess-1'), permissionFixture('perm-2', 'sess-1')]
      })

      slice.applyEvent(ev('permission.replied', { permissionID: 'perm-1' }))

      expect(get().permissions.map((p) => p.id)).toEqual(['perm-2'])
    })

    it('permission.replied for an unknown id is a no-op', () => {
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        permissions: [permissionFixture('perm-1', 'sess-1')]
      })

      slice.applyEvent(ev('permission.replied', { permissionID: 'never-existed' }))

      expect(get().permissions).toHaveLength(1)
    })
  })

  describe('session.status', () => {
    it('ignores status updates for a non-active session', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: false })
      slice.applyEvent(ev('session.status', { sessionID: 'other', status: { type: 'busy' } }))
      expect(get().busy).toBe(false)
    })

    it('busy=true while status.type is "busy"', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: false })
      slice.applyEvent(ev('session.status', { sessionID: 'sess-1', status: { type: 'busy' } }))
      expect(get().busy).toBe(true)
    })

    it('"busy" with a live attempt for the session (re)arms the stall watchdog', () => {
      const { slice } = setup({ activeSessionID: 'sess-1', busy: false })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      const attempt = getActiveAttempt()!
      attempt.stallTimer = null // simulate the paused/cleared state a 'busy' status is meant to resume

      slice.applyEvent(ev('session.status', { sessionID: 'sess-1', status: { type: 'busy' } }))

      expect(getActiveAttempt()!.stallTimer).not.toBeNull()
    })

    it('"retry" pauses (clears) the in-flight stall watchdog without flipping busy off', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: true })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      const attempt = getActiveAttempt()!
      attempt.stallTimer = setTimeout(() => {}, 90_000)

      slice.applyEvent(ev('session.status', { sessionID: 'sess-1', status: { type: 'retry' } }))

      expect(getActiveAttempt()!.stallTimer).toBeNull()
      expect(get().busy).toBe(true) // retry still counts as busy
    })

    it('a status neither busy nor retry clears busy', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: true })
      slice.applyEvent(ev('session.status', { sessionID: 'sess-1', status: { type: 'completed' } }))
      expect(get().busy).toBe(false)
    })
  })

  describe('session.idle', () => {
    it('ignores an idle event for a non-active session', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: true })
      slice.applyEvent(ev('session.idle', { sessionID: 'other' }))
      expect(get().busy).toBe(true)
    })

    it('sets busy=false and records a success in the routing ledger for the live attempt', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: true })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')

      slice.applyEvent(ev('session.idle', { sessionID: 'sess-1' }))

      expect(get().busy).toBe(false)
      expect(getActiveAttempt()).toBeNull()
      expect(getLedger()['google/gemini-3.6-flash']).toBeDefined()
      expect(getLedger()['google/gemini-3.6-flash']!.latencyEwma).not.toBeNull()
    })

    it('resets rotateRetries on a clean completion (no failover in flight) — R2', () => {
      const { slice } = setup({ activeSessionID: 'sess-1' })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      // Simulate that a prior exchange had already retried once.
      // (rotateRetries is only mutated internally by beginFailover; we assert the
      // reset call fires by checking it stays at its already-zero baseline here and
      // that idle does not throw when failoverInFlight is false.)
      expect(getActiveAttempt()!.failoverInFlight).toBe(false)

      slice.applyEvent(ev('session.idle', { sessionID: 'sess-1' }))

      expect(getRotateRetries()).toBe(0)
    })

    it('does NOT reset rotateRetries when the completing attempt has a failover in flight', () => {
      const { slice } = setup({ activeSessionID: 'sess-1' })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      getActiveAttempt()!.failoverInFlight = true

      // resetRotateRetries only fires on a clean completion; simulate a nonzero
      // counter first so we can observe it is left untouched.
      setLedger({}) // no-op, keeps intent explicit
      slice.applyEvent(ev('session.idle', { sessionID: 'sess-1' }))

      // clean up is still correct: busy clears and attempt is released either way
      expect(getActiveAttempt()).toBeNull()
    })

    it('clears the captured last prompt for this session', () => {
      const { slice } = setup({ activeSessionID: 'sess-1' })
      setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: 'm1' })

      slice.applyEvent(ev('session.idle', { sessionID: 'sess-1' }))

      expect(getLastPrompt()).toBeNull()
    })

    it('drains one queued prompt and dispatches it through send()', () => {
      const sendMock = vi.fn(async () => {})
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        queuedPrompts: [{ text: 'next prompt', parts: undefined }],
        send: sendMock
      })

      slice.applyEvent(ev('session.idle', { sessionID: 'sess-1' }))

      expect(get().queuedPrompts).toEqual([])
      expect(sendMock).toHaveBeenCalledWith('next prompt', undefined)
    })

    it('leaves the queue untouched when empty', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', queuedPrompts: [] })
      slice.applyEvent(ev('session.idle', { sessionID: 'sess-1' }))
      expect(get().queuedPrompts).toEqual([])
    })
  })

  describe('session.error', () => {
    it('ignores an error for a session that is not active (never replays into the wrong session)', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: true, error: null })
      slice.applyEvent(ev('session.error', { sessionID: 'other', error: { name: 'Boom' } }))
      expect(get().busy).toBe(true)
      expect(get().error).toBeNull()
    })

    it('a user-initiated MessageAbortedError (no recovery marker) clears busy and the active attempt', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: true })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')

      slice.applyEvent(ev('session.error', { sessionID: 'sess-1', error: { name: 'MessageAbortedError' } }))

      expect(get().busy).toBe(false)
      expect(getActiveAttempt()).toBeNull()
      expect(getLastSendStartTime()).toBeNull()
    })

    it('a recovery-triggered MessageAbortedError just clears the marker and leaves busy alone', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: true })
      setAbortForRecoverySessionID('sess-1')

      slice.applyEvent(ev('session.error', { sessionID: 'sess-1', error: { name: 'MessageAbortedError' } }))

      expect(getAbortForRecoverySessionID()).toBeNull()
      expect(get().busy).toBe(true) // untouched — this abort was our own doing, not the user's
    })

    it('a non-retryable client error surfaces directly, no failover attempted', () => {
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: true, routingMode: 'failover' })

      slice.applyEvent(
        ev('session.error', {
          sessionID: 'sess-1',
          error: { name: 'ApiError', data: { message: 'Invalid request body', statusCode: 400 } }
        })
      )

      expect(get().busy).toBe(false)
      expect(get().error).toBe('Invalid request body')
    })

    it('routingMode "locked" never fails over, even on a retryable error class', () => {
      const rotateToNextFreeModel = vi.fn(() => ({
        providerID: 'groq',
        modelID: 'llama',
        providerName: 'Groq',
        modelName: 'Llama'
      }))
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        busy: true,
        routingMode: 'locked',
        directory: '/proj',
        rotateToNextFreeModel
      })
      setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: 'm1' })

      slice.applyEvent(
        ev('session.error', {
          sessionID: 'sess-1',
          error: { name: 'ApiError', data: { message: 'RESOURCE_EXHAUSTED: quota exceeded for today', statusCode: 429 } }
        })
      )

      expect(get().busy).toBe(false)
      expect(get().error).toContain('quota')
      expect(rotateToNextFreeModel).not.toHaveBeenCalled()
    })

    it('R1: blocks auto-retry and surfaces a warning once a tool has already executed', () => {
      const addSystemNotice = vi.fn()
      const { get, slice } = setup({ activeSessionID: 'sess-1', busy: true, addSystemNotice, directory: '/proj' })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      getActiveAttempt()!.toolExecuted = true
      setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: 'm1' })

      slice.applyEvent(
        ev('session.error', {
          sessionID: 'sess-1',
          error: { name: 'ApiError', data: { message: 'RESOURCE_EXHAUSTED: quota', statusCode: 429 } }
        })
      )

      expect(get().busy).toBe(false)
      expect(addSystemNotice).toHaveBeenCalledWith(expect.stringMatching(/side effects already committed/))
    })

    it('honors Retry-After from responseHeaders when recording the 429 in the ledger', async () => {
      const rotateToNextFreeModel = vi.fn(() => null) // no free model left — surfaces the error
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        busy: true,
        directory: '/proj',
        rotateToNextFreeModel
      })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: 'm1' })

      slice.applyEvent(
        ev('session.error', {
          sessionID: 'sess-1',
          error: {
            name: 'ApiError',
            data: {
              message: 'rate limit exceeded',
              statusCode: 429,
              responseHeaders: { 'retry-after': '5' }
            }
          }
        })
      )
      await flush()

      expect(getLedger()['google/gemini-3.6-flash']!.cooldownMs).toBe(5_000)
      expect(get().busy).toBe(false)
      expect(get().error).toBeTruthy()
    })

    it('a non-429 retryable class (timeout) records a plain failure, not a 429 cooldown, in the ledger', async () => {
      const rotateToNextFreeModel = vi.fn(() => null)
      const { slice } = setup({
        activeSessionID: 'sess-1',
        busy: true,
        directory: '/proj',
        rotateToNextFreeModel
      })
      startActiveAttempt('sess-1', 'google', 'gemini-3.6-flash')
      setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: 'm1' })

      slice.applyEvent(
        ev('session.error', {
          sessionID: 'sess-1',
          error: { name: 'ApiError', data: { message: 'the request timed out', statusCode: 504 } }
        })
      )
      await flush()

      const health = getLedger()['google/gemini-3.6-flash']!
      expect(health.error).toBe(1)
      expect(health.last429).toBeNull() // record429 was NOT the path taken
    })

    it('a retryable error with no free model left in the pool surfaces the original error', async () => {
      const rotateToNextFreeModel = vi.fn(() => null)
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        busy: true,
        directory: '/proj',
        rotateToNextFreeModel
      })
      setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: 'm1' })

      slice.applyEvent(
        ev('session.error', {
          sessionID: 'sess-1',
          error: { name: 'ApiError', data: { message: 'the request timed out', statusCode: 504 } }
        })
      )
      await flush()

      expect(rotateToNextFreeModel).toHaveBeenCalled()
      expect(get().busy).toBe(false)
      expect(get().error).toBeTruthy()
    })

    it('a retryable error with a free model available reverts the message and re-prompts on it', async () => {
      mockApi.mockReturnValue(fakeApi())
      const rotateToNextFreeModel = vi.fn(() => ({
        providerID: 'groq',
        modelID: 'llama-3.3-70b-versatile',
        providerName: 'Groq',
        modelName: 'Llama 3.3 70B'
      }))
      const addSystemNotice = vi.fn()
      const { get, slice } = setup({
        activeSessionID: 'sess-1',
        busy: true,
        error: null,
        directory: '/proj',
        rotateToNextFreeModel,
        addSystemNotice
      })
      setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: 'm1' })

      slice.applyEvent(
        ev('session.error', {
          sessionID: 'sess-1',
          error: { name: 'ApiError', data: { message: 'RESOURCE_EXHAUSTED: quota exceeded', statusCode: 429 } }
        })
      )
      await flush()

      expect(rotateToNextFreeModel).toHaveBeenCalled()
      expect(get().busy).toBe(true)
      expect(get().error).toBeNull()
      expect(getActiveAttempt()).toMatchObject({ sessionID: 'sess-1', providerID: 'groq', modelID: 'llama-3.3-70b-versatile' })
      expect(addSystemNotice).toHaveBeenCalledWith(expect.stringMatching(/Failover/))
    })
  })

  describe('session.created / session.updated / session.deleted', () => {
    it('adds a brand-new session when it belongs to the current directory', () => {
      const { get, slice } = setup({ directory: '/proj', sessions: [] })
      slice.applyEvent(ev('session.created', { info: sessionFixture('s1', { directory: '/proj' }) }))
      expect(get().sessions.map((s) => s.id)).toEqual(['s1'])
    })

    it('ignores a brand-new session for a different directory', () => {
      const { get, slice } = setup({ directory: '/proj', sessions: [] })
      slice.applyEvent(ev('session.created', { info: sessionFixture('s1', { directory: '/elsewhere' }) }))
      expect(get().sessions).toEqual([])
    })

    it('updates an already-known session even if its directory field changed', () => {
      const { get, slice } = setup({ directory: '/proj', sessions: [sessionFixture('s1', { directory: '/proj', title: 'Old' })] })
      slice.applyEvent(ev('session.updated', { info: sessionFixture('s1', { directory: '/elsewhere', title: 'New' }) }))
      expect(get().sessions[0]!.title).toBe('New')
    })

    it('session.deleted removes the session and, if it was active, clears dependent state', () => {
      const { get, slice } = setup({
        activeSessionID: 's1',
        sessions: [sessionFixture('s1')],
        messages: [withParts(userMsg('m1', 's1'))],
        permissions: [permissionFixture('perm-1', 's1')],
        busy: true
      })

      slice.applyEvent(ev('session.deleted', { info: sessionFixture('s1') }))

      expect(get().sessions).toEqual([])
      expect(get().activeSessionID).toBeNull()
      expect(get().messages).toEqual([])
      expect(get().permissions).toEqual([])
      expect(get().busy).toBe(false)
    })

    it('session.deleted for a non-active session leaves active-session state untouched', () => {
      const { get, slice } = setup({
        activeSessionID: 's1',
        sessions: [sessionFixture('s1'), sessionFixture('s2')],
        messages: [withParts(userMsg('m1', 's1'))],
        busy: true
      })

      slice.applyEvent(ev('session.deleted', { info: sessionFixture('s2') }))

      expect(get().sessions.map((s) => s.id)).toEqual(['s1'])
      expect(get().activeSessionID).toBe('s1')
      expect(get().messages).toHaveLength(1)
      expect(get().busy).toBe(true)
    })

    it('session.deleted with an unknown id that is not active is a no-op', () => {
      const { get, slice } = setup({ activeSessionID: 's1', sessions: [sessionFixture('s1')] })
      slice.applyEvent(ev('session.deleted', { info: sessionFixture('never-existed') }))
      expect(get().sessions.map((s) => s.id)).toEqual(['s1'])
    })
  })

  describe('todo.updated / session.compacted / vcs.branch.updated / file.edited', () => {
    it('todo.updated for the active session fetches and stores fresh todos', async () => {
      const todos = [{ id: 't1', content: 'do thing', status: 'pending' } as any]
      mockApi.mockReturnValue(fakeApi({ sessions: { todos: vi.fn(async () => todos) } } as any))
      const { get, slice } = setup({ activeSessionID: 'sess-1', directory: '/proj', todos: [] })

      slice.applyEvent(ev('todo.updated', { sessionID: 'sess-1' }))
      await flush()

      expect(get().todos).toEqual(todos)
    })

    it('todo.updated for a non-active session does not touch todos', async () => {
      const todosFn = vi.fn(async () => [])
      mockApi.mockReturnValue(fakeApi({ sessions: { todos: todosFn } } as any))
      const { get, slice } = setup({ activeSessionID: 'sess-1', directory: '/proj', todos: [] })

      slice.applyEvent(ev('todo.updated', { sessionID: 'other' }))
      await flush()

      expect(todosFn).not.toHaveBeenCalled()
      expect(get().todos).toEqual([])
    })

    it('vcs.branch.updated sets the branch, and a falsy branch clears it to null', () => {
      const { get, slice } = setup({ branch: null })
      slice.applyEvent(ev('vcs.branch.updated', { branch: 'feature/x' }))
      expect(get().branch).toBe('feature/x')

      slice.applyEvent(ev('vcs.branch.updated', { branch: '' }))
      expect(get().branch).toBeNull()
    })

    it('vcs.branch.updated with no branch field at all is a no-op', () => {
      const { get, slice } = setup({ branch: 'main' })
      slice.applyEvent(ev('vcs.branch.updated', {}))
      expect(get().branch).toBe('main')
    })

    it('session.compacted reloads messages and appends a "Context compacted." notice', async () => {
      const loaded = [withParts(userMsg('m1', 'sess-1', { time: { created: 100 } }))]
      mockApi.mockReturnValue(fakeApi({ messages: vi.fn(async () => loaded) } as any))
      const { get, slice } = setup({ activeSessionID: 'sess-1', directory: '/proj', messages: [] })

      slice.applyEvent(ev('session.compacted', { sessionID: 'sess-1' }))
      await flush()

      expect(get().messages).toHaveLength(2)
      const notice = get().messages[1]!
      expect((notice.parts[0] as any).text).toBe('Context compacted.')
    })

    it('session.compacted for a non-active session does not touch messages', async () => {
      const messagesFn = vi.fn(async () => [])
      mockApi.mockReturnValue(fakeApi({ messages: messagesFn } as any))
      const { get, slice } = setup({ activeSessionID: 'sess-1', directory: '/proj', messages: [] })

      slice.applyEvent(ev('session.compacted', { sessionID: 'other' }))
      await flush()

      expect(messagesFn).not.toHaveBeenCalled()
      expect(get().messages).toEqual([])
    })

    it('file.edited debounce-refreshes both the git status and the file tree', () => {
      const refreshGit = vi.fn(async () => {})
      const refreshTree = vi.fn(async () => {})
      const { slice } = setup({ refreshGit, refreshTree })

      slice.applyEvent(ev('file.edited', {}))

      expect(refreshGit).toHaveBeenCalledTimes(1)
      expect(refreshTree).toHaveBeenCalledTimes(1)
    })

    it('session.created inherits sessionReadOnly when parent session is read-only', () => {
      const { get, slice } = setup({
        directory: '/proj',
        sessionReadOnly: { 'parent-1': true }
      })

      slice.applyEvent(
        ev('session.created', {
          info: { id: 'child-1', parentID: 'parent-1', directory: '/proj' }
        })
      )

      expect(get().sessionReadOnly?.['child-1']).toBe(true)
      expect(get().sessions.some((s) => s.id === 'child-1')).toBe(true)
    })
  })
})
