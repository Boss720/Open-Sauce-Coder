/**
 * The single-exchange attempt machine: watchdogs, routing ledger, and failover.
 *
 * WHY THIS IS ONE MODULE. Every piece of mutable state below is a SINGLETON by design —
 * one in-flight attempt, one ledger, one retry counter, one recovery-abort marker. If any
 * of it were duplicated per slice, a proactive pick and a reactive retry could interleave
 * against stale snapshots and the failover guards would stop meaning anything. Slices reach
 * this state only through the accessors here, so there is exactly one copy.
 *
 * `store.ts` runs this as a mirror of `attempts.ts` (the pure reducer that CONTRACTS.md calls
 * the executable spec). That duplication is pre-existing and deliberately left alone here.
 */

import {
  loadLedger,
  saveLedger,
  recordFailure,
  recordTimeout,
  reserveAttempt,
  releaseAttempt,
  type Ledger
} from '../routing'
import { api, errText } from './api'
import { store } from './storeRef'
import { READONLY_TOOLS } from '../toolPolicies'
import type { PromptPart } from '../types'

/* ------------------------------------------------------------------ *
 * Singleton mutable state
 * ------------------------------------------------------------------ */

export interface LastPrompt {
  text: string
  parts?: PromptPart[]
  sessionID: string
  /** The user message id that opened this exchange, for revertMessage transactionality. */
  userMessageID: string | null
  policy?: { agent?: string; tools?: Record<string, boolean> }
}

export type ActiveAttempt = {
  attemptId: number
  sessionID: string
  providerID: string
  modelID: string
  startedAt: number
  ttftTimer: ReturnType<typeof setTimeout> | null
  stallTimer: ReturnType<typeof setTimeout> | null
  hasStreamed: boolean
  toolExecuted: boolean
  pausedForTool: boolean
  pausedForPermission: boolean
  failoverInFlight: boolean
  /** The user message id that opened this exchange, for revertMessage transactionality. */
  userMessageID: string | null
}

let lastPrompt: LastPrompt | null = null
let rotateRetries = 0
let routingLedger: Ledger = {}
let lastSendStartTime: number | null = null
const DEFAULT_TTFT_MS = 20_000
const DEFAULT_STALL_MS = 90_000
let attemptCounter = 0
let activeAttempt: ActiveAttempt | null = null
let abortForRecoverySessionID: string | null = null

/* ------------------------------------------------------------------ *
 * Accessors — the only way slices touch the singletons
 * ------------------------------------------------------------------ */

/** The live attempt object. Callers may mutate its fields; there is only ever one. */
export function getActiveAttempt(): ActiveAttempt | null {
  return activeAttempt
}

export function getLastPrompt(): LastPrompt | null {
  return lastPrompt
}

export function setLastPrompt(next: LastPrompt | null): void {
  lastPrompt = next
}

export function getLedger(): Ledger {
  return routingLedger
}

export function setLedger(next: Ledger): void {
  routingLedger = next
}

/** Read the persisted ledger back in. Called once from `init()`. */
export function restoreLedger(): void {
  routingLedger = loadLedger()
}

export function getRotateRetries(): number {
  return rotateRetries
}

export function resetRotateRetries(): void {
  rotateRetries = 0
}

export function setLastSendStartTime(next: number | null): void {
  lastSendStartTime = next
}

export function getLastSendStartTime(): number | null {
  return lastSendStartTime
}

export function getAbortForRecoverySessionID(): string | null {
  return abortForRecoverySessionID
}

export function setAbortForRecoverySessionID(next: string | null): void {
  abortForRecoverySessionID = next
}

/* ------------------------------------------------------------------ *
 * Attempt lifecycle
 * ------------------------------------------------------------------ */

export function clearActiveAttempt(sessionID?: string): void {
  if (!activeAttempt || (sessionID && activeAttempt.sessionID !== sessionID)) return
  if (activeAttempt.ttftTimer) clearTimeout(activeAttempt.ttftTimer)
  if (activeAttempt.stallTimer) clearTimeout(activeAttempt.stallTimer)
  activeAttempt = null
}

function getTtftMs(): number {
  return store().getState().appSettings.ttftMs ?? DEFAULT_TTFT_MS
}

function getStallMs(): number {
  return store().getState().appSettings.stallMs ?? DEFAULT_STALL_MS
}

/** TTFT watchdog — fires if no tokens arrive within ttftMs. */
function armTtftWatchdog(): void {
  if (!activeAttempt) return
  if (activeAttempt.ttftTimer) clearTimeout(activeAttempt.ttftTimer)
  const watched = activeAttempt
  watched.ttftTimer = setTimeout(() => {
    void recoverHungAttempt(watched, 'ttft')
  }, getTtftMs())
}

