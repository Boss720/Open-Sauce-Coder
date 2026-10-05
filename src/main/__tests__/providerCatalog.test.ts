import { describe, it, expect } from 'vitest'
import { PROVIDER_CATALOG, catalogByProvider, catalogByEnvVar } from '../providerCatalog'
import { ALLOWLIST } from '../env'

describe('providerCatalog', () => {
  it('every entry has non-empty required fields', () => {
    for (const entry of PROVIDER_CATALOG) {
      expect(entry.providerID).toBeTruthy()
      expect(entry.envVar).toBeTruthy()
      expect(entry.label).toBeTruthy()
      expect(entry.docsUrl).toBeTruthy()
    }
  })

  it('no duplicate providerIDs', () => {
    const ids = PROVIDER_CATALOG.map((e) => e.providerID)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })

  it('no duplicate envVars', () => {
    const vars = PROVIDER_CATALOG.map((e) => e.envVar)
    const unique = new Set(vars)
    expect(unique.size).toBe(vars.length)
  })

  it('includes all supported BYOK providers', () => {
    const expected = ['nanogpt', 'google', 'anthropic', 'openai', 'groq', 'mistral', 'openrouter', 'moonshot', 'xai', 'cerebras', 'deepseek']
    expect(PROVIDER_CATALOG.map((entry) => entry.providerID)).toEqual(expected)
    expect(catalogByProvider('groq')).toBeDefined()
    expect(catalogByProvider('anthropic')).toBeDefined()
    expect(catalogByProvider('openai')).toBeDefined()
    expect(catalogByProvider('deepseek')).toBeDefined()
  })

  it('catalogByEnvVar resolves GEMINI_API_KEY correctly', () => {
    const entry = catalogByEnvVar('GEMINI_API_KEY')
    expect(entry).toBeDefined()
    expect(entry?.providerID).toBe('google')
    expect(entry?.label).toBe('Gemini (including Gemini Live)')
  })

  it('unknown lookups return undefined', () => {
    expect(catalogByProvider('unknown-provider')).toBeUndefined()
    expect(catalogByEnvVar('UNKNOWN_API_KEY')).toBeUndefined()
  })

  it('lookups are case-sensitive', () => {
    expect(catalogByProvider('GOOGLE')).toBeUndefined()
    expect(catalogByEnvVar('groq_api_key')).toBeUndefined()
  })

  it('all entries with test config have required test fields', () => {
    for (const entry of PROVIDER_CATALOG) {
      if (entry.test) {
        expect(entry.test.url).toBeTruthy()
        expect(entry.test.authHeader).toBeTruthy()
      }
    }
  })

  it('catalogByProvider resolves nanogpt correctly', () => {
    const entry = catalogByProvider('nanogpt')
    expect(entry).toBeDefined()
    expect(entry?.envVar).toBe('NANOGPT_API_KEY')
  })

  it('nanogpt envVar is a member of the ALLOWLIST', () => {
    const entry = catalogByProvider('nanogpt')
    expect(entry).toBeDefined()
    expect(ALLOWLIST.has(entry!.envVar)).toBe(true)
  })

  it('nanogpt test.url points at the subscription models endpoint', () => {
    const entry = catalogByProvider('nanogpt')
    expect(entry?.test?.url).toBe('https://nano-gpt.com/api/subscription/v1/models')
  })

  it('catalogByEnvVar resolves NANOGPT_API_KEY to the nanogpt provider', () => {
    expect(catalogByEnvVar('NANOGPT_API_KEY')?.providerID).toBe('nanogpt')
  })

  it('resolves newly restored providers and keeps non-catalog vars undefined', () => {
    expect(catalogByEnvVar('GROQ_API_KEY')?.providerID).toBe('groq')
    expect(ALLOWLIST.has('GROQ_API_KEY')).toBe(true)
    expect(catalogByEnvVar('COHERE_API_KEY')).toBeUndefined()
    expect(ALLOWLIST.has('COHERE_API_KEY')).toBe(false)
  })
})
