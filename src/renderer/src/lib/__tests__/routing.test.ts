import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  record429,
  reserveAttempt,
  recordSuccess,
  recordFailure,
  underRateCaps,
  underModelRateCaps,
  releaseAttempt,
  selectModel,
  selectModelDetailed,
  getCostTier,
  parseModelKey,
  codingQuality,
  loadLedger,
  saveLedger,
  LEDGER_STORAGE_KEY,
  type Ledger,
  type ModelKey,
  type ModelCapsMap,
  type ModelSelectionExplanation
} from '../routing'

describe('Smart routing v2 (routing.ts)', () => {
  const now = 1700000000000
  const modelA = 'google/gemini-2.5-flash'
  const modelB = 'groq/llama-3.3-70b-versatile'
  const modelC = 'cerebras/gpt-oss-120b'

  describe('record429', () => {
    it('sets initial 30s cooldown on first 429', () => {
      const ledger: Ledger = {}
      const updated = record429(ledger, modelA, now)
      expect(updated[modelA].cooldownMs).toBe(30000)
      expect(updated[modelA].cooldownUntil).toBe(now + 30000)
      expect(updated[modelA].last429).toBe(now)
    })

    it('doubles cooldown on consecutive 429s up to 30 minutes', () => {
      let ledger: Ledger = {}
      ledger = record429(ledger, modelA, now)
      expect(ledger[modelA].cooldownMs).toBe(30000)

      // Second consecutive 429 while cooling down
      ledger = record429(ledger, modelA, now + 10000)
      expect(ledger[modelA].cooldownMs).toBe(60000)
      expect(ledger[modelA].cooldownUntil).toBe(now + 10000 + 60000)

      // Multiple 429s capped at 1800000ms (30m)
      for (let i = 0; i < 10; i++) {
        ledger = record429(ledger, modelA, now + 20000 + i * 1000)
      }
      expect(ledger[modelA].cooldownMs).toBe(1800000)
      expect(ledger[modelA].cooldownUntil).toBe(now + 20000 + 9000 + 1800000)
    })
  })

  describe('recordSuccess', () => {
    it('clears cooldownUntil and updates EWMA latency without double-counting a reserved send', () => {
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: now + 30000,
          cooldownMs: 60000,
          success: 2,
          error: 0,
          last429: now - 10000,
          latencyEwma: 1000,
          sends: [now - 100000]
        }
      }

      const updated = recordSuccess(ledger, modelA, 500, now)
      expect(updated[modelA].cooldownUntil).toBe(0)
      expect(updated[modelA].cooldownMs).toBe(30000) // halved from 60000
      expect(updated[modelA].success).toBe(3)
      expect(updated[modelA].latencyEwma).toBe(0.3 * 500 + 0.7 * 1000)
      expect(updated[modelA].sends).toEqual([now - 100000])
    })

    it('reserves attempts before dispatch and prunes sends older than 48h', () => {
      const oldTime = now - 49 * 3600_000 // beyond the 25-hour Pacific day safety window
      const recentTime = now - 10000 // 10s ago
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 1,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [oldTime, recentTime]
        }
      }

      const updated = reserveAttempt(ledger, modelA, now)
      expect(updated[modelA].sends).toEqual([recentTime, now])
    })
  })

  describe('recordFailure', () => {
    it('increments error count without touching cooldowns', () => {
      const ledger: Ledger = {}
      const updated = recordFailure(ledger, modelA, now)
      expect(updated[modelA].error).toBe(1)
      expect(updated[modelA].cooldownUntil).toBe(0)
    })
  })

  describe('underRateCaps', () => {
    const caps: ModelCapsMap = {
      google: { rpm: 2, rpd: 5 },
      groq: { rpm: 10 }
    }

    it('returns true when sends are under limits', () => {
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 1,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [now - 10000]
        }
      }
      expect(underRateCaps(ledger, modelA, caps, now)).toBe(true)
    })

    it('returns false when RPM cap is exceeded', () => {
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 2,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [now - 20000, now - 10000]
        }
      }
      expect(underRateCaps(ledger, modelA, caps, now)).toBe(false)
    })

    it('returns false when RPD cap is exceeded', () => {
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 5,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [
            now - 5000000,
            now - 4000000,
            now - 3000000,
            now - 2000000,
            now - 1000000
          ]
        }
      }
      expect(underRateCaps(ledger, modelA, caps, now)).toBe(false)
    })

    it('aggregates rate caps across models from the same provider', () => {
      const ledger: Ledger = {
        [modelA]: { cooldownUntil: 0, cooldownMs: 30000, success: 0, error: 0, last429: null, latencyEwma: null, sends: [now - 10000] },
        'google/gemini-2.5-pro': { cooldownUntil: 0, cooldownMs: 30000, success: 0, error: 0, last429: null, latencyEwma: null, sends: [now - 5000] }
      }
      expect(underRateCaps(ledger, modelA, caps, now)).toBe(false)
    })

    it('parses nested model IDs without losing any segment', () => {
      expect(parseModelKey('openrouter/qwen/qwen3-coder:free')).toEqual({
        providerID: 'openrouter',
        modelID: 'qwen/qwen3-coder:free'
      })
      expect(parseModelKey('invalid')).toBeNull()
    })
  })

  describe('selectModel', () => {
    const available = new Set([modelA, modelB, modelC])
    const caps: ModelCapsMap = {}

    it('honors sticky mode if sticky model is healthy and available', () => {
      const ledger: Ledger = {}
      const picked = selectModel(null, ledger, caps, now, {
        sticky: true,
        current: modelB,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      expect(picked).toBe(modelB)
    })

    it('falls back to scoring when sticky model is in cooldown', () => {
      const ledger: Ledger = {
        [modelB]: {
          cooldownUntil: now + 60000,
          cooldownMs: 60000,
          success: 0,
          error: 1,
          last429: now,
          latencyEwma: null,
          sends: []
        }
      }
      const picked = selectModel(null, ledger, caps, now, {
        sticky: true,
        current: modelB,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      expect(picked).toBe(modelC) // gpt-oss is favoured over generic flash
    })

    it('is deterministic when candidates have equal scores', () => {
      const ledger: Ledger = {}
      const picked1 = selectModel([modelC, modelA], ledger, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      const picked2 = selectModel([modelC, modelA], ledger, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      expect(picked1).toBe(modelC)
      expect(picked2).toBe(modelC)
    })

    it('returns null if all candidates are cooling down or capped', () => {
      const ledger: Ledger = {
        [modelA]: { cooldownUntil: now + 30000, cooldownMs: 30000, success: 0, error: 0, last429: now, latencyEwma: null, sends: [] },
        [modelB]: { cooldownUntil: now + 30000, cooldownMs: 30000, success: 0, error: 0, last429: now, latencyEwma: null, sends: [] },
        [modelC]: { cooldownUntil: now + 30000, cooldownMs: 30000, success: 0, error: 0, last429: now, latencyEwma: null, sends: [] }
      }
      const picked = selectModel(null, ledger, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })
      expect(picked).toBeNull()
    })

    it('never selects an unauthenticated provider or escapes a user pool', () => {
      const picked = selectModel([modelA], {}, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['cerebras'])
      })
      expect(picked).toBeNull()
    })

    it('can fail over away from an explicitly excluded failed model', () => {
      const candidates = new Set<ModelKey>([modelB, modelC])
      candidates.delete(modelB)
      const picked = selectModel(null, {}, caps, now, {
        sticky: false,
        current: modelB,
        available: candidates,
        authenticatedProviders: new Set(['groq', 'cerebras'])
      })
      expect(picked).toBe(modelC)
    })

    it('ranks strong coding models deterministically when no pool is set', () => {
      const models = new Set<ModelKey>([
        'google/gemini-2.5-pro',
        'anthropic/claude-sonnet-4',
        'openai/gpt-5.5-codex'
      ])
      const picked = selectModel(null, {}, caps, now, {
        sticky: false,
        current: null,
        available: models,
        authenticatedProviders: new Set(['google', 'anthropic', 'openai'])
      })
      expect(picked).toBe('openai/gpt-5.5-codex')
      expect(codingQuality('openai/gpt-5.5-codex')).toBeGreaterThan(codingQuality('google/gemini-2.5-pro'))
    })
  })

  describe('loadLedger & saveLedger', () => {
    let mockStorage: Record<string, string> = {}

    beforeEach(() => {
      mockStorage = {}
      const localStorageMock = {
        getItem: (k: string) => mockStorage[k] || null,
        setItem: (k: string, v: string) => {
          mockStorage[k] = v
        },
        removeItem: (k: string) => {
          delete mockStorage[k]
        },
        clear: () => {
          mockStorage = {}
        }
      }
      vi.stubGlobal('localStorage', localStorageMock)
    })

    it('loads and prunes ledger entries from localStorage', () => {
      mockStorage[LEDGER_STORAGE_KEY] = JSON.stringify({
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 5,
          error: 0,
          last429: null,
          latencyEwma: 300,
          sends: [Date.now() - 1000]
        },
        'expired/model': {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 0,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [Date.now() - 49 * 3600_000] // beyond the Pacific-day retention window
        }
      })

      const loaded = loadLedger()
      expect(loaded[modelA]).toBeDefined()
      expect(loaded[modelA].success).toBe(5)
      expect(loaded['expired/model']).toBeUndefined()
    })

    it('saves ledger debounced', async () => {
      vi.useFakeTimers()
      const ledger: Ledger = {
        [modelA]: {
          cooldownUntil: 0,
          cooldownMs: 30000,
          success: 1,
          error: 0,
          last429: null,
          latencyEwma: null,
          sends: [Date.now()]
        }
      }

      saveLedger(ledger)
      expect(mockStorage[LEDGER_STORAGE_KEY]).toBeUndefined() // debounced

      vi.advanceTimersByTime(600)
      expect(mockStorage[LEDGER_STORAGE_KEY]).toBeDefined()
      expect(JSON.parse(mockStorage[LEDGER_STORAGE_KEY])[modelA].success).toBe(1)
      vi.useRealTimers()
    })
  })

  describe('record429 with retryAfterMs', () => {
    it('uses retryAfterMs when provided instead of exponential backoff', () => {
      const ledger: Ledger = {}
      const updated = record429(ledger, modelA, now, 45000)
      expect(updated[modelA].cooldownMs).toBe(45000)
      expect(updated[modelA].cooldownUntil).toBe(now + 45000)
    })

    it('caps retryAfterMs at 120s for rpm-style waits', () => {
      const ledger: Ledger = {}
      const updated = record429(ledger, modelA, now, 300000)
      expect(updated[modelA].cooldownMs).toBe(120000)
      expect(updated[modelA].cooldownUntil).toBe(now + 120000)
    })

    it('falls back to exponential backoff when retryAfterMs is undefined', () => {
      let ledger: Ledger = {}
      ledger = record429(ledger, modelA, now)
      expect(ledger[modelA].cooldownMs).toBe(30000)
      ledger = record429(ledger, modelA, now + 10000)
      expect(ledger[modelA].cooldownMs).toBe(60000)
    })
  })

  describe('releaseAttempt', () => {
    it('removes the most recent send timestamp for a model', () => {
      let ledger: Ledger = {}
      ledger = reserveAttempt(ledger, modelA, now)
      ledger = reserveAttempt(ledger, modelA, now + 1000)
      expect(ledger[modelA].sends).toHaveLength(2)

      ledger = releaseAttempt(ledger, modelA)
      expect(ledger[modelA].sends).toHaveLength(1)
      expect(ledger[modelA].sends[0]).toBe(now)
    })

    it('is a no-op when model has no sends', () => {
      const ledger: Ledger = {}
      const result = releaseAttempt(ledger, modelA)
      expect(result).toEqual({})
    })
  })

  describe('underModelRateCaps (model-level, not provider-level)', () => {
    it('counts only sends for the specific model, not the whole provider', () => {
      const caps: ModelCapsMap = { google: { rpm: 2 } }
      const ledger: Ledger = {
        [modelA]: { cooldownUntil: 0, cooldownMs: 30000, success: 0, error: 0, last429: null, latencyEwma: null, sends: [now - 10000] },
        'google/gemini-2.5-pro': { cooldownUntil: 0, cooldownMs: 30000, success: 0, error: 0, last429: null, latencyEwma: null, sends: [now - 5000] }
      }
      // underRateCaps (provider-level) would see 2 sends for google and return false
      expect(underRateCaps(ledger, modelA, caps, now)).toBe(false)
      // underModelRateCaps (model-level) sees only 1 send for modelA and returns true
      expect(underModelRateCaps(ledger, modelA, caps, now)).toBe(true)
    })
  })

  describe('codingQuality with freeCodingQuality integration', () => {
    it('returns tier-based score for known free models', () => {
      expect(codingQuality('google/gemini-3.8-flash')).toBe(5) // S-tier
      expect(codingQuality('google/gemini-3.6-flash')).toBe(4) // A-tier
      expect(codingQuality('groq/openai/gpt-oss-120b')).toBe(4) // A-tier
      expect(codingQuality('groq/llama-3.3-70b-versatile')).toBe(3) // B-tier
      expect(codingQuality('groq/llama-3.1-8b-instant')).toBe(2) // C-tier
    })

    it('falls back to regex scoring for unknown models', () => {
      expect(codingQuality('openai/gpt-5.5-codex')).toBe(6)
      expect(codingQuality('anthropic/claude-sonnet-4')).toBe(4)
    })
  })

  describe('selectModel with success-ratio floor (R11)', () => {
    it('skips models with >= 5 attempts and < 20% success ratio', () => {
      const caps: ModelCapsMap = {}
      const available = new Set([modelA, modelB])
      const ledger: Ledger = {
        [modelA]: { cooldownUntil: 0, cooldownMs: 30000, success: 0, error: 6, last429: null, latencyEwma: null, sends: [] },
        [modelB]: { cooldownUntil: 0, cooldownMs: 30000, success: 3, error: 1, last429: null, latencyEwma: null, sends: [] }
      }
      const picked = selectModel(null, ledger, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['google', 'groq'])
      })
      expect(picked).toBe(modelB)
    })
  })

  describe('getCostTier', () => {
    it('classifies subscription, free, and paid models accurately', () => {
      expect(getCostTier('nanogpt/claude-3-5-sonnet')).toBe('subscription')
      expect(getCostTier('google/gemini-3.6-flash')).toBe('free')
      expect(getCostTier('groq/llama-3.3-70b-versatile')).toBe('free')
      expect(getCostTier('openai/gpt-4o')).toBe('paid')
      expect(getCostTier('invalid-key')).toBe('paid')
    })
  })

  describe('selectModelDetailed (M3 explainable balanced routing)', () => {
    const caps: ModelCapsMap = {
      groq: { rpm: 2 }
    }

    it('returns transparent scoring, candidate breakdown, and rationale', () => {
      const available = new Set([modelA, modelB, modelC])
      const ledger: Ledger = {
        [modelA]: { cooldownUntil: 0, cooldownMs: 30000, success: 10, error: 0, last429: null, latencyEwma: 250, sends: [] },
        [modelB]: { cooldownUntil: 0, cooldownMs: 30000, success: 5, error: 1, last429: null, latencyEwma: 800, sends: [] },
        [modelC]: { cooldownUntil: 0, cooldownMs: 30000, success: 1, error: 0, last429: null, latencyEwma: null, sends: [] }
      }

      const detailed: ModelSelectionExplanation = selectModelDetailed(null, ledger, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })

      expect(detailed.selected).toBe(modelC)
      expect(detailed.reason).toContain('Selected cerebras/gpt-oss-120b')
      expect(detailed.candidates).toHaveLength(3)

      const candA = detailed.candidates.find((c) => c.key === modelA)
      expect(candA).toBeDefined()
      expect(candA?.score).toBeGreaterThan(0)
      expect(candA?.quality).toBe(codingQuality(modelA))
      expect(candA?.latency).toBe(250)
      expect(candA?.costTier).toBe('free')
      expect(candA?.rejectedReason).toBeUndefined()
    })

    it('explains sticky model preservation when active and healthy', () => {
      const available = new Set([modelA, modelB])
      const ledger: Ledger = {
        [modelA]: { cooldownUntil: 0, cooldownMs: 30000, success: 10, error: 0, last429: null, latencyEwma: 100, sends: [] },
        [modelB]: { cooldownUntil: 0, cooldownMs: 30000, success: 5, error: 0, last429: null, latencyEwma: 500, sends: [] }
      }

      const detailed = selectModelDetailed(null, ledger, caps, now, {
        sticky: true,
        current: modelB,
        available,
        authenticatedProviders: new Set(['google', 'groq'])
      })

      expect(detailed.selected).toBe(modelB)
      expect(detailed.reason).toContain('Preserved current model (sticky selection enabled and model is healthy)')
    })

    it('records specific rejection reasons for candidates', () => {
      const available = new Set([modelA, modelB, modelC])
      const ledger: Ledger = {
        // modelA is in cooldown
        [modelA]: { cooldownUntil: now + 15000, cooldownMs: 30000, success: 0, error: 2, last429: now, latencyEwma: null, sends: [] },
        // modelB hit rate limit cap
        [modelB]: { cooldownUntil: 0, cooldownMs: 30000, success: 5, error: 0, last429: null, latencyEwma: null, sends: [now - 1000, now - 2000] },
        // modelC has high failure rate
        [modelC]: { cooldownUntil: 0, cooldownMs: 30000, success: 0, error: 5, last429: null, latencyEwma: null, sends: [] }
      }

      const detailed = selectModelDetailed(null, ledger, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['google', 'groq', 'cerebras'])
      })

      expect(detailed.selected).toBeNull()
      expect(detailed.reason).toContain('No healthy candidates available')

      const candA = detailed.candidates.find((c) => c.key === modelA)
      expect(candA?.rejectedReason).toContain('Cooldown active')

      const candB = detailed.candidates.find((c) => c.key === modelB)
      expect(candB?.rejectedReason).toBe('Rate limit cap reached')

      const candC = detailed.candidates.find((c) => c.key === modelC)
      expect(candC?.rejectedReason).toContain('High failure rate')
    })

    it('flags unauthenticated providers and unavailable models', () => {
      const available = new Set([modelA])
      const detailed = selectModelDetailed(['google/gemini-2.5-flash', 'openai/gpt-4o', 'groq/llama-3.3-70b-versatile'], {}, caps, now, {
        sticky: false,
        current: null,
        available,
        authenticatedProviders: new Set(['openai']) // google and groq not authenticated
      })

      const candGoogle = detailed.candidates.find((c) => c.key === modelA)
      expect(candGoogle?.rejectedReason).toBe('Provider not authenticated')

      const candOpenAI = detailed.candidates.find((c) => c.key === 'openai/gpt-4o')
      expect(candOpenAI?.rejectedReason).toBe('Not available on server')
    })
  })
})
