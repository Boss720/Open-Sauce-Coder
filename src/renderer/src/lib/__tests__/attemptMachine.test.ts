import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState } from '../slices/types'
import { LEDGER_STORAGE_KEY, type Ledger } from '../routing'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { registerStore, type StoreHandle } from '../slices/storeRef'
import {
  armStallWatchdog,
  beginFailover,
  clearActiveAttempt,
  getAbortForRecoverySessionID,
  getActiveAttempt,
  getLastPrompt,
  getLastSendStartTime,
  getLedger,
  getRotateRetries,
  markPermissionAsked,
  markPermissionReplied,
  markToolCompleted,
  markToolStarted,
  parseRetryAfterMs,
  recoverHungAttempt,
  resetRotateRetries,
  restoreLedger,
  setAbortForRecoverySessionID,
  setAttemptFailure,
  setLastPrompt,
  setLastSendStartTime,
  setLedger,
  startActiveAttempt,
  touchActiveAttempt
} from '../slices/attemptMachine'

const mockApi = vi.mocked(api)

function fakeApi(overrides: Partial<OpencodeApi> = {}): OpencodeApi {
  return {
    revertMessage: vi.fn(async () => {}),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    ...overrides
  } as unknown as OpencodeApi
}

/**
 * A minimal stand-in for the fields attemptMachine actually reads off the store:
 * busy/activeSessionID/routingMode/directory (recoverHungAttempt's guards),
 * appSettings.ttftMs/stallMs (the watchdog durations), and the two callbacks
 * (addSystemNotice, rotateToNextFreeModel) it invokes on the way to a retry.
 */
type FakeState = {
  busy: boolean
  error: string | null
  activeSessionID: string | null
  routingMode: 'locked' | 'failover' | 'auto'
  directory: string | null
  appSettings: { ttftMs: number; stallMs: number }
  addSystemNotice: ReturnType<typeof vi.fn>
  rotateToNextFreeModel: ReturnType<typeof vi.fn>
}

function createHandle(overrides: Partial<FakeState> = {}): { handle: StoreHandle; getFake: () => FakeState } {
  let state: FakeState = {
    busy: true,
    error: null,
    activeSessionID: 'sess-1',
    routingMode: 'failover',
    directory: '/proj',
    appSettings: { ttftMs: 20_000, stallMs: 90_000 },
    addSystemNotice: vi.fn(),
    rotateToNextFreeModel: vi.fn(() => ({
      providerID: 'groq',
      modelID: 'llama-3.3-70b-versatile',
      providerName: 'Groq',
      modelName: 'Llama 3.3 70B'
    })),
    ...overrides
  }
  const handle: StoreHandle = {
    getState: () => state as unknown as AppState,
    setState: (partial) => {
      state = { ...state, ...(partial as unknown as Partial<FakeState>) }
    }
  }
  return { handle, getFake: () => state }
}

/** Starts a fresh attempt and returns the live singleton object. */
function attempt(sessionID = 'sess-1', providerID = 'google', modelID = 'gemini-3.6-flash') {
  startActiveAttempt(sessionID, providerID, modelID)
  return getActiveAttempt()!
}

function setLastPromptFor(sessionID = 'sess-1', userMessageID: string | null = 'usr-1') {
  setLastPrompt({ text: 'hello there', parts: undefined, sessionID, userMessageID })
}

beforeEach(() => {
  mockApi.mockReset()
  vi.useFakeTimers()
})

afterEach(() => {
  // These are all module-level singletons — drain them so one test's attempt/ledger
  // state can never bleed into the next.
  clearActiveAttempt()
  setLastPrompt(null)
  resetRotateRetries()
  setLedger({})
  setLastSendStartTime(null)
  setAbortForRecoverySessionID(null)
  vi.useRealTimers()
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
})

