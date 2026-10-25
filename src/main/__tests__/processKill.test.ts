import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawnSync: vi.fn()
}))

vi.mock('node:child_process', () => ({ execFile: mocks.execFile, spawnSync: mocks.spawnSync }))

import { killProcessTree, setSyncProcessKill } from '../harness/tools/processKill'

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

function fakeProc(pid: number | null = 4321): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  return { pid: pid ?? undefined, kill: vi.fn() } as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> }
}

afterEach(() => {
  setSyncProcessKill(false)
  mocks.execFile.mockReset()
  mocks.spawnSync.mockReset()
})

describe('killProcessTree on win32', () => {
  it('uses non-blocking execFile taskkill by default and kills the root once it finishes', () => {
    const proc = fakeProc()
    withPlatform('win32', () => killProcessTree(proc))

    expect(mocks.spawnSync).not.toHaveBeenCalled()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    const [cmd, args, opts, cb] = mocks.execFile.mock.calls[0]
    expect(cmd).toBe('taskkill')
    expect(args).toEqual(['/pid', '4321', '/T', '/F'])
    expect(opts).toEqual({ windowsHide: true })

    // The async path only falls back to proc.kill() from its completion callback.
    expect(proc.kill).not.toHaveBeenCalled()
    cb()
    expect(proc.kill).toHaveBeenCalledTimes(1)
  })

  it('uses spawnSync taskkill after setSyncProcessKill(true)', () => {
    mocks.spawnSync.mockReturnValue({ status: 0 })
    const proc = fakeProc()
    setSyncProcessKill(true)
    withPlatform('win32', () => killProcessTree(proc))

    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1)
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '4321', '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 5000 }
    )
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('accepts a bare pid in sync mode', () => {
    mocks.spawnSync.mockReturnValue({ status: 0 })
    setSyncProcessKill(true)
    withPlatform('win32', () => killProcessTree(77))

    expect(mocks.spawnSync).toHaveBeenCalledWith('taskkill', ['/pid', '77', '/T', '/F'], expect.any(Object))
  })

  it('falls back to proc.kill() in sync mode when taskkill exits non-zero', () => {
    mocks.spawnSync.mockReturnValue({ status: 128 })
    const proc = fakeProc()
    setSyncProcessKill(true)
    withPlatform('win32', () => killProcessTree(proc))

    expect(proc.kill).toHaveBeenCalledTimes(1)
  })

  it('falls back to proc.kill() in sync mode when spawnSync reports an error or throws', () => {
    setSyncProcessKill(true)

    mocks.spawnSync.mockReturnValueOnce({ status: null, error: new Error('ETIMEDOUT') })
    const timedOut = fakeProc()
    withPlatform('win32', () => killProcessTree(timedOut))
    expect(timedOut.kill).toHaveBeenCalledTimes(1)

    mocks.spawnSync.mockImplementationOnce(() => {
      throw new Error('spawn failed')
    })
    const threw = fakeProc()
    withPlatform('win32', () => killProcessTree(threw))
    expect(threw.kill).toHaveBeenCalledTimes(1)
  })

  it('swallows a proc.kill() failure in the sync fallback', () => {
    mocks.spawnSync.mockReturnValue({ status: 1 })
    const proc = fakeProc()
    proc.kill.mockImplementation(() => {
      throw new Error('already gone')
    })
    setSyncProcessKill(true)
    expect(() => withPlatform('win32', () => killProcessTree(proc))).not.toThrow()
  })

  it('returns to the async path after setSyncProcessKill(false)', () => {
    setSyncProcessKill(true)
    setSyncProcessKill(false)
    withPlatform('win32', () => killProcessTree(fakeProc()))

    expect(mocks.spawnSync).not.toHaveBeenCalled()
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
  })

  it('does nothing without a pid', () => {
    setSyncProcessKill(true)
    withPlatform('win32', () => killProcessTree(fakeProc(null)))
    withPlatform('win32', () => killProcessTree(0))

    expect(mocks.spawnSync).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
})

describe('killProcessTree on POSIX', () => {
  it('sends SIGKILL and never shells out, with or without sync mode', () => {
    for (const sync of [false, true]) {
      setSyncProcessKill(sync)
      const proc = fakeProc()
      withPlatform('linux', () => killProcessTree(proc))
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL')
    }
    expect(mocks.spawnSync).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })

  it('signals a bare pid via process.kill', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      withPlatform('linux', () => killProcessTree(99))
      expect(killSpy).toHaveBeenCalledWith(99, 'SIGKILL')
    } finally {
      killSpy.mockRestore()
    }
  })
})
