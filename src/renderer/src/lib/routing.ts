/**
 * Smart routing v2 — proactive health-ledger router for model selection.
 *
 * Pure module, no store import, no React.
 */

import { freeCodingQuality, OPAQUE_RPM_PROVIDERS, isSubscriptionProvider, isFreeModel } from './freeTier'
// Type-only: erased at compile time, so this module stays free of the localStorage in prefs.ts.
import type { RoutingMode } from './prefs'

export type ModelKey = string // format "providerID/modelID"

/**
 * True when the app may switch models on its own.
 *
 * The single predicate behind every auto-routing indicator. It MUST stay identical to the
 * condition the failover gates test — `attemptMachine.recoverHungAttempt`, `eventSlice`'s
 * 429 path and `sessionSlice`'s reactive failover all check `routingMode !== 'locked'`.
 * Previously the indicators read a separate `autoRotate` boolean that no gate consulted, so
 * a user in `locked` mode saw a "⚡ auto" badge while every failover was silently suppressed.
 */
export function isAutoRoutingActive(mode: RoutingMode): boolean {
  return mode !== 'locked'
}

/** Short human label for a routing mode, for `/models`, `/doctor` and status surfaces. */
export function describeRoutingMode(mode: RoutingMode): string {
  if (mode === 'locked') return 'Locked (your chosen model runs every turn; errors surface immediately)'
  if (mode === 'failover') return 'Failover (your pin is kept; switches to a healthy free model on 429 or stall)'
  return 'Auto (pre-selects the healthiest model on every send; may override your pick)'
}

/**
 * Split a model key on its first slash only. Model IDs may themselves contain
 * slashes (for example, `openrouter/qwen/qwen3-coder:free`).
 */
export function parseModelKey(key: ModelKey): { providerID: string; modelID: string } | null {
  const separator = key.indexOf('/')
  if (separator <= 0 || separator === key.length - 1) return null
  return { providerID: key.slice(0, separator), modelID: key.slice(separator + 1) }
}

export type ModelHealth = {
  cooldownUntil: number
  cooldownMs: number
  success: number
  error: number
  last429: number | null
  latencyEwma: number | null
  sends: number[] // epoch-ms timestamps; retain 48h for 25h Pacific quota days
  /**
   * `[epochMs, totalTokens]` per completed request, pruned to the last hour.
   * Separate from `sends` because a send carries no token count until it finishes,
   * and absent on ledgers written before TPM accounting existed — always read it
   * defensively.
   */
  tokenEvents?: Array<[number, number]>
  /** `[epochMs, inputTokens]` for provider limits defined on input tokens only. */
  inputTokenEvents?: Array<[number, number]>
}

export type Ledger = Record<ModelKey, ModelHealth>

/**
 * How a provider's daily allowance resets.
 * - `rolling-24h` (default): safe when the reset boundary is undocumented. Never
 *   over-sends, but keeps a model parked for up to a full day after exhaustion.
 * - `day-pt`: a real calendar reset at midnight Pacific, which is what Google
 *   documents. Using the rolling window for those would strand the model for
 *   hours after the quota had already come back.
 */
export type RpdWindow = 'rolling-24h' | 'day-pt'

export type ProviderCaps = {
  rpm?: number
  rpd?: number
  /**
   * Tokens per minute. For Google Flash this is the limit that actually bites: the
   * account dashboard shows models sitting at 266K and 383K against a 250K ceiling
   * while nowhere near their request counts. Enforced from observed usage after the
   * fact (see `tokenEvents`) — a pre-send estimate would need the prompt tokenised,
   * which the renderer cannot do.
   */
  tpm?: number
  /** Google reports input TPM; other entries default to total observed tokens. */
  tpmTokens?: 'input' | 'total'
  rpdWindow?: RpdWindow
  burst?: { count: number; windowMs: number }
}

/**
 * Keyed by `providerID` OR `providerID/modelID`; the specific entry wins and its
 * key decides the counting scope. See FREE_PROVIDER_CAPS in freeTier.ts — that is
 * the one table both the router and the UI read.
 */
export type ModelCapsMap = Record<string, ProviderCaps>

export const LEDGER_STORAGE_KEY = 'opencode-desktop:routing-ledger'

const DAY_MS = 86400000
const SEND_EVENT_RETENTION_MS = 48 * 3600_000

const PT_ZONE = 'America/Los_Angeles'

let ptFormatter: Intl.DateTimeFormat | null | undefined

