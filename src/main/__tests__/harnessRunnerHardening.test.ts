import { describe, expect, it, vi } from 'vitest'
import { AgentRunner, truncateToolOutput, type RunnerEvent, type RunnerResult } from '../harness/runner'
import { ToolRegistry, type ToolExecutor } from '../harness/tools/registry'
import type { AgentProfile } from '../harness/profiles'
import type {
  ChatDelta,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ToolCall
} from '../harness/providers/adapter'

// ── Helpers ──

let callSeq = 0

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return { id: 'tester', name: 'Tester', provider: 'stub', model: 'm', ...overrides }
}

function response(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return { id: 'r', content: '', finishReason: 'stop', usage: { input: 1, output: 1 }, ...overrides }
}

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function rawCall(name: string, rawArguments: string): ToolCall {
  return { id: `call-${++callSeq}`, type: 'function', function: { name, arguments: rawArguments } }
}

function toolTurn(calls: ToolCall[], overrides: Partial<ChatResponse> = {}): ChatResponse {
  return response({ finishReason: 'tool_calls', toolCalls: calls, ...overrides })
}

function register(tools: ToolRegistry, name: string, executor: ToolExecutor, category: 'read' | 'write' = 'read'): void {
  tools.register({ name, description: name, parameters: { type: 'object' }, category }, executor)
}

/** Every assistant tool_call id must have exactly one tool message, and vice versa. */
function pairingProblems(messages: ChatMessage[]): string[] {
  const problems: string[] = []
  const expected = new Set<string>()
  const answered = new Map<string, number>()
  for (const m of messages) {
    if (m.role === 'assistant') for (const tc of m.tool_calls ?? []) expected.add(tc.id)
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? ''
      answered.set(id, (answered.get(id) ?? 0) + 1)
    }
  }
  for (const id of expected) {
    const n = answered.get(id) ?? 0
    if (n !== 1) problems.push(`${id} answered ${n} times`)
  }
  for (const id of answered.keys()) {
    if (!expected.has(id)) problems.push(`${id} has no matching tool_call`)
  }
  return problems
}

type Step = ChatResponse | ((req: ChatRequest, onDelta?: (d: ChatDelta) => void) => Promise<ChatResponse> | ChatResponse)

/** Replays steps (last repeats), records requests, and records tool_call/tool pairing violations. */
function scripted(steps: Step[]) {
  const requests: ChatRequest[] = []
  const pairingViolations: string[] = []
  return {
    id: 'stub',
    requests,
    pairingViolations,
    chat: vi.fn(async (req: ChatRequest, onDelta?: (d: ChatDelta) => void): Promise<ChatResponse> => {
      requests.push(req)
      pairingViolations.push(...pairingProblems(req.messages))
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]
      return typeof step === 'function' ? step(req, onDelta) : step
    }),
    abort: vi.fn(),
    probe: vi.fn(async () => true)
  }
}

function newRunner(adapter: ProviderAdapter, tools: ToolRegistry, prof: AgentProfile = profile()): AgentRunner {
  return new AgentRunner({ id: 'run-1', profile: prof, adapter, tools, directory: '/tmp' })
}

async function execute(
  adapter: ProviderAdapter,
  tools: ToolRegistry,
  prof: AgentProfile = profile()
): Promise<{ runner: AgentRunner; events: RunnerEvent[]; result: RunnerResult }> {
  const events: RunnerEvent[] = []
  const runner = newRunner(adapter, tools, prof)
  const result = await runner.run('task', (e) => events.push(e))
  return { runner, events, result }
}

function toolMessages(req: ChatRequest): string[] {
  return req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content))
}

function toolResults(events: RunnerEvent[]): Array<Extract<RunnerEvent, { type: 'tool_result' }>> {
  return events.filter((e): e is Extract<RunnerEvent, { type: 'tool_result' }> => e.type === 'tool_result')
}

const WARNING = 'System Warning: You have called'

// ── 1. Streaming ──