describe('singleton accessors', () => {
  it('round-trips lastPrompt', () => {
    expect(getLastPrompt()).toBeNull()
    setLastPrompt({ text: 'hi', sessionID: 'sess-1', userMessageID: 'usr-1' })
    expect(getLastPrompt()).toEqual({ text: 'hi', sessionID: 'sess-1', userMessageID: 'usr-1' })
  })

  it('round-trips the ledger', () => {
    expect(getLedger()).toEqual({})
    const next: Ledger = {
      'google/gemini-3.6-flash': { cooldownUntil: 0, cooldownMs: 30000, success: 1, error: 0, last429: null, latencyEwma: null, sends: [] }
    }
    setLedger(next)
    expect(getLedger()).toBe(next)
  })

  it('round-trips lastSendStartTime', () => {
    expect(getLastSendStartTime()).toBeNull()
    setLastSendStartTime(1234)
    expect(getLastSendStartTime()).toBe(1234)
  })

  it('round-trips abortForRecoverySessionID', () => {
    expect(getAbortForRecoverySessionID()).toBeNull()
    setAbortForRecoverySessionID('sess-9')
    expect(getAbortForRecoverySessionID()).toBe('sess-9')
  })

  it('resetRotateRetries brings the counter back to zero', () => {
    expect(getRotateRetries()).toBe(0)
    resetRotateRetries()
    expect(getRotateRetries()).toBe(0)
  })
})

describe('restoreLedger', () => {
  it('loads a persisted ledger from localStorage', () => {
    const persisted: Ledger = {
      'google/gemini-3.6-flash': { cooldownUntil: 0, cooldownMs: 30000, success: 3, error: 1, last429: null, latencyEwma: 400, sends: [Date.now()] }
    }
    const backing: Record<string, string> = { [LEDGER_STORAGE_KEY]: JSON.stringify(persisted) }
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => backing[k] ?? null,
      setItem: (k: string, v: string) => {
        backing[k] = v
      },
      removeItem: (k: string) => {
        delete backing[k]
      },
      clear: () => {
        for (const k of Object.keys(backing)) delete backing[k]
      },
      key: () => null,
      length: 0
    } as unknown as Storage

    restoreLedger()

    expect(getLedger()['google/gemini-3.6-flash']).toMatchObject({ success: 3, error: 1 })
  })

  it('falls back to an empty ledger when localStorage is unavailable', () => {
    restoreLedger()
    expect(getLedger()).toEqual({})
  })
})

describe('startActiveAttempt / clearActiveAttempt', () => {
  it('creates a fresh attempt and arms the TTFT watchdog', () => {
    registerStore(createHandle().handle)
    const a = attempt()
    expect(a.sessionID).toBe('sess-1')
    expect(a.providerID).toBe('google')
    expect(a.modelID).toBe('gemini-3.6-flash')
    expect(a.hasStreamed).toBe(false)
    expect(a.toolExecuted).toBe(false)
    expect(a.ttftTimer).not.toBeNull()
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })

  it('increments attemptId on each successive start', () => {
    registerStore(createHandle().handle)
    const first = attempt()
    const second = attempt()
    expect(second.attemptId).toBe(first.attemptId + 1)
  })

  it('carries the userMessageID over from the pending lastPrompt', () => {
    registerStore(createHandle().handle)
    setLastPromptFor('sess-1', 'usr-42')
    const a = attempt()
    expect(a.userMessageID).toBe('usr-42')
  })

  it('clearActiveAttempt tears down the timers and the singleton', () => {
    registerStore(createHandle().handle)
    attempt()
    expect(getActiveAttempt()).not.toBeNull()
    clearActiveAttempt()
    expect(getActiveAttempt()).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clearActiveAttempt for a mismatched sessionID is a no-op', () => {
    registerStore(createHandle().handle)
    attempt('sess-1')
    clearActiveAttempt('sess-other')
    expect(getActiveAttempt()).not.toBeNull()
  })

  it('clearActiveAttempt with nothing in flight does not throw', () => {
    expect(() => clearActiveAttempt('sess-1')).not.toThrow()
  })
})

