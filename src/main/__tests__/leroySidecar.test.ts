import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The sidecar only reaches for `webContents.fromId` and the contents object's
// own `send`/`once`/`isDestroyed`, so the whole electron surface is this small.
const state = vi.hoisted(() => ({
  sent: [] as Array<{ id: number; event: Record<string, unknown> }>,
  destroyed: false,
  destroyHandlers: [] as Array<() => void>
}))

function fakeContents(id: number): unknown {
  return {
    id,
    isDestroyed: () => state.destroyed,
    send: (_channel: string, event: Record<string, unknown>) => state.sent.push({ id, event }),
    once: (_name: string, handler: () => void) => state.destroyHandlers.push(handler)
  }
}

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => (id === 99 ? null : fakeContents(id)) }
}))
vi.mock('../env', () => ({ buildChildEnv: (vars: Record<string, string>) => ({ PATH: '/usr/bin', ...vars }) }))
vi.mock('../keys', () => ({ loadByokEnv: () => ({ GEMINI_API_KEY: 'AIzaFAKEKEYFAKEKEY' }) }))

import {
  isLeroyRunning,
  resolveLeroyLaunch,
  sendLeroyCommand,
  startLeroy,
  stopAllLeroy,
  stopLeroy
} from '../leroy/sidecar'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): void }
  stderr = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): void }
  written: string[] = []
  stdin = {
    destroyed: false,
    write: (chunk: string) => this.written.push(chunk),
    end: () => {
      this.stdin.destroyed = true
    }
  }
  killed = false

  constructor() {
    super()
    this.stdout.setEncoding = () => {}
    this.stderr.setEncoding = () => {}
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  /** Frames the child received, decoded. */
  frames(): Array<Record<string, unknown>> {
    return this.written.map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  emitStdout(...frames: Array<Record<string, unknown>>): void {
    this.stdout.emit('data', frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''))
  }

  handshake(protocol = 1): void {
    this.emitStdout({ type: 'ready', protocol, run_id: 'r1' })
  }
}

type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> }

function harness(): { child: FakeChild; calls: SpawnCall[]; deps: Record<string, unknown> } {
  const child = new FakeChild()
  const calls: SpawnCall[] = []
  return {
    child,
    calls,
    deps: {
      spawnProcess: (command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options })
        return child
      },
      exists: () => true,
      home: () => 'C:/home',
      platform: 'win32' as NodeJS.Platform,
      providerEnv: () => ({ GEMINI_API_KEY: 'AIzaFAKEKEYFAKEKEY' })
    }
  }
}

function events(): Array<Record<string, unknown>> {
  return state.sent.map((entry) => entry.event)
}

beforeEach(() => {
  state.sent = []
  state.destroyed = false
  state.destroyHandlers = []
})

afterEach(() => {
  stopAllLeroy()
})

describe('resolveLeroyLaunch', () => {
  it('prefers the checkout venv interpreter on Windows', () => {
    const launch = resolveLeroyLaunch({}, { exists: () => true, home: () => 'C:/home', platform: 'win32' })
    expect(launch.agentDir).toBe(join('C:/home', 'projects', 'gemini-live-agent'))
    expect(launch.python).toBe(join(launch.agentDir, '.venv', 'Scripts', 'python.exe'))
    expect(launch.script).toBe(join(launch.agentDir, 'bridge_stdio.py'))
  })

  it('falls back to a PATH interpreter when the checkout has no venv', () => {
    const script = join('C:/agent', 'bridge_stdio.py')
    const launch = resolveLeroyLaunch(
      { agentDir: 'C:/agent' },
      { exists: (path) => path === script, home: () => 'C:/home', platform: 'win32' }
    )
    expect(launch.python).toBe('python')
  })

  it('uses posix venv layout off Windows', () => {
    const launch = resolveLeroyLaunch({ agentDir: '/opt/agent' }, { exists: () => true, platform: 'linux' })
    expect(launch.python).toBe(join('/opt/agent', '.venv', 'bin', 'python'))
  })

  it('names the directory it looked in when the script is missing', () => {
    expect(() => resolveLeroyLaunch({ agentDir: 'C:/nope' }, { exists: () => false })).toThrow(/C:\/nope/)
  })
})

