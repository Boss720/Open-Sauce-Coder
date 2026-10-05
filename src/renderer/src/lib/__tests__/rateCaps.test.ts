import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  capsFor,
  currentRateUsage,
  LEDGER_STORAGE_KEY,
  loadLedger,
  nextAvailableAt,
  record429,
  recordInputTokens,
  recordTokens,
  reserveAttempt,
  rpdWindowEnd,
  rpdWindowStart,
  underRateCaps,
  type Ledger,
  type ModelCapsMap,
  type ModelHealth
} from '../routing'
import { FREE_MODEL_TIERS, FREE_PROVIDER_CAPS, GEMINI_LIVE_CAPS } from '../freeTier'

/** A ledger entry with the given send timestamps and otherwise-neutral health. */
function health(sends: number[], overrides: Partial<ModelHealth> = {}): ModelHealth {
  return {
    cooldownUntil: 0,
    cooldownMs: 30000,
    success: 0,
    error: 0,
    last429: null,
    latencyEwma: null,
    sends,
    ...overrides
  }
}

const HOUR = 3600_000
const DAY = 86400_000

describe('rate-cap scoping (capsFor)', () => {
  const caps: ModelCapsMap = {
    google: { rpm: 10, rpd: 250 },
    'google/gemini-2.5-flash-lite': { rpm: 15, rpd: 1000 }
  }

  it('prefers a provider/model entry over the bare provider entry', () => {
    expect(capsFor(caps, 'google/gemini-2.5-flash-lite')).toEqual({
      caps: { rpm: 15, rpd: 1000 },
      scope: 'model'
    })
  })

  it('falls back to the provider entry for a model with no specific caps', () => {
    expect(capsFor(caps, 'google/gemini-3.6-flash')).toEqual({
      caps: { rpm: 10, rpd: 250 },
      scope: 'provider'
    })
  })

  it('returns null for an unknown provider and for an unparseable key', () => {
    expect(capsFor(caps, 'openai/gpt-5')).toBeNull()
    expect(capsFor(caps, 'nokey')).toBeNull()
  })
})

describe('cap scope decides what gets counted', () => {
  const now = 1700000000000

  it('a model-scoped cap ignores sibling models on the same provider', () => {
    // Google enforces per model per project, so a busy Flash must not throttle Flash-Lite.
    const caps: ModelCapsMap = {
      'google/gemini-3.6-flash': { rpm: 2 },
      'google/gemini-2.5-flash-lite': { rpm: 2 }
    }
    const ledger: Ledger = {
      'google/gemini-3.6-flash': health([now - 20000, now - 10000]),
      'google/gemini-2.5-flash-lite': health([])
    }
    expect(underRateCaps(ledger, 'google/gemini-3.6-flash', caps, now)).toBe(false)
    expect(underRateCaps(ledger, 'google/gemini-2.5-flash-lite', caps, now)).toBe(true)
  })

  it('a provider-scoped cap aggregates every model on that provider', () => {
    // OpenRouter's free allowance is account-wide, so siblings do share it.
    const caps: ModelCapsMap = { openrouter: { rpm: 2 } }
    const ledger: Ledger = {
      'openrouter/a:free': health([now - 20000]),
      'openrouter/b:free': health([now - 10000])
    }
    expect(underRateCaps(ledger, 'openrouter/a:free', caps, now)).toBe(false)
  })
})

describe('opaque providers are not pre-throttled on rpm', () => {
  const now = 1700000000000

  it('ignores a guessed rpm gate but still honours the rpd gate', () => {
    const caps: ModelCapsMap = { mistral: { rpm: 2, rpd: 10 } }
    const overRpm = health([now - 30_000, now - 20_000, now - 10_000])
    expect(underRateCaps({ 'mistral/devstral-latest': overRpm }, 'mistral/devstral-latest', caps, now)).toBe(true)

    const overRpd = health(Array.from({ length: 10 }, (_, i) => now - (i + 1) * 60_000))
    expect(underRateCaps({ 'mistral/devstral-latest': overRpd }, 'mistral/devstral-latest', caps, now)).toBe(false)
  })

  it('still enforces rpm for a provider that publishes it', () => {
    const caps: ModelCapsMap = { google: { rpm: 2 } }
    const ledger: Ledger = { 'google/x': health([now - 20_000, now - 10_000]) }
    expect(underRateCaps(ledger, 'google/x', caps, now)).toBe(false)
  })

  it('reports no rpm wait time for an opaque provider', () => {
    const caps: ModelCapsMap = { mistral: { rpm: 1 } }
    const ledger: Ledger = { 'mistral/x': health([now - 1000]) }
    expect(nextAvailableAt(['mistral/x'], ledger, caps, now)).toEqual({ key: 'mistral/x', at: now })
  })
})

