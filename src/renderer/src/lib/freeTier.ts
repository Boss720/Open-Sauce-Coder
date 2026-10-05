/**
 * Free-tier model registry — curated ranked list, identity predicate, sub-pools.
 *
 * Pure data module, no store/React imports.
 * Source: provider model docs and the supplied Google AI Studio quota snapshot
 * (2026-10-05). Quotas are local estimates; actual limits vary by account/project.
 */

import type { ModelCapsMap } from './routing'

// ---------------------------------------------------------------------------
// Tier definitions
// ---------------------------------------------------------------------------

export type Tier = 'S' | 'A' | 'B' | 'C'

export type TaskKind = 'code' | 'title' | 'summary' | 'commit'

export interface FreeTierEntry {
  providerID: string
  modelID: string
  tier: Tier
  rpm: number
  rpd: number | null // null = opaque / unknown
  note: string
}

export const FREE_MODEL_TIERS: readonly FreeTierEntry[] = [
  // S-tier — Google describes 3.8 Flash for long-horizon software engineering and agents.
  // Full Flash models in the supplied account snapshot each have a 20/day quota.
  { providerID: 'google', modelID: 'gemini-3.8-flash', tier: 'S', rpm: 5, rpd: 20, note: 'current coding-focused Flash; 20/day' },
  { providerID: 'google', modelID: 'gemini-3.7-flash', tier: 'A', rpm: 5, rpd: 20, note: 'agent-capable Flash; 20/day' },
  { providerID: 'google', modelID: 'gemini-3.6-flash', tier: 'A', rpm: 5, rpd: 20, note: 'agent-capable Flash; 20/day' },
  { providerID: 'google', modelID: 'gemini-3.5-flash', tier: 'A', rpm: 5, rpd: 20, note: 'agent-capable Flash; 20/day' },
  { providerID: 'google', modelID: 'gemini-3-flash-preview', tier: 'B', rpm: 5, rpd: 20, note: 'preview model; exact API ID verified' },

  // A-tier — strong alternatives
  { providerID: 'groq', modelID: 'openai/gpt-oss-120b', tier: 'A', rpm: 30, rpd: 1000, note: '8K TPM bottleneck; no parallel tool calls' },
  { providerID: 'cerebras', modelID: 'gpt-oss-120b', tier: 'A', rpm: 30, rpd: 14400, note: 'generous RPD but 1M tokens/day is the real ceiling' },
  { providerID: 'mistral', modelID: 'devstral-latest', tier: 'A', rpm: 2, rpd: null, note: 'purpose-built agentic coding; RPM unpublished, see OPAQUE_RPM_PROVIDERS' },
  { providerID: 'mistral', modelID: 'mistral-medium-latest', tier: 'A', rpm: 2, rpd: null, note: 'frontier general/agentic; RPM unpublished' },
  { providerID: 'google', modelID: 'gemma-4-31b-it', tier: 'A', rpm: 30, rpd: 14400, note: 'tool-capable alternative; 16K input TPM' },

  // B-tier — stable fallbacks
  { providerID: 'groq', modelID: 'llama-3.3-70b-versatile', tier: 'B', rpm: 30, rpd: 1000, note: '12K TPM, parallel tools' },
  { providerID: 'google', modelID: 'gemini-2.5-flash', tier: 'B', rpm: 5, rpd: 20, note: 'access may be restricted; 20/day observed' },
  // 500/day — 25x any Flash. The highest-throughput free Google models by a wide
  // margin, so they carry the long sessions once Flash's 20 are gone.
  { providerID: 'google', modelID: 'gemini-3.5-flash-lite', tier: 'B', rpm: 15, rpd: 500, note: 'high-throughput fallback; 500/day' },
  { providerID: 'google', modelID: 'gemini-3.1-flash-lite', tier: 'B', rpm: 15, rpd: 500, note: 'stable high-throughput fallback; 500/day' },
  { providerID: 'google', modelID: 'gemma-4-26b-a4b-it', tier: 'B', rpm: 30, rpd: 14400, note: 'high-volume alternative; 16K input TPM' },
  { providerID: 'mistral', modelID: 'ministral-8b-latest', tier: 'B', rpm: 2, rpd: null, note: 'routine steps; RPM unpublished' },

  // C-tier — subtasks / chores only
  { providerID: 'groq', modelID: 'llama-3.1-8b-instant', tier: 'C', rpm: 30, rpd: 14400, note: 'subtasks only; most permissive Groq RPD' },
  { providerID: 'google', modelID: 'gemini-2.5-flash-lite', tier: 'C', rpm: 10, rpd: 20, note: '10 rpm and 20/day in the supplied snapshot' },
  { providerID: 'openrouter', modelID: 'nvidia/nemotron-nano-9b-v2:free', tier: 'C', rpm: 20, rpd: 50, note: '50/day account-wide; 1000 after a lifetime $10 credit purchase' },
  { providerID: 'cohere', modelID: 'command-r7b-12-2024', tier: 'C', rpm: 20, rpd: 33, note: 'trial only; not re-verified 2026-07-29' },
] as const

