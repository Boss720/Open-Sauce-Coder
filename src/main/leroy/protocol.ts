/**
 * NDJSON protocol shared with the Leroy sidecar (`bridge_stdio.py` in the
 * gemini-live-agent repo). Electron-free so it stays unit-testable.
 *
 * Commands go out on the child's stdin, events come back on its stdout, one
 * JSON object per line. Both directions are validated here: the sidecar is a
 * separate program that may be a different build than this app, so nothing it
 * writes is trusted, and nothing malformed is written to it.
 *
 * `LEROY_PROTOCOL_VERSION` must match the sidecar's `PROTOCOL_VERSION`;
 * a mismatch is refused at handshake rather than papered over.
 */

export const LEROY_PROTOCOL_VERSION = 1

/** Connection states mirrored from the sidecar's `core/events.py`. */
export const LEROY_CONNECTION_STATES = [
  'idle', 'connecting', 'live', 'draining', 'reconnecting',
  'disconnecting', 'disconnected', 'error', 'failed'
] as const
export type LeroyConnectionState = (typeof LEROY_CONNECTION_STATES)[number]

export type LeroyGatingMode = 'guarded' | 'yolo'

/** Every frame the sidecar may emit. Unknown types are dropped by `parseLeroyEvent`. */
export type LeroyEvent =
  | { type: 'ready'; protocol: number; runId: string }
  | { type: 'connection_state_changed'; state: LeroyConnectionState; detail: string }
  | { type: 'partial_transcript'; text: string; source: 'user' | 'model'; turnId: number }
  | { type: 'turn_complete'; source: 'user' | 'model'; text: string; turnId: number }
  | { type: 'tool_call_received'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_approval_requested'; callId: string; name: string; args: Record<string, unknown>; allowText: string }
  | { type: 'tool_result_sent'; callId: string; name: string; ok: boolean; result: string; orphaned: boolean }
  | { type: 'tool_call_cancelled'; callIds: string[]; reason: string }
  | { type: 'session_expiring'; seconds: number | null }
  | { type: 'audio_level'; source: string; level: number }
  | { type: 'session_error'; message: string; fatal: boolean }
  | { type: 'rate_limit_hit'; model: string; tier: string; tpmUsed: number; tpmLimit: number; cooldownSeconds: number }
  | { type: 'context_reset'; reason: string }
  | { type: 'usage_update'; promptTokens: number; cachedTokens: number; completionTokens: number; audioTokens: number; videoTokens: number; totalTokens: number; estimatedUsd: number | null }
  | { type: 'session_ended'; code: string; detail: string }
  | { type: 'fatal'; message: string }

/** Every frame this app may send. */
export type LeroyCommand =
  | { type: 'connect'; settings: Record<string, unknown> }
  | { type: 'disconnect' }
  | { type: 'send_text'; text: string }
  | { type: 'set_mic_gate'; open: boolean }
  | { type: 'set_share_screen'; enabled: boolean; monitor?: number }
  | { type: 'approve_tool'; call_id: string }
  | { type: 'deny_tool'; call_id: string; reason?: string }
  | { type: 'cancel_tool'; call_ids: string[] }
  | { type: 'set_gating_mode'; mode: LeroyGatingMode; duration_minutes?: number }
  | { type: 'ping' }

function str(raw: Record<string, unknown>, key: string, fallback = ''): string {
  const value = raw[key]
  return typeof value === 'string' ? value : fallback
}

function num(raw: Record<string, unknown>, key: string, fallback = 0): number {
  const value = raw[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(raw: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = raw[key]
  return typeof value === 'boolean' ? value : fallback
}

function nullableNum(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function args(raw: Record<string, unknown>): Record<string, unknown> {
  const value = raw.args
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function strings(raw: Record<string, unknown>, key: string): string[] {
  const value = raw[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function source(raw: Record<string, unknown>): 'user' | 'model' {
  return raw.source === 'user' ? 'user' : 'model'
}

/**
 * Parse one stdout line into an event, or `null` when it is not a frame this
 * build understands. A sidecar that logs to stdout by accident, or that adds an
 * event type in a newer version, must not take the session down — so this is
 * lenient about what it drops and strict about what it returns.
 */
export function parseLeroyEvent(line: string): LeroyEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const raw = parsed as Record<string, unknown>
  switch (raw.type) {
    case 'ready':
      return { type: 'ready', protocol: num(raw, 'protocol', -1), runId: str(raw, 'run_id') }
    case 'connection_state_changed': {
      const state = raw.state
      if (typeof state !== 'string' || !(LEROY_CONNECTION_STATES as readonly string[]).includes(state)) return null
      return { type: 'connection_state_changed', state: state as LeroyConnectionState, detail: str(raw, 'detail') }
    }
    case 'partial_transcript':
      return { type: 'partial_transcript', text: str(raw, 'text'), source: source(raw), turnId: num(raw, 'turn_id') }
    case 'turn_complete':
      return { type: 'turn_complete', source: source(raw), text: str(raw, 'text'), turnId: num(raw, 'turn_id') }
    case 'tool_call_received':
      return { type: 'tool_call_received', callId: str(raw, 'call_id'), name: str(raw, 'name'), args: args(raw) }
    case 'tool_approval_requested':
      return {
        type: 'tool_approval_requested',
        callId: str(raw, 'call_id'),
        name: str(raw, 'name'),
        args: args(raw),
        allowText: str(raw, 'allow_text')
      }
    case 'tool_result_sent':
      return {
        type: 'tool_result_sent',
        callId: str(raw, 'call_id'),
        name: str(raw, 'name'),
        ok: bool(raw, 'ok'),
        result: str(raw, 'result'),
        orphaned: bool(raw, 'orphaned')
      }
    case 'tool_call_cancelled':
      return { type: 'tool_call_cancelled', callIds: strings(raw, 'call_ids'), reason: str(raw, 'reason') }
    case 'session_expiring':
      return { type: 'session_expiring', seconds: nullableNum(raw, 'seconds') }
    case 'audio_level':
      return { type: 'audio_level', source: str(raw, 'source'), level: num(raw, 'level') }
    case 'session_error':
      return { type: 'session_error', message: str(raw, 'message'), fatal: bool(raw, 'fatal') }
    case 'rate_limit_hit':
      return {
        type: 'rate_limit_hit',
        model: str(raw, 'model'),
        tier: str(raw, 'tier'),
        tpmUsed: num(raw, 'tpm_used'),
        tpmLimit: num(raw, 'tpm_limit'),
        cooldownSeconds: num(raw, 'cooldown_seconds')
      }
    case 'context_reset':
      return { type: 'context_reset', reason: str(raw, 'reason') }
    case 'usage_update':
      return {
        type: 'usage_update',
        promptTokens: num(raw, 'prompt_tokens'),
        cachedTokens: num(raw, 'cached_tokens'),
        completionTokens: num(raw, 'completion_tokens'),
        audioTokens: num(raw, 'audio_tokens'),
        videoTokens: num(raw, 'video_tokens'),
        totalTokens: num(raw, 'total_tokens'),
        estimatedUsd: nullableNum(raw, 'estimated_usd')
      }
    case 'session_ended':
      return { type: 'session_ended', code: str(raw, 'code'), detail: str(raw, 'detail') }
    case 'fatal':
      return { type: 'fatal', message: str(raw, 'message') }
    default:
      return null
  }
}

/** Split a stdout chunk into complete lines plus the unterminated remainder. */
export function splitFrames(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { lines: parts, rest }
}

const MAX_TEXT_LENGTH = 8000
const CALL_ID_PATTERN = /^[\w.:-]{1,128}$/

/**
 * Validate a renderer-supplied command before it reaches the child's stdin.
 * Throws on anything malformed — an unchecked newline in `text` would forge a
 * second frame, so string fields are length- and content-checked here.
 */
export function validateLeroyCommand(input: unknown): LeroyCommand {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('leroy command must be an object')
  }
  const raw = input as Record<string, unknown>
  switch (raw.type) {
    case 'disconnect':
      return { type: 'disconnect' }
    case 'ping':
      return { type: 'ping' }
    case 'send_text': {
      const text = raw.text
      if (typeof text !== 'string' || !text.trim()) throw new Error('send_text requires non-empty text')
      if (text.length > MAX_TEXT_LENGTH) throw new Error(`send_text is limited to ${MAX_TEXT_LENGTH} characters`)
      return { type: 'send_text', text }
    }
    case 'set_mic_gate':
      if (typeof raw.open !== 'boolean') throw new Error('set_mic_gate requires a boolean open')
      return { type: 'set_mic_gate', open: raw.open }
    case 'set_share_screen': {
      if (typeof raw.enabled !== 'boolean') throw new Error('set_share_screen requires a boolean enabled')
      const monitor = raw.monitor
      if (monitor !== undefined && (typeof monitor !== 'number' || !Number.isInteger(monitor) || monitor < 0)) {
        throw new Error('set_share_screen monitor must be a non-negative integer')
      }
      return monitor === undefined
        ? { type: 'set_share_screen', enabled: raw.enabled }
        : { type: 'set_share_screen', enabled: raw.enabled, monitor: monitor as number }
    }
    case 'approve_tool':
      return { type: 'approve_tool', call_id: requireCallId(raw.call_id) }
    case 'deny_tool': {
      const reason = raw.reason
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) {
        throw new Error('deny_tool reason must be a string of at most 200 characters')
      }
      return reason === undefined
        ? { type: 'deny_tool', call_id: requireCallId(raw.call_id) }
        : { type: 'deny_tool', call_id: requireCallId(raw.call_id), reason: reason as string }
    }
    case 'cancel_tool': {
      const ids = raw.call_ids
      if (!Array.isArray(ids) || ids.length === 0) throw new Error('cancel_tool requires a non-empty call_ids array')
      return { type: 'cancel_tool', call_ids: ids.map(requireCallId) }
    }
    case 'set_gating_mode': {
      if (raw.mode !== 'guarded' && raw.mode !== 'yolo') throw new Error('set_gating_mode mode must be guarded or yolo')
      const duration = raw.duration_minutes
      if (duration !== undefined && (typeof duration !== 'number' || !Number.isInteger(duration) || duration <= 0)) {
        throw new Error('set_gating_mode duration_minutes must be a positive integer')
      }
      return duration === undefined
        ? { type: 'set_gating_mode', mode: raw.mode }
        : { type: 'set_gating_mode', mode: raw.mode, duration_minutes: duration as number }
    }
    default:
      throw new Error(`unknown leroy command: ${String(raw.type)}`)
  }
}

function requireCallId(value: unknown): string {
  if (typeof value !== 'string' || !CALL_ID_PATTERN.test(value)) throw new Error('call_id must be a short identifier string')
  return value
}

/** Serialize a command as a single NDJSON line, newline included. */
export function encodeLeroyCommand(command: LeroyCommand): string {
  return `${JSON.stringify(command)}\n`
}
