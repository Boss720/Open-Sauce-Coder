import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { AgentRunner, type RunnerEvent } from '../harness/runner'
import { ToolRegistry, type ToolContext } from '../harness/tools/registry'
import { registerBuiltins } from '../harness/tools/builtins'
import { killProcessTree } from '../harness/tools/processKill'
import { assertSubpath } from '../projectsPaths'
import { buildChildEnv } from '../env'
import { HarnessController } from '../harness/controller'
import { NanoGptAdapter } from '../harness/providers/nanogpt'
import { GeminiAdapter } from '../harness/providers/gemini'
import type { ProfileStore } from '../harness/profileStore'
import type { ProviderRegistry } from '../harness/providers/registry'
import type { AgentProfile } from '../harness/profiles'
import type { ChatRequest, ChatResponse, ProviderAdapter } from '../harness/providers/adapter'

function createProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    provider: 'stub',
    model: 'model-x',
    ...overrides
  }
}

function toolCall(name: string, args: Record<string, unknown> = {}): NonNullable<ChatResponse['toolCalls']>[number] {
  return {
    id: `call-${name}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  }
}

/**
 * Safely removes a temporary directory on Windows and POSIX.
 * Retries asynchronously with linear backoff to allow Windows kernel
 * process handle cleanup (cwd locks) to settle following process termination.
 * Swallows transient OS locks to avoid spurious test failures on ephemeral temp dirs.
 */
async function safeCleanDir(dir: string, retries = 10, delayMs = 50): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best effort on Windows ephemeral temp directories
  }
}

describe('R1 Adversarial Challenge: Tool Policy Broker & Pre-Execution Gates', () => {
  it('strictly blocks write, shell, and custom tools when profile is readOnly, without calling executors', async () => {
    const tools = new ToolRegistry()
    const writeSpy = vi.fn(async () => ({ output: 'written' }))
    const shellSpy = vi.fn(async () => ({ output: 'shelled' }))
    const customSpy = vi.fn(async () => ({ output: 'customed' }))
    const webSpy = vi.fn(async () => ({ output: 'webbed' }))
    const readSpy = vi.fn(async () => ({ output: 'read-ok' }))

    tools.register({ name: 'fs_write', description: 'w', parameters: {}, category: 'write' }, writeSpy)
    tools.register({ name: 'shell', description: 's', parameters: {}, category: 'shell' }, shellSpy)
    tools.register({ name: 'custom_lint', description: 'c', parameters: {}, category: 'custom' }, customSpy)
    tools.register({ name: 'web_fetch', description: 'wf', parameters: {}, category: 'web' }, webSpy)
    tools.register({ name: 'fs_read', description: 'r', parameters: {}, category: 'read' }, readSpy)

    let turnCount = 0
    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(async () => {
        turnCount++
        if (turnCount === 1) {
          return {
            id: 'r1',
            content: '',
            finishReason: 'tool_calls' as const,
            usage: { input: 1, output: 1 },
            toolCalls: [
              toolCall('fs_write', { path: 'a.txt' }),
              toolCall('shell', { command: 'dir' }),
              toolCall('custom_lint', {}),
              toolCall('web_fetch', { url: 'http://example.com' }),
              toolCall('fs_read', { path: 'allowed.txt' })
            ]
          }
        }
        return {
          id: 'r2',
          content: 'final after policy checks',
          finishReason: 'stop' as const,
          usage: { input: 1, output: 1 }
        }
      }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }

    const events: RunnerEvent[] = []
    const runner = new AgentRunner({
      id: 'adv-run-1',
      profile: createProfile({ readOnly: true }),
      adapter,
      tools,
      directory: '/tmp'
    })

    const result = await runner.run('adversarial turn', (e) => events.push(e))

    // Non-read tool executors must NEVER be called
    expect(writeSpy).toHaveBeenCalledTimes(0)
    expect(shellSpy).toHaveBeenCalledTimes(0)
    expect(customSpy).toHaveBeenCalledTimes(0)
    expect(webSpy).toHaveBeenCalledTimes(0)

    // Allowed read tool executor WAS called
    expect(readSpy).toHaveBeenCalledTimes(1)

    // Verify error events emitted for blocked tools
    const toolResults = events.filter((e) => e.type === 'tool_result')
    const writeRes = toolResults.find((e) => e.name === 'fs_write')
    expect(writeRes?.error).toMatch(/read-only policy/i)
    const shellRes = toolResults.find((e) => e.name === 'shell')
    expect(shellRes?.error).toMatch(/read-only policy/i)
    const customRes = toolResults.find((e) => e.name === 'custom_lint')
    expect(customRes?.error).toMatch(/read-only policy/i)
    const webRes = toolResults.find((e) => e.name === 'web_fetch')
    expect(webRes?.error).toMatch(/read-only policy/i)

    expect(result.finishReason).toBe('complete')
  })

  it('strictly blocks all tools when profile has empty tools: []', async () => {
    const tools = new ToolRegistry()
    const readSpy = vi.fn(async () => ({ output: 'read' }))
    const thinkSpy = vi.fn(async () => ({ output: 'thought' }))
    tools.register({ name: 'fs_read', description: 'r', parameters: {}, category: 'read' }, readSpy)
    tools.register({ name: 'think', description: 't', parameters: {}, category: 'read' }, thinkSpy)

    // Registry forProfile must return empty array
    const exposed = tools.forProfile({ tools: [] })
    expect(exposed).toEqual([])

    let turn = 0
    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(async () => {
        turn++
        if (turn === 1) {
          return {
            id: 'r1',
            content: '',
            finishReason: 'tool_calls' as const,
            usage: { input: 1, output: 1 },
            toolCalls: [toolCall('fs_read', { path: 'x.txt' }), toolCall('think', { thought: 't' })]
          }
        }
        return { id: 'r2', content: 'done', finishReason: 'stop' as const, usage: { input: 1, output: 1 } }
      }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }

    const events: RunnerEvent[] = []
    const runner = new AgentRunner({
      id: 'adv-run-2',
      profile: createProfile({ tools: [] }),
      adapter,
      tools,
      directory: '/tmp'
    })

    const result = await runner.run('test empty tools', (e) => events.push(e))
    expect(readSpy).toHaveBeenCalledTimes(0)
    expect(thinkSpy).toHaveBeenCalledTimes(0)
    expect(result.finishReason).toBe('complete')

    const errors = events.filter((e): e is Extract<RunnerEvent, { type: 'tool_result' }> => e.type === 'tool_result').map((e) => e.error)
    expect(errors.every((err) => /no tools allowed/i.test(err ?? ''))).toBe(true)
  })

  it('strictly blocks tools on toolDenyList even if listed in tools allowlist', async () => {
    const tools = new ToolRegistry()
    const shellSpy = vi.fn(async () => ({ output: 'shelled' }))
    const readSpy = vi.fn(async () => ({ output: 'read' }))
    tools.register({ name: 'shell', description: 's', parameters: {}, category: 'shell' }, shellSpy)
    tools.register({ name: 'fs_read', description: 'r', parameters: {}, category: 'read' }, readSpy)

    let turn = 0
    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(async () => {
        turn++
        if (turn === 1) {
          return {
            id: 'r1',
            content: '',
            finishReason: 'tool_calls' as const,
            usage: { input: 1, output: 1 },
            toolCalls: [toolCall('shell', { command: 'echo 1' }), toolCall('fs_read', { path: 'a.txt' })]
          }
        }
        return { id: 'r2', content: 'done', finishReason: 'stop' as const, usage: { input: 1, output: 1 } }
      }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }

    const runner = new AgentRunner({
      id: 'adv-run-3',
      profile: createProfile({ tools: ['shell', 'fs_read'], toolDenyList: ['shell'] }),
      adapter,
      tools,
      directory: '/tmp'
    })

    const events: RunnerEvent[] = []
    await runner.run('test denylist', (e) => events.push(e))

    expect(shellSpy).toHaveBeenCalledTimes(0)
    expect(readSpy).toHaveBeenCalledTimes(1)

    const shellResult = events.find((e): e is Extract<RunnerEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.name === 'shell')
    expect(shellResult?.error).toMatch(/denied by profile policy/i)
  })

  it('ToolRegistry.execute directly enforces policy even if runner broker is bypassed', async () => {
    const registry = new ToolRegistry()
    const writeSpy = vi.fn(async () => ({ output: 'wrote' }))
    registry.register({ name: 'fs_write', description: 'w', parameters: {}, category: 'write' }, writeSpy)

    const ctx: ToolContext = {
      directory: '/tmp',
      agentId: 'a',
      runId: 'r',
      abortSignal: new AbortController().signal,
      profile: { readOnly: true }
    }

    const res = await registry.execute('fs_write', { path: 'a' }, ctx)
    expect(writeSpy).toHaveBeenCalledTimes(0)
    expect(res.error).toMatch(/read-only policy/i)

    const ctxDenied: ToolContext = {
      ...ctx,
      profile: { toolDenyList: ['fs_write'] }
    }
    const resDenied = await registry.execute('fs_write', { path: 'a' }, ctxDenied)
    expect(writeSpy).toHaveBeenCalledTimes(0)
    expect(resDenied.error).toMatch(/denied by profile policy/i)

    const ctxNoTools: ToolContext = {
      ...ctx,
      profile: { tools: [] }
    }
    const resNoTools = await registry.execute('fs_write', { path: 'a' }, ctxNoTools)
    expect(writeSpy).toHaveBeenCalledTimes(0)
    expect(resNoTools.error).toMatch(/no tools allowed/i)

    const ctxNotAllowed: ToolContext = {
      ...ctx,
      profile: { tools: ['think'] }
    }
    const resNotAllowed = await registry.execute('fs_write', { path: 'a' }, ctxNotAllowed)
    expect(writeSpy).toHaveBeenCalledTimes(0)
    expect(resNotAllowed.error).toMatch(/not in profile allowed tools/i)
  })
})

describe('R1 Adversarial Challenge: Child Process Environment Sanitization', () => {
  const origEnv = { ...process.env }

  beforeEach(() => {
    process.env.NANOGPT_API_KEY = 'super-secret-nanogpt-token'
    process.env.GEMINI_API_KEY = 'super-secret-gemini-token'
    process.env.GOOGLE_API_KEY = 'super-secret-google-token'
    process.env.OPENAI_API_KEY = 'super-secret-openai-token'
    process.env.AWS_SECRET_ACCESS_KEY = 'super-secret-aws-key'
    process.env.GITHUB_TOKEN = 'ghp_secret_token_123456789'
    process.env.DATABASE_URL = 'postgres://user:secretpass@host/db'
  })

  afterEach(() => {
    process.env = { ...origEnv }
  })

  it('buildChildEnv({}) strips all API keys, database credentials, and host secrets', () => {
    const sanitized = buildChildEnv({})
    expect(sanitized.NANOGPT_API_KEY).toBeUndefined()
    expect(sanitized.GEMINI_API_KEY).toBeUndefined()
    expect(sanitized.GOOGLE_API_KEY).toBeUndefined()
    expect(sanitized.OPENAI_API_KEY).toBeUndefined()
    expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(sanitized.GITHUB_TOKEN).toBeUndefined()
    expect(sanitized.DATABASE_URL).toBeUndefined()

    // But essential runtime execution keys are preserved
    expect(sanitized.PATH || sanitized.Path).toBeDefined()
  })

  it('shell builtin tool executes commands in sanitized environment without leaking host secrets', async () => {
    const registry = new ToolRegistry()
    registerBuiltins(registry)

    const scriptDir = mkdtempSync(join(tmpdir(), 'adv-shell-test-'))
    const scriptPath = join(scriptDir, 'check_env.cjs')
    writeFileSync(
      scriptPath,
      'process.stdout.write(JSON.stringify({ ' +
      'hasNanoGpt: Boolean(process.env.NANOGPT_API_KEY), ' +
      'hasGemini: Boolean(process.env.GEMINI_API_KEY), ' +
      'hasAws: Boolean(process.env.AWS_SECRET_ACCESS_KEY), ' +
      'hasPath: Boolean(process.env.PATH || process.env.Path) ' +
      '}))'
    )

    try {
      const result = await registry.execute(
        'shell',
        { command: 'node check_env.cjs' },
        { directory: scriptDir, agentId: 'a', runId: 'r', abortSignal: new AbortController().signal }
      )

      expect(result.error).toBeUndefined()
      const parsed = JSON.parse(result.output)
      expect(parsed.hasNanoGpt).toBe(false)
      expect(parsed.hasGemini).toBe(false)
      expect(parsed.hasAws).toBe(false)
      expect(parsed.hasPath).toBe(true)
      expect(result.output).not.toContain('super-secret')
    } finally {
      await safeCleanDir(scriptDir)
    }
  })
})

describe('R1 Adversarial Challenge: Path Containment & fs_list Root Handling', () => {
  let tempBase: string

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'adv-path-containment-'))
    writeFileSync(join(tempBase, 'root-anchor.txt'), 'root-content')
  })

  afterEach(async () => {
    await safeCleanDir(tempBase)
  })

  it('assertSubpath rejects sophisticated traversal attacks and outside paths', () => {
    const maliciousPaths = [
      '../outside.txt',
      '..\\outside.txt',
      'subdir/../../outside.txt',
      'subdir\\..\\..\\outside.txt',
      'sub/sub2/../../../outside.txt',
      './../outside.txt',
      '.\\..\\outside.txt',
      './../../outside.txt',
      resolve(tempBase, '..', 'sibling.txt'),
      resolve(tempBase, '..'),
      process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd'
    ]

    for (const target of maliciousPaths) {
      expect(() => assertSubpath(tempBase, target), `Should reject ${target}`).toThrow(/strictly inside|escapes/i)
      expect(() => assertSubpath(tempBase, target, { allowRoot: true }), `Should reject ${target} with allowRoot:true`).toThrow(/strictly inside|escapes/i)
    }
  })

  it('assertSubpath strictly enforces allowRoot semantics', () => {
    // With allowRoot: false (default), root path is forbidden
    expect(() => assertSubpath(tempBase, '.')).toThrow(/strictly inside/i)
    expect(() => assertSubpath(tempBase, '')).toThrow(/non-empty/i)

    // With allowRoot: true, root path is safely canonicalized
    expect(assertSubpath(tempBase, '.', { allowRoot: true })).toBe(resolve(tempBase))
    expect(assertSubpath(tempBase, '', { allowRoot: true })).toBe(resolve(tempBase))
    expect(assertSubpath(tempBase, 'child.txt', { allowRoot: true })).toBe(resolve(tempBase, 'child.txt'))
  })

  it('fs_list tool safely lists root directory with "." and "" and rejects traversal', async () => {
    const registry = new ToolRegistry()
    registerBuiltins(registry)
    const ctx: ToolContext = {
      directory: tempBase,
      agentId: 'a',
      runId: 'r',
      abortSignal: new AbortController().signal
    }

    const dotRes = await registry.execute('fs_list', { path: '.' }, ctx)
    expect(dotRes.error).toBeUndefined()
    expect(dotRes.output).toContain('root-anchor.txt')

    const emptyRes = await registry.execute('fs_list', { path: '' }, ctx)
    expect(emptyRes.error).toBeUndefined()
    expect(emptyRes.output).toContain('root-anchor.txt')

    const spaceRes = await registry.execute('fs_list', { path: '   ' }, ctx)
    expect(spaceRes.error).toBeUndefined()
    expect(spaceRes.output).toContain('root-anchor.txt')

    const traversalRes = await registry.execute('fs_list', { path: '../' }, ctx)
    expect(traversalRes.error).toMatch(/project directory|inside/i)

    const nestedTraversalRes = await registry.execute('fs_list', { path: 'child/../../' }, ctx)
    expect(nestedTraversalRes.error).toMatch(/project directory|inside/i)
  })
})

describe('R2 Adversarial Challenge: Deterministic Request Tracking & Cancellation Pipeline', () => {
  it('halts queued tool execution immediately on abort during multi-tool batch', async () => {
    const tools = new ToolRegistry()
    let runnerRef: AgentRunner | null = null

    const tool1 = vi.fn(async () => {
      // Abort during execution of tool 1
      runnerRef?.abort()
      return { output: 't1 executed' }
    })
    const tool2 = vi.fn(async () => ({ output: 't2 executed' }))
    const tool3 = vi.fn(async () => ({ output: 't3 executed' }))

    tools.register({ name: 't1', description: 't1', parameters: {}, category: 'read' }, tool1)
    tools.register({ name: 't2', description: 't2', parameters: {}, category: 'read' }, tool2)
    tools.register({ name: 't3', description: 't3', parameters: {}, category: 'read' }, tool3)

    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(async () => ({
        id: 'r1',
        content: '',
        finishReason: 'tool_calls' as const,
        usage: { input: 1, output: 1 },
        toolCalls: [toolCall('t1'), toolCall('t2'), toolCall('t3')]
      })),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }

    const runner = new AgentRunner({
      id: 'multi-tool-abort-run',
      profile: createProfile(),
      adapter,
      tools,
      directory: '/tmp'
    })
    runnerRef = runner

    const events: RunnerEvent[] = []
    const result = await runner.run('multi tool abort', (e) => events.push(e))

    // Only tool1 was invoked before abort; tool2 and tool3 must NEVER run
    expect(tool1).toHaveBeenCalledTimes(1)
    expect(tool2).toHaveBeenCalledTimes(0)
    expect(tool3).toHaveBeenCalledTimes(0)

    expect(result.finishReason).toBe('aborted')
    const doneEvent = events.find((e) => e.type === 'done')
    expect(doneEvent).toMatchObject({ type: 'done', result: { finishReason: 'aborted' } })
  })

  it('propagates abort during in-flight transport to active requestId and runId, returning finishReason "aborted"', async () => {
    let capturedRequest: ChatRequest | null = null
    let abortDeferredResolve: (() => void) | null = null
    const abortDeferred = new Promise<void>((r) => { abortDeferredResolve = r })

    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(async (req: ChatRequest): Promise<ChatResponse> => {
        capturedRequest = req
        return new Promise<ChatResponse>((_resolve, reject) => {
          if (req.signal) {
            req.signal.addEventListener('abort', () => {
              abortDeferredResolve?.()
              reject(new Error('Request aborted.'))
            })
          }
        })
      }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }

    const runner = new AgentRunner({
      id: 'transport-abort-run',
      profile: createProfile(),
      adapter,
      tools: new ToolRegistry(),
      directory: '/tmp'
    })

    const runPromise = runner.run('transport abort task', () => {})

    // Wait until chat is called and captured
    for (let i = 0; i < 50; i++) {
      if (capturedRequest) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(capturedRequest).not.toBeNull()
    expect(capturedRequest!.requestId).toBe('transport-abort-run-turn-0')
    expect(capturedRequest!.signal?.aborted).toBe(false)

    // Abort runner while chat is in-flight
    runner.abort()
    await abortDeferred

    expect(capturedRequest!.signal?.aborted).toBe(true)
    expect(adapter.abort).toHaveBeenCalledWith('transport-abort-run-turn-0')
    expect(adapter.abort).toHaveBeenCalledWith('transport-abort-run')

    const result = await runPromise
    expect(result.finishReason).toBe('aborted')
  })

  it('HarnessController preserves "cancelled" status and does not overwrite with "failed" on abort', async () => {
    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(async (req: ChatRequest) => {
        return new Promise<ChatResponse>((_resolve, reject) => {
          req.signal?.addEventListener('abort', () => reject(new Error('Aborted by signal')))
        })
      }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }

    const controller = new HarnessController(
      {
        list: () => [createProfile({ id: 'prof-1' })],
        get: (id: string) => (id === 'prof-1' ? createProfile({ id: 'prof-1' }) : undefined),
        save: vi.fn(),
        delete: vi.fn(),
        reset: vi.fn()
      } as unknown as ProfileStore,
      {
        resolve: () => adapter,
        isSupported: () => true,
        list: () => ['stub'],
        probe: vi.fn(async () => true),
        reset: vi.fn()
      } as unknown as ProviderRegistry
    )

    const runId = await controller.startRun({ profileId: 'prof-1', task: 'do-it', directory: '/tmp' })
    expect(controller.getRunStatus(runId)?.status).toBe('running')

    // Stop the run
    controller.stopRun(runId)
    expect(controller.getRunStatus(runId)?.status).toBe('cancelled')

    // Wait for the async runner promise to settle and ensure status remains 'cancelled'
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }

    const finalStatus = controller.getRunStatus(runId)
    expect(finalStatus?.status).toBe('cancelled')
    expect(finalStatus?.status).not.toBe('failed')
  })

  it('killProcessTree terminates spawned process trees cleanly', async () => {
    // Spawn a long running node process
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
      stdio: 'ignore'
    })

    expect(child.pid).toBeTypeOf('number')
    expect(child.killed).toBe(false)

    // Call killProcessTree
    killProcessTree(child)

    // Wait for exit
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
      setTimeout(() => resolve(-999), 5000)
    })

    expect(exitCode).not.toBe(-999)
  })

  it('NanoGPT and Gemini adapters handle abort signals and correlation IDs', () => {
    const nanoGpt = new NanoGptAdapter()
    expect(nanoGpt.id).toBe('nanogpt')
    // nanoGpt.abort with non-existent or prefix id does not throw
    expect(() => nanoGpt.abort('non-existent')).not.toThrow()
    expect(() => nanoGpt.abort('prefix-*')).not.toThrow()

    const gemini = new GeminiAdapter()
    expect(gemini.id).toBe('google')
    expect(() => gemini.abort('non-existent')).not.toThrow()
    expect(() => gemini.abort('prefix-*')).not.toThrow()
  })

  it('aborting during a long-running shell command kills child process promptly via abortSignal', async () => {
    const registry = new ToolRegistry()
    registerBuiltins(registry)

    const abortController = new AbortController()
    const scriptDir = mkdtempSync(join(tmpdir(), 'adv-shell-abort-'))

    const startTime = Date.now()
    // Command that sleeps for 30 seconds
    const hangCmd = 'node -e "setTimeout(() => {}, 30000)"'

    const executePromise = registry.execute(
      'shell',
      { command: hangCmd },
      { directory: scriptDir, agentId: 'a', runId: 'r', abortSignal: abortController.signal }
    )

    // Wait 100ms then abort
    setTimeout(() => {
      abortController.abort()
    }, 100)

    const res = await executePromise
    const duration = Date.now() - startTime

    // The command should terminate well under 5 seconds (not wait 30s)
    expect(duration).toBeLessThan(5000)
    expect(res.error).toBeDefined()
    await safeCleanDir(scriptDir)
  })

  it('wildcard tools: ["*"] strictly obeys readOnly and toolDenyList constraints', () => {
    const tools = new ToolRegistry()
    tools.register({ name: 'fs_read', description: 'r', parameters: {}, category: 'read' }, vi.fn())
    tools.register({ name: 'fs_write', description: 'w', parameters: {}, category: 'write' }, vi.fn())
    tools.register({ name: 'shell', description: 's', parameters: {}, category: 'shell' }, vi.fn())
    tools.register({ name: 'think', description: 't', parameters: {}, category: 'read' }, vi.fn())

    // Profile with wildcard tools: ['*'], but readOnly: true and denyList: ['think']
    const profileDef = {
      tools: ['*'],
      readOnly: true,
      toolDenyList: ['think']
    }

    const available = tools.forProfile(profileDef)
    const availableNames = available.map((t) => t.name)

    // fs_write and shell are blocked because readOnly: true
    expect(availableNames).not.toContain('fs_write')
    expect(availableNames).not.toContain('shell')

    // think is blocked because toolDenyList
    expect(availableNames).not.toContain('think')

    // Only fs_read passes
    expect(availableNames).toEqual(['fs_read'])
  })

  it('custom tools are blocked under readOnly profile and inherit sanitized env', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'adv-custom-tools-'))
    const customToolsDir = join(projectDir, '.opencode', 'harness', 'tools')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(customToolsDir, { recursive: true })

    // Create a custom tool that outputs an env check
    writeFileSync(
      join(customToolsDir, 'my_custom_tool.json'),
      JSON.stringify({
        name: 'my_custom_tool',
        description: 'Test custom tool',
        parameters: { type: 'object', properties: {} },
        command: 'node -e "process.stdout.write(JSON.stringify({ hasSecret: Boolean(process.env.NANOGPT_API_KEY) }))"'
      })
    )

    const { loadCustomTools } = await import('../harness/tools/custom')
    const registry = new ToolRegistry()
    loadCustomTools(registry, projectDir)

    const resolved = registry.resolve('my_custom_tool')
    expect(resolved).toBeDefined()
    expect(resolved?.definition.category).toBe('custom')

    // 1. Under readOnly profile: must be blocked
    const readOnlyCtx: ToolContext = {
      directory: projectDir,
      agentId: 'a',
      runId: 'r',
      abortSignal: new AbortController().signal,
      profile: { readOnly: true }
    }
    const blockedRes = await registry.execute('my_custom_tool', {}, readOnlyCtx)
    expect(blockedRes.error).toMatch(/read-only policy/i)

    // 2. Under normal profile: executes in sanitized env
    process.env.NANOGPT_API_KEY = 'super-secret-key'
    try {
      const normalCtx: ToolContext = {
        directory: projectDir,
        agentId: 'a',
        runId: 'r',
        abortSignal: new AbortController().signal
      }
      const normalRes = await registry.execute('my_custom_tool', {}, normalCtx)
      expect(normalRes.error).toBeUndefined()
      const parsed = JSON.parse(normalRes.output)
      expect(parsed.hasSecret).toBe(false)
    } finally {
      delete process.env.NANOGPT_API_KEY
      await safeCleanDir(projectDir)
    }
  })
})
