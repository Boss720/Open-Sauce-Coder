import { describe, expect, it } from 'vitest'
import type { LeroyEvent } from '../../../../preload'
import {
  describeLeroyStatus,
  formatLeroyUsage,
  isLeroyLive,
  reduceLeroyEvent,
  INITIAL_LEROY_STATE,
  type LeroyState
} from '../leroySession'

const AT = 1_700_000_000_000

function fold(events: LeroyEvent[], from: LeroyState = INITIAL_LEROY_STATE): LeroyState {
  return events.reduce((state, event) => reduceLeroyEvent(state, event, AT), from)
}

const live: LeroyEvent = { type: 'connection_state_changed', state: 'live', detail: '' }

function approval(callId: string, name = 'write_file'): LeroyEvent {
  return { type: 'tool_approval_requested', callId, name, args: { path: 'a.txt' }, allowText: 'writes a.txt' }
}

describe('transcript', () => {
  it('merges consecutive same-speaker partials and keeps ids stable', () => {
    const state = fold([
      { type: 'partial_transcript', text: 'open the', source: 'model', turnId: 1 },
      { type: 'partial_transcript', text: 'file', source: 'model', turnId: 1 }
    ])
    expect(state.transcript).toHaveLength(1)
    expect(state.transcript[0]).toMatchObject({ role: 'gemini', text: 'open the file', at: AT })
  })

  it('separates the two speakers', () => {
    const state = fold([
      { type: 'partial_transcript', text: 'hello', source: 'user', turnId: 1 },
      { type: 'partial_transcript', text: 'hi', source: 'model', turnId: 1 }
    ])
    expect(state.transcript.map((entry) => entry.role)).toEqual(['you', 'gemini'])
  })

  it('drops empty partials instead of creating blank bubbles', () => {
    expect(fold([{ type: 'partial_transcript', text: '   ', source: 'model', turnId: 1 }]).transcript).toEqual([])
  })

  it('turn_complete only closes the turn — the text already arrived as partials', () => {
    const state = fold([
      { type: 'partial_transcript', text: 'done', source: 'model', turnId: 1 },
      { type: 'turn_complete', source: 'model', text: 'done', turnId: 1 }
    ])
    expect(state.transcript).toHaveLength(1)
  })

  it('records a context reset and a real expiry countdown as status lines', () => {
    const state = fold([
      { type: 'context_reset', reason: 'handle rejected' },
      { type: 'session_expiring', seconds: 30 },
      { type: 'session_expiring', seconds: null }
    ])
    expect(state.transcript.map((entry) => entry.role)).toEqual(['system', 'system'])
    expect(state.transcript[0].text).toContain('handle rejected')
    expect(state.transcript[1].text).toContain('30s')
  })
})

describe('approvals', () => {
  it('queues a request and clears it when the result lands', () => {
    const queued = fold([approval('c1')])
    expect(queued.approvals).toEqual([
      { callId: 'c1', name: 'write_file', args: { path: 'a.txt' }, allowText: 'writes a.txt' }
    ])

    const done = fold([{ type: 'tool_result_sent', callId: 'c1', name: 'write_file', ok: true, result: 'wrote 3 lines', orphaned: false }], queued)
    expect(done.approvals).toEqual([])
    expect(done.toolRuns[0]).toMatchObject({ callId: 'c1', ok: true, result: 'wrote 3 lines' })
  })

  it('does not double-queue a repeated request for the same call', () => {
    expect(fold([approval('c1'), approval('c1')]).approvals).toHaveLength(1)
  })

  it('drops approvals the sidecar cancelled, leaving the others', () => {
    const state = fold([approval('c1'), approval('c2', 'run_command'), { type: 'tool_call_cancelled', callIds: ['c1'], reason: 'interrupted' }])
    expect(state.approvals.map((item) => item.callId)).toEqual(['c2'])
  })

  it('keeps failed runs and shows the newest first', () => {
    const state = fold([
      { type: 'tool_result_sent', callId: 'c1', name: 'read_file', ok: true, result: 'ok', orphaned: false },
      { type: 'tool_result_sent', callId: 'c2', name: 'run_command', ok: false, result: 'exit 1', orphaned: false }
    ])
    expect(state.toolRuns.map((run) => run.callId)).toEqual(['c2', 'c1'])
    expect(state.toolRuns[0].ok).toBe(false)
  })

  it('bounds the tool log', () => {
    const events: LeroyEvent[] = Array.from({ length: 60 }, (_, index) => ({
      type: 'tool_result_sent',
      callId: `c${index}`,
      name: 'read_file',
      ok: true,
      result: 'ok',
      orphaned: false
    }))
    expect(fold(events).toolRuns).toHaveLength(50)
  })
})