describe('AgentRunner hardening: streaming deltas', () => {
  it('emits text and thinking deltas live, before the provider response resolves', async () => {
    const events: RunnerEvent[] = []
    let snapshotBeforeResolve: RunnerEvent[] = []
    const adapter = scripted([
      async (_req, onDelta) => {
        onDelta?.({ thinkingContent: 'hmm' })
        onDelta?.({ content: 'Hel' })
        onDelta?.({ content: 'lo' })
        await Promise.resolve()
        snapshotBeforeResolve = [...events]
        return response({ content: 'Hello', thinkingContent: 'hmm' })
      }
    ])
    const runner = newRunner(adapter, new ToolRegistry())
    await runner.run('task', (e) => events.push(e))

    expect(snapshotBeforeResolve).toEqual([
      { type: 'thinking', content: 'hmm' },
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' }
    ])
  })

  it('does not re-emit streamed text or thinking from the final response', async () => {
    const adapter = scripted([
      async (_req, onDelta) => {
        onDelta?.({ thinkingContent: 'think' })
        onDelta?.({ content: 'answer' })
        return response({ content: 'answer', thinkingContent: 'think' })
      }
    ])
    const { events } = await execute(adapter, new ToolRegistry())
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1)
  })

  it('emits from the final response what the provider did not stream, exactly once', async () => {
    const adapter = scripted([
      async (_req, onDelta) => {
        onDelta?.({ thinkingContent: 'streamed thinking' })
        return response({ content: 'only in final', thinkingContent: 'streamed thinking' })
      }
    ])
    const { events } = await execute(adapter, new ToolRegistry())
    expect(events.filter((e) => e.type === 'thinking')).toEqual([{ type: 'thinking', content: 'streamed thinking' }])
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'only in final' }])
  })

  it('tracks streamed flags per turn so a non-streamed turn after a streamed one still emits', async () => {
    const tools = new ToolRegistry()
    register(tools, 'noop', async () => ({ output: 'ok' }))
    const adapter = scripted([
      async (_req, onDelta) => {
        onDelta?.({ content: 'turn one ' })
        return toolTurn([call('noop')], { content: 'turn one ' })
      },
      response({ content: 'turn two' })
    ])
    const { events } = await execute(adapter, tools)
    expect(events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', delta: 'turn one ' },
      { type: 'text', delta: 'turn two' }
    ])
  })
})

// ── 2. Tool output cap ──

describe('AgentRunner hardening: tool output cap (30,000 chars)', () => {
  it('truncateToolOutput leaves exactly-30,000 output alone and cuts 30,001 with a notice', () => {
    expect(truncateToolOutput('a'.repeat(30_000))).toBe('a'.repeat(30_000))
    const cut = truncateToolOutput('a'.repeat(30_001))
    expect(cut.startsWith('a'.repeat(30_000))).toBe(true)
    expect(cut).toContain('[Output truncated: showing first 30,000 of 30,001 characters...]')
  })

  it('caps a successful tool output', async () => {
    const tools = new ToolRegistry()
    register(tools, 'big', async () => ({ output: 'A'.repeat(45_000) }))
    const adapter = scripted([toolTurn([call('big')]), response()])
    await execute(adapter, tools)
    const [msg] = toolMessages(adapter.requests[1])
    expect(msg.length).toBeLessThan(31_000)
    expect(msg).toContain('[Output truncated: showing first 30,000 of 45,000 characters...]')
  })

  it('caps the output of a failing tool (error path)', async () => {
    const tools = new ToolRegistry()
    register(tools, 'bigfail', async () => ({ output: 'B'.repeat(50_000), error: 'boom' }))
    const adapter = scripted([toolTurn([call('bigfail')]), response()])
    await execute(adapter, tools)
    const [msg] = toolMessages(adapter.requests[1])
    expect(msg.startsWith('Error: boom\n')).toBe(true)
    expect(msg.length).toBeLessThan(31_000)
    expect(msg).toMatch(/showing first 30,000 of [\d,]+ characters/)
  })

  it('keeps the loop guidance even when the failing tool error itself is enormous', async () => {
    const tools = new ToolRegistry()
    register(tools, 'hugeerr', async () => ({ output: '', error: 'E'.repeat(50_000) }))
    const same = { k: 1 }
    const adapter = scripted([
      toolTurn([call('hugeerr', same)]),
      toolTurn([call('hugeerr', same)]),
      toolTurn([call('hugeerr', same)]),
      response()
    ])
    const { events } = await execute(adapter, tools)
    const results = toolResults(events)
    expect(results).toHaveLength(3)
    expect(results[2].error).toContain(WARNING)
    expect(results[2].error!.length).toBeLessThan(31_000)
    const msgs = toolMessages(adapter.requests[3])
    expect(msgs[2]).toContain(WARNING)
    expect(msgs[2].length).toBeLessThan(31_000)
  })

  it('caps the result for an unknown tool with an enormous name', async () => {
    const adapter = scripted([toolTurn([call('x'.repeat(60_000))]), response()])
    const { events } = await execute(adapter, new ToolRegistry())
    const [msg] = toolMessages(adapter.requests[1])
    expect(msg).toContain('Tool not found: xxx')
    expect(msg.length).toBeLessThan(31_000)
    expect(toolResults(events)[0].error!.length).toBeLessThan(31_000)
  })

  it('caps the malformed-arguments error and echoes only a short excerpt of the raw arguments', async () => {
    const tools = new ToolRegistry()
    register(tools, 'writer', async () => ({ output: 'should not run' }))
    const rawArgs = '{"content":"' + 'z'.repeat(100_000)
    const adapter = scripted([toolTurn([rawCall('writer', rawArgs)]), response()])
    await execute(adapter, tools)
    const [msg] = toolMessages(adapter.requests[1])
    expect(msg.length).toBeLessThan(2_000)
    expect(msg).toContain('100,012 characters total')
  })

  it('does not crash when a tool returns a non-string output', async () => {
    const tools = new ToolRegistry()
    register(tools, 'weird', async () => ({ output: undefined as unknown as string }))
    const adapter = scripted([toolTurn([call('weird')]), response({ content: 'fine' })])
    const { result } = await execute(adapter, tools)
    expect(result.finishReason).toBe('complete')
    expect(adapter.pairingViolations).toEqual([])
  })
})

