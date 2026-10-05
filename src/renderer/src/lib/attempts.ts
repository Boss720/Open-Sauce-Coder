/**
 * Pure per-attempt state machine for failover routing.
 *
 * All timer scheduling and side-effects are returned as `Effect` descriptors,
 * never executed internally — the store wires real timers to them.
 * This lets us unit-test every timing edge case with fake clocks.
 *
 * No store, no React, no DOM imports.
 */

import type { TaskKind } from './freeTier'

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

export interface AttemptState {
  /** Monotonically increasing attempt counter. */
  attemptId: number
  /** The user message that started this exchange. */
  messageID: string | null
  sessionID: string | null
  providerID: string | null
  modelID: string | null
  startedAt: number | null

  /** User's pinned selection — never mutated by failover. */
  chosenProviderID: string | null
  chosenModelID: string | null

  /** What's actually running — may differ during failover. */
  effectiveProviderID: string | null
  effectiveModelID: string | null

  /** Per-exchange retry counter (reset on clean idle, NOT on every idle). */
  retries: number
  maxRetries: number

  /** Whether any tool part has reached 'running' or 'completed' state. */
  toolExecuted: boolean
  /** Whether any assistant text/reasoning token has been streamed. */
  hasStreamed: boolean

  /** Watchdog config (ms). */
  ttftMs: number
  stallMs: number

  /** Current watchdog phase. */
  watchdog: 'ttft' | 'stall' | 'paused' | 'idle'

  /** Why watchdog is paused (for resume). */
  pauseReason: 'tool' | 'permission' | 'retry' | null

  /** Failover history for this exchange. */
  history: FailoverRecord[]

  /** Whether a failover is already in progress (single-entry guard). */
  failoverInFlight: boolean

  /** Optional task kind for sub-pool routing. */
  taskKind: TaskKind
}

