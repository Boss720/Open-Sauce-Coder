import { describe, expect, it } from 'vitest'
import {
  FREE_FALLBACK_PROVIDER_ORDER,
  FREE_PROVIDER_CAPS,
  isFreeModel,
  isSubscriptionProvider
} from '../freeTier'

describe('freeTier', () => {
  describe('isFreeModel', () => {
    it('nanogpt is free for any model id, including unknown ones', () => {
      expect(isFreeModel('nanogpt', 'anything/at-all')).toBe(true)
      expect(isFreeModel('nanogpt', 'some-brand-new-model-not-in-any-registry')).toBe(true)
    })

    it('a nonzero list price does not flip the nanogpt subscription verdict', () => {
      expect(isFreeModel('nanogpt', 'x', { input: 5, output: 10 })).toBe(true)
    })

    it('openai is never free (NEVER_FREE_PROVIDERS regression guard)', () => {
      expect(isFreeModel('openai', 'gpt-5.2')).toBe(false)
    })

    it('regression: known quota-tier free models stay free', () => {
      expect(isFreeModel('google', 'gemini-3.6-flash')).toBe(true)
      expect(isFreeModel('google', 'gemini-3.8-flash')).toBe(true)
      expect(isFreeModel('google', 'gemini-3.7-flash')).toBe(true)
      expect(isFreeModel('google', 'gemini-3-flash-preview')).toBe(true)
      expect(isFreeModel('google', 'gemma-4-31b-it')).toBe(true)
      expect(isFreeModel('google', 'gemma-4-26b-a4b-it')).toBe(true)
      expect(isFreeModel('groq', 'llama-3.3-70b-versatile')).toBe(true)
    })

    it('does not infer free access for models without a verified free quota', () => {
      expect(isFreeModel('google', 'gemini-3.1-pro')).toBe(false)
      expect(isFreeModel('google', 'gemini-omni-1.1-flash')).toBe(false)
    })
  })

  describe('isSubscriptionProvider', () => {
    it('nanogpt is a subscription provider', () => {
      expect(isSubscriptionProvider('nanogpt')).toBe(true)
    })

    it('google is not a subscription provider', () => {
      expect(isSubscriptionProvider('google')).toBe(false)
    })
  })

  describe('FREE_FALLBACK_PROVIDER_ORDER', () => {
    it('leads with nanogpt', () => {
      expect(FREE_FALLBACK_PROVIDER_ORDER[0]).toBe('nanogpt')
    })
  })

  describe('FREE_PROVIDER_CAPS', () => {
    it('has an entry for nanogpt', () => {
      expect(FREE_PROVIDER_CAPS.nanogpt).toBeDefined()
    })
  })
})
