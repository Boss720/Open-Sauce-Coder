import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadByokEnv } from '../keys'
import {
  AnthropicAdapter,
  anthropicModelTraits,
  toAnthropicMessages
} from '../harness/providers/anthropic'
import type { ChatDelta, ChatMessage, ChatRequest } from '../harness/providers/adapter'

const TEST_KEY = 'sk-ant-test-key-0001'

vi.mock('../keys', () => ({
  loadByokEnv: vi.fn(() => ({ ANTHROPIC_API_KEY: 'sk-ant-test-key-0001' }))
}))

type SseEvent = Record<string, unknown>

const encoder = new TextEncoder()

function sseText(events: SseEvent[]): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
}

/** A complete SSE response; `chunkSize` splits the payload at arbitrary byte boundaries. */
function streamResponse(events: SseEvent[], chunkSize?: number): Response {
  const bytes = encoder.encode(sseText(events))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (!chunkSize) {
        controller.enqueue(bytes)
      } else {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize))
      }
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** A response that emits `events` and then never finishes (until the reader is cancelled). */
function stalledResponse(events: SseEvent[], onCancel?: () => void): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseText(events)))
    },
    cancel() {
      onCancel?.()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function errorResponse(status: number, type: string, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

const messageStart = (usage: Record<string, number> = { input_tokens: 10 }): SseEvent => ({
  type: 'message_start',
  message: { id: 'msg_test', usage }
})

const textBlock = (index: number, text: string): SseEvent[] => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index }
]

const thinkingBlock = (index: number, thinking: string, signature?: string): SseEvent[] => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } },
  ...(signature ? [{ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } }] : []),
  { type: 'content_block_stop', index }
]

const redactedBlock = (index: number, data: string): SseEvent[] => [
  { type: 'content_block_start', index, content_block: { type: 'redacted_thinking', data } },
  { type: 'content_block_stop', index }
]

const toolBlock = (index: number, id: string, name: string, json: string): SseEvent[] => {
  const half = Math.ceil(json.length / 2)
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, half) } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(half) } },
    { type: 'content_block_stop', index }
  ]
}

const finish = (stopReason: string, outputTokens = 5): SseEvent[] => [
  { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: outputTokens } },
  { type: 'message_stop' }
]

