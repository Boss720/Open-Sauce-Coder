/**
 * PTY-backed terminal service (Phase 1 — code surface, workstream A3).
 *
 * Spike verdict: GO. `node-pty` 1.1.0 ships a prebuilt, N-API (ABI-stable) `win32-x64` binary that
 * loads without a native rebuild and drives real ConPTY sessions from inside Electron's main-context
 * Node runtime (verified empirically: `pty.spawn('powershell.exe', ...)` produced live shell output
 * under `ELECTRON_RUN_AS_NODE=1` against Electron 43 / NODE_MODULE_VERSION 148). See the workstream
 * report for the full evidence trail.
 *
 * Security (CONTRACTS.md invariant #4, "PTY confinement"):
 *  - `cwd` is pinned to the session `directory` and validated with `assertSubpath` from
 *    `projectsPaths.ts` (reused, not reimplemented — see `validatedCwd` below for how a single
 *    directory argument is threaded through a helper built for base/subpath pairs).
 *  - The child environment is built via `buildChildEnv` from `env.ts` with an EMPTY provider-vars
 *    map, so it carries only the same OS/runtime allowlist the opencode server child gets — never
 *    the `.env` provider keys or the decrypted BYOK store. `keys.ts` (BYOK) is never imported here.
 *  - Every PTY is keyed by the `WebContents` that started it and killed when that WebContents is
 *    destroyed (window close, navigation, or a renderer reload), and on app quit.
 *  - Output is coalesced/bounded before crossing IPC (see `MAX_BACKLOG_CHARS` / `FLUSH_MS`).
 */
import { randomUUID } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { basename, dirname } from 'node:path'
import { app, type IpcMain, type WebContents } from 'electron'
import * as pty from 'node-pty'
import type { IDisposable, IPty } from 'node-pty'
import { buildChildEnv } from './env'
import { assertSubpath } from './projectsPaths'

export type TermId = string

const MAX_DIM = 500
const MAX_WRITE_CHARS = 65_536
/** Per-terminal output backlog cap: bounds memory if a renderer stops draining `oc:term:data`. */
const MAX_BACKLOG_CHARS = 1_000_000
/** Output is coalesced into at most one IPC send per terminal per this window — simple back-pressure. */
const FLUSH_MS = 16
/** Largest single `oc:term:data` payload; larger flushes are split into several sends. */
const MAX_CHUNK_CHARS = 65_536

type TermSession = {
  id: TermId
  contentsId: number
  proc: IPty
  dataDisposable: IDisposable
  exitDisposable: IDisposable
}

type OutputBuffer = { text: string; timer: ReturnType<typeof setTimeout> | null }

const sessions = new Map<TermId, TermSession>()
/** WebContents id -> owned terminal ids, so a destroyed/reloaded renderer cannot orphan a PTY. */
const byContents = new Map<number, Set<TermId>>()
/** WebContents ids that already have a `destroyed` listener installed (installed at most once). */
const trackedContents = new Set<number>()
const outputBuffers = new Map<TermId, OutputBuffer>()

let quitHookInstalled = false

