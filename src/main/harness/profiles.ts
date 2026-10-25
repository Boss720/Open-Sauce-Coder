/**
 * Agent profile type, validation, and built-in defaults for the agentic harness.
 *
 * A profile defines an agent's identity, model selection, generation parameters,
 * tool access, and budget constraints.
 */

export type AgentProfile = {
  id: string
  name: string
  description?: string

  // ── Model Selection ──
  provider: string
  model: string
  fallbackModels?: string[]

  // ── Generation Parameters ──
  temperature?: number
  maxTokens?: number
  topP?: number
  thinking?: {
    enabled: boolean
    budget?: number
  }

  // ── System Prompt & Persona ──
  systemPrompt?: string
  systemPromptFile?: string

  // ── Tool Access ──
  tools?: string[]
  toolDenyList?: string[]
  readOnly?: boolean

  // ── Concurrency & Budget ──
  maxConcurrent?: number
  maxTurns?: number
  tokenBudget?: number
  costBudget?: number

  // ── Routing & Endpoint ──
  /** NanoGPT routing suffix: ':fast', ':cheap'. Only applies when provider is 'nanogpt'. */
  routingSuffix?: string
  /** NanoGPT billing route: 'subscription' uses the covered tier, 'standard' uses pay-per-prompt. */
  billingRoute?: 'subscription' | 'standard'
  caching?: boolean
  /** Base URL override for custom endpoints (Ollama, LM Studio) or proxying. */
  baseUrl?: string

  // ── Metadata ──
  builtin?: boolean
  createdAt?: number
  updatedAt?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Profile validation: ${field} must be a non-empty string.`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function optionalNumber(value: unknown, min?: number, max?: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (min !== undefined && value < min) return undefined
  if (max !== undefined && value > max) return undefined
  return value
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

const VALID_BILLING_ROUTES = new Set(['subscription', 'standard'])
const VALID_ROUTING_SUFFIXES = new Set([':fast', ':cheap', ':speed', ':price'])

/** Validate and normalise a raw value into a well-formed AgentProfile. */
export function validateProfile(raw: unknown): AgentProfile {
  if (!isRecord(raw)) throw new Error('Profile validation: input must be an object.')

  const id = requireString(raw.id, 'id')
  if (!/^[a-z0-9_-]+$/.test(id)) {
    throw new Error('Profile validation: id must contain only lowercase letters, digits, hyphens, and underscores.')
  }
  if (id.length > 64) {
    throw new Error('Profile validation: id must be 64 characters or fewer.')
  }

  const name = requireString(raw.name, 'name')
  const provider = requireString(raw.provider, 'provider')
  const model = requireString(raw.model, 'model')

  // Preserve all raw fields so custom/advanced extension properties are retained
  const profile: AgentProfile & Record<string, unknown> = {
    ...raw,
    id,
    name,
    provider,
    model
  }

  const description = optionalString(raw.description)
  if (description !== undefined) profile.description = description
  else delete profile.description

  const fallbackModels = optionalStringArray(raw.fallbackModels)
  if (fallbackModels !== undefined) profile.fallbackModels = fallbackModels
  else delete profile.fallbackModels

  const temperature = optionalNumber(raw.temperature, 0, 2)
  if (temperature !== undefined) profile.temperature = temperature
  else delete profile.temperature

  const maxTokens = optionalNumber(raw.maxTokens, 1, 1_000_000)
  if (maxTokens !== undefined) profile.maxTokens = Math.round(maxTokens)
  else delete profile.maxTokens

  const topP = optionalNumber(raw.topP, 0, 1)
  if (topP !== undefined) profile.topP = topP
  else delete profile.topP

  if (isRecord(raw.thinking)) {
    const enabled = optionalBoolean(raw.thinking.enabled)
    if (enabled !== undefined) {
      profile.thinking = { enabled }
      const budget = optionalNumber(raw.thinking.budget, 1, 1_000_000)
      if (budget !== undefined) profile.thinking.budget = Math.round(budget)
    } else {
      delete profile.thinking
    }
  } else if ('thinking' in raw) {
    delete profile.thinking
  }

  const systemPrompt = optionalString(raw.systemPrompt)
  if (systemPrompt !== undefined) profile.systemPrompt = systemPrompt
  else delete profile.systemPrompt

  const systemPromptFile = optionalString(raw.systemPromptFile)
  if (systemPromptFile !== undefined) profile.systemPromptFile = systemPromptFile
  else delete profile.systemPromptFile

  const tools = optionalStringArray(raw.tools)
  if (tools !== undefined) profile.tools = tools
  else delete profile.tools

  const toolDenyList = optionalStringArray(raw.toolDenyList)
  if (toolDenyList !== undefined) profile.toolDenyList = toolDenyList
  else delete profile.toolDenyList

  const readOnly = optionalBoolean(raw.readOnly)
  if (readOnly !== undefined) profile.readOnly = readOnly
  else delete profile.readOnly

  const maxConcurrent = optionalNumber(raw.maxConcurrent, 1, 50)
  if (maxConcurrent !== undefined) profile.maxConcurrent = Math.round(maxConcurrent)
  else delete profile.maxConcurrent

  const maxTurns = optionalNumber(raw.maxTurns, 1, 500)
  if (maxTurns !== undefined) profile.maxTurns = Math.round(maxTurns)
  else delete profile.maxTurns

  const tokenBudget = optionalNumber(raw.tokenBudget, 1)
  if (tokenBudget !== undefined) profile.tokenBudget = Math.round(tokenBudget)
  else delete profile.tokenBudget

  const costBudget = optionalNumber(raw.costBudget, 0)
  if (costBudget !== undefined) profile.costBudget = costBudget
  else delete profile.costBudget

  if (typeof raw.routingSuffix === 'string' && VALID_ROUTING_SUFFIXES.has(raw.routingSuffix)) {
    profile.routingSuffix = raw.routingSuffix
  } else {
    delete profile.routingSuffix
  }

  if (typeof raw.billingRoute === 'string' && VALID_BILLING_ROUTES.has(raw.billingRoute)) {
    profile.billingRoute = raw.billingRoute as 'subscription' | 'standard'
  } else {
    delete profile.billingRoute
  }

  const caching = optionalBoolean(raw.caching)
  if (caching !== undefined) profile.caching = caching
  else delete profile.caching

  const baseUrl = optionalString(raw.baseUrl)
  if (baseUrl !== undefined) profile.baseUrl = baseUrl
  else delete profile.baseUrl

  const builtin = optionalBoolean(raw.builtin)
  if (builtin !== undefined) profile.builtin = builtin

  return profile
}

/** Sensible built-in profiles. Read-only — users can clone and customise. */
export const BUILTIN_PROFILES: readonly AgentProfile[] = Object.freeze([
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'High-capability planning agent for complex multi-step tasks. GLM-5.2 thinking, 1M context, x1 subscription cost.',
    provider: 'nanogpt',
    model: 'zai-org/glm-5.2:thinking',
    temperature: 0.3,
    maxTokens: 16384,
    thinking: { enabled: true, budget: 32768 },
    tools: ['*'],
    maxTurns: 50,
    billingRoute: 'subscription',
    builtin: true
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Fast wide-context model for information gathering. Read-only tools, no thinking overhead. DeepSeek V4 Flash, 1M context, cheapest x1.',
    provider: 'nanogpt',
    model: 'deepseek/deepseek-v4-flash:thinking',
    routingSuffix: ':fast',
    temperature: 0.2,
    maxTokens: 8192,
    readOnly: true,
    maxTurns: 20,
    billingRoute: 'subscription',
    builtin: true
  },
  {
    id: 'coder',
    name: 'Coder',
    description: 'Code-specialized model with file and shell access. Qwen3 Coder Next, x1 subscription cost, default implementer.',
    provider: 'nanogpt',
    model: 'qwen/qwen3-coder-next',
    temperature: 0.1,
    maxTokens: 16384,
    tools: ['fs_read', 'fs_write', 'fs_patch', 'fs_list', 'grep', 'shell', 'think'],
    maxTurns: 40,
    billingRoute: 'subscription',
    builtin: true
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Read-only review agent for code critique and analysis. Nemotron-3 Super, cheap x1 subscription cost.',
    provider: 'nanogpt',
    model: 'nvidia/nemotron-3-super-120b-a12b:thinking',
    routingSuffix: ':cheap',
    temperature: 0.5,
    maxTokens: 8192,
    readOnly: true,
    maxTurns: 10,
    billingRoute: 'subscription',
    builtin: true
  },
  {
    id: 'gemini-pro-planner',
    name: 'Gemini Pro Planner',
    description: 'High-capability Google reasoning model for deep analysis and architectural design. Gemini 2.5 Pro with thinking budget.',
    provider: 'google',
    model: 'gemini-2.5-pro',
    temperature: 0.2,
    maxTokens: 16384,
    thinking: { enabled: true, budget: 16384 },
    tools: ['*'],
    maxTurns: 40,
    builtin: true
  },
  {
    id: 'claude-coder',
    name: 'Claude Coder',
    description: 'Anthropic Claude Sonnet 5.5 with native tool use for precision software engineering and refactoring.',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    temperature: 0.2,
    maxTokens: 16384,
    thinking: { enabled: true, budget: 8192 },
    tools: ['fs_read', 'fs_write', 'fs_patch', 'fs_list', 'grep', 'shell', 'think'],
    maxTurns: 40,
    builtin: true
  },
  {
    id: 'openai-architect',
    name: 'OpenAI Architect',
    description: 'General-purpose engineering and architectural reasoning powered by GPT-4o with full tool access.',
    provider: 'openai',
    model: 'gpt-4o',
    temperature: 0.2,
    maxTokens: 16384,
    tools: ['*'],
    maxTurns: 40,
    builtin: true
  },
  {
    id: 'groq-fast-coder',
    name: 'Groq Fast Coder',
    description: 'Ultra-low latency Llama 3.3 70B on Groq LPUs for rapid iterations and quick codebase inquiries.',
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    temperature: 0.1,
    maxTokens: 8192,
    tools: ['fs_read', 'fs_write', 'fs_patch', 'fs_list', 'grep', 'shell'],
    maxTurns: 30,
    builtin: true
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek V4 Pro',
    description: 'DeepSeek V4 Pro reasoning model with chain-of-thought extraction for difficult algorithmic problems.',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    temperature: 0.6,
    maxTokens: 16384,
    tools: ['*'],
    maxTurns: 30,
    builtin: true
  },
  {
    id: 'opencode-agent',
    name: 'OpenCode Assistant',
    description: 'Supervised OpenCode serve engine running local models or configured server providers.',
    provider: 'opencode',
    model: 'default',
    temperature: 0.2,
    maxTokens: 16384,
    // The bridge returns text only and cannot route tool calls through the
    // harness ToolRegistry, so this profile requests none.
    tools: [],
    maxTurns: 40,
    builtin: true
  }
])
