/**
 * Supervises the Leroy sidecar — the `gemini-live-agent` Python harness run as
 * a child process and driven over NDJSON (see `bridge_stdio.py` there, and
 * `protocol.ts` here).
 *
 * One child per Live window, keyed by `webContents.id` exactly like
 * `geminiLive.ts`, torn down when that window is destroyed. The child owns the
 * microphone, speaker and screen capture; this app owns the UI, so the renderer
 * sends commands and renders the event stream and nothing else.
 *
 * Credentials reach the child through its environment, never through the
 * protocol or argv — argv is world-readable in the process table.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { webContents, type WebContents } from 'electron'
import { buildChildEnv } from '../env'
import { loadByokEnv } from '../keys'
import {
  encodeLeroyCommand,
  parseLeroyEvent,
  splitFrames,
  validateLeroyCommand,
  LEROY_PROTOCOL_VERSION,
  type LeroyCommand,
  type LeroyEvent
} from './protocol'

export const LEROY_EVENT_CHANNEL = 'oc:leroy:event'

/** Frames the host adds on top of the sidecar's own vocabulary. */
export type LeroyHostEvent =
  | LeroyEvent
  | { type: 'sidecar_exit'; code: number | null; signal: string | null; stderr: string }
  | { type: 'sidecar_error'; message: string }

export type LeroyLaunch = {
  /** Interpreter to spawn — the agent's own `.venv` when it has one. */
  python: string
  /** Repository root, used as cwd and as the location of `bridge_stdio.py`. */
  agentDir: string
  script: string
}

export type LeroyStartOptions = {
  /** Explicit agent checkout; falls back to `LEROY_AGENT_DIR`, then `~/projects/gemini-live-agent`. */
  agentDir?: string
  /** Partial `AppSettings` for the Python side — voice, model, working_dir, share_screen, ... */
  settings?: Record<string, unknown>
}

type Deps = {
  spawnProcess: typeof spawn
  exists: (path: string) => boolean
  home: () => string
  platform: NodeJS.Platform
  providerEnv: () => Record<string, string>
}

const defaultDeps: Deps = {
  spawnProcess: spawn,
  exists: existsSync,
  home: homedir,
  platform: process.platform,
  providerEnv: loadByokEnv
}

/**
 * Work out which interpreter and script to run.
 *
 * The agent's `.venv` is strongly preferred: the harness needs `google-genai`,
 * `sounddevice` and friends, and a bare `python` on PATH is 3.12 on this
 * machine while the checkout's venv is 3.11 with the compiled extensions
 * actually installed. Falling back to PATH is a convenience for a checkout that
 * has no venv, not a supported configuration.
 */
export function resolveLeroyLaunch(options: LeroyStartOptions = {}, deps: Partial<Deps> = {}): LeroyLaunch {
  const { exists, home, platform } = { ...defaultDeps, ...deps }
  const agentDir = options.agentDir?.trim() || process.env.LEROY_AGENT_DIR?.trim() || join(home(), 'projects', 'gemini-live-agent')
  const script = join(agentDir, 'bridge_stdio.py')
  if (!exists(script)) {
    throw new Error(`Leroy agent not found at ${agentDir}. Set LEROY_AGENT_DIR to the gemini-live-agent checkout.`)
  }
  const venv = platform === 'win32'
    ? join(agentDir, '.venv', 'Scripts', 'python.exe')
    : join(agentDir, '.venv', 'bin', 'python')
  return { python: exists(venv) ? venv : platform === 'win32' ? 'python' : 'python3', agentDir, script }
}

/** How much of the child's stderr is kept for the crash report. */
const STDERR_TAIL_LIMIT = 4000
/** A single stdout line larger than this means the child is not speaking NDJSON. */
const MAX_LINE_LENGTH = 1_000_000

type Session = {
  child: ChildProcessWithoutNullStreams
  contents: WebContents
  stdout: string
  stderr: string
  /** Set by `stopLeroy` so the exit handler reports a clean stop, not a crash. */
  userStopped: boolean
  /** The child is only writable once its `ready` handshake has been accepted. */
  ready: boolean
  /** Commands sent before `ready`; flushed in order once the handshake lands. */
  pending: LeroyCommand[]
}

const sessions = new Map<number, Session>()

function send(contents: WebContents, event: LeroyHostEvent): void {
  if (!contents.isDestroyed()) contents.send('oc:leroy:event', event)
}

function redact(message: string): string {
  return message.replace(/([?&]key=)[^&\s]+/gi, '$1[redacted]').replace(/AIza[\w-]{10,}/g, '[redacted]')
}

function write(session: Session, command: LeroyCommand): void {
  if (!session.ready) {
    session.pending.push(command)
    return
  }
  if (session.child.stdin.destroyed) return
  session.child.stdin.write(encodeLeroyCommand(command))
}

