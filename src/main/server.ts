/**
 * Owns the `opencode serve` child process and the SDK client that talks to it.
 *
 * Responsibilities:
 *  - locate the opencode binary (Windows-first: %APPDATA%\npm\opencode.cmd, then PATH)
 *  - pick a port, reusing an already-running OpenCode instance when one answers
 *  - spawn / supervise / kill the child process (process-tree kill on Windows)
 *  - hold the single SSE subscription and rebroadcast events to registered listeners
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createOpencodeClient, type Event as OpencodeEvent, type OpencodeClient } from '@opencode-ai/sdk'
import { buildChildEnv, linkedProviderIDs, loadProviderEnv, redactedSummary } from './env'
import { loadByokEnv } from './keys'
import { nanogptEnv, readCacheSync } from './nanogptConfig'
import { tokenBudgetTracker } from './tokenBudgetTracker'

export type ServerStatus = {
  running: boolean
  url: string | null
  /**
   * Whether the SSE subscription is live. Independent of `running`: the stream
   * can drop and reconnect on its own backoff while the HTTP server stays up,
   * and no events arrive in between.
   */
  streamConnected: boolean
  error?: string
}

export type StatusListener = (status: ServerStatus) => void
export type EventListener = (event: OpencodeEvent) => void

const HOST = '127.0.0.1'
const BASE_PORT = 4599
const PORT_ATTEMPTS = 20
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 250
const PROBE_TIMEOUT_MS = 1500
const LOG_RING_SIZE = 100
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000

const NOT_FOUND_MESSAGE = 'OpenCode CLI not found — run: npm i -g opencode-ai'

let child: ChildProcess | null = null
let client: OpencodeClient | null = null
let status: ServerStatus = { running: false, url: null, streamConnected: false }
/** true only when this process spawned the server it is talking to */
let owned = false
let stopping = false
let startInFlight: Promise<ServerStatus> | null = null
let eventGeneration = 0
let eventAbort: AbortController | null = null
/** Project directory the renderer currently has selected; scopes the SSE subscription. */
let eventDirectory: string | null = null
/** Non-secret routing authority for the server instance this process spawned. */
let authorizedProviderIDs = new Set<string>()

const logRing: string[] = []
const statusListeners = new Set<StatusListener>()
const eventListeners = new Set<EventListener>()

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function errText(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function record(chunk: string): void {
  for (const rawLine of chunk.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line) continue
    logRing.push(line)
  }
  while (logRing.length > LOG_RING_SIZE) logRing.shift()
}

/** Last few captured output lines, formatted for an error banner. */
function _tail(lines = 6): string {
  if (logRing.length === 0) return ''
  return `\n${logRing.slice(-lines).join('\n')}`
}

function setStatus(next: ServerStatus): void {
  status = next
  const snapshot: ServerStatus = { ...next }
  for (const listener of statusListeners) {
    try {
      listener(snapshot)
    } catch {
      /* a listener must never break the supervisor */
    }
  }
}

/** Patch just the stream flag, leaving the rest of the status snapshot alone. */
function setStreamConnected(connected: boolean): void {
  if (status.streamConnected === connected) return
  setStatus({ ...status, streamConnected: connected })
}

function emitEvent(event: OpencodeEvent): void {
  try {
    tokenBudgetTracker.recordEvent(event)
  } catch {
    /* tracker failure must never break event emission */
  }

  for (const listener of eventListeners) {
    try {
      listener(event)
    } catch {
      /* a listener must never break the stream loop */
    }
  }
}

/* ------------------------------------------------------------------ */
/* binary resolution                                                   */
/* ------------------------------------------------------------------ */

function binaryNames(): string[] {
  if (process.platform === 'win32') return ['opencode.cmd', 'opencode.exe', 'opencode.bat', 'opencode']
  return ['opencode']
}

/** Absolute path to the opencode launcher, or null when it is not installed. */
function resolveBinary(): string | null {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) {
      const npmGlobal = join(appData, 'npm', 'opencode.cmd')
      if (existsSync(npmGlobal)) return npmGlobal
    }
  }

  const pathEnv = process.env.PATH ?? process.env.Path ?? ''
  for (const entry of pathEnv.split(delimiter)) {
    const dir = entry.trim().replace(/^"+|"+$/g, '')
    if (!dir) continue
    for (const name of binaryNames()) {
      const candidate = join(dir, name)
      try {
        if (existsSync(candidate)) return candidate
      } catch {
        /* unreadable PATH entry — skip */
      }
    }
  }
  return null
}

/**
 * Node refuses to spawn `.cmd`/`.bat` directly (CVE-2024-27980 hardening), and we are not allowed
 * to use `shell: true`. Route those through cmd.exe explicitly with verbatim arguments instead —
 * every value here is produced by us, never by the renderer.
 */
function buildCommand(
  bin: string,
  args: string[]
): { command: string; args: string[]; verbatim: boolean } {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const quote = (value: string): string => (/[\s&|<>^"()]/.test(value) ? `"${value}"` : value)
    const line = [quote(bin), ...args.map(quote)].join(' ')
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      verbatim: true
    }
  }
  return { command: bin, args, verbatim: false }
}

