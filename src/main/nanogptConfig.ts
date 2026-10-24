/**
 * NanoGPT model cache + generated OpenCode provider configuration.
 *
 * This app cannot invent models: the renderer's model list comes from
 * `client.config.providers()`, i.e. from whatever the `opencode serve` child process knows about.
 * So NanoGPT is registered as an OpenCode *custom provider*, and the provider block is generated
 * here and injected as `OPENCODE_CONFIG_CONTENT` at spawn time (see `server.ts`).
 *
 * DECISION — env injection, NOT writing opencode.json. `OPENCODE_CONFIG_CONTENT` was verified
 * against opencode 1.18.4 to DEEP-MERGE with the project/global config rather than replace it: a
 * project `opencode.json` carrying `instructions: ["knowledge/**\/*.md"]` (written by projects.ts)
 * survives injection intact. Env injection keeps the generated block ephemeral and leaves every
 * user-owned config file untouched.
 *
 * DECISION — subscription-scoped baseURL. `options.baseURL` points at
 * `https://nano-gpt.com/api/subscription/v1`, and `models` is populated only from
 * `/api/subscription/v1/models`. Both the catalogue AND the billing path are therefore
 * subscription-scoped: a pay-per-token model cannot be reached through this provider even by
 * typing its id by hand. That property is what lets `freeTier.ts` treat the whole `nanogpt/`
 * namespace as free-at-point-of-use.
 *
 * SECURITY: the generated JSON contains the literal placeholder `{env:NANOGPT_API_KEY}`, never a
 * key value. OpenCode substitutes it from the child env, exactly as it does for every other
 * provider. No new at-rest copy of the key is created, and the generated config is safe to log.
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchImageModels, fetchSubscriptionModels, type NanoChatModel, type NanoImageModel } from './nanogpt'

/** TTL for image model metadata cache (1 hour). */
export const IMAGE_METADATA_TTL_MS = 1 * 60 * 60 * 1000

/** Provider id used both in the generated config and by the renderer's picker/routing code. */
export const NANOGPT_PROVIDER_ID = 'nanogpt'

const CONFIG_ENV_VAR = 'OPENCODE_CONFIG_CONTENT'
const BASE_URL = 'https://nano-gpt.com/api/subscription/v1'

/** Fallbacks for models whose catalogue entry omits limits. Conservative on purpose. */
const DEFAULT_CONTEXT = 128_000
const DEFAULT_OUTPUT = 16_384

export type NanogptCache = {
  version: 1
  /** epoch ms of the last successful catalogue fetch; 0 when never fetched. */
  fetchedAt: number
  chat: NanoChatModel[]
  image: NanoImageModel[]
  /**
   * Image model ids observed to bill the pay-as-you-go BALANCE rather than the subscription.
   *
   * NanoGPT exposes no API field marking per-image-model subscription inclusion — the help page
   * says the included set "varies". The generation response's `paymentSource` is the only
   * machine-readable ground truth, so inclusion is learned empirically and remembered here.
   */
  balanceBilled: string[]
}

function emptyCache(): NanogptCache {
  return { version: 1, fetchedAt: 0, chat: [], image: [], balanceBilled: [] }
}

function cachePath(): string {
  return join(app.getPath('userData'), 'nanogpt-models.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Keep only well-formed entries so a partially-corrupt cache degrades instead of throwing. */
function sanitizeModels<T extends { id: string }>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is T => isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0
  )
}

/** Read the cache. A missing or corrupt file reads as empty and never throws (mirrors keys.ts). */
export function readCacheSync(): NanogptCache {
  try {
    const path = cachePath()
    if (!existsSync(path)) return emptyCache()
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!isRecord(parsed)) return emptyCache()
    const fetchedAt =
      typeof parsed.fetchedAt === 'number' && Number.isFinite(parsed.fetchedAt) ? parsed.fetchedAt : 0
    return {
      version: 1,
      fetchedAt,
      chat: sanitizeModels<NanoChatModel>(parsed.chat),
      image: sanitizeModels<NanoImageModel>(parsed.image),
      balanceBilled: Array.isArray(parsed.balanceBilled)
        ? parsed.balanceBilled.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
    }
  } catch {
    return emptyCache()
  }
}

export async function readCache(): Promise<NanogptCache> {
  try {
    const path = cachePath()
    if (!existsSync(path)) return emptyCache()
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return emptyCache()
    const fetchedAt =
      typeof parsed.fetchedAt === 'number' && Number.isFinite(parsed.fetchedAt) ? parsed.fetchedAt : 0
    return {
      version: 1,
      fetchedAt,
      chat: sanitizeModels<NanoChatModel>(parsed.chat),
      image: sanitizeModels<NanoImageModel>(parsed.image),
      balanceBilled: Array.isArray(parsed.balanceBilled)
        ? parsed.balanceBilled.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : []
    }
  } catch {
    return emptyCache()
  }
}