// ── 3. Repetitive failing call detection ──

describe('AgentRunner hardening: repetitive failing tool calls', () => {
  it('warns on the 3rd identical failure, never executes the 4th, and lets the model recover', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: '', error: 'nope' }))
    register(tools, 'stuck', executor)
    const args = { path: 'a' }
    const adapter = scripted([
      toolTurn([call('stuck', args)]),
      toolTurn([call('stuck', args)]),
      toolTurn([call('stuck', args)]),
      toolTurn([call('stuck', args)]),
      response({ content: 'gave up' })
    ])
    const { result, events } = await execute(adapter, tools)

    expect(result.finishReason).toBe('complete')
    expect(executor).toHaveBeenCalledTimes(3)
    const results = toolResults(events)
    expect(results.map((r) => r.error?.includes(WARNING))).toEqual([false, false, true, true])
    // The guidance is a tool message the model actually receives, with an actionable instruction.
    const lastMsgs = toolMessages(adapter.requests[4])
    expect(lastMsgs[2]).toContain('alternative approach or explain the blocker')
    expect(lastMsgs[3]).toContain(WARNING)
  })

  it('is bounded by maxTurns when the model ignores the guidance forever, without executing again', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: '', error: 'nope' }))
    register(tools, 'stuck', executor)
    const adapter = scripted([() => toolTurn([call('stuck', { a: 1 })])])
    const { result } = await execute(adapter, tools, profile({ maxTurns: 8 }))

    expect(result.finishReason).toBe('max_turns')
    expect(executor).toHaveBeenCalledTimes(3)
    expect(adapter.chat).toHaveBeenCalledTimes(8)
    expect(adapter.pairingViolations).toEqual([])
  })

  it('resets the count when the arguments differ', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: '', error: 'nope' }))
    register(tools, 'stuck', executor)
    const adapter = scripted([
      toolTurn([call('stuck', { x: 1 })]),
      toolTurn([call('stuck', { x: 1 })]),
      toolTurn([call('stuck', { x: 2 })]),
      toolTurn([call('stuck', { x: 1 })]),
      toolTurn([call('stuck', { x: 1 })]),
      response()
    ])
    const { events } = await execute(adapter, tools)

    expect(executor).toHaveBeenCalledTimes(5)
    expect(toolResults(events).some((r) => r.error?.includes(WARNING))).toBe(false)
  })

  it('resets the count when a different tool call succeeds in between', async () => {
    const tools = new ToolRegistry()
    const flaky = vi.fn(async () => ({ output: '', error: 'nope' }))
    const fine = vi.fn(async () => ({ output: 'ok' }))
    register(tools, 'flaky', flaky)
    register(tools, 'fine', fine)
    const same = { q: 'x' }
    const adapter = scripted([
      toolTurn([call('flaky', same)]),
      toolTurn([call('flaky', same)]),
      toolTurn([call('fine')]),
      toolTurn([call('flaky', same)]),
      toolTurn([call('flaky', same)]),
      toolTurn([call('flaky', same)]),
      toolTurn([call('flaky', same)]),
      response()
    ])
    await execute(adapter, tools)

    const msgs = toolMessages(adapter.requests[7])
    expect(msgs).toHaveLength(7)
    expect(msgs.map((m) => m.includes(WARNING))).toEqual([false, false, false, false, false, true, true])
    // Executed: flaky 1,2 then (after the success) 4,5,6 -> 5 runs; the 7th was blocked.
    expect(flaky).toHaveBeenCalledTimes(5)
    expect(fine).toHaveBeenCalledTimes(1)
  })

  it('resets the count when the same call succeeds', async () => {
    const tools = new ToolRegistry()
    let n = 0
    const executor = vi.fn(async () => {
      n++
      return n === 3 ? { output: 'worked' } : { output: '', error: 'nope' }
    })
    register(tools, 'sometimes', executor)
    const same = { z: 1 }
    const adapter = scripted([
      toolTurn([call('sometimes', same)]),
      toolTurn([call('sometimes', same)]),
      toolTurn([call('sometimes', same)]),
      toolTurn([call('sometimes', same)]),
      toolTurn([call('sometimes', same)]),
      response()
    ])
    const { events } = await execute(adapter, tools)
    expect(toolResults(events).some((r) => r.error?.includes(WARNING))).toBe(false)
    expect(executor).toHaveBeenCalledTimes(5)
  })

  it('treats repeated identical malformed arguments as a loop (never executing the tool)', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: 'ran' }))
    register(tools, 'writer', executor)
    const bad = '{"path": "a.txt", "content": '
    const adapter = scripted([
      toolTurn([rawCall('writer', bad)]),
      toolTurn([rawCall('writer', bad)]),
      toolTurn([rawCall('writer', bad)]),
      response()
    ])
    const { events } = await execute(adapter, tools)

    expect(executor).not.toHaveBeenCalled()
    const results = toolResults(events)
    expect(results.map((r) => r.error?.includes(WARNING))).toEqual([false, false, true])
  })

  it('applies the guidance to policy rejections of the same call', async () => {
    const tools = new ToolRegistry()
    const writeExecutor = vi.fn(async () => ({ output: 'written' }))
    register(tools, 'fs_write', writeExecutor, 'write')
    const same = { path: 'a' }
    const adapter = scripted([
      toolTurn([call('fs_write', same)]),
      toolTurn([call('fs_write', same)]),
      toolTurn([call('fs_write', same)]),
      toolTurn([call('fs_write', same)]),
      response()
    ])
    const { events } = await execute(adapter, tools, profile({ readOnly: true }))
    expect(writeExecutor).not.toHaveBeenCalled()
    expect(toolResults(events).map((r) => r.error?.includes(WARNING))).toEqual([false, false, true, true])
  })
})

