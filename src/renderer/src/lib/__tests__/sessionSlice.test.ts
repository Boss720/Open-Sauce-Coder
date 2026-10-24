import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { RoutingMode } from '../prefs'
import type { MessageWithParts, Part, Provider, Session, Todo } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

// The attempt machine is a singleton with real timers and a late-bound store handle —
// none of that belongs to sessionSlice's own tests (attemptMachine.test.ts owns it).
// Mocking it lets these tests assert exactly what sessionSlice hands off, and nothing more.
vi.mock('../slices/attemptMachine', () => ({
  beginFailover: vi.fn(async () => false),
  clearActiveAttempt: vi.fn(),
  getActiveAttempt: vi.fn(() => null),
  getLedger: vi.fn(() => ({})),
  resetRotateRetries: vi.fn(),
  setLastPrompt: vi.fn(),
  setLastSendStartTime: vi.fn(),
  setLedger: vi.fn(),
  startActiveAttempt: vi.fn()
}))

// reserveAttempt/record429/recordFailure/etc. are pure and already covered by
// routing.test.ts — keep them real. Only saveLedger has a real-timer side effect
// (a 500ms debounced localStorage write) that would otherwise dangle past the test.
vi.mock('../routing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routing')>()
  return { ...actual, saveLedger: vi.fn() }
})

import { api } from '../slices/api'
import { saveLedger } from '../routing'
import {
  beginFailover,
  clearActiveAttempt,
  getActiveAttempt,
  setLastPrompt,
  startActiveAttempt
} from '../slices/attemptMachine'
import { createSessionSlice, type SessionSlice } from '../slices/sessionSlice'

const mockApi = vi.mocked(api)
const mockSaveLedger = vi.mocked(saveLedger)
const mockBeginFailover = vi.mocked(beginFailover)
const mockClearActiveAttempt = vi.mocked(clearActiveAttempt)
const mockGetActiveAttempt = vi.mocked(getActiveAttempt)
const mockStartActiveAttempt = vi.mocked(startActiveAttempt)
const mockSetLastPrompt = vi.mocked(setLastPrompt)

type ApiOverrides = Omit<Partial<OpencodeApi>, 'sessions' | 'vcs' | 'commands'> & {
  sessions?: Partial<OpencodeApi['sessions']>
  vcs?: Partial<OpencodeApi['vcs']>
  commands?: Partial<OpencodeApi['commands']>
}

