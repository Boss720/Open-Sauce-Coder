/**
 * Every renderer -> main invoke channel. Channel names are fixed by CONTRACTS.md.
 * Handlers unwrap the SDK's `{ data, error }` fields result and throw a readable Error on failure.
 */
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { Agent, Message, Part, Provider, Session } from '@opencode-ai/sdk'
import { getAuthorizedProviderIDs, getClient, getStatus, isAuthorizedProvider, restartServer, setEventDirectory, type ServerStatus } from './server'
import { getPermissionConfig, setPermissionConfig, validatePermissionConfig, type PermissionConfig } from './configService'
import { optionalAgentName, optionalToolPolicy } from './promptValidation'
import { parseSearchOptions, resolveSearchDirectories } from './searchScope'
import { register as registerFs, requireDirectory } from './fsService'
import { register as registerGit } from './gitService'
import { register as registerTerminal } from './terminal'
import { register as registerOpenEditor } from './openEditor'
import { deleteKey, listKeys, setKey, testKey, type MaskedKeyRow } from './keys'
import {
  addKnowledge,
  createProject,
  getProjectInstructions,
  listKnowledge,
  listProjects,
  removeKnowledge,
  setProjectInstructions
} from './projects'
import {
  addMcp,
  authMcp,
  connectMcp,
  disconnectMcp,
  getMcpSnapshot,
  removeMcp,
  type McpSnapshot
} from './mcp'
import type { AppSettingsController, AppSettingsResult } from './appSettings'
import type { LiveWindowController } from './liveWindow'
import { sendGeminiLive, startGeminiLive, stopGeminiLive, type GeminiLiveInput } from './geminiLive'
import { isLeroyRunning, sendLeroyCommand, startLeroy, stopLeroy, LEROY_EVENT_CHANNEL } from './leroy/sidecar'
import { saveLiveTranscript, revealTranscriptsFolder } from './liveTranscripts'
import { nanogptLimiter } from './nanogptLimiter'
import { getCrashLogPath, readCrashLog, type CrashLogReport } from './crashlog'
import { markBalanceBilled, readCache, readCacheSync, refreshCatalogs, type RefreshResult } from './nanogptConfig'
import { tokenBudgetTracker, type WeeklyTokenData } from './tokenBudgetTracker'
import {
  fetchSubscriptionUsage,
  generateImage,
  fetchBalance,
  type NanoChatModel,
  type NanoImageModel,
  type NanoUsage,
  type NanoBalance
} from './nanogpt'
import {
  deleteImage,
  listImages,
  readImage,
  reconcile,
  saveImage,
  imagesToday,
  type GeneratedImageMeta
} from './nanogptImages'
import { classifyBilling, type ImageBilling } from './nanogptBilling'
import { getHarnessController } from './harness/controller'
import { getDagController, listWorkflows, loadWorkflow } from './harness/dag'
import type { DagRunState, DagRunSummary, WorkflowDefinition, WorkflowSummary } from './harness/dag'

export type MessageWithParts = { info: Message; parts: Part[] }
export type ProvidersResult = { providers: Provider[]; default: Record<string, string>; linkedProviderIDs: string[] }
export type PermissionResponse = 'once' | 'always' | 'reject'

/** Cached NanoGPT catalogues, as returned by `oc:nanogpt:models`. Carries no credentials. */
export type NanogptModelsResult = {
  chat: NanoChatModel[]
  image: NanoImageModel[]
  /** Image model ids observed to bill balance rather than the subscription. */
  balanceBilled: string[]
  fetchedAt: number
}

/** Result of `oc:nanogpt:generate`. `base64` is the PNG bytes for immediate display. */
export type NanogptGenerateResult = {
  images: Array<{ meta: GeneratedImageMeta; base64: string }>
  /** How this generation was billed, per `classifyBilling`. */
  billing: ImageBilling
  paymentSource?: string
  cost?: number
  remainingBalance?: number
  /** Which endpoint served it: 'subscription' means the subscription-scoped path existed. */
  route: 'subscription' | 'standard'
  /** True when this call caused the model to be recorded as balance-billing. */
  blacklisted: boolean
}

export type RegisterIpcOptions = {
  appSettings?: Pick<AppSettingsController, 'get' | 'set'>
  onQuickSubmit?: (text: string) => void | Promise<void>
  liveWindow?: Pick<LiveWindowController, 'show' | 'setAlwaysOnTop' | 'getWindow'>
}

/** Shape of every SDK call with the default `responseStyle: 'fields'`. */
type FieldsResult<T> = { data: T | undefined; error: unknown; response: Response }

const CHANNELS = [
  'oc:status',
  'oc:restart',
  'oc:pickDirectory',
  'oc:sessions:list',
  'oc:sessions:create',
  'oc:sessions:delete',
  'oc:messages:list',
  'oc:prompt',
  'oc:abort',
  'oc:providers',
  'oc:permission:reply',
  'oc:openExternal',
  'oc:sessions:update',
  'oc:sessions:summarize',
  'oc:sessions:init',
  'oc:sessions:todos',
  'oc:sessions:command',
  'oc:commands:list',
  'oc:find:files',
  'oc:vcs:get',
  'oc:projects:list',
  'oc:projects:create',
  'oc:projects:instructions:get',
  'oc:projects:instructions:set',
  'oc:projects:knowledge:list',
  'oc:projects:knowledge:add',
  'oc:projects:knowledge:remove',
  'oc:mcp:status',
  'oc:mcp:add',
  'oc:mcp:remove',
  'oc:mcp:connect',
  'oc:mcp:disconnect',
  'oc:mcp:auth',
  'oc:quick:submit',
  'oc:liveWindow:open',
  'oc:liveWindow:close',
  'oc:liveWindow:setAlwaysOnTop',
  'oc:appSettings:get',
  'oc:appSettings:set',
  'oc:exportChat',
  'oc:saveFile',
  'oc:messages:revert',
  'oc:messages:unrevert',
  'oc:session:fork',
  'oc:agents:list',
  'oc:config:permission:get',
  'oc:config:permission:set',
  'oc:search:chats',
  'oc:keys:list',
  'oc:keys:set',
  'oc:keys:delete',
  'oc:keys:test',
  'oc:live:start',
  'oc:live:stop',
  'oc:live:saveTranscript',
  'oc:live:transcripts:reveal',
  'oc:leroy:start',
  'oc:leroy:stop',
  'oc:leroy:status',
  'oc:crashlog:read',
  'oc:crashlog:reveal',
  'oc:nanogpt:models',
  'oc:nanogpt:refresh',
  'oc:nanogpt:usage',
  'oc:nanogpt:balance',
  'oc:nanogpt:weeklyUsage',
  'oc:nanogpt:generate',
  'oc:nanogpt:images:list',
  'oc:nanogpt:images:read',
  'oc:nanogpt:images:delete',
  'oc:nanogpt:images:today',
  'oc:fs:tree',
  'oc:fs:read',
  'oc:fs:write',
  'oc:git:status',
  'oc:git:diff',
  'oc:git:stage',
  'oc:git:unstage',
  'oc:git:stageHunks',
  'oc:git:commit',
  'oc:git:branches',
  'oc:git:checkout',
  'oc:git:remoteUrl',
  'oc:term:start',
  'oc:term:write',
  'oc:term:resize',
  'oc:term:kill',
  'oc:openEditor',
  'oc:pickFiles',
  'oc:clipboard:saveImage',
  'oc:harness:profiles:list',
  'oc:harness:profiles:get',
  'oc:harness:profiles:save',
  'oc:harness:profiles:delete',
  'oc:harness:profiles:test',
  'oc:harness:run:start',
  'oc:harness:run:stop',
  'oc:harness:run:status',
  'oc:harness:run:list',
  'oc:harness:tools:list',
  'oc:dag:listWorkflows',
  'oc:dag:loadWorkflow',
  'oc:dag:startRun',
  'oc:dag:stopRun',
  'oc:dag:getRunStatus',
  'oc:dag:listRuns'
] as const