/** Write the cache pretty-printed. Contains no secrets, so no restrictive mode is needed. */
export async function writeCache(cache: NanogptCache): Promise<void> {
  await writeFile(cachePath(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
}

/** Record that an image model billed the balance rather than the subscription. Idempotent. */
export async function markBalanceBilled(modelID: string): Promise<NanogptCache> {
  const cache = await readCache()
  if (cache.balanceBilled.includes(modelID)) return cache
  const next: NanogptCache = { ...cache, balanceBilled: [...cache.balanceBilled, modelID] }
  await writeCache(next)
  return next
}

/** Clear a model's balance-billed flag, e.g. after the user changes plan. */
export async function clearBalanceBilled(modelID: string): Promise<NanogptCache> {
  const cache = await readCache()
  if (!cache.balanceBilled.includes(modelID)) return cache
  const next: NanogptCache = {
    ...cache,
    balanceBilled: cache.balanceBilled.filter((id) => id !== modelID)
  }
  await writeCache(next)
  return next
}

/**
 * Build the OpenCode provider block for the given subscription models.
 *
 * Returns `null` when there is nothing worth injecting (no models), so the caller can leave
 * `OPENCODE_CONFIG_CONTENT` unset entirely rather than registering an empty provider.
 */
export function buildConfigContent(chat: readonly NanoChatModel[]): string | null {
  if (chat.length === 0) return null

  const models: Record<string, unknown> = {}
  for (const model of chat) {
    const vision = model.capabilities?.vision === true
    // NanoGPT omits tool_calling on some entries; default to true because OpenCode's own default for
    // a custom provider is toolcall:true, and a false negative here would hide the model from the
    // picker entirely (isAgentModel requires toolcall). Only an explicit `false` disables it.
    const toolCall = model.capabilities?.tool_calling !== false

    models[model.id] = {
      name: model.name && model.name.length > 0 ? model.name : model.id,
      // Capability keys verified against opencode 1.18.4 via `/config/providers`:
      // `tool_call`, `attachment`, `reasoning`, `temperature`, and `modalities`. Note the key is
      // `tool_call` (snake) even though the resolved capability reads back as `toolcall` — writing
      // `toolcall` here is silently ignored.
      tool_call: toolCall,
      attachment: vision,
      modalities: {
        input: vision ? ['text', 'image'] : ['text'],
        output: ['text']
      },
      limit: {
        context: model.context_length ?? DEFAULT_CONTEXT,
        output: model.max_output_tokens ?? DEFAULT_OUTPUT
      }
    }
  }

  return JSON.stringify({
    provider: {
      [NANOGPT_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'NanoGPT (subscription)',
        options: {
          baseURL: BASE_URL,
          // Placeholder only — OpenCode substitutes this from the child env at config-resolve time.
          apiKey: '{env:NANOGPT_API_KEY}'
        },
        models
      }
    }
  })
}

/**
 * Env vars to merge into the `opencode serve` child environment for NanoGPT support.
 *
 * Returns an empty object when no key is linked or the cache holds no models — in that case the
 * provider is simply absent, which is better than registering one that cannot authenticate.
 */
export function nanogptEnv(hasKey: boolean): Record<string, string> {
  if (!hasKey) return {}
  const content = buildConfigContent(readCacheSync().chat)
  if (content === null) return {}
  return { [CONFIG_ENV_VAR]: content }
}

export type RefreshResult = {
  chatCount: number
  imageCount: number
  /** True when the chat model set changed, i.e. a server restart is needed to pick it up. */
  restartRequired: boolean
  fetchedAt: number
}

/**
 * Re-fetch both catalogues and rewrite the cache.
 *
 * `restartRequired` compares the chat model ID SETS (order-insensitive) — the generated provider
 * block is only read at spawn time, so a changed set means the running server is stale. Image
 * models go straight through the sidecar and never need a restart.
 *
 * Throws on network/auth failure; the caller decides whether that is fatal.
 */
export async function refreshCatalogs(): Promise<RefreshResult> {
  const previous = await readCache()
  // Fetch both before writing: a failure leaves the existing cache untouched.
  const [chat, image] = await Promise.all([fetchSubscriptionModels(), fetchImageModels()])

  const before = new Set(previous.chat.map((model) => model.id))
  const after = new Set(chat.map((model) => model.id))
  const restartRequired =
    before.size !== after.size || [...after].some((id) => !before.has(id))

  const fetchedAt = Date.now()
  await writeCache({ version: 1, fetchedAt, chat, image, balanceBilled: previous.balanceBilled })
  return { chatCount: chat.length, imageCount: image.length, restartRequired, fetchedAt }
}