/** Minimal harness mirroring zustand's set/get shape, without pulling in zustand itself. */
function createStore(): { get: GetState; set: SetState } {
  let state = {} as AppState
  const set = ((partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  return { get, set }
}

/**
 * Installs the slice's own defaults first, then layers the test's overrides on top —
 * calling `set(slice)` *after* the overrides would clobber them with the slice's
 * initial values (busy: false, sessions: [], etc). `toggleAutoRotate` is stubbed here
 * (it belongs to routingSlice, not this one) purely so the `/free` command has
 * somewhere real to write.
 */
function setup(overrides: Partial<AppState> = {}): { get: GetState; set: SetState; slice: SessionSlice } {
  const { get, set } = createStore()
  const slice = createSessionSlice(set, get)
  set(slice)
  set({
    providers: [],
    linkedProviderIDs: [],
    routingMode: 'failover',
    modelPool: null,
    providerID: null,
    modelID: null,
    theme: 'auto',
    // Owned by uiSlice in the real composed store, but sessionSlice reads/writes them
    // (deleteSession filters `permissions`, most paths write `error`) — default them here
    // so those production code paths don't hit `undefined`.
    permissions: [],
    error: null,
    // Mirrors routingSlice: the toggle drives `routingMode` — off maps to `locked`,
    // on maps to `failover`. There is no separate `autoRotate` boolean any more.
    toggleAutoRotate: () =>
      set((s: AppState) => ({
        routingMode: (s.routingMode === 'locked' ? 'failover' : 'locked') as RoutingMode
      })),
    // Owned by subagentSlice/agentSlice in the composed store. sessionSlice reads the two
    // per-session records on every send and calls the three actions on select/setDirectory,
    // so they must exist here or those paths throw before reaching what is under test.
    sessionAgents: {},
    sessionReadOnly: {},
    clearSubagents: () => {},
    loadAgents: async () => {},
    startSideChat: async () => {},
    ...overrides
  })
  return { get, set, slice }
}

function fakeApi(overrides: ApiOverrides = {}): OpencodeApi {
  return {
    sessions: {
      list: vi.fn(async () => []),
      create: vi.fn(async () => session('new-sess')),
      remove: vi.fn(async () => {}),
      update: vi.fn(async () => session('renamed')),
      todos: vi.fn(async () => [])
    },
    vcs: { get: vi.fn(async () => null) },
    commands: { list: vi.fn(async () => []) },
    messages: vi.fn(async () => []),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    revertMessage: vi.fn(async () => {}),
    nanogpt: { images: { list: vi.fn(async () => []) } },
    ...overrides
  } as unknown as OpencodeApi
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'proj-1',
    directory: '/proj',
    title: id,
    version: '1',
    time: { created: 1000, updated: 1000 },
    ...overrides
  } as Session
}

function userMessage(id: string, sessionID: string, text: string): MessageWithParts {
  return {
    info: {
      id,
      sessionID,
      role: 'user',
      time: { created: 1000 },
      agent: 'build',
      model: { providerID: 'google', modelID: 'gemini-3.6-flash' }
    } as unknown as MessageWithParts['info'],
    parts: [{ id: `${id}-p1`, sessionID, messageID: id, type: 'text', text }] as unknown as MessageWithParts['parts']
  }
}

function assistantMessage(id: string, sessionID: string, overrides: Record<string, unknown> = {}): MessageWithParts {
  return {
    info: {
      id,
      sessionID,
      role: 'assistant',
      // Deliberately later than userMessage's fixed `created: 1000` — sortMessages ties on
      // `created` fall back to a lexicographic id compare, which would otherwise put e.g.
      // "a1" ahead of "u1" and silently reorder a fixture meant to read as chronological.
      time: { created: 1500, completed: 2000 },
      parentID: '',
      modelID: 'gemini-3.6-flash',
      providerID: 'google',
      mode: 'build',
      path: { cwd: '/proj', root: '/proj' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      ...overrides
    } as unknown as MessageWithParts['info'],
    parts: []
  }
}

function agentProvider(id: string, modelID: string): Provider {
  return {
    id,
    name: id,
    source: 'config',
    env: [],
    options: {},
    models: {
      [modelID]: {
        id: modelID,
        name: modelID,
        capabilities: { toolcall: true, input: { text: true }, output: { text: true } }
      } as unknown as Provider['models'][string]
    }
  } as unknown as Provider
}

/**
 * Finds the (synthetic) system-notice message containing `substr`. System notices and the
 * user's echoed slash-command message can share the same synthetic `created` second, so
 * their relative order after sortMessages isn't guaranteed — assert by content, not position.
 */
function findNotice(get: GetState, substr: string): MessageWithParts | undefined {
  return get().messages.find((m) => {
    const part: unknown = m.parts[0]
    return typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' &&
      'text' in part && typeof part.text === 'string' && part.text.includes(substr)
  })
}

function textContent(part: Part | undefined): string | undefined {
  return part?.type === 'text' ? part.text : undefined
}

beforeEach(() => {
  mockApi.mockReset()
  vi.clearAllMocks()
})

describe('setDirectory', () => {
  it('resets session state, then loads sessions/branch/commands for the new directory', async () => {
    const listedSessions = [session('a', { time: { created: 1, updated: 5 } }), session('b', { time: { created: 1, updated: 10 } })]
    mockApi.mockReturnValue(
      fakeApi({
        sessions: { list: vi.fn(async () => listedSessions) } as unknown as Partial<OpencodeApi['sessions']>,
        vcs: { get: vi.fn(async () => ({ branch: 'main' })) } as unknown as Partial<OpencodeApi['vcs']>,
        commands: { list: vi.fn(async () => [{ name: 'foo', description: 'd' }]) } as unknown as Partial<OpencodeApi['commands']>
      })
    )
    const { get, slice } = setup({
      directory: '/old',
      sessions: [session('stale')],
      activeSessionID: 'stale',
      messages: [userMessage('m1', 'stale', 'hi')],
      busy: true
    })

    await slice.setDirectory('/proj')

    expect(get().directory).toBe('/proj')
    expect(get().activeSessionID).toBeNull()
    expect(get().messages).toEqual([])
    expect(get().busy).toBe(false)
    // Newest-updated first.
    expect(get().sessions.map((s) => s.id)).toEqual(['b', 'a'])
    expect(get().branch).toBe('main')
    expect(get().serverCommands).toEqual([{ name: 'foo', description: 'd' }])
  })

  it('discards a stale sessions.list response if the directory changed again before it resolved', async () => {
    let resolveList: (v: Session[]) => void = () => {}
    const listPromise = new Promise<Session[]>((res) => {
      resolveList = res
    })
    mockApi.mockReturnValue(fakeApi({ sessions: { list: vi.fn(() => listPromise) } as unknown as Partial<OpencodeApi['sessions']> }))
    const { get, set, slice } = setup()

    const p = slice.setDirectory('/proj-a')
    set({ directory: '/proj-b' })
    resolveList([session('late')])
    await p

    expect(get().sessions).toEqual([])
  })

  it('surfaces a sessions.list failure as the error banner', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        sessions: {
          list: vi.fn(async () => {
            throw new Error('disk unplugged')
          })
        } as unknown as Partial<OpencodeApi['sessions']>
      })
    )
    const { get, slice } = setup()

    await slice.setDirectory('/proj')

    expect(get().error).toBe('disk unplugged')
  })

  it('swallows a vcs.get failure and leaves branch null', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        vcs: {
          get: vi.fn(async () => {
            throw new Error('not a repo')
          })
        } as unknown as Partial<OpencodeApi['vcs']>
      })
    )
    const { get, slice } = setup()

    await slice.setDirectory('/proj')

    expect(get().branch).toBeNull()
    expect(get().error).toBeNull()
  })

  it('swallows a commands.list failure and leaves serverCommands empty', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        commands: {
          list: vi.fn(async () => {
            throw new Error('boom')
          })
        } as unknown as Partial<OpencodeApi['commands']>
      })
    )
    const { get, slice } = setup()

    await slice.setDirectory('/proj')

    expect(get().serverCommands).toEqual([])
    expect(get().error).toBeNull()
  })
})