describe('touchActiveAttempt', () => {
  it('clears the TTFT timer, flags hasStreamed, and arms the stall timer', () => {
    registerStore(createHandle().handle)
    attempt()
    touchActiveAttempt('sess-1')
    const a = getActiveAttempt()!
    expect(a.hasStreamed).toBe(true)
    expect(a.ttftTimer).toBeNull()
    expect(a.stallTimer).not.toBeNull()
  })

  it('ignores a touch reported for a different session', () => {
    registerStore(createHandle().handle)
    attempt()
    touchActiveAttempt('sess-other')
    expect(getActiveAttempt()!.hasStreamed).toBe(false)
  })
})

describe('armStallWatchdog', () => {
  it('does nothing without an active attempt', () => {
    expect(() => armStallWatchdog()).not.toThrow()
  })

  it('refuses to arm while paused for a tool or a permission prompt', () => {
    registerStore(createHandle().handle)
    attempt()
    markToolStarted('sess-1')
    armStallWatchdog()
    expect(getActiveAttempt()!.stallTimer).toBeNull()
  })
})

describe('tool / permission pause-resume', () => {
  it('markToolStarted pauses the stall timer and flags toolExecuted', () => {
    registerStore(createHandle().handle)
    attempt()
    touchActiveAttempt('sess-1')
    markToolStarted('sess-1')
    const a = getActiveAttempt()!
    expect(a.toolExecuted).toBe(true)
    expect(a.pausedForTool).toBe(true)
    expect(a.stallTimer).toBeNull()
  })

  it('markToolCompleted resumes the stall timer', () => {
    registerStore(createHandle().handle)
    attempt()
    touchActiveAttempt('sess-1')
    markToolStarted('sess-1')
    markToolCompleted('sess-1')
    const a = getActiveAttempt()!
    expect(a.pausedForTool).toBe(false)
    expect(a.stallTimer).not.toBeNull()
  })

  it('markPermissionAsked pauses and markPermissionReplied resumes', () => {
    registerStore(createHandle().handle)
    attempt()
    touchActiveAttempt('sess-1')
    markPermissionAsked('sess-1')
    expect(getActiveAttempt()!.pausedForPermission).toBe(true)
    expect(getActiveAttempt()!.stallTimer).toBeNull()
    markPermissionReplied('sess-1')
    expect(getActiveAttempt()!.pausedForPermission).toBe(false)
    expect(getActiveAttempt()!.stallTimer).not.toBeNull()
  })

  it('mark* calls scoped to a foreign session are ignored', () => {
    registerStore(createHandle().handle)
    attempt()
    markToolStarted('sess-other')
    expect(getActiveAttempt()!.toolExecuted).toBe(false)
  })
})

describe('parseRetryAfterMs', () => {
  it('returns undefined with no headers at all', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined()
    expect(parseRetryAfterMs(null)).toBeUndefined()
    expect(parseRetryAfterMs({})).toBeUndefined()
  })

  it('parses a numeric retry-after as seconds', () => {
    expect(parseRetryAfterMs({ 'retry-after': '30' })).toBe(30_000)
  })

  it('is case-insensitive on the header name', () => {
    expect(parseRetryAfterMs({ 'RETRY-AFTER': '5' })).toBe(5_000)
  })

  it('parses an HTTP-date retry-after relative to now', () => {
    const future = new Date(Date.now() + 5_000).toUTCString()
    const ms = parseRetryAfterMs({ 'retry-after': future })
    expect(ms).toBeGreaterThan(0)
    expect(ms).toBeLessThanOrEqual(5_000)
  })

  it('falls through to x-ratelimit-reset when retry-after is unparseable', () => {
    expect(parseRetryAfterMs({ 'retry-after': 'not-a-number-or-date', 'x-ratelimit-reset': '15' })).toBe(15_000)
  })

  it('treats a small x-ratelimit-reset as a duration in seconds', () => {
    expect(parseRetryAfterMs({ 'x-ratelimit-reset': '60' })).toBe(60_000)
  })

  it('treats a large x-ratelimit-reset as an epoch-ms timestamp', () => {
    const now = Date.now()
    const future = now + 10_000
    expect(parseRetryAfterMs({ 'x-ratelimit-reset': String(future) })).toBe(10_000)
  })

  it('accepts x-ratelimit-reset-after as a fallback header', () => {
    expect(parseRetryAfterMs({ 'x-ratelimit-reset-after': '20' })).toBe(20_000)
  })
})