/** Sizes the image endpoint is asked for. An allowlist — `size` is forwarded to a paid API. */
const IMAGE_SIZES: ReadonlySet<string> = new Set([
  '256x256', '512x512', '768x768', '1024x1024',
  '1024x1536', '1536x1024', '1024x1792', '1792x1024'
])

const MAX_IMAGE_PROMPT = 4000
const MAX_IMAGE_COUNT = 4

/** Decoded-byte cap for a pasted clipboard image — matches MAX_ATTACHMENT_BYTES in Composer.tsx. */
const MAX_PASTED_IMAGE_BYTES = 5 * 1024 * 1024

/** Extensions accepted for a pasted clipboard image. `svg` is deliberately excluded (script-capable). */
const PASTED_IMAGE_EXTS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** How long a pasted-image file is kept before `saveClipboardImage` prunes it on next write. */
const PASTED_IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Monotonic counter so two pastes in the same millisecond never collide. */
let pastedImageCounter = 0

function pastedImagesDir(): string {
  return join(app.getPath('userData'), 'pasted-images')
}

/** Best-effort deletion of pasted-image files older than PASTED_IMAGE_MAX_AGE_MS. Never throws. */
async function prunePastedImages(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir)
    const cutoff = Date.now() - PASTED_IMAGE_MAX_AGE_MS
    await Promise.all(
      entries.map(async (name) => {
        const full = join(dir, name)
        try {
          const info = await stat(full)
          if (info.isFile() && info.mtimeMs < cutoff) await unlink(full)
        } catch {
          // best-effort: a single bad entry must never fail the paste
        }
      })
    )
  } catch {
    // best-effort: pruning must never fail the paste
  }
}

/**
 * Models with a generation currently in flight.
 *
 * The `balanceBilled` guard can only reject a model whose billing is already KNOWN, and billing only
 * becomes known when a generation returns. Two concurrent calls on an untested model would therefore
 * both pass the guard and both spend — a window as wide as a full generation (up to 120s), not a
 * narrow one. Serialising per model means the second call sees the first call's verdict.
 */
const generationsInFlight = new Set<string>()

/** Result item for `oc:search:chats`. Kept structurally identical to the preload `ChatSearchHit`. */
export type ChatSearchHit = {
  sessionID: string
  title: string
  messageID: string
  snippet: string
  time: number
  directory: string
}

/* ------------------------------------------------------------------ */
/* error / argument plumbing                                           */
/* ------------------------------------------------------------------ */

function describeErrorPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'string') return payload
  if (payload instanceof Error) return payload.message
  if (typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name : undefined
    const data = record.data
    let message: string | undefined
    if (typeof record.message === 'string') message = record.message
    if (!message && typeof data === 'object' && data !== null) {
      const inner = (data as Record<string, unknown>).message
      if (typeof inner === 'string') message = inner
    }
    if (name && message) return `${name}: ${message}`
    if (message) return message
    if (name) return name
  }
  try {
    return JSON.stringify(payload)
  } catch {
    return String(payload)
  }
}