describe('newSession', () => {
  it('requires a directory first', async () => {
    const { get, slice } = setup({ directory: null })
    await slice.newSession()
    expect(get().error).toBe('Pick a project folder first.')
  })

  it('creates a session and makes it active', async () => {
    mockApi.mockReturnValue(fakeApi({ sessions: { create: vi.fn(async () => session('s1')) } as unknown as Partial<OpencodeApi['sessions']> }))
    const { get, slice } = setup({ directory: '/proj' })

    await slice.newSession()

    expect(get().activeSessionID).toBe('s1')
    expect(get().sessions.map((s) => s.id)).toEqual(['s1'])
    expect(get().messages).toEqual([])
    expect(get().error).toBeNull()
  })

  it('surfaces a creation failure', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        sessions: {
          create: vi.fn(async () => {
            throw new Error('quota exceeded')
          })
        } as unknown as Partial<OpencodeApi['sessions']>
      })
    )
    const { get, slice } = setup({ directory: '/proj' })

    await slice.newSession()

    expect(get().error).toBe('quota exceeded')
  })
})

describe('selectSession', () => {
  it('requires a directory first', async () => {
    const { get, slice } = setup({ directory: null })
    await slice.selectSession('s1')
    expect(get().error).toBe('Pick a project folder first.')
  })

  it('loads messages and reports not-busy when the last message already completed', async () => {
    const loaded = [userMessage('u1', 's1', 'hi'), assistantMessage('a1', 's1')]
    mockApi.mockReturnValue(fakeApi({ messages: vi.fn(async () => loaded) }))
    const { get, slice } = setup({ directory: '/proj' })

    await slice.selectSession('s1')

    expect(get().activeSessionID).toBe('s1')
    expect(get().messages.map((m) => m.info.id)).toEqual(['u1', 'a1'])
    expect(get().busy).toBe(false)
  })

  it('reports busy when the last message is an assistant turn still in flight', async () => {
    const loaded = [assistantMessage('a1', 's1', { time: { created: 1000 }, error: undefined })]
    mockApi.mockReturnValue(fakeApi({ messages: vi.fn(async () => loaded) }))
    const { get, slice } = setup({ directory: '/proj' })

    await slice.selectSession('s1')

    expect(get().busy).toBe(true)
  })

  it('discards a stale messages response for a session the user has since left', async () => {
    let resolveMessages: (v: MessageWithParts[]) => void = () => {}
    const messagesPromise = new Promise<MessageWithParts[]>((res) => {
      resolveMessages = res
    })
    mockApi.mockReturnValue(fakeApi({ messages: vi.fn(() => messagesPromise) }))
    const { get, set, slice } = setup({ directory: '/proj' })

    const p = slice.selectSession('s1')
    // The user switched away before the transcript came back.
    set({ activeSessionID: 's2' })
    resolveMessages([userMessage('u1', 's1', 'hi')])
    await p

    expect(get().messages).toEqual([])
  })

  it('surfaces a messages() failure as the error banner', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        messages: vi.fn(async () => {
          throw new Error('read failed')
        })
      })
    )
    const { get, slice } = setup({ directory: '/proj' })

    await slice.selectSession('s1')

    expect(get().error).toBe('read failed')
  })

  it('swallows a todos() failure — todos are optional', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        sessions: {
          todos: vi.fn(async () => {
            throw new Error('no todos endpoint')
          })
        } as unknown as Partial<OpencodeApi['sessions']>
      })
    )
    const { get, slice } = setup({ directory: '/proj', todos: [{ id: 'old' } as unknown as Todo] })

    await slice.selectSession('s1')

    expect(get().error).toBeNull()
    expect(get().todos).toEqual([{ id: 'old' }])
  })
})

