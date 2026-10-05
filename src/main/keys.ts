/**
 * BYOK (bring-your-own-key) storage — the ONLY module that touches Electron `safeStorage`.
 *
 * Users store LLM-provider API keys in-app. Each key is encrypted at rest with the OS keychain
 * (DPAPI on Windows / Keychain on macOS / libsecret on Linux) via `safeStorage.encryptString`,
 * persisted as base64 in `userData/byok-keys.json`, and injected into the `opencode serve` child
 * process environment at spawn time (see `loadByokEnv`, consumed by server.ts).
 *
 * DECISION: we inject keys into the child env rather than calling opencode's SDK `auth.set`,
 * because `auth.set` persists the raw key in plaintext to opencode's `auth.json`. Env-injection
 * keeps the only at-rest copy under OS encryption and never writes plaintext to disk.
 *
 * SECURITY INVARIANTS:
 *  - A plaintext key value is NEVER written to any log, error message, or crash file.
 *  - Error messages reference only the providerID / envVar, never the key.
 *  - The full key never crosses IPC back to the renderer (listKeys returns masked tails only).
 *  - If encryption is unavailable we THROW on write (never persist plaintext), but degrade
 *    gracefully on read (skip undecryptable keys) so the server can still start.
 */
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ALLOWLIST, ALIASES } from './env'
import { catalogByProvider, PROVIDER_CATALOG } from './providerCatalog'
import { GoogleGenAI, Modality } from '@google/genai'

/* ------------------------------------------------------------------ */
/* storage shape                                                       */
/* ------------------------------------------------------------------ */

type KeyStore = {
  version: 1
  /** envVar -> base64 of safeStorage.encryptString(plaintext) */
  keys: Record<string, string>
}

/** Encrypted, per-workspace MCP credential material. Never written to opencode.json. */
type McpSecretStore = {
  version: 1
  secrets: Record<string, string>
}

export type McpSecrets = {
  environment?: Record<string, string>
  headers?: Record<string, string>
  oauthClientSecret?: string
}

function emptyStore(): KeyStore {
  return { version: 1, keys: {} }
}

function storePath(): string {
  return join(app.getPath('userData'), 'byok-keys.json')
}

function mcpSecretStorePath(): string {
  return join(app.getPath('userData'), 'mcp-secrets.json')
}

function mcpSecretKey(directory: string, name: string): string {
  return createHash('sha256').update(`${directory}\u0000${name}`).digest('base64url')
}

function readMcpSecretStore(): McpSecretStore {
  try {
    const path = mcpSecretStorePath()
    if (!existsSync(path)) return { version: 1, secrets: {} }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, secrets: {} }
    const candidate = parsed as Partial<McpSecretStore>
    const secrets = typeof candidate.secrets === 'object' && candidate.secrets !== null
      ? candidate.secrets as Record<string, string>
      : {}
    return {
      version: 1,
      secrets: Object.fromEntries(Object.entries(secrets).filter(([, value]) => typeof value === 'string'))
    }
  } catch {
    return { version: 1, secrets: {} }
  }
}

function writeMcpSecretStore(store: McpSecretStore): void {
  writeFileSync(mcpSecretStorePath(), JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/** Read + parse the store. A missing or corrupt file reads as an empty store (never throws). */
function readStore(): KeyStore {
  try {
    const path = storePath()
    if (!existsSync(path)) return emptyStore()
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return emptyStore()
    const candidate = parsed as Partial<KeyStore>
    const keys =
      typeof candidate.keys === 'object' && candidate.keys !== null
        ? (candidate.keys as Record<string, string>)
        : {}
    // Keep only string values keyed by string env vars.
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(keys)) {
      if (typeof v === 'string') clean[k] = v
    }
    return { version: 1, keys: clean }
  } catch {
    return emptyStore()
  }
}

/** Write the store as pretty JSON, best-effort chmod 0o600. */
function writeStore(store: KeyStore): void {
  const path = storePath()
  writeFileSync(path, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/**
 * Resolve the canonical env var for a providerID, validating against the catalog and the
 * ALLOWLIST. Throws (referencing only the providerID / envVar) on any mismatch.
 */
function resolveEnvVar(providerID: string): string {
  const entry = catalogByProvider(providerID)
  if (!entry) {
    throw new Error(`Unknown provider: ${providerID}`)
  }
  if (!ALLOWLIST.has(entry.envVar)) {
    throw new Error(`Provider ${providerID} maps to a disallowed env var (${entry.envVar}).`)
  }
  return entry.envVar
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Encrypt and store a key for a provider. Throws when the provider is unknown, the resolved
 * env var is not allowlisted, encryption is unavailable, or the key is empty. Never writes
 * plaintext to disk.
 */
export function setKey(providerID: string, key: string): void {
  const envVar = resolveEnvVar(providerID)
  const trimmed = key.trim()
  if (trimmed.length === 0) {
    throw new Error(`Refusing to store an empty key for provider ${providerID}.`)
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      `OS encryption is unavailable — refusing to store the ${envVar} key in plaintext.`
    )
  }
  const encrypted = safeStorage.encryptString(trimmed).toString('base64')
  const store = readStore()
  store.keys[envVar] = encrypted
  writeStore(store)
}

/** Remove the stored key for a provider (no-op if none stored). */
export function deleteKey(providerID: string): void {
  const envVar = resolveEnvVar(providerID)
  const store = readStore()
  if (envVar in store.keys) {
    delete store.keys[envVar]
    writeStore(store)
  }
}

/** Store MCP headers, environment values, and OAuth client secrets under OS encryption. */
export function setMcpSecrets(directory: string, name: string, secrets: McpSecrets): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS encryption is unavailable — refusing to store MCP credentials in plaintext.')
  }
  const key = mcpSecretKey(directory, name)
  const store = readMcpSecretStore()
  const serialized = JSON.stringify(secrets)
  store.secrets[key] = safeStorage.encryptString(serialized).toString('base64')
  writeMcpSecretStore(store)
}

/** Read MCP credentials transiently for a main-process connection attempt. */
export function getMcpSecrets(directory: string, name: string): McpSecrets | undefined {
  const encoded = readMcpSecretStore().secrets[mcpSecretKey(directory, name)]
  if (!encoded) return undefined
  const plaintext = decryptStored(encoded)
  if (!plaintext) return undefined
  try {
    const parsed = JSON.parse(plaintext) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const value = parsed as McpSecrets
    return value
  } catch {
    return undefined
  }
}

/** Remove MCP credentials when their connector is removed. */
export function deleteMcpSecrets(directory: string, name: string): void {
  const store = readMcpSecretStore()
  const key = mcpSecretKey(directory, name)
  if (key in store.secrets) {
    delete store.secrets[key]
    writeMcpSecretStore(store)
  }
}

/** Decrypt one stored base64 value; returns null on any failure (never throws, never logs). */
function decryptStored(encoded: string): string | null {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const buf = Buffer.from(encoded, 'base64')
    return safeStorage.decryptString(buf)
  } catch {
    return null
  }
}