function killTree(proc: ChildProcess): void {
  const pid = proc.pid
  if (pid === undefined) {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
    return
  }

  if (process.platform === 'win32') {
    // A .cmd launcher spawns a real process tree; taskkill /T is the only reliable way down.
    // Synchronous on purpose: on quit Electron exits within ~100 ms, and an async taskkill
    // gets cut off after cmd.exe dies, orphaning the real opencode.exe on the port.
    try {
      const result = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5000
      })
      if (result.error || result.status !== 0) proc.kill()
    } catch {
      /* already gone */
    }
    return
  }

  try {
    proc.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}

/* ------------------------------------------------------------------ */
/* port discovery / health probing                                     */
/* ------------------------------------------------------------------ */

/** True when an OpenCode HTTP server is answering on this port. */
async function probeOpencode(port: number): Promise<boolean> {
  const base = `http://${HOST}:${port}`

  try {
    const res = await fetch(`${base}/doc`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (res.ok) {
      const body = await res.text()
      if (body.includes('openapi') || body.includes('opencode')) return true
    }
  } catch {
    /* fall through to the /config probe */
  }

  try {
    const res = await fetch(`${base}/config`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    if (!res.ok) return false
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) return false
    const body = (await res.json()) as Record<string, unknown> | null
    if (typeof body !== 'object' || body === null) return false
    // Tighten: require at least one OpenCode-specific key to confirm it's not just any JSON response
    return '$schema' in body || 'provider' in body || 'providers' in body || 'model' in body || 'modelID' in body || 'agent' in body || 'theme' in body
  } catch {
    return false
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => {
      probe.close(() => resolve(true))
    })
    probe.listen(port, HOST)
  })
}

async function waitForReady(port: number, isDead: () => boolean): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (isDead()) return false
    if (await probeOpencode(port)) return true
    await sleep(READY_POLL_MS)
  }
  return false
}

/* ------------------------------------------------------------------ */
/* SSE stream                                                          */
/* ------------------------------------------------------------------ */

function startEventLoop(): void {
  const generation = ++eventGeneration
  void runEventLoop(generation)
}