/** Cached formatter, or null when the runtime has no ICU time-zone data. */
function getPtFormatter(): Intl.DateTimeFormat | null {
  if (ptFormatter !== undefined) return ptFormatter
  try {
    ptFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: PT_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    ptFormatter = null
  }
  return ptFormatter
}

type WallClock = { year: number; month: number; day: number; ms: number }

/** The Pacific wall-clock reading at an instant, or null without ICU data. */
function ptWallClock(t: number): WallClock | null {
  const fmt = getPtFormatter()
  if (fmt === null) return null
  const parts = fmt.formatToParts(new Date(t))
  const read = (type: string): number => {
    const raw = parts.find((p) => p.type === type)?.value
    const n = raw === undefined ? NaN : Number(raw)
    return n
  }
  const year = read('year')
  const month = read('month')
  const day = read('day')
  const hour = read('hour')
  const minute = read('minute')
  const second = read('second')
  if (![year, month, day, hour, minute, second].every((n) => Number.isFinite(n))) return null
  return { year, month, day, ms: ((hour * 60 + minute) * 60 + second) * 1000 }
}

/** Zone offset in ms at an instant: wall clock read as UTC, minus the instant. */
function ptOffsetMs(t: number): number | null {
  const wall = ptWallClock(t)
  if (wall === null) return null
  const asUTC = Date.UTC(wall.year, wall.month - 1, wall.day) + wall.ms
  return asUTC - (t - (t % 1000))
}

/**
 * Epoch ms of the most recent midnight in Pacific time.
 *
 * Naively subtracting the elapsed wall-clock time is wrong on the two DST
 * transition days — the offset at midnight differs from the offset now, which
 * skews the boundary by an hour. So this resolves the local calendar date, then
 * converts that date's midnight back to an instant using the offset in effect at
 * that instant, re-evaluated once because the first guess can land on the far
 * side of a transition.
 */
function ptDayStart(now: number): number | null {
  const wall = ptWallClock(now)
  if (wall === null) return null
  const utcMidnight = Date.UTC(wall.year, wall.month - 1, wall.day)
  const firstOffset = ptOffsetMs(utcMidnight)
  if (firstOffset === null) return null
  const guess = utcMidnight - firstOffset
  const settledOffset = ptOffsetMs(guess)
  if (settledOffset === null) return null
  return utcMidnight - settledOffset
}

/** Start of the current window for a daily allowance. */
export function rpdWindowStart(now: number, window: RpdWindow | undefined): number {
  if (window === 'day-pt') {
    const start = ptDayStart(now)
    // Without ICU data, fall through to the rolling window: it never over-sends.
    if (start !== null) return start
  }
  return now - DAY_MS
}

/** When the current daily window ends, i.e. the earliest time the allowance returns. */
export function rpdWindowEnd(now: number, window: RpdWindow | undefined, oldestSend?: number): number {
  if (window === 'day-pt') {
    const start = ptDayStart(now)
    if (start !== null) {
      // Next local midnight, not start + 24h: the DST days are 23h and 25h long.
      const nextGuess = ptDayStart(start + DAY_MS + 3 * 3600_000)
      if (nextGuess !== null && nextGuess > now) return nextGuess
      return start + DAY_MS
    }
  }
  // Rolling: the allowance frees up one slot at a time as old sends age out.
  // `underRateCaps` includes a send exactly on the rolling-window boundary.
  return (oldestSend ?? now) + DAY_MS + 1
}

/**
 * Resolve the caps that apply to a model, and the scope its counters use.
 * A `providerID/modelID` entry means the provider enforces the limit per model,
 * so only that model's sends count. A bare `providerID` entry means the limit is
 * account-wide and every send to the provider counts against it.
 */
export function capsFor(
  caps: ModelCapsMap,
  key: ModelKey
): { caps: ProviderCaps; scope: 'model' | 'provider' } | null {
  const parsed = parseModelKey(key)
  if (!parsed) return null
  const exact = caps[key]
  if (exact) return { caps: exact, scope: 'model' }
  const byProvider = caps[parsed.providerID]
  if (byProvider) return { caps: byProvider, scope: 'provider' }
  return null
}

const DEFAULT_HEALTH: ModelHealth = {
  cooldownUntil: 0,
  cooldownMs: 30000,
  success: 0,
  error: 0,
  last429: null,
  latencyEwma: null,
  sends: []
}

/**
 * Record a 429 rate-limit error.
 *
 * When `retryAfterMs` is provided (from a Retry-After header), it is used
 * directly, capped at 120s. Otherwise exponential backoff applies: 30s
 * initial, doubling per consecutive 429, capped at 30 minutes.
 */
