import { describe, it, expect, vi } from 'vitest'
import { ProviderRegistry } from '../harness/providers/registry'
import { OpenAiCompatibleAdapter } from '../harness/providers/openaiCompatible'

vi.mock('../keys', () => ({
  loadByokEnv: vi.fn(() => ({
    GROQ_API_KEY: 'gsk-mock-key-1234',
    MISTRAL_API_KEY: 'mistral-mock-key-5678'
  }))
}))

describe('ProviderRegistry multi-provider support', () => {
  it('supports all 8 core providers', () => {
    const registry = new ProviderRegistry()
    const expected = ['nanogpt', 'google', 'groq', 'mistral', 'openrouter', 'moonshot', 'xai', 'cerebras']
    for (const id of expected) {
      expect(registry.isSupported(id)).toBe(true)
    }
    expect(registry.isSupported('unsupported-provider')).toBe(false)
  })

  it('resolves OpenAI-compatible providers to OpenAiCompatibleAdapter', () => {
    const registry = new ProviderRegistry()
    const groqAdapter = registry.resolve('groq')
    expect(groqAdapter).toBeInstanceOf(OpenAiCompatibleAdapter)
    expect(groqAdapter.id).toBe('groq')

    const mistralAdapter = registry.resolve('mistral')
    expect(mistralAdapter).toBeInstanceOf(OpenAiCompatibleAdapter)
    expect(mistralAdapter.id).toBe('mistral')
  })

  it('throws descriptive error on unknown provider', () => {
    const registry = new ProviderRegistry()
    expect(() => registry.resolve('unknown-provider')).toThrow(/Unsupported harness provider/)
  })
})
