import { describe, expect, it } from 'vitest'
import {
  attemptReducer,
  INITIAL_ATTEMPT_STATE,
  isFailedOver,
  canAutoRetry,
  type AttemptState,
  type AttemptEvent,
  type Effect,
} from '../attempts'

function dispatch(state: AttemptState, ...events: AttemptEvent[]): { state: AttemptState; allEffects: Effect[] } {
  let current = state
  const allEffects: Effect[] = []
  for (const e of events) {
    const result = attemptReducer(current, e)
    current = result.state
    allEffects.push(...result.effects)
  }
  return { state: current, allEffects }
}

const T0 = 1700000000000

function sendEvent(overrides?: Partial<AttemptEvent & { type: 'send' }>): AttemptEvent {
  return {
    type: 'send',
    messageID: 'msg-1',
    sessionID: 'sess-1',
    providerID: 'google',
    modelID: 'gemini-3.6-flash',
    now: T0,
    ...overrides,
  } as AttemptEvent
}

describe('attempts reducer', () => {
  describe('send', () => {
    it('initializes attempt and arms TTFT watchdog', () => {
      const { state, allEffects } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())

      expect(state.attemptId).toBe(1)
      expect(state.sessionID).toBe('sess-1')
      expect(state.messageID).toBe('msg-1')
      expect(state.chosenProviderID).toBe('google')
      expect(state.chosenModelID).toBe('gemini-3.6-flash')
      expect(state.effectiveProviderID).toBe('google')
      expect(state.effectiveModelID).toBe('gemini-3.6-flash')
      expect(state.watchdog).toBe('ttft')
      expect(state.retries).toBe(0)
      expect(state.toolExecuted).toBe(false)
      expect(state.hasStreamed).toBe(false)

      expect(allEffects).toContainEqual({ kind: 'arm_ttft', attemptId: 1, ms: 20_000 })
    })

    it('increments attemptId on each send', () => {
      const { state: s1 } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      expect(s1.attemptId).toBe(1)
      const { state: s2 } = dispatch(s1, { type: 'idle', sessionID: 'sess-1', now: T0 + 1000 }, sendEvent({ now: T0 + 2000 }))
      expect(s2.attemptId).toBe(2)
    })

    it('resets retries and history on fresh send', () => {
      let s = INITIAL_ATTEMPT_STATE
      s = { ...s, retries: 2, history: [{ fromProvider: 'a', fromModel: 'b', toProvider: 'c', toModel: 'd', reason: 'test', timestamp: T0 }] }
      const { state } = dispatch(s, sendEvent())
      expect(state.retries).toBe(0)
      expect(state.history).toEqual([])
    })
  })

  describe('TTFT watchdog', () => {
    it('fires timeout error when no tokens arrive', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state, allEffects } = dispatch(sent, {
        type: 'ttft_fired', attemptId: sent.attemptId, now: T0 + 20_000,
      })

      const failover = allEffects.find((e) => e.kind === 'begin_failover')
      expect(failover).toBeDefined()
      expect(state.failoverInFlight).toBe(true)
    })

    it('ignores stale TTFT from superseded attempt', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { allEffects } = dispatch(sent, {
        type: 'ttft_fired', attemptId: sent.attemptId - 1, now: T0 + 20_000,
      })
      expect(allEffects).toEqual([])
    })

    it('transitions to stall watchdog on first stream', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state, allEffects } = dispatch(sent, {
        type: 'stream', sessionID: 'sess-1', now: T0 + 5000,
      })

      expect(state.watchdog).toBe('stall')
      expect(state.hasStreamed).toBe(true)
      expect(allEffects).toContainEqual({ kind: 'arm_stall', attemptId: sent.attemptId, ms: 90_000 })
    })
  })

  describe('stall watchdog pausing', () => {
    function sendAndStream(): AttemptState {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state } = dispatch(sent, { type: 'stream', sessionID: 'sess-1', now: T0 + 1000 })
      return state
    }

    it('pauses during tool execution', () => {
      const streaming = sendAndStream()
      const { state, allEffects } = dispatch(streaming, {
        type: 'tool_started', sessionID: 'sess-1', now: T0 + 2000,
      })

      expect(state.watchdog).toBe('paused')
      expect(state.pauseReason).toBe('tool')
      expect(state.toolExecuted).toBe(true)
      expect(allEffects).toContainEqual({ kind: 'clear_timer', attemptId: streaming.attemptId })
    })

    it('resumes stall after tool completes', () => {
      const streaming = sendAndStream()
      const { state } = dispatch(streaming,
        { type: 'tool_started', sessionID: 'sess-1', now: T0 + 2000 },
        { type: 'tool_completed', sessionID: 'sess-1', now: T0 + 10000 },
      )

      expect(state.watchdog).toBe('stall')
      expect(state.pauseReason).toBeNull()
    })

    it('pauses during permission wait', () => {
      const streaming = sendAndStream()
      const { state } = dispatch(streaming, {
        type: 'permission_asked', sessionID: 'sess-1', now: T0 + 2000,
      })

      expect(state.watchdog).toBe('paused')
      expect(state.pauseReason).toBe('permission')
    })

    it('resumes after permission replied', () => {
      const streaming = sendAndStream()
      const { state } = dispatch(streaming,
        { type: 'permission_asked', sessionID: 'sess-1', now: T0 + 2000 },
        { type: 'permission_replied', sessionID: 'sess-1', now: T0 + 5000 },
      )

      expect(state.watchdog).toBe('stall')
      expect(state.pauseReason).toBeNull()
    })

    it('pauses during session retry', () => {
      const streaming = sendAndStream()
      const { state } = dispatch(streaming, {
        type: 'session_retry', sessionID: 'sess-1', now: T0 + 2000,
      })

      expect(state.watchdog).toBe('paused')
      expect(state.pauseReason).toBe('retry')
    })
  })

  describe('tool-executed guard (R1)', () => {
    it('blocks auto-retry when tool has executed', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state: streamed } = dispatch(sent, { type: 'stream', sessionID: 'sess-1', now: T0 + 1000 })
      const { state: tooled } = dispatch(streamed, { type: 'tool_started', sessionID: 'sess-1', now: T0 + 2000 })

      const { allEffects } = dispatch(tooled, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpm-wait', now: T0 + 3000,
      })

      const continueEffect = allEffects.find((e) => e.kind === 'continue_with_next')
      expect(continueEffect).toBeDefined()
      expect(canAutoRetry(tooled)).toBe(false)

      // Should NOT have begin_failover
      expect(allEffects.find((e) => e.kind === 'begin_failover')).toBeUndefined()
      expect(allEffects.find((e) => e.kind === 'wait_and_retry_same')).toBeUndefined()
    })

    it('blocks auto-retry when tokens have streamed', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state: streamed } = dispatch(sent, { type: 'stream', sessionID: 'sess-1', now: T0 + 1000 })

      const { allEffects } = dispatch(streamed, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpd-drop', now: T0 + 2000,
      })

      expect(allEffects.find((e) => e.kind === 'continue_with_next')).toBeDefined()
      expect(canAutoRetry(streamed)).toBe(false)
    })

    it('allows auto-retry when clean (no tools, no stream)', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      expect(canAutoRetry(sent)).toBe(true)

      const { allEffects } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpm-wait', now: T0 + 2000,
      })
      expect(allEffects.find((e) => e.kind === 'wait_and_retry_same')).toBeDefined()
    })
  })

  describe('single-entry beginFailover (R3)', () => {
    it('second error during failover is ignored', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state: failing } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpd-drop', now: T0 + 1000,
      })
      expect(failing.failoverInFlight).toBe(true)

      const { state: same, allEffects } = dispatch(failing, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpd-drop', now: T0 + 1500,
      })
      expect(allEffects).toEqual([])
      expect(same).toBe(failing)
    })
  })

  describe('per-exchange retry cap (R2)', () => {
    it('caps at maxRetries then stops', () => {
      let s = dispatch(INITIAL_ATTEMPT_STATE, sendEvent()).state

      for (let i = 0; i < 3; i++) {
        const r = dispatch(s, { type: 'error', sessionID: 'sess-1', errorClass: 'rpd-drop', now: T0 + (i + 1) * 1000 })
        s = r.state
        // Simulate failover complete
        s = dispatch(s, {
          type: 'failover_complete', attemptId: s.attemptId, providerID: 'groq', modelID: `model-${i}`, reason: 'test', now: T0 + (i + 1) * 1000 + 500,
        }).state
      }

      expect(s.retries).toBe(3)

      const { allEffects } = dispatch(s, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpd-drop', now: T0 + 5000,
      })
      expect(allEffects.find((e) => e.kind === 'stop')).toBeDefined()
    })

    it('resets on clean idle', () => {
      let s = dispatch(INITIAL_ATTEMPT_STATE, sendEvent()).state
      const r = dispatch(s, { type: 'error', sessionID: 'sess-1', errorClass: 'rpd-drop', now: T0 + 1000 })
      s = r.state
      s = dispatch(s, {
        type: 'failover_complete', attemptId: s.attemptId, providerID: 'groq', modelID: 'x', reason: 'test', now: T0 + 2000,
      }).state
      expect(s.retries).toBe(1)

      s = dispatch(s, { type: 'idle', sessionID: 'sess-1', now: T0 + 3000 }).state
      expect(s.retries).toBe(0)
    })
  })

  describe('error classification routing', () => {
    it('rpm-wait → wait_and_retry_same with capped retryAfter', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { allEffects } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpm-wait', retryAfterMs: 300_000, now: T0 + 1000,
      })

      const wait = allEffects.find((e) => e.kind === 'wait_and_retry_same') as Extract<Effect, { kind: 'wait_and_retry_same' }>
      expect(wait).toBeDefined()
      expect(wait.waitMs).toBe(120_000) // capped at 120s
    })

    it('rpm-wait defaults to 30s when no retryAfter', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { allEffects } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpm-wait', now: T0 + 1000,
      })

      const wait = allEffects.find((e) => e.kind === 'wait_and_retry_same') as Extract<Effect, { kind: 'wait_and_retry_same' }>
      expect(wait.waitMs).toBe(30_000)
    })

    it('rpd-drop → begin_failover', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { allEffects } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpd-drop', now: T0 + 1000,
      })
      expect(allEffects.find((e) => e.kind === 'begin_failover')).toBeDefined()
    })

    it('tpm-drop → begin_failover without retrying the unchanged request', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { allEffects } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'tpm-drop', now: T0 + 1000,
      })
      const failover = allEffects.find((e) => e.kind === 'begin_failover') as Extract<Effect, { kind: 'begin_failover' }>
      expect(failover.reason).toContain('token throughput')
      expect(allEffects.some((e) => e.kind === 'wait_and_retry_same')).toBe(false)
    })

    it('transient → transient_retry', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { allEffects } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'transient', now: T0 + 1000,
      })
      expect(allEffects.find((e) => e.kind === 'transient_retry')).toBeDefined()
    })

    it('client → stop (non-retryable)', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { allEffects } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'client', now: T0 + 1000,
      })
      expect(allEffects.find((e) => e.kind === 'stop')).toBeDefined()
    })

    it('server → stop (non-retryable)', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { allEffects } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'server', now: T0 + 1000,
      })
      expect(allEffects.find((e) => e.kind === 'stop')).toBeDefined()
    })
  })

  describe('chosen/effective split (R4)', () => {
    it('chosen stays pinned after failover', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state: failing } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpd-drop', now: T0 + 1000,
      })
      const { state: rotated } = dispatch(failing, {
        type: 'failover_complete', attemptId: failing.attemptId, providerID: 'groq', modelID: 'llama-3.3-70b-versatile', reason: '429', now: T0 + 2000,
      })

      expect(rotated.chosenProviderID).toBe('google')
      expect(rotated.chosenModelID).toBe('gemini-3.6-flash')
      expect(rotated.effectiveProviderID).toBe('groq')
      expect(rotated.effectiveModelID).toBe('llama-3.3-70b-versatile')
      expect(isFailedOver(rotated)).toBe(true)
    })

    it('set_chosen updates only chosen, not effective', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state } = dispatch(sent, {
        type: 'set_chosen', providerID: 'mistral', modelID: 'devstral-latest',
      })

      expect(state.chosenProviderID).toBe('mistral')
      expect(state.chosenModelID).toBe('devstral-latest')
      expect(state.effectiveProviderID).toBe('google')
      expect(state.effectiveModelID).toBe('gemini-3.6-flash')
    })
  })

  describe('failover history', () => {
    it('records each rotation', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state: failing } = dispatch(sent, {
        type: 'error', sessionID: 'sess-1', errorClass: 'rpd-drop', now: T0 + 1000,
      })
      const { state: rotated } = dispatch(failing, {
        type: 'failover_complete', attemptId: failing.attemptId, providerID: 'groq', modelID: 'gpt-oss-120b', reason: 'quota', now: T0 + 2000,
      })

      expect(rotated.history).toHaveLength(1)
      expect(rotated.history[0]).toEqual({
        fromProvider: 'google',
        fromModel: 'gemini-3.6-flash',
        toProvider: 'groq',
        toModel: 'gpt-oss-120b',
        reason: 'quota',
        timestamp: T0 + 2000,
      })
    })
  })

  describe('session scoping (R6)', () => {
    it('ignores events from wrong session', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state, allEffects } = dispatch(sent, {
        type: 'stream', sessionID: 'other-session', now: T0 + 1000,
      })
      expect(allEffects).toEqual([])
      expect(state).toBe(sent) // reference equality — no mutation
    })

    it('ignores errors from wrong session', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { allEffects } = dispatch(sent, {
        type: 'error', sessionID: 'other-session', errorClass: 'rpd-drop', now: T0 + 1000,
      })
      expect(allEffects).toEqual([])
    })
  })

  describe('abort', () => {
    it('clears watchdog and failover flag', () => {
      const { state: sent } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      const { state } = dispatch(sent, {
        type: 'abort', sessionID: 'sess-1', now: T0 + 1000,
      })

      expect(state.watchdog).toBe('idle')
      expect(state.failoverInFlight).toBe(false)
    })
  })

  describe('taskKind', () => {
    it('defaults to code', () => {
      const { state } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent())
      expect(state.taskKind).toBe('code')
    })

    it('accepts override', () => {
      const { state } = dispatch(INITIAL_ATTEMPT_STATE, sendEvent({ taskKind: 'title' }))
      expect(state.taskKind).toBe('title')
    })
  })
})
