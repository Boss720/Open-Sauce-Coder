import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadByokEnv } from '../keys'
import {
  OpenAiAdapter,
  isOpenAiReasoningModel,
  sanitizeOpenAiMessages
} from '../harness/providers/openai'
import type { ChatDelta, ChatMessage, ChatRequest } from '../harness/providers/adapter'

const TEST_KEY = 'sk-openai-test-key-0001'

vi.mock('../keys', () => ({
  loadByokEnv: vi.fn(() => ({ OPENAI_API_KEY: 'sk-openai-test-key-0001' }))
}))

const encoder = new TextEncoder()

type Chunk = Record<string, unknown>

function sseText(chunks: Chunk[], done = true): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
}

function bytesResponse(text: string, chunkSize?: number): Response {
  const bytes = encoder.encode(text)
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

function streamResponse(chunks: Chunk[], done = true): Response {
  return bytesResponse(sseText(chunks, done))
}

function stalledResponse(text: string, onCancel?: () => void): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
    },
    cancel() {
      onCancel?.()
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const delta = (d: Record<string, unknown>, finishReason: string | null = null, id = 'chatcmpl-1'): Chunk => ({
  id,
  choices: [{ index: 0, delta: d, finish_reason: finishReason }]
})

const simpleAnswer = (text = 'ok'): Chunk[] => [
  delta({ role: 'assistant', content: text }),
  delta({}, 'stop'),
  { id: 'chatcmpl-1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }
]

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

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
  stream: boolean
  stream_options?: { include_usage?: boolean }
  messages: Array<Record<string, unknown>>
  tools?: unknown
  temperature?: number
  top_p?: number
  max_tokens?: number
  max_completion_tokens?: number
  reasoning_effort?: string
}

function bodyOf(fn: ReturnType<typeof stubFetch>, call = 0): SentBody {
  return JSON.parse(String(fn.mock.calls[call][1]?.body)) as SentBody
}

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    requestId: 'run-1-turn-1',
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.mocked(loadByokEnv).mockClear()
})

describe('isOpenAiReasoningModel', () => {
  it.each(['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.1', 'gpt-5-codex', 'gpt-5.5', 'gpt-6-sol', 'gpt-6.1-sol-pro', 'openai/gpt-5', 'openai/o3-mini'])(
    '%s is a reasoning model',
    (model) => {
      expect(isOpenAiReasoningModel(model)).toBe(true)
    }
  )

  it.each(['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4-turbo', 'gpt-3.5-turbo', 'gpt-5-chat-latest', 'gpt-5.2-chat', 'gpt-chat-latest'])(
    '%s is a standard model',
    (model) => {
      expect(isOpenAiReasoningModel(model)).toBe(false)
    }
  )
})

describe('OpenAiAdapter request body', () => {
  it('requests streamed usage', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new OpenAiAdapter().chat(request())
    const body = bodyOf(fetchFn)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it.each(['o1', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini'])(
    'adapts parameters for reasoning model %s',
    async (model) => {
      const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
      await new OpenAiAdapter().chat(
        request({
          model,
          maxTokens: 5000,
          temperature: 0.7,
          topP: 0.9,
          thinking: { enabled: true },
          messages: [
            { role: 'system', content: 'Guidelines.' },
            { role: 'user', content: 'Solve.' }
          ]
        })
      )
      const body = bodyOf(fetchFn)
      expect(body.max_completion_tokens).toBe(5000)
      expect('max_tokens' in body).toBe(false)
      expect('temperature' in body).toBe(false)
      expect('top_p' in body).toBe(false)
      expect(body.reasoning_effort).toBe('medium')
      expect(body.messages[0].role).toBe('developer')
    }
  )

  it('omits reasoning_effort when thinking is not requested, and for models that predate it', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()), () => streamResponse(simpleAnswer()))
    const adapter = new OpenAiAdapter()
    await adapter.chat(request({ model: 'gpt-5', thinking: { enabled: false } }))
    await adapter.chat(request({ model: 'o1-mini', thinking: { enabled: true } }))
    expect('reasoning_effort' in bodyOf(fetchFn, 0)).toBe(false)
    expect('reasoning_effort' in bodyOf(fetchFn, 1)).toBe(false)
  })

  it('keeps max_tokens, temperature and top_p for standard models', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new OpenAiAdapter().chat(
      request({
        model: 'gpt-4o',
        maxTokens: 2048,
        temperature: 0.5,
        topP: 0.8,
        thinking: { enabled: true },
        messages: [
          { role: 'system', content: 'Guidelines.' },
          { role: 'user', content: 'Hi' }
        ]
      })
    )
    const body = bodyOf(fetchFn)
    expect(body.max_tokens).toBe(2048)
    expect(body.temperature).toBe(0.5)
    expect(body.top_p).toBe(0.8)
    expect('max_completion_tokens' in body).toBe(false)
    expect('reasoning_effort' in body).toBe(false)
    expect(body.messages[0].role).toBe('system')
  })

  it('passes tools through and honours a baseUrl override without a double slash', async () => {
    const tools = [
      { type: 'function' as const, function: { name: 'fs_read', description: 'read', parameters: { type: 'object' } } }
    ]
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await new OpenAiAdapter().chat(request({ tools, baseUrl: 'http://localhost:1234/v1/' }))
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:1234/v1/chat/completions')
    expect(bodyOf(fetchFn).tools).toEqual(tools)
    const headers = fetchFn.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`)
  })

  it('resolves the API key per request', async () => {
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()), () => streamResponse(simpleAnswer()))
    const adapter = new OpenAiAdapter()
    vi.mocked(loadByokEnv).mockReturnValueOnce({ OPENAI_API_KEY: 'sk-openai-rotated' })
    await adapter.chat(request())
    await adapter.chat(request())
    expect((fetchFn.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer sk-openai-rotated')
    expect((fetchFn.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_KEY}`)
  })
})