// ---------------------------------------------------------------------------
// Free-model identity predicate
// ---------------------------------------------------------------------------

type FreeVerdict = 'quota' | 'zero-price' | 'subscription' | 'never'

const QUOTA_PROVIDERS = new Set(['google', 'groq', 'cerebras', 'mistral', 'cohere'])
const ZERO_PRICE_PROVIDERS = new Set(['openrouter', 'huggingface'])

/**
 * Providers whose ENTIRE exposed catalogue is covered by a flat-rate subscription the user already
 * pays for — free at the point of use, so they belong in the default (non-"show paid") picker and
 * are safe failover targets.
 *
 * `nanogpt` qualifies only because of how main constructs it: `nanogptConfig.ts` builds the
 * provider with `baseURL` pinned to `/api/subscription/v1` and populates `models` solely from
 * `/api/subscription/v1/models`. Both the catalogue and the billing path are subscription-scoped,
 * so no model reachable under `nanogpt/` can bill per token. Do NOT add a provider here unless
 * that same property holds — a provider with a mixed paid catalogue must not be listed.
 */
const SUBSCRIPTION_PROVIDERS = new Set(['nanogpt'])

/** True when the provider's whole catalogue is covered by a flat-rate subscription. */
export function isSubscriptionProvider(providerID: string): boolean {
  return SUBSCRIPTION_PROVIDERS.has(providerID)
}
const NEVER_FREE_PROVIDERS = new Set([
  'openai', 'anthropic', 'xai', 'deepseek', 'together', 'fireworks', 'nvidia', 'opencode',
])

const FREE_MODEL_IDS = new Set(
  FREE_MODEL_TIERS.map((e) => `${e.providerID}/${e.modelID}`)
)

/**
 * Providers whose free plans expose more models than our small, hand-ranked
 * registry.  The registry decides the default order; these matchers keep a
 * newly-added live model from disappearing from the free picker or failover
 * pool before the next desktop release.
 *
 * This deliberately does not treat every model from every provider as free.
 * A provider with a paid catalogue still needs an explicit, conservative
 * family match or a `:free` model ID.
 */
const LIVE_FREE_MODEL_FAMILIES: Readonly<Record<string, RegExp>> = {
  groq: /^(?:llama-|meta-llama\/llama-|qwen\/qwen|openai\/gpt-oss-(?!safeguard))/i,
  google: /^gemini-(?:\d+(?:\.\d+)?-)?flash(?:-lite)?(?:-|$)/i,
  cerebras: /^(?:gpt-oss|qwen|llama|zai\/glm)/i,
  mistral: /^(?:devstral|ministral)/i,
  cohere: /^command-r/i,
}

/**
 * Three-valued free check. Rejects the broken `cost==0` predicate — SDK
 * `Model.cost` defaults to 0 for unknowns, false-positiving image/auto-router
 * models, while every real free model has a nonzero list price with a $0 quota.
 *
 * @param providerID  e.g. "google"
 * @param modelID     e.g. "gemini-3.6-flash"
 * @param modelCost   optional { input: number; output: number } from SDK Model
 */
export function isFreeModel(
  providerID: string,
  modelID: string,
  modelCost?: { input: number; output: number } | null,
): boolean {
  const verdict = classifyProvider(providerID)

  switch (verdict) {
    case 'quota':
      return (
        FREE_MODEL_IDS.has(`${providerID}/${modelID}`) ||
        LIVE_FREE_MODEL_FAMILIES[providerID]?.test(modelID) === true
      )

    case 'zero-price':
      if (modelCost && modelCost.input === 0 && modelCost.output === 0) return true
      return modelID.endsWith(':free') || FREE_MODEL_IDS.has(`${providerID}/${modelID}`)

    case 'subscription':
      // Every model in the exposed catalogue is subscription-covered — see SUBSCRIPTION_PROVIDERS.
      // Deliberately not gated on modelID: the catalogue is fetched live and changes without a
      // desktop release, so an allowlist here would hide new subscription models.
      return true

    case 'never':
      return false
  }
}