// ── 4. Malformed JSON arguments ──

describe('AgentRunner hardening: malformed tool arguments', () => {
  it('returns a parse error naming the tool and the problem, and never executes the tool', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: 'ran' }))
    register(tools, 'fs_read', executor)
    const adapter = scripted([toolTurn([rawCall('fs_read', '{"path": "a.txt"')]), response({ content: 'fixed' })])
    const { result, events } = await execute(adapter, tools)

    expect(executor).not.toHaveBeenCalled()
    expect(result.finishReason).toBe('complete')
    expect(result.toolCallCount).toBe(1)
    expect(events.some((e) => e.type === 'tool_call')).toBe(false)
    const [msg] = toolMessages(adapter.requests[1])
    expect(msg).toContain('not valid JSON')
    expect(msg).toContain('"fs_read" schema')
    expect(msg).toMatch(/JSON|position|token|end of/i)
  })

  it.each([
    ['a JSON array', '[1,2]', 'array'],
    ['a JSON string', '"hello"', 'string'],
    ['a JSON number', '42', 'number'],
    ['JSON null', 'null', 'null']
  ])('rejects %s instead of passing {}', async (_label, raw, received) => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: 'ran' }))
    register(tools, 'calc', executor)
    const adapter = scripted([toolTurn([rawCall('calc', raw)]), response()])
    await execute(adapter, tools)

    expect(executor).not.toHaveBeenCalled()
    expect(toolMessages(adapter.requests[1])[0]).toContain(`Expected a JSON object, but received ${received}`)
  })

  it('still treats empty and whitespace-only arguments as a legitimate no-argument call', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async (_args: Record<string, unknown>) => ({ output: 'ran' }))
    register(tools, 'noargs', executor)
    const adapter = scripted([toolTurn([rawCall('noargs', ''), rawCall('noargs', '   ')]), response()])
    await execute(adapter, tools)
    expect(executor).toHaveBeenCalledTimes(2)
    expect(executor.mock.calls.map((c) => c[0])).toEqual([{}, {}])
  })

  it('answers every call in a mixed batch (malformed + valid) exactly once', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: 'valid ran' }))
    register(tools, 'ok', executor)
    const adapter = scripted([
      toolTurn([rawCall('ok', '{bad'), call('ok', { fine: true })]),
      response()
    ])
    await execute(adapter, tools)
    expect(executor).toHaveBeenCalledTimes(1)
    expect(toolMessages(adapter.requests[1])).toHaveLength(2)
    expect(adapter.pairingViolations).toEqual([])
  })
})