describe('sanitizeOpenAiMessages', () => {
  const toolCall = { id: 'call_1', type: 'function' as const, function: { name: 'fs_read', arguments: '{"path":"a"}' } }

  it('sends content: null (never an empty string) for tool-calling assistant messages without text', () => {
    const out = sanitizeOpenAiMessages([
      { role: 'assistant', content: '', tool_calls: [toolCall] },
      { role: 'assistant', content: null, tool_calls: [toolCall] }
    ])
    for (const message of out) {
      expect(message.content).toBeNull()
      expect(message.tool_calls).toEqual([toolCall])
    }
    // Survives JSON serialisation as an explicit null, not a missing or empty-string field.
    expect(JSON.parse(JSON.stringify(out[0])).content).toBeNull()
  })

  it('keeps assistant text alongside tool calls', () => {
    const [message] = sanitizeOpenAiMessages([{ role: 'assistant', content: 'Reading it.', tool_calls: [toolCall] }])
    expect(message.content).toBe('Reading it.')
  })

  it('drops assistant messages that have neither text nor tool calls', () => {
    const out = sanitizeOpenAiMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: null },
      { role: 'assistant', content: 'real' }
    ])
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'real' }
    ])
  })

  it('does not leak non-OpenAI fields such as providerReplay', () => {
    const [message] = sanitizeOpenAiMessages([
      { role: 'assistant', content: null, tool_calls: [toolCall], providerReplay: { anthropic: { thinking: [] } } }
    ])
    expect(Object.keys(message).sort()).toEqual(['content', 'role', 'tool_calls'])
  })

  it('flattens tool message content to text and keeps tool_call_id', () => {
    const out = sanitizeOpenAiMessages([
      { role: 'tool', tool_call_id: 'call_1', content: 'plain' },
      { role: 'tool', tool_call_id: 'call_2', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'tool', tool_call_id: 'call_3', content: null }
    ] as ChatMessage[])
    expect(out).toEqual([
      { role: 'tool', content: 'plain', tool_call_id: 'call_1' },
      { role: 'tool', content: 'a\nb', tool_call_id: 'call_2' },
      { role: 'tool', content: '', tool_call_id: 'call_3' }
    ])
  })

  it('maps system to developer only for reasoning models', () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'rules' }]
    expect(sanitizeOpenAiMessages(messages, true)[0].role).toBe('developer')
    expect(sanitizeOpenAiMessages(messages, false)[0].role).toBe('system')
  })
})

