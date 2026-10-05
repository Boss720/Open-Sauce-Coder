import { describe, expect, it } from 'vitest'
import { contextLimit, contextUsed, lastAssistantInputTokenCount, sessionCost } from '../aggregate'
import type { MessageWithParts, Provider } from '../types'

describe('aggregate helpers', () => {
  it('sessionCost sums message costs correctly', () => {
    const messages: MessageWithParts[] = [
      { info: { role: 'assistant', cost: 0.0012 } as any, parts: [] },
      { info: { role: 'assistant', cost: 0.0034 } as any, parts: [] },
      { info: { role: 'user' } as any, parts: [] }
    ]
    expect(sessionCost(messages)).toBeCloseTo(0.0046, 5)
  })

  it('sessionCost returns 0 for empty messages', () => {
    expect(sessionCost([])).toBe(0)
  })

  it('contextUsed extracts latest assistant token sum', () => {
    const messages: MessageWithParts[] = [
      {
        info: {
          role: 'assistant',
          tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } }
        } as any,
        parts: []
      }
    ]
    expect(contextUsed(messages)).toBe(1500)
  })

  it('lastAssistantInputTokenCount reads input tokens from the newest assistant message', () => {
    const messages: MessageWithParts[] = [
      { info: { role: 'assistant', tokens: { input: 90, output: 10 } } as unknown as MessageWithParts['info'], parts: [] },
      { info: { role: 'user' } as unknown as MessageWithParts['info'], parts: [] },
      { info: { role: 'assistant', tokens: { input: 120, output: 45 } } as unknown as MessageWithParts['info'], parts: [] }
    ]
    expect(lastAssistantInputTokenCount(messages)).toBe(120)
    expect(lastAssistantInputTokenCount([])).toBe(0)
  })

  it('contextLimit reads model limit from providers array', () => {
    const providers: Provider[] = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'config',
        env: [],
        options: {},
        models: {
          'claude-3-5-sonnet': { id: 'claude-3-5-sonnet', name: 'Sonnet', limit: { context: 200000 } } as any
        }
      }
    ]
    expect(contextLimit(providers, 'anthropic', 'claude-3-5-sonnet')).toBe(200000)
    expect(contextLimit(providers, 'unknown', 'model')).toBe(0)
  })
})