// ── 5. Hard stops ──

describe('AgentRunner hardening: maxTurns and tokenBudget hard stops', () => {
  function loopingTools(): ToolRegistry {
    const tools = new ToolRegistry()
    register(tools, 'noop', async () => ({ output: 'ok' }))
    return tools
  }

  it('stops at maxTurns with finishReason "max_turns" and never issues another request', async () => {
    const adapter = scripted([() => toolTurn([call('noop')])])
    const { result, events } = await execute(adapter, loopingTools(), profile({ maxTurns: 3 }))

    expect(result.finishReason).toBe('max_turns')
    expect(result.turns).toBe(3)
    expect(adapter.chat).toHaveBeenCalledTimes(3)
    expect(events.some((e) => e.type === 'budget_warning')).toBe(false)
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('stops before the next call once accumulated input tokens reach tokenBudget', async () => {
    const adapter = scripted([() => toolTurn([call('noop')], { usage: { input: 60, output: 5 } })])
    const { result, events } = await execute(adapter, loopingTools(), profile({ tokenBudget: 100 }))

    expect(result.finishReason).toBe('budget_exceeded')
    expect(adapter.chat).toHaveBeenCalledTimes(2) // 60 < 100 -> second call; 120 >= 100 -> stop
    expect(events).toContainEqual({ type: 'budget_warning', field: 'tokenBudget', used: 120, limit: 100 })
    expect(result.usage).toEqual({ input: 120, output: 10 })
  })

  it('treats usage exactly equal to the budget as exhausted', async () => {
    const adapter = scripted([() => toolTurn([call('noop')], { usage: { input: 50, output: 0 } })])
    const { result } = await execute(adapter, loopingTools(), profile({ tokenBudget: 50 }))
    expect(result.finishReason).toBe('budget_exceeded')
    expect(adapter.chat).toHaveBeenCalledTimes(1)
  })

  it('does not stop a run that stays under budget and maxTurns', async () => {
    const adapter = scripted([toolTurn([call('noop')], { usage: { input: 10, output: 1 } }), response({ usage: { input: 10, output: 1 } })])
    const { result } = await execute(adapter, loopingTools(), profile({ tokenBudget: 1000, maxTurns: 5 }))
    expect(result.finishReason).toBe('complete')
  })

  it('uses distinct finish reasons for turn exhaustion, budget exhaustion and provider errors', async () => {
    const turns = await execute(scripted([() => toolTurn([call('noop')])]), loopingTools(), profile({ maxTurns: 1 }))
    const budget = await execute(
      scripted([() => toolTurn([call('noop')], { usage: { input: 9, output: 0 } })]),
      loopingTools(),
      profile({ tokenBudget: 5 })
    )
    const failing = await execute(
      { id: 's', chat: async () => { throw new Error('x') }, abort: vi.fn(), probe: async () => true },
      loopingTools()
    )
    expect(new Set([turns.result.finishReason, budget.result.finishReason, failing.result.finishReason]).size).toBe(3)
    expect([turns.result.finishReason, budget.result.finishReason, failing.result.finishReason]).toEqual([
      'max_turns',
      'budget_exceeded',
      'error'
    ])
  })
})

// ── 6. Abort propagation ──

describe('AgentRunner hardening: abort propagation', () => {
  /** Adapter whose chat hangs until request.signal aborts, then rejects like fetch does. */
  function hangingUntilAborted() {
    let started!: () => void
    const startedPromise = new Promise<void>((r) => { started = r })
    const seen: { signal?: AbortSignal; requestId?: string } = {}
    const adapter = {
      id: 'hang',
      chat: vi.fn((req: ChatRequest) => {
        seen.signal = req.signal
        seen.requestId = req.requestId
        return new Promise<ChatResponse>((_resolve, reject) => {
          req.signal?.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
            { once: true }
          )
          started()
        })
      }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }
    return { adapter, started: startedPromise, seen }
  }

  it('aborts the in-flight provider request (signal + adapter.abort) and finishes "aborted", not "error"', async () => {
    const { adapter, started, seen } = hangingUntilAborted()
    const events: RunnerEvent[] = []
    const runner = newRunner(adapter, new ToolRegistry())
    const running = runner.run('task', (e) => events.push(e))
    await started
    expect(seen.signal?.aborted).toBe(false)

    runner.abort()
    const result = await running

    expect(seen.signal?.aborted).toBe(true)
    expect(adapter.abort).toHaveBeenCalledWith('run-1-turn-0')
    expect(adapter.abort).toHaveBeenCalledWith('run-1')
    expect(result.finishReason).toBe('aborted')
    expect(result.error).toBeUndefined()
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'done', result })
  })

  it('still finishes "aborted" promptly when the adapter ignores the abort signal entirely', async () => {
    let started!: () => void
    const startedPromise = new Promise<void>((r) => { started = r })
    const adapter = {
      id: 'deaf',
      chat: vi.fn(() => { started(); return new Promise<ChatResponse>(() => {}) }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }
    const runner = newRunner(adapter, new ToolRegistry())
    const running = runner.run('task', () => {})
    await startedPromise
    runner.abort()
    const result = await running
    expect(result.finishReason).toBe('aborted')
  })

  it('does not leak an unhandled rejection when an abandoned provider call rejects after abort', async () => {
    let started!: () => void
    const startedPromise = new Promise<void>((r) => { started = r })
    const adapter = {
      id: 'late',
      chat: vi.fn(() => new Promise<ChatResponse>((_resolve, reject) => {
        started()
        setTimeout(() => reject(new Error('late failure')), 20)
      })),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }
    const runner = newRunner(adapter, new ToolRegistry())
    const running = runner.run('task', () => {})
    await startedPromise
    runner.abort()
    expect((await running).finishReason).toBe('aborted')
    await new Promise((r) => setTimeout(r, 60))
  })

  it('aborts the running tool through ToolContext.abortSignal and finishes "aborted"', async () => {
    const tools = new ToolRegistry()
    let toolSignal: AbortSignal | undefined
    let toolStarted!: () => void
    const startedPromise = new Promise<void>((r) => { toolStarted = r })
    register(tools, 'slow', async (_args, ctx) => {
      toolSignal = ctx.abortSignal
      toolStarted()
      await new Promise<void>((resolve) => ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true }))
      return { output: 'killed', error: 'aborted by signal' }
    })
    const adapter = scripted([toolTurn([call('slow')]), response({ content: 'should never be requested' })])
    const events: RunnerEvent[] = []
    const runner = newRunner(adapter, tools)
    const running = runner.run('task', (e) => events.push(e))
    await startedPromise
    expect(toolSignal?.aborted).toBe(false)

    runner.abort()
    const result = await running

    expect(toolSignal?.aborted).toBe(true)
    expect(result.finishReason).toBe('aborted')
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(adapter.chat).toHaveBeenCalledTimes(1) // no request with dangling tool_calls was sent
  })

  it('passes the same signal to the provider request and to tools', async () => {
    const tools = new ToolRegistry()
    let toolSignal: AbortSignal | undefined
    register(tools, 'peek', async (_args, ctx) => {
      toolSignal = ctx.abortSignal
      return { output: 'ok' }
    })
    const adapter = scripted([toolTurn([call('peek')]), response()])
    await execute(adapter, tools)
    expect(adapter.requests[0].signal).toBeDefined()
    expect(toolSignal).toBe(adapter.requests[0].signal)
  })

  it('stops a tool batch midway: remaining calls are not executed and no request carries dangling tool_calls', async () => {
    const tools = new ToolRegistry()
    const holder: { runner?: AgentRunner } = {}
    const first = vi.fn(async () => { holder.runner?.abort(); return { output: 'first ran' } })
    const second = vi.fn(async () => ({ output: 'second ran' }))
    register(tools, 'first', first)
    register(tools, 'second', second)
    const adapter = scripted([toolTurn([call('first'), call('second')]), response()])
    const runner = newRunner(adapter, tools)
    holder.runner = runner
    const result = await runner.run('task', () => {})

    expect(result.finishReason).toBe('aborted')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(adapter.chat).toHaveBeenCalledTimes(1)
    expect(adapter.pairingViolations).toEqual([])
  })

  it('finishes "aborted" without any provider call when aborted before run()', async () => {
    const adapter = scripted([response()])
    const runner = newRunner(adapter, new ToolRegistry())
    runner.abort()
    const result = await runner.run('task', () => {})
    expect(result.finishReason).toBe('aborted')
    expect(adapter.chat).not.toHaveBeenCalled()
  })

  it('still aborts when adapter.abort() itself throws', async () => {
    const { adapter, started, seen } = hangingUntilAborted()
    adapter.abort.mockImplementation(() => { throw new Error('adapter abort exploded') })
    const runner = newRunner(adapter, new ToolRegistry())
    const running = runner.run('task', () => {})
    await started
    expect(() => runner.abort()).not.toThrow()
    const result = await running
    expect(seen.signal?.aborted).toBe(true)
    expect(result.finishReason).toBe('aborted')
  })
})