describe('OpenAiAdapter streaming', () => {
  it('accumulates interleaved tool-call deltas by index', async () => {
    stubFetch(() =>
      streamResponse([
        delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'fs_read', arguments: '' } }] }),
        delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'fs_list', arguments: '' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
        delta({ tool_calls: [{ index: 1, function: { arguments: '{"dir":"."}' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
        delta({}, 'tool_calls')
      ])
    )
    const response = await new OpenAiAdapter().chat(request())
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.txt"}' } },
      { id: 'call_b', type: 'function', function: { name: 'fs_list', arguments: '{"dir":"."}' } }
    ])
  })

  it('defaults empty arguments to {} and synthesises a missing id', async () => {
    stubFetch(() =>
      streamResponse([delta({ tool_calls: [{ index: 0, function: { name: 'now' } }] }), delta({}, 'tool_calls')])
    )
    const response = await new OpenAiAdapter().chat(request())
    expect(response.toolCalls).toEqual([
      { id: 'call_0', type: 'function', function: { name: 'now', arguments: '{}' } }
    ])
  })

  it('reads usage from the trailing chunk with empty choices, including reasoning tokens', async () => {
    stubFetch(() =>
      streamResponse([
        delta({ content: 'Answer' }),
        delta({}, 'stop'),
        {
          id: 'chatcmpl-1',
          choices: [],
          usage: { prompt_tokens: 15, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } }
        }
      ])
    )
    const response = await new OpenAiAdapter().chat(request({ model: 'o3-mini' }))
    expect(response.content).toBe('Answer')
    expect(response.usage).toEqual({ input: 15, output: 20, reasoning: 12 })
  })

  it('emits text and reasoning deltas and maps finish reasons', async () => {
    stubFetch(() =>
      streamResponse([
        delta({ reasoning_content: 'thinking...' }),
        delta({ content: 'part one ' }),
        delta({ content: 'part two' }),
        delta({}, 'length')
      ])
    )
    const deltas: ChatDelta[] = []
    const response = await new OpenAiAdapter().chat(request(), (d) => deltas.push(d))
    expect(deltas).toEqual([
      { thinkingContent: 'thinking...' },
      { content: 'part one ' },
      { content: 'part two' }
    ])
    expect(response.content).toBe('part one part two')
    expect(response.thinkingContent).toBe('thinking...')
    expect(response.finishReason).toBe('length')
  })

  it('processes a final data line that has no trailing newline and handles split chunks', async () => {
    const full = sseText([delta({ content: 'héllo' }), delta({}, 'stop')], false) + 'data: [DONE]'
    stubFetch(() => bytesResponse(full, 5))
    const response = await new OpenAiAdapter().chat(request())
    expect(response.content).toBe('héllo')

    const noTrailing = `data: ${JSON.stringify(delta({ content: 'tail' }))}`
    stubFetch(() => bytesResponse(noTrailing))
    const tail = await new OpenAiAdapter().chat(request())
    expect(tail.content).toBe('tail')
  })

  it('surfaces a refusal when no text was produced', async () => {
    stubFetch(() =>
      streamResponse([delta({ refusal: "I can't " }), delta({ refusal: 'help with that.' }), delta({}, 'stop')])
    )
    const response = await new OpenAiAdapter().chat(request())
    expect(response.content).toBe("I can't help with that.")
    expect(response.finishReason).toBe('stop')
  })

  it('surfaces a content-filter finish with a clear notice', async () => {
    stubFetch(() => streamResponse([delta({}, 'content_filter')]))
    const response = await new OpenAiAdapter().chat(request())
    expect(response.content).toMatch(/content filter/)
    expect(response.finishReason).toBe('stop')
  })

  it('throws on an in-stream error object', async () => {
    stubFetch(() => streamResponse([delta({ content: 'x' }), { error: { message: 'The server had an error', type: 'server_error' } }]))
    await expect(new OpenAiAdapter().chat(request())).rejects.toThrow(/stream error: The server had an error/)
  })

  it('does not abort a healthy stream that outlives the idle timeout', async () => {
    // A total-request timeout (the old behaviour) would kill this; only inactivity may.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let i = 0; i < 6; i++) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(delta({ content: `${i}` }))}\n\n`))
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        controller.enqueue(encoder.encode(sseText([delta({}, 'stop')])))
        controller.close()
      }
    })
    stubFetch(() => new Response(stream, { status: 200 }))
    const response = await new OpenAiAdapter({ idleTimeoutMs: 100 }).chat(request())
    expect(response.content).toBe('012345')
  })

  it('aborts a stalled stream after the idle timeout and cancels the body', async () => {
    const onCancel = vi.fn()
    stubFetch(() => stalledResponse(`data: ${JSON.stringify(delta({ content: 'x' }))}\n\n`, onCancel))
    await expect(new OpenAiAdapter({ idleTimeoutMs: 40 }).chat(request())).rejects.toThrow(/stopped responding/)
    expect(onCancel).toHaveBeenCalled()
  })

  it('rejects with "Request aborted." when the caller aborts mid-stream', async () => {
    const controller = new AbortController()
    const onCancel = vi.fn()
    stubFetch(() => stalledResponse(`data: ${JSON.stringify(delta({ content: 'x' }))}\n\n`, onCancel))
    const result = new OpenAiAdapter().chat(request({ signal: controller.signal }), () => controller.abort())
    await expect(result).rejects.toThrow('Request aborted.')
    expect(onCancel).toHaveBeenCalled()
  })

  it('sends no request when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchFn = stubFetch(() => streamResponse(simpleAnswer()))
    await expect(new OpenAiAdapter().chat(request({ signal: controller.signal }))).rejects.toThrow('Request aborted.')
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('OpenAiAdapter errors', () => {
  it('reports the HTTP status with the parsed API error', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }), {
          status: 401,
          statusText: 'Unauthorized'
        })
    )
    await expect(new OpenAiAdapter().chat(request())).rejects.toThrow(
      /OpenAI harness request failed: 401 Unauthorized — invalid_api_key: Incorrect API key provided/
    )
  })

  it('redacts the API key from HTTP error details', async () => {
    stubFetch(
      () => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${TEST_KEY}` } }), { status: 401 })
    )
    const promise = new OpenAiAdapter().chat(request())
    await expect(promise).rejects.toThrow('[redacted]')
    await promise.catch((error: Error) => {
      expect(error.message).not.toContain(TEST_KEY)
    })
  })

  it('redacts the API key from network errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError(`connect failed for https://x/?api_key=${TEST_KEY} ${TEST_KEY}`)
    }))
    const promise = new OpenAiAdapter().chat(request())
    await expect(promise).rejects.toThrow(/Unable to reach OpenAI/)
    await promise.catch((error: Error) => {
      expect(error.message).not.toContain(TEST_KEY)
    })
  })
})