describe('deleteSession', () => {
  it('no-ops without a directory', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { slice } = setup({ directory: null })
    await slice.deleteSession('s1')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('clears active session state when the deleted session was active', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({
      directory: '/proj',
      sessions: [session('s1'), session('s2')],
      activeSessionID: 's1',
      messages: [userMessage('m1', 's1', 'hi')],
      busy: true
    })

    await slice.deleteSession('s1')

    expect(get().sessions.map((s) => s.id)).toEqual(['s2'])
    expect(get().activeSessionID).toBeNull()
    expect(get().messages).toEqual([])
    expect(get().busy).toBe(false)
  })

  it('leaves messages/busy untouched when the deleted session was not active', async () => {
    mockApi.mockReturnValue(fakeApi())
    const messages = [userMessage('m1', 's2', 'hi')]
    const { get, slice } = setup({
      directory: '/proj',
      sessions: [session('s1'), session('s2')],
      activeSessionID: 's2',
      messages,
      busy: true
    })

    await slice.deleteSession('s1')

    expect(get().sessions.map((s) => s.id)).toEqual(['s2'])
    expect(get().activeSessionID).toBe('s2')
    expect(get().messages).toBe(messages)
    expect(get().busy).toBe(true)
  })

  it('surfaces a removal failure', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        sessions: {
          remove: vi.fn(async () => {
            throw new Error('locked')
          })
        } as unknown as Partial<OpencodeApi['sessions']>
      })
    )
    const { get, slice } = setup({ directory: '/proj', sessions: [session('s1')] })

    await slice.deleteSession('s1')

    expect(get().error).toBe('locked')
  })
})

