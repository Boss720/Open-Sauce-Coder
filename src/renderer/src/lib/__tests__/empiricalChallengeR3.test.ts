import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import { READONLY_TOOLS } from '../toolPolicies'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { registerStore, type StoreHandle } from '../slices/storeRef'
import {
  beginFailover,
  clearActiveAttempt,
  getActiveAttempt,
  setLastPrompt,
  startActiveAttempt,
  touchActiveAttempt,
  markToolStarted,
  recoverHungAttempt
} from '../slices/attemptMachine'
import { createSessionSlice } from '../slices/sessionSlice'
import { createSubagentSlice } from '../slices/subagentSlice'
import { createEventSlice } from '../slices/eventSlice'
import type { OcEvent, Session } from '../types'

const mockApi = vi.mocked(api)

function makeSession(id: string, title: string, parentID: string | null = null): Session {
  return {
    id,
    parentID,
    directory: '/proj',
    projectID: 'p1',
    title,
    version: '1',
    time: { created: Date.now(), updated: Date.now() }
  } as Session
}

function fakeApi(overrides: Partial<OpencodeApi> = {}): OpencodeApi {
  return {
    revertMessage: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    sessions: {
      create: vi.fn(async (_dir, title, parentID) => makeSession(`child-${Date.now()}`, title ?? 'Child Session', parentID ?? null)),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => {}),
      update: vi.fn(async (_dir, id, title) => makeSession(id, title)),
      todos: vi.fn(async () => [])
    } as unknown as OpencodeApi['sessions'],
    ...overrides
  } as unknown as OpencodeApi
}