// ── 7. Tool calls with non-"tool_calls" finish reasons ──

describe('AgentRunner hardening: finish reason vs. tool calls', () => {
  it('executes tool calls when the provider reports finishReason "stop" (Gemini-style)', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: 'looked' }))
    register(tools, 'look', executor)
    const adapter = scripted([
      response({ finishReason: 'stop', toolCalls: [call('look', { where: 'here' })] }),
      response({ content: 'done looking' })
    ])
    const { result } = await execute(adapter, tools)

    expect(executor).toHaveBeenCalledTimes(1)
    expect(result.finishReason).toBe('complete')
    expect(result.content).toBe('done looking')
    expect(result.toolCallCount).toBe(1)
    expect(result.turns).toBe(2)
    expect(adapter.pairingViolations).toEqual([])
  })

  it('does not execute truncated tool calls on finishReason "length"; each gets a cut-off tool result to retry from', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: 'wrote' }))
    register(tools, 'big_write', executor)
    const adapter = scripted([
      response({
        finishReason: 'length',
        content: 'Writing...',
        toolCalls: [rawCall('big_write', '{"content": "abc'), call('big_write', { content: 'complete-looking' })]
      }),
      response({ content: 'retrying smaller' })
    ])
    const { result, events } = await execute(adapter, tools)

    expect(executor).not.toHaveBeenCalled()
    expect(result.finishReason).toBe('complete')
    expect(events.some((e) => e.type === 'tool_call')).toBe(false)

    const second = adapter.requests[1]
    const assistant = second.messages.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls).toHaveLength(2)
    const msgs = toolMessages(second)
    expect(msgs).toHaveLength(2)
    for (const msg of msgs) {
      expect(msg).toContain('output token limit')
      expect(msg).toContain('NOT executed')
      expect(msg).toContain('"big_write"')
    }
    expect(toolResults(events)).toHaveLength(2)
    expect(adapter.pairingViolations).toEqual([])
  })

  it('completes normally on finishReason "length" with no tool calls', async () => {
    const adapter = scripted([response({ finishReason: 'length', content: 'partial answer' })])
    const { result } = await execute(adapter, new ToolRegistry())
    expect(result.finishReason).toBe('complete')
    expect(result.content).toBe('partial answer')
  })

  it('completes when finishReason is "tool_calls" but the call list is empty or missing', async () => {
    const variants: Array<ToolCall[] | undefined> = [undefined, []]
    for (const toolCalls of variants) {
      const adapter = scripted([response({ finishReason: 'tool_calls', content: 'nothing to call', toolCalls })])
      const { result } = await execute(adapter, new ToolRegistry())
      expect(result.finishReason).toBe('complete')
      expect(adapter.chat).toHaveBeenCalledTimes(1)
    }
  })

  it('reports finishReason "error" without tool calls as a failed run, not a completed one', async () => {
    const adapter = scripted([response({ finishReason: 'error', content: '' })])
    const { result, events } = await execute(adapter, new ToolRegistry())
    expect(result.finishReason).toBe('error')
    expect(result.error).toMatch(/error response/i)
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('echoes providerReplay onto the assistant message for executed and cut-off tool turns', async () => {
    const tools = new ToolRegistry()
    register(tools, 'noop', async () => ({ output: 'ok' }))
    const adapter = scripted([
      toolTurn([call('noop')], { providerReplay: { anthropic: { thinking: 'sig-1' } } }),
      response({ finishReason: 'length', toolCalls: [call('noop')], providerReplay: { gemini: { sig: 'sig-2' } } }),
      response({ content: 'end' })
    ])
    await execute(adapter, tools)
    const replays = adapter.requests[2].messages.filter((m) => m.role === 'assistant').map((m) => m.providerReplay)
    expect(replays).toEqual([{ anthropic: { thinking: 'sig-1' } }, { gemini: { sig: 'sig-2' } }])
  })
})