export function record429(
  ledger: Ledger,
  key: ModelKey,
  now: number,
  retryAfterMs?: number,
  opts?: { daily?: boolean; caps?: ModelCapsMap }
): Ledger {
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }

  let newCooldownMs: number
  if (opts?.daily === true) {
    // A daily allowance does not come back in two minutes. Capping this at 120s
    // like an RPM wait meant an exhausted model was re-selected every couple of
    // minutes for the rest of the day, burning a failover cycle each time and
    // guaranteeing another 429. Park it until the allowance actually resets.
    const window = opts.caps ? capsFor(opts.caps, key)?.caps.rpdWindow : undefined
    const oldestSend = existing.sends.length > 0 ? Math.min(...existing.sends) : undefined
    const untilReset = rpdWindowEnd(now, window, oldestSend) - now
    newCooldownMs = Math.max(retryAfterMs ?? 0, untilReset, 60_000)
  } else if (retryAfterMs !== undefined) {
    newCooldownMs = Math.min(120_000, Math.max(1000, retryAfterMs))
  } else {
    const isConsecutive = existing.cooldownUntil > now || (existing.last429 !== null && now - existing.last429 <= existing.cooldownMs + 60000)
    newCooldownMs = isConsecutive ? Math.min(1800000, existing.cooldownMs * 2) : 30000
  }

  return {
    ...ledger,
    [key]: {
      ...existing,
      cooldownUntil: now + newCooldownMs,
      cooldownMs: newCooldownMs,
      last429: now
    }
  }
}

/**
 * Reserve an outbound attempt before it is sent. Rate caps count attempts,
 * including calls that fail or never complete.
 */
export function reserveAttempt(ledger: Ledger, key: ModelKey, now: number): Ledger {
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  const sends = existing.sends.filter((t) => t <= now && now - t <= SEND_EVENT_RETENTION_MS)
  sends.push(now)

  return {
    ...ledger,
    [key]: {
      ...existing,
      sends
    }
  }
}

/**
 * Release a reserved attempt that failed before dispatch completed.
 * Removes the most recent send timestamp so it does not count against caps.
 */
export function releaseAttempt(ledger: Ledger, key: ModelKey): Ledger {
  const existing = ledger[key]
  if (!existing || existing.sends.length === 0) return ledger
  return {
    ...ledger,
    [key]: {
      ...existing,
      sends: existing.sends.slice(0, -1)
    }
  }
}

/**
 * Record a successful request completion. Attempts must be reserved with
 * `reserveAttempt` before dispatch so completion timing cannot bypass caps.
 */
export function recordSuccess(ledger: Ledger, key: ModelKey, latencyMs: number, _now: number): Ledger {
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  const newCooldownMs = Math.max(30000, Math.floor(existing.cooldownMs / 2))
  const newEwma = existing.latencyEwma === null ? latencyMs : 0.3 * latencyMs + 0.7 * existing.latencyEwma

  return {
    ...ledger,
    [key]: {
      ...existing,
      cooldownUntil: 0,
      cooldownMs: newCooldownMs,
      success: existing.success + 1,
      latencyEwma: newEwma
    }
  }
}

/**
 * Record a non-429 request failure.
 * Increments error count without modifying cooldowns.
 */
export function recordFailure(ledger: Ledger, key: ModelKey, _now: number): Ledger {
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  return {
    ...ledger,
    [key]: {
      ...existing,
      error: existing.error + 1
    }
  }
}

/**
 * Record a request that made no progress before the watchdog deadline. A timeout
 * is temporarily treated as unhealthy so the next route cannot immediately pick
 * the same hung model.
 */
export function recordTimeout(ledger: Ledger, key: ModelKey, now: number): Ledger {
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  const cooldownMs = Math.min(300000, Math.max(30000, existing.cooldownMs))
  return {
    ...ledger,
    [key]: {
      ...existing,
      error: existing.error + 1,
      cooldownMs,
      cooldownUntil: now + cooldownMs
    }
  }
}

/**
 * Check if a model is under conservative rate caps (RPM / RPD).
 */