/** Stall watchdog — re-armed on each new part; paused during tool/permission. */
export function armStallWatchdog(): void {
  if (!activeAttempt) return
  if (activeAttempt.stallTimer) clearTimeout(activeAttempt.stallTimer)
  if (activeAttempt.pausedForTool || activeAttempt.pausedForPermission) return
  const watched = activeAttempt
  watched.stallTimer = setTimeout(() => {
    void recoverHungAttempt(watched, 'stall')
  }, getStallMs())
}

export function startActiveAttempt(sessionID: string, providerID: string, modelID: string): void {
  clearActiveAttempt()
  attemptCounter += 1
  activeAttempt = {
    attemptId: attemptCounter,
    sessionID,
    providerID,
    modelID,
    startedAt: Date.now(),
    ttftTimer: null,
    stallTimer: null,
    hasStreamed: false,
    toolExecuted: false,
    pausedForTool: false,
    pausedForPermission: false,
    failoverInFlight: false,
    userMessageID: lastPrompt?.userMessageID ?? null,
  }
  armTtftWatchdog()
}

/** Called on message.part.updated — clears TTFT and (re)arms stall. */
export function touchActiveAttempt(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  if (activeAttempt.ttftTimer) {
    clearTimeout(activeAttempt.ttftTimer)
    activeAttempt.ttftTimer = null
  }
  activeAttempt.hasStreamed = true
  armStallWatchdog()
}

/** Called when a tool part enters running state — pauses stall. */
export function markToolStarted(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  activeAttempt.toolExecuted = true
  activeAttempt.pausedForTool = true
  if (activeAttempt.stallTimer) {
    clearTimeout(activeAttempt.stallTimer)
    activeAttempt.stallTimer = null
  }
}

export function markToolCompleted(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  activeAttempt.pausedForTool = false
  armStallWatchdog()
}

export function markPermissionAsked(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  activeAttempt.pausedForPermission = true
  if (activeAttempt.stallTimer) {
    clearTimeout(activeAttempt.stallTimer)
    activeAttempt.stallTimer = null
  }
}

export function markPermissionReplied(sessionID: string): void {
  if (!activeAttempt || activeAttempt.sessionID !== sessionID) return
  activeAttempt.pausedForPermission = false
  armStallWatchdog()
}

/**
 * Parse Retry-After / X-RateLimit-Reset from ApiError.responseHeaders.
 * Returns milliseconds until the endpoint suggests we retry, or undefined.
 */
export function parseRetryAfterMs(headers: Record<string, string> | undefined | null): number | undefined {
  if (!headers) return undefined
  const normalized: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) normalized[k.toLowerCase()] = v

  const retryAfter = normalized['retry-after']
  if (retryAfter) {
    const asInt = parseInt(retryAfter, 10)
    if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000
    const asDate = Date.parse(retryAfter)
    if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now())
  }

  const rlReset = normalized['x-ratelimit-reset'] ?? normalized['x-ratelimit-reset-after']
  if (rlReset) {
    const asInt = parseInt(rlReset, 10)
    if (Number.isFinite(asInt)) {
      // Heuristic: > 10^10 → epoch seconds, > 10^12 → epoch ms, else duration
      if (asInt > 10_000_000_000) return Math.max(0, asInt - Date.now())
      if (asInt > 1_000_000_000) return Math.max(0, asInt * 1000 - Date.now())
      return asInt * 1000
    }
  }
  return undefined
}

/**
 * Single-entry failover. Reverts the user message, picks the next free model,
 * and re-prompts. Idempotent — a second call while a failover is in flight
 * returns immediately without duplicating work (R3).
 *
 * Returns true if a retry was dispatched, false if the caller should surface
 * the error normally (all fallbacks exhausted or unsafe to retry).
 */
function getHarnessPolicy(sessionID: string): { agent?: string; tools?: Record<string, boolean> } {
  const state = store().getState()
  const agent = state.sessionAgents?.[sessionID]
  const readOnly = state.sessionReadOnly?.[sessionID] === true
  return {
    ...(agent ? { agent } : {}),
    ...(readOnly ? { tools: { ...READONLY_TOOLS } } : {})
  }
}