const simpleAnswer = (text = 'ok'): SseEvent[] => [messageStart(), ...textBlock(0, text), ...finish('end_turn')]

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Stub global fetch; the nth call uses the nth responder (the last one repeats). */
function stubFetch(...responders: Array<() => Response | Promise<Response>>) {
  let call = 0
  const fn = vi.fn<FetchFn>(async () => {
    const responder = responders[Math.min(call, responders.length - 1)]
    call++
    return responder()
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

type SentBody = {
  model: string
  max_tokens: number
  stream: boolean
  system?: string
  messages: Array<{ role: string; content: Array<Record<string, unknown>> }>
  thinking?: unknown
  temperature?: number
  top_p?: number
  tools?: unknown
}

function bodyOf(fn: ReturnType<typeof stubFetch>, call = 0): SentBody {
  return JSON.parse(String(fn.mock.calls[call][1]?.body)) as SentBody
}

function headersOf(fn: ReturnType<typeof stubFetch>, call = 0): Record<string, string> {
  return fn.mock.calls[call][1]?.headers as Record<string, string>
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    requestId: 'run-1-turn-1',
    model: 'claude-sonnet-5-5',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides
  }
}

const fsReadTool = {
  type: 'function' as const,
  function: {
    name: 'fs_read',
    description: 'read file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(loadByokEnv).mockClear()
})

describe('anthropicModelTraits', () => {
  const modern = { adaptiveThinking: true, samplingAllowed: false }
  const adaptiveWithSampling = { adaptiveThinking: true, samplingAllowed: true }
  const legacy = { adaptiveThinking: false, samplingAllowed: true }

  it.each([
    ['claude-opus-5-5', modern],
    ['claude-sonnet-5-5', modern],
    ['claude-haiku-5-5', modern],
    ['claude-fable-5-1', modern],
    ['claude-fable-5', modern],
    ['claude-opus-5', modern],
    ['claude-sonnet-5', modern],
    ['claude-opus-4-8', modern],
    ['claude-opus-4-7', modern],
    ['claude-opus-4-6', adaptiveWithSampling],
    ['claude-sonnet-4-6', adaptiveWithSampling],
    ['claude-haiku-4-5', legacy],
    ['claude-sonnet-4-5', legacy],
    ['claude-opus-4-5', legacy],
    ['claude-opus-4-1', legacy],
    ['claude-haiku-4-5-20251001', legacy],
    ['claude-opus-4-1-20250805', legacy],
    ['claude-3-7-sonnet-20250219', legacy],
    ['claude-3-5-haiku-latest', legacy],
    ['claude-3-opus-20240229', legacy]
  ])('%s', (model, expected) => {
    expect(anthropicModelTraits(model)).toEqual(expected)
  })

  it('treats an 8-digit number as a date, not a minor version', () => {
    // If 20250514 were parsed as a minor version this would look like 4.x >= 4.6 and become adaptive.
    expect(anthropicModelTraits('claude-sonnet-4-20250514')).toEqual(legacy)
    expect(anthropicModelTraits('claude-opus-4-20250514')).toEqual(legacy)
  })

  it('tolerates provider prefixes', () => {
    expect(anthropicModelTraits('anthropic/claude-sonnet-4-20250514')).toEqual(legacy)
    expect(anthropicModelTraits('anthropic/claude-opus-5-5')).toEqual(modern)
  })

  it('defaults unknown or unparseable ids to the modern behaviour', () => {
    expect(anthropicModelTraits('my-proxy-model')).toEqual(modern)
    expect(anthropicModelTraits('claude-latest')).toEqual(modern)
    expect(anthropicModelTraits('')).toEqual(modern)
    expect(anthropicModelTraits('claude-mystery-9')).toEqual(modern)
  })
})

describe('AnthropicAdapter request body', () => {
  it('sends adaptive thinking with summarized display on adaptive models', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new AnthropicAdapter().chat(request({ model: 'claude-sonnet-5-5', thinking: { enabled: true, budget: 8000 } }))
    const body = bodyOf(fetchFn)
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.max_tokens).toBe(16000)
    expect(body.stream).toBe(true)
  })

  it('sends budget_tokens thinking on pre-4.6 models', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new AnthropicAdapter().chat(request({ model: 'claude-sonnet-4-20250514', thinking: { enabled: true, budget: 4096 } }))
    const body = bodyOf(fetchFn)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
    expect(body.max_tokens).toBeGreaterThan(4096)
  })

  it('clamps budget_tokens to the 1024 minimum and keeps max_tokens above the budget', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new AnthropicAdapter().chat(request({ model: 'claude-haiku-4-5', thinking: { enabled: true, budget: 100 }, maxTokens: 900 }))
    const body = bodyOf(fetchFn)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(body.max_tokens).toBeGreaterThan(1024)
  })

  it.each(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-4-5'])(
    'omits the thinking field entirely when thinking is not requested (%s)',
    async (model) => {
      const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
      await new AnthropicAdapter().chat(request({ model, thinking: { enabled: false } }))
      expect('thinking' in bodyOf(fetchFn)).toBe(false)
    }
  )

  it('omits thinking when the request carries no thinking config', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new AnthropicAdapter().chat(request())
    expect('thinking' in bodyOf(fetchFn)).toBe(false)
  })

  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-opus-4-7'])(
    'omits sampling parameters on new models (%s)',
    async (model) => {
      const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
      await new AnthropicAdapter().chat(request({ model, temperature: 0.3, topP: 0.8 }))
      const body = bodyOf(fetchFn)
      expect('temperature' in body).toBe(false)
      expect('top_p' in body).toBe(false)
      expect('top_k' in body).toBe(false)
    }
  )

  it('sends sampling parameters on models that allow them, preferring temperature over top_p', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()), () => streamResponse(simpleAnswer()))
    const adapter = new AnthropicAdapter()
    await adapter.chat(request({ model: 'claude-sonnet-4-6', temperature: 0.3, topP: 0.8 }))
    await adapter.chat(request({ model: 'claude-sonnet-4-6', topP: 0.8 }))
    expect(bodyOf(fetchFn, 0).temperature).toBe(0.3)
    expect('top_p' in bodyOf(fetchFn, 0)).toBe(false)
    expect(bodyOf(fetchFn, 1).top_p).toBe(0.8)
  })

  it('clamps temperature into the 0..1 range Anthropic accepts', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new AnthropicAdapter().chat(request({ model: 'claude-haiku-4-5', temperature: 1.7 }))
    expect(bodyOf(fetchFn).temperature).toBe(1)
  })

  it('never sends sampling parameters alongside thinking', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()), () => streamResponse(simpleAnswer()))
    const adapter = new AnthropicAdapter()
    await adapter.chat(request({ model: 'claude-sonnet-4-5', temperature: 0.2, topP: 0.9, thinking: { enabled: true } }))
    await adapter.chat(request({ model: 'claude-sonnet-4-6', temperature: 0.2, topP: 0.9, thinking: { enabled: true } }))
    for (const call of [0, 1]) {
      const body = bodyOf(fetchFn, call)
      expect('temperature' in body).toBe(false)
      expect('top_p' in body).toBe(false)
    }
  })

  it('sends tools in Anthropic shape and never sends tool_choice', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new AnthropicAdapter().chat(request({ tools: [fsReadTool] }))
    const body = bodyOf(fetchFn)
    expect(body.tools).toEqual([
      { name: 'fs_read', description: 'read file', input_schema: fsReadTool.function.parameters }
    ])
    expect('tool_choice' in body).toBe(false)
  })

  it('sends the required headers and honours a baseUrl override', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new AnthropicAdapter().chat(request({ baseUrl: 'http://127.0.0.1:9999/v1/' }))
    expect(fetchFn.mock.calls[0][0]).toBe('http://127.0.0.1:9999/v1/messages')
    const headers = headersOf(fetchFn)
    expect(headers['x-api-key']).toBe(TEST_KEY)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
  })

  it('honours an explicit maxTokens', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new AnthropicAdapter().chat(request({ maxTokens: 2000 }))
    expect(bodyOf(fetchFn).max_tokens).toBe(2000)
  })

  it('resolves the API key per request and never caches it', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()), () => streamResponse(simpleAnswer()))
    const adapter = new AnthropicAdapter()
    vi.mocked(loadByokEnv).mockReturnValueOnce({ ANTHROPIC_API_KEY: 'sk-ant-rotated-A' })
    await adapter.chat(request())
    await adapter.chat(request())
    expect(headersOf(fetchFn, 0)['x-api-key']).toBe('sk-ant-rotated-A')
    expect(headersOf(fetchFn, 1)['x-api-key']).toBe(TEST_KEY)
    expect(vi.mocked(loadByokEnv).mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('fails with a clear message when no key is configured', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    vi.mocked(loadByokEnv).mockReturnValueOnce({})
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      await expect(new AnthropicAdapter().chat(request())).rejects.toThrow(/No Anthropic API key/)
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('toAnthropicMessages', () => {
  it('merges all tool results of one assistant turn into a single user message', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
          { id: 'c3', type: 'function', function: { name: 'c', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      { role: 'tool', tool_call_id: 'c3', content: 'r3' }
    ])
    expect(messages).toHaveLength(3)
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
        { type: 'tool_result', tool_use_id: 'c2', content: 'r2' },
        { type: 'tool_result', tool_use_id: 'c3', content: 'r3' }
      ]
    })
  })

  it('appends a following user message to the tool_result message instead of creating a second user turn', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'working',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'user', content: 'also do this' }
    ])
    expect(messages).toHaveLength(3)
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
      { type: 'text', text: 'also do this' }
    ])
  })

  it('never emits empty or whitespace-only text blocks', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: '' },
      { role: 'user', content: [{ type: 'text', text: '   ' }, { type: 'text', text: 'real' }] },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'r1' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: null },
      { role: 'user', content: 'next' }
    ])
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'real' }] })
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'a', input: {} }]
    })
    // The empty assistant turns were skipped; "next" merged into the tool_result user turn.
    expect(messages).toHaveLength(3)
    const texts = JSON.stringify(messages).match(/"text":"([^"]*)"/g) ?? []
    for (const t of texts) expect(t).not.toBe('"text":""')
  })

  it('converts image_url parts to Anthropic image blocks', () => {
    const { messages } = toAnthropicMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
          { type: 'image_url', image_url: { url: 'file:///etc/passwd' } }
        ]
      }
    ])
    expect(messages[0].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.jpg' } },
      { type: 'text', text: '[unsupported image omitted]' }
    ])
  })

  it('joins system messages into the system string and recovers from malformed tool arguments', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'be brief' },
      { role: 'system', content: [{ type: 'text', text: 'be kind' }] },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{"path":' } }]
      }
    ])
    expect(system).toBe('be brief\n\nbe kind')
    expect(messages[1].content).toEqual([{ type: 'tool_use', id: 'c1', name: 'a', input: {} }])
  })

  it('re-emits thinking and redacted_thinking blocks, in order, before text and tool_use', () => {
    const assistant: ChatMessage = {
      role: 'assistant',
      content: 'I will read it.',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a"}' } }],
      providerReplay: {
        anthropic: {
          thinking: [
            { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
            { type: 'redacted_thinking', data: 'opaque-1' }
          ]
        }
      }
    }
    const { messages } = toAnthropicMessages([{ role: 'user', content: 'go' }, assistant])
    expect(messages[1].content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sig-1' },
      { type: 'redacted_thinking', data: 'opaque-1' },
      { type: 'text', text: 'I will read it.' },
      { type: 'tool_use', id: 'c1', name: 'fs_read', input: { path: 'a' } }
    ])
  })

  it('ignores malformed replay entries and other providers\' replay keys', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'done',
        providerReplay: { gemini: { thoughtSignature: 'x' } }
      },
      { role: 'user', content: 'again' },
      {
        role: 'assistant',
        content: 'done again',
        providerReplay: {
          anthropic: {
            thinking: [
              { type: 'thinking', thinking: 'no signature' },
              { type: 'redacted_thinking' },
              'garbage',
              { type: 'thinking', thinking: 'ok', signature: 's' }
            ]
          }
        }
      }
    ])
    expect(messages[1]).toEqual({ role: 'assistant', content: 'done' })
    expect(messages[3].content).toEqual([
      { type: 'thinking', thinking: 'ok', signature: 's' },
      { type: 'text', text: 'done again' }
    ])
  })
})

