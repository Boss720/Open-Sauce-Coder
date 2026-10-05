/**
 * Provider registry for the agentic harness.
 *
 * Resolves a provider id to the correct ProviderAdapter instance.
 * Lazy-instantiates adapters on first use and caches them.
 */
import type { ProviderAdapter } from './adapter'
import { NanoGptAdapter } from './nanogpt'
import { GeminiAdapter } from './gemini'
import { AnthropicAdapter } from './anthropic'
import { OpenAiAdapter } from './openai'
import { OpenAiCompatibleAdapter, OPENAI_COMPATIBLE_CONFIGS } from './openaiCompatible'

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>()

  /** Resolve a provider id to its adapter. Throws on unknown provider. */
  resolve(providerId: string): ProviderAdapter {
    const cached = this.adapters.get(providerId)
    if (cached) return cached

    const adapter = this.createAdapter(providerId)
    this.adapters.set(providerId, adapter)
    return adapter
  }

  /** Check if a provider is supported by the harness. */
  isSupported(providerId: string): boolean {
    return SUPPORTED_PROVIDERS.has(providerId)
  }

  /** List supported provider ids. */
  list(): string[] {
    return [...SUPPORTED_PROVIDERS]
  }

  /** Test connectivity for a provider. */
  async probe(providerId: string): Promise<boolean> {
    try {
      const adapter = this.resolve(providerId)
      return await adapter.probe()
    } catch {
      return false
    }
  }

  /** Reset all cached adapters. Useful for testing or after key changes. */
  reset(): void {
    this.adapters.clear()
  }

  private createAdapter(providerId: string): ProviderAdapter {
    switch (providerId) {
      case 'nanogpt':
        return new NanoGptAdapter()
      case 'google':
        return new GeminiAdapter()
      case 'anthropic':
        return new AnthropicAdapter()
      case 'openai':
        return new OpenAiAdapter()
      case 'groq':
      case 'mistral':
      case 'openrouter':
      case 'deepseek':
      case 'moonshot':
      case 'xai':
      case 'cerebras':
      case 'custom': {
        const config = OPENAI_COMPATIBLE_CONFIGS[providerId]
        if (!config) throw new Error(`Missing OpenAI-compatible configuration for: ${providerId}`)
        return new OpenAiCompatibleAdapter(config)
      }
      default:
        throw new Error(
          `Unsupported harness provider: "${providerId}". ` +
          `Supported providers: ${[...SUPPORTED_PROVIDERS].join(', ')}.`
        )
    }
  }
}

const SUPPORTED_PROVIDERS = new Set([
  'nanogpt',
  'google',
  'anthropic',
  'openai',
  'openrouter',
  'groq',
  'mistral',
  'deepseek',
  'moonshot',
  'xai',
  'cerebras',
  'custom'
])

/** Main-process singleton instance. */
export const providerRegistry = new ProviderRegistry()
