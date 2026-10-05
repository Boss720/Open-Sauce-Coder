import { describe, expect, it, vi } from 'vitest'
import { AgentRunner, canonicalJson, parseToolArgs, truncateToolOutput, type RunnerEvent } from '../harness/runner'
import { ToolRegistry } from '../harness/tools/registry'
import type { AgentProfile } from '../harness/profiles'
import type { ChatResponse, ProviderAdapter } from '../harness/providers/adapter'

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return { id: 'tester', name: 'Tester', provider: 'stub', model: 'm', ...overrides }
}

function response(overrides: Partial<ChatResponse>): ChatResponse {
  return {
    id: 'r1',
    content: '',
    finishReason: 'stop',
    usage: { input: 1, output: 1 },
    ...overrides
  }
}

/** Adapter that replays queued responses (last one repeats when exhausted). */
function stubAdapter(responses: ChatResponse[]): ProviderAdapter & { chat: ReturnType<typeof vi.fn> } {
  let i = 0
  return {
    id: 'stub',
    chat: vi.fn(async () => responses[Math.min(i++, responses.length - 1)]),
    abort: vi.fn(),
    probe: vi.fn(async () => true)
  }
}

function toolCall(name: string, args: Record<string, unknown> = {}): NonNullable<ChatResponse['toolCalls']>[number] {
  return { id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function makeRunner(adapter: ProviderAdapter, tools: ToolRegistry, prof = profile()): AgentRunner {
  return new AgentRunner({ id: 'run-1', profile: prof, adapter, tools, directory: '/tmp' })
}

describe('AgentRunner', () => {
  it('executes a tool_call response, then completes on the next stop response', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async (_args: Record<string, unknown>, _ctx: unknown) => ({ output: 'tool says hi' }))
    tools.register(
      { name: 'echo', description: 'echo', parameters: { type: 'object' }, category: 'read' },
      executor
    )

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('echo', { x: 1 })] }),
      response({ content: 'final answer', finishReason: 'stop' })
    ])

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools)
    const result = await runner.run('do the thing', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(result.content).toBe('final answer')
    expect(result.toolCallCount).toBe(1)
    expect(result.turns).toBe(2)
    expect(result.usage).toEqual({ input: 2, output: 2 })

    expect(executor).toHaveBeenCalledTimes(1)
    expect(executor.mock.calls[0][0]).toEqual({ x: 1 })
    expect(executor.mock.calls[0][1]).toMatchObject({ directory: '/tmp', agentId: 'tester', runId: 'run-1' })

    const types = events.map((e) => e.type)
    expect(types).toEqual(['tool_call', 'tool_result', 'text', 'done'])
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toMatchObject({ name: 'echo', output: 'tool says hi' })
    expect(events.at(-1)).toEqual({ type: 'done', result })

    // The second chat call saw the tool result appended as a tool message.
    const secondRequest = adapter.chat.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> }
    const toolMessage = secondRequest.messages.at(-1)
    expect(toolMessage?.role).toBe('tool')
    expect(toolMessage?.content).toBe('tool says hi')
  })

  it('stops with finishReason "max_turns" when the profile budget is exhausted', async () => {
    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('noop')] })
    ])
    const tools = new ToolRegistry()
    tools.register(
      { name: 'noop', description: 'noop', parameters: { type: 'object' }, category: 'read' },
      async () => ({ output: '' })
    )

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools, profile({ maxTurns: 1 }))
    const result = await runner.run('loop forever', (e) => events.push(e))

    expect(result.finishReason).toBe('max_turns')
    expect(result.turns).toBe(1)
    expect(adapter.chat).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toEqual({ type: 'done', result })
  })

  it('abort() ends the run with finishReason "aborted" and aborts the adapter', async () => {
    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('noop')] })
    ])
    const tools = new ToolRegistry()
    tools.register(
      { name: 'noop', description: 'noop', parameters: { type: 'object' }, category: 'read' },
      async () => ({ output: '' })
    )

    const runner = makeRunner(adapter, tools)
    const events: RunnerEvent[] = []
    const result = await runner.run('run', (e) => {
      events.push(e)
      if (e.type === 'tool_result') runner.abort()
    })

    expect(result.finishReason).toBe('aborted')
    expect(adapter.abort).toHaveBeenCalledWith('run-1')
    expect(events.at(-1)).toEqual({ type: 'done', result })
  })

  it('turns adapter exceptions into an error event and an error result', async () => {
    const adapter: ProviderAdapter = {
      id: 'stub',
      chat: vi.fn(async () => { throw new Error('provider down') }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }
    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, new ToolRegistry())
    const result = await runner.run('boom', (e) => events.push(e))

    expect(result.finishReason).toBe('error')
    expect(result.error).toBe('provider down')
    expect(events.some((e) => e.type === 'error' && e.message === 'provider down')).toBe(true)
  })

  it('rejects mutating tool before executor is called when profile is readOnly', async () => {
    const tools = new ToolRegistry()
    const writeExecutor = vi.fn(async () => ({ output: 'written' }))
    tools.register(
      { name: 'fs_write', description: 'write', parameters: { type: 'object' }, category: 'write' },
      writeExecutor
    )

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('fs_write', { path: 'a.txt' })] }),
      response({ content: 'done', finishReason: 'stop' })
    ])

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools, profile({ readOnly: true }))
    const result = await runner.run('write file', (e) => events.push(e))

    // Pre-execution policy broker must block executor dispatch
    expect(writeExecutor).toHaveBeenCalledTimes(0)
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toMatchObject({
      name: 'fs_write',
      error: expect.stringMatching(/read-only policy/i)
    })
    expect(result.finishReason).toBe('complete')
  })

  it('rejects tool on profile toolDenyList before executor is called', async () => {
    const tools = new ToolRegistry()
    const shellExecutor = vi.fn(async () => ({ output: 'executed' }))
    tools.register(
      { name: 'shell', description: 'shell', parameters: { type: 'object' }, category: 'shell' },
      shellExecutor
    )

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('shell', { command: 'dir' })] }),
      response({ content: 'done', finishReason: 'stop' })
    ])

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools, profile({ toolDenyList: ['shell'] }))
    await runner.run('run shell', (e) => events.push(e))

    expect(shellExecutor).toHaveBeenCalledTimes(0)
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toMatchObject({
      name: 'shell',
      error: expect.stringMatching(/denied by profile policy/i)
    })
  })

  it('rejects tool calls when profile specifies empty tools: []', async () => {
    const tools = new ToolRegistry()
    const readExecutor = vi.fn(async () => ({ output: 'read' }))
    tools.register(
      { name: 'fs_read', description: 'read', parameters: { type: 'object' }, category: 'read' },
      readExecutor
    )

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('fs_read', { path: 'x.txt' })] }),
      response({ content: 'done', finishReason: 'stop' })
    ])

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools, profile({ tools: [] }))
    await runner.run('read file', (e) => events.push(e))

    expect(readExecutor).toHaveBeenCalledTimes(0)
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toMatchObject({
      name: 'fs_read',
      error: expect.stringMatching(/no tools allowed/i)
    })
  })

  it('aborts queue and halts further tool execution when stop occurs during tool batch', async () => {
    const tools = new ToolRegistry()
    let runnerRef: AgentRunner | null = null
    const tool1 = vi.fn(async () => {
      runnerRef?.abort()
      return { output: 'tool1 ran' }
    })
    const tool2 = vi.fn(async () => ({ output: 'tool2 should never run' }))

    tools.register({ name: 't1', description: 't1', parameters: {}, category: 'read' }, tool1)
    tools.register({ name: 't2', description: 't2', parameters: {}, category: 'read' }, tool2)

    const adapter = stubAdapter([
      response({
        finishReason: 'tool_calls',
        toolCalls: [toolCall('t1'), toolCall('t2')]
      })
    ])

    const runner = makeRunner(adapter, tools)
    runnerRef = runner
    const events: RunnerEvent[] = []
    const result = await runner.run('batch', (e) => events.push(e))

    expect(tool1).toHaveBeenCalledTimes(1)
    expect(tool2).toHaveBeenCalledTimes(0)
    expect(result.finishReason).toBe('aborted')
    expect(events.at(-1)).toEqual({ type: 'done', result })
  })

  it('handles malformed JSON arguments by returning error to model', async () => {
    const tools = new ToolRegistry()
    const echoExecutor = vi.fn(async () => ({ output: 'should not run' }))
    tools.register({ name: 'echo', description: 'echo', parameters: {}, category: 'read' }, echoExecutor)

    const malformedCall: NonNullable<ChatResponse['toolCalls']>[number] = {
      id: 'bad-call-1',
      type: 'function',
      function: { name: 'echo', arguments: '{invalid-json: ' }
    }

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [malformedCall] }),
      response({ content: 'recovered', finishReason: 'stop' })
    ])

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools)
    const result = await runner.run('bad json test', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(echoExecutor).toHaveBeenCalledTimes(0)

    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toMatchObject({
      name: 'echo',
      error: expect.stringMatching(/not valid JSON/i)
    })

    const secondRequest = adapter.chat.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> }
    const toolMsg = secondRequest.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('not valid JSON')
  })

  it('treats empty string tool arguments as empty object arguments', async () => {
    const tools = new ToolRegistry()
    const noargExecutor = vi.fn(async (_args: Record<string, unknown>) => ({ output: 'noarg success' }))
    tools.register({ name: 'noarg_tool', description: 'no args', parameters: {}, category: 'read' }, noargExecutor)

    const emptyArgCall: NonNullable<ChatResponse['toolCalls']>[number] = {
      id: 'empty-call-1',
      type: 'function',
      function: { name: 'noarg_tool', arguments: '' }
    }

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [emptyArgCall] }),
      response({ content: 'done', finishReason: 'stop' })
    ])

    const runner = makeRunner(adapter, tools)
    const result = await runner.run('test empty args', () => {})

    expect(result.finishReason).toBe('complete')
    expect(noargExecutor).toHaveBeenCalledTimes(1)
    expect((noargExecutor.mock.calls as any)[0][0]).toEqual({})
  })

  it('truncates individual tool output exceeding 30,000 characters before appending to messages', async () => {
    const tools = new ToolRegistry()
    const hugeOutput = 'A'.repeat(45_000)
    tools.register(
      { name: 'big_tool', description: 'big', parameters: {}, category: 'read' },
      async () => ({ output: hugeOutput })
    )

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('big_tool')] }),
      response({ content: 'done', finishReason: 'stop' })
    ])

    const runner = makeRunner(adapter, tools)
    await runner.run('test big output', () => {})

    const secondRequest = adapter.chat.mock.calls[1][0] as { messages: Array<{ role: string; content: unknown }> }
    const toolMsg = secondRequest.messages.find((m) => m.role === 'tool')
    expect(typeof toolMsg?.content).toBe('string')
    const content = toolMsg?.content as string
    expect(content.length).toBeLessThan(31_000)
    expect(content).toContain('[Output truncated: showing first 30,000 of 45,000 characters...]')
  })

  it('detects repetitive tool call loop and injects system guidance warning after 3 consecutive failures', async () => {
    const tools = new ToolRegistry()
    tools.register(
      { name: 'failing_tool', description: 'fails', parameters: {}, category: 'read' },
      async () => ({ output: '', error: 'file not found' })
    )

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('failing_tool', { path: 'same.txt' })] }),
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('failing_tool', { path: 'same.txt' })] }),
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('failing_tool', { path: 'same.txt' })] }),
      response({ content: 'stopped repeating', finishReason: 'stop' })
    ])

    const runner = makeRunner(adapter, tools)
    await runner.run('test loop detection', () => {})

    // The 4th chat invocation saw the 3rd tool message with loop guidance attached
    const fourthRequest = adapter.chat.mock.calls[3][0] as { messages: Array<{ role: string; content: unknown }> }
    const toolMessages = fourthRequest.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(3)
    const thirdToolMsg = toolMessages[2]
    expect(thirdToolMsg.content).toContain('System Warning: You have called "failing_tool" with identical arguments 3 times without progress')
  })

  it('emits real-time streaming deltas when adapter calls onDelta', async () => {
    const tools = new ToolRegistry()
    const streamingAdapter: ProviderAdapter = {
      id: 'streamer',
      chat: vi.fn(async (_req, onDelta) => {
        onDelta?.({ thinkingContent: 'let me think...' })
        onDelta?.({ content: 'first chunk ' })
        onDelta?.({ content: 'second chunk' })
        return response({ content: 'first chunk second chunk', thinkingContent: 'let me think...', finishReason: 'stop' })
      }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }

    const events: RunnerEvent[] = []
    const runner = makeRunner(streamingAdapter, tools)
    const result = await runner.run('stream test', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'text')).toHaveLength(2)
    expect(events.find((e) => e.type === 'thinking')).toEqual({ type: 'thinking', content: 'let me think...' })
  })

  it('detects repetitive loop regardless of JSON key ordering and injects warning on 3rd failure', async () => {
    const tools = new ToolRegistry()
    tools.register(
      { name: 'flaky_tool', description: 'flaky', parameters: {}, category: 'read' },
      async () => ({ output: '', error: 'connection refused' })
    )

    // Call 1: { b: 2, a: 1 }
    // Call 2: { a: 1, b: 2 } (reversed keys)
    // Call 3: { b: 2, a: 1 }
    // Call 4: Stop
    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('flaky_tool', { b: 2, a: 1 })] }),
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('flaky_tool', { a: 1, b: 2 })] }),
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('flaky_tool', { b: 2, a: 1 })] }),
      response({ content: 'stopped', finishReason: 'stop' })
    ])

    const runner = makeRunner(adapter, tools)
    await runner.run('test canonical loop detection', () => {})

    const fourthRequest = adapter.chat.mock.calls[3][0] as { messages: Array<{ role: string; content: unknown }> }
    const toolMessages = fourthRequest.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(3)
    const thirdMsg = toolMessages[2]
    expect(thirdMsg.content).toContain('System Warning: You have called "flaky_tool" with identical arguments 3 times without progress')
  })

  it('short-circuits and prevents tool execution on 4th consecutive attempt of failing call', async () => {
    const tools = new ToolRegistry()
    const executor = vi.fn(async () => ({ output: '', error: 'bad state' }))
    tools.register(
      { name: 'stuck_tool', description: 'stuck', parameters: {}, category: 'read' },
      executor
    )

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('stuck_tool', { id: 42 })] }),
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('stuck_tool', { id: 42 })] }),
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('stuck_tool', { id: 42 })] }),
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('stuck_tool', { id: 42 })] }),
      response({ content: 'finally broke loop', finishReason: 'stop' })
    ])

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools)
    const result = await runner.run('test short circuit on 4th attempt', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    expect(executor).toHaveBeenCalledTimes(3)

    const fifthRequest = adapter.chat.mock.calls[4][0] as { messages: Array<{ role: string; content: unknown }> }
    const toolMessages = fifthRequest.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(4)
    expect(toolMessages[3].content).toContain('System Warning: You have called "stuck_tool" with identical arguments 3 times without progress')
  })

  it('tracks repetitive loop and injects warning for policy broker rejections', async () => {
    const tools = new ToolRegistry()
    tools.register(
      { name: 'fs_write', description: 'write', parameters: {}, category: 'write' },
      async () => ({ output: 'written' })
    )

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('fs_write', { path: 'forbidden.txt' })] }),
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('fs_write', { path: 'forbidden.txt' })] }),
      response({ finishReason: 'tool_calls', toolCalls: [toolCall('fs_write', { path: 'forbidden.txt' })] }),
      response({ content: 'stopped trying to write', finishReason: 'stop' })
    ])

    const runner = makeRunner(adapter, tools, profile({ readOnly: true }))
    await runner.run('test policy loop detection', () => {})

    const fourthRequest = adapter.chat.mock.calls[3][0] as { messages: Array<{ role: string; content: unknown }> }
    const toolMessages = fourthRequest.messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(3)
    const thirdMsg = toolMessages[2]
    expect(thirdMsg.content).toContain('System Warning: You have called "fs_write" with identical arguments 3 times without progress')
  })

  it('returns schema guidance on malformed JSON and rejects arrays', async () => {
    const tools = new ToolRegistry()
    tools.register({ name: 'calc', description: 'calculator', parameters: { type: 'object' }, category: 'read' }, async () => ({ output: 'ok' }))

    const arrayCall: NonNullable<ChatResponse['toolCalls']>[number] = {
      id: 'bad-call-array',
      type: 'function',
      function: { name: 'calc', arguments: '[1, 2, 3]' }
    }

    const adapter = stubAdapter([
      response({ finishReason: 'tool_calls', toolCalls: [arrayCall] }),
      response({ content: 'fixed', finishReason: 'stop' })
    ])

    const events: RunnerEvent[] = []
    const runner = makeRunner(adapter, tools)
    const result = await runner.run('test array rejection', (e) => events.push(e))

    expect(result.finishReason).toBe('complete')
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toMatchObject({
      name: 'calc',
      error: expect.stringMatching(/Expected a JSON object, but received array/i)
    })
    expect(toolResult?.error).toContain('matching the "calc" schema')
  })

  it('allows runs to proceed past 20 turns when maxTurns is configured higher', async () => {
    const tools = new ToolRegistry()
    tools.register(
      { name: 'step', description: 'step', parameters: {}, category: 'read' },
      async () => ({ output: 'ok' })
    )

    const responses: ChatResponse[] = []
    for (let i = 0; i < 22; i++) {
      responses.push(response({ finishReason: 'tool_calls', toolCalls: [toolCall('step', { i })] }))
    }
    responses.push(response({ content: 'all 22 steps complete', finishReason: 'stop' }))

    const adapter = stubAdapter(responses)
    const runner = makeRunner(adapter, tools, profile({ maxTurns: 30 }))
    const result = await runner.run('long run', () => {})

    expect(result.finishReason).toBe('complete')
    expect(result.turns).toBe(23)
    expect(result.toolCallCount).toBe(22)
  })
})

describe('canonicalJson', () => {
  it('sorts keys recursively and handles primitives and arrays', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(canonicalJson({ b: { d: 4, c: 3 }, a: [2, 1] })).toBe('{"a":[2,1],"b":{"c":3,"d":4}}')
    expect(canonicalJson('hello')).toBe('"hello"')
    expect(canonicalJson(42)).toBe('42')
    expect(canonicalJson(null)).toBe('null')
  })
})

describe('parseToolArgs', () => {
  it('parses valid JSON objects', () => {
    const res = parseToolArgs('{"key": "value"}')
    expect(res).toEqual({ ok: true, args: { key: 'value' } })
  })

  it('rejects arrays with informative error message', () => {
    const res = parseToolArgs('[1, 2, 3]')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.raw).toBe('[1, 2, 3]')
      expect(res.error).toContain('received array')
    }
  })

  it('rejects syntax errors with captured error details', () => {
    const res = parseToolArgs('{ invalid json')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.raw).toBe('{ invalid json')
      expect(res.error.length).toBeGreaterThan(0)
    }
  })

  it('rejects primitives and null with descriptive type errors', () => {
    const res = parseToolArgs('null')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toContain('received null')
    }
  })
})
