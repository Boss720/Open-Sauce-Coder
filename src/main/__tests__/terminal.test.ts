import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void

  function makeFakePty(pid: number) {
    const dataListeners: Array<(data: string) => void> = []
    const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = []
    return {
      pid,
      cols: 80,
      rows: 24,
      process: 'shell',
      handleFlowControl: false,
      onData: vi.fn((cb: (data: string) => void) => {
        dataListeners.push(cb)
        return { dispose: vi.fn(() => { const i = dataListeners.indexOf(cb); if (i >= 0) dataListeners.splice(i, 1) }) }
      }),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        exitListeners.push(cb)
        return { dispose: vi.fn(() => { const i = exitListeners.indexOf(cb); if (i >= 0) exitListeners.splice(i, 1) }) }
      }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      __emitData: (data: string) => { for (const l of [...dataListeners]) l(data) },
      __emitExit: (e: { exitCode: number; signal?: number }) => { for (const l of [...exitListeners]) l(e) }
    }
  }

  const spawnedPtys: ReturnType<typeof makeFakePty>[] = []
  const spawn = vi.fn((_file: string, _args: unknown, options: { env?: Record<string, string | undefined>; cwd?: string }) => {
    const p = makeFakePty(1000 + spawnedPtys.length)
    ;(p as unknown as { __options: unknown }).__options = options
    spawnedPtys.push(p)
    return p
  })

  const appListeners = new Map<string, Set<Listener>>()
  const app = {
    on: vi.fn((event: string, listener: Listener) => {
      const set = appListeners.get(event) ?? new Set<Listener>()
      set.add(listener)
      appListeners.set(event, set)
    })
  }

  const execFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: unknown) => void) => {
    if (cb) cb(null)
  })

  const spawnSync = vi.fn((_cmd: string, _args: string[], _opts: unknown) => ({ status: 0, error: undefined }))

  return { spawnedPtys, spawn, app, appListeners, execFile, spawnSync }
})

vi.mock('node-pty', () => ({ spawn: mocks.spawn }))
vi.mock('electron', () => ({ app: mocks.app }))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, spawnSync: mocks.spawnSync }))

import { register, type TermId } from '../terminal'

/** Runs `fn` with `process.platform` stubbed, so the win32-only taskkill paths are exercised on any host. */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

/** Minimal fake IpcMain that records handlers by channel, matching what `register` needs. */
function makeFakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel) }),
    handlers
  }
}

/** Minimal fake WebContents: records `destroyed` listeners so tests can fire them manually. */
function makeFakeContents(id: number) {
  const destroyedListeners: Array<() => void> = []
  let destroyed = false
  return {
    id,
    isDestroyed: () => destroyed,
    send: vi.fn(),
    once: vi.fn((event: string, cb: () => void) => {
      if (event === 'destroyed') destroyedListeners.push(cb)
    }),
    __destroy: () => {
      destroyed = true
      for (const cb of [...destroyedListeners]) cb()
    }
  }
}