describe('daily window boundaries', () => {
  // 2026-07-29T20:34Z is 13:34 PDT — the same Pacific day, 07:00Z was midnight.
  const midDay = Date.UTC(2026, 6, 29, 20, 34, 0)

  it('day-pt starts at the most recent Pacific midnight', () => {
    expect(rpdWindowStart(midDay, 'day-pt')).toBe(Date.UTC(2026, 6, 29, 7, 0, 0))
  })

  it('day-pt ends at the next Pacific midnight', () => {
    expect(rpdWindowEnd(midDay, 'day-pt')).toBe(Date.UTC(2026, 6, 30, 7, 0, 0))
  })

  it('resolves the correct local midnight on the spring-forward day', () => {
    // 2026-03-08: PST → PDT at 02:00 local. Local midnight is still PST (UTC-8),
    // so subtracting the *current* PDT offset would land an hour early.
    const afterTransition = Date.UTC(2026, 2, 8, 20, 0, 0)
    expect(rpdWindowStart(afterTransition, 'day-pt')).toBe(Date.UTC(2026, 2, 8, 8, 0, 0))
  })

  it('resolves the correct local midnight on the fall-back day', () => {
    // 2026-11-01: PDT → PST at 02:00 local. Local midnight is still PDT (UTC-7).
    const afterTransition = Date.UTC(2026, 10, 1, 20, 0, 0)
    expect(rpdWindowStart(afterTransition, 'day-pt')).toBe(Date.UTC(2026, 10, 1, 7, 0, 0))
  })

  it('handles the 25-hour fall-back day without ending the window early', () => {
    const duringLongDay = Date.UTC(2026, 10, 1, 20, 0, 0)
    const end = rpdWindowEnd(duringLongDay, 'day-pt')
    expect(end).toBe(Date.UTC(2026, 10, 2, 8, 0, 0))
    expect(end - rpdWindowStart(duringLongDay, 'day-pt')).toBe(25 * HOUR)
  })

  it('rolling-24h is a plain trailing window', () => {
    expect(rpdWindowStart(midDay, 'rolling-24h')).toBe(midDay - DAY)
    expect(rpdWindowStart(midDay, undefined)).toBe(midDay - DAY)
  })

  it('counts a send from earlier today but not one from yesterday evening', () => {
    const caps: ModelCapsMap = { 'google/x': { rpd: 1, rpdWindow: 'day-pt' } }
    const yesterdayEvening = Date.UTC(2026, 6, 29, 3, 0, 0) // 20:00 PDT on the 28th
    const thisMorning = Date.UTC(2026, 6, 29, 15, 0, 0) // 08:00 PDT on the 29th

    // A rolling window would still be counting yesterday's send and block; the
    // real quota reset at midnight PT, so the model is usable.
    expect(underRateCaps({ 'google/x': health([yesterdayEvening]) }, 'google/x', caps, midDay)).toBe(true)
    expect(underRateCaps({ 'google/x': health([thisMorning]) }, 'google/x', caps, midDay)).toBe(false)
  })
})

