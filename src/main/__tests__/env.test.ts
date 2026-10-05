import { describe, expect, it } from 'vitest'
import { ALLOWLIST, linkedProviderIDs } from '../env'

describe('BYOK environment boundary', () => {
  it('allows only supported provider credential variables', () => {
    expect([...ALLOWLIST].sort()).toEqual([
      'CEREBRAS_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GROQ_API_KEY',
      'MISTRAL_API_KEY',
      'MOONSHOT_API_KEY',
      'NANOGPT_API_KEY',
      'OPENROUTER_API_KEY',
      'XAI_API_KEY'
    ])
  })
})

describe('linkedProviderIDs', () => {
  it('authorizes known providers from non-secret API-key presence only', () => {
    expect(linkedProviderIDs({ OPENAI_API_KEY: 'sk-test', GROQ_API_KEY: 'gsk-test', NANOGPT_API_KEY: 'nano-test' })).toEqual([
      'groq',
      'nanogpt'
    ])
  })

  it('recognizes Google aliases without leaking their values', () => {
    expect(linkedProviderIDs({ GOOGLE_API_KEY: 'test' })).toEqual(['google'])
    expect(linkedProviderIDs({ GOOGLE_GENERATIVE_AI_API_KEY: 'test' })).toEqual(['google'])
  })

  it('does not authorize a provider for empty or unrelated environment values', () => {
    expect(linkedProviderIDs({ OPENAI_API_KEY: '  ', SOME_OTHER_KEY: 'test' })).toEqual([])
  })
})