export function underRateCaps(
  ledger: Ledger,
  key: ModelKey,
  caps: ModelCapsMap,
  now: number,
  opts?: { nanoQuotaExhausted?: boolean }
): boolean {
  const parsed = parseModelKey(key)
  if (!parsed) return false

  if (parsed.providerID === 'nanogpt' && opts?.nanoQuotaExhausted === true) {
    return false
  }

  const resolved = capsFor(caps, key)
  if (!resolved) return true

  const sends = sendsInScope(ledger, key, resolved.scope)

  // No `sends.length === 0` shortcut: token usage is tracked separately, so an empty
  // send list does not imply an idle model. It also means a declared cap of 0 blocks
  // correctly — which is what the AI Studio dashboard's `0/0` rows are (Pro, Veo,
  // Nano Banana have no free quota at all).
  const cap = resolved.caps
  // Providers that stopped publishing their RPM get no pre-emptive minute gate: the
  // table's number is a guess, and blocking on a guess costs more than the one
  // request it takes to learn the truth. A real 429 still parks them via record429's
  // exponential backoff, so the ceiling is discovered rather than assumed.
  const enforceRpm = cap.rpm !== undefined && !OPAQUE_RPM_PROVIDERS.has(parsed.providerID)
  if (enforceRpm) {
    const rpmSends = sends.filter((t) => t <= now && now - t <= 60000).length
    if (rpmSends >= (cap.rpm as number)) return false
  }

  if (cap.burst !== undefined) {
    const burstSends = sends.filter((t) => t <= now && now - t <= cap.burst!.windowMs).length
    if (burstSends >= cap.burst.count) return false
  }

  if (cap.rpd !== undefined) {
    const windowStart = rpdWindowStart(now, cap.rpdWindow)
    const rpdSends = sends.filter((t) => t >= windowStart && t <= now).length
    if (rpdSends >= cap.rpd) return false
  }

  // TPM last, because it is the one most likely to be the real blocker on Google
  // Flash and the one the router previously ignored entirely.
  if (cap.tpm !== undefined) {
    const used = cap.tpmTokens === 'input'
      ? inputTokensInLastMinute(ledger, key, resolved.scope, now)
      : tokensInLastMinute(ledger, key, resolved.scope, now)
    if (used >= cap.tpm) return false
  }

  return true
}

const TOKEN_EVENT_RETENTION_MS = 3600_000

/**
 * Record the token cost of a completed request, for TPM accounting.
 * Called alongside `recordSuccess`; a request whose token count never arrives simply
 * does not contribute, which errs toward sending rather than blocking.
 */
export function recordTokens(ledger: Ledger, key: ModelKey, tokens: number, now: number): Ledger {
  if (!Number.isFinite(tokens) || tokens <= 0) return ledger
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  const kept = (existing.tokenEvents ?? []).filter(([t]) => t <= now && now - t <= TOKEN_EVENT_RETENTION_MS)
  kept.push([now, Math.round(tokens)])
  return { ...ledger, [key]: { ...existing, tokenEvents: kept } }
}

/** Record input tokens separately for providers whose TPM counts prompt tokens only. */
export function recordInputTokens(ledger: Ledger, key: ModelKey, tokens: number, now: number): Ledger {
  if (!Number.isFinite(tokens) || tokens <= 0) return ledger
  const existing = ledger[key] ?? { ...DEFAULT_HEALTH }
  const kept = (existing.inputTokenEvents ?? []).filter(([time]) => time <= now && now - time <= TOKEN_EVENT_RETENTION_MS)
  kept.push([now, Math.round(tokens)])
  return { ...ledger, [key]: { ...existing, inputTokenEvents: kept } }
}

/** Token events counted against a cap, per its scope. */
function tokenEventsInScope(
  ledger: Ledger,
  key: ModelKey,
  scope: 'model' | 'provider'
): Array<[number, number]> {
  if (scope === 'model') return ledger[key]?.tokenEvents ?? []
  const providerID = parseModelKey(key)?.providerID
  if (providerID === undefined) return []
  const entries: Array<[number, number]> = []
  for (const [modelKey, health] of Object.entries(ledger)) {
    if (parseModelKey(modelKey)?.providerID !== providerID) continue
    entries.push(...(health.tokenEvents ?? []))
  }
  return entries
}

/** Tokens observed in the trailing 60s within a cap's scope. */
function tokensInLastMinute(ledger: Ledger, key: ModelKey, scope: 'model' | 'provider', now: number): number {
  let total = 0
  for (const [t, tokens] of tokenEventsInScope(ledger, key, scope)) {
    if (t <= now && now - t <= 60000) total += tokens
  }
  return total
}

/** Input token events counted against a cap, per its scope. */
function inputTokenEventsInScope(
  ledger: Ledger,
  key: ModelKey,
  scope: 'model' | 'provider'
): Array<[number, number]> {
  const providerID = parseModelKey(key)?.providerID
  if (scope === 'model') return ledger[key]?.inputTokenEvents ?? []
  if (providerID === undefined) return []
  return Object.entries(ledger)
    .filter(([modelKey]) => parseModelKey(modelKey)?.providerID === providerID)
    .flatMap(([, health]) => health.inputTokenEvents ?? [])
}