describe('record429 daily parking', () => {
  const now = Date.UTC(2026, 6, 29, 20, 34, 0)

  it('parks a daily exhaustion until the Pacific reset instead of 120s', () => {
    const caps: ModelCapsMap = { 'google/x': { rpd: 1, rpdWindow: 'day-pt' } }
    const updated = record429({}, 'google/x', now, 60_000, { daily: true, caps })
    expect(updated['google/x'].cooldownUntil).toBe(Date.UTC(2026, 6, 30, 7, 0, 0))
  })

  it('honours a Retry-After longer than the computed reset', () => {
    const caps: ModelCapsMap = { 'google/x': { rpd: 1, rpdWindow: 'day-pt' } }
    const twoDays = 2 * DAY
    const updated = record429({}, 'google/x', now, twoDays, { daily: true, caps })
    expect(updated['google/x'].cooldownUntil).toBe(now + twoDays)
  })

  it('parks a rolling-window provider until its oldest send ages out', () => {
    const ledger: Ledger = { 'mistral/x': health([now - 6 * HOUR, now - HOUR]) }
    const updated = record429(ledger, 'mistral/x', now, undefined, {
      daily: true,
      caps: { mistral: { rpd: 2 } }
    })
    expect(updated['mistral/x'].cooldownUntil).toBe(now - 6 * HOUR + DAY + 1)
  })

  it('still caps a plain rpm wait at 120s', () => {
    const updated = record429({}, 'google/x', now, 600_000)
    expect(updated['google/x'].cooldownUntil).toBe(now + 120_000)
  })
})

describe('nextAvailableAt', () => {
  const now = 1700000000000

  it('reports when an RPM-capped model frees a slot', () => {
    const caps: ModelCapsMap = { 'google/x': { rpm: 2 } }
    const oldest = now - 40_000
    const ledger: Ledger = { 'google/x': health([oldest, now - 10_000]) }
    expect(nextAvailableAt(['google/x'], ledger, caps, now)).toEqual({
      key: 'google/x',
      at: oldest + 60_001
    })
  })

  it('picks the candidate that recovers soonest', () => {
    const caps: ModelCapsMap = {}
    const ledger: Ledger = {
      'google/slow': health([], { cooldownUntil: now + 10 * 60_000 }),
      'groq/fast': health([], { cooldownUntil: now + 60_000 })
    }
    expect(nextAvailableAt(['google/slow', 'groq/fast'], ledger, caps, now)?.key).toBe('groq/fast')
  })

  it('returns now for a model that is already usable', () => {
    const result = nextAvailableAt(['google/x'], {}, {}, now)
    expect(result).toEqual({ key: 'google/x', at: now })
  })

  it('returns null for an empty pool', () => {
    expect(nextAvailableAt([], {}, {}, now)).toBeNull()
  })

  it('returns null for a permanently zero quota instead of a misleading retry time', () => {
    expect(nextAvailableAt(['google/unavailable'], {}, { 'google/unavailable': { rpd: 0 } }, now)).toBeNull()
    expect(nextAvailableAt(['google/unavailable'], {}, { 'google/unavailable': { rpm: 0 } }, now)).toBeNull()
  })

  it('includes burst-window expiration in recovery estimates', () => {
    const caps: ModelCapsMap = { nanogpt: { burst: { count: 2, windowMs: 10_000 } } }
    const oldest = now - 8_000
    const ledger: Ledger = { 'nanogpt/a': health([oldest, now - 1000]) }
    expect(nextAvailableAt(['nanogpt/a'], ledger, caps, now)).toEqual({ key: 'nanogpt/a', at: oldest + 10_001 })
  })
})