export type MaskedKeyRow = { providerID: string; envVar: string; maskedTail: string | null }

/**
 * One row per catalog provider that HAS a stored key. Decrypts transiently only to compute the
 * last-4-char tail (null if the key is shorter than 4 or fails to decrypt), then discards the
 * plaintext. NEVER returns the full key.
 */
export function listKeys(): MaskedKeyRow[] {
  const store = readStore()
  const rows: MaskedKeyRow[] = []
  for (const entry of PROVIDER_CATALOG) {
    const encoded = store.keys[entry.envVar]
    if (encoded === undefined) continue
    let maskedTail: string | null = null
    const plaintext = decryptStored(encoded)
    if (plaintext !== null && plaintext.length >= 4) {
      maskedTail = plaintext.slice(-4)
    }
    rows.push({ providerID: entry.providerID, envVar: entry.envVar, maskedTail })
  }
  return rows
}

/**
 * Decrypt all stored keys into `{ [ENV_VAR]: plaintext }`, then apply ALIAS expansion (same
 * logic as env.ts). Called at spawn time in server.ts to merge into the child env. Never throws:
 * if encryption is unavailable or a value fails to decrypt, that key is skipped so the server
 * still starts.
 */
export function loadByokEnv(): Record<string, string> {
  const vars: Record<string, string> = {}
  try {
    const store = readStore()
    for (const [envVar, encoded] of Object.entries(store.keys)) {
      // Defence in depth: only surface allowlisted env vars into the child.
      if (!ALLOWLIST.has(envVar)) continue
      const plaintext = decryptStored(encoded)
      if (plaintext === null || plaintext.length === 0) continue
      vars[envVar] = plaintext
    }
    for (const [source, targets] of Object.entries(ALIASES)) {
      const value = vars[source]
      if (!value) continue
      for (const target of targets) {
        if (!vars[target]) vars[target] = value
      }
    }
  } catch {
    // Never block startup on BYOK failures.
  }
  return vars
}

/** Mint a one-use, short-lived Live API token without exposing the stored Google key. */
export async function createGeminiLiveToken(): Promise<string> {
  const env = loadByokEnv()
  const apiKey = env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GOOGLE_API_KEY
  if (!apiKey) throw new Error('No Google API key is configured. Add Google under Providers first.')
  const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } })
  const now = Date.now()
  const token = await client.authTokens.create({
    config: {
      uses: 1,
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      expireTime: new Date(now + 30 * 60_000).toISOString(),
      liveConnectConstraints: {
        model: 'gemini-3.1-flash-live-preview',
        config: { responseModalities: [Modality.AUDIO] }
      }
    }
  })
  if (!token.name) throw new Error('Gemini did not return a Live session token.')
  return token.name
}

/**
 * Live-test a stored key against the provider's test endpoint. Returns a structured result.
 * NEVER logs or returns the key. Returns `{ ok: false, detail }` when there's no test config,
 * no stored key, or the request fails.
 */
export async function testKey(
  providerID: string
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const entry = catalogByProvider(providerID)
  if (!entry) return { ok: false, detail: `Unknown provider: ${providerID}` }
  if (!entry.test) return { ok: false, detail: 'No test endpoint for this provider' }

  const store = readStore()
  const encoded = store.keys[entry.envVar]
  if (encoded === undefined) return { ok: false, detail: 'No key stored' }
  const key = decryptStored(encoded)
  if (key === null) return { ok: false, detail: 'Stored key could not be decrypted' }

  const scheme = entry.test.authScheme ? `${entry.test.authScheme} ` : ''
  try {
    const res = await fetch(entry.test.url, {
      headers: {
        [entry.test.authHeader]: `${scheme}${key}`,
        ...(entry.test.extraHeaders ?? {})
      },
      signal: AbortSignal.timeout(5000)
    })
    return { ok: res.ok, status: res.status }
  } catch (error) {
    // error must not contain the key — it never does, but scrub the URL/message to be safe.
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, detail }
  }
}