describe('connection, errors and death', () => {
  it('clears a stale error once the session is live again', () => {
    const state = fold([{ type: 'session_error', message: 'dropped', fatal: false }, live])
    expect(state.error).toBeNull()
    expect(isLeroyLive(state)).toBe(true)
  })

  it('keeps the error when the state change is itself a failure', () => {
    const state = fold([
      { type: 'session_error', message: 'quota exhausted', fatal: false },
      { type: 'connection_state_changed', state: 'failed', detail: 'gave up' }
    ])
    expect(state.error).toBe('quota exhausted')
    expect(isLeroyLive(state)).toBe(false)
  })

  it('a fatal session error kills the session even before the child exits', () => {
    const state = fold([live, { type: 'session_error', message: 'no API key', fatal: true }])
    expect(state.dead).toBe(true)
    expect(isLeroyLive(state)).toBe(false)
  })

  it('reports a crash with the last stderr line and does not overwrite an earlier cause', () => {
    const crashed = fold([{ type: 'sidecar_exit', code: 1, signal: null, stderr: 'Traceback:\nModuleNotFoundError: no sounddevice' }])
    expect(crashed.error).toContain('ModuleNotFoundError: no sounddevice')
    expect(crashed.connection).toBe('failed')

    const explained = fold([
      { type: 'session_error', message: 'invalid settings', fatal: false },
      { type: 'sidecar_exit', code: 1, signal: null, stderr: 'noise' }
    ])
    expect(explained.error).toBe('invalid settings')
  })

  it('describes a signal kill without inventing an exit code', () => {
    const state = fold([{ type: 'sidecar_exit', code: null, signal: 'SIGTERM', stderr: '' }])
    expect(state.error).toBe('Leroy stopped (signal SIGTERM).')
  })

  it('marks the session dead when it ends normally', () => {
    const state = fold([live, { type: 'session_ended', code: 'user_request', detail: '' }])
    expect(state).toMatchObject({ dead: true, connection: 'disconnected' })
  })

  it('records the handshake', () => {
    expect(fold([{ type: 'ready', protocol: 1, runId: 'r1' }]).ready).toBe(true)
  })

  it('ignores audio meter frames rather than rerendering on them', () => {
    const before = fold([live])
    expect(reduceLeroyEvent(before, { type: 'audio_level', source: 'mic', level: 0.4 }, AT)).toBe(before)
  })
})

describe('usage and rate limits', () => {
  it('keeps the latest usage snapshot', () => {
    const state = fold([
      { type: 'usage_update', promptTokens: 1, cachedTokens: 0, completionTokens: 1, audioTokens: 2, videoTokens: 3, totalTokens: 10, estimatedUsd: 0.01 },
      { type: 'usage_update', promptTokens: 2, cachedTokens: 0, completionTokens: 2, audioTokens: 4, videoTokens: 6, totalTokens: 20, estimatedUsd: 0.02 }
    ])
    expect(state.usage).toEqual({ totalTokens: 20, audioTokens: 4, videoTokens: 6, estimatedUsd: 0.02 })
  })

  it('records the pool that hit its limit', () => {
    const state = fold([{ type: 'rate_limit_hit', model: 'gemini-3.1-flash-live-preview', tier: 'free', tpmUsed: 65000, tpmLimit: 65000, cooldownSeconds: 15 }])
    expect(state.rateLimit).toMatchObject({ tier: 'free', tpmUsed: 65000, cooldownSeconds: 15 })
  })

  it('formats free and billed usage differently', () => {
    expect(formatLeroyUsage(null)).toBe('')
    expect(formatLeroyUsage({ totalTokens: 1234, audioTokens: 0, videoTokens: 0, estimatedUsd: null })).toBe('1,234 tokens · Free')
    expect(formatLeroyUsage({ totalTokens: 1234, audioTokens: 0, videoTokens: 0, estimatedUsd: 0.04123 })).toBe('1,234 tokens · $0.0412')
  })
})

describe('describeLeroyStatus', () => {
  it('reports Stopped once dead, whatever the last connection state was', () => {
    expect(describeLeroyStatus({ ...INITIAL_LEROY_STATE, connection: 'live', dead: true })).toBe('Stopped')
  })

  it('names each live-cycle state', () => {
    const say = (connection: LeroyState['connection']): string => describeLeroyStatus({ ...INITIAL_LEROY_STATE, connection })
    expect(say('idle')).toBe('Idle')
    expect(say('live')).toBe('Live')
    expect(say('reconnecting')).toBe('Reconnecting…')
    expect(say('draining')).toBe('Finishing turn…')
    expect(say('failed')).toBe('Failed')
  })
})
