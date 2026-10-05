/**
 * Reduces the Leroy sidecar's event stream into the state the Live window
 * renders. Pure (no store/React/IPC) so it stays unit-testable, like
 * `liveTranscript.ts` next to it.
 *
 * Event shapes are pinned by `src/main/leroy/protocol.ts` and CONTRACTS.md.
 */

import type { LeroyConnectionState, LeroyEvent } from '../../../preload'
import { appendTranscriptChunk, type LiveTranscriptEntry } from './liveTranscript'

/** A tool call the model wants to run, waiting on the user. */
export type LeroyApproval = {
  callId: string
  name: string
  args: Record<string, unknown>
  /** One-line policy summary from the Python side; may be empty. */
  allowText: string
}

/** A tool call that already ran, newest first. */
export type LeroyToolRun = {
  callId: string
  name: string
  ok: boolean
  result: string
}

export type LeroyUsage = {
  totalTokens: number
  audioTokens: number
  videoTokens: number
  /** Null on the free tier or when the model reports no cost — show "Free", not "$0". */
  estimatedUsd: number | null
}

export type LeroyRateLimit = {
  model: string
  tier: string
  tpmUsed: number
  tpmLimit: number
  cooldownSeconds: number
}

export type LeroyState = {
  connection: LeroyConnectionState
  /** Extra detail from the last state change (e.g. the reconnect reason). */
  detail: string
  transcript: LiveTranscriptEntry[]
  approvals: LeroyApproval[]
  toolRuns: LeroyToolRun[]
  usage: LeroyUsage | null
  rateLimit: LeroyRateLimit | null
  /** Last error worth showing; cleared when the session goes live again. */
  error: string | null
  /** True once the sidecar has handshaken. */
  ready: boolean
  /** Set when the child died — the session cannot recover without a restart. */
  dead: boolean
  /** Monotonic id source for transcript entries. */
  nextEntryId: number
}

export const INITIAL_LEROY_STATE: LeroyState = {
  connection: 'idle',
  detail: '',
  transcript: [],
  approvals: [],
  toolRuns: [],
  usage: null,
  rateLimit: null,
  error: null,
  ready: false,
  dead: false,
  nextEntryId: 0
}

/** How many finished tool runs to keep; older ones scroll out of usefulness. */
const TOOL_RUN_LIMIT = 50

function withEntry(
  state: LeroyState,
  role: LiveTranscriptEntry['role'],
  text: string,
  at: number
): LeroyState {
  if (!text.trim()) return state
  const id = state.nextEntryId + 1
  return {
    ...state,
    nextEntryId: id,
    transcript: appendTranscriptChunk(state.transcript, { id, role, text, at })
  }
}

/**
 * Fold one sidecar event into the session state.
 *
 * `at` is passed in rather than read from the clock so the reducer stays pure
 * and tests can assert on timestamps.
 */
export function reduceLeroyEvent(state: LeroyState, event: LeroyEvent, at: number): LeroyState {
  switch (event.type) {
    case 'ready':
      return { ...state, ready: true }
    case 'connection_state_changed':
      return {
        ...state,
        connection: event.state,
        detail: event.detail,
        // A live connection means the last error is stale — but a failed or
        // errored state must keep it, since it is the only explanation shown.
        error: event.state === 'live' ? null : state.error
      }
    case 'partial_transcript':
      return withEntry(state, event.source === 'user' ? 'you' : 'gemini', event.text, at)
    case 'turn_complete':
      // The text already arrived as partials; a turn boundary only closes them.
      return state
    case 'tool_call_received':
      // Ungated calls never raise an approval — log them so the user still sees
      // what ran, with the result filled in by `tool_result_sent`.
      return state
    case 'tool_approval_requested': {
      if (state.approvals.some((approval) => approval.callId === event.callId)) return state
      return {
        ...state,
        approvals: [
          ...state.approvals,
          { callId: event.callId, name: event.name, args: event.args, allowText: event.allowText }
        ]
      }
    }
    case 'tool_result_sent':
      return {
        ...state,
        approvals: state.approvals.filter((approval) => approval.callId !== event.callId),
        toolRuns: [
          { callId: event.callId, name: event.name, ok: event.ok, result: event.result },
          ...state.toolRuns
        ].slice(0, TOOL_RUN_LIMIT)
      }
    case 'tool_call_cancelled':
      return {
        ...state,
        approvals: state.approvals.filter((approval) => !event.callIds.includes(approval.callId))
      }
    case 'usage_update':
      return {
        ...state,
        usage: {
          totalTokens: event.totalTokens,
          audioTokens: event.audioTokens,
          videoTokens: event.videoTokens,
          estimatedUsd: event.estimatedUsd
        }
      }
    case 'rate_limit_hit':
      return {
        ...state,
        rateLimit: {
          model: event.model,
          tier: event.tier,
          tpmUsed: event.tpmUsed,
          tpmLimit: event.tpmLimit,
          cooldownSeconds: event.cooldownSeconds
        }
      }
    case 'context_reset':
      return withEntry(state, 'system', `Context rebuilt: ${event.reason}`, at)
    case 'session_expiring':
      return event.seconds === null
        ? state
        : withEntry(state, 'system', `Session expires in ${event.seconds}s — it will resume automatically.`, at)
    case 'session_error':
      return { ...state, error: event.message, dead: state.dead || event.fatal }
    case 'session_ended':
      return { ...state, connection: 'disconnected', dead: true, detail: event.detail }
    case 'fatal':
      return { ...state, error: event.message, dead: true, connection: 'failed' }
    case 'sidecar_exit':
      return {
        ...state,
        dead: true,
        connection: 'failed',
        error: state.error ?? describeExit(event.code, event.signal, event.stderr)
      }
    case 'sidecar_error':
      return { ...state, error: event.message }
    case 'audio_level':
      // Metered many times a second; deliberately not stored (it would rerender
      // the whole panel at ~30 Hz for a decoration).
      return state
    default:
      return state
  }
}

function describeExit(code: number | null, signal: string | null, stderr: string): string {
  const how = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
  const tail = stderr.trim().split('\n').filter(Boolean).at(-1)
  return tail ? `Leroy stopped (${how}): ${tail}` : `Leroy stopped (${how}).`
}

/** True while the session can accept text and tool answers. */
export function isLeroyLive(state: LeroyState): boolean {
  return state.connection === 'live' && !state.dead
}

/** Human-readable one-liner for the status dot. */
export function describeLeroyStatus(state: LeroyState): string {
  if (state.dead) return 'Stopped'
  switch (state.connection) {
    case 'live':
      return 'Live'
    case 'connecting':
      return 'Connecting…'
    case 'reconnecting':
      return 'Reconnecting…'
    case 'draining':
      return 'Finishing turn…'
    case 'disconnecting':
      return 'Disconnecting…'
    case 'disconnected':
      return 'Disconnected'
    case 'error':
      return 'Error'
    case 'failed':
      return 'Failed'
    default:
      return 'Idle'
  }
}

/** `1,234 tokens · $0.0412` / `1,234 tokens · Free`. */
export function formatLeroyUsage(usage: LeroyUsage | null): string {
  if (!usage) return ''
  const tokens = `${usage.totalTokens.toLocaleString()} tokens`
  return usage.estimatedUsd === null ? `${tokens} · Free` : `${tokens} · $${usage.estimatedUsd.toFixed(4)}`
}