function inputTokensInLastMinute(ledger: Ledger, key: ModelKey, scope: 'model' | 'provider', now: number): number {
  return inputTokenEventsInScope(ledger, key, scope)
    .reduce((sum, [time, tokens]) => sum + (time <= now && now - time <= 60000 ? tokens : 0), 0)
}

/** Send timestamps counted against a cap, per its scope. */
function sendsInScope(ledger: Ledger, key: ModelKey, scope: 'model' | 'provider'): number[] {
  if (scope === 'model') return ledger[key]?.sends ?? []
  const providerID = parseModelKey(key)?.providerID
  if (providerID === undefined) return []
  return Object.entries(ledger)
    .filter(([modelKey]) => parseModelKey(modelKey)?.providerID === providerID)
    .flatMap(([, health]) => health.sends)
}

export type CurrentRateUsage = {
  caps: ProviderCaps
  scope: 'model' | 'provider'
  requestsPerMinute: number
  requestsPerDay: number
  burstRequests: number
  tokensPerMinute: number
}

/** Local ledger usage and limits, resolved with the same scope as the throttle. */
export function currentRateUsage(
  ledger: Ledger,
  key: ModelKey,
  caps: ModelCapsMap,
  now: number
): CurrentRateUsage | null {
  const resolved = capsFor(caps, key)
  if (!resolved) return null
  const sends = sendsInScope(ledger, key, resolved.scope)
  const cap = resolved.caps
  const windowStart = rpdWindowStart(now, cap.rpdWindow)
  const tokensPerMinute = cap.tpmTokens === 'input'
    ? inputTokensInLastMinute(ledger, key, resolved.scope, now)
    : tokensInLastMinute(ledger, key, resolved.scope, now)

  return {
    caps: cap,
    scope: resolved.scope,
    requestsPerMinute: sends.filter((t) => t <= now && now - t <= 60000).length,
    requestsPerDay: sends.filter((t) => t >= windowStart && t <= now).length,
    burstRequests: cap.burst
      ? sends.filter((t) => t <= now && now - t <= cap.burst!.windowMs).length
      : 0,
    tokensPerMinute
  }
}

/**
 * Model-level rate cap check — counts only sends for this specific model,
 * NOT all models from the same provider. Use when you need to know whether
 * a specific model is individually throttled vs provider-wide throttling.
 */
export function underModelRateCaps(ledger: Ledger, key: ModelKey, caps: ModelCapsMap, now: number): boolean {
  const parsed = parseModelKey(key)
  if (!parsed) return false
  const cap = caps[parsed.providerID]
  if (!cap) return true

  const health = ledger[key]
  if (!health || health.sends.length === 0) return true

  if (cap.rpm !== undefined) {
    const rpmSends = health.sends.filter((t) => t <= now && now - t <= 60000).length
    if (rpmSends >= cap.rpm) return false
  }

  if (cap.rpd !== undefined) {
    const rpdSends = health.sends.filter((t) => t <= now && now - t <= 86400000).length
    if (rpdSends >= cap.rpd) return false
  }

  return true
}

export type CandidateDetail = {
  key: ModelKey
  score: number
  quality: number
  latency: number | null
  costTier: 'free' | 'subscription' | 'paid'
  rejectedReason?: string
}

export type ModelSelectionExplanation = {
  selected: ModelKey | null
  reason: string
  candidates: CandidateDetail[]
}

/** Classify a model key into free, subscription, or paid tier. */
export function getCostTier(key: ModelKey): 'free' | 'subscription' | 'paid' {
  const parsed = parseModelKey(key)
  if (!parsed) return 'paid'
  if (isSubscriptionProvider(parsed.providerID)) return 'subscription'
  if (isFreeModel(parsed.providerID, parsed.modelID)) return 'free'
  return 'paid'
}