describe('renameSession', () => {
  it('upserts the renamed session on success', async () => {
    mockApi.mockReturnValue(fakeApi({ sessions: { update: vi.fn(async () => session('s1', { title: 'New title' })) } as unknown as Partial<OpencodeApi['sessions']> }))
    const { get, slice } = setup({ directory: '/proj', sessions: [session('s1', { title: 'Old' })] })

    await slice.renameSession('s1', 'New title')

    expect(get().sessions[0].title).toBe('New title')
  })

  it('surfaces a rename failure', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        sessions: {
          update: vi.fn(async () => {
            throw new Error('name taken')
          })
        } as unknown as Partial<OpencodeApi['sessions']>
      })
    )
    const { get, slice } = setup({ directory: '/proj', sessions: [session('s1')] })

    await slice.renameSession('s1', 'x')

    expect(get().error).toBe('name taken')
  })
})

describe('queuePrompt / removeQueued', () => {
  it('appends to the queue', () => {
    const { get, slice } = setup()
    slice.queuePrompt('first')
    slice.queuePrompt('second', [{ type: 'text', text: 'second' }])
    expect(get().queuedPrompts).toEqual([{ text: 'first', parts: undefined }, { text: 'second', parts: [{ type: 'text', text: 'second' }] }])
  })

  it('removes only the targeted index', () => {
    const { get, slice } = setup({ queuedPrompts: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] })
    slice.removeQueued(1)
    expect(get().queuedPrompts).toEqual([{ text: 'a' }, { text: 'c' }])
  })
})

describe('addSystemNotice', () => {
  it('appends a synthetic assistant notice to messages', () => {
    const { get, slice } = setup({ activeSessionID: 's1' })
    slice.addSystemNotice('hello there')
    expect(get().messages).toHaveLength(1)
    expect(get().messages[0].parts[0]).toMatchObject({ type: 'text', text: 'hello there' })
  })
})

describe('abort', () => {
  it('no-ops without a directory', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { slice } = setup({ directory: null, activeSessionID: 's1' })
    await slice.abort()
    expect(mockClearActiveAttempt).not.toHaveBeenCalled()
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('no-ops without an active session', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { slice } = setup({ directory: '/proj', activeSessionID: null })
    await slice.abort()
    expect(mockClearActiveAttempt).not.toHaveBeenCalled()
  })

  it('clears the active attempt, aborts on the server, and drops busy', async () => {
    const abortFn = vi.fn(async () => {})
    mockApi.mockReturnValue(fakeApi({ abort: abortFn }))
    const { get, slice } = setup({ directory: '/proj', activeSessionID: 's1', busy: true })

    await slice.abort()

    expect(mockClearActiveAttempt).toHaveBeenCalledWith('s1')
    expect(abortFn).toHaveBeenCalledWith('/proj', 's1')
    expect(get().busy).toBe(false)
  })

  it('aborting mid-stream: a server-side abort failure still drops busy and surfaces the error', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        abort: vi.fn(async () => {
          throw new Error('stream already closed')
        })
      })
    )
    const { get, slice } = setup({ directory: '/proj', activeSessionID: 's1', busy: true })

    await slice.abort()

    expect(get().busy).toBe(false)
    expect(get().error).toBe('stream already closed')
    // clearActiveAttempt still ran before the failing call.
    expect(mockClearActiveAttempt).toHaveBeenCalledWith('s1')
  })
})

describe('retryExchange', () => {
  it('no-ops when a prerequisite (directory/session/model) is missing', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { slice } = setup({ directory: null, activeSessionID: 's1', providerID: 'google', modelID: 'gemini-3.6-flash' })
    await slice.retryExchange('a1')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('no-ops when the target message is not found', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      messages: [userMessage('u1', 's1', 'hi')]
    })
    await slice.retryExchange('does-not-exist')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('no-ops when there is no preceding user message to resend', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      messages: [assistantMessage('a1', 's1')]
    })
    await slice.retryExchange('a1')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('resends the nearest preceding user text and marks busy', async () => {
    const promptFn = vi.fn(async () => {})
    mockApi.mockReturnValue(fakeApi({ prompt: promptFn }))
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      messages: [userMessage('u1', 's1', 'do the thing'), assistantMessage('a1', 's1')]
    })

    await slice.retryExchange('a1')

    expect(promptFn).toHaveBeenCalledWith({
      directory: '/proj',
      sessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      text: 'do the thing'
    })
    expect(get().busy).toBe(true)
    expect(get().error).toBeNull()
  })

  it('surfaces a prompt failure and drops busy', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        prompt: vi.fn(async () => {
          throw new Error('server down')
        })
      })
    )
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      messages: [userMessage('u1', 's1', 'do the thing'), assistantMessage('a1', 's1')]
    })

    await slice.retryExchange('a1')

    expect(get().busy).toBe(false)
    expect(get().error).toBe('server down')
  })
})

