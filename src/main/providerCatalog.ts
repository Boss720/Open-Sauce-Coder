/**
 * Catalog of LLM providers supported by BYOK (bring-your-own-key) key management.
 * Each entry maps a provider ID to its canonical environment variable, documentation,
 * and optional test endpoint configuration.
 *
 * The catalog is static, owned by Stream 3C, and imported by keys.ts (Stream 3A).
 */

export type ProviderCatalogEntry = {
  providerID: string
  envVar: string
  label: string
  docsUrl: string
  test?: {
    url: string
    authHeader: string
    authScheme?: string
    extraHeaders?: Record<string, string>
  }
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    providerID: 'nanogpt',
    envVar: 'NANOGPT_API_KEY',
    label: 'NanoGPT (subscription)',
    docsUrl: 'https://docs.nano-gpt.com/',
    // Tests against the SUBSCRIPTION model list, not /api/v1/models: a 200 here proves both that the
    // key is valid and that the subscription endpoint this app routes through is reachable.
    test: {
      url: 'https://nano-gpt.com/api/subscription/v1/models',
      authHeader: 'Authorization',
      authScheme: 'Bearer'
    }
  },
  {
    providerID: 'google',
    envVar: 'GEMINI_API_KEY',
    label: 'Gemini (including Gemini Live)',
    docsUrl: 'https://ai.google.dev/gemini-api/docs',
    test: { url: 'https://generativelanguage.googleapis.com/v1beta/models?key=', authHeader: 'X-Goog-Api-Key' }
  },
  {
    providerID: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    label: 'Anthropic (Claude)',
    docsUrl: 'https://docs.anthropic.com/',
    test: {
      url: 'https://api.anthropic.com/v1/models',
      authHeader: 'x-api-key',
      extraHeaders: { 'anthropic-version': '2023-06-01' }
    }
  },
  {
    providerID: 'openai',
    envVar: 'OPENAI_API_KEY',
    label: 'OpenAI',
    docsUrl: 'https://platform.openai.com/docs',
    test: {
      url: 'https://api.openai.com/v1/models',
      authHeader: 'Authorization',
      authScheme: 'Bearer'
    }
  },
  {
    providerID: 'groq',
    envVar: 'GROQ_API_KEY',
    label: 'Groq',
    docsUrl: 'https://console.groq.com/docs/quickstart',
    test: {
      url: 'https://api.groq.com/openai/v1/models',
      authHeader: 'Authorization',
      authScheme: 'Bearer'
    }
  },
  {
    providerID: 'mistral',
    envVar: 'MISTRAL_API_KEY',
    label: 'Mistral AI',
    docsUrl: 'https://docs.mistral.ai/',
    test: {
      url: 'https://api.mistral.ai/v1/models',
      authHeader: 'Authorization',
      authScheme: 'Bearer'
    }
  },
  {
    providerID: 'openrouter',
    envVar: 'OPENROUTER_API_KEY',
    label: 'OpenRouter',
    docsUrl: 'https://openrouter.ai/docs',
    test: {
      url: 'https://openrouter.ai/api/v1/models',
      authHeader: 'Authorization',
      authScheme: 'Bearer'
    }
  },
  {
    providerID: 'moonshot',
    envVar: 'MOONSHOT_API_KEY',
    label: 'Moonshot (Kimi)',
    docsUrl: 'https://platform.moonshot.cn/docs',
    test: {
      url: 'https://api.moonshot.cn/v1/models',
      authHeader: 'Authorization',
      authScheme: 'Bearer'
    }
  },
  {
    providerID: 'xai',
    envVar: 'XAI_API_KEY',
    label: 'xAI (Grok)',
    docsUrl: 'https://docs.x.ai/',
    test: {
      url: 'https://api.x.ai/v1/models',
      authHeader: 'Authorization',
      authScheme: 'Bearer'
    }
  },
  {
    providerID: 'cerebras',
    envVar: 'CEREBRAS_API_KEY',
    label: 'Cerebras',
    docsUrl: 'https://inference-docs.cerebras.ai/',
    test: {
      url: 'https://api.cerebras.ai/v1/models',
      authHeader: 'Authorization',
      authScheme: 'Bearer'
    }
  },
  {
    providerID: 'deepseek',
    envVar: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    docsUrl: 'https://platform.deepseek.com/',
    test: {
      url: 'https://api.deepseek.com/models',
      authHeader: 'Authorization',
      authScheme: 'Bearer'
    }
  }
]

/**
 * Look up a provider catalog entry by providerID (case-sensitive, exact match).
 * Returns undefined if not found.
 */
export function catalogByProvider(providerID: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.providerID === providerID)
}

/**
 * Look up a provider catalog entry by envVar (case-sensitive, exact match).
 * Returns undefined if not found.
 */
export function catalogByEnvVar(envVar: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.envVar === envVar)
}