async function call<T>(request: Promise<FieldsResult<T>>): Promise<T> {
  const result = await request

  if (result.error !== undefined && result.error !== null) {
    const detail = describeErrorPayload(result.error)
    const statusText = `${result.response.status} ${result.response.statusText}`.trim()
    throw new Error(detail ? `OpenCode: ${detail}` : `OpenCode request failed (${statusText})`)
  }

  if (!result.response.ok) {
    throw new Error(
      `OpenCode request failed: ${result.response.status} ${result.response.statusText}`.trim()
    )
  }

  return result.data as T
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid IPC argument: ${name} must be a non-empty string.`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid IPC argument: ${name} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requirePermissionResponse(value: unknown): PermissionResponse {
  if (value === 'once' || value === 'always' || value === 'reject') return value
  throw new Error(`Invalid permission response: ${String(value)}`)
}

/* ------------------------------------------------------------------ */
/* chat search: bounded pool, extraction, LRU cache                    */
/* ------------------------------------------------------------------ */

/** One searchable message: its id + concatenated text-part content. */
type SearchableMessage = { messageID: string; text: string }

/**
 * Module-scoped extraction cache. Keyed by `${sessionID}:${session.time.updated}`
 * → the session's extracted searchable text. A changed `updated` timestamp yields a
 * new key, so stale entries are simply never hit again (and evicted by capacity).
 * Insertion order = recency of use; oldest entries evict first past the cap.
 */
const SEARCH_CACHE_LIMIT = 200
const searchCache = new Map<string, SearchableMessage[]>()

function searchCacheGet(key: string): SearchableMessage[] | undefined {
  const hit = searchCache.get(key)
  if (hit === undefined) return undefined
  // Refresh recency: re-insert so it becomes the newest entry.
  searchCache.delete(key)
  searchCache.set(key, hit)
  return hit
}

function searchCacheSet(key: string, value: SearchableMessage[]): void {
  if (searchCache.has(key)) searchCache.delete(key)
  searchCache.set(key, value)
  while (searchCache.size > SEARCH_CACHE_LIMIT) {
    const oldest = searchCache.keys().next().value
    if (oldest === undefined) break
    searchCache.delete(oldest)
  }
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Never rejects: worker failures are the worker's own concern (it swallows them).
 */
async function promisePool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const runners: Promise<void>[] = []
  const width = Math.max(1, Math.min(concurrency, items.length))
  for (let i = 0; i < width; i++) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next
          next += 1
          if (index >= items.length) return
          results[index] = await worker(items[index])
        }
      })()
    )
  }
  await Promise.all(runners)
  return results
}

/** Build a ~60-char snippet centred on the (already-located) match, with ellipses + collapsed whitespace. */
function makeSnippet(text: string, matchIndex: number, queryLen: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  // Re-locate the match inside the collapsed string (indices shift when whitespace collapses).
  const lower = collapsed.toLowerCase()
  const q = text.substr(matchIndex, queryLen).replace(/\s+/g, ' ').toLowerCase()
  let idx = q.length > 0 ? lower.indexOf(q) : matchIndex
  if (idx < 0) idx = 0
  const radius = 30
  const start = Math.max(0, idx - radius)
  const end = Math.min(collapsed.length, idx + queryLen + radius)
  let snippet = collapsed.slice(start, end).trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < collapsed.length) snippet = `${snippet}…`
  return snippet
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

/** Reject model operations unless both the provider credential and model are
 * present in the server started by this desktop process. */
async function requireAuthorizedModel(providerID: string, modelID: string): Promise<void> {
  if (!isAuthorizedProvider(providerID)) {
    throw new Error(`Provider ${providerID} has no API key linked to this OpenCode Desktop server.`)
  }
  const config = await call<{ providers: Provider[] }>(getClient().config.providers())
  const modelExists = config.providers.some(
    (provider) => provider.id === providerID && Object.prototype.hasOwnProperty.call(provider.models ?? {}, modelID)
  )
  if (!modelExists) {
    throw new Error(`Model ${providerID}/${modelID} is not available from the linked provider.`)
  }
}

export function registerIpc(options: RegisterIpcOptions = {}): void {
  // Idempotent: a re-register (hot reload in dev) must not throw on duplicates.
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)

  ipcMain.handle('oc:status', (): ServerStatus => getStatus())

  ipcMain.handle('oc:restart', (): Promise<ServerStatus> => restartServer())

  ipcMain.handle('oc:pickDirectory', async (event): Promise<string | null> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a project folder',
      buttonLabel: 'Open project',
      properties: ['openDirectory']
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    const [first] = result.filePaths
    return first ?? null
  })

  ipcMain.handle('oc:pickFiles', async (event): Promise<string[]> => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Attach files',
      buttonLabel: 'Attach',
      properties: ['openFile', 'multiSelections']
    }
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle(
    'oc:clipboard:saveImage',
    async (_event, argsArg: unknown): Promise<string> => {
      const args = requireObject(argsArg, 'args')
      const data = requireString(args.data, 'data')
      const ext = requireString(args.ext, 'ext').toLowerCase()
      if (!PASTED_IMAGE_EXTS.has(ext)) {
        throw new Error(`Invalid IPC argument: ext must be one of ${[...PASTED_IMAGE_EXTS].join(', ')}.`)
      }
      const bytes = Buffer.from(data, 'base64')
      if (bytes.byteLength > MAX_PASTED_IMAGE_BYTES) {
        throw new Error(`Pasted image exceeds the ${MAX_PASTED_IMAGE_BYTES} byte limit.`)
      }
      const dir = pastedImagesDir()
      await mkdir(dir, { recursive: true })
      const filename = `paste-${Date.now()}-${++pastedImageCounter}.${ext}`
      const filePath = join(dir, filename)
      await writeFile(filePath, bytes)
      await prunePastedImages(dir)
      return filePath
    }
  )

  ipcMain.handle('oc:sessions:list', async (_event, directoryArg: unknown): Promise<Session[]> => {
    const directory = requireString(directoryArg, 'directory')
    setEventDirectory(directory)
    return call<Session[]>(getClient().session.list({ query: { directory } }))
  })

  ipcMain.handle(
    'oc:sessions:create',
    async (
      _event,
      directoryArg: unknown,
      titleArg: unknown,
      parentIDArg: unknown
    ): Promise<Session> => {
      const directory = requireString(directoryArg, 'directory')
      const title = optionalString(titleArg)
      // Child sessions (subagent tabs, side chats) pass parentID; omitted for a root session.
      const parentID = optionalString(parentIDArg)
      return call<Session>(
        getClient().session.create({
          query: { directory },
          body: { ...(title ? { title } : {}), ...(parentID ? { parentID } : {}) }
        })
      )
    }
  )

  ipcMain.handle(
    'oc:sessions:delete',
    async (_event, directoryArg: unknown, idArg: unknown): Promise<void> => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(idArg, 'id')
      await call<boolean>(getClient().session.delete({ path: { id }, query: { directory } }))
    }
  )

  ipcMain.handle(
    'oc:messages:list',
    async (_event, directoryArg: unknown, sessionArg: unknown): Promise<MessageWithParts[]> => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(sessionArg, 'sessionID')
      return call<MessageWithParts[]>(
        getClient().session.messages({ path: { id }, query: { directory } })
      )
    }
  )

  ipcMain.handle('oc:prompt', async (_event, argsArg: unknown): Promise<void> => {
    const args = requireObject(argsArg, 'prompt args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const providerID = requireString(args.providerID, 'providerID')
    const modelID = requireString(args.modelID, 'modelID')
    const text = requireString(args.text, 'text')

    const parts = Array.isArray(args.parts) && args.parts.length > 0
      ? args.parts
      : [{ type: 'text' as const, text }]

    // Optional per-request tool policy. Used by compare runs to disable every mutating tool so N
    // concurrent columns cannot race on one working tree. Validated rather than forwarded: keys reach
    // the agent's tool registry, so only conservative identifiers are accepted.
    const tools = optionalToolPolicy(args.tools)

    // Optional agent override (e.g. "plan"). Validated against the same charset as MCP names;
    // the server rejects unknown names, so no registry lookup is needed here.
    const agent = optionalAgentName(args.agent)

    await requireAuthorizedModel(providerID, modelID)
    await call<void>(
      getClient().session.promptAsync({
        path: { id },
        query: { directory },
        body: {
          model: { providerID, modelID },
          parts,
          ...(tools ? { tools } : {}),
          ...(agent ? { agent } : {})
        }
      })
    )
  })

  ipcMain.handle(
    'oc:abort',
    async (_event, directoryArg: unknown, sessionArg: unknown): Promise<void> => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(sessionArg, 'sessionID')
      await call<boolean>(getClient().session.abort({ path: { id }, query: { directory } }))
    }
  )

  ipcMain.handle('oc:providers', async (): Promise<ProvidersResult> => {
    const result = await call<{ providers: Provider[]; default: Record<string, string> }>(getClient().config.providers())
    return { ...result, linkedProviderIDs: getAuthorizedProviderIDs() }
  })

  ipcMain.handle('oc:permission:reply', async (_event, argsArg: unknown): Promise<void> => {
    const args = requireObject(argsArg, 'permission args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const permissionID = requireString(args.permissionID, 'permissionID')
    const response = requirePermissionResponse(args.response)

    await call<boolean>(
      getClient().postSessionIdPermissionsPermissionId({
        path: { id, permissionID },
        query: { directory },
        body: { response }
      })
    )
  })

  ipcMain.handle('oc:openExternal', async (_event, urlArg: unknown): Promise<void> => {
    const raw = requireString(urlArg, 'url')
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new Error(`Refusing to open malformed URL: ${raw}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing to open non-http(s) URL: ${raw}`)
    }
    await shell.openExternal(parsed.toString())
  })

  ipcMain.handle(
    'oc:sessions:update',
    async (_event, directoryArg: unknown, idArg: unknown, titleArg: unknown): Promise<Session> => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(idArg, 'id')
      const title = requireString(titleArg, 'title')
      return call<Session>(
        getClient().session.update({ path: { id }, query: { directory }, body: { title } })
      )
    }
  )

  ipcMain.handle('oc:sessions:summarize', async (_event, argsArg: unknown): Promise<boolean> => {
    const args = requireObject(argsArg, 'summarize args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const providerID = requireString(args.providerID, 'providerID')
    const modelID = requireString(args.modelID, 'modelID')
    await requireAuthorizedModel(providerID, modelID)
    return call<boolean>(
      getClient().session.summarize({
        path: { id },
        query: { directory },
        body: { providerID, modelID }
      })
    )
  })

  ipcMain.handle('oc:sessions:init', async (_event, argsArg: unknown): Promise<boolean> => {
    const args = requireObject(argsArg, 'init args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const providerID = requireString(args.providerID, 'providerID')
    const modelID = requireString(args.modelID, 'modelID')
    const messageID = requireString(args.messageID, 'messageID')
    await requireAuthorizedModel(providerID, modelID)
    return call<boolean>(
      getClient().session.init({
        path: { id },
        query: { directory },
        body: { providerID, modelID, messageID }
      })
    )
  })

  ipcMain.handle(
    'oc:sessions:todos',
    async (_event, directoryArg: unknown, sessionArg: unknown) => {
      const directory = requireString(directoryArg, 'directory')
      const id = requireString(sessionArg, 'sessionID')
      return call(getClient().session.todo({ path: { id }, query: { directory } }))
    }
  )

  ipcMain.handle('oc:sessions:command', async (_event, argsArg: unknown): Promise<void> => {
    const args = requireObject(argsArg, 'command args')
    const directory = requireString(args.directory, 'directory')
    const id = requireString(args.sessionID, 'sessionID')
    const command = requireString(args.command, 'command')
    const arguments_ = typeof args.arguments === 'string' ? args.arguments : ''
    // Fire-and-forget — errors arrive via SSE
    void call(
      getClient().session.command({
        path: { id },
        query: { directory },
        body: { command, arguments: arguments_ }
      })
    ).catch((err) => { console.error('oc:sessions:command failed', err) })
  })

  ipcMain.handle(
    'oc:commands:list',
    async (_event, directoryArg: unknown) => {
      const directory = requireString(directoryArg, 'directory')
      return call(getClient().command.list({ query: { directory } }))
    }
  )

  ipcMain.handle(
    'oc:find:files',
    async (_event, directoryArg: unknown, queryArg: unknown) => {
      const directory = requireString(directoryArg, 'directory')
      const query = typeof queryArg === 'string' ? queryArg : ''
      return call<string[]>(getClient().find.files({ query: { query, directory } }))
    }
  )

  ipcMain.handle(
    'oc:vcs:get',
    async (_event, directoryArg: unknown) => {
      const directory = requireString(directoryArg, 'directory')
      try {
        return await call(getClient().vcs.get({ query: { directory } }))
      } catch {
        // 404 when no VCS is available — return null instead of throwing.
        return null
      }
    }
  )

  ipcMain.handle('oc:projects:list', async () => listProjects())

  ipcMain.handle('oc:projects:create', async (_event, argsArg: unknown) => {
    const args = requireObject(argsArg, 'project create args')
    return createProject(requireString(args.name, 'name'))
  })

  ipcMain.handle('oc:projects:instructions:get', async (_event, directoryArg: unknown) => {
    return getProjectInstructions(requireString(directoryArg, 'directory'))
  })

  ipcMain.handle('oc:projects:instructions:set', async (_event, argsArg: unknown) => {
    const args = requireObject(argsArg, 'project instructions args')
    const directory = requireString(args.directory, 'directory')
    const text = typeof args.text === 'string' ? args.text : (() => { throw new Error('Invalid IPC argument: text must be a string.') })()
    await setProjectInstructions(directory, text)
  })

  ipcMain.handle('oc:projects:knowledge:list', async (_event, directoryArg: unknown) => {
    return listKnowledge(requireString(directoryArg, 'directory'))
  })

  ipcMain.handle('oc:projects:knowledge:add', async (event, argsArg: unknown) => {
    const args = requireObject(argsArg, 'project knowledge args')
    const directory = requireString(args.directory, 'directory')
    let filePaths: string[] = []
    if (args.filePaths !== undefined) {
      if (!Array.isArray(args.filePaths) || !args.filePaths.every((item) => typeof item === 'string')) {
        throw new Error('Invalid IPC argument: filePaths must be a string array.')
      }
      filePaths = args.filePaths
    }
    if (filePaths.length === 0) {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        title: 'Add knowledge files',
        buttonLabel: 'Add knowledge',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled) return listKnowledge(directory)
      filePaths = result.filePaths
    }
    return addKnowledge(directory, filePaths)
  })

  ipcMain.handle('oc:projects:knowledge:remove', async (_event, argsArg: unknown) => {
    const args = requireObject(argsArg, 'project knowledge remove args')
    await removeKnowledge(
      requireString(args.directory, 'directory'),
      requireString(args.filename, 'filename')
    )
  })

  ipcMain.handle('oc:mcp:status', (_event, directoryArg: unknown): Promise<McpSnapshot> => {
    const directory = requireString(directoryArg, 'directory')
    return getMcpSnapshot(getClient(), directory)
  })

  ipcMain.handle('oc:mcp:add', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.add args')
    const directory = requireString(args.directory, 'directory')
    return addMcp(getClient(), directory, args.name, args.config, restartServer, getClient)
  })

  ipcMain.handle('oc:mcp:remove', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.remove args')
    const directory = requireString(args.directory, 'directory')
    return removeMcp(getClient(), directory, args.name, restartServer, getClient)
  })

  ipcMain.handle('oc:mcp:connect', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.connect args')
    const directory = requireString(args.directory, 'directory')
    return connectMcp(getClient(), directory, args.name)
  })

  ipcMain.handle('oc:mcp:disconnect', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.disconnect args')
    const directory = requireString(args.directory, 'directory')
    return disconnectMcp(getClient(), directory, args.name)
  })

  ipcMain.handle('oc:mcp:auth', (_event, argsArg: unknown): Promise<McpSnapshot> => {
    const args = requireObject(argsArg, 'mcp.auth args')
    const directory = requireString(args.directory, 'directory')
    return authMcp(getClient(), directory, args.name, (url) => shell.openExternal(url))
  })

  ipcMain.handle('oc:quick:submit', async (_event, textArg: unknown): Promise<void> => {
    const text = requireString(textArg, 'text').trim()
    if (!options.onQuickSubmit) throw new Error('Quick Entry is not initialized.')
    await options.onQuickSubmit(text)
  })

  ipcMain.handle('oc:liveWindow:open', (): void => {
    if (!options.liveWindow) throw new Error('The Gemini Live window is not initialized.')
    options.liveWindow.show()
  })

  ipcMain.handle('oc:liveWindow:close', (): void => {
    if (!options.liveWindow) throw new Error('The Gemini Live window is not initialized.')
    const win = options.liveWindow.getWindow()
    if (win && !win.isDestroyed()) win.close()
  })

  ipcMain.handle('oc:liveWindow:setAlwaysOnTop', (_event, onArg: unknown): void => {
    if (!options.liveWindow) throw new Error('The Gemini Live window is not initialized.')
    if (typeof onArg !== 'boolean') {
      throw new Error('Invalid liveWindow.setAlwaysOnTop argument: on must be a boolean.')
    }
    options.liveWindow.setAlwaysOnTop(onArg)
  })

  ipcMain.handle('oc:appSettings:get', (): AppSettingsResult => {
    if (!options.appSettings) throw new Error('App settings are not initialized.')
    return options.appSettings.get()
  })

  ipcMain.handle('oc:appSettings:set', (_event, patchArg: unknown): AppSettingsResult => {
    if (!options.appSettings) throw new Error('App settings are not initialized.')
    return options.appSettings.set(patchArg)
  })

  ipcMain.handle(
    'oc:exportChat',
    async (_event, defaultNameArg: unknown, contentArg: unknown): Promise<boolean> => {
      const defaultName = requireString(defaultNameArg, 'defaultName')
      const content = requireString(contentArg, 'content')
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Export Chat History to Markdown',
        defaultPath: defaultName,
        filters: [{ name: 'Markdown Files', extensions: ['md'] }]
      }
      const { filePath, canceled } = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (canceled || !filePath) return false
      await writeFile(filePath, content, 'utf8')
      return true
    }
  )

  ipcMain.handle(
    'oc:saveFile',
    async (_event, argsArg: unknown): Promise<boolean> => {
      const args = requireObject(argsArg, 'saveFile args')
      const defaultName = requireString(args.defaultName, 'defaultName')
      const content = requireString(args.content, 'content')
      // Optional and defaulting to utf8, so every existing caller is unaffected. base64 exists so
      // generated PNGs can be saved as bytes rather than being mangled into text.
      let encoding: 'utf8' | 'base64' = 'utf8'
      if (args.encoding !== undefined) {
        if (args.encoding !== 'utf8' && args.encoding !== 'base64') {
          throw new Error('Invalid IPC argument: encoding must be "utf8" or "base64".')
        }
        encoding = args.encoding
      }
      const ext = defaultName.includes('.') ? defaultName.split('.').pop()! : 'txt'
      const win = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Save File',
        defaultPath: defaultName,
        filters: [{ name: `${ext.toUpperCase()} File`, extensions: [ext] }, { name: 'All Files', extensions: ['*'] }]
      }
      const { filePath, canceled } = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (canceled || !filePath) return false
      if (encoding === 'base64') {
        await writeFile(filePath, Buffer.from(content, 'base64'))
      } else {
        await writeFile(filePath, content, 'utf8')
      }
      return true
    }
  )

  ipcMain.handle('oc:messages:revert', async (_event, argsArg: unknown): Promise<void> => {
    const args = requireObject(argsArg, 'revert args')
    const directory = requireString(args.directory, 'directory')
    const sessionID = requireString(args.sessionID, 'sessionID')
    const messageID = requireString(args.messageID, 'messageID')
    await call<Session>(
      getClient().session.revert({
        path: { id: sessionID },
        query: { directory },
        body: { messageID }
      })
    )
  })

  ipcMain.handle('oc:messages:unrevert', async (_event, argsArg: unknown): Promise<Session> => {
    const args = requireObject(argsArg, 'unrevert args')
    const directory = requireString(args.directory, 'directory')
    const sessionID = requireString(args.sessionID, 'sessionID')
    // The updated session (with `revert` cleared) is returned so the renderer can drop its
    // reverted-state banner without waiting on the session.updated SSE event.
    return call<Session>(
      getClient().session.unrevert({ path: { id: sessionID }, query: { directory } })
    )
  })

  ipcMain.handle('oc:session:fork', async (_event, argsArg: unknown): Promise<Session> => {
    const args = requireObject(argsArg, 'fork args')
    const directory = requireString(args.directory, 'directory')
    const sessionID = requireString(args.sessionID, 'sessionID')
    const messageID = requireString(args.messageID, 'messageID')
    // The server creates the branched session and returns it — no revert/replay needed.
    return call<Session>(
      getClient().session.fork({
        path: { id: sessionID },
        query: { directory },
        body: { messageID }
      })
    )
  })

  ipcMain.handle('oc:agents:list', async (_event, directoryArg: unknown): Promise<Agent[]> => {
    const directory = requireString(directoryArg, 'directory')
    return call<Agent[]>(getClient().app.agents({ query: { directory } }))
  })

  ipcMain.handle(
    'oc:config:permission:get',
    (_event, directoryArg: unknown): Promise<PermissionConfig> => {
      const directory = requireString(directoryArg, 'directory')
      return getPermissionConfig(getClient(), directory)
    }
  )

  ipcMain.handle('oc:config:permission:set', (_event, argsArg: unknown): Promise<boolean> => {
    const args = requireObject(argsArg, 'permission.set args')
    const directory = requireString(args.directory, 'directory')
    // Strictly validated before it can reach opencode.json — unknown keys/values are rejected.
    const permission = validatePermissionConfig(args.permission)
    return setPermissionConfig(getClient(), directory, permission, restartServer)
  })

  /**
   * Search a single directory's sessions. A directory may belong to a project whose
   * folder was deleted or renamed, or that the currently-running server simply doesn't
   * know about — that must never fail the whole (possibly multi-directory) search, so
   * `session.list` itself is wrapped here in addition to the existing per-session guard.
   */
  const searchOneDirectory = async (directory: string, needle: string): Promise<ChatSearchHit[]> => {
    let sessions: Session[]
    try {
      sessions = await call<Session[]>(getClient().session.list({ query: { directory } }))
    } catch {
      // One directory failing to load (deleted/renamed/unknown to the server) must
      // never fail the whole search.
      return []
    }

    return (
      await promisePool(sessions, 4, async (session): Promise<ChatSearchHit[]> => {
        const updated = session.time?.updated ?? 0
        const cacheKey = `${session.id}:${updated}`

        let searchable = searchCacheGet(cacheKey)
        if (searchable === undefined) {
          try {
            const messages = await call<MessageWithParts[]>(
              getClient().session.messages({ path: { id: session.id }, query: { directory } })
            )
            searchable = messages.map((m) => ({
              messageID: m.info.id,
              text: m.parts
                .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
                .map((p) => p.text)
                .join('\n')
            }))
            searchCacheSet(cacheKey, searchable)
          } catch {
            // One session failing to load must never fail the whole search.
            return []
          }
        }

        const title = session.title ?? '(untitled)'
        const out: ChatSearchHit[] = []
        for (const entry of searchable) {
          const matchIndex = entry.text.toLowerCase().indexOf(needle)
          if (matchIndex >= 0) {
            out.push({
              sessionID: session.id,
              title,
              messageID: entry.messageID,
              snippet: makeSnippet(entry.text, matchIndex, needle.length),
              time: updated,
              directory
            })
          }
        }
        return out
      })
    ).flat()
  }

  ipcMain.handle(
    'oc:search:chats',
    async (
      _event,
      directoryArg: unknown,
      queryArg: unknown,
      optionsArg: unknown
    ): Promise<ChatSearchHit[]> => {
      const directory = requireString(directoryArg, 'directory')
      const query = typeof queryArg === 'string' ? queryArg : ''
      const needle = query.trim().toLowerCase()
      if (needle.length === 0) return []

      const options = parseSearchOptions(optionsArg)
      const directories =
        options.scope === 'all'
          ? resolveSearchDirectories(directory, 'all', (await listProjects()).map((p) => p.directory))
          : [directory]

      // Bound total fan-out: directories are themselves run through the bounded-pool
      // helper at concurrency 2 (on top of the existing per-session concurrency of 4),
      // so worst-case in-flight message fetches stays at 2 * 4 = 8 rather than scaling
      // linearly with the number of known projects.
      const perDirectory = await promisePool(directories, 2, (dir) => searchOneDirectory(dir, needle))

      return perDirectory
        .flat()
        .sort((a, b) => b.time - a.time)
        .slice(0, 100)
    }
  )

  /* ---------------------------------------------------------------- */
  /* BYOK key management (Stream 3A)                                  */
  /* The full key crosses IPC only renderer -> main on 'oc:keys:set'. */
  /* It is NEVER returned to the renderer; list yields masked rows.   */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('oc:keys:list', (): MaskedKeyRow[] => listKeys())

  ipcMain.handle('oc:keys:set', (_event, argsArg: unknown): void => {
    const args = requireObject(argsArg, 'keys.set args')
    const providerID = requireString(args.providerID, 'providerID')
    const key = requireString(args.key, 'key')
    try {
      setKey(providerID, key)
    } catch (error) {
      // Rethrow a message that references only the provider — never the key.
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to store key for provider ${providerID}: ${detail}`)
    }
  })

  ipcMain.handle('oc:keys:delete', (_event, providerArg: unknown): void => {
    const providerID = requireString(providerArg, 'providerID')
    deleteKey(providerID)
  })

  ipcMain.handle(
    'oc:keys:test',
    (_event, providerArg: unknown): Promise<{ ok: boolean; status?: number; detail?: string }> => {
      const providerID = requireString(providerArg, 'providerID')
      return testKey(providerID)
    }
  )

  /* ---------------------------------------------------------------- */
  /* NanoGPT — subscription catalogue + quota                          */
  /* The API key never crosses IPC; main reads it from the BYOK store. */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('oc:nanogpt:models', (): NanogptModelsResult => {
    const cache = readCacheSync()
    return {
      chat: cache.chat,
      image: cache.image,
      balanceBilled: cache.balanceBilled,
      fetchedAt: cache.fetchedAt
    }
  })

  ipcMain.handle('oc:nanogpt:refresh', async (): Promise<RefreshResult> => {
    // refreshCatalogs() fans out to both the chat and image catalog endpoints internally
    // (nanogptConfig.ts, owned by M1/M3 — not edited here); this is the only call site available
    // to gate that fan-out behind the account-wide limiter per contract T4 (D6).
    const releaseLimiter = await nanogptLimiter.acquireSlot()
    try {
      return await refreshCatalogs()
    } finally {
      releaseLimiter()
    }
  })

  ipcMain.handle('oc:nanogpt:usage', async (): Promise<NanoUsage | null> => {
    const releaseLimiter = await nanogptLimiter.acquireSlot()
    try {
      return await fetchSubscriptionUsage()
    } catch {
      // Per contract T2: null means "unknown", never a zero-valued placeholder — the UI must be
      // able to tell "usage unknown" apart from a genuinely empty account.
      return null
    } finally {
      releaseLimiter()
    }
  })

  ipcMain.handle('oc:nanogpt:balance', async (): Promise<NanoBalance | null> => {
    const releaseLimiter = await nanogptLimiter.acquireSlot()
    try {
      return await fetchBalance()
    } catch {
      // Per contract T2 / defect D5: null means "unknown", never { balance: 0 } — a $0.00 wallet
      // and a failed fetch are different states and the Settings card must distinguish them.
      return null
    } finally {
      releaseLimiter()
    }
  })

  ipcMain.handle('oc:nanogpt:weeklyUsage', (): WeeklyTokenData => tokenBudgetTracker.getWeeklyTokens())

  /**
   * Generate one or more images. This handler SPENDS MONEY, so every argument is validated against
   * an allowlist rather than forwarded: `model` must be a member of the cached catalogue (no
   * arbitrary passthrough to a paid endpoint), `size` must be a known size, and counts are capped.
   */
  ipcMain.handle('oc:nanogpt:generate', async (_event, argsArg: unknown): Promise<NanogptGenerateResult> => {
    const args = requireObject(argsArg, 'generate args')

    const prompt = requireString(args.prompt, 'prompt').trim()
    if (prompt.length > MAX_IMAGE_PROMPT) {
      throw new Error(`Prompt is too long (${prompt.length} characters; the limit is ${MAX_IMAGE_PROMPT}).`)
    }

    const model = requireString(args.model, 'model')
    const cache = await readCache()
    if (!cache.image.some((entry) => entry.id === model)) {
      throw new Error(
        `Unknown image model "${model}". Refresh the NanoGPT model list under Providers first.`
      )
    }

    let count = 1
    if (args.n !== undefined) {
      if (typeof args.n !== 'number' || !Number.isInteger(args.n) || args.n < 1 || args.n > MAX_IMAGE_COUNT) {
        throw new Error(`Invalid IPC argument: n must be an integer between 1 and ${MAX_IMAGE_COUNT}.`)
      }
      count = args.n
    }

    let size: string | undefined
    if (args.size !== undefined) {
      const requested = requireString(args.size, 'size')
      if (!IMAGE_SIZES.has(requested)) {
        throw new Error(`Unsupported image size "${requested}".`)
      }
      size = requested
    }

    const sessionID = typeof args.sessionID === 'string' && args.sessionID.length > 0 ? args.sessionID : null
    // Explicit, per-call consent to spend balance. Never defaults to true.
    const allowBalance = args.allowBalance === true

    // Refuse up front for a model already known to bill balance, unless the user opted in for this
    // call. The first generation on an unseen model cannot be pre-checked — that is the probe.
    const subscriptionOnly = options.appSettings
      ? options.appSettings.get().settings.nanogptSubscriptionOnly
      : true
    if (subscriptionOnly && !allowBalance && cache.balanceBilled.includes(model)) {
      throw new Error(
        `"${model}" bills your NanoGPT balance, not your subscription. Turn off "Subscription images only" in Settings, or pick a different model.`
      )
    }

    // Refuse a second concurrent generation on the same model — see `generationsInFlight`. Without
    // this, two calls on an untested model both pass the guard above and both spend before either
    // reports its `paymentSource`.
    if (generationsInFlight.has(model)) {
      throw new Error(`A generation with "${model}" is already running. Wait for it to finish.`)
    }
    generationsInFlight.add(model)

    let result: Awaited<ReturnType<typeof generateImage>>
    const releaseLimiter = await nanogptLimiter.acquireSlot()
    try {
      result = await generateImage({ model, prompt, n: count, ...(size ? { size } : {}) })
    } finally {
      releaseLimiter()
      generationsInFlight.delete(model)
    }

    const billing = classifyBilling(result.paymentSource)

    // Re-read rather than reusing the pre-await snapshot: the cache is on disk and this await was
    // long. Only the blacklist bookkeeping depends on it, but a stale read here would return a wrong
    // `blacklisted` flag to the UI.
    let blacklisted = false
    if (billing === 'balance' && !(await readCache()).balanceBilled.includes(model)) {
      await markBalanceBilled(model)
      blacklisted = true
    }

    // Sequential, not Promise.all: nanogptImages.saveImage() now serializes its own index.json
    // mutations internally (D1's withIndexLock), so concurrent calls are safe either way, but a
    // plain loop here is cheaper to reason about and avoids relying on that internal lock alone.
    const images: Array<{ meta: GeneratedImageMeta; base64: string }> = []
    for (const image of result.images) {
      const meta = await saveImage({
        base64: image.b64,
        sessionID,
        prompt,
        model,
        ...(size ? { size } : {}),
        ...(result.paymentSource !== undefined ? { paymentSource: result.paymentSource } : {}),
        ...(result.cost !== undefined ? { cost: result.cost } : {})
      })
      images.push({ meta, base64: image.b64 })
    }

    return {
      images,
      billing,
      route: result.route,
      blacklisted,
      ...(result.paymentSource !== undefined ? { paymentSource: result.paymentSource } : {}),
      ...(result.cost !== undefined ? { cost: result.cost } : {}),
      ...(result.remainingBalance !== undefined ? { remainingBalance: result.remainingBalance } : {})
    }
  })

  ipcMain.handle('oc:nanogpt:images:list', async (_event, sessionArg: unknown): Promise<GeneratedImageMeta[]> => {
    // Drop entries whose file vanished so the gallery never renders a broken tile.
    await reconcile()
    const sessionID = optionalString(sessionArg)
    return sessionID === undefined ? await listImages() : await listImages(sessionID)
  })

  ipcMain.handle('oc:nanogpt:images:read', async (_event, idArg: unknown): Promise<string | null> =>
    await readImage(requireString(idArg, 'id'))
  )

  ipcMain.handle('oc:nanogpt:images:delete', async (_event, idArg: unknown): Promise<void> =>
    await deleteImage(requireString(idArg, 'id'))
  )

  ipcMain.handle('oc:nanogpt:images:today', async (): Promise<number> => await imagesToday())

  ipcMain.handle('oc:live:start', (event, config: unknown): Promise<void> => startGeminiLive(event.sender, config))
  ipcMain.handle('oc:live:stop', (event): void => stopGeminiLive(event.sender.id))
  ipcMain.on('oc:live:send', (event, input: GeminiLiveInput): void => sendGeminiLive(event.sender.id, input))
  ipcMain.handle('oc:live:saveTranscript', (_event, args: unknown): string => {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw new Error('saveTranscript args must be an object with a messages array')
    }
    return saveLiveTranscript((args as { messages?: unknown }).messages)
  })
  ipcMain.handle('oc:live:transcripts:reveal', (): void => revealTranscriptsFolder())

  /* ---------------------------------------------------------------- */
  /* Leroy — the gemini-live-agent harness run as a Python sidecar.    */
  /* Keyed by event.sender.id like oc:live:*, so a window can only     */
  /* ever drive its own child process.                                 */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('oc:leroy:start', (event, optionsArg: unknown): void => {
    const options = optionsArg === undefined || optionsArg === null ? {} : requireObject(optionsArg, 'leroy start options')
    const agentDir = options.agentDir
    if (agentDir !== undefined && typeof agentDir !== 'string') throw new Error('leroy agentDir must be a string')
    const settings = options.settings
    if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) {
      throw new Error('leroy settings must be an object')
    }
    startLeroy(event.sender.id, {
      agentDir: agentDir as string | undefined,
      settings: settings as Record<string, unknown> | undefined
    })
  })
  ipcMain.handle('oc:leroy:stop', (event): void => stopLeroy(event.sender.id))
  ipcMain.handle('oc:leroy:status', (event): boolean => isLeroyRunning(event.sender.id))
  ipcMain.on('oc:leroy:send', (event, command: unknown): void => {
    // Fire-and-forget like oc:live:send; a malformed command must not reject
    // into an unhandled rejection in the renderer, so it is reported as an
    // event on the same channel the session already listens to.
    try {
      sendLeroyCommand(event.sender.id, command)
    } catch (error) {
      if (!event.sender.isDestroyed()) {
        event.sender.send(LEROY_EVENT_CHANNEL, {
          type: 'sidecar_error',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  })

  /* ---------------------------------------------------------------- */
  /* Crash log — bounded read of main's own file; the renderer never   */
  /* passes a path (main derives it from crashlog.getCrashLogPath()).  */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('oc:crashlog:read', (): CrashLogReport => readCrashLog())

  ipcMain.handle('oc:crashlog:reveal', (): void => {
    const logPath = getCrashLogPath()
    if (logPath) shell.showItemInFolder(logPath)
  })

  /* ---------------------------------------------------------------- */
  /* Agentic harness — profile CRUD, run lifecycle, tool listing.      */
  /* All work delegates to the HarnessController singleton; the        */
  /* run:start directory is renderer-supplied, so it is resolved and   */
  /* must exist as a directory (same guard the fs surface applies).    */
  /* ---------------------------------------------------------------- */

  ipcMain.handle('oc:harness:profiles:list', () => getHarnessController().listProfiles())

  ipcMain.handle('oc:harness:profiles:get', (_event, idArg: unknown) =>
    getHarnessController().getProfile(requireString(idArg, 'id')) ?? null
  )

  ipcMain.handle('oc:harness:profiles:save', (_event, profileArg: unknown) =>
    getHarnessController().saveProfile(profileArg)
  )

  ipcMain.handle('oc:harness:profiles:delete', (_event, idArg: unknown) =>
    getHarnessController().deleteProfile(requireString(idArg, 'id'))
  )

  ipcMain.handle('oc:harness:profiles:test', (_event, idArg: unknown) =>
    getHarnessController().testProfile(requireString(idArg, 'id'))
  )

  ipcMain.handle('oc:harness:run:start', (_event, argsArg: unknown): Promise<string> => {
    const args = requireObject(argsArg, 'harness run args')
    const profileId = requireString(args.profileId, 'profileId')
    const task = requireString(args.task, 'task')
    const directory = requireDirectory(args.directory, 'directory')
    return getHarnessController().startRun({ profileId, task, directory })
  })

  ipcMain.handle('oc:harness:run:stop', (_event, runIdArg: unknown): void => {
    getHarnessController().stopRun(requireString(runIdArg, 'runId'))
  })

  ipcMain.handle('oc:harness:run:status', (_event, runIdArg: unknown) =>
    getHarnessController().getRunStatus(requireString(runIdArg, 'runId')) ?? null
  )

  ipcMain.handle('oc:harness:run:list', () => getHarnessController().listRuns())

  ipcMain.handle('oc:harness:tools:list', () => getHarnessController().listTools())

  /* ---------------------------------------------------------------- */
  /* Multi-Agent Directed Acyclic Graph (DAG) orchestration engine     */
  /* Workflow discovery/loading and run lifecycle via DagController.   */
  /* ---------------------------------------------------------------- */

  ipcMain.handle(
    'oc:dag:listWorkflows',
    async (_event, directoryArg: unknown): Promise<WorkflowSummary[]> => {
      // The project directory is required and validated; never derived from
      // renderer-supplied text and never defaulted to process.cwd().
      const dir = requireDirectory(directoryArg, 'directory')
      // Disk-only pass first so builtin templates are not given a filePath
      // for a file that does not exist.
      const diskIds = new Set((await listWorkflows(dir)).map((wf) => wf.id))
      const workflows = await listWorkflows(dir, { includeBuiltin: true })
      return workflows.map((wf) => ({
        id: wf.id,
        name: wf.name,
        description: wf.description,
        nodeCount: wf.nodes ? wf.nodes.length : 0,
        filePath: diskIds.has(wf.id)
          ? join(dir, '.opencode', 'workflows', `${wf.id}.json`)
          : undefined
      }))
    }
  )

  ipcMain.handle(
    'oc:dag:loadWorkflow',
    async (_event, directoryArg: unknown, workflowIdArg: unknown): Promise<WorkflowDefinition> => {
      // Containment base is the validated project directory, never a value
      // derived from the renderer-supplied workflow reference. The loader
      // resolves `<dir>/.opencode/workflows/<id>.json` through assertSubpath
      // and falls back to a builtin template when no such file exists.
      const dir = requireDirectory(directoryArg, 'directory')
      const workflowId = requireString(workflowIdArg, 'workflowId').trim()
      if (!workflowId) {
        throw new Error('Invalid IPC argument: workflowId must be a non-empty string.')
      }
      return loadWorkflow(dir, workflowId)
    }
  )

  ipcMain.handle(
    'oc:dag:startRun',
    async (_event, reqArg: unknown): Promise<{ runId: string }> => {
      const req = requireObject(reqArg, 'startRun request')
      const workflow = req.workflow as WorkflowDefinition
      if (!workflow || typeof workflow !== 'object') {
        throw new Error('Invalid IPC argument: workflow must be a WorkflowDefinition object.')
      }
      const directory = requireDirectory(req.directory, 'directory')
      // Only a finite positive number is forwarded (NaN and Infinity are
      // dropped); DagRunner clamps it to its hard concurrency ceiling.
      const maxWorkerConcurrency =
        typeof req.maxWorkerConcurrency === 'number' &&
        Number.isFinite(req.maxWorkerConcurrency) &&
        req.maxWorkerConcurrency >= 1
          ? Math.floor(req.maxWorkerConcurrency)
          : undefined
      const result = await getDagController().startDagRun({
        workflow,
        directory,
        options: maxWorkerConcurrency ? { maxConcurrency: maxWorkerConcurrency } : undefined
      })
      return { runId: result.dagRunId }
    }
  )

  ipcMain.handle(
    'oc:dag:stopRun',
    async (_event, runIdArg: unknown): Promise<{ success: boolean }> => {
      const runId = requireString(runIdArg, 'runId')
      const success = await getDagController().stopDagRun(runId)
      return { success }
    }
  )

  ipcMain.handle(
    'oc:dag:getRunStatus',
    (_event, runIdArg: unknown): DagRunState | null => {
      const runId = requireString(runIdArg, 'runId')
      return getDagController().getDagRunStatus(runId)
    }
  )

  ipcMain.handle('oc:dag:listRuns', (): DagRunSummary[] => {
    return getDagController().listDagRuns()
  })

  /* ---------------------------------------------------------------- */
  /* Phase 1 — fs / git / terminal / editor deep-link (code surface)   */
  /* Each service owns its own handlers; this is the single place all */
  /* four are registered (unifying the previously split registration  */
  /* between here and src/main/index.ts).                             */
  /* ---------------------------------------------------------------- */

  registerFs(ipcMain)
  registerGit(ipcMain)
  registerTerminal(ipcMain)
  registerOpenEditor(ipcMain)
}


/** Remove every handler this module registered. */
export function unregisterIpc(): void {
  for (const channel of CHANNELS) ipcMain.removeHandler(channel)
  ipcMain.removeAllListeners('oc:live:send')
  ipcMain.removeAllListeners('oc:leroy:send')
}