function handleLine(session: Session, line: string): void {
  const event = parseLeroyEvent(line)
  if (!event) return
  // The harness meters mic and speaker envelopes ~30 times a second. Measured
  // on a real session that is the overwhelming majority of the stream, and the
  // renderer draws no meter — forwarding it would burn IPC for nothing.
  if (event.type === 'audio_level') return
  if (event.type === 'ready') {
    if (event.protocol !== LEROY_PROTOCOL_VERSION) {
      send(session.contents, {
        type: 'sidecar_error',
        message: `Leroy sidecar speaks protocol ${event.protocol}, this build needs ${LEROY_PROTOCOL_VERSION}. Update the gemini-live-agent checkout.`
      })
      session.userStopped = true
      session.child.kill()
      return
    }
    session.ready = true
    const queued = session.pending
    session.pending = []
    for (const command of queued) write(session, command)
  }
  send(session.contents, event)
}

function attach(session: Session): void {
  const { child } = session
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const { lines, rest } = splitFrames(session.stdout + chunk)
    // A child spewing binary or an endless line would otherwise grow this
    // buffer without bound; drop the partial rather than hold it forever.
    session.stdout = rest.length > MAX_LINE_LENGTH ? '' : rest
    for (const line of lines) handleLine(session, line)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    session.stderr = (session.stderr + chunk).slice(-STDERR_TAIL_LIMIT)
  })
  child.on('error', (error: Error) => {
    send(session.contents, { type: 'sidecar_error', message: redact(error.message) })
  })
  child.on('exit', (code, signal) => {
    sessions.delete(session.contents.id)
    if (session.userStopped) return
    send(session.contents, { type: 'sidecar_exit', code, signal, stderr: redact(session.stderr) })
  })
}

/**
 * Spawn the sidecar for `contentsId` and send it a `connect`.
 *
 * Restarting is safe: an existing session for the same window is stopped first,
 * because the Python side owns the audio devices and two children would fight
 * over the microphone.
 */
export function startLeroy(contentsId: number, options: LeroyStartOptions = {}, deps: Partial<Deps> = {}): void {
  const resolved = { ...defaultDeps, ...deps }
  stopLeroy(contentsId)
  const contents = webContents.fromId(contentsId)
  if (!contents || contents.isDestroyed()) throw new Error('Leroy: the requesting window is gone.')

  const launch = resolveLeroyLaunch(options, resolved)
  const provider = resolved.providerEnv()
  // A missing key here is NOT fatal: the harness has its own credential store
  // (OS keyring, plus the checkout's .env) and a user who has been running it
  // standalone has a key there but none under Providers. Pass ours when we have
  // one and let the child report a genuine absence itself.
  const apiKey = provider.GEMINI_API_KEY ?? provider.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
  const secrets: Record<string, string> = {}
  if (apiKey) secrets.GOOGLE_API_KEY = apiKey
  // Optional second key: its presence is what arms the sidecar's dual-tier
  // fallback cascade. Without it the harness runs the legacy single-key path.
  const freeKey = provider.GOOGLE_API_KEY_FREE ?? process.env.GOOGLE_API_KEY_FREE
  if (freeKey) secrets.GOOGLE_API_KEY_FREE = freeKey

  const child = resolved.spawnProcess(launch.python, ['-u', launch.script], {
    cwd: launch.agentDir,
    env: buildChildEnv(secrets, { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams

  const session: Session = { child, contents, stdout: '', stderr: '', userStopped: false, ready: false, pending: [] }
  sessions.set(contentsId, session)
  attach(session)

  // Queued until the handshake: the child emits `ready` before it will read a
  // connect, and `write` replays anything sent in the meantime.
  write(session, { type: 'connect', settings: options.settings ?? {} })

  contents.once('destroyed', () => stopLeroy(contentsId))
}

/** Validate a renderer command and forward it to that window's sidecar. */
export function sendLeroyCommand(contentsId: number, input: unknown): void {
  const session = sessions.get(contentsId)
  if (!session) throw new Error('Leroy is not running for this window.')
  write(session, validateLeroyCommand(input))
}

/**
 * Ask the sidecar to disconnect, then stop it.
 *
 * The `disconnect` command lets the harness close the WebSocket, flush its
 * audit journal and release the audio devices; `stdin.end()` is the backstop
 * for a child that is wedged, and `kill()` follows so a hung interpreter cannot
 * outlive its window.
 */
export function stopLeroy(contentsId: number): void {
  const session = sessions.get(contentsId)
  if (!session) return
  session.userStopped = true
  sessions.delete(contentsId)
  if (!session.child.stdin.destroyed) {
    if (session.ready) session.child.stdin.write(encodeLeroyCommand({ type: 'disconnect' }))
    session.child.stdin.end()
  }
  session.child.kill()
}

export function isLeroyRunning(contentsId: number): boolean {
  return sessions.has(contentsId)
}

/** Stop every sidecar — called on app quit alongside the opencode server teardown. */
export function stopAllLeroy(): void {
  for (const contentsId of [...sessions.keys()]) stopLeroy(contentsId)
}