// ── 8. One tool result per tool call ──

describe('AgentRunner hardening: exactly one tool result per tool call', () => {
  it('answers every call exactly once across success, failure, malformed, unknown, denied and loop-blocked calls', async () => {
    const tools = new ToolRegistry()
    register(tools, 'ok', async () => ({ output: 'fine' }))
    register(tools, 'bad', async () => ({ output: '', error: 'failed' }))
    register(tools, 'writer', async () => ({ output: 'wrote' }), 'write')
    const badArgs = { id: 7 }
    const adapter = scripted([
      toolTurn([call('ok'), rawCall('ok', '{oops'), call('missing_tool'), call('writer', { p: 1 })]),
      toolTurn([call('bad', badArgs), call('bad', badArgs), call('bad', badArgs), call('bad', badArgs), call('bad', badArgs)]),
      response({ finishReason: 'length', toolCalls: [call('ok'), call('bad', badArgs)] }),
      response({ content: 'finished' })
    ])
    const { result } = await execute(adapter, tools, profile({ readOnly: true }))

    expect(result.finishReason).toBe('complete')
    expect(adapter.pairingViolations).toEqual([])
    expect(adapter.chat).toHaveBeenCalledTimes(4)
    expect(toolMessages(adapter.requests[3])).toHaveLength(4 + 5 + 2)
  })

  it('turns a throwing tool executor into an error result for that call and keeps the batch intact', async () => {
    const tools = new ToolRegistry()
    register(tools, 'explodes', async () => { throw new Error('executor blew up') })
    register(tools, 'fine', async () => ({ output: 'fine ran' }))
    const adapter = scripted([toolTurn([call('explodes'), call('fine')]), response({ content: 'ok' })])
    const { result } = await execute(adapter, tools)

    expect(result.finishReason).toBe('complete')
    const msgs = toolMessages(adapter.requests[1])
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toContain('executor blew up')
    expect(msgs[1]).toBe('fine ran')
    expect(adapter.pairingViolations).toEqual([])
  })
})