describe('beginFailover', () => {
  it('single-entry (R3): a second call while a failover is already in flight is a no-op that reports success', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi())
    attempt()
    getActiveAttempt()!.failoverInFlight = true

    const result = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom')

    expect(result).toBe(true)
    expect(getFake().rotateToNextFreeModel).not.toHaveBeenCalled()
  })

  it('per-exchange retry cap (R2): gives up once 3 rotations have happened', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi())
    attempt()
    setLastPromptFor()

    for (let i = 0; i < 3; i++) {
      const ok = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom', 'google/gemini-3.6-flash')
      expect(ok).toBe(true)
    }
    expect(getRotateRetries()).toBe(3)

    const capped = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom', 'google/gemini-3.6-flash')

    expect(capped).toBe(false)
    expect(getFake().addSystemNotice).toHaveBeenCalledWith(expect.stringContaining('Retry cap reached (3/3)'))
  })

  it('refuses without a lastPrompt recorded for this session', async () => {
    registerStore(createHandle().handle)
    attempt()
    const result = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom')
    expect(result).toBe(false)
  })

  it('refuses when the recorded lastPrompt belongs to a different session', async () => {
    registerStore(createHandle().handle)
    attempt()
    setLastPromptFor('sess-other')
    const result = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom')
    expect(result).toBe(false)
  })

  it('refuses when lastPrompt has no userMessageID to revert to', async () => {
    registerStore(createHandle().handle)
    attempt()
    setLastPromptFor('sess-1', null)
    const result = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom')
    expect(result).toBe(false)
  })

  it('R1 guard: refuses once a tool has executed and notifies the user', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    attempt()
    setLastPromptFor()
    getActiveAttempt()!.toolExecuted = true

    const result = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom')

    expect(result).toBe(false)
    expect(getFake().addSystemNotice).toHaveBeenCalledWith(expect.stringContaining('side effects already committed'))
  })

  it('R1 guard: refuses once tokens have streamed', async () => {
    registerStore(createHandle().handle)
    attempt()
    setLastPromptFor()
    getActiveAttempt()!.hasStreamed = true

    const result = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom')
    expect(result).toBe(false)
  })

  it('refuses when no other free model is available to rotate to', async () => {
    registerStore(createHandle({ rotateToNextFreeModel: vi.fn(() => null) }).handle)
    attempt()
    setLastPromptFor()

    const result = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom')
    expect(result).toBe(false)
  })

  it('aborts the retry when the server-side revert fails, before rotating for real', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi({ revertMessage: vi.fn(async () => {
      throw new Error('revert rejected')
    }) }))
    attempt()
    setLastPromptFor()

    const result = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom')

    expect(result).toBe(false)
    expect(getFake().addSystemNotice).toHaveBeenCalledWith(expect.stringContaining('could not revert'))
  })

  it('rotates model, reverts on the server, re-prompts, and reports success', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    const promptFn = vi.fn(async () => {})
    const revertFn = vi.fn(async () => {})
    mockApi.mockReturnValue(fakeApi({ prompt: promptFn, revertMessage: revertFn }))
    attempt()
    setLastPromptFor()

    const result = await beginFailover('sess-1', '/proj', 'hello there', undefined, 'boom', 'google/gemini-3.6-flash')

    expect(result).toBe(true)
    expect(revertFn).toHaveBeenCalledWith({ directory: '/proj', sessionID: 'sess-1', messageID: 'usr-1' })
    expect(promptFn).toHaveBeenCalledWith({
      directory: '/proj',
      sessionID: 'sess-1',
      providerID: 'groq',
      modelID: 'llama-3.3-70b-versatile',
      text: 'hello there',
      parts: undefined
    })
    expect(getRotateRetries()).toBe(1)
    expect(getActiveAttempt()?.providerID).toBe('groq')
    expect(getFake().addSystemNotice).toHaveBeenCalledWith(expect.stringContaining('Failover'))
  })

  it('still reports the retry as dispatched (true) when the follow-up prompt itself fails', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi({ prompt: vi.fn(async () => {
      throw new Error('dispatch failed')
    }) }))
    attempt()
    setLastPromptFor()

    const result = await beginFailover('sess-1', '/proj', 'hello', undefined, 'boom')

    expect(result).toBe(true)
    expect(getActiveAttempt()).toBeNull()
    expect(getFake().busy).toBe(false)
    expect(getFake().error).toBe('dispatch failed')
  })

  it('preserves immutable policy snapshot (agent and tools) on failover re-prompt', async () => {
    const { handle } = createHandle()
    registerStore(handle)
    const promptFn = vi.fn(async () => {})
    const revertFn = vi.fn(async () => {})
    mockApi.mockReturnValue(fakeApi({ prompt: promptFn, revertMessage: revertFn }))
    attempt()
    const policy = { agent: 'reviewer', tools: { fs_write: false, fs_read: true } }
    setLastPrompt({ text: 'hello there', parts: undefined, sessionID: 'sess-1', userMessageID: 'usr-1', policy })

    const result = await beginFailover('sess-1', '/proj', 'hello there', undefined, 'boom', 'google/gemini-3.6-flash', undefined, policy)

    expect(result).toBe(true)
    expect(promptFn).toHaveBeenCalledWith({
      directory: '/proj',
      sessionID: 'sess-1',
      providerID: 'groq',
      modelID: 'llama-3.3-70b-versatile',
      text: 'hello there',
      parts: undefined,
      agent: 'reviewer',
      tools: { fs_write: false, fs_read: true }
    })
  })
})