describe('TPM accounting', () => {
  const now = 1700000000000

  it('blocks a model whose trailing-minute tokens reach the cap', () => {
    const caps: ModelCapsMap = { 'google/x': { tpm: 250_000 } }
    let ledger: Ledger = {}
    ledger = recordTokens(ledger, 'google/x', 150_000, now - 30_000)
    expect(underRateCaps(ledger, 'google/x', caps, now)).toBe(true)
    ledger = recordTokens(ledger, 'google/x', 100_000, now - 10_000)
    expect(underRateCaps(ledger, 'google/x', caps, now)).toBe(false)
  })

  it('forgets tokens older than the trailing minute', () => {
    const caps: ModelCapsMap = { 'google/x': { tpm: 100 } }
    const ledger = recordTokens({}, 'google/x', 500, now - 61_000)
    expect(underRateCaps(ledger, 'google/x', caps, now)).toBe(true)
  })

  it('ignores non-positive and non-finite token counts', () => {
    expect(recordTokens({}, 'google/x', 0, now)).toEqual({})
    expect(recordTokens({}, 'google/x', -5, now)).toEqual({})
    expect(recordTokens({}, 'google/x', Number.NaN, now)).toEqual({})
  })

  it('aggregates tokens provider-wide only for a provider-scoped cap', () => {
    const modelScoped: ModelCapsMap = { 'google/a': { tpm: 100 }, 'google/b': { tpm: 100 } }
    const providerScoped: ModelCapsMap = { google: { tpm: 100 } }
    let ledger: Ledger = {}
    ledger = recordTokens(ledger, 'google/a', 60, now - 1000)
    ledger = recordTokens(ledger, 'google/b', 60, now - 1000)
    expect(underRateCaps(ledger, 'google/a', modelScoped, now)).toBe(true)
    expect(underRateCaps(ledger, 'google/a', providerScoped, now)).toBe(false)
  })

  it('reports when the token window frees up', () => {
    const caps: ModelCapsMap = { 'google/x': { tpm: 100 } }
    const oldest = now - 40_000
    let ledger: Ledger = {}
    ledger = recordTokens(ledger, 'google/x', 80, oldest)
    ledger = recordTokens(ledger, 'google/x', 40, now - 5_000)
    expect(nextAvailableAt(['google/x'], ledger, caps, now)).toEqual({
      key: 'google/x',
      at: oldest + 60_001
    })
  })

  it('uses input-only token events when the cap is documented as input TPM', () => {
    const caps: ModelCapsMap = { 'google/x': { tpm: 100, tpmTokens: 'input' } }
    let ledger: Ledger = {}
    ledger = recordTokens(ledger, 'google/x', 150, now - 1000)
    expect(underRateCaps(ledger, 'google/x', caps, now)).toBe(true)
    ledger = recordInputTokens(ledger, 'google/x', 100, now - 1000)
    expect(underRateCaps(ledger, 'google/x', caps, now)).toBe(false)
    expect(currentRateUsage(ledger, 'google/x', caps, now)?.tokensPerMinute).toBe(100)
  })

  it('reports local RPM, RPD, burst, token use, and configured scope together', () => {
    const caps: ModelCapsMap = { nanogpt: { rpm: 4, rpd: 10, burst: { count: 2, windowMs: 10_000 } } }
    const ledger: Ledger = { 'nanogpt/a': health([now - 5000, now - 1000]) }
    expect(currentRateUsage(ledger, 'nanogpt/a', caps, now)).toMatchObject({
      scope: 'provider', requestsPerMinute: 2, requestsPerDay: 2, burstRequests: 2, tokensPerMinute: 0
    })
  })

  it('survives a ledger written before tokenEvents existed', () => {
    const legacy: Ledger = { 'google/x': health([now - 1000]) }
    expect(legacy['google/x'].tokenEvents).toBeUndefined()
    expect(underRateCaps(legacy, 'google/x', { 'google/x': { tpm: 1 } }, now)).toBe(true)
    expect(recordTokens(legacy, 'google/x', 10, now)['google/x'].tokenEvents).toEqual([[now, 10]])
  })
})