// ── 9. Usage accounting and provider errors ──

describe('AgentRunner hardening: usage accounting and provider errors', () => {
  it('keeps usage and turns from completed turns when the provider throws mid-run, message unchanged', async () => {
    const tools = new ToolRegistry()
    register(tools, 'noop', async () => ({ output: 'ok' }))
    const providerMessage = 'Provider request failed (HTTP 429): rate limited. key=[REDACTED]'
    const adapter = scripted([
      toolTurn([call('noop')], { usage: { input: 100, output: 20, reasoning: 7 } }),
      toolTurn([call('noop')], { usage: { input: 150, output: 30 } }),
      () => { throw new Error(providerMessage) }
    ])
    const { result, events, runner } = await execute(adapter, tools)

    expect(result.finishReason).toBe('error')
    expect(result.error).toBe(providerMessage)
    expect(events).toContainEqual({ type: 'error', message: providerMessage })
    expect(result.turns).toBe(2)
    expect(result.toolCallCount).toBe(2)
    expect(result.usage).toEqual({ input: 250, output: 50, reasoning: 7 })
    expect(runner.getStatus()).toMatchObject({ turns: 2, usage: { input: 250, output: 50, reasoning: 7 }, running: false })
    expect(events.at(-1)).toEqual({ type: 'done', result })
  })

  it('passes through rejected non-Error values and falls back for empty messages', async () => {
    const stringThrow = await execute(
      { id: 's', chat: async () => { throw 'plain string failure' }, abort: vi.fn(), probe: async () => true },
      new ToolRegistry()
    )
    expect(stringThrow.result.error).toBe('plain string failure')

    const emptyMessage = await execute(
      { id: 's', chat: async () => { throw new Error('') }, abort: vi.fn(), probe: async () => true },
      new ToolRegistry()
    )
    expect(emptyMessage.result.finishReason).toBe('error')
    expect(emptyMessage.result.error).toBeTruthy()
  })

  it('tolerates a response with missing or non-numeric usage without crashing', async () => {
    const adapter = scripted([
      response({ usage: undefined as unknown as ChatResponse['usage'], content: 'no usage reported' })
    ])
    const { result } = await execute(adapter, new ToolRegistry())
    expect(result.finishReason).toBe('complete')
    expect(result.usage).toEqual({ input: 0, output: 0 })
  })

  it('aggregates reasoning tokens across turns', async () => {
    const tools = new ToolRegistry()
    register(tools, 'noop', async () => ({ output: 'ok' }))
    const adapter = scripted([
      toolTurn([call('noop')], { usage: { input: 1, output: 2, reasoning: 3 } }),
      response({ usage: { input: 4, output: 5, reasoning: 6 } })
    ])
    const { result } = await execute(adapter, tools)
    expect(result.usage).toEqual({ input: 5, output: 7, reasoning: 9 })
  })
})