describe('recoverHungAttempt', () => {
  it('ignores a stale attempt that has since been superseded', async () => {
    registerStore(createHandle().handle)
    const stale = attempt()
    clearActiveAttempt()
    attempt() // a new attempt object is now active
    await recoverHungAttempt(stale, 'ttft')
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('does nothing when the store reports not busy', async () => {
    registerStore(createHandle({ busy: false }).handle)
    const a = attempt()
    await recoverHungAttempt(a, 'ttft')
    expect(getActiveAttempt()).not.toBeNull()
  })

  it('does nothing when the active session in the store no longer matches', async () => {
    registerStore(createHandle({ activeSessionID: 'sess-other' }).handle)
    const a = attempt()
    await recoverHungAttempt(a, 'ttft')
    expect(getActiveAttempt()).not.toBeNull()
  })

  it('never swaps the model when routing is locked', async () => {
    const { handle, getFake } = createHandle({ routingMode: 'locked' })
    registerStore(handle)
    const a = attempt()

    await recoverHungAttempt(a, 'stall')

    expect(getActiveAttempt()).not.toBeNull()
    expect(getFake().rotateToNextFreeModel).not.toHaveBeenCalled()
    expect(mockApi).not.toHaveBeenCalled()
  })

  it('does nothing without a project directory', async () => {
    registerStore(createHandle({ directory: null }).handle)
    const a = attempt()
    await recoverHungAttempt(a, 'ttft')
    expect(getActiveAttempt()).not.toBeNull()
  })

  it('R1: fails immediately with a TTFT-specific message once a tool has already executed', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    const a = attempt()
    a.toolExecuted = true

    await recoverHungAttempt(a, 'ttft')

    expect(getActiveAttempt()).toBeNull()
    expect(mockApi).not.toHaveBeenCalled()
    expect(getFake().error).toMatch(/stopped responding before first token/)
  })

  it('R1: fails immediately with a stall-specific message once tokens have streamed', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    const a = attempt()
    a.hasStreamed = true

    await recoverHungAttempt(a, 'stall')

    expect(getFake().error).toMatch(/went quiet mid-response/)
  })

  it('aborts on the server, records a ledger timeout, and fails over to another model', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    const abortFn = vi.fn(async () => {})
    const revertFn = vi.fn(async () => {})
    const promptFn = vi.fn(async () => {})
    mockApi.mockReturnValue(fakeApi({ abort: abortFn, revertMessage: revertFn, prompt: promptFn }))
    setLastPromptFor()
    const a = attempt()

    await recoverHungAttempt(a, 'ttft')

    expect(abortFn).toHaveBeenCalledWith('/proj', 'sess-1')
    expect(getLedger()['google/gemini-3.6-flash'].error).toBe(1)
    expect(promptFn).toHaveBeenCalled()
    expect(getFake().addSystemNotice).toHaveBeenCalledWith(expect.stringContaining('No response after 20s'))
  })

  it('surfaces a failure when the recovery abort itself cannot complete', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi({ abort: vi.fn(async () => {
      throw new Error('abort rejected')
    }) }))
    setLastPromptFor()
    const a = attempt()

    await recoverHungAttempt(a, 'stall')

    expect(getActiveAttempt()).toBeNull()
    expect(getFake().error).toMatch(/could not be safely aborted/)
    expect(getAbortForRecoverySessionID()).toBeNull()
  })

  it('surfaces "no other free model" when failover has nothing left to try', async () => {
    const { handle, getFake } = createHandle({ rotateToNextFreeModel: vi.fn(() => null) })
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi())
    setLastPromptFor()
    const a = attempt()

    await recoverHungAttempt(a, 'ttft')

    expect(getFake().error).toMatch(/No other free model available/)
  })

  it('surfaces a timeout failure when there is no prompt left to retry', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi())
    const a = attempt()
    // lastPrompt intentionally left unset for this test.

    await recoverHungAttempt(a, 'ttft')

    expect(getFake().error).toBe('Model request timed out before it could be retried.')
  })
})