function classifyProvider(providerID: string): FreeVerdict {
  if (SUBSCRIPTION_PROVIDERS.has(providerID)) return 'subscription'
  if (QUOTA_PROVIDERS.has(providerID)) return 'quota'
  if (ZERO_PRICE_PROVIDERS.has(providerID)) return 'zero-price'
  if (NEVER_FREE_PROVIDERS.has(providerID)) return 'never'
  return 'never' // fail closed
}

// ---------------------------------------------------------------------------
// Sub-pools by task kind
// ---------------------------------------------------------------------------

const CODE_TIERS: ReadonlySet<Tier> = new Set<Tier>(['S', 'A'])
const CHORE_TIERS: ReadonlySet<Tier> = new Set<Tier>(['C', 'B'])

/**
 * Return the subset of FREE_MODEL_TIERS appropriate for a given task kind.
 * 'code' → S+A tiers (best models for agentic work).
 * 'title'/'summary'/'commit' → C+B tiers (save good models' quota for code).
 */
export function poolForTask(task: TaskKind): readonly FreeTierEntry[] {
  const tiers = task === 'code' ? CODE_TIERS : CHORE_TIERS
  return FREE_MODEL_TIERS.filter((e) => tiers.has(e.tier))
}

// ---------------------------------------------------------------------------
// Provider caps — authoritative seed for the ledger, replaces routing.ts values
// ---------------------------------------------------------------------------

/**
 * Providers that no longer publish free-tier request limits. Their numbers above are
 * deliberately pessimistic guesses, so a 429 from them carries information the table
 * does not — the router should trust observed 429s over these constants.
 */
export const OPAQUE_RPM_PROVIDERS: ReadonlySet<string> = new Set(['mistral'])

/**
 * THE rate-cap table. Both the router and the Routing panel read this — previously the
 * router enforced `DEFAULT_PROVIDER_CAPS` in routing.ts while the panel displayed these,
 * so the UI and the throttle disagreed on every provider (mistral 5 vs 60 rpm, cerebras
 * 30 vs 5, openrouter 200 vs 50 rpd, nanogpt uncapped in the router entirely).
 *
 * Keys are either `providerID` or `providerID/modelID`; the more specific entry wins.
 * That distinction is also the counting scope — see `capsFor` in routing.ts:
 *
 *   - a `providerID/modelID` entry counts only that model's sends, because the provider
 *     enforces the limit per model (Google: per model per project; Groq: per model per
 *     org; Cerebras: per model)
 *   - a `providerID` entry counts every send to that provider, because the limit is
 *     account-wide (OpenRouter's 50/day spans all free models)
 *
 * Google's values below use the account's AI Studio Rate Limit screenshot (2026-10-05).
 * The numerator is peak use over the preceding 28 days; only each denominator is a
 * configured limit. Google's official docs say active limits vary by project/tier.
 *
 * Google documents TPM as input tokens/minute, so Google entries explicitly count
 * input tokens. Other providers keep the router's total-token estimate unless stated.
 *
 * Daily windows: Google resets at midnight Pacific, so its entries say so rather than
 * relying on a rolling 24h window that would lock a model out for hours after the real
 * quota had already reset.
 */
