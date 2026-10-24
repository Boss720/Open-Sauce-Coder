import { describe, expect, it } from 'vitest'
import { classifyError, isRateLimitError, isTokenThroughputLimit, pickDefaultModel, restoredSelectionValid, PREFERRED_MODELS } from '../rotation'
import type { Provider } from '../types'

type ProviderModel = Provider['models'][string]

describe('rotation helpers', () => {
  describe('classifyError', () => {
    it('classifies 429 as rpm-wait', () => {
      expect(classifyError('429 Too Many Requests')).toBe('rpm-wait')
      expect(classifyError('Rate limit exceeded')).toBe('rpm-wait')
      expect(classifyError('ratelimit')).toBe('rpm-wait')
      expect(classifyError('too many requests')).toBe('rpm-wait')
    })

    it('classifies an oversized Groq TPM request as a provider-drop condition', () => {
      const message =
        'Request too large for model openai/gpt-oss-120b on tokens per minute (TPM): Limit 8000, Requested 32569'
      expect(isTokenThroughputLimit(message)).toBe(true)
      expect(classifyError(message, { statusCode: 413 })).toBe('tpm-drop')
      expect(isTokenThroughputLimit('Context window limit exceeded')).toBe(false)
    })

    it('classifies daily quota as rpd-drop', () => {
      expect(classifyError('Quota reached for today')).toBe('rpd-drop')
      expect(classifyError('RESOURCE_EXHAUSTED')).toBe('rpm-wait')
      expect(classifyError('429 per day limit exceeded')).toBe('rpd-drop')
      expect(classifyError('daily quota exhausted')).toBe('rpd-drop')
      expect(classifyError("RESOURCE_EXHAUSTED: GenerateContentRequestsPerDayPerProjectPerModel-FreeTier")).toBe('rpd-drop')
    })

    it('does not park a generic quota error until the daily reset', () => {
      expect(classifyError('RESOURCE_EXHAUSTED: quota exceeded', { statusCode: 429 })).toBe('rpm-wait')
      expect(classifyError('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', { statusCode: 429 })).toBe('rpm-wait')
    })

    it('classifies timeouts', () => {
      expect(classifyError('Request timed out')).toBe('timeout')
      expect(classifyError('Deadline exceeded')).toBe('timeout')
      expect(classifyError('timeout waiting for response')).toBe('timeout')
    })

    it('classifies transient errors', () => {
      expect(classifyError('ECONNRESET')).toBe('transient')
      expect(classifyError('socket hang up')).toBe('transient')
      expect(classifyError('fetch failed')).toBe('transient')
      expect(classifyError('Server overloaded')).toBe('transient')
      expect(classifyError('capacity')).toBe('transient')
      expect(classifyError('Internal server error', { statusCode: 500 })).toBe('transient')
    })

    it('classifies auth/server errors', () => {
      expect(classifyError('Invalid API Key')).toBe('server')
      expect(classifyError('Unauthorized', { statusCode: 401 })).toBe('server')
      expect(classifyError('Forbidden', { statusCode: 403 })).toBe('server')
    })

    it('classifies client errors', () => {
      expect(classifyError('Bad request', { statusCode: 400 })).toBe('client')
      expect(classifyError('Model not found', { statusCode: 404 })).toBe('client')
    })

    it('does NOT false-positive on generic "capacity" or "overloaded" as rate limit', () => {
      // These were false-positive rate limits in the old isRateLimitError
      expect(classifyError('Server overloaded')).not.toBe('rpm-wait')
      expect(classifyError('Server overloaded')).not.toBe('rpd-drop')
      expect(classifyError('capacity')).not.toBe('rpm-wait')
    })

    it('uses statusCode when provided', () => {
      expect(classifyError('Something went wrong', { statusCode: 429 })).toBe('rpm-wait')
      expect(classifyError('Something went wrong', { statusCode: 503 })).toBe('transient')
    })

    it('uses isRetryable hint from SDK', () => {
      expect(classifyError('Unknown error', { isRetryable: true })).toBe('transient')
    })

    it('defaults to client for unrecognized errors', () => {
      expect(classifyError('Something completely unknown')).toBe('client')
    })
  })

  describe('isRateLimitError (backward compat)', () => {
    it('returns true for rate limit strings', () => {
      expect(isRateLimitError('429 Too Many Requests')).toBe(true)
      expect(isRateLimitError('Rate limit exceeded')).toBe(true)
      expect(isRateLimitError('Quota reached for today')).toBe(true)
      expect(isRateLimitError('RESOURCE_EXHAUSTED')).toBe(true)
      expect(isRateLimitError('Request too large for tokens per minute (TPM) limit, Requested 32569')).toBe(true)
    })

    it('returns false for non-rate-limit errors', () => {
      expect(isRateLimitError('Invalid API Key')).toBe(false)
      expect(isRateLimitError('Network timeout')).toBe(false)
    })

    it('no longer false-positives on overloaded/capacity', () => {
      expect(isRateLimitError('Overloaded')).toBe(false)
      expect(isRateLimitError('capacity')).toBe(false)
    })
  })

  describe('pickDefaultModel', () => {
    it('selects preferred models in order when available', () => {
      const mockProviders: Provider[] = [
        {
          id: 'google',
          name: 'Google Gemini',
          source: 'config',
          env: [],
          options: {},
          models: {
            'gemini-3.6-flash': {
              id: 'gemini-3.6-flash',
              name: 'Gemini 3.6 Flash',
              capabilities: { toolcall: true, input: { text: true }, output: { text: true } }
            } as unknown as ProviderModel,
            'gemini-2.5-flash': {
              id: 'gemini-2.5-flash',
              name: 'Gemini 2.5 Flash',
              capabilities: { toolcall: true, input: { text: true }, output: { text: true } }
            } as unknown as ProviderModel
          }
        }
      ]
      const picked = pickDefaultModel(mockProviders)
      expect(picked).toEqual({
        providerID: 'google',
        modelID: 'gemini-3.6-flash'
      })
    })

    it('falls back to provider scan when no preferred model found', () => {
      const mockProviders: Provider[] = [
        {
          id: 'groq',
          name: 'Groq',
          source: 'config',
          env: [],
          options: {},
          models: {
            'llama-3.3-70b-versatile': {
              id: 'llama-3.3-70b-versatile',
              name: 'Llama 3.3 70B',
              capabilities: { toolcall: true, input: { text: true }, output: { text: true } }
            } as unknown as ProviderModel
          }
        }
      ]
      const picked = pickDefaultModel(mockProviders)
      expect(picked).not.toBeNull()
      expect(picked!.providerID).toBe('groq')
    })

    it('accepts newly listed Groq free-tier model families', () => {
      const mockProviders: Provider[] = [{
        id: 'groq', name: 'Groq', source: 'config', env: [], options: {},
        models: {
          'qwen/qwen3-32b': {
            id: 'qwen/qwen3-32b', name: 'Qwen3 32B',
            capabilities: { toolcall: true, input: { text: true }, output: { text: true } }
          } as unknown as ProviderModel
        }
      }]
      expect(pickDefaultModel(mockProviders)).toEqual({ providerID: 'groq', modelID: 'qwen/qwen3-32b' })
    })
  })

  describe('restoredSelectionValid', () => {
    const providers: Provider[] = [
      {
        id: 'google',
        name: 'Google',
        source: 'config',
        env: [],
        options: {},
        models: {
          'gemini-3.6-flash': {
            id: 'gemini-3.6-flash',
            name: 'Gemini 3.6 Flash',
            capabilities: { toolcall: true, input: { text: true }, output: { text: true } }
          } as unknown as ProviderModel
        }
      },
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'config',
        env: [],
        options: {},
        models: {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            capabilities: { toolcall: true, input: { text: true }, output: { text: true } }
          } as unknown as ProviderModel
        }
      }
    ]

    it('accepts free model without showPaidModels', () => {
      expect(restoredSelectionValid(providers, 'google', 'gemini-3.6-flash')).toBe(true)
    })

    it('rejects paid model without showPaidModels', () => {
      expect(restoredSelectionValid(providers, 'openai', 'gpt-4o')).toBe(false)
    })

    it('accepts paid model with showPaidModels', () => {
      expect(restoredSelectionValid(providers, 'openai', 'gpt-4o', true)).toBe(true)
    })

    it('rejects null provider/model', () => {
      expect(restoredSelectionValid(providers, null, null)).toBe(false)
    })
  })

  describe('PREFERRED_MODELS', () => {
    it('has entries derived from freeTier', () => {
      expect(PREFERRED_MODELS.length).toBeGreaterThan(0)
      expect(PREFERRED_MODELS[0]).toHaveProperty('providerID')
      expect(PREFERRED_MODELS[0]).toHaveProperty('modelID')
      expect(PREFERRED_MODELS[0].providerID).toBe('google')
      expect(PREFERRED_MODELS[0].modelID).toBe('gemini-3.8-flash')
    })
  })
})