describe("Google caps match the account's AI Studio dashboard, not the public docs", () => {
  // Denominators from the supplied AI Studio snapshot on 2026-10-05. The values are
  // account-specific; screenshot numerators show 28-day peak use, not current usage.
  const expected: Record<string, { rpm: number; rpd: number; tpm: number }> = {
    'google/gemini-3.6-flash': { rpm: 5, rpd: 20, tpm: 250_000 },
    'google/gemini-3.8-flash': { rpm: 5, rpd: 20, tpm: 250_000 },
    'google/gemini-3.7-flash': { rpm: 5, rpd: 20, tpm: 250_000 },
    'google/gemini-3.5-flash': { rpm: 5, rpd: 20, tpm: 250_000 },
    'google/gemini-3-flash-preview': { rpm: 5, rpd: 20, tpm: 250_000 },
    'google/gemini-2.5-flash': { rpm: 5, rpd: 20, tpm: 250_000 },
    'google/gemini-3.5-flash-lite': { rpm: 15, rpd: 500, tpm: 250_000 },
    'google/gemini-3.1-flash-lite': { rpm: 15, rpd: 500, tpm: 250_000 },
    'google/gemini-2.5-flash-lite': { rpm: 10, rpd: 20, tpm: 250_000 },
    'google/gemma-4-26b-a4b-it': { rpm: 30, rpd: 14400, tpm: 16_000 },
    'google/gemma-4-31b-it': { rpm: 30, rpd: 14400, tpm: 16_000 }
  }

  for (const [key, want] of Object.entries(expected)) {
    it(`${key} is ${want.rpm} rpm / ${want.rpd} rpd / ${want.tpm} tpm`, () => {
      const resolved = capsFor(FREE_PROVIDER_CAPS, key)
      expect(resolved?.scope).toBe('model')
      expect(resolved?.caps).toEqual({ ...want, tpmTokens: 'input', rpdWindow: 'day-pt' })
    })
  }

  it('does not match the old incorrect Gemma aliases', () => {
    expect(capsFor(FREE_PROVIDER_CAPS, 'google/gemma-4-26b')?.scope).toBe('provider')
    expect(capsFor(FREE_PROVIDER_CAPS, 'google/gemma-4-31b')?.scope).toBe('provider')
  })

  it('falls back to the strictest Google tier for an unrecognised model', () => {
    // A new Flash-Lite the registry has not learned about yet must NOT inherit 500/day.
    const resolved = capsFor(FREE_PROVIDER_CAPS, 'google/gemini-4-flash-lite')
    expect(resolved?.scope).toBe('provider')
    expect(resolved?.caps.rpd).toBe(20)
    expect(resolved?.caps.rpm).toBe(5)
  })

  it('gives Live API models a token budget and no request caps', () => {
    for (const [key, caps] of Object.entries(GEMINI_LIVE_CAPS)) {
      expect(caps.tpm, `${key} needs a tpm`).toBeGreaterThan(0)
      expect(caps.rpm, `${key} must not carry an rpm`).toBeUndefined()
      expect(caps.rpd, `${key} must not carry an rpd`).toBeUndefined()
    }
  })
})

describe('FREE_PROVIDER_CAPS is the single source of truth', () => {
  it('agrees with every per-model rpm in the tier registry', () => {
    for (const entry of FREE_MODEL_TIERS) {
      const resolved = capsFor(FREE_PROVIDER_CAPS, `${entry.providerID}/${entry.modelID}`)
      expect(resolved, `${entry.providerID}/${entry.modelID} has no caps`).not.toBeNull()
      expect(resolved!.caps.rpm, `rpm mismatch for ${entry.providerID}/${entry.modelID}`).toBe(entry.rpm)
    }
  })

  it('agrees with every declared per-model rpd in the tier registry', () => {
    for (const entry of FREE_MODEL_TIERS) {
      if (entry.rpd === null) continue
      const resolved = capsFor(FREE_PROVIDER_CAPS, `${entry.providerID}/${entry.modelID}`)
      expect(resolved!.caps.rpd, `rpd mismatch for ${entry.providerID}/${entry.modelID}`).toBe(entry.rpd)
    }
  })

  it('gives every Google entry a Pacific daily window', () => {
    for (const entry of FREE_MODEL_TIERS.filter((e) => e.providerID === 'google')) {
      const resolved = capsFor(FREE_PROVIDER_CAPS, `${entry.providerID}/${entry.modelID}`)
      expect(resolved!.caps.rpdWindow).toBe('day-pt')
    }
  })
})

describe('25-hour Pacific day ledger retention', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps a send older than 24 hours so a 25-hour quota day is still counted', () => {
    const now = Date.UTC(2026, 10, 2, 7, 30)
    const send = Date.UTC(2026, 10, 1, 7, 1) // 24h29m old during the 25-hour DST day
    const oldHealth = health([send])
    expect(reserveAttempt({ 'google/x': oldHealth }, 'google/x', now)['google/x'].sends).toEqual([send, now])

    vi.useFakeTimers()
    vi.setSystemTime(now)
    const data: Record<string, string> = {
      [LEDGER_STORAGE_KEY]: JSON.stringify({ 'google/x': oldHealth })
    }
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => { data[key] = value },
      removeItem: (key: string) => { delete data[key] },
      clear: () => { for (const key of Object.keys(data)) delete data[key] }
    })
    expect(loadLedger()['google/x'].sends).toContain(send)
  })
})