export const FREE_PROVIDER_CAPS: ModelCapsMap = {
  // NanoGPT: 60 RPM limit + 10 requests per 10s burst window limit.
  nanogpt: { rpm: 60, burst: { count: 10, windowMs: 10_000 } },

  // Mistral stopped publishing free-tier RPM; real ceilings only appear in their admin
  // console. 2 rpm is the lowest figure currently reported for the free Experiment tier —
  // pessimistic on purpose, and listed in OPAQUE_RPM_PROVIDERS so 429s can correct it.
  mistral: { rpm: 2 },

  // Account-wide across every free model, not per model.
  openrouter: { rpm: 20, rpd: 50 },
  cohere: { rpm: 20, rpd: 33 },

  // Per-provider floors for models not named below. Deliberately the STRICTEST
  // Google tier: an unrecognised model ID must be assumed to carry the 20/day Flash
  // allowance, never the 500/day Flash-Lite one. Specific entries raise it.
  google: { rpm: 5, rpd: 20, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  groq: { rpm: 30, rpd: 1000 },
  cerebras: { rpm: 30, rpd: 14400 },

  // Per-model entries — Google quotas are project/model-specific in the screenshot.
  // Flash class: 5 rpm / 250K input tpm / 20 rpd.
  'google/gemini-3.8-flash': { rpm: 5, rpd: 20, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  'google/gemini-3.7-flash': { rpm: 5, rpd: 20, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  'google/gemini-3.6-flash': { rpm: 5, rpd: 20, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  'google/gemini-3.5-flash': { rpm: 5, rpd: 20, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  'google/gemini-3-flash-preview': { rpm: 5, rpd: 20, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  'google/gemini-2.5-flash': { rpm: 5, rpd: 20, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  // Flash-Lite 3.x: 15 rpm / 500 rpd. 2.5 Flash-Lite is NOT in this club — it gets
  // 10 rpm / 20 rpd, so it must not inherit the 3.x numbers by name similarity.
  'google/gemini-3.5-flash-lite': { rpm: 15, rpd: 500, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  'google/gemini-3.1-flash-lite': { rpm: 15, rpd: 500, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  'google/gemini-2.5-flash-lite': { rpm: 10, rpd: 20, tpm: 250_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  // Gemma 4: 30 rpm / 16K input tpm / 14.4K rpd in the screenshot.
  'google/gemma-4-26b-a4b-it': { rpm: 30, rpd: 14_400, tpm: 16_000, tpmTokens: 'input', rpdWindow: 'day-pt' },
  'google/gemma-4-31b-it': { rpm: 30, rpd: 14_400, tpm: 16_000, tpmTokens: 'input', rpdWindow: 'day-pt' },

  'groq/openai/gpt-oss-120b': { rpm: 30, rpd: 1000, tpm: 8_000 },
  'groq/llama-3.3-70b-versatile': { rpm: 30, rpd: 1000, tpm: 12_000 },
  'groq/llama-3.1-8b-instant': { rpm: 30, rpd: 14400 },
  'cerebras/gpt-oss-120b': { rpm: 30, rpd: 14400 },
}

/**
 * Google's Live API is metered on tokens only — the dashboard reports Unlimited for
 * both RPM and RPD on every Live model. Request-count throttling would be pure
 * false positives there, so these keys carry a TPM budget and nothing else.
 *
 * Kept separate from FREE_PROVIDER_CAPS because the Live session runs through
 * geminiLive.ts in the main process, not through the router's ledger. This is the
 * reference for that path rather than something selectModel consults.
 */
export const GEMINI_LIVE_CAPS: ModelCapsMap = {
  'google/gemini-3-flash-live': { tpm: 65_000 },
  'google/gemini-2.5-flash-native-audio-dialog': { tpm: 1_000_000 },
  'google/gemini-3.5-live-translate': { tpm: 20_000 },
}

// ---------------------------------------------------------------------------
// Derived lists (consumed by rotation.ts replacements)
// ---------------------------------------------------------------------------

/** Preferred models for auto-pick, S-tier first then A-tier. */
export const FREE_PREFERRED_MODELS: ReadonlyArray<{ providerID: string; modelID: string }> =
  FREE_MODEL_TIERS
    .filter((e) => e.tier === 'S' || e.tier === 'A')
    .map(({ providerID, modelID }) => ({ providerID, modelID }))

/**
 * Provider priority order for fallback scanning. `nanogpt` leads: a paid flat-rate subscription is
 * materially more reliable than a free quota tier, so it is the best first failover target.
 */
export const FREE_FALLBACK_PROVIDER_ORDER: readonly string[] = [
  'nanogpt', 'google', 'groq', 'cerebras', 'mistral', 'cohere', 'openrouter',
]

// ---------------------------------------------------------------------------
// Coding-quality scores anchored to tiers (replaces regex guesswork)
// ---------------------------------------------------------------------------

/**
 * Deterministic coding-quality score for a known free model.
 * Returns null for unknown models (caller should fall back to regex scoring).
 */
export function freeCodingQuality(providerID: string, modelID: string): number | null {
  const key = `${providerID}/${modelID}`
  const entry = FREE_MODEL_TIERS.find((e) => `${e.providerID}/${e.modelID}` === key)
  if (!entry) return null
  const tierScore: Record<Tier, number> = { S: 5, A: 4, B: 3, C: 2 }
  return tierScore[entry.tier]
}