describe('editAndResend', () => {
  it('no-ops without a directory or active session', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { slice } = setup({ directory: null, activeSessionID: null })
    await slice.editAndResend('u1', 'new text')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('no-ops on empty/whitespace text', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { slice } = setup({ directory: '/proj', activeSessionID: 's1', messages: [userMessage('u1', 's1', 'old')] })
    await slice.editAndResend('u1', '   ')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('no-ops when the target message is not a user message', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { slice } = setup({ directory: '/proj', activeSessionID: 's1', messages: [assistantMessage('a1', 's1')] })
    await slice.editAndResend('a1', 'new text')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('reverts on the server, drops the edited message and everything after it, then resends', async () => {
    const revertFn = vi.fn(async () => {})
    const promptFn = vi.fn(async () => {})
    mockApi.mockReturnValue(fakeApi({ revertMessage: revertFn, prompt: promptFn }))
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      linkedProviderIDs: ['google'],
      messages: [userMessage('u1', 's1', 'old text'), assistantMessage('a1', 's1')]
    })

    await slice.editAndResend('u1', 'new text')

    expect(revertFn).toHaveBeenCalledWith({ directory: '/proj', sessionID: 's1', messageID: 'u1' })
    // send() re-appended nothing synchronously visible here beyond the prompt dispatch —
    // what matters is the stale assistant turn was dropped before resending.
    expect(promptFn).toHaveBeenCalledWith(
      expect.objectContaining({ directory: '/proj', sessionID: 's1', text: 'new text' })
    )
    expect(get().messages.some((m) => m.info.id === 'a1')).toBe(false)
  })

  it('surfaces a revert failure without calling send', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        revertMessage: vi.fn(async () => {
          throw new Error('revert rejected')
        })
      })
    )
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      messages: [userMessage('u1', 's1', 'old text')]
    })

    await slice.editAndResend('u1', 'new text')

    expect(get().error).toBe('revert rejected')
  })
})

describe('executeSlashCommand', () => {
  it('requires a directory first', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({ directory: null })
    await slice.executeSlashCommand('/help')
    expect(get().error).toBe('Pick a project folder first.')
  })

  it('creates a session on the fly when none is active yet', async () => {
    mockApi.mockReturnValue(fakeApi({ sessions: { create: vi.fn(async () => session('fresh')) } as unknown as Partial<OpencodeApi['sessions']> }))
    const { get, slice } = setup({ directory: '/proj', activeSessionID: null })

    await slice.executeSlashCommand('/help')

    expect(get().activeSessionID).toBe('fresh')
  })

  it('/help posts the command list as a system notice', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({ directory: '/proj', activeSessionID: 's1' })
    await slice.executeSlashCommand('/help')
    // Two messages land: the echoed "/help" user turn and the notice reply. Both share the
    // same synthetic `created` second, so sort order between them isn't guaranteed — find by
    // content rather than assuming the notice is last.
    const notice = findNotice(get, 'Slash Commands')
    expect(notice).toBeDefined()
  })

  it('/clear wipes the local transcript and leaves only the confirmation notice', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      messages: [userMessage('u1', 's1', 'earlier message')]
    })

    await slice.executeSlashCommand('/clear')

    expect(get().messages).toHaveLength(1)
    expect(textContent(get().messages[0]?.parts[0])).toContain('Cleared local view')
  })

  it('/models summarizes providers and the active model', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      providers: [agentProvider('google', 'gemini-3.6-flash')]
    })

    await slice.executeSlashCommand('/models')

    expect(findNotice(get, 'google/gemini-3.6-flash')).toBeDefined()
  })

  it('/free toggles routing mode and reports the new state', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({ directory: '/proj', activeSessionID: 's1', routingMode: 'locked' })

    await slice.executeSlashCommand('/free')

    expect(get().routingMode).toBe('failover')
    expect(findNotice(get, 'ENABLED')).toBeDefined()
  })

  it('/doctor reports server, directory, and model diagnostics', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      server: { running: true, url: 'http://localhost:1', streamConnected: true },
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      providers: []
    })

    await slice.executeSlashCommand('/doctor')

    const notice = findNotice(get, 'System Diagnostics')
    expect(notice).toBeDefined()
    expect(textContent(notice?.parts[0])).toContain('Running')
  })

  it('reports unknown commands instead of silently dropping them', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({ directory: '/proj', activeSessionID: 's1' })

    await slice.executeSlashCommand('/not-a-real-command')

    expect(findNotice(get, 'Unknown slash command')).toBeDefined()
  })
})