/* ------------------------------------------------------------------ */
/* argument validation                                                 */
/* ------------------------------------------------------------------ */

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid IPC argument: ${name} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid IPC argument: ${name} must be a non-empty string.`)
  }
  return value
}

function requireDim(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`Invalid IPC argument: ${name} must be an integer.`)
  }
  if (value < 1 || value > MAX_DIM) {
    throw new Error(`Invalid IPC argument: ${name} must be between 1 and ${MAX_DIM}.`)
  }
  return value
}

/**
 * Validate the terminal's cwd the same way every other renderer-supplied path in this app is
 * validated. `assertSubpath(baseDir, relativeOrAbsPath)` deliberately rejects `target === baseDir`
 * (see projectsPaths.ts), so it cannot be called as `assertSubpath(directory, directory)`. Splitting
 * the directory into its parent + basename and calling `assertSubpath(parent, name)` applies the
 * exact same traversal/symlink/reparse-point checks to the directory the PTY will actually run in.
 */
function validatedCwd(directory: string): string {
  const parent = dirname(directory)
  const name = basename(directory)
  if (!name || parent === directory) {
    throw new Error('Invalid terminal directory.')
  }
  return assertSubpath(parent, name)
}

/* ------------------------------------------------------------------ */
/* shell resolution                                                    */
/* ------------------------------------------------------------------ */

function resolveShell(): string {
  if (process.platform === 'win32') return 'powershell.exe'
  return process.env.SHELL && process.env.SHELL.trim().length > 0 ? process.env.SHELL : '/bin/bash'
}

/* ------------------------------------------------------------------ */
/* output coalescing (bounded + back-pressured)                        */
/* ------------------------------------------------------------------ */

function flushOutput(id: TermId, contents: WebContents): void {
  const buffer = outputBuffers.get(id)
  if (!buffer) return
  buffer.timer = null
  const text = buffer.text
  buffer.text = ''
  if (text.length === 0) return
  if (contents.isDestroyed()) return
  for (let offset = 0; offset < text.length; offset += MAX_CHUNK_CHARS) {
    contents.send('oc:term:data', { id, data: text.slice(offset, offset + MAX_CHUNK_CHARS) })
  }
}

function queueOutput(id: TermId, contents: WebContents, chunk: string): void {
  let buffer = outputBuffers.get(id)
  if (!buffer) {
    buffer = { text: '', timer: null }
    outputBuffers.set(id, buffer)
  }
  buffer.text += chunk
  if (buffer.text.length > MAX_BACKLOG_CHARS) {
    // Drop the oldest data rather than growing without bound; the renderer could not keep up anyway.
    buffer.text = buffer.text.slice(buffer.text.length - MAX_BACKLOG_CHARS)
  }
  if (!buffer.timer) {
    buffer.timer = setTimeout(() => flushOutput(id, contents), FLUSH_MS)
  }
}

function dropOutputBuffer(id: TermId): void {
  const buffer = outputBuffers.get(id)
  if (buffer?.timer) clearTimeout(buffer.timer)
  outputBuffers.delete(id)
}

/* ------------------------------------------------------------------ */
/* session bookkeeping                                                 */
/* ------------------------------------------------------------------ */

function untrack(id: TermId): TermSession | undefined {
  const session = sessions.get(id)
  if (!session) return undefined
  sessions.delete(id)
  dropOutputBuffer(id)
  const owned = byContents.get(session.contentsId)
  if (owned) {
    owned.delete(id)
    if (owned.size === 0) byContents.delete(session.contentsId)
  }
  return session
}

/** On Windows a ConPTY-hosted shell can itself spawn a process tree; reap the whole tree, following
 * the same `taskkill /T /F` precedent server.ts uses to reap the opencode child. `sync` is for
 * teardown (quit, WebContents destroyed); a single tab close stays async so it never blocks the main
 * thread. */
function killSession(id: TermId, opts: { sync?: boolean } = {}): void {
  const session = untrack(id)
  if (!session) return
  try {
    session.dataDisposable.dispose()
    session.exitDisposable.dispose()
  } catch {
    /* best-effort */
  }
  if (process.platform === 'win32') {
    const args = ['/pid', String(session.proc.pid), '/T', '/F']
    if (opts.sync) {
      // Synchronous on purpose: on quit Electron exits within ~100 ms, and an async taskkill gets
      // cut off mid-run, orphaning grandchildren (e.g. a dev server started in the terminal).
      try {
        spawnSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5000 })
      } catch {
        /* already gone; proc.kill() below is the fallback */
      }
    } else {
      execFile('taskkill', args, { windowsHide: true }, () => {
        /* the pty's own onExit already reconciles session state; a taskkill failure here is not fatal */
      })
    }
  }
  try {
    session.proc.kill()
  } catch {
    /* already gone */
  }
}

function killAllForContents(contentsId: number): void {
  const owned = byContents.get(contentsId)
  if (!owned) return
  // Sync: closing the last window destroys its WebContents before `before-quit`, so this is the
  // path that actually reaps terminals on a normal quit; the window is gone, so blocking is fine.
  for (const id of [...owned]) killSession(id, { sync: true })
  byContents.delete(contentsId)
}

function killAll(): void {
  for (const id of [...sessions.keys()]) killSession(id, { sync: true })
}

/* ------------------------------------------------------------------ */
/* registration                                                        */
/* ------------------------------------------------------------------ */

export function register(ipc: IpcMain): void {
  // Idempotent: a re-register (dev hot reload) must not throw on duplicate handlers.
  ipc.removeHandler('oc:term:start')
  ipc.removeHandler('oc:term:write')
  ipc.removeHandler('oc:term:resize')
  ipc.removeHandler('oc:term:kill')

  if (!quitHookInstalled) {
    quitHookInstalled = true
    app.on('before-quit', killAll)
  }

  ipc.handle('oc:term:start', (event, argsArg: unknown): { id: TermId } => {
    const args = requireObject(argsArg, 'term.start args')
    const directory = requireString(args.directory, 'directory')
    const cols = requireDim(args.cols, 'cols')
    const rows = requireDim(args.rows, 'rows')
    const cwd = validatedCwd(directory)

    const contents = event.sender
    const proc = pty.spawn(resolveShell(), [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd,
      env: buildChildEnv({})
    })

    const id = randomUUID()
    const dataDisposable = proc.onData((chunk) => {
      if (contents.isDestroyed()) {
        killSession(id)
        return
      }
      queueOutput(id, contents, chunk)
    })
    const exitDisposable = proc.onExit(({ exitCode }) => {
      untrack(id)
      if (!contents.isDestroyed()) contents.send('oc:term:exit', { id, code: exitCode })
    })

    sessions.set(id, { id, contentsId: contents.id, proc, dataDisposable, exitDisposable })
    let owned = byContents.get(contents.id)
    if (!owned) {
      owned = new Set()
      byContents.set(contents.id, owned)
    }
    owned.add(id)

    if (!trackedContents.has(contents.id)) {
      trackedContents.add(contents.id)
      contents.once('destroyed', () => {
        trackedContents.delete(contents.id)
        killAllForContents(contents.id)
      })
    }

    return { id }
  })

  ipc.handle('oc:term:write', (_event, argsArg: unknown): void => {
    const args = requireObject(argsArg, 'term.write args')
    const id = requireString(args.id, 'id')
    const data = typeof args.data === 'string' ? args.data : ''
    if (data.length === 0) return
    const session = sessions.get(id)
    if (!session) return // inert on an unknown/already-dead id
    session.proc.write(data.length > MAX_WRITE_CHARS ? data.slice(0, MAX_WRITE_CHARS) : data)
  })

  ipc.handle('oc:term:resize', (_event, argsArg: unknown): void => {
    const args = requireObject(argsArg, 'term.resize args')
    const id = requireString(args.id, 'id')
    const cols = requireDim(args.cols, 'cols')
    const rows = requireDim(args.rows, 'rows')
    const session = sessions.get(id)
    if (!session) return // inert on an unknown/already-dead id
    try {
      session.proc.resize(cols, rows)
    } catch {
      /* pty already exited between the renderer's resize and this call */
    }
  })

  ipc.handle('oc:term:kill', (_event, idArg: unknown): void => {
    const id = typeof idArg === 'string' ? idArg : ''
    if (!id) return
    killSession(id) // inert on an unknown/already-dead id
  })
}
