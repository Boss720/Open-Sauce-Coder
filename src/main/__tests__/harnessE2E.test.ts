/**
 * End-to-End (E2E) Test Suite for the Multi-Provider Agentic Harness.
 *
 * Verifies public harness interfaces across 4 tiers:
 * - Tier 1: Feature Coverage (Providers, Streaming Deltas, Runner Loop, Resilient Tools)
 * - Tier 2: Boundary & Corner Cases (Empty inputs, binary files, 30k char truncation, containment)
 * - Tier 3: Pairwise Combinations (Streaming + tool execution, abort signals, policy enforcement)
 * - Tier 4: Real-world Workloads (Read-patch-verify, directory scaffolding, multi-turn pipelines)
 *
 * Requirements authoritative source: ORIGINAL_REQUEST.md (## 2026-10-05T17:42:14Z) & PROJECT.md
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentRunner, type RunnerEvent } from '../harness/runner'
import { ToolRegistry, type ToolContext } from '../harness/tools/registry'
import { registerBuiltins } from '../harness/tools/builtins'
import { ProviderRegistry } from '../harness/providers/registry'
import { AnthropicAdapter } from '../harness/providers/anthropic'
import { OpenAiAdapter } from '../harness/providers/openai'
import { OpenAiCompatibleAdapter } from '../harness/providers/openaiCompatible'
import { NanoGptAdapter } from '../harness/providers/nanogpt'
import { GeminiAdapter } from '../harness/providers/gemini'
import type { AgentProfile } from '../harness/profiles'
import type {
  ChatDelta,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ToolCall
} from '../harness/providers/adapter'

// Mock credential storage so provider adapters resolve keys deterministically in tests
vi.mock('../keys', () => ({
  loadByokEnv: vi.fn(() => ({
    ANTHROPIC_API_KEY: 'sk-ant-test-key-mock-1234',
    OPENAI_API_KEY: 'sk-openai-test-key-mock-5678',
    GEMINI_API_KEY: 'test-gemini-key-mock-9012',
    NANOGPT_API_KEY: 'test-nanogpt-key-mock-3456',
    GROQ_API_KEY: 'gsk-test-groq-key-mock-7890',
    MISTRAL_API_KEY: 'test-mistral-key-mock-2345',
    DEEPSEEK_API_KEY: 'test-deepseek-key-mock-6789'
  }))
}))

// ── Test Helpers ──

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test-agent',
    name: 'E2E Test Agent',
    provider: 'stub',
    model: 'test-model-v1',
    tools: ['*'],
    ...overrides
  }
}

function makeResponse(overrides: Partial<ChatResponse>): ChatResponse {
  return {
    id: 'resp-' + Math.random().toString(36).slice(2, 8),
    content: '',
    finishReason: 'stop',
    usage: { input: 15, output: 8 },
    ...overrides
  }
}

function makeToolCall(name: string, args: Record<string, unknown> = {}, id?: string): ToolCall {
  return {
    id: id ?? `call-${name}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'function',
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  }
}

type TurnDefinition = {
  response: ChatResponse
  deltas?: ChatDelta[]
}

function makeMockAdapter(turns: TurnDefinition[]): ProviderAdapter & {
  requests: ChatRequest[]
  aborts: string[]
} {
  let turnIdx = 0
  const requests: ChatRequest[] = []
  const aborts: string[] = []

  return {
    id: 'mock-adapter',
    requests,
    aborts,
    async chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResponse> {
      requests.push(request)
      const turn = turns[Math.min(turnIdx++, turns.length - 1)]
      if (turn.deltas && onDelta) {
        for (const delta of turn.deltas) {
          onDelta(delta)
        }
      }
      return turn.response
    },
    abort(requestId: string): void {
      aborts.push(requestId)
    },
    async probe(): Promise<boolean> {
      return true
    }
  }
}

function contextFor(directory: string, signal?: AbortSignal, profileOverride?: Partial<AgentProfile>): ToolContext {
  return {
    directory,
    agentId: 'test-agent',
    runId: 'run-e2e',
    abortSignal: signal ?? new AbortController().signal,
    profile: profileOverride
  }
}

function registryWithBuiltins(): ToolRegistry {
  const reg = new ToolRegistry()
  registerBuiltins(reg)
  return reg
}

// ── Test Suites ──

describe('Harness E2E: Tier 1 — Feature Coverage (Primary Behavior)', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'harness-e2e-tier1-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  // Feature 1: Real-time Streaming Deltas
  describe('Feature 1: Real-time Streaming Deltas', () => {
    it('emits live thinking deltas from provider during generation', async () => {
      const adapter = makeMockAdapter([
        {
          deltas: [
            { thinkingContent: 'Analyzing' },
            { thinkingContent: ' problem' },
            { thinkingContent: ' structure...' }
          ],
          response: makeResponse({
            content: 'Solution ready.',
            thinkingContent: 'Analyzing problem structure...'
          })
        }
      ])
      const runner = new AgentRunner({
        id: 'run-t1-1',
        profile: makeProfile(),
        adapter,
        tools: new ToolRegistry(),
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      const result = await runner.run('solve problem', (e) => events.push(e))

      expect(result.finishReason).toBe('complete')
      const thinkingEvents = events.filter((e) => e.type === 'thinking')
      expect(thinkingEvents.length).toBe(3)
      expect(thinkingEvents.map((e) => (e as { content: string }).content).join('')).toBe(
        'Analyzing problem structure...'
      )
    })

    it('emits live text deltas and prevents duplicate whole-content emission', async () => {
      const adapter = makeMockAdapter([
        {
          deltas: [
            { content: 'Hello ' },
            { content: 'from ' },
            { content: 'stream.' }
          ],
          response: makeResponse({ content: 'Hello from stream.' })
        }
      ])
      const runner = new AgentRunner({
        id: 'run-t1-2',
        profile: makeProfile(),
        adapter,
        tools: new ToolRegistry(),
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      const result = await runner.run('greet', (e) => events.push(e))

      expect(result.finishReason).toBe('complete')
      const textEvents = events.filter((e) => e.type === 'text')
      expect(textEvents.length).toBe(3)
      expect(textEvents.map((e) => (e as { delta: string }).delta).join('')).toBe('Hello from stream.')
    })

    it('falls back to whole response content emission when onDelta did not emit text', async () => {
      const adapter = makeMockAdapter([
        {
          response: makeResponse({ content: 'Non-streamed fallback answer.' })
        }
      ])
      const runner = new AgentRunner({
        id: 'run-t1-3',
        profile: makeProfile(),
        adapter,
        tools: new ToolRegistry(),
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      await runner.run('fallback', (e) => events.push(e))

      const textEvents = events.filter((e) => e.type === 'text')
      expect(textEvents.length).toBe(1)
      expect((textEvents[0] as { delta: string }).delta).toBe('Non-streamed fallback answer.')
    })

    it('falls back to whole response thinkingContent when onDelta did not emit thinking', async () => {
      const adapter = makeMockAdapter([
        {
          response: makeResponse({
            content: 'Done',
            thinkingContent: 'Internal reasoning without stream'
          })
        }
      ])
      const runner = new AgentRunner({
        id: 'run-t1-4',
        profile: makeProfile(),
        adapter,
        tools: new ToolRegistry(),
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      await runner.run('think test', (e) => events.push(e))

      const thinkingEvents = events.filter((e) => e.type === 'thinking')
      expect(thinkingEvents.length).toBe(1)
      expect((thinkingEvents[0] as { content: string }).content).toBe('Internal reasoning without stream')
    })

    it('maintains ordered event lifecycle (thinking -> text -> tool_call -> done)', async () => {
      const tools = new ToolRegistry()
      tools.register(
        { name: 'mock_op', description: 'op', parameters: {}, category: 'read' },
        async () => ({ output: 'op completed' })
      )

      const adapter = makeMockAdapter([
        {
          deltas: [
            { thinkingContent: 'pondering' },
            { content: 'calling op' }
          ],
          response: makeResponse({
            finishReason: 'tool_calls',
            toolCalls: [makeToolCall('mock_op')]
          })
        },
        {
          response: makeResponse({ content: 'finished task' })
        }
      ])

      const runner = new AgentRunner({
        id: 'run-t1-5',
        profile: makeProfile(),
        adapter,
        tools,
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      await runner.run('run workflow', (e) => events.push(e))

      const types = events.map((e) => e.type)
      expect(types).toEqual(['thinking', 'text', 'tool_call', 'tool_result', 'text', 'done'])
    })
  })

  // Feature 6: 12+ Provider Registry
  describe('Feature 6: 12+ Provider Registry', () => {
    it('supports all 12 specified providers', () => {
      const registry = new ProviderRegistry()
      const expectedProviders = [
        'nanogpt', 'google', 'anthropic', 'openai', 'openrouter',
        'groq', 'mistral', 'deepseek', 'moonshot', 'xai', 'cerebras', 'custom'
      ]
      for (const p of expectedProviders) {
        expect(registry.isSupported(p), `Provider ${p} must be supported`).toBe(true)
      }
      expect(registry.list()).toEqual(expect.arrayContaining(expectedProviders))
    })

    it('resolves dedicated adapter instances for primary cloud providers', () => {
      const registry = new ProviderRegistry()
      expect(registry.resolve('nanogpt')).toBeInstanceOf(NanoGptAdapter)
      expect(registry.resolve('google')).toBeInstanceOf(GeminiAdapter)
      expect(registry.resolve('anthropic')).toBeInstanceOf(AnthropicAdapter)
      expect(registry.resolve('openai')).toBeInstanceOf(OpenAiAdapter)
    })

    it('resolves OpenAI-compatible and custom endpoints to OpenAiCompatibleAdapter', () => {
      const registry = new ProviderRegistry()
      for (const p of ['groq', 'mistral', 'openrouter', 'deepseek', 'moonshot', 'xai', 'cerebras', 'custom']) {
        const adapter = registry.resolve(p)
        expect(adapter).toBeInstanceOf(OpenAiCompatibleAdapter)
        expect(adapter.id).toBe(p)
      }
    })

    it('throws descriptive error on unknown provider and supports registry reset', () => {
      const registry = new ProviderRegistry()
      expect(() => registry.resolve('unsupported-llm')).toThrow(/Unsupported harness provider/)

      const initial = registry.resolve('openai')
      registry.reset()
      const afterReset = registry.resolve('openai')
      expect(afterReset).toBeInstanceOf(OpenAiAdapter)
      expect(afterReset).not.toBe(initial)
    })
  })

  // Feature 7 & 11: Full Turn Loop Ceiling & Budget Hard-Stops
  describe('Feature 7 & 11: Turn Loop Ceiling & Budget Hard-Stops', () => {
    it('executes up to custom maxTurns ceiling and stops with max_turns', async () => {
      const tools = new ToolRegistry()
      tools.register(
        { name: 'step_tool', description: 'step', parameters: {}, category: 'read' },
        async () => ({ output: 'step done' })
      )

      // Always return tool call to test ceiling
      const adapter = makeMockAdapter([
        {
          response: makeResponse({
            finishReason: 'tool_calls',
            toolCalls: [makeToolCall('step_tool')]
          })
        }
      ])

      const runner = new AgentRunner({
        id: 'run-ceiling',
        profile: makeProfile({ maxTurns: 5 }),
        adapter,
        tools,
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      const result = await runner.run('keep going', (e) => events.push(e))

      expect(result.finishReason).toBe('max_turns')
      expect(result.turns).toBe(5)
      expect(adapter.requests.length).toBe(5)
      expect(events[events.length - 1]).toEqual({ type: 'done', result })
    })

    it('stops execution immediately when tokenBudget is exceeded pre-turn', async () => {
      // First turn uses 50 tokens, limit is 40
      const adapter = makeMockAdapter([
        {
          response: makeResponse({
            usage: { input: 50, output: 10 },
            finishReason: 'tool_calls',
            toolCalls: [makeToolCall('noop')]
          })
        }
      ])
      const tools = new ToolRegistry()
      tools.register(
        { name: 'noop', description: 'noop', parameters: {}, category: 'read' },
        async () => ({ output: 'ok' })
      )

      const runner = new AgentRunner({
        id: 'run-budget',
        profile: makeProfile({ tokenBudget: 40 }),
        adapter,
        tools,
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      const result = await runner.run('budget task', (e) => events.push(e))

      expect(result.finishReason).toBe('budget_exceeded')
      expect(events.some((e) => e.type === 'budget_warning')).toBe(true)
      const warning = events.find((e) => e.type === 'budget_warning') as {
        field: string
        used: number
        limit: number
      }
      expect(warning.field).toBe('tokenBudget')
      expect(warning.used).toBe(50)
      expect(warning.limit).toBe(40)
    })
  })

  // Feature 8: Context Truncation Guard (30,000 characters)
  describe('Feature 8: Context Truncation Notice with Total Count', () => {
    it('truncates tool output exceeding 30,000 characters when inserted into message history', async () => {
      const hugeOutput = 'A'.repeat(35_000)
      const tools = new ToolRegistry()
      tools.register(
        { name: 'big_reader', description: 'read big', parameters: {}, category: 'read' },
        async () => ({ output: hugeOutput })
      )

      const adapter = makeMockAdapter([
        {
          response: makeResponse({
            finishReason: 'tool_calls',
            toolCalls: [makeToolCall('big_reader')]
          })
        },
        {
          response: makeResponse({ content: 'Acknowledged truncated output.' })
        }
      ])

      const runner = new AgentRunner({
        id: 'run-trunc',
        profile: makeProfile(),
        adapter,
        tools,
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      await runner.run('read big data', (e) => events.push(e))

      // Verify the second request's tool message was truncated
      const secondRequest = adapter.requests[1]
      const toolMsg = secondRequest.messages.find((m) => m.role === 'tool')
      expect(toolMsg).toBeDefined()
      const content = String(toolMsg?.content)
      expect(content.length).toBeLessThan(35_000)
      expect(content).toContain('[Output truncated: showing first 30,000 of 35,000 characters...]')
      expect(content.slice(0, 30_000)).toBe('A'.repeat(30_000))

      // The live event sent to the UI retains initial preview (up to 2000 chars)
      const toolResultEvent = events.find((e) => e.type === 'tool_result') as {
        output: string
      }
      expect(toolResultEvent.output.length).toBe(2000)
    })
  })

  // Feature 9: Rolling Loop Detection & Guidance
  describe('Feature 9: Rolling Loop Detection & Guidance', () => {
    it('adds system guidance on 3rd failure and intercepts on 4th consecutive identical failure', async () => {
      const failingTool = vi.fn(async () => ({ output: '', error: 'Database locked' }))
      const tools = new ToolRegistry()
      tools.register(
        { name: 'db_query', description: 'query', parameters: {}, category: 'read' },
        failingTool
      )

      const identicalCall = makeToolCall('db_query', { table: 'users' })
      const adapter = makeMockAdapter([
        { response: makeResponse({ finishReason: 'tool_calls', toolCalls: [identicalCall] }) },
        { response: makeResponse({ finishReason: 'tool_calls', toolCalls: [identicalCall] }) },
        { response: makeResponse({ finishReason: 'tool_calls', toolCalls: [identicalCall] }) },
        { response: makeResponse({ finishReason: 'tool_calls', toolCalls: [identicalCall] }) },
        { response: makeResponse({ content: 'Gave up on db.' }) }
      ])

      const runner = new AgentRunner({
        id: 'run-loop',
        profile: makeProfile({ maxTurns: 10 }),
        adapter,
        tools,
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      await runner.run('query users', (e) => events.push(e))

      // The executor was called 3 times; the 4th identical call was short-circuited before execution!
      expect(failingTool).toHaveBeenCalledTimes(3)

      const toolResults = events.filter((e) => e.type === 'tool_result') as Array<{
        name: string
        error?: string
      }>
      expect(toolResults.length).toBe(4)

      // 3rd call includes guidance in error
      expect(toolResults[2].error).toContain('System Warning: You have called "db_query" with identical arguments 3 times')
      // 4th call was intercepted with loop warning
      expect(toolResults[3].error).toContain('System Warning: You have called "db_query" with identical arguments 3 times')
    })
  })

  // Feature 10: Malformed JSON Tool Argument Recovery
  describe('Feature 10: Malformed JSON Tool Argument Recovery', () => {
    it('handles syntax errors in tool arguments without crashing and reports guidance to model', async () => {
      const adapter = makeMockAdapter([
        {
          response: makeResponse({
            finishReason: 'tool_calls',
            toolCalls: [{
              id: 'call-malformed',
              type: 'function',
              function: {
                name: 'fs_read',
                arguments: '{ path: "unterminated' // syntax error
              }
            }]
          })
        },
        {
          response: makeResponse({ content: 'Received format error and recovered.' })
        }
      ])

      const tools = registryWithBuiltins()
      const runner = new AgentRunner({
        id: 'run-malformed',
        profile: makeProfile(),
        adapter,
        tools,
        directory: projectDir
      })

      const events: RunnerEvent[] = []
      const result = await runner.run('read file', (e) => events.push(e))

      expect(result.finishReason).toBe('complete')
      const toolResult = events.find((e) => e.type === 'tool_result') as {
        name: string
        error?: string
      }
      expect(toolResult).toBeDefined()
      expect(toolResult.error).toContain('Tool arguments were not valid JSON')

      // Second turn sees the error in messages
      const secondRequest = adapter.requests[1]
      const toolMsg = secondRequest.messages.find((m) => m.role === 'tool')
      expect(toolMsg?.content).toContain('Tool arguments were not valid JSON')
    })
  })

  // Feature 12: Recursive Directory Creation in fs_write
  describe('Feature 12: Recursive Directory Creation in fs_write', () => {
    it('auto-creates nested intermediate directories idempotently', async () => {
      const tools = registryWithBuiltins()
      const nestedFile = 'nested/level1/level2/deep.txt'
      const result = await tools.execute(
        'fs_write',
        { path: nestedFile, content: 'Deep file content' },
        contextFor(projectDir)
      )

      expect(result.error).toBeUndefined()
      expect(result.output).toContain('Wrote 17 bytes')
      const written = readFileSync(join(projectDir, nestedFile), 'utf8')
      expect(written).toBe('Deep file content')

      // Second write to another file in the same directory succeeds
      const result2 = await tools.execute(
        'fs_write',
        { path: 'nested/level1/level2/deep2.txt', content: 'Second file' },
        contextFor(projectDir)
      )
      expect(result2.error).toBeUndefined()
      expect(readFileSync(join(projectDir, 'nested/level1/level2/deep2.txt'), 'utf8')).toBe('Second file')
    })
  })

  // Feature 13: Zero-Dependency Grep Fallback
  describe('Feature 13: Zero-Dependency Grep Fallback', () => {
    it('finds patterns recursively across project files', async () => {
      const tools = registryWithBuiltins()
      writeFileSync(join(projectDir, 'handler.ts'), 'export function handleAuthToken() { return 1 }\n')
      writeFileSync(join(projectDir, 'other.ts'), 'export function handleOther() { return 2 }\n')

      const result = await tools.execute(
        'grep',
        { pattern: 'handleAuthToken' },
        contextFor(projectDir)
      )

      expect(result.error).toBeUndefined()
      expect(result.output).toContain('handler.ts:1:export function handleAuthToken')
      expect(result.output).not.toContain('other.ts')
    })
  })

  // Feature 15: Targeted Replacement Tool fs_patch
  describe('Feature 15: Targeted Replacement Tool fs_patch', () => {
    it('replaces exact target block in file and validates uniqueness', async () => {
      const tools = registryWithBuiltins()
      const file = 'module.ts'
      writeFileSync(join(projectDir, file), 'export const VERSION = "1.0.0"\nexport const ENV = "dev"\n')

      const patchResult = await tools.execute(
        'fs_patch',
        { path: file, target: 'VERSION = "1.0.0"', replacement: 'VERSION = "2.0.0"' },
        contextFor(projectDir)
      )

      expect(patchResult.error).toBeUndefined()
      expect(patchResult.output).toContain('Successfully patched')
      expect(readFileSync(join(projectDir, file), 'utf8')).toBe(
        'export const VERSION = "2.0.0"\nexport const ENV = "dev"\n'
      )
    })
  })

  // Feature 16: Binary File Sniff in fs_read
  describe('Feature 16: Binary File Sniff in fs_read', () => {
    it('detects null bytes in first 8 KB and returns binary notice', async () => {
      const tools = registryWithBuiltins()
      const binFile = 'test.bin'
      const binData = Buffer.from([0x01, 0x02, 0x00, 0x04, 0x05]) // contains \0
      writeFileSync(join(projectDir, binFile), binData)

      const result = await tools.execute('fs_read', { path: binFile }, contextFor(projectDir))
      expect(result.error).toBeUndefined()
      expect(result.output).toBe('[Binary file, size: 5 bytes]')
    })
  })
})

describe('Harness E2E: Tier 2 — Boundary & Corner Cases', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'harness-e2e-tier2-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('rejects path escape attempts across all filesystem tools', async () => {
    const tools = registryWithBuiltins()
    const ctx = contextFor(projectDir)
    const escapes = ['../escape.txt', '..\\escape.txt', join(tmpdir(), 'absolute-escape.txt')]

    for (const esc of escapes) {
      const rRead = await tools.execute('fs_read', { path: esc }, ctx)
      expect(rRead.error).toMatch(/project directory|inside/i)

      const rWrite = await tools.execute('fs_write', { path: esc, content: 'x' }, ctx)
      expect(rWrite.error).toMatch(/project directory|inside/i)

      const rPatch = await tools.execute('fs_patch', { path: esc, target: 'a', replacement: 'b' }, ctx)
      expect(rPatch.error).toMatch(/project directory|inside/i)

      const rList = await tools.execute('fs_list', { path: esc }, ctx)
      expect(rList.error).toMatch(/project directory|inside/i)
    }
  })

  it('handles empty inputs safely across built-in tools', async () => {
    const tools = registryWithBuiltins()
    const ctx = contextFor(projectDir)

    // fs_list with empty string defaults to project root "."
    writeFileSync(join(projectDir, 'sample.txt'), 'sample')
    const listResult = await tools.execute('fs_list', { path: '' }, ctx)
    expect(listResult.error).toBeUndefined()
    expect(listResult.output).toContain('sample.txt')

    // fs_write with empty content creates 0-byte file
    const writeResult = await tools.execute('fs_write', { path: 'empty.txt', content: '' }, ctx)
    expect(writeResult.error).toBeUndefined()
    expect(readFileSync(join(projectDir, 'empty.txt'), 'utf8')).toBe('')

    // fs_patch with empty target returns validation error
    const patchResult = await tools.execute(
      'fs_patch',
      { path: 'empty.txt', target: '', replacement: 'replacement' },
      ctx
    )
    expect(patchResult.error).toContain('Target string must not be empty')
  })

  it('detects binary files at offset boundary (offset 0 and offset 8191)', async () => {
    const tools = registryWithBuiltins()
    const ctx = contextFor(projectDir)

    // Null byte at offset 0
    writeFileSync(join(projectDir, 'offset0.bin'), Buffer.from([0x00, 0x61, 0x62]))
    const res0 = await tools.execute('fs_read', { path: 'offset0.bin' }, ctx)
    expect(res0.output).toContain('[Binary file')

    // Null byte at offset 8191
    const buffer8k = Buffer.alloc(8192, 0x61) // all 'a'
    buffer8k[8191] = 0x00 // null byte at end of 8KB sniff window
    writeFileSync(join(projectDir, 'offset8191.bin'), buffer8k)
    const res8k = await tools.execute('fs_read', { path: 'offset8191.bin' }, ctx)
    expect(res8k.output).toContain('[Binary file')
  })

  it('preserves UTF-8 multi-byte characters and emoji without corruption', async () => {
    const tools = registryWithBuiltins()
    const ctx = contextFor(projectDir)
    const unicodeText = '🚀 OpenCode Desktop — 日本語とEspañol: €100 — 🌟'
    await tools.execute('fs_write', { path: 'unicode.txt', content: unicodeText }, ctx)

    const readResult = await tools.execute('fs_read', { path: 'unicode.txt' }, ctx)
    expect(readResult.output).toBe(unicodeText)

    await tools.execute(
      'fs_patch',
      { path: 'unicode.txt', target: '€100', replacement: '€250' },
      ctx
    )
    const patchedRead = await tools.execute('fs_read', { path: 'unicode.txt' }, ctx)
    expect(patchedRead.output).toContain('€250')
  })

  it('rejects writes exceeding MAX_WRITE_BYTES (2 MiB)', async () => {
    const tools = registryWithBuiltins()
    const ctx = contextFor(projectDir)
    const oversizedContent = 'a'.repeat(2 * 1024 * 1024 + 10)

    const result = await tools.execute('fs_write', { path: 'huge.txt', content: oversizedContent }, ctx)
    expect(result.error).toContain('Refusing to write')
  })

  it('enforces target uniqueness in fs_patch when duplicate occurrences exist', async () => {
    const tools = registryWithBuiltins()
    const ctx = contextFor(projectDir)
    writeFileSync(join(projectDir, 'dups.txt'), 'target_token\nsome code\ntarget_token\n')

    const result = await tools.execute(
      'fs_patch',
      { path: 'dups.txt', target: 'target_token', replacement: 'new_token' },
      ctx
    )
    expect(result.error).toContain('appears 2 times')
  })

  it('aborts runner immediately when pre-aborted signal is passed', async () => {
    const adapter = makeMockAdapter([{ response: makeResponse({ content: 'Never run' }) }])
    const runner = new AgentRunner({
      id: 'run-preabort',
      profile: makeProfile(),
      adapter,
      tools: new ToolRegistry(),
      directory: projectDir
    })

    runner.abort()
    const events: RunnerEvent[] = []
    const result = await runner.run('task', (e) => events.push(e))

    expect(result.finishReason).toBe('aborted')
    expect(adapter.requests.length).toBe(0)
  })
})

describe('Harness E2E: Tier 3 — Pairwise Combinations & Cross-Feature Interactions', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'harness-e2e-tier3-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('combines streaming deltas with multi-turn tool execution', async () => {
    const tools = registryWithBuiltins()
    const adapter = makeMockAdapter([
      // Turn 1: Model streams thoughts, then issues fs_write tool call
      {
        deltas: [
          { thinkingContent: 'I will create index.js' },
          { content: 'Creating index.js...' }
        ],
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            makeToolCall('fs_write', { path: 'index.js', content: 'console.log("hello");\n' })
          ]
        })
      },
      // Turn 2: Model receives tool result, streams final answer
      {
        deltas: [
          { content: 'Successfully created ' },
          { content: 'the index.js file.' }
        ],
        response: makeResponse({ content: 'Successfully created the index.js file.' })
      }
    ])

    const runner = new AgentRunner({
      id: 'run-t3-stream-tool',
      profile: makeProfile(),
      adapter,
      tools,
      directory: projectDir
    })

    const events: RunnerEvent[] = []
    const result = await runner.run('create index.js', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(result.toolCallCount).toBe(1)
    expect(readFileSync(join(projectDir, 'index.js'), 'utf8')).toBe('console.log("hello");\n')

    // Verify event ordering: thinking -> text -> tool_call -> tool_result -> text -> done
    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toEqual([
      'thinking',
      'text',
      'tool_call',
      'tool_result',
      'text',
      'text',
      'done'
    ])
  })

  it('enforces read-only profile policy rejecting mutating tools while allowing read tools', async () => {
    const tools = registryWithBuiltins()
    writeFileSync(join(projectDir, 'data.txt'), 'secret data')

    const adapter = makeMockAdapter([
      // Turn 1: read tool (allowed)
      {
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [makeToolCall('fs_read', { path: 'data.txt' })]
        })
      },
      // Turn 2: write tool (rejected by readOnly profile)
      {
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [makeToolCall('fs_write', { path: 'data.txt', content: 'corrupted' })]
        })
      },
      // Turn 3: completed
      {
        response: makeResponse({ content: 'Stopped after violation.' })
      }
    ])

    const runner = new AgentRunner({
      id: 'run-t3-readonly',
      profile: makeProfile({ readOnly: true }),
      adapter,
      tools,
      directory: projectDir
    })

    const events: RunnerEvent[] = []
    const result = await runner.run('read then write', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    // File content remains unmutated
    expect(readFileSync(join(projectDir, 'data.txt'), 'utf8')).toBe('secret data')

    // Check tool results
    const results = events.filter((e) => e.type === 'tool_result') as Array<{
      name: string
      output: string
      error?: string
    }>
    expect(results[0].name).toBe('fs_read')
    expect(results[0].output).toBe('secret data')

    expect(results[1].name).toBe('fs_write')
    expect(results[1].error).toMatch(/read-only policy/i)
  })

  it('enforces toolDenyList restricting specific tools without affecting allowed ones', async () => {
    const tools = registryWithBuiltins()
    const adapter = makeMockAdapter([
      {
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [makeToolCall('shell', { command: 'echo unsafe' })]
        })
      },
      {
        response: makeResponse({ content: 'Shell was denied as expected.' })
      }
    ])

    const runner = new AgentRunner({
      id: 'run-t3-denylist',
      profile: makeProfile({ toolDenyList: ['shell'] }),
      adapter,
      tools,
      directory: projectDir
    })

    const events: RunnerEvent[] = []
    await runner.run('execute shell', (e) => events.push(e))

    const shellResult = events.find((e) => e.type === 'tool_result') as {
      name: string
      error?: string
    }
    expect(shellResult.name).toBe('shell')
    expect(shellResult.error).toMatch(/denied|policy/i)
  })

  it('resets consecutive failure loop tracker after a successful tool call', async () => {
    const tools = new ToolRegistry()
    let flakyCalls = 0
    tools.register(
      { name: 'flaky_service', description: 'flaky', parameters: {}, category: 'read' },
      async () => {
        flakyCalls++
        if (flakyCalls <= 2) return { output: '', error: 'Service Unavailable' }
        return { output: 'Service Recovered' }
      }
    )

    const callDef = makeToolCall('flaky_service')
    const adapter = makeMockAdapter([
      { response: makeResponse({ finishReason: 'tool_calls', toolCalls: [callDef] }) }, // Failure 1
      { response: makeResponse({ finishReason: 'tool_calls', toolCalls: [callDef] }) }, // Failure 2
      { response: makeResponse({ finishReason: 'tool_calls', toolCalls: [callDef] }) }, // Success (resets counter)
      { response: makeResponse({ content: 'All recovered.' }) }
    ])

    const runner = new AgentRunner({
      id: 'run-t3-recovery',
      profile: makeProfile(),
      adapter,
      tools,
      directory: projectDir
    })

    const events: RunnerEvent[] = []
    const result = await runner.run('retry service', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(flakyCalls).toBe(3)
    const toolResults = events.filter((e) => e.type === 'tool_result')
    const lastResult = toolResults[toolResults.length - 1] as {
      output: string
      error?: string
    }
    expect(lastResult.output).toBe('Service Recovered')
    expect(lastResult.error).toBeUndefined()
  })

  it('aborts mid-run and propagates abort signal to adapter correlation id', async () => {
    const tools = registryWithBuiltins()
    const adapter = makeMockAdapter([
      {
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [makeToolCall('fs_list', { path: '.' })]
        })
      },
      {
        response: makeResponse({ content: 'Never reached' })
      }
    ])

    const runner = new AgentRunner({
      id: 'run-t3-abort-prop',
      profile: makeProfile(),
      adapter,
      tools,
      directory: projectDir
    })

    const events: RunnerEvent[] = []
    const runPromise = runner.run('list files', (e) => {
      events.push(e)
      if (e.type === 'tool_call') {
        runner.abort()
      }
    })

    const result = await runPromise
    expect(result.finishReason).toBe('aborted')
    expect(adapter.aborts).toContain('run-t3-abort-prop')
  })
})

describe('Harness E2E: Tier 4 — Real-world Workload Scenarios', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'harness-e2e-tier4-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('executes full Read-Patch-Verify multi-turn engineering workflow', async () => {
    const tools = registryWithBuiltins()

    // 1. Setup initial codebase
    const sourceFile = 'server.ts'
    const initialCode = [
      'import express from "express";',
      'const app = express();',
      'const PORT = 3000;',
      'app.listen(PORT, () => console.log("running"));'
    ].join('\n')
    writeFileSync(join(projectDir, sourceFile), initialCode)

    // 2. Simulated LLM dialog executing Read -> Patch -> Verify -> Conclude
    const adapter = makeMockAdapter([
      // Turn 1: Inspect server.ts
      {
        deltas: [{ content: 'Reading server.ts to locate port configuration...' }],
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [makeToolCall('fs_read', { path: sourceFile })]
        })
      },
      // Turn 2: Patch PORT to 4599
      {
        deltas: [{ content: 'Found PORT = 3000. Applying patch to 4599...' }],
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            makeToolCall('fs_patch', {
              path: sourceFile,
              target: 'const PORT = 3000;',
              replacement: 'const PORT = 4599;'
            })
          ]
        })
      },
      // Turn 3: Grep to verify change
      {
        deltas: [{ content: 'Verifying updated port with grep...' }],
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            makeToolCall('grep', { pattern: 'PORT = 4599' })
          ]
        })
      },
      // Turn 4: Final confirmation
      {
        deltas: [{ content: 'Port successfully updated to 4599 and verified.' }],
        response: makeResponse({
          content: 'Port successfully updated to 4599 and verified.'
        })
      }
    ])

    const runner = new AgentRunner({
      id: 'run-workload-patch',
      profile: makeProfile(),
      adapter,
      tools,
      directory: projectDir
    })

    const events: RunnerEvent[] = []
    const result = await runner.run('update server port to 4599', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(result.toolCallCount).toBe(3)
    expect(result.turns).toBe(4)

    // Verify physical file was accurately modified
    const modifiedCode = readFileSync(join(projectDir, sourceFile), 'utf8')
    expect(modifiedCode).toContain('const PORT = 4599;')
    expect(modifiedCode).not.toContain('const PORT = 3000;')

    // Verify event progression
    const toolCallEvents = events.filter((e) => e.type === 'tool_call') as Array<{
      name: string
    }>
    expect(toolCallEvents.map((t) => t.name)).toEqual(['fs_read', 'fs_patch', 'grep'])
  })

  it('executes Project Scaffolding multi-turn workflow with deep directories', async () => {
    const tools = registryWithBuiltins()

    const adapter = makeMockAdapter([
      // Turn 1: Scaffold package.json
      {
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            makeToolCall('fs_write', {
              path: 'package.json',
              content: '{\n  "name": "scaffold-app"\n}\n'
            })
          ]
        })
      },
      // Turn 2: Scaffold nested src/controllers/user.ts
      {
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            makeToolCall('fs_write', {
              path: 'src/controllers/user.ts',
              content: 'export class UserController {}\n'
            })
          ]
        })
      },
      // Turn 3: List files to inspect scaffolding
      {
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [
            makeToolCall('fs_list', { path: '.', recursive: true })
          ]
        })
      },
      // Turn 4: Final summary
      {
        response: makeResponse({ content: 'Project scaffold complete.' })
      }
    ])

    const runner = new AgentRunner({
      id: 'run-workload-scaffold',
      profile: makeProfile(),
      adapter,
      tools,
      directory: projectDir
    })

    const events: RunnerEvent[] = []
    const result = await runner.run('scaffold new app', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(result.toolCallCount).toBe(3)

    // Check files created
    expect(readFileSync(join(projectDir, 'package.json'), 'utf8')).toContain('scaffold-app')
    expect(readFileSync(join(projectDir, 'src/controllers/user.ts'), 'utf8')).toContain('UserController')
  })

  it('executes Shell Execution & Output Analysis workflow', async () => {
    const tools = registryWithBuiltins()

    // Determine platform echo
    const echoCmd = process.platform === 'win32' ? 'echo OpenCode_CLI_OK' : 'echo OpenCode_CLI_OK'

    const adapter = makeMockAdapter([
      // Turn 1: Run shell command
      {
        response: makeResponse({
          finishReason: 'tool_calls',
          toolCalls: [makeToolCall('shell', { command: echoCmd })]
        })
      },
      // Turn 2: Report analysis
      {
        response: makeResponse({
          content: 'Shell reported CLI environment is healthy.'
        })
      }
    ])

    const runner = new AgentRunner({
      id: 'run-workload-shell',
      profile: makeProfile(),
      adapter,
      tools,
      directory: projectDir
    })

    const events: RunnerEvent[] = []
    const result = await runner.run('test shell environment', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(result.toolCallCount).toBe(1)

    const toolResult = events.find((e) => e.type === 'tool_result') as {
      output: string
      error?: string
    }
    expect(toolResult.error).toBeUndefined()
    expect(toolResult.output).toContain('OpenCode_CLI_OK')
  })
})