export interface FailoverRecord {
  fromProvider: string
  fromModel: string
  toProvider: string
  toModel: string
  reason: string
  timestamp: number
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AttemptEvent =
  | { type: 'send'; messageID: string; sessionID: string; providerID: string; modelID: string; now: number; taskKind?: TaskKind }
  | { type: 'stream'; sessionID: string; now: number }
  | { type: 'tool_started'; sessionID: string; now: number }
  | { type: 'tool_completed'; sessionID: string; now: number }
  | { type: 'permission_asked'; sessionID: string; now: number }
  | { type: 'permission_replied'; sessionID: string; now: number }
  | { type: 'session_retry'; sessionID: string; now: number }
  | { type: 'session_retry_done'; sessionID: string; now: number }
  | { type: 'idle'; sessionID: string; now: number }
  | { type: 'error'; sessionID: string; errorClass: ErrorClass; retryAfterMs?: number; now: number }
  | { type: 'ttft_fired'; attemptId: number; now: number }
  | { type: 'stall_fired'; attemptId: number; now: number }
  | { type: 'failover_complete'; attemptId: number; providerID: string; modelID: string; reason: string; now: number }
  | { type: 'set_chosen'; providerID: string; modelID: string }
  | { type: 'abort'; sessionID: string; now: number }

export type ErrorClass =
  | 'rpm-wait'
  | 'rpd-drop'
  | 'tpm-drop'
  | 'timeout'
  | 'transient'
  | 'client'
  | 'server'

// ---------------------------------------------------------------------------
// Effects — what the store should do in response
// ---------------------------------------------------------------------------

export type Effect =
  | { kind: 'arm_ttft'; attemptId: number; ms: number }
  | { kind: 'arm_stall'; attemptId: number; ms: number }
  | { kind: 'clear_timer'; attemptId: number }
  | { kind: 'begin_failover'; attemptId: number; reason: string; errorClass: ErrorClass; retryAfterMs?: number }
  | { kind: 'wait_and_retry_same'; attemptId: number; waitMs: number }
  | { kind: 'transient_retry'; attemptId: number }
  | { kind: 'stop'; error: string }
  | { kind: 'continue_with_next'; attemptId: number; reason: string }

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

export const INITIAL_ATTEMPT_STATE: AttemptState = {
  attemptId: 0,
  messageID: null,
  sessionID: null,
  providerID: null,
  modelID: null,
  startedAt: null,
  chosenProviderID: null,
  chosenModelID: null,
  effectiveProviderID: null,
  effectiveModelID: null,
  retries: 0,
  maxRetries: 3,
  toolExecuted: false,
  hasStreamed: false,
  ttftMs: 20_000,
  stallMs: 90_000,
  watchdog: 'idle',
  pauseReason: null,
  history: [],
  failoverInFlight: false,
  taskKind: 'code',
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export interface ReducerResult {
  state: AttemptState
  effects: Effect[]
}

export function attemptReducer(state: AttemptState, event: AttemptEvent): ReducerResult {
  switch (event.type) {
    case 'send':
      return handleSend(state, event)
    case 'stream':
      return handleStream(state, event)
    case 'tool_started':
      return handleToolStarted(state, event)
    case 'tool_completed':
      return handleToolCompleted(state, event)
    case 'permission_asked':
      return handlePermissionAsked(state, event)
    case 'permission_replied':
      return handlePermissionReplied(state, event)
    case 'session_retry':
      return handleSessionRetry(state, event)
    case 'session_retry_done':
      return handleSessionRetryDone(state, event)
    case 'idle':
      return handleIdle(state, event)
    case 'error':
      return handleError(state, event)
    case 'ttft_fired':
      return handleTtftFired(state, event)
    case 'stall_fired':
      return handleStallFired(state, event)
    case 'failover_complete':
      return handleFailoverComplete(state, event)
    case 'set_chosen':
      return handleSetChosen(state, event)
    case 'abort':
      return handleAbort(state, event)
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleSend(
  state: AttemptState,
  e: { messageID: string; sessionID: string; providerID: string; modelID: string; now: number; taskKind?: TaskKind },
): ReducerResult {
  const next: AttemptState = {
    ...state,
    attemptId: state.attemptId + 1,
    messageID: e.messageID,
    sessionID: e.sessionID,
    providerID: e.providerID,
    modelID: e.modelID,
    startedAt: e.now,
    chosenProviderID: e.providerID,
    chosenModelID: e.modelID,
    effectiveProviderID: e.providerID,
    effectiveModelID: e.modelID,
    retries: 0,
    toolExecuted: false,
    hasStreamed: false,
    watchdog: 'ttft',
    pauseReason: null,
    history: [],
    failoverInFlight: false,
    taskKind: e.taskKind ?? 'code',
  }
  return {
    state: next,
    effects: [
      { kind: 'clear_timer', attemptId: state.attemptId },
      { kind: 'arm_ttft', attemptId: next.attemptId, ms: next.ttftMs },
    ],
  }
}

function handleStream(
  state: AttemptState,
  e: { sessionID: string; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)
  if (state.watchdog === 'idle') return noOp(state)

  const next: AttemptState = {
    ...state,
    hasStreamed: true,
    watchdog: 'stall',
  }
  return {
    state: next,
    effects: [{ kind: 'arm_stall', attemptId: state.attemptId, ms: state.stallMs }],
  }
}

function handleToolStarted(
  state: AttemptState,
  e: { sessionID: string; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)

  const next: AttemptState = {
    ...state,
    toolExecuted: true,
    watchdog: 'paused',
    pauseReason: 'tool',
  }
  return {
    state: next,
    effects: [{ kind: 'clear_timer', attemptId: state.attemptId }],
  }
}

function handleToolCompleted(
  state: AttemptState,
  e: { sessionID: string; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)
  if (state.watchdog !== 'paused' || state.pauseReason !== 'tool') return noOp(state)

  const next: AttemptState = {
    ...state,
    watchdog: 'stall',
    pauseReason: null,
  }
  return {
    state: next,
    effects: [{ kind: 'arm_stall', attemptId: state.attemptId, ms: state.stallMs }],
  }
}

function handlePermissionAsked(
  state: AttemptState,
  e: { sessionID: string; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)
  if (state.watchdog === 'idle') return noOp(state)

  const next: AttemptState = {
    ...state,
    watchdog: 'paused',
    pauseReason: 'permission',
  }
  return {
    state: next,
    effects: [{ kind: 'clear_timer', attemptId: state.attemptId }],
  }
}

function handlePermissionReplied(
  state: AttemptState,
  e: { sessionID: string; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)
  if (state.watchdog !== 'paused' || state.pauseReason !== 'permission') return noOp(state)

  const next: AttemptState = {
    ...state,
    watchdog: 'stall',
    pauseReason: null,
  }
  return {
    state: next,
    effects: [{ kind: 'arm_stall', attemptId: state.attemptId, ms: state.stallMs }],
  }
}

function handleSessionRetry(
  state: AttemptState,
  e: { sessionID: string; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)
  if (state.watchdog === 'idle') return noOp(state)

  const next: AttemptState = {
    ...state,
    watchdog: 'paused',
    pauseReason: 'retry',
  }
  return {
    state: next,
    effects: [{ kind: 'clear_timer', attemptId: state.attemptId }],
  }
}

function handleSessionRetryDone(
  state: AttemptState,
  e: { sessionID: string; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)
  if (state.watchdog !== 'paused' || state.pauseReason !== 'retry') return noOp(state)

  const next: AttemptState = {
    ...state,
    watchdog: 'stall',
    pauseReason: null,
  }
  return {
    state: next,
    effects: [{ kind: 'arm_stall', attemptId: state.attemptId, ms: state.stallMs }],
  }
}

function handleIdle(
  state: AttemptState,
  e: { sessionID: string; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)

  const next: AttemptState = {
    ...state,
    watchdog: 'idle',
    pauseReason: null,
    toolExecuted: false,
    hasStreamed: false,
    failoverInFlight: false,
    // retries reset on clean completion only
    retries: 0,
  }
  return {
    state: next,
    effects: [{ kind: 'clear_timer', attemptId: state.attemptId }],
  }
}

function handleError(
  state: AttemptState,
  e: { sessionID: string; errorClass: ErrorClass; retryAfterMs?: number; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)

  // Single-entry guard
  if (state.failoverInFlight) return noOp(state)

  const effects: Effect[] = [{ kind: 'clear_timer', attemptId: state.attemptId }]

  // If tools ran or tokens streamed, NEVER auto-retry — show partial + continue button
  if (state.toolExecuted || state.hasStreamed) {
    const next: AttemptState = {
      ...state,
      watchdog: 'idle',
      pauseReason: null,
    }
    effects.push({
      kind: 'continue_with_next',
      attemptId: state.attemptId,
      reason: `Side effects detected (${state.toolExecuted ? 'tool executed' : 'tokens streamed'}). Manual continue required.`,
    })
    return { state: next, effects }
  }

  switch (e.errorClass) {
    case 'rpm-wait': {
      const waitMs = Math.min(e.retryAfterMs ?? 30_000, 120_000)
      const next: AttemptState = { ...state, failoverInFlight: true }
      effects.push({ kind: 'wait_and_retry_same', attemptId: state.attemptId, waitMs })
      return { state: next, effects }
    }

    case 'rpd-drop':
    case 'tpm-drop':
    case 'timeout': {
      if (state.retries >= state.maxRetries) {
        const next: AttemptState = { ...state, watchdog: 'idle' }
        effects.push({ kind: 'stop', error: `Retry cap reached (${state.maxRetries}/${state.maxRetries}). Send again or switch models.` })
        return { state: next, effects }
      }
      const next: AttemptState = { ...state, failoverInFlight: true }
      effects.push({
        kind: 'begin_failover',
        attemptId: state.attemptId,
        reason: e.errorClass === 'rpd-drop'
          ? 'Daily quota exhausted'
          : e.errorClass === 'tpm-drop'
            ? 'Input token throughput limit exceeded'
            : 'Request timed out',
        errorClass: e.errorClass,
        retryAfterMs: e.retryAfterMs,
      })
      return { state: next, effects }
    }

    case 'transient': {
      if (state.retries >= state.maxRetries) {
        const next: AttemptState = { ...state, watchdog: 'idle' }
        effects.push({ kind: 'stop', error: 'Transient errors exhausted retry budget.' })
        return { state: next, effects }
      }
      const next: AttemptState = { ...state, failoverInFlight: true }
      effects.push({ kind: 'transient_retry', attemptId: state.attemptId })
      return { state: next, effects }
    }

    case 'client':
    case 'server': {
      const next: AttemptState = { ...state, watchdog: 'idle' }
      effects.push({ kind: 'stop', error: `Non-retryable error (${e.errorClass}).` })
      return { state: next, effects }
    }
  }
}

function handleTtftFired(
  state: AttemptState,
  e: { attemptId: number; now: number },
): ReducerResult {
  // Stale timer from a superseded attempt
  if (e.attemptId !== state.attemptId) return noOp(state)
  if (state.watchdog !== 'ttft') return noOp(state)

  // Treat as timeout error — delegate to error handler
  return handleError(state, {
    sessionID: state.sessionID!,
    errorClass: 'timeout',
    now: e.now,
  })
}

function handleStallFired(
  state: AttemptState,
  e: { attemptId: number; now: number },
): ReducerResult {
  if (e.attemptId !== state.attemptId) return noOp(state)
  if (state.watchdog !== 'stall') return noOp(state)

  return handleError(state, {
    sessionID: state.sessionID!,
    errorClass: 'timeout',
    now: e.now,
  })
}

function handleFailoverComplete(
  state: AttemptState,
  e: { attemptId: number; providerID: string; modelID: string; reason: string; now: number },
): ReducerResult {
  if (e.attemptId !== state.attemptId) return noOp(state)

  const record: FailoverRecord = {
    fromProvider: state.effectiveProviderID ?? '',
    fromModel: state.effectiveModelID ?? '',
    toProvider: e.providerID,
    toModel: e.modelID,
    reason: e.reason,
    timestamp: e.now,
  }

  const next: AttemptState = {
    ...state,
    attemptId: state.attemptId + 1,
    effectiveProviderID: e.providerID,
    effectiveModelID: e.modelID,
    providerID: e.providerID,
    modelID: e.modelID,
    startedAt: e.now,
    retries: state.retries + 1,
    toolExecuted: false,
    hasStreamed: false,
    watchdog: 'ttft',
    pauseReason: null,
    failoverInFlight: false,
    history: [...state.history, record],
  }
  return {
    state: next,
    effects: [{ kind: 'arm_ttft', attemptId: next.attemptId, ms: next.ttftMs }],
  }
}

function handleSetChosen(
  state: AttemptState,
  e: { providerID: string; modelID: string },
): ReducerResult {
  const next: AttemptState = {
    ...state,
    chosenProviderID: e.providerID,
    chosenModelID: e.modelID,
  }
  return { state: next, effects: [] }
}

function handleAbort(
  state: AttemptState,
  e: { sessionID: string; now: number },
): ReducerResult {
  if (e.sessionID !== state.sessionID) return noOp(state)
  const next: AttemptState = {
    ...state,
    watchdog: 'idle',
    pauseReason: null,
    failoverInFlight: false,
  }
  return {
    state: next,
    effects: [{ kind: 'clear_timer', attemptId: state.attemptId }],
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noOp(state: AttemptState): ReducerResult {
  return { state, effects: [] }
}

// ---------------------------------------------------------------------------
// Queries (pure, no side effects)
// ---------------------------------------------------------------------------

/** Whether the effective model differs from the user's chosen model. */
export function isFailedOver(state: AttemptState): boolean {
  if (!state.effectiveProviderID || !state.chosenProviderID) return false
  return (
    state.effectiveProviderID !== state.chosenProviderID ||
    state.effectiveModelID !== state.chosenModelID
  )
}

/** Whether auto-retry is safe (no side effects have occurred). */
export function canAutoRetry(state: AttemptState): boolean {
  return !state.toolExecuted && !state.hasStreamed
}