describe('AnthropicAdapter streaming', () => {
  it('streams text, thinking and tool calls and reports usage', async () => {
    stubFetch(() =>
      streamResponse([
        messageStart({ input_tokens: 25 }),
        ...thinkingBlock(0, 'Plan carefully...', 'sig-abc'),
        ...textBlock(1, 'I will check the file.'),
        ...toolBlock(2, 'call_1', 'fs_read', '{"path":"foo.txt"}'),
        ...finish('tool_use', 42)
      ])
    )
    const deltas: ChatDelta[] = []
    const response = await new AnthropicAdapter().chat(request({ tools: [fsReadTool] }), (d) => deltas.push(d))

    expect(response.id).toBe('msg_test')
    expect(response.content).toBe('I will check the file.')
    expect(response.thinkingContent).toBe('Plan carefully...')
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"foo.txt"}' } }
    ])
    expect(response.usage).toEqual({ input: 25, output: 42 })
    expect(deltas).toEqual([
      { thinkingContent: 'Plan carefully...' },
      { content: 'I will check the file.' }
    ])
  })

  it('gives a tool_use block without input deltas empty-object arguments', async () => {
    stubFetch(() =>
      streamResponse([
        messageStart(),
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'list', input: {} } },
        { type: 'content_block_stop', index: 0 },
        ...finish('tool_use')
      ])
    )
    const response = await new AnthropicAdapter().chat(request())
    expect(response.toolCalls?.[0].function.arguments).toBe('{}')
  })

  it('parses events split across arbitrary chunk boundaries and CRLF line endings', async () => {
    const events = [
      messageStart(),
      ...textBlock(0, 'héllo wörld'),
      ...finish('end_turn')
    ]
    const crlf = sseText(events).replace(/\n/g, '\r\n')
    const bytes = encoder.encode(crlf)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
      }
    })
    stubFetch(() => new Response(stream, { status: 200 }))
    const response = await new AnthropicAdapter().chat(request())
    expect(response.content).toBe('héllo wörld')
  })

  it('counts cache read and creation tokens as input', async () => {
    stubFetch(() =>
      streamResponse([
        messageStart({ input_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 40 }),
        ...textBlock(0, 'ok'),
        ...finish('end_turn', 7)
      ])
    )
    const response = await new AnthropicAdapter().chat(request())
    expect(response.usage).toEqual({ input: 550, output: 7 })
  })

  it.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['pause_turn', 'stop'],
    ['max_tokens', 'length']
  ])('maps stop_reason %s to finishReason %s', async (stopReason, expected) => {
    stubFetch(() => streamResponse([messageStart(), ...textBlock(0, 'x'), ...finish(stopReason)]))
    const response = await new AnthropicAdapter().chat(request())
    expect(response.finishReason).toBe(expected)
    expect(response.content).toBe('x')
  })

  it('reports a tool call cut off by max_tokens as length, keeping the call for the runner to answer', async () => {
    stubFetch(() =>
      streamResponse([
        messageStart(),
        ...toolBlock(0, 'call_cut', 'fs_write', '{"path":"a.txt","content":"half'),
        ...finish('max_tokens')
      ])
    )
    const response = await new AnthropicAdapter().chat(request({ tools: [fsReadTool] }))
    expect(response.finishReason).toBe('length')
    expect(response.toolCalls?.map((tc) => tc.id)).toEqual(['call_cut'])
  })

  describe('thinking signature round-trip', () => {
    it('captures thinking + signature and redacted_thinking into providerReplay', async () => {
      stubFetch(() =>
        streamResponse([
          messageStart(),
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'step ' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'one' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-XYZ' } },
          { type: 'content_block_stop', index: 0 },
          ...redactedBlock(1, 'ENCRYPTED-BLOB'),
          ...textBlock(2, 'text'),
          ...finish('end_turn')
        ])
      )
      const response = await new AnthropicAdapter().chat(request({ thinking: { enabled: true } }))
      expect(response.thinkingContent).toBe('step one')
      expect(response.providerReplay).toEqual({
        anthropic: {
          thinking: [
            { type: 'thinking', thinking: 'step one', signature: 'SIG-XYZ' },
            { type: 'redacted_thinking', data: 'ENCRYPTED-BLOB' }
          ]
        }
      })
    })

    it('keeps empty-text thinking blocks whose display was omitted (signature only)', async () => {
      stubFetch(() =>
        streamResponse([
          messageStart(),
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG-ONLY' } },
          { type: 'content_block_stop', index: 0 },
          ...textBlock(1, 'answer'),
          ...finish('end_turn')
        ])
      )
      const response = await new AnthropicAdapter().chat(request())
      expect(response.thinkingContent).toBeUndefined()
      expect(response.providerReplay).toEqual({
        anthropic: { thinking: [{ type: 'thinking', thinking: '', signature: 'SIG-ONLY' }] }
      })
    })

    it('drops thinking blocks that never received a signature and omits providerReplay when empty', async () => {
      stubFetch(() =>
        streamResponse([messageStart(), ...thinkingBlock(0, 'unsigned'), ...textBlock(1, 'a'), ...finish('end_turn')])
      )
      const response = await new AnthropicAdapter().chat(request())
      expect(response.providerReplay).toBeUndefined()
    })

    it('echoes the captured blocks, signature intact, before tool_use in the next request', async () => {
      const fetchFn = stubFetch(
        () =>
          streamResponse([
            messageStart(),
            ...thinkingBlock(0, 'I should read the file', 'SIG-ROUNDTRIP'),
            ...redactedBlock(1, 'REDACTED-DATA'),
            ...textBlock(2, 'Reading.'),
            ...toolBlock(3, 'call_9', 'fs_read', '{"path":"a.txt"}'),
            ...finish('tool_use')
          ]),
        () => streamResponse(simpleAnswer('Done.'))
      )
      const adapter = new AnthropicAdapter()
      const messages: ChatMessage[] = [{ role: 'user', content: 'read a.txt' }]

      const first = await adapter.chat(request({ messages: [...messages], tools: [fsReadTool], thinking: { enabled: true } }))
      // Exactly what the runner does with the response:
      messages.push({
        role: 'assistant',
        content: first.content.length > 0 ? first.content : null,
        tool_calls: first.toolCalls,
        ...(first.providerReplay ? { providerReplay: first.providerReplay } : {})
      })
      messages.push({ role: 'tool', tool_call_id: 'call_9', content: 'file body' })

      await adapter.chat(request({ messages, tools: [fsReadTool], thinking: { enabled: true } }))

      const sent = bodyOf(fetchFn, 1).messages
      expect(sent).toHaveLength(3)
      expect(sent[1].role).toBe('assistant')
      expect(sent[1].content).toEqual([
        { type: 'thinking', thinking: 'I should read the file', signature: 'SIG-ROUNDTRIP' },
        { type: 'redacted_thinking', data: 'REDACTED-DATA' },
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'call_9', name: 'fs_read', input: { path: 'a.txt' } }
      ])
      expect(sent[2]).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_9', content: 'file body' }]
      })
    })
  })

  describe('refusal', () => {
    it('surfaces a clear notice when the model refuses without producing text', async () => {
      stubFetch(() => streamResponse([messageStart(), ...finish('refusal', 0)]))
      const response = await new AnthropicAdapter().chat(request())
      expect(response.finishReason).toBe('stop')
      expect(response.content).toBe('[Claude declined this request]')
      expect(response.toolCalls).toBeUndefined()
    })

    it('keeps any text the model did produce and discards partial tool calls', async () => {
      stubFetch(() =>
        streamResponse([
          messageStart(),
          ...textBlock(0, 'I cannot help with that.'),
          ...toolBlock(1, 'c1', 'fs_read', '{"pa'),
          ...finish('refusal', 6)
        ])
      )
      const response = await new AnthropicAdapter().chat(request())
      expect(response.finishReason).toBe('stop')
      expect(response.content).toBe('I cannot help with that.')
      expect(response.toolCalls).toBeUndefined()
    })
  })

  describe('mid-stream failures', () => {
    it('throws on an error event after output has already been emitted, without retrying', async () => {
      const fetchFn = stubFetch(() =>
        streamResponse([
          messageStart(),
          ...textBlock(0, 'partial'),
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }
        ])
      )
      const deltas: ChatDelta[] = []
      await expect(
        new AnthropicAdapter({ retryBaseDelayMs: 0 }).chat(request(), (d) => deltas.push(d))
      ).rejects.toThrow(/stream error \(overloaded_error\): Overloaded/)
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(deltas).toEqual([{ content: 'partial' }])
    })

    it('retries a retryable error event that arrives before any delta was emitted', async () => {
      const fetchFn = stubFetch(
        () => streamResponse([messageStart(), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]),
        () => streamResponse(simpleAnswer('recovered'))
      )
      const deltas: ChatDelta[] = []
      const response = await new AnthropicAdapter({ retryBaseDelayMs: 0 }).chat(request(), (d) => deltas.push(d))
      expect(response.content).toBe('recovered')
      expect(fetchFn).toHaveBeenCalledTimes(2)
      expect(deltas).toEqual([{ content: 'recovered' }])
    })

    it('does not retry a non-retryable error event', async () => {
      const fetchFn = stubFetch(() =>
        streamResponse([messageStart(), { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }])
      )
      await expect(new AnthropicAdapter({ retryBaseDelayMs: 0 }).chat(request())).rejects.toThrow(/invalid_request_error/)
      expect(fetchFn).toHaveBeenCalledTimes(1)
    })

    it('rejects a stream that ends before the message completed instead of returning a truncated turn', async () => {
      stubFetch(() => streamResponse([messageStart(), ...textBlock(0, 'cut off')]))
      await expect(new AnthropicAdapter({ retryBaseDelayMs: 0 }).chat(request())).rejects.toThrow(
        /ended before the message completed/
      )
    })

    it('aborts a stalled stream after the idle timeout and cancels the body', async () => {
      const onCancel = vi.fn()
      stubFetch(() => stalledResponse([messageStart()], onCancel))
      await expect(new AnthropicAdapter({ idleTimeoutMs: 40 }).chat(request())).rejects.toThrow(/stopped responding/)
      expect(onCancel).toHaveBeenCalled()
    })

    it('rejects with "Request aborted." when the caller aborts mid-stream', async () => {
      const controller = new AbortController()
      const onCancel = vi.fn()
      stubFetch(() => stalledResponse([messageStart(), ...textBlock(0, 'streaming')], onCancel))
      const result = new AnthropicAdapter().chat(request({ signal: controller.signal }), () => controller.abort())
      await expect(result).rejects.toThrow('Request aborted.')
      expect(onCancel).toHaveBeenCalled()
    })

    it('adapter.abort(runId) aborts the in-flight request by run id prefix', async () => {
      stubFetch(() => stalledResponse([messageStart()]))
      const adapter = new AnthropicAdapter()
      const result = adapter.chat(request({ requestId: 'run-77-turn-3' }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      adapter.abort('run-77')
      await expect(result).rejects.toThrow('Request aborted.')
    })
  })
})