async function runEventLoop(generation: number): Promise<void> {
  let backoff = RECONNECT_MIN_MS

  while (!stopping && generation === eventGeneration && client !== null && status.running) {
    const active = client
    const directory = eventDirectory
    const abort = new AbortController()
    eventAbort = abort

    try {
      const { stream } = await active.event.subscribe(
        directory ? { query: { directory }, signal: abort.signal } : { signal: abort.signal }
      )
      backoff = RECONNECT_MIN_MS
      setStreamConnected(true)
      for await (const event of stream) {
        if (stopping || generation !== eventGeneration) break
        emitEvent(event)
      }
    } catch (error) {
      if (abort.signal.aborted || stopping || generation !== eventGeneration) break
      record(`event stream error: ${errText(error)}`)
    } finally {
      // Covers both a thrown subscribe and a stream that simply ended: either
      // way events have stopped arriving, and the UI needs to say so.
      setStreamConnected(false)
      if (eventAbort === abort) eventAbort = null
      if (!abort.signal.aborted) abort.abort()
    }

    if (stopping || generation !== eventGeneration || !status.running) break
    await sleep(backoff)
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
  }
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

function fail(message: string): ServerStatus {
  client = null
  authorizedProviderIDs.clear()
  setStatus({ running: false, url: null, streamConnected: false, error: message })
  return { ...status }
}

async function doStart(): Promise<ServerStatus> {
  let port = -1
  for (let offset = 0; offset < PORT_ATTEMPTS; offset++) {
    const candidate = BASE_PORT + offset
    if (await isPortFree(candidate)) {
      port = candidate
      break
    }
  }

  if (port < 0) {
    return fail(
      `No usable port between ${BASE_PORT} and ${BASE_PORT + PORT_ATTEMPTS - 1} for the OpenCode server.`
    )
  }

  const url = `http://${HOST}:${port}`

  const bin = resolveBinary()
  if (!bin) return fail(NOT_FOUND_MESSAGE)

  logRing.length = 0
  const { command, args, verbatim } = buildCommand(bin, [
    'serve',
    '--hostname',
    HOST,
    '--port',
    String(port)
  ])

  const providerEnv = loadProviderEnv()
  if (providerEnv.sourcePath) {
    record(
      `loaded ${providerEnv.count} provider keys from ${providerEnv.sourcePath}: ${redactedSummary(providerEnv.vars)}`
    )
  }

  // BYOK keys (OS-encrypted store) merge ON TOP of the .env vars — BYOK wins on conflict.
  const byokVars = loadByokEnv()
  const byokCount = Object.keys(byokVars).length
  if (byokCount > 0) {
    record(`loaded ${byokCount} BYOK keys (encrypted store): ${redactedSummary(byokVars)}`)
  }
  const mergedProviderVars = { ...providerEnv.vars, ...byokVars }

  // NanoGPT is an OpenCode *custom provider*: its model map has to exist in the child's resolved
  // config before the server starts, so it is generated from the cached subscription catalogue and
  // injected as OPENCODE_CONFIG_CONTENT (deep-merges; never touches a user config file). The
  // generated JSON carries only the `{env:NANOGPT_API_KEY}` placeholder, so it is safe to log.
  const nanogptVars = nanogptEnv(Boolean(mergedProviderVars.NANOGPT_API_KEY))
  const childEnv = buildChildEnv(mergedProviderVars, nanogptVars)
  if (nanogptVars.OPENCODE_CONFIG_CONTENT) {
    record(`nanogpt: injected ${readCacheSync().chat.length} subscription models`)
  }
  authorizedProviderIDs = new Set(linkedProviderIDs(childEnv))
  record(`authorized API-key providers: ${[...authorizedProviderIDs].join(', ') || 'none'}`)

  let proc: ChildProcess
  try {
    proc = spawn(command, args, {
      cwd: homedir(),
      env: childEnv,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return fail(`Failed to launch OpenCode (${bin}): ${errText(error)}`)
  }

  let dead = false
  let exitInfo = ''

  proc.stdout?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => record(chunk))
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => record(chunk))

  proc.on('error', (error) => {
    dead = true
    exitInfo = errText(error)
    record(`spawn error: ${exitInfo}`)
  })

  proc.on('exit', (code, signal) => {
    dead = true
    exitInfo = `exit code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`
    if (child !== proc) return
    child = null
    owned = false
    if (stopping) return
    client = null
    eventGeneration++
    setStatus({
      running: false,
      url: null,
      streamConnected: false,
      error: `OpenCode server stopped (${exitInfo}).`
    })
  })

  child = proc
  owned = true

  const ready = await waitForReady(port, () => dead)
  if (!ready) {
    if (child === proc) {
      child = null
      owned = false
      killTree(proc)
    }
    return fail(
      dead
        ? `OpenCode server exited before it was ready (${exitInfo}).`
        : `Timed out after ${Math.round(READY_TIMEOUT_MS / 1000)}s waiting for OpenCode on ${url}.`
    )
  }

  client = createOpencodeClient({ baseUrl: url })
  // The stream is not up until `event.subscribe` resolves inside the loop.
  setStatus({ running: true, url, streamConnected: false })
  startEventLoop()
  return { ...status }
}

/** Start (or attach to) an OpenCode server. Safe to call repeatedly. */
export function startServer(): Promise<ServerStatus> {
  if (startInFlight) return startInFlight
  if (status.running && client) return Promise.resolve({ ...status })

  stopping = false
  const run = doStart()
    .catch((error: unknown) => fail(`Failed to start OpenCode: ${errText(error)}`))
    .finally(() => {
      startInFlight = null
    })
  startInFlight = run
  return run
}

/** Stop the SSE stream and kill the server, but only if we spawned it. */
export function stopServer(): void {
  stopping = true
  eventGeneration++
  eventAbort?.abort()
  eventAbort = null

  const proc = child
  const wasOwned = owned
  child = null
  owned = false
  client = null
  authorizedProviderIDs.clear()

  if (proc && wasOwned) killTree(proc)

  if (status.running || status.url !== null) {
    setStatus({ running: false, url: null, streamConnected: false })
  }
}

export async function restartServer(): Promise<ServerStatus> {
  stopServer()
  // Give the OS a moment to release the listening socket before probing again.
  await sleep(500)
  stopping = false
  return startServer()
}

export function getStatus(): ServerStatus {
  return { ...status }
}

/** Provider IDs backed by an API key in the effective environment of our child server. */
export function getAuthorizedProviderIDs(): string[] {
  return [...authorizedProviderIDs].sort()
}

export function isAuthorizedProvider(providerID: string): boolean {
  return authorizedProviderIDs.has(providerID)
}

/** The live SDK client. Throws when the server is not running. */
export function getClient(): OpencodeClient {
  if (!client || !status.running) {
    throw new Error(status.error ?? 'OpenCode server is not running.')
  }
  return client
}

/** Subscribe to server status changes. Returns an unsubscribe function. */
export function onStatus(callback: StatusListener): () => void {
  statusListeners.add(callback)
  return () => {
    statusListeners.delete(callback)
  }
}

/** Subscribe to the OpenCode SSE stream. Returns an unsubscribe function. */
export function onEvent(callback: EventListener): () => void {
  eventListeners.add(callback)
  return () => {
    eventListeners.delete(callback)
  }
}

/**
 * Scope the SSE subscription to a project directory (opencode instances are per-project).
 * No-op when the directory is unchanged — never tear down a healthy stream for nothing.
 * When it does change, restart the event loop so the new subscription picks it up.
 */
function normalizeDir(dir: string | null): string | null {
  if (!dir) return null
  return dir.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function setEventDirectory(directory: string | null): void {
  if (normalizeDir(directory) === normalizeDir(eventDirectory)) return
  eventDirectory = directory
  eventAbort?.abort()
  if (status.running && client) {
    startEventLoop()
  } else {
    eventGeneration++
  }
}