function createHarnessStore(initialState: Partial<AppState> = {}): {
  get: GetState
  set: SetState
  handle: StoreHandle
} {
  let state = {} as AppState

  const set: SetState = ((partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState

  const get: GetState = () => state
  const handle: StoreHandle = { getState: get, setState: set }

  const sessionSlice = createSessionSlice(set, get)
  const subagentSlice = createSubagentSlice(set, get)
  const eventSlice = createEventSlice(set, get)
  set(sessionSlice)
  set(subagentSlice)
  set(eventSlice)

  set({
    directory: '/proj',
    activeSessionID: 'sess-1',
    busy: false,
    error: null,
    routingMode: 'failover',
    providerID: 'google',
    modelID: 'gemini-2.5-flash',
    providers: [
      { id: 'google', name: 'Google', models: { 'gemini-2.5-flash': { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' } } },
      { id: 'nanogpt', name: 'NanoGPT', models: { 'qwen/coder': { id: 'qwen/coder', name: 'Qwen Coder' } } }
    ],
    linkedProviderIDs: ['google', 'nanogpt'],
    modelPool: null,
    sessions: [makeSession('sess-1', 'Main Session')],
    messages: [],
    permissions: [],
    sessionAgents: {},
    sessionReadOnly: {},
    appSettings: { ttftMs: 20_000, stallMs: 90_000 },
    addSystemNotice: vi.fn(),
    rotateToNextFreeModel: vi.fn(() => ({
      providerID: 'nanogpt',
      modelID: 'qwen/coder',
      providerName: 'NanoGPT',
      modelName: 'Qwen Coder'
    })),
    clearSubagents: vi.fn()
  } as unknown as Partial<AppState>)

  set(initialState)

  registerStore(handle)
  return { get, set, handle }
}

describe('R3 Adversarial Challenge: Policy Snapshot Immutability & Side-Effect Guards', () => {
  beforeEach(() => {
    mockApi.mockReset()
    clearActiveAttempt()
    setLastPrompt(null)
  })

  afterEach(() => {
    clearActiveAttempt()
    setLastPrompt(null)
  })

  describe('R3.1: policySnapshot Retains Restricted Tools and Pinned Agent Against Store Mutation', () => {
    it('strictly preserves policySnapshot even if store sessionAgents and sessionReadOnly mutate to unrestricted during retry', async () => {
      const { set } = createHarnessStore({
        sessionAgents: { 'sess-1': 'unrestricted-admin' },
        sessionReadOnly: { 'sess-1': false }
      })

      const promptSpy = vi.fn(async (_args: Parameters<OpencodeApi['prompt']>[0]) => {})
      const revertSpy = vi.fn(async () => {})
      mockApi.mockReturnValue(fakeApi({ prompt: promptSpy, revertMessage: revertSpy }))

      startActiveAttempt('sess-1', 'google', 'gemini-2.5-flash')
      const initialPolicy = { agent: 'reviewer', tools: { ...READONLY_TOOLS } }

      setLastPrompt({
        text: 'Review this patch',
        parts: undefined,
        sessionID: 'sess-1',
        userMessageID: 'usr-1',
        policy: initialPolicy
      })

      // Adversarial mutation: Store state changes dynamically right before failover executes
      set({
        sessionAgents: { 'sess-1': 'malicious-agent-override' },
        sessionReadOnly: { 'sess-1': false }
      })

      const failoverDispatched = await beginFailover(
        'sess-1',
        '/proj',
        'Review this patch',
        undefined,
        'rate-limited',
        'google/gemini-2.5-flash',
        undefined,
        initialPolicy // explicit snapshot passed
      )

      expect(failoverDispatched).toBe(true)
      expect(promptSpy).toHaveBeenCalledTimes(1)
      const promptCall = promptSpy.mock.calls[0]?.[0]
      expect(promptCall?.agent).toBe('reviewer')
      expect(promptCall?.tools).toEqual(READONLY_TOOLS)
      expect(promptCall?.agent).not.toBe('malicious-agent-override')
    })

    it('falls back to lastPrompt.policy snapshot if policySnapshot arg omitted, resisting store corruption', async () => {
      const { set } = createHarnessStore({
        sessionAgents: { 'sess-1': 'cleared-agent' },
        sessionReadOnly: { 'sess-1': false }
      })

      const promptSpy = vi.fn(async (_args: Parameters<OpencodeApi['prompt']>[0]) => {})
      mockApi.mockReturnValue(fakeApi({ prompt: promptSpy }))

      startActiveAttempt('sess-1', 'google', 'gemini-2.5-flash')
      const capturedPolicy = { agent: 'auditor', tools: { ...READONLY_TOOLS } }

      setLastPrompt({
        text: 'Audit code',
        parts: undefined,
        sessionID: 'sess-1',
        userMessageID: 'usr-1',
        policy: capturedPolicy
      })

      // Corrupt the global store entirely
      set({ sessionAgents: {}, sessionReadOnly: {} })

      // Call beginFailover without explicit policySnapshot argument
      const failoverDispatched = await beginFailover(
        'sess-1',
        '/proj',
        'Audit code',
        undefined,
        'transient-500',
        'google/gemini-2.5-flash'
      )

      expect(failoverDispatched).toBe(true)
      expect(promptSpy).toHaveBeenCalledTimes(1)
      const promptCall = promptSpy.mock.calls[0]?.[0]
      expect(promptCall?.agent).toBe('auditor')
      expect(promptCall?.tools).toEqual(READONLY_TOOLS)
    })
  })

  describe('R3.2: Side-Effect Guards on Late Transport Errors (toolExecuted / hasStreamed)', () => {
    it('strictly prevents failover in sessionSlice.send when toolExecuted = true before transport error', async () => {
      const { get } = createHarnessStore()

      let promptInvocationCount = 0
      const promptSpy = vi.fn(async () => {
        promptInvocationCount++
        // Simulate: tool begins executing
        markToolStarted('sess-1')
        // Then transport throws a rate limit error (429)
        throw new Error('429 Too Many Requests (rate limit exceeded)')
      })

      mockApi.mockReturnValue(fakeApi({ prompt: promptSpy }))

      await get().send('Format the files')

      // 1. Initial prompt was attempted
      expect(promptInvocationCount).toBe(1)
      // 2. Because toolExecuted was true, failover was strictly prevented (prompt not called a 2nd time)
      expect(promptSpy).toHaveBeenCalledTimes(1)
      // 3. UI is not busy, error is surfaced
      expect(get().busy).toBe(false)
      expect(get().error).toContain('429 Too Many Requests')
      // 4. activeAttempt was cleaned up
      expect(getActiveAttempt()).toBeNull()
    })

    it('strictly prevents failover in sessionSlice.send when hasStreamed = true before transport error', async () => {
      const { get } = createHarnessStore()

      let promptInvocationCount = 0
      const promptSpy = vi.fn(async () => {
        promptInvocationCount++
        // Simulate: tokens stream in
        touchActiveAttempt('sess-1')
        // Then network connection drops mid-stream
        throw new Error('503 Service Unavailable: connection reset by peer')
      })

      mockApi.mockReturnValue(fakeApi({ prompt: promptSpy }))

      await get().send('Write a script')

      // Initial prompt was attempted
      expect(promptInvocationCount).toBe(1)
      // Failover was NOT triggered because tokens already streamed
      expect(promptSpy).toHaveBeenCalledTimes(1)
      expect(get().busy).toBe(false)
      expect(get().error).toContain('503 Service Unavailable')
      expect(getActiveAttempt()).toBeNull()
    })

    it('successfully fails over and re-prompts next free model when NO side effects occurred and userMessageID is valid', async () => {
      createHarnessStore()

      const promptSpy = vi.fn(async () => {})
      const revertSpy = vi.fn(async () => {})
      mockApi.mockReturnValue(fakeApi({ prompt: promptSpy, revertMessage: revertSpy }))

      startActiveAttempt('sess-1', 'google', 'gemini-2.5-flash')
      setLastPrompt({
        text: 'Clean prompt',
        parts: undefined,
        sessionID: 'sess-1',
        userMessageID: 'usr-valid',
        policy: { agent: 'coder', tools: { fs_read: true } }
      })

      // When beginFailover is executed for an attempt with no side effects
      const dispatched = await beginFailover(
        'sess-1',
        '/proj',
        'Clean prompt',
        undefined,
        'rate-limit-429',
        'google/gemini-2.5-flash'
      )

      expect(dispatched).toBe(true)
      expect(revertSpy).toHaveBeenCalledWith({
        directory: '/proj',
        sessionID: 'sess-1',
        messageID: 'usr-valid'
      })
      expect(promptSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionID: 'sess-1',
          providerID: 'nanogpt',
          modelID: 'qwen/coder',
          text: 'Clean prompt',
          agent: 'coder'
        })
      )
    })

    it('strictly blocks beginFailover direct call if activeAttempt has toolExecuted or hasStreamed', async () => {
      const { get } = createHarnessStore()

      startActiveAttempt('sess-1', 'google', 'gemini-2.5-flash')
      setLastPrompt({ text: 'test', sessionID: 'sess-1', userMessageID: 'usr-1' })

      // Case 1: toolExecuted is true
      getActiveAttempt()!.toolExecuted = true
      const res1 = await beginFailover('sess-1', '/proj', 'test', undefined, 'err')
      expect(res1).toBe(false)
      expect(get().addSystemNotice).toHaveBeenCalledWith(
        expect.stringContaining('side effects already committed')
      )

      // Case 2: hasStreamed is true
      clearActiveAttempt()
      startActiveAttempt('sess-1', 'google', 'gemini-2.5-flash')
      getActiveAttempt()!.hasStreamed = true
      const res2 = await beginFailover('sess-1', '/proj', 'test', undefined, 'err')
      expect(res2).toBe(false)
    })

    it('watchdog recoverHungAttempt refuses retry and fails cleanly when side effects exist', async () => {
      const { get } = createHarnessStore({ busy: true })

      startActiveAttempt('sess-1', 'google', 'gemini-2.5-flash')
      const attempt = getActiveAttempt()!
      attempt.toolExecuted = true

      const abortSpy = vi.fn(async () => {})
      mockApi.mockReturnValue(fakeApi({ abort: abortSpy }))

      await recoverHungAttempt(attempt, 'stall')

      expect(abortSpy).not.toHaveBeenCalled()
      expect(getActiveAttempt()).toBeNull()
      expect(get().error).toMatch(/mid-response/i)
    })
  })

  describe('R3.3: Subagent & Side-Chat Read-Only Restriction Confinement', () => {
    it('startSideChat (/btw) strictly inherits parent sessionReadOnly and passes READONLY_TOOLS', async () => {
      const { get } = createHarnessStore({
        activeSessionID: 'parent-ro-1',
        sessionReadOnly: { 'parent-ro-1': true },
        sessions: [makeSession('parent-ro-1', 'Parent')]
      })

      let createdChildId = ''
      const promptSpy = vi.fn(async () => {})
      mockApi.mockReturnValue(fakeApi({
        sessions: {
          create: vi.fn(async (_dir, _title, parentID) => {
            createdChildId = `side-chat-${Date.now()}`
            return makeSession(createdChildId, 'Tangent', parentID ?? null)
          }),
          list: vi.fn(async () => []),
          remove: vi.fn(async () => {}),
          update: vi.fn(async (_dir, id, title) => makeSession(id, title)),
          todos: vi.fn(async () => [])
        } as unknown as OpencodeApi['sessions'],
        prompt: promptSpy
      }))

      await get().startSideChat('Can we delete log files?')

      expect(createdChildId).not.toBe('')
      expect(get().sessionReadOnly[createdChildId]).toBe(true)
      expect(promptSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionID: createdChildId,
          tools: READONLY_TOOLS
        })
      )
    })

    it('promptSubagent strictly enforces parent read-only policy on child follow-up', async () => {
      const { get } = createHarnessStore({
        activeSessionID: 'parent-ro-2',
        sessionReadOnly: { 'parent-ro-2': true },
        sessions: [
          makeSession('parent-ro-2', 'Parent'),
          makeSession('child-task-1', 'Child Task', 'parent-ro-2')
        ],
        subagentTabs: ['child-task-1'],
        subagentBusy: { 'child-task-1': false }
      })

      const promptSpy = vi.fn(async () => {})
      mockApi.mockReturnValue(fakeApi({ prompt: promptSpy }))

      await get().promptSubagent('child-task-1', 'Try writing to disk')

      expect(get().sessionReadOnly['child-task-1']).toBe(true)
      expect(promptSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionID: 'child-task-1',
          tools: READONLY_TOOLS
        })
      )
    })

    it('multi-generation delegation: grandchild inherits read-only from read-only child', () => {
      const { get } = createHarnessStore({
        activeSessionID: 'root-ro',
        sessionReadOnly: {
          'root-ro': true,
          'child-ro': true
        },
        sessions: [
          makeSession('root-ro', 'Root'),
          makeSession('child-ro', 'Child', 'root-ro')
        ]
      })

      // An SSE event arrives: grandchild created under child-ro
      const grandchildEvent: OcEvent = {
        type: 'session.created',
        properties: {
          info: makeSession('grandchild-1', 'Grandchild', 'child-ro')
        }
      }

      get().applyEvent(grandchildEvent)

      expect(get().sessionReadOnly['grandchild-1']).toBe(true)
    })
  })
})
