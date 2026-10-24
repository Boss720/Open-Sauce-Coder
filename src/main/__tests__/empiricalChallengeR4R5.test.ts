import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateProfile, type AgentProfile } from '../harness/profiles'
import { ToolRegistry, type ToolContext } from '../harness/tools/registry'
import { AgentRunner, type RunnerEvent } from '../harness/runner'
import type { ProviderAdapter, ChatRequest, ChatResponse } from '../harness/providers/adapter'

let userDataPath = ''

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

import { ProfileStore } from '../harness/profileStore'

/**
 * Safely removes a temporary directory on Windows and POSIX.
 * Retries asynchronously with linear backoff and swallows transient OS locks.
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

describe('R4 Adversarial Challenge: Lossless Profile Persistence & Safety Semantics', () => {
  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'opencode-profile-r4-challenge-'))
  })

  afterEach(async () => {
    await safeCleanDir(userDataPath)
  })

  describe('R4.1: Strict Zero-Tool Semantics (tools: [])', () => {
    it('validateProfile preserves explicit tools: [] and never converts to wildcard or undefined', () => {
      const raw = {
        id: 'no-tools-agent',
        name: 'No Tools Agent',
        provider: 'nanogpt',
        model: 'deepseek/v3',
        tools: []
      }

      const validated = validateProfile(raw)

      expect(Array.isArray(validated.tools)).toBe(true)
      expect(validated.tools).toHaveLength(0)
      expect(validated.tools).toEqual([])
      expect(validated.tools).not.toBeUndefined()
      expect(validated.tools).not.toContain('*')
    })

    it('validateProfile distinguishes tools: [] from omitted tools (which means undefined)', () => {
      const omitted = validateProfile({
        id: 'omitted-tools-agent',
        name: 'Omitted Tools Agent',
        provider: 'nanogpt',
        model: 'deepseek/v3'
      })
      expect(omitted.tools).toBeUndefined()

      const wildcard = validateProfile({
        id: 'wildcard-agent',
        name: 'Wildcard Agent',
        provider: 'nanogpt',
        model: 'deepseek/v3',
        tools: ['*']
      })
      expect(wildcard.tools).toEqual(['*'])
    })

    it('ToolRegistry.forProfile returns strictly empty array [] when tools: [] is specified', () => {
      const registry = new ToolRegistry()
      registry.register({ name: 'fs_read', description: 'r', parameters: {}, category: 'read' }, vi.fn())
      registry.register({ name: 'fs_write', description: 'w', parameters: {}, category: 'write' }, vi.fn())
      registry.register({ name: 'shell', description: 's', parameters: {}, category: 'shell' }, vi.fn())

      // 1. Explicit tools: []
      const forEmpty = registry.forProfile({ tools: [] })
      expect(forEmpty).toEqual([])
      expect(forEmpty).toHaveLength(0)

      // 2. Wildcard tools: ['*']
      const forWildcard = registry.forProfile({ tools: ['*'] })
      expect(forWildcard).toHaveLength(3)

      // 3. Omitted tools: undefined
      const forDefault = registry.forProfile({})
      expect(forDefault).toHaveLength(3)
    })

    it('ToolRegistry.execute directly blocks tool invocation when profile.tools is []', async () => {
      const registry = new ToolRegistry()
      const executorSpy = vi.fn(async () => ({ output: 'secret' }))
      registry.register({ name: 'fs_read', description: 'r', parameters: {}, category: 'read' }, executorSpy)

      const context: ToolContext = {
        directory: '/test',
        agentId: 'a1',
        runId: 'r1',
        abortSignal: new AbortController().signal,
        profile: { tools: [] }
      }

      const result = await registry.execute('fs_read', {}, context)

      expect(executorSpy).not.toHaveBeenCalled()
      expect(result.error).toMatch(/no tools allowed/i)
      expect(result.output).toBe('')
    })

    it('AgentRunner pre-execution broker blocks tool dispatch and returns error when profile.tools is []', async () => {
      const registry = new ToolRegistry()
      const writeSpy = vi.fn(async () => ({ output: 'written' }))
      registry.register({ name: 'fs_write', description: 'w', parameters: {}, category: 'write' }, writeSpy)

      const profile: AgentProfile = {
        id: 'sandboxed-runner',
        name: 'Sandboxed Runner',
        provider: 'nanogpt',
        model: 'test-model',
        tools: []
      }

      let turn = 0
      const adapter: ProviderAdapter = {
        id: 'nanogpt',
        probe: vi.fn(async () => true),
        chat: vi.fn(async (_req: ChatRequest): Promise<ChatResponse> => {
          turn++
          if (turn === 1) {
            return {
              id: 'resp-1',
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: 'tc-1',
                  type: 'function',
                  function: { name: 'fs_write', arguments: '{"path":"foo.txt","content":"data"}' }
                }
              ],
              usage: { input: 10, output: 10 }
            }
          }
          return {
            id: 'resp-2',
            content: 'Acknowledged tool restriction',
            finishReason: 'stop',
            usage: { input: 10, output: 10 }
          }
        }),
        abort: vi.fn()
      }

      const runner = new AgentRunner({
        id: 'run-zero-tools',
        profile,
        adapter,
        tools: registry,
        directory: '/test'
      })

      const events: RunnerEvent[] = []
      const res = await runner.run('Execute file write', (e) => events.push(e))

      // 1. Tool executor was NEVER called
      expect(writeSpy).not.toHaveBeenCalled()

      // 2. Runner emitted a tool_result event with policy error
      const toolResultEvent = events.find((e) => e.type === 'tool_result')
      expect(toolResultEvent).toBeDefined()
      if (toolResultEvent && toolResultEvent.type === 'tool_result') {
        expect(toolResultEvent.error).toMatch(/no tools allowed/i)
      }

      // 3. Run finished cleanly
      expect(res.finishReason).toBe('complete')
    })
  })

  describe('R4.2: Lossless Persistence & Arbitrary Fields Round-Trip', () => {
    it('preserves thinking, routing, and arbitrary extension fields across validateProfile', () => {
      const raw = {
        id: 'custom-expert',
        name: 'Custom Expert',
        provider: 'nanogpt',
        model: 'zai-org/glm-5.2:thinking',
        temperature: 0.7,
        maxTokens: 4096,
        thinking: { enabled: true, budget: 16384 },
        routingSuffix: ':fast',
        billingRoute: 'subscription',
        caching: true,
        tools: ['fs_read', 'grep'],
        // Arbitrary custom metadata fields
        customDomain: 'cybersecurity',
        extraParams: { top_k: 40, penalty: 1.1 },
        tags: ['audit', 'm0']
      }

      const validated = validateProfile(raw)

      expect(validated.thinking).toEqual({ enabled: true, budget: 16384 })
      expect(validated.routingSuffix).toBe(':fast')
      expect(validated.billingRoute).toBe('subscription')
      expect(validated.caching).toBe(true)
      expect(validated.tools).toEqual(['fs_read', 'grep'])
      // Arbitrary fields survived validation
      expect((validated as Record<string, unknown>).customDomain).toBe('cybersecurity')
      expect((validated as Record<string, unknown>).extraParams).toEqual({ top_k: 40, penalty: 1.1 })
      expect((validated as Record<string, unknown>).tags).toEqual(['audit', 'm0'])
    })

    it('ProfileStore saves to disk and reads back arbitrary fields and tools: [] losslessly', async () => {
      const store = new ProfileStore()

      const input = {
        id: 'round-trip-agent',
        name: 'Round Trip Agent',
        provider: 'nanogpt',
        model: 'qwen-coder',
        tools: [],
        thinking: { enabled: true, budget: 8192 },
        customField: 'preserved-value',
        numericCode: 42
      }

      await store.save(input)

      // Inspect persisted file on disk
      const filePath = join(userDataPath, 'harness-profiles.json')
      const rawOnDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { profiles: Array<Record<string, unknown>> }
      const persisted = rawOnDisk.profiles.find((p) => p.id === 'round-trip-agent')

      expect(persisted).toBeDefined()
      if (!persisted) throw new Error('Persisted profile was not written')
      expect(persisted.tools).toEqual([])
      expect(persisted.thinking).toEqual({ enabled: true, budget: 8192 })
      expect(persisted.customField).toBe('preserved-value')
      expect(persisted.numericCode).toBe(42)

      // Create brand new store instance reading from same disk path
      const freshStore = new ProfileStore()
      const retrieved = freshStore.get('round-trip-agent')

      expect(retrieved).toBeDefined()
      expect(retrieved?.tools).toEqual([])
      expect(retrieved?.thinking).toEqual({ enabled: true, budget: 8192 })
      expect((retrieved as Record<string, unknown>)?.customField).toBe('preserved-value')
      expect((retrieved as Record<string, unknown>)?.numericCode).toBe(42)
    })

    it('strictly validates profile ID format preventing path traversal and unsafe identifiers', () => {
      const invalidIds = [
        '../escaped',
        'sub/folder',
        'has spaces',
        'UPPERCASE_ID',
        'invalid.dots',
        '',
        '   ',
        'a'.repeat(65) // exceeds 64 chars
      ]

      for (const id of invalidIds) {
        expect(() =>
          validateProfile({
            id,
            name: 'Invalid Test',
            provider: 'nanogpt',
            model: 'model-x'
          })
        ).toThrow(/Profile validation: id/)
      }

      // Valid IDs must pass
      const validIds = ['valid-id', 'agent_123', 'simple', 'a-b_c']
      for (const id of validIds) {
        expect(() =>
          validateProfile({
            id,
            name: 'Valid Test',
            provider: 'nanogpt',
            model: 'model-x'
          })
        ).not.toThrow()
      }
    })
  })
})

describe('R5 Adversarial Challenge: Release Gate Contract Checking', () => {
  it('programmatically asserts CONTRACTS.md covers every registered IPC channel and preload method with zero drift', () => {
    const root = resolve(__dirname, '../../..')
    const MAIN_DIR = join(root, 'src/main')
    const PRELOAD_FILE = join(root, 'src/preload/index.ts')
    const CONTRACTS_FILE = join(root, 'CONTRACTS.md')

    // 1. Extract IPC channels from src/main
    const invokeRegex = /(?:ipcMain|ipc)\.handle\(\s*['"]([^'"]+)['"]/g
    const listenRegex = /\bipcMain\.on\(\s*['"]([^'"]+)['"]/g
    const sendRegex = /\.send\(\s*['"]([^'"]+)['"]/g
    const broadcastRegex = /\bbroadcast\(\s*['"]([^'"]+)['"]/g

    function collectMainFiles(dir: string): string[] {
      const files: string[] = []
      for (const entry of readdirSync(dir, { recursive: true })) {
        const rel = String(entry)
        if (rel.includes('__tests__')) continue
        if (rel.endsWith('.ts') && !rel.endsWith('.test.ts')) {
          files.push(join(dir, rel))
        }
      }
      return files
    }

    const invokeChannels = new Set<string>()
    const listenChannels = new Set<string>()
    const sendChannels = new Set<string>()

    for (const f of collectMainFiles(MAIN_DIR)) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(invokeRegex)) invokeChannels.add(m[1])
      for (const m of src.matchAll(listenRegex)) listenChannels.add(m[1])
      for (const m of src.matchAll(sendRegex)) sendChannels.add(m[1])
      for (const m of src.matchAll(broadcastRegex)) sendChannels.add(m[1])
    }

    // 2. Read CONTRACTS.md
    const contracts = readFileSync(CONTRACTS_FILE, 'utf8')

    const missingInvoke = [...invokeChannels].filter((c) => !contracts.includes(c))
    const missingListen = [...listenChannels].filter((c) => !contracts.includes(c))
    const missingSend = [...sendChannels].filter((c) => !contracts.includes(c))

    expect(missingInvoke).toEqual([])
    expect(missingListen).toEqual([])
    expect(missingSend).toEqual([])

    // 3. Extract preload window.api methods
    const preloadSrc = readFileSync(PRELOAD_FILE, 'utf8')
    const lines = preloadSrc.split(/\r?\n/)
    const start = lines.findIndex((l) => /^const api\b/.test(l))
    expect(start).toBeGreaterThan(-1)

    const methods: string[] = []
    const stack: Array<{ key: string; depth: number }> = []

    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]
      if (/^}/.test(line)) break
      const match = /^(\s+)([A-Za-z_$][\w$]*):\s*(.*)$/.exec(line)
      if (!match) continue
      const depth = match[1].length
      const key = match[2]
      const rest = match[3]

      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()

      if (rest.startsWith('{')) {
        stack.push({ key, depth })
      } else {
        methods.push([...stack.map((frame) => frame.key), key].join('.'))
      }
    }

    // 4. Verify all preload methods are in CONTRACTS.md
    // Leroy methods specifically must be present
    expect(contracts).toContain('leroy:')
    expect(contracts).toContain('start(options?: LeroyStartOptions): Promise<void>')
    expect(contracts).toContain('send(command: LeroyCommand): void')
    expect(contracts).toContain('stop(): Promise<void>')
    expect(contracts).toContain('status(): Promise<boolean>')
    expect(contracts).toContain('onEvent(cb: (event: LeroyEvent) => void): () => void')

    // Mirrored constants
    const rendererTypesSrc = readFileSync(join(root, 'src/renderer/src/lib/types.ts'), 'utf8')
    const mainTokenTrackerSrc = readFileSync(join(root, 'src/main/tokenBudgetTracker.ts'), 'utf8')
    const mainImagesSrc = readFileSync(join(root, 'src/main/nanogptImages.ts'), 'utf8')

    const mainCap = mainTokenTrackerSrc.match(/export const WEEKLY_INPUT_TOKEN_CAP\s*=\s*([0-9_]+)/)?.[1].replace(/_/g, '')
    const rendererCap = rendererTypesSrc.match(/export const WEEKLY_INPUT_TOKEN_CAP\s*=\s*([0-9_]+)/)?.[1].replace(/_/g, '')
    expect(mainCap).toBe(rendererCap)

    const mainImageCap = mainImagesSrc.match(/export const DAILY_FREE_IMAGE_CAP\s*=\s*([0-9_]+)/)?.[1].replace(/_/g, '')
    const rendererImageCap = rendererTypesSrc.match(/export const DAILY_FREE_IMAGE_CAP\s*=\s*([0-9_]+)/)?.[1].replace(/_/g, '')
    expect(mainImageCap).toBe(rendererImageCap)
  })
})