function evaluateCandidate(
  key: ModelKey,
  ledger: Ledger,
  caps: ModelCapsMap,
  now: number,
  opts: { available: ReadonlySet<ModelKey> },
  isAuthenticatedCandidate: (key: ModelKey) => boolean
): CandidateDetail {
  const quality = codingQuality(key)
  const costTier = getCostTier(key)
  const health = ledger[key]
  const latency = health?.latencyEwma ?? null

  if (!opts.available.has(key)) {
    return { key, score: -1, quality, latency, costTier, rejectedReason: 'Not available on server' }
  }

  if (!isAuthenticatedCandidate(key)) {
    return { key, score: -1, quality, latency, costTier, rejectedReason: 'Provider not authenticated' }
  }

  const isOutofCooldown = !health || health.cooldownUntil <= now
  if (!isOutofCooldown) {
    const remainingSec = Math.ceil((health.cooldownUntil - now) / 1000)
    return {
      key,
      score: -1,
      quality,
      latency,
      costTier,
      rejectedReason: `Cooldown active (${remainingSec}s left)`
    }
  }

  if (!underRateCaps(ledger, key, caps, now)) {
    return { key, score: -1, quality, latency, costTier, rejectedReason: 'Rate limit cap reached' }
  }

  if (health) {
    const total = health.success + health.error
    if (total >= 5 && health.success / total < 0.2) {
      const pct = Math.round((health.success / total) * 100)
      return {
        key,
        score: -1,
        quality,
        latency,
        costTier,
        rejectedReason: `High failure rate (${pct}% success over ${total} runs)`
      }
    }
  }

  const h = health ?? DEFAULT_HEALTH
  const total = h.success + h.error
  const successRatio = total > 0 ? h.success / total : 1.0
  const latencyPenalty = h.latencyEwma !== null ? Math.min(1.0, h.latencyEwma / 5000) : 0.0
  const recent429Penalty = h.last429 !== null ? Math.max(0, 1 - (now - h.last429) / 3600000) : 0.0

  const healthScore = successRatio - latencyPenalty * 0.3 - recent429Penalty * 0.5
  const qualityNorm = quality / 6
  const score = healthScore + qualityNorm * 0.12

  return { key, score, quality, latency, costTier }
}

/**
 * Score and select the optimal model from a pool based on health ledger statistics,
 * returning full explanation and candidate evaluation details.
 */
export function selectModelDetailed(
  pool: ModelKey[] | null,
  ledger: Ledger,
  caps: ModelCapsMap,
  now: number,
  opts: {
    sticky: boolean
    current: ModelKey | null
    available: ReadonlySet<ModelKey>
    authenticatedProviders: ReadonlySet<string>
  }
): ModelSelectionExplanation {
  const candidatePool = pool && pool.length > 0 ? pool : Array.from(opts.available)
  const candidateDetails: CandidateDetail[] = []

  const isAuthenticatedCandidate = (key: ModelKey): boolean => {
    const parsed = parseModelKey(key)
    return Boolean(parsed && opts.authenticatedProviders.has(parsed.providerID))
  }

  // Sticky model preference: if sticky mode is enabled and current model is healthy, stay put.
  if (opts.sticky && opts.current && opts.available.has(opts.current) && isAuthenticatedCandidate(opts.current)) {
    const health = ledger[opts.current]
    const isOutofCooldown = !health || health.cooldownUntil <= now
    if (isOutofCooldown && underRateCaps(ledger, opts.current, caps, now)) {
      for (const key of candidatePool) {
        candidateDetails.push(evaluateCandidate(key, ledger, caps, now, opts, isAuthenticatedCandidate))
      }
      if (!candidatePool.includes(opts.current)) {
        candidateDetails.unshift(evaluateCandidate(opts.current, ledger, caps, now, opts, isAuthenticatedCandidate))
      }
      return {
        selected: opts.current,
        reason: 'Preserved current model (sticky selection enabled and model is healthy)',
        candidates: candidateDetails
      }
    }
  }

  for (const key of candidatePool) {
    candidateDetails.push(evaluateCandidate(key, ledger, caps, now, opts, isAuthenticatedCandidate))
  }

  const healthyCandidates = candidateDetails
    .map((c, poolIndex) => ({ ...c, poolIndex }))
    .filter((c) => !c.rejectedReason && c.score >= 0)

  if (healthyCandidates.length === 0) {
    return {
      selected: null,
      reason: 'No healthy candidates available; all candidates are cooling down, rate-limited, or unauthenticated',
      candidates: candidateDetails
    }
  }

  healthyCandidates.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 1e-6) {
      return b.score - a.score // highest score first
    }
    if (a.quality !== b.quality) return b.quality - a.quality
    return a.key < b.key ? -1 : a.key > b.key ? 1 : a.poolIndex - b.poolIndex
  })

  const winner = healthyCandidates[0]
  const latencyStr = winner.latency !== null ? `${Math.round(winner.latency)}ms latency` : 'no latency history'
  const reason = `Selected ${winner.key}: score ${(winner.score * 100).toFixed(0)}%, coding quality ${winner.quality}/6, ${latencyStr} (${winner.costTier} tier)`

  return {
    selected: winner.key,
    reason,
    candidates: candidateDetails
  }
}

