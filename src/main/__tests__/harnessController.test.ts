import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 'probe' stands in for a long-running shell tool: it hangs until aborted and records, from
// inside the abort listener, which runs' signals fired.
const probe = vi.hoisted(() => ({ started: [] as string[], fired: [] as string[] }))

vi.mock('../harness/tools/builtins', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness/tools/builtins')>()
  return {
    ...actual,
    registerBuiltins: (registry: ToolRegistry) => {
      actual.registerBuiltins(registry)
      registry.register(
        { name: 'probe', description: 'test hook', parameters: { type: 'object' }, category: 'read' },
        (_args, ctx) =>
          new Promise<never>(() => {
            probe.started.push(ctx.runId)
            ctx.abortSignal.addEventListener('abort', () => probe.fired.push(ctx.runId), { once: true })
          })
      )
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'opencode-controller-')) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import { HarnessController } from '../harness/controller'
import type { ProfileStore } from '../harness/profileStore'
import type { ProviderRegistry } from '../harness/providers/registry'
import type { AgentProfile } from '../harness/profiles'
import type { ChatRequest, ChatResponse, ProviderAdapter } from '../harness/providers/adapter'
import type { ToolRegistry } from '../harness/tools/registry'

const testProfile: AgentProfile = {
  id: 'tester', name: 'Tester', provider: 'stub', model: 'm'
}

function stubProfiles(profile?: AgentProfile): ProfileStore {
  return {
    list: () => (profile ? [profile] : []),
    get: (id: string) => (profile && profile.id === id ? profile : undefined),
    save: vi.fn(),
    delete: vi.fn(),
    reset: vi.fn()
  } as unknown as ProfileStore
}

function stubProviders(adapter: ProviderAdapter, supported = true): ProviderRegistry {
  return {
    resolve: () => adapter,
    isSupported: () => supported,
    list: () => (supported ? ['stub'] : []),
    probe: vi.fn(async () => true),
    reset: vi.fn()
  } as unknown as ProviderRegistry
}

function immediateAdapter(chatResponse: Partial<ChatResponse> = {}): ProviderAdapter {
  return {
    id: 'stub',
    chat: vi.fn(async (): Promise<ChatResponse> => ({
      id: 'r1',
      content: 'done',
      finishReason: 'stop',
      usage: { input: 1, output: 1 },
      ...chatResponse
    })),
    abort: vi.fn(),
    probe: vi.fn(async () => true)
  }
}

/** Poll until the run leaves the running state (run() is fire-and-forget). */
async function waitForSettled(controller: HarnessController, runId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (controller.getRunStatus(runId)?.status !== 'running') return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('run did not settle in time')
}

describe('HarnessController', () => {
  it('rejects startRun for an unknown profile', async () => {
    const controller = new HarnessController(stubProfiles(), stubProviders(immediateAdapter()))
    await expect(
      controller.startRun({ profileId: 'nope', task: 't', directory: '/tmp' })
    ).rejects.toThrow(/Profile not found/)
  })

  it('rejects startRun when the profile provider is unsupported', async () => {
    const controller = new HarnessController(
      stubProfiles(testProfile),
      stubProviders(immediateAdapter(), false)
    )
    await expect(
      controller.startRun({ profileId: 'tester', task: 't', directory: '/tmp' })
    ).rejects.toThrow(/not supported/)
  })

  it('runs to completion: status transitions running → completed with usage and result', async () => {
    // Gated adapter: the first chat call blocks until the test releases it, so the
    // 'running' state is observable before the run completes.
    let releaseChat: (value: ChatResponse) => void = () => {}
    const gate = new Promise<ChatResponse>((resolve) => { releaseChat = resolve })
    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(() => gate),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }
    const controller = new HarnessController(stubProfiles(testProfile), stubProviders(adapter))
    const events: Array<{ runId: string; type: string }> = []
    controller.setEventCallback((runId, event) => events.push({ runId, type: event.type }))

    const runId = await controller.startRun({ profileId: 'tester', task: 'hi', directory: '/tmp' })
    expect(typeof runId).toBe('string')
    expect(controller.getRunStatus(runId)?.status).toBe('running')

    releaseChat({ id: 'r1', content: 'done', finishReason: 'stop', usage: { input: 1, output: 1 } })
    await waitForSettled(controller, runId)

    const status = controller.getRunStatus(runId)
    expect(status?.status).toBe('completed')
    expect(status?.completedAt).toBeTypeOf('number')
    expect(status?.result?.finishReason).toBe('complete')
    expect(status?.usage).toEqual({ input: 1, output: 1 })
    expect(controller.listRuns().map((r) => r.id)).toContain(runId)

    const done = events.find((e) => e.type === 'done')
    expect(done?.runId).toBe(runId)
  })

  it('stopRun cancels a running run', async () => {
    // Adapter that never resolves on its own; abort() unblocks nothing — stopRun
    // flips the status synchronously.
    const hanging: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(() => new Promise<ChatResponse>(() => {})),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }
    const controller = new HarnessController(stubProfiles(testProfile), stubProviders(hanging))

    const runId = await controller.startRun({ profileId: 'tester', task: 'hi', directory: '/tmp' })
    controller.stopRun(runId)

    const status = controller.getRunStatus(runId)
    expect(status?.status).toBe('cancelled')
    expect(status?.completedAt).toBeTypeOf('number')
    expect(hanging.abort).toHaveBeenCalledWith(runId)

    // Stopping a non-running run is a no-op, unknown ids are ignored.
    controller.stopRun(runId)
    controller.stopRun('unknown')
    expect(controller.getRunStatus(runId)?.status).toBe('cancelled')
  })

  describe('stopAll', () => {
    /** Adapter whose run hangs inside the 'probe' tool unless the task is 'finish'. */
    function probeAdapter(abort: ProviderAdapter['abort'] = vi.fn()): ProviderAdapter {
      return {
        id: 'stub',
        chat: vi.fn(async (req: ChatRequest): Promise<ChatResponse> => {
          const task = req.messages.find((m) => m.role === 'user')?.content
          if (task === 'finish') {
            return { id: 'r', content: 'done', finishReason: 'stop', usage: { input: 1, output: 1 } }
          }
          return {
            id: 'r',
            content: '',
            finishReason: 'tool_calls',
            usage: { input: 1, output: 1 },
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }]
          }
        }),
        abort,
        probe: vi.fn(async () => true)
      }
    }

    async function waitForProbe(runId: string): Promise<void> {
      for (let i = 0; i < 200; i++) {
        if (probe.started.includes(runId)) return
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error('probe tool never started')
    }

    it('aborts every running run in-tick, marks them cancelled and leaves finished runs alone', async () => {
      probe.started.length = 0
      probe.fired.length = 0
      const adapter = probeAdapter()
      const controller = new HarnessController(stubProfiles(testProfile), stubProviders(adapter))

      const doneId = await controller.startRun({ profileId: 'tester', task: 'finish', directory: '/tmp' })
      await waitForSettled(controller, doneId)
      const a = await controller.startRun({ profileId: 'tester', task: 'hang', directory: '/tmp' })
      const b = await controller.startRun({ profileId: 'tester', task: 'hang', directory: '/tmp' })
      await waitForProbe(a)
      await waitForProbe(b)
      expect(probe.fired).toEqual([])

      controller.stopAll()

      // No await: the tool abort signals (what reaps shell trees) must have fired already.
      expect([...probe.fired].sort()).toEqual([a, b].sort())
      for (const id of [a, b]) {
        const status = controller.getRunStatus(id)
        expect(status?.status).toBe('cancelled')
        expect(status?.completedAt).toBeTypeOf('number')
        expect(adapter.abort).toHaveBeenCalledWith(id)
      }
      expect(controller.getRunStatus(doneId)?.status).toBe('completed')
      expect(adapter.abort).not.toHaveBeenCalledWith(doneId)

      // Idempotent: a second sweep finds nothing running.
      controller.stopAll()
      expect(probe.fired).toHaveLength(2)
    })

    it('keeps stopping the remaining runs when one abort throws', async () => {
      probe.started.length = 0
      probe.fired.length = 0
      let failFor = ''
      const adapter = probeAdapter(
        vi.fn((id: string) => {
          if (id === failFor) throw new Error('adapter abort failed')
        })
      )
      const controller = new HarnessController(stubProfiles(testProfile), stubProviders(adapter))
      const a = await controller.startRun({ profileId: 'tester', task: 'hang', directory: '/tmp' })
      const b = await controller.startRun({ profileId: 'tester', task: 'hang', directory: '/tmp' })
      await waitForProbe(a)
      await waitForProbe(b)
      failFor = a

      expect(() => controller.stopAll()).not.toThrow()

      expect([...probe.fired].sort()).toEqual([a, b].sort())
      expect(controller.getRunStatus(b)?.status).toBe('cancelled')
    })

    it('is a no-op with no runs', () => {
      const controller = new HarnessController(stubProfiles(testProfile), stubProviders(immediateAdapter()))
      expect(() => controller.stopAll()).not.toThrow()
    })

    it('stopAllHarnessRuns sweeps an existing singleton but never constructs one', async () => {
      vi.resetModules()
      const mod = await import('../harness/controller')
      const spy = vi.spyOn(mod.HarnessController.prototype, 'stopAll')

      mod.stopAllHarnessRuns()
      expect(spy).not.toHaveBeenCalled()

      mod.getHarnessController()
      mod.stopAllHarnessRuns()
      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    })
  })

  it('getRunStatus returns undefined for unknown runs', () => {
    const controller = new HarnessController(stubProfiles(), stubProviders(immediateAdapter()))
    expect(controller.getRunStatus('missing')).toBeUndefined()
  })

  it('listTools returns the builtin tool definitions', () => {
    const controller = new HarnessController(stubProfiles(), stubProviders(immediateAdapter()))
    const names = controller.listTools().map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['fs_read', 'fs_list', 'grep', 'shell', 'think']))
  })

  it('testProfile probes the profile provider and returns false for unknown profiles', async () => {
    const providers = stubProviders(immediateAdapter())
    const controller = new HarnessController(stubProfiles(testProfile), providers)
    await expect(controller.testProfile('missing')).resolves.toBe(false)
    await expect(controller.testProfile('tester')).resolves.toBe(true)
    expect(providers.probe).toHaveBeenCalledWith('stub')
  })
})