describe('terminal service', () => {
  let ipc: ReturnType<typeof makeFakeIpc>
  let contents: ReturnType<typeof makeFakeContents>
  const baseDir = resolve('C:/workspace/project')
  // The terminal module tracks `WebContents` by numeric id in module-level state that outlives any
  // one test (there is no exported reset hook, by design — it mirrors production lifetime). Each
  // test therefore needs its own unique WebContents id so a `destroyed` listener registered by an
  // earlier test can never be mistaken for the current test's fake instance.
  let nextContentsId = 1

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.spawnedPtys.length = 0
    // NOTE: `mocks.appListeners` is deliberately NOT cleared here. `register()` installs its
    // `before-quit` hook at most once per process (`quitHookInstalled`), so only the very first
    // `register()` call across this whole suite ever calls `app.on('before-quit', ...)` — clearing
    // the listener set on later tests would make that hook unreachable for the rest of the file.
    ipc = makeFakeIpc()
    contents = makeFakeContents(nextContentsId++)
    register(ipc as unknown as Parameters<typeof register>[0])
  })

  function start(directory: string, cols = 80, rows = 24): { id: TermId } {
    const handler = ipc.handlers.get('oc:term:start')!
    return handler({ sender: contents }, { directory, cols, rows }) as { id: TermId }
  }

  it('registers all four term channels and an app quit hook', () => {
    expect([...ipc.handlers.keys()].sort()).toEqual([
      'oc:term:kill',
      'oc:term:resize',
      'oc:term:start',
      'oc:term:write'
    ])
    expect(mocks.app.on).toHaveBeenCalledWith('before-quit', expect.any(Function))
  })

  describe('cwd containment', () => {
    it('rejects a directory whose basename resolves outside its own parent', () => {
      // basename('...\\project\\..') === '..' -> resolves outside the computed parent, exactly
      // the traversal case assertSubpath is meant to catch.
      const traversal = `${baseDir}\\..`
      expect(() => start(traversal)).toThrow(/strictly inside|Invalid terminal directory/i)
    })

    it('rejects an existing symlinked directory segment', () => {
      const root = mkdtempSync(join(tmpdir(), 'opencode-term-'))
      const outside = mkdtempSync(join(tmpdir(), 'opencode-term-outside-'))
      const linkParent = mkdtempSync(join(tmpdir(), 'opencode-term-parent-'))
      const link = join(linkParent, 'linked')
      try {
        symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        return // Windows dev-mode/privilege restrictions may prevent symlink creation in CI
      }
      expect(() => start(link)).toThrow(/symbolic/i)
      void root
    })

    it('accepts a plain absolute directory and pins the pty cwd to it', () => {
      const { id } = start(baseDir)
      expect(id).toBeTruthy()
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
      const options = mocks.spawn.mock.calls[0][2] as { cwd?: string }
      expect(options.cwd).toBe(baseDir)
    })
  })

  describe('BYOK isolation', () => {
    it('never forwards decrypted provider API key env vars to the terminal child', () => {
      const previous = { ...process.env }
      process.env.OPENAI_API_KEY = 'sk-should-not-leak'
      process.env.GEMINI_API_KEY = 'gk-should-not-leak'
      process.env.GROQ_API_KEY = 'gsk-should-not-leak'
      process.env.ANTHROPIC_API_KEY = 'ak-should-not-leak'
      try {
        start(baseDir)
        const options = mocks.spawn.mock.calls[0][2] as { env?: Record<string, string | undefined> }
        expect(options.env?.OPENAI_API_KEY).toBeUndefined()
        expect(options.env?.GEMINI_API_KEY).toBeUndefined()
        expect(options.env?.GROQ_API_KEY).toBeUndefined()
        expect(options.env?.ANTHROPIC_API_KEY).toBeUndefined()
      } finally {
        process.env = previous
      }
    })
  })

  describe('lifecycle cleanup on WebContents destruction', () => {
    it('kills every terminal owned by a WebContents when it is destroyed, and further calls are inert', () => {
      const { id } = start(baseDir)
      const pty = mocks.spawnedPtys[0]
      expect(pty.kill).not.toHaveBeenCalled()

      contents.__destroy()

      expect(pty.kill).toHaveBeenCalledTimes(1)

      // Further writes/resizes/kills on the now-dead id must be silent no-ops, not throw.
      const write = ipc.handlers.get('oc:term:write')!
      const resize = ipc.handlers.get('oc:term:resize')!
      const kill = ipc.handlers.get('oc:term:kill')!
      expect(() => write({}, { id, data: 'echo hi\r' })).not.toThrow()
      expect(() => resize({}, { id, cols: 100, rows: 40 })).not.toThrow()
      expect(() => kill({}, id)).not.toThrow()
      expect(pty.write).not.toHaveBeenCalled()
      expect(pty.resize).not.toHaveBeenCalled()
    })

    it('kills all live terminals on the app before-quit hook', () => {
      start(baseDir)
      const pty = mocks.spawnedPtys[0]
      const quitListeners = mocks.appListeners.get('before-quit') ?? new Set()
      for (const listener of quitListeners) listener()
      expect(pty.kill).toHaveBeenCalledTimes(1)
    })
  })

  describe('unknown id handling', () => {
    it('resize on an unknown id is inert, not a throw', () => {
      const resize = ipc.handlers.get('oc:term:resize')!
      expect(() => resize({}, { id: 'not-a-real-id', cols: 80, rows: 24 })).not.toThrow()
    })

    it('kill on an unknown id is inert, not a throw', () => {
      const kill = ipc.handlers.get('oc:term:kill')!
      expect(() => kill({}, 'not-a-real-id')).not.toThrow()
      expect(mocks.execFile).not.toHaveBeenCalled()
    })

    it('write on an unknown id is inert, not a throw', () => {
      const write = ipc.handlers.get('oc:term:write')!
      expect(() => write({}, { id: 'not-a-real-id', data: 'x' })).not.toThrow()
    })
  })

  describe('write/resize/kill on a live terminal', () => {
    it('forwards write and resize to the underlying pty', () => {
      const { id } = start(baseDir)
      const pty = mocks.spawnedPtys[0]
      const write = ipc.handlers.get('oc:term:write')!
      const resize = ipc.handlers.get('oc:term:resize')!
      write({}, { id, data: 'echo hi\r' })
      resize({}, { id, cols: 120, rows: 30 })
      expect(pty.write).toHaveBeenCalledWith('echo hi\r')
      expect(pty.resize).toHaveBeenCalledWith(120, 30)
    })

    it('reaps the process tree via taskkill on Windows kill', () => {
      const { id } = start(baseDir)
      const kill = ipc.handlers.get('oc:term:kill')!
      kill({}, id)
      if (process.platform === 'win32') {
        expect(mocks.execFile).toHaveBeenCalledWith(
          'taskkill',
          expect.arrayContaining(['/T', '/F']),
          expect.any(Object),
          expect.any(Function)
        )
      }
    })

    it('uses async execFile, not spawnSync, for a per-session kill on Windows', () => {
      const { id } = start(baseDir)
      const pty = mocks.spawnedPtys[0]
      const kill = ipc.handlers.get('oc:term:kill')!
      withPlatform('win32', () => kill({}, id))
      expect(mocks.execFile).toHaveBeenCalledTimes(1)
      expect(mocks.execFile).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', String(pty.pid), '/T', '/F'],
        expect.objectContaining({ windowsHide: true }),
        expect.any(Function)
      )
      expect(mocks.spawnSync).not.toHaveBeenCalled()
      expect(pty.kill).toHaveBeenCalledTimes(1)
    })

    it('reaps a destroyed WebContents synchronously on Windows (window close precedes before-quit)', () => {
      start(baseDir)
      const pty = mocks.spawnedPtys[0]
      withPlatform('win32', () => contents.__destroy())
      expect(mocks.spawnSync).toHaveBeenCalledWith(
        'taskkill',
        ['/pid', String(pty.pid), '/T', '/F'],
        expect.objectContaining({ windowsHide: true, stdio: 'ignore', timeout: 5000 })
      )
      expect(mocks.execFile).not.toHaveBeenCalled()
      expect(pty.kill).toHaveBeenCalledTimes(1)
    })

    it('reaps every live tree synchronously on before-quit on Windows, without execFile', () => {
      start(baseDir)
      start(baseDir)
      const ptys = [...mocks.spawnedPtys]
      expect(ptys).toHaveLength(2)
      const quitListeners = mocks.appListeners.get('before-quit') ?? new Set()
      withPlatform('win32', () => {
        for (const listener of quitListeners) listener()
      })
      for (const pty of ptys) {
        expect(mocks.spawnSync).toHaveBeenCalledWith(
          'taskkill',
          ['/pid', String(pty.pid), '/T', '/F'],
          expect.objectContaining({ windowsHide: true, stdio: 'ignore', timeout: 5000 })
        )
        expect(pty.kill).toHaveBeenCalledTimes(1)
      }
      expect(mocks.execFile).not.toHaveBeenCalled()
    })
  })
})