/**
 * Score and select the optimal model from a pool based on health ledger statistics.
 */
export function selectModel(
  pool: ModelKey[] | null,
  ledger: Ledger,
  caps: ModelCapsMap,
  now: number,
  opts: { sticky: boolean; current: ModelKey | null; available: ReadonlySet<ModelKey>; authenticatedProviders: ReadonlySet<string> }
): ModelKey | null {
  return selectModelDetailed(pool, ledger, caps, now, opts).selected
}

/**
 * Earliest moment any candidate becomes usable again, for when `selectModel`
 * returns null because everything is cooling down or capped. Without this the
 * only thing to show the user is the raw provider error from the last attempt,
 * which says nothing about when to try again.
 *
 * Returns null when no candidate can ever recover on its own (empty pool, or
 * every model failing for a non-rate reason).
 */
export function nextAvailableAt(
  pool: ModelKey[],
  ledger: Ledger,
  caps: ModelCapsMap,
  now: number
): { key: ModelKey; at: number } | null {
  let best: { key: ModelKey; at: number } | null = null

  for (const key of pool) {
    const health = ledger[key]
    let at = health?.cooldownUntil !== undefined && health.cooldownUntil > now ? health.cooldownUntil : now
    const resolved = capsFor(caps, key)
    let canRecover = true

    if (resolved) {
      const sends = sendsInScope(ledger, key, resolved.scope)
      const cap = resolved.caps
      const providerID = parseModelKey(key)?.providerID

      // Zero limits never recover with time. Ignore this candidate instead of
      // promising a retry at `now` (or producing an invalid timestamp).
      if (
        (cap.rpm !== undefined && cap.rpm <= 0 && providerID !== undefined && !OPAQUE_RPM_PROVIDERS.has(providerID)) ||
        (cap.rpd !== undefined && cap.rpd <= 0) ||
        (cap.burst !== undefined && cap.burst.count <= 0) ||
        (cap.tpm !== undefined && cap.tpm <= 0)
      ) canRecover = false

      // Mirrors underRateCaps: an unenforced guess must not produce a wait time either.
      if (canRecover && cap.rpm !== undefined && providerID !== undefined && !OPAQUE_RPM_PROVIDERS.has(providerID)) {
        const inWindow = sends.filter((t) => t <= now && now - t <= 60000).sort((a, b) => a - b)
        // At the cap, a slot frees just after the oldest send reaches 60s.
        if (inWindow.length >= cap.rpm) at = Math.max(at, inWindow[inWindow.length - cap.rpm] + 60001)
      }

      if (canRecover && cap.burst !== undefined) {
        const inWindow = sends.filter((t) => t <= now && now - t <= cap.burst!.windowMs).sort((a, b) => a - b)
        if (inWindow.length >= cap.burst.count) {
          const requiredToExpire = inWindow.length - cap.burst.count
          at = Math.max(at, inWindow[requiredToExpire] + cap.burst.windowMs + 1)
        }
      }

      if (canRecover && cap.rpd !== undefined) {
        const windowStart = rpdWindowStart(now, cap.rpdWindow)
        const inWindow = sends.filter((t) => t >= windowStart && t <= now).sort((a, b) => a - b)
        if (inWindow.length >= cap.rpd) {
          at = Math.max(at, rpdWindowEnd(now, cap.rpdWindow, inWindow[inWindow.length - cap.rpd]))
        }
      }

      if (canRecover && cap.tpm !== undefined) {
        const useInput = cap.tpmTokens === 'input'
        const used = useInput
          ? inputTokensInLastMinute(ledger, key, resolved.scope, now)
          : tokensInLastMinute(ledger, key, resolved.scope, now)
        if (used >= cap.tpm) {
          // Shed the oldest token events until the trailing total would fit; the
          // window clears 60s after the last one that had to go.
          const sourceEvents = useInput
            ? inputTokenEventsInScope(ledger, key, resolved.scope)
            : tokenEventsInScope(ledger, key, resolved.scope)
          const events = sourceEvents
            .filter(([t]) => t <= now && now - t <= 60000)
            .sort((a, b) => a[0] - b[0])
          let remaining = used
          let freesAt = now
          for (const [t, tokens] of events) {
            remaining -= tokens
            freesAt = t + 60001
            if (remaining < cap.tpm) break
          }
          at = Math.max(at, freesAt)
        }
      }
    }

    if (!canRecover) continue
    if (best === null || at < best.at) best = { key, at }
  }

  return best
}

