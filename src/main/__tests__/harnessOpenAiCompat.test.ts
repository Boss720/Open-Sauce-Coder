import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  OpenAiCompatibleAdapter,
  OPENAI_COMPATIBLE_CONFIGS,
  buildEndpointUrl,
  createIdleGuard,
  isLoopbackUrl,
  sanitizeMessages
} from '../harness/providers/openaiCompatible'
import { NanoGptAdapter } from '../harness/providers/nanogpt'
import { ThinkTagStreamer, extractThinkTags } from '../harness/providers/thinkTagStreamer'
import { loadByokEnv } from '../keys'
import type { ChatDelta, ChatMessage, ChatRequest } from '../harness/providers/adapter'

const { DEFAULT_ENV } = vi.hoisted(() => ({
  DEFAULT_ENV: {
    NANOGPT_API_KEY: 'nano-mock-key-1111',
    GROQ_API_KEY: 'gsk-mock-key-1234',
    DEEPSEEK_API_KEY: 'sk-deepseek-mock-key-7890',
    MOONSHOT_API_KEY: 'sk-moonshot-mock-key-4321',
    OPENROUTER_API_KEY: 'sk-or-mock-key-5555'
  } as Record<string, string>
}))

vi.mock('../keys', () => ({
  loadByokEnv: vi.fn(() => DEFAULT_ENV)
}))

// ── helpers ──

const encoder = new TextEncoder()

/** An SSE response made of exactly the given raw pieces (so tests control read boundaries). */
function rawSse(pieces: string[], contentType = 'text/event-stream'): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    }
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': contentType } })
}