describe('AnthropicAdapter HTTP errors and retry', () => {
  it.each([
    [529, 'overloaded_error'],
    [500, 'api_error'],
    [503, 'api_error']
  ])('retries HTTP %i and then succeeds', async (status, type) => {
    const fetchFn = stubFetch(
      () => errorResponse(status, type, 'try later'),
      () => streamResponse(simpleAnswer('after retry'))
    )
    const response = await new AnthropicAdapter({ retryBaseDelayMs: 0 }).chat(request())
    expect(response.content).toBe('after retry')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('honours retry-after on 429 and retries', async () => {
    const fetchFn = stubFetch(
      () => errorResponse(429, 'rate_limit_error', 'slow down', { 'retry-after': '0' }),
      () => streamResponse(simpleAnswer('ok'))
    )
    const response = await new AnthropicAdapter({ retryBaseDelayMs: 60_000 }).chat(request())
    expect(response.content).toBe('ok')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('retries at most twice, then surfaces the error', async () => {
    const fetchFn = stubFetch(() => errorResponse(529, 'overloaded_error', 'Overloaded'))
    await expect(new AnthropicAdapter({ retryBaseDelayMs: 0 }).chat(request())).rejects.toThrow(
      /529.*overloaded_error: Overloaded/
    )
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('does not retry when retry-after is longer than the wait cap', async () => {
    const fetchFn = stubFetch(() => errorResponse(429, 'rate_limit_error', 'slow down', { 'retry-after': '120' }))
    await expect(new AnthropicAdapter({ retryBaseDelayMs: 0 }).chat(request())).rejects.toThrow(/429/)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'not_found_error']
  ])('does not retry HTTP %i', async (status, type) => {
    const fetchFn = stubFetch(() => errorResponse(status, type, 'nope'))
    await expect(new AnthropicAdapter({ retryBaseDelayMs: 0 }).chat(request())).rejects.toThrow(
      new RegExp(`${status}.*${type}: nope`)
    )
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('does not retry when the request was aborted while the failing response arrived', async () => {
    const controller = new AbortController()
    const fetchFn = stubFetch(
      () => {
        controller.abort()
        return errorResponse(529, 'overloaded_error', 'Overloaded')
      },
      () => streamResponse(simpleAnswer())
    )
    await expect(
      new AnthropicAdapter({ retryBaseDelayMs: 0 }).chat(request({ signal: controller.signal }))
    ).rejects.toThrow('Request aborted.')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('stops waiting immediately when aborted during the retry backoff', async () => {
    const controller = new AbortController()
    const fetchFn = stubFetch(
      () => errorResponse(529, 'overloaded_error', 'Overloaded'),
      () => streamResponse(simpleAnswer())
    )
    const started = Date.now()
    const result = new AnthropicAdapter({ retryBaseDelayMs: 60_000 }).chat(request({ signal: controller.signal }))
    setTimeout(() => controller.abort(), 30)
    await expect(result).rejects.toThrow('Request aborted.')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('sends no request at all when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await expect(new AnthropicAdapter().chat(request({ signal: controller.signal }))).rejects.toThrow('Request aborted.')
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('redacts the API key from error messages', async () => {
    stubFetch(() => errorResponse(400, 'invalid_request_error', `bad credentials ${TEST_KEY} supplied`))
    const promise = new AnthropicAdapter().chat(request())
    await expect(promise).rejects.toThrow('[redacted]')
    await promise.catch((error: Error) => {
      expect(error.message).not.toContain(TEST_KEY)
    })
  })

  it('redacts the API key from network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError(`connect failed for https://x/?key=${TEST_KEY} and ${TEST_KEY}`)
    }))
    const promise = new AnthropicAdapter().chat(request())
    await expect(promise).rejects.toThrow(/Unable to reach Anthropic/)
    await promise.catch((error: Error) => {
      expect(error.message).not.toContain(TEST_KEY)
    })
  })
})