describe('startLeroy', () => {
  it('spawns the interpreter unbuffered with the key in the environment, not argv', () => {
    const { child, calls, deps } = harness()
    startLeroy(1, { settings: { voice: 'Kore' } }, deps)
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['-u', join('C:/home', 'projects', 'gemini-live-agent', 'bridge_stdio.py')])
    expect(JSON.stringify(calls[0].args)).not.toContain('AIza')
    expect(calls[0].options.env).toMatchObject({ GOOGLE_API_KEY: 'AIzaFAKEKEYFAKEKEY' })
    expect(calls[0].options.cwd).toBe(join('C:/home', 'projects', 'gemini-live-agent'))
    expect(child.written).toEqual([])
  })

  it('passes the second key through only when one is configured', () => {
    const first = harness()
    startLeroy(1, {}, first.deps)
    expect(first.calls[0].options.env).not.toHaveProperty('GOOGLE_API_KEY_FREE')
    stopLeroy(1)

    const second = harness()
    second.deps.providerEnv = () => ({ GEMINI_API_KEY: 'k1', GOOGLE_API_KEY_FREE: 'k2' })
    startLeroy(1, {}, second.deps)
    expect(second.calls[0].options.env).toMatchObject({ GOOGLE_API_KEY_FREE: 'k2' })
  })

  it('holds the connect frame until the ready handshake lands, then flushes in order', () => {
    const { child, deps } = harness()
    startLeroy(1, { settings: { voice: 'Kore' } }, deps)
    sendLeroyCommand(1, { type: 'send_text', text: 'hello' })
    expect(child.written).toEqual([])

    child.handshake()
    expect(child.frames()).toEqual([
      { type: 'connect', settings: { voice: 'Kore' } },
      { type: 'send_text', text: 'hello' }
    ])
  })

  it('refuses a sidecar speaking a different protocol version', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake(2)
    expect(events()[0]).toMatchObject({ type: 'sidecar_error', message: expect.stringContaining('protocol 2') })
    expect(child.killed).toBe(true)
    expect(child.frames()).toEqual([])
  })

  it('starts without a host key and lets the harness use its own credential store', () => {
    const { calls, deps } = harness()
    deps.providerEnv = () => ({})
    const saved = { gemini: process.env.GEMINI_API_KEY, google: process.env.GOOGLE_API_KEY }
    delete process.env.GEMINI_API_KEY
    delete process.env.GOOGLE_API_KEY
    try {
      expect(() => startLeroy(1, {}, deps)).not.toThrow()
      expect(calls[0].options.env).not.toHaveProperty('GOOGLE_API_KEY')
    } finally {
      if (saved.gemini) process.env.GEMINI_API_KEY = saved.gemini
      if (saved.google) process.env.GOOGLE_API_KEY = saved.google
    }
  })

  it('rejects a start for a window that is already gone', () => {
    const { deps } = harness()
    expect(() => startLeroy(99, {}, deps)).toThrow(/window is gone/)
  })

  it('replaces an existing session rather than running two children on one microphone', () => {
    const first = harness()
    startLeroy(1, {}, first.deps)
    first.child.handshake()
    const second = harness()
    startLeroy(1, {}, second.deps)
    expect(first.child.killed).toBe(true)
    expect(isLeroyRunning(1)).toBe(true)
  })
})

describe('event stream', () => {
  it('forwards parsed frames to the owning window', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake()
    child.emitStdout(
      { type: 'connection_state_changed', state: 'live', detail: '' },
      { type: 'tool_approval_requested', call_id: 'c1', name: 'write_file', args: {}, allow_text: 'writes' }
    )
    expect(events().map((event) => event.type)).toEqual([
      'ready',
      'connection_state_changed',
      'tool_approval_requested'
    ])
  })

  it('reassembles frames split across chunk boundaries', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake()
    child.stdout.emit('data', '{"type":"session_er')
    expect(events()).toHaveLength(1)
    child.stdout.emit('data', 'ror","message":"boom","fatal":false}\n')
    expect(events()[1]).toEqual({ type: 'session_error', message: 'boom', fatal: false })
  })

  it('drops the audio meter, which a real session emits ~30 times a second', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake()
    child.emitStdout({ type: 'audio_level', source: 'mic', level: 0.3 })
    expect(events().map((event) => event.type)).toEqual(['ready'])
  })

  it('ignores stray non-JSON output on stdout', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake()
    child.stdout.emit('data', 'WARNING: sounddevice is noisy\n')
    expect(events()).toHaveLength(1)
  })

  it('reports a crash with the stderr tail, redacted', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake()
    child.stderr.emit('data', 'Traceback: bad key AIzaSECRETSECRET123 used\n')
    child.emit('exit', 1, null)
    const exit = events().at(-1) as { type: string; code: number; stderr: string }
    expect(exit.type).toBe('sidecar_exit')
    expect(exit.code).toBe(1)
    expect(exit.stderr).toContain('[redacted]')
    expect(exit.stderr).not.toContain('AIzaSECRETSECRET123')
    expect(isLeroyRunning(1)).toBe(false)
  })

  it('stays quiet when the exit was requested', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake()
    stopLeroy(1)
    child.emit('exit', 0, null)
    expect(events().map((event) => event.type)).toEqual(['ready'])
  })

  it('surfaces a spawn error', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.emit('error', new Error('spawn python ENOENT'))
    expect(events().at(-1)).toMatchObject({ type: 'sidecar_error', message: 'spawn python ENOENT' })
  })
})

describe('commands and teardown', () => {
  it('validates before writing', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake()
    expect(() => sendLeroyCommand(1, { type: 'nope' })).toThrow(/unknown leroy command/)
    expect(child.frames().map((frame) => frame.type)).toEqual(['connect'])
  })

  it('refuses commands for a window with no sidecar', () => {
    expect(() => sendLeroyCommand(7, { type: 'disconnect' })).toThrow(/not running/)
  })

  it('asks the child to disconnect before killing it', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake()
    stopLeroy(1)
    expect(child.frames().at(-1)).toEqual({ type: 'disconnect' })
    expect(child.stdin.destroyed).toBe(true)
    expect(child.killed).toBe(true)
    expect(isLeroyRunning(1)).toBe(false)
  })

  it('kills a child that never handshook without writing to it', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    stopLeroy(1)
    expect(child.written).toEqual([])
    expect(child.killed).toBe(true)
  })

  it('stops the sidecar when its window is destroyed', () => {
    const { child, deps } = harness()
    startLeroy(1, {}, deps)
    child.handshake()
    for (const handler of state.destroyHandlers) handler()
    expect(child.killed).toBe(true)
    expect(isLeroyRunning(1)).toBe(false)
  })

  it('stopAllLeroy tears down every window', () => {
    const first = harness()
    const second = harness()
    startLeroy(1, {}, first.deps)
    startLeroy(2, {}, second.deps)
    stopAllLeroy()
    expect(first.child.killed).toBe(true)
    expect(second.child.killed).toBe(true)
    expect(isLeroyRunning(1)).toBe(false)
    expect(isLeroyRunning(2)).toBe(false)
  })

  it('is a no-op when stopping a window that never started', () => {
    expect(() => stopLeroy(42)).not.toThrow()
  })
})