function sse(chunks: Array<Record<string, unknown> | '[DONE]'>): Response {
  return rawSse(chunks.map((c) => (c === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(c)}\n\n`)))
}

function delta(payload: Record<string, unknown>, finish: string | null = null): Record<string, unknown> {
  return { id: 'cmpl-1', choices: [{ index: 0, delta: payload, finish_reason: finish }] }
}

type Captured = {
  url: string
  init: RequestInit
  body: { messages: Array<Record<string, unknown>> } & Record<string, unknown>
}

/** Stub fetch with a sequence of responders; records every call. */
function stubFetch(...responders: Array<() => Response | Promise<Response>>): Captured[] {
  const calls: Captured[] = []
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(String(init.body)) : {} })
    const responder = responders[Math.min(n, responders.length - 1)]
    n++
    return responder()
  }))
  return calls
}

function adapterFor(providerId: keyof typeof OPENAI_COMPATIBLE_CONFIGS): OpenAiCompatibleAdapter {
  return new OpenAiCompatibleAdapter(OPENAI_COMPATIBLE_CONFIGS[providerId])
}

function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    requestId: 'run-turn-0',
    model: 'some-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides
  }
}

function headerOf(call: Captured, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name]
}

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the promise to reject')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.mocked(loadByokEnv).mockReset()
  vi.mocked(loadByokEnv).mockReturnValue(DEFAULT_ENV)
})

// ── message conversion ──

describe('assistant tool-call messages', () => {
  const toolCall = { id: 'call_1', type: 'function' as const, function: { name: 'grep', arguments: '{}' } }

  it('sanitizeMessages sends content:null for a tool-call turn without text, text when present, and never null otherwise', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: null },
      { role: 'assistant', content: null, tool_calls: [toolCall] },
      { role: 'assistant', content: '', tool_calls: [toolCall] },
      { role: 'assistant', content: 'Looking.', tool_calls: [toolCall] },
      { role: 'assistant', content: null },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' }
    ]
    const out = sanitizeMessages(messages)
    expect(out[0]).toEqual({ role: 'system', content: '' })
    expect(out[1]).toEqual({ role: 'assistant', content: null, tool_calls: [toolCall] })
    expect(out[2].content).toBeNull()
    expect(out[3].content).toBe('Looking.')
    expect(out[4]).toEqual({ role: 'assistant', content: '' })
    expect(out[5]).toEqual({ role: 'tool', content: 'result', tool_call_id: 'call_1' })
  })

  it('the request body for a compatible provider carries content:null on the wire', async () => {
    const calls = stubFetch(() => sse([delta({ content: 'ok' }, 'stop'), '[DONE]']))
    await adapterFor('groq').chat(req({
      messages: [
        { role: 'user', content: 'find' },
        { role: 'assistant', content: null, tool_calls: [toolCall] },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' }
      ]
    }))
    const wire = calls[0].body.messages
    expect(wire[1]).toEqual({ role: 'assistant', content: null, tool_calls: [toolCall] })
    expect(calls[0].init.body).toContain('"content":null')
  })

  it('NanoGPT sends content:null as well', async () => {
    const calls = stubFetch(() => sse([delta({ content: 'ok' }, 'stop'), '[DONE]']))
    await new NanoGptAdapter().chat(
      req({
        messages: [
          { role: 'user', content: 'find' },
          { role: 'assistant', content: null, tool_calls: [toolCall] },
          { role: 'tool', tool_call_id: 'call_1', content: 'found' }
        ]
      }),
      () => undefined
    )
    expect(calls[0].body.messages[1].content).toBeNull()
  })
})

// ── think tags ──

describe('ThinkTagStreamer', () => {
  function run(pieces: string[]): { text: string; thinking: string; deltas: ChatDelta[] } {
    const streamer = new ThinkTagStreamer()
    const deltas: ChatDelta[] = []
    let text = ''
    let thinking = ''
    for (const piece of pieces) {
      const out = streamer.process(piece, (d) => deltas.push(d))
      text += out.text
      thinking += out.thinking
    }
    const tail = streamer.flush((d) => deltas.push(d))
    return { text: text + tail.text, thinking: thinking + tail.thinking, deltas }
  }

  it('handles an opening tag split at every possible position', () => {
    const full = '<think>plan</think>answer'
    for (let cut = 1; cut < '<think>'.length; cut++) {
      const result = run([full.slice(0, cut), full.slice(cut)])
      expect(result.thinking, `cut at ${cut}`).toBe('plan')
      expect(result.text, `cut at ${cut}`).toBe('answer')
    }
  })

  it('handles a closing tag split at every possible position', () => {
    const open = '<think>plan'
    const close = '</think>answer'
    for (let cut = 1; cut < '</think>'.length; cut++) {
      const result = run([open, close.slice(0, cut), close.slice(cut)])
      expect(result.thinking, `cut at ${cut}`).toBe('plan')
      expect(result.text, `cut at ${cut}`).toBe('answer')
    }
  })

  it('handles a tag delivered one character at a time', () => {
    const result = run([...'<think>why</think>because'])
    expect(result.thinking).toBe('why')
    expect(result.text).toBe('because')
  })

  it('splits "<thi" + "nk>" exactly as the spec example', () => {
    const result = run(['<thi', 'nk>deep', ' thought</think>', 'done'])
    expect(result.thinking).toBe('deep thought')
    expect(result.text).toBe('done')
  })

  it('does not hold back or swallow lookalike text', () => {
    const result = run(['x < y and <table>', ' <t', 'ip>'])
    expect(result.text).toBe('x < y and <table> <tip>')
    expect(result.thinking).toBe('')
  })

  it('flushes an unterminated think block as thinking, not as answer text', () => {
    const result = run(['<think>never closed', ' still thinking'])
    expect(result.thinking).toBe('never closed still thinking')
    expect(result.text).toBe('')
  })

  it('flushes a dangling partial closing tag inside an unterminated block as thinking', () => {
    const result = run(['<think>cut off</thi'])
    expect(result.thinking).toBe('cut off</thi')
    expect(result.text).toBe('')
  })

  it('flushes a dangling partial opening tag as plain text', () => {
    const result = run(['value <thi'])
    expect(result.text).toBe('value <thi')
  })

  it('supports several think blocks, any letter case, and drops whitespace after a closing tag', () => {
    const result = run(['<THINK>a</Think>\n\nfirst ', '<think>b</think> second'])
    expect(result.thinking).toBe('ab')
    expect(result.text).toBe('first second')
  })

  it('streams text and thinking as deltas in order', () => {
    const result = run(['pre <think>mid</think> post'])
    expect(result.deltas).toEqual([
      { content: 'pre ' },
      { thinkingContent: 'mid' },
      { content: 'post' }
    ])
  })

  it('extractThinkTags handles multiple, unterminated and bare-closing cases', () => {
    expect(extractThinkTags('no tags')).toEqual({ text: 'no tags' })
    expect(extractThinkTags('<think>a</think>x<think>b</think>y')).toEqual({ text: 'xy', thinking: 'a\nb' })
    expect(extractThinkTags('answer<think>cut off')).toEqual({ text: 'answer', thinking: 'cut off' })
    expect(extractThinkTags('reasoning here</think>final')).toEqual({ text: 'final', thinking: 'reasoning here' })
    expect(extractThinkTags('<think></think>just text')).toEqual({ text: 'just text' })
  })
})

describe('think tags through the adapters', () => {
  it('separates a <think> block split across SSE chunks and across network reads', async () => {
    stubFetch(() => rawSse([
      'data: ' + JSON.stringify(delta({ content: '<thi' })) + '\n\n',
      'data: ' + JSON.stringify(delta({ content: 'nk>working' })).slice(0, 30),
      JSON.stringify(delta({ content: 'nk>working' })).slice(30) + '\n\n',
      'data: ' + JSON.stringify(delta({ content: ' it out</th' })) + '\n\n',
      'data: ' + JSON.stringify(delta({ content: 'ink>The answer.' }, 'stop')) + '\n\n',
      'data: [DONE]\n\n'
    ]))
    const deltas: ChatDelta[] = []
    const response = await adapterFor('groq').chat(req(), (d) => deltas.push(d))
    expect(response.content).toBe('The answer.')
    expect(response.thinkingContent).toBe('working it out')
    expect(deltas.some((d) => d.content?.includes('<'))).toBe(false)
  })

  it('flushes an unterminated think block at end of stream as thinking', async () => {
    stubFetch(() => sse([delta({ content: '<think>trailing thoughts' }, 'length'), '[DONE]']))
    const response = await adapterFor('groq').chat(req())
    expect(response.content).toBe('')
    expect(response.thinkingContent).toBe('trailing thoughts')
    expect(response.finishReason).toBe('length')
  })

  it('NanoGPT streaming splits tags the same way', async () => {
    stubFetch(() => sse([
      delta({ content: '<think' }),
      delta({ content: '>nano thoughts</think' }),
      delta({ content: '>nano answer' }, 'stop'),
      '[DONE]'
    ]))
    const response = await new NanoGptAdapter().chat(req(), () => undefined)
    expect(response.thinkingContent).toBe('nano thoughts')
    expect(response.content).toBe('nano answer')
  })
})

// ── reasoning ──

describe('reasoning deltas', () => {
  it('captures delta.reasoning_content (DeepSeek / Moonshot style)', async () => {
    stubFetch(() => sse([
      delta({ reasoning_content: 'Step one. ' }),
      delta({ reasoning_content: 'Step two.' }),
      delta({ content: 'Result.' }, 'stop'),
      '[DONE]'
    ]))
    const deltas: ChatDelta[] = []
    const response = await adapterFor('deepseek').chat(req(), (d) => deltas.push(d))
    expect(response.thinkingContent).toBe('Step one. Step two.')
    expect(response.content).toBe('Result.')
    expect(deltas.filter((d) => d.thinkingContent).map((d) => d.thinkingContent)).toEqual(['Step one. ', 'Step two.'])
  })

  it('captures delta.reasoning (OpenRouter / Groq style)', async () => {
    stubFetch(() => sse([
      delta({ reasoning: 'Considering.' }),
      delta({ content: 'Done.' }, 'stop'),
      '[DONE]'
    ]))
    const response = await adapterFor('openrouter').chat(req())
    expect(response.thinkingContent).toBe('Considering.')
    expect(response.content).toBe('Done.')
  })

  it('does not double-count a server that sends both reasoning fields', async () => {
    stubFetch(() => sse([
      delta({ reasoning_content: 'Once.', reasoning: 'Once.' }),
      delta({ content: 'x' }, 'stop'),
      '[DONE]'
    ]))
    const response = await adapterFor('openrouter').chat(req())
    expect(response.thinkingContent).toBe('Once.')
  })

  it('reads reasoning from a non-streaming JSON answer, merged with think tags', async () => {
    stubFetch(() => new Response(JSON.stringify({
      id: 'j1',
      choices: [{ message: { content: '<think>inline</think>Answer', reasoning_content: 'field' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 3 } }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const response = await adapterFor('groq').chat(req())
    expect(response.content).toBe('Answer')
    expect(response.thinkingContent).toBe('field\ninline')
    expect(response.usage).toEqual({ input: 4, output: 6, reasoning: 3 })
  })

  it('echoes captured reasoning back as reasoning_content for DeepSeek and Moonshot only', async () => {
    const toolCall = { id: 'call_1', type: 'function' as const, function: { name: 'grep', arguments: '{}' } }
    const history: ChatMessage[] = [
      { role: 'user', content: 'find' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall],
        providerReplay: { openaiCompat: { reasoningContent: 'I should grep.' } }
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'found' }
    ]

    for (const provider of ['deepseek', 'moonshot'] as const) {
      const calls = stubFetch(() => sse([delta({ content: 'ok' }, 'stop'), '[DONE]']))
      await adapterFor(provider).chat(req({ messages: history }))
      expect(calls[0].body.messages[1].reasoning_content, provider).toBe('I should grep.')
      expect(calls[0].body.messages[1].content, provider).toBeNull()
    }

    for (const provider of ['groq', 'mistral', 'openrouter', 'custom'] as const) {
      const calls = stubFetch(() => sse([delta({ content: 'ok' }, 'stop'), '[DONE]']))
      vi.mocked(loadByokEnv).mockReturnValueOnce({ MISTRAL_API_KEY: 'k', GROQ_API_KEY: 'k', OPENROUTER_API_KEY: 'k' })
      await adapterFor(provider).chat(req({ messages: history }))
      expect('reasoning_content' in calls[0].body.messages[1], provider).toBe(false)
    }
  })

  it('stores the reasoning to echo in providerReplay only for providers that need it', async () => {
    stubFetch(() => sse([delta({ reasoning_content: 'because' }), delta({ content: 'x' }, 'stop'), '[DONE]']))
    const deepseek = await adapterFor('deepseek').chat(req())
    expect(deepseek.providerReplay).toEqual({ openaiCompat: { reasoningContent: 'because' } })

    stubFetch(() => sse([delta({ reasoning_content: 'because' }), delta({ content: 'x' }, 'stop'), '[DONE]']))
    const groq = await adapterFor('groq').chat(req())
    expect(groq.providerReplay).toBeUndefined()
  })
})

// ── base URL + keys ──

describe('baseUrl handling', () => {
  it('buildEndpointUrl joins exactly once', () => {
    expect(buildEndpointUrl('http://localhost:11434/v1', '/chat/completions')).toBe('http://localhost:11434/v1/chat/completions')
    expect(buildEndpointUrl('http://localhost:11434/v1/', '/chat/completions')).toBe('http://localhost:11434/v1/chat/completions')
    expect(buildEndpointUrl('http://localhost:1234/v1///', '/chat/completions')).toBe('http://localhost:1234/v1/chat/completions')
    expect(buildEndpointUrl('https://api.deepseek.com', '/chat/completions')).toBe('https://api.deepseek.com/chat/completions')
    expect(buildEndpointUrl('http://h:8000/v1/chat/completions', '/chat/completions')).toBe('http://h:8000/v1/chat/completions')
    expect(buildEndpointUrl('http://h:8000/v1/chat/completions/', 'chat/completions')).toBe('http://h:8000/v1/chat/completions')
    expect(buildEndpointUrl('https://gw.example/v1?api-version=2', '/chat/completions')).toBe('https://gw.example/v1/chat/completions?api-version=2')
  })

  it('rejects non-http(s) and malformed base URLs without echoing them', () => {
    expect(() => buildEndpointUrl('ftp://host/v1', '/chat/completions')).toThrow(/http/)
    let message = ''
    try {
      buildEndpointUrl('not a url?key=SECRETVALUE', '/chat/completions')
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/Invalid base URL/)
    expect(message).not.toContain('SECRETVALUE')
  })

  it('isLoopbackUrl recognises local servers only', () => {
    for (const url of ['http://localhost:11434/v1', 'http://127.0.0.1:1234', 'http://127.1.2.3/v1', 'http://[::1]:8080/v1', 'http://ollama.localhost/v1']) {
      expect(isLoopbackUrl(url), url).toBe(true)
    }
    for (const url of ['https://api.groq.com/openai/v1', 'http://192.168.1.10:11434/v1', 'http://localhost.evil.com/v1', 'http://example.com']) {
      expect(isLoopbackUrl(url), url).toBe(false)
    }
  })

  it('honours a custom baseUrl with a trailing slash and appends /chat/completions once', async () => {
    const calls = stubFetch(() => sse([delta({ content: 'hi' }, 'stop'), '[DONE]']))
    await adapterFor('custom').chat(req({ baseUrl: 'http://127.0.0.1:1234/v1/' }))
    await adapterFor('custom').chat(req({ baseUrl: 'http://127.0.0.1:1234/v1/chat/completions' }))
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:1234/v1/chat/completions',
      'http://127.0.0.1:1234/v1/chat/completions'
    ])
  })

  it('falls back to the provider default when the override is empty or blank', async () => {
    const calls = stubFetch(() => sse([delta({ content: 'hi' }, 'stop'), '[DONE]']))
    await adapterFor('groq').chat(req({ baseUrl: '   ' }))
    await adapterFor('custom').chat(req({ baseUrl: '' }))
    expect(calls[0].url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(calls[1].url).toBe('http://localhost:11434/v1/chat/completions')
  })

  it('custom + loopback works with no API key at all (Ollama / LM Studio)', async () => {
    vi.stubEnv('CUSTOM_API_KEY', '')
    vi.mocked(loadByokEnv).mockReturnValue({})
    const calls = stubFetch(() => sse([delta({ content: 'local' }, 'stop'), '[DONE]']))
    const response = await adapterFor('custom').chat(req({ baseUrl: 'http://localhost:11434/v1' }))
    expect(response.content).toBe('local')
    expect(headerOf(calls[0], 'Authorization')).toBeUndefined()
  })

  it('sends CUSTOM_API_KEY to a custom endpoint when one is configured', async () => {
    vi.stubEnv('CUSTOM_API_KEY', 'custom-secret-9')
    vi.mocked(loadByokEnv).mockReturnValue({})
    const calls = stubFetch(() => sse([delta({ content: 'x' }, 'stop'), '[DONE]']))
    await adapterFor('custom').chat(req({ baseUrl: 'https://my-gateway.example/v1' }))
    expect(headerOf(calls[0], 'Authorization')).toBe('Bearer custom-secret-9')
  })

  it('a built-in provider pointed at a loopback server needs no key and never leaks its stored key', async () => {
    vi.stubEnv('GROQ_API_KEY', '')
    vi.mocked(loadByokEnv).mockReturnValue({ GROQ_API_KEY: 'gsk-stored-key' })
    const calls = stubFetch(() => sse([delta({ content: 'x' }, 'stop'), '[DONE]']))
    await adapterFor('groq').chat(req({ baseUrl: 'http://127.0.0.1:8080/v1' }))
    await adapterFor('groq').chat(req({ baseUrl: 'https://evil.example/v1' }))
    expect(headerOf(calls[0], 'Authorization')).toBeUndefined()
    expect(headerOf(calls[1], 'Authorization')).toBeUndefined()
  })

  it('a built-in provider on its own API still requires and sends its key', async () => {
    vi.stubEnv('GROQ_API_KEY', '')
    vi.mocked(loadByokEnv).mockReturnValue({})
    const calls = stubFetch(() => sse([delta({ content: 'x' }, 'stop'), '[DONE]']))
    await expect(adapterFor('groq').chat(req())).rejects.toThrow(/No API key configured for Groq/)
    expect(calls).toHaveLength(0)

    vi.mocked(loadByokEnv).mockReturnValue({ GROQ_API_KEY: 'gsk-real-1' })
    await adapterFor('groq').chat(req())
    expect(headerOf(calls[0], 'Authorization')).toBe('Bearer gsk-real-1')
  })

  it.each(['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1', 'https://api.moonshot.ai/v1/'])(
    'moonshot sends its key to the official host %s',
    async (baseUrl) => {
      const calls = stubFetch(() => sse([delta({ content: 'x' }, 'stop'), '[DONE]']))
      await adapterFor('moonshot').chat(req({ baseUrl }))
      expect(headerOf(calls[0], 'Authorization')).toBe(`Bearer ${DEFAULT_ENV.MOONSHOT_API_KEY}`)
    }
  )

  it.each([
    'https://api.moonshot.ai.evil.example/v1',
    'https://api.moonshot.ai@evil.example/v1',
    'http://api.moonshot.ai/v1',
    'https://evil.example/v1'
  ])('moonshot sends no key to %s', async (baseUrl) => {
    const calls = stubFetch(() => sse([delta({ content: 'x' }, 'stop'), '[DONE]']))
    await adapterFor('moonshot').chat(req({ baseUrl }))
    expect(headerOf(calls[0], 'Authorization')).toBeUndefined()
  })

  it('moonshot on its international host without a key is a configuration error, not a keyless call', async () => {
    vi.stubEnv('MOONSHOT_API_KEY', '')
    vi.mocked(loadByokEnv).mockReturnValue({})
    const calls = stubFetch(() => sse([delta({ content: 'x' }, 'stop'), '[DONE]']))
    await expect(adapterFor('moonshot').chat(req({ baseUrl: 'https://api.moonshot.ai/v1' }))).rejects.toThrow(
      /No API key configured for/
    )
    expect(calls).toHaveLength(0)
  })

  it('probe() works for a keyless loopback custom endpoint', async () => {
    vi.stubEnv('CUSTOM_API_KEY', '')
    vi.mocked(loadByokEnv).mockReturnValue({})
    const calls = stubFetch(() => new Response('{}', { status: 200 }))
    await expect(adapterFor('custom').probe()).resolves.toBe(true)
    expect(calls[0].url).toBe('http://localhost:11434/v1/models')
  })
})

// ── tool-call accumulation ──

describe('streamed tool-call accumulation', () => {
  it('assembles fragmented arguments by index, with id and name only on the first fragment', async () => {
    stubFetch(() => sse([
      delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'fs_read', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] }),
      delta({}, 'tool_calls'),
      '[DONE]'
    ]))
    const response = await adapterFor('groq').chat(req())
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.ts"}' } }
    ])
  })

  it('accepts a call whose full arguments arrive in a single chunk', async () => {
    stubFetch(() => sse([
      delta({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'grep', arguments: '{"pattern":"x"}' } }] }, 'tool_calls'),
      '[DONE]'
    ]))
    const response = await adapterFor('groq').chat(req())
    expect(response.toolCalls?.[0].function).toEqual({ name: 'grep', arguments: '{"pattern":"x"}' })
  })

  it('keeps parallel calls apart by index and fills in missing ids', async () => {
    stubFetch(() => sse([
      delta({ tool_calls: [{ index: 0, id: 'call_0', function: { name: 'fs_read', arguments: '{"path":' } }] }),
      delta({ tool_calls: [{ index: 1, function: { name: 'grep', arguments: '{"pattern":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] }, 'tool_calls'),
      '[DONE]'
    ]))
    const response = await adapterFor('groq').chat(req())
    expect(response.toolCalls).toHaveLength(2)
    expect(response.toolCalls![0]).toMatchObject({ id: 'call_0', function: { name: 'fs_read', arguments: '{"path":"a"}' } })
    expect(response.toolCalls![1]).toMatchObject({ function: { name: 'grep', arguments: '{"pattern":"b"}' } })
    expect(response.toolCalls![1].id).toMatch(/^call_[0-9a-f]{12}$/)
    expect(response.toolCalls![1].id).not.toBe(response.toolCalls![0].id)
  })

  it('separates parallel calls from servers that reuse index 0 but give each call its own id', async () => {
    stubFetch(() => sse([
      delta({ tool_calls: [{ index: 0, id: 'id_a', function: { name: 'fs_read', arguments: '{"path":"a"}' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'id_b', function: { name: 'fs_read', arguments: '{"path":"b"}' } }] }, 'stop'),
      '[DONE]'
    ]))
    const response = await adapterFor('groq').chat(req())
    expect(response.toolCalls?.map((c) => [c.id, c.function.arguments])).toEqual([
      ['id_a', '{"path":"a"}'],
      ['id_b', '{"path":"b"}']
    ])
    // A server that says "stop" while returning calls is still a tool-call turn.
    expect(response.finishReason).toBe('tool_calls')
  })

  it('handles servers that omit index entirely', async () => {
    stubFetch(() => sse([
      delta({ tool_calls: [{ id: 'x1', function: { name: 'grep', arguments: '{"pattern":' } }] }),
      delta({ tool_calls: [{ function: { arguments: '"q"}' } }] }),
      delta({ tool_calls: [{ id: 'x2', function: { name: 'fs_read', arguments: '{}' } }] }, 'tool_calls'),
      '[DONE]'
    ]))
    const response = await adapterFor('groq').chat(req())
    expect(response.toolCalls?.map((c) => [c.id, c.function.name, c.function.arguments])).toEqual([
      ['x1', 'grep', '{"pattern":"q"}'],
      ['x2', 'fs_read', '{}']
    ])
  })

  it('does not double a function name that is repeated on every fragment', async () => {
    stubFetch(() => sse([
      delta({ tool_calls: [{ index: 0, id: 'c', function: { name: 'grep', arguments: '{"a":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { name: 'grep', arguments: '1}' } }] }, 'tool_calls'),
      '[DONE]'
    ]))
    const response = await adapterFor('groq').chat(req())
    expect(response.toolCalls?.[0].function).toEqual({ name: 'grep', arguments: '{"a":1}' })
  })

  it('defaults empty arguments to {} and accepts object-valued arguments', async () => {
    stubFetch(() => sse([
      delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'noargs' } }, { index: 1, id: 'b', function: { name: 'obj', arguments: { k: 1 } } }] }, 'tool_calls'),
      '[DONE]'
    ]))
    const response = await adapterFor('groq').chat(req())
    expect(response.toolCalls?.map((c) => c.function.arguments)).toEqual(['{}', '{"k":1}'])
  })

  it('NanoGPT uses the same accumulation', async () => {
    stubFetch(() => sse([
      delta({ tool_calls: [{ index: 0, id: 'n1', function: { name: 'shell', arguments: '{"cmd":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, 'tool_calls'),
      '[DONE]'
    ]))
    const response = await new NanoGptAdapter().chat(req(), () => undefined)
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls?.[0]).toEqual({ id: 'n1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } })
  })

  it('reads tool calls from a non-streaming JSON answer', async () => {
    stubFetch(() => new Response(JSON.stringify({
      choices: [{
        message: { content: null, tool_calls: [{ id: 'j1', type: 'function', function: { name: 'grep', arguments: '{"p":1}' } }] },
        finish_reason: 'tool_calls'
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const response = await adapterFor('groq').chat(req())
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls?.[0].function).toEqual({ name: 'grep', arguments: '{"p":1}' })
  })
})

// ── stream robustness ──

describe('stream and request robustness', () => {
  it('processes a final SSE line that has no trailing newline', async () => {
    stubFetch(() => rawSse([
      'data: ' + JSON.stringify(delta({ content: 'tail' })) + '\n\n',
      'data: ' + JSON.stringify({ id: 'z', choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 9, completion_tokens: 2 } })
    ]))
    const response = await adapterFor('groq').chat(req())
    expect(response.content).toBe('tail')
    expect(response.finishReason).toBe('length')
    expect(response.usage).toEqual({ input: 9, output: 2 })
  })

  it('does not retry a 400 and redacts the key from the error', async () => {
    const calls = stubFetch(() => new Response('bad request for gsk-mock-key-1234', { status: 400 }))
    const error = await rejectionOf(adapterFor('groq').chat(req()))
    expect(calls).toHaveLength(1)
    expect(error.message).toContain('groq API returned 400')
    expect(error.message).not.toContain('gsk-mock-key-1234')
    expect(error.message).toContain('[redacted]')
  })

  it('retries a transient 503 and then succeeds', async () => {
    const calls = stubFetch(
      () => new Response('overloaded', { status: 503 }),
      () => sse([delta({ content: 'recovered' }, 'stop'), '[DONE]'])
    )
    const response = await adapterFor('groq').chat(req())
    expect(calls).toHaveLength(2)
    expect(response.content).toBe('recovered')
  })

  it('does not retry once output has reached the caller (no duplicated deltas)', async () => {
    const calls = stubFetch(() => sse([
      delta({ content: 'partial ' }),
      { error: { message: 'upstream exploded' } }
    ]))
    const deltas: ChatDelta[] = []
    await expect(adapterFor('openrouter').chat(req(), (d) => deltas.push(d))).rejects.toThrow(/upstream exploded/)
    expect(calls).toHaveLength(1)
    expect(deltas).toEqual([{ content: 'partial ' }])
  })

  it('surfaces content_filter with no output instead of returning an empty answer', async () => {
    stubFetch(() => sse([delta({}, 'content_filter'), '[DONE]']))
    await expect(adapterFor('groq').chat(req())).rejects.toThrow(/content_filter/)
  })

  it('falls back to JSON parsing when the server ignores stream:true', async () => {
    stubFetch(() => new Response(JSON.stringify({
      id: 'plain',
      choices: [{ message: { role: 'assistant', content: 'plain answer' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2 }
    }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }))
    const deltas: ChatDelta[] = []
    const response = await adapterFor('custom').chat(req({ baseUrl: 'http://localhost:8080/v1' }), (d) => deltas.push(d))
    expect(response.content).toBe('plain answer')
    expect(deltas).toEqual([{ content: 'plain answer' }])
  })

  it('stays cancellable', async () => {
    const controller = new AbortController()
    stubFetch(() => {
      controller.abort()
      throw new Error('aborted by caller')
    })
    await expect(adapterFor('groq').chat(req({ signal: controller.signal }))).rejects.toThrow(/cancelled/)
  })

  it('createIdleGuard fires only after silence and is reset by activity', () => {
    vi.useFakeTimers()
    const parent = new AbortController()
    const guard = createIdleGuard(parent.signal, 1000)
    vi.advanceTimersByTime(900)
    guard.touch()
    vi.advanceTimersByTime(900)
    expect(guard.signal.aborted).toBe(false)
    vi.advanceTimersByTime(200)
    expect(guard.signal.aborted).toBe(true)
    expect(guard.timedOut).toBe(true)
    guard.dispose()

    const second = createIdleGuard(parent.signal, 1000)
    parent.abort()
    expect(second.signal.aborted).toBe(true)
    expect(second.timedOut).toBe(false)
    second.dispose()
  })
})