describe('setAttemptFailure', () => {
  it('clears the active attempt, resets lastSendStartTime, and reports the error to the store', () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    attempt()
    setLastSendStartTime(999)

    setAttemptFailure('boom')

    expect(getActiveAttempt()).toBeNull()
    expect(getLastSendStartTime()).toBeNull()
    expect(getFake().busy).toBe(false)
    expect(getFake().error).toBe('boom')
  })
})

describe('watchdog timers firing for real', () => {
  it('the TTFT watchdog elapses and drives an actual failover', async () => {
    const { handle, getFake } = createHandle()
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi())
    setLastPromptFor()
    attempt() // arms a 20_000ms TTFT timer

    await vi.advanceTimersByTimeAsync(20_000)

    expect(getFake().addSystemNotice).toHaveBeenCalledWith(expect.stringContaining('Failover'))
  })

  it('the stall watchdog elapses after tokens stop arriving — but R1 blocks auto-retry once streaming has started', async () => {
    // touchActiveAttempt (real token arrival) is the only way the stall watchdog gets armed,
    // and it always sets hasStreamed. So a stall firing can never itself dispatch a silent
    // retry — it must surface a failure instead, per the R1 guard in beginFailover.
    const { handle, getFake } = createHandle()
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi())
    setLastPromptFor()
    attempt()
    touchActiveAttempt('sess-1') // switches from the 20s TTFT timer to the 90s stall timer

    await vi.advanceTimersByTimeAsync(90_000)

    expect(getActiveAttempt()).toBeNull()
    expect(getFake().error).toMatch(/went quiet mid-response/)
  })

  it('a locked routing mode never fires a model swap, even once the watchdog elapses', async () => {
    const { handle, getFake } = createHandle({ routingMode: 'locked' })
    registerStore(handle)
    mockApi.mockReturnValue(fakeApi())
    attempt()

    await vi.advanceTimersByTimeAsync(20_000)

    expect(getFake().rotateToNextFreeModel).not.toHaveBeenCalled()
    expect(mockApi).not.toHaveBeenCalled()
    expect(getActiveAttempt()).not.toBeNull()
  })
})