describe('send', () => {
  it('ignores empty/whitespace input', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({ directory: '/proj' })
    await slice.send('   ')
    expect(mockApi).not.toHaveBeenCalled()
    expect(get().busy).toBe(false)
  })

  it('routes slash-prefixed text to executeSlashCommand instead of prompting', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({ directory: '/proj', activeSessionID: 's1' })
    await slice.send('/help')
    expect(findNotice(get, 'Slash Commands')).toBeDefined()
  })

  it('requires a directory first', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({ directory: null })
    await slice.send('hello')
    expect(get().error).toBe('Pick a project folder first.')
  })

  it('requires a model to be chosen', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({ directory: '/proj', providerID: null, modelID: null })
    await slice.send('hello')
    expect(get().error).toBe('Choose a model before sending a message.')
  })

  it('refuses to route to a provider without a linked API key', async () => {
    mockApi.mockReturnValue(fakeApi())
    const { get, slice } = setup({
      directory: '/proj',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      linkedProviderIDs: []
    })
    await slice.send('hello')
    expect(get().error).toContain('Add an API key for google')
  })

  it('creates a session on the fly when none is active, then prompts', async () => {
    const promptFn = vi.fn(async () => {})
    mockApi.mockReturnValue(fakeApi({ sessions: { create: vi.fn(async () => session('fresh')) } as unknown as Partial<OpencodeApi['sessions']>, prompt: promptFn }))
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: null,
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      linkedProviderIDs: ['google']
    })

    await slice.send('hello')

    expect(get().activeSessionID).toBe('fresh')
    expect(promptFn).toHaveBeenCalledWith(
      expect.objectContaining({ directory: '/proj', sessionID: 'fresh', providerID: 'google', modelID: 'gemini-3.6-flash', text: 'hello' })
    )
  })

  it('happy path: arms the attempt machine and dispatches the prompt', async () => {
    const promptFn = vi.fn(async () => {})
    mockApi.mockReturnValue(fakeApi({ prompt: promptFn }))
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      linkedProviderIDs: ['google']
    })

    await slice.send('hello', [{ type: 'text', text: 'hello' }])

    expect(get().busy).toBe(true)
    expect(get().error).toBeNull()
    expect(mockSetLastPrompt).toHaveBeenCalledWith({
      text: 'hello',
      parts: [{ type: 'text', text: 'hello' }],
      sessionID: 's1',
      userMessageID: null
    })
    expect(mockStartActiveAttempt).toHaveBeenCalledWith('s1', 'google', 'gemini-3.6-flash')
    // saveLedger's real debounce is mocked out (see the '../routing' mock above) so this test
    // stays timer-free, but the slice must still be reserving/persisting the attempt.
    expect(mockSaveLedger).toHaveBeenCalled()
    expect(promptFn).toHaveBeenCalledWith({
      directory: '/proj',
      sessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      text: 'hello',
      parts: [{ type: 'text', text: 'hello' }]
    })
  })

  it('error path: a client (non-retryable) error surfaces immediately, no failover attempted', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        prompt: vi.fn(async () => {
          throw new Error('Bad request')
        })
      })
    )
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      linkedProviderIDs: ['google']
    })

    await slice.send('hello')

    expect(mockClearActiveAttempt).toHaveBeenCalledWith('s1')
    expect(mockBeginFailover).not.toHaveBeenCalled()
    expect(get().busy).toBe(false)
    expect(get().error).toBe('Bad request')
  })

  it('error path: a locked routing mode never engages failover, even for a retryable error', async () => {
    mockApi.mockReturnValue(
      fakeApi({
        prompt: vi.fn(async () => {
          throw new Error('429 Too Many Requests')
        })
      })
    )
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      linkedProviderIDs: ['google'],
      routingMode: 'locked'
    })

    await slice.send('hello')

    expect(mockBeginFailover).not.toHaveBeenCalled()
    expect(get().busy).toBe(false)
    expect(get().error).toBe('429 Too Many Requests')
  })

  it('error path: side effects already committed (R1) blocks failover even for a retryable error', async () => {
    mockGetActiveAttempt.mockReturnValueOnce({ toolExecuted: true, hasStreamed: false } as unknown as NonNullable<ReturnType<typeof getActiveAttempt>>)
    mockApi.mockReturnValue(
      fakeApi({
        prompt: vi.fn(async () => {
          throw new Error('timeout waiting for response')
        })
      })
    )
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      linkedProviderIDs: ['google']
    })

    await slice.send('hello')

    expect(mockBeginFailover).not.toHaveBeenCalled()
    expect(get().error).toBe('timeout waiting for response')
  })

  it('error path: a retryable, side-effect-free error engages failover and stays busy while it retries', async () => {
    mockBeginFailover.mockResolvedValueOnce(true)
    mockApi.mockReturnValue(
      fakeApi({
        prompt: vi.fn(async () => {
          throw new Error('Rate limit exceeded')
        })
      })
    )
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      linkedProviderIDs: ['google']
    })

    await slice.send('hello')

    expect(mockBeginFailover).toHaveBeenCalledWith(
      's1',
      '/proj',
      'hello',
      undefined,
      'Rate limit / error on google/gemini-3.6-flash',
      'google/gemini-3.6-flash',
      undefined
    )
    // beginFailover took over — send() must not have also set its own error/busy:false.
    expect(get().busy).toBe(true)
    expect(get().error).toBeNull()
  })

  it('error path: falls through to the error banner when failover reports no other model was available', async () => {
    mockBeginFailover.mockResolvedValueOnce(false)
    mockApi.mockReturnValue(
      fakeApi({
        prompt: vi.fn(async () => {
          throw new Error('Rate limit exceeded')
        })
      })
    )
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      providerID: 'google',
      modelID: 'gemini-3.6-flash',
      linkedProviderIDs: ['google']
    })

    await slice.send('hello')

    expect(get().busy).toBe(false)
    expect(get().error).toBe('Rate limit exceeded')
  })

  it('auto-mode proactively swaps to a healthier free model before sending', async () => {
    const promptFn = vi.fn(async () => {})
    mockApi.mockReturnValue(fakeApi({ prompt: promptFn }))
    const { get, slice } = setup({
      directory: '/proj',
      activeSessionID: 's1',
      routingMode: 'auto',
      providerID: null,
      modelID: null,
      linkedProviderIDs: ['google'],
      providers: [agentProvider('google', 'gemini-3.6-flash')]
    })

    await slice.send('hello')

    expect(get().providerID).toBe('google')
    expect(get().modelID).toBe('gemini-3.6-flash')
    const notices = get().messages.filter((m) => textContent(m.parts[0])?.includes('Auto-mode'))
    expect(notices).toHaveLength(1)
    expect(promptFn).toHaveBeenCalledWith(
      expect.objectContaining({ providerID: 'google', modelID: 'gemini-3.6-flash' })
    )
  })
})