export async function beginFailover(
  sessionID: string,
  directory: string,
  text: string,
  parts: PromptPart[] | undefined,
  reason: string,
  failedModelKey?: string,
  failedProviderID?: string,
  policySnapshot?: { agent?: string; tools?: Record<string, boolean> }
): Promise<boolean> {
  // Guard: single-entry
  if (activeAttempt?.failoverInFlight) return true
  if (activeAttempt) activeAttempt.failoverInFlight = true

  // Guard: per-exchange retry cap
  if (rotateRetries >= 3) {
    store().getState().addSystemNotice(
      `⚠️ **Retry cap reached (3/3).** Auto model rotation gave up after repeated errors. Send again or switch models manually. (${reason})`
    )
    return false
  }

  // Guard: last prompt must be for this session and have a user message id
  const prompt = lastPrompt
  if (!prompt || prompt.sessionID !== sessionID || !prompt.userMessageID) {
    return false
  }

  // R1 guard: only fail over when nothing has committed side effects
  if (activeAttempt && (activeAttempt.toolExecuted || activeAttempt.hasStreamed)) {
    store().getState().addSystemNotice(
      `⚠️ **Cannot auto-retry: side effects already committed** (tools run or tokens streamed). Send again to try a different model.`
    )
    return false
  }

  // Rotate to next free model BEFORE revert, so we know we have somewhere to go
  const rotated = store().getState().rotateToNextFreeModel(failedModelKey, failedProviderID)
  if (!rotated) return false

  // Transactional: revert on the server before re-prompting
  try {
    await api().revertMessage({ directory, sessionID, messageID: prompt.userMessageID })
  } catch (error) {
    store().getState().addSystemNotice(
      `⚠️ **Auto-retry aborted: could not revert to the last user message.** ${errText(error)}`
    )
    return false
  }

  rotateRetries += 1
  store().getState().addSystemNotice(
    `⚡ **Failover:** switched to **${rotated.providerName} · ${rotated.modelName}** and retrying (${rotateRetries}/3). Reason: ${reason}`
  )

  lastSendStartTime = Date.now()
  routingLedger = reserveAttempt(routingLedger, `${rotated.providerID}/${rotated.modelID}`, lastSendStartTime)
  saveLedger(routingLedger)
  startActiveAttempt(sessionID, rotated.providerID, rotated.modelID)
  store().setState({ busy: true, error: null })

  const effectivePolicy = policySnapshot ?? prompt.policy ?? getHarnessPolicy(sessionID)

  try {
    await api().prompt({
      directory,
      sessionID,
      providerID: rotated.providerID,
      modelID: rotated.modelID,
      text,
      parts,
      ...effectivePolicy
    })
    return true
  } catch (error) {
    clearActiveAttempt(sessionID)
    routingLedger = recordFailure(routingLedger, `${rotated.providerID}/${rotated.modelID}`, Date.now())
    routingLedger = releaseAttempt(routingLedger, `${rotated.providerID}/${rotated.modelID}`)
    saveLedger(routingLedger)
    setAttemptFailure(errText(error))
    return true
  }
}

export async function recoverHungAttempt(attempt: ActiveAttempt, kind: 'ttft' | 'stall'): Promise<void> {
  if (activeAttempt !== attempt) return
  const state = store().getState()
  if (!state.busy || state.activeSessionID !== attempt.sessionID) return
  if (state.routingMode === 'locked' || !state.directory) return

  const now = Date.now()
  const failedKey = `${attempt.providerID}/${attempt.modelID}`
  routingLedger = recordTimeout(routingLedger, failedKey, now)
  saveLedger(routingLedger)

  // R1: if any tool ran or tokens streamed, do NOT auto-retry
  if (attempt.toolExecuted || attempt.hasStreamed) {
    clearActiveAttempt(attempt.sessionID)
    setAttemptFailure(
      kind === 'ttft'
        ? 'Model stopped responding before first token.'
        : 'Model went quiet mid-response. Send again to continue.'
    )
    return
  }

  abortForRecoverySessionID = attempt.sessionID
  try {
    await api().abort(state.directory, attempt.sessionID)
  } catch (error) {
    abortForRecoverySessionID = null
    clearActiveAttempt(attempt.sessionID)
    setAttemptFailure(`Timed-out request could not be safely aborted: ${errText(error)}`)
    return
  }
  clearActiveAttempt(attempt.sessionID)

  const prompt = lastPrompt
  const directory = state.directory
  if (!prompt || !directory) {
    setAttemptFailure('Model request timed out before it could be retried.')
    return
  }

  const reason = kind === 'ttft'
    ? `No response after ${Math.round(getTtftMs() / 1000)}s`
    : `No progress after ${Math.round(getStallMs() / 1000)}s`

  const failedOver = await beginFailover(
    attempt.sessionID,
    directory,
    prompt.text,
    prompt.parts,
    reason,
    failedKey,
  )
  if (!failedOver) {
    setAttemptFailure(`${reason}. No other free model available.`)
  }
}

export function setAttemptFailure(error: string): void {
  clearActiveAttempt()
  lastSendStartTime = null
  store().setState({ busy: false, error })
}