/** Higher values indicate a stronger likely coding model, using provider/model IDs only. */
export function codingQuality(key: ModelKey): number {
  const parsed = parseModelKey(key)
  if (!parsed) return 0

  // Prefer tier-based score from the curated free registry
  const tierScore = freeCodingQuality(parsed.providerID, parsed.modelID)
  if (tierScore !== null) return tierScore

  // Regex fallback for paid / unknown models
  const id = `${parsed.providerID}/${parsed.modelID}`.toLowerCase()
  if (/(gpt-5\.[45]|codex)/.test(id)) return 6
  if (/(gpt-5|claude.*opus)/.test(id)) return 5
  if (/claude.*sonnet/.test(id)) return 4
  if (/(claude|gemini.*pro|deepseek.*(coder|reasoner))/.test(id)) return 4
  if (/(coder|gpt-oss|qwen3|gemini)/.test(id)) return 3
  if (/(deepseek|llama|mistral|command-r)/.test(id)) return 2
  return 1
}

function getLocalStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  if (typeof globalThis !== 'undefined' && (globalThis as unknown as { localStorage?: Storage }).localStorage) {
    return (globalThis as unknown as { localStorage: Storage }).localStorage
  }
  return null
}

/**
 * Load and prune routing ledger from localStorage.
 */
export function loadLedger(): Ledger {
  try {
    const storage = getLocalStorage()
    if (!storage) return {}
    const raw = storage.getItem(LEDGER_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Ledger
    const now = Date.now()
    const pruned: Ledger = {}

    for (const [key, health] of Object.entries(parsed)) {
      if (!health || typeof health !== 'object') continue
      const sends = Array.isArray(health.sends)
        ? health.sends.filter((t) => typeof t === 'number' && t <= now && now - t <= SEND_EVENT_RETENTION_MS)
        : []
      const cooldownUntil = typeof health.cooldownUntil === 'number' && health.cooldownUntil > now ? health.cooldownUntil : 0
      const success = typeof health.success === 'number' ? health.success : 0
      const error = typeof health.error === 'number' ? health.error : 0

      // Absent on any ledger written before TPM accounting, and each element must be
      // validated individually — a corrupt entry here would silently poison the
      // trailing-minute total and could block a healthy model indefinitely.
      const tokenEvents = Array.isArray(health.tokenEvents)
        ? health.tokenEvents.filter(
            (e): e is [number, number] =>
              Array.isArray(e) &&
              e.length === 2 &&
              typeof e[0] === 'number' &&
              typeof e[1] === 'number' &&
              Number.isFinite(e[0]) &&
              Number.isFinite(e[1]) &&
              e[1] > 0 &&
              e[0] <= now && now - e[0] <= TOKEN_EVENT_RETENTION_MS
          )
        : []
      const inputTokenEvents = Array.isArray(health.inputTokenEvents)
        ? health.inputTokenEvents.filter(
            (e): e is [number, number] =>
              Array.isArray(e) &&
              e.length === 2 &&
              typeof e[0] === 'number' &&
              typeof e[1] === 'number' &&
              Number.isFinite(e[0]) &&
              Number.isFinite(e[1]) &&
              e[1] > 0 &&
              e[0] <= now &&
              now - e[0] <= TOKEN_EVENT_RETENTION_MS
          )
        : []

      // Omit empty useless entries
      if (sends.length === 0 && success === 0 && error === 0 && cooldownUntil === 0 && tokenEvents.length === 0 && inputTokenEvents.length === 0) {
        continue
      }

      pruned[key] = {
        cooldownUntil,
        cooldownMs: typeof health.cooldownMs === 'number' ? health.cooldownMs : 30000,
        success,
        error,
        last429: typeof health.last429 === 'number' ? health.last429 : null,
        latencyEwma: typeof health.latencyEwma === 'number' ? health.latencyEwma : null,
        sends,
        ...(tokenEvents.length > 0 ? { tokenEvents } : {}),
        ...(inputTokenEvents.length > 0 ? { inputTokenEvents } : {})
      }
    }

    return pruned
  } catch {
    return {}
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Save routing ledger to localStorage with ~500ms debounce.
 */
export function saveLedger(ledger: Ledger): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      const storage = getLocalStorage()
      if (storage) {
        storage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(ledger))
      }
    } catch {
      // Storage write best-effort
    }
  }, 500)
}
