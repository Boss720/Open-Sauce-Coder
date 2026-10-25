import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  GeminiAdapter,
  buildGeminiThinkingConfig,
  toGeminiContents
} from '../harness/providers/gemini'
import type { ChatDelta, ChatMessage, ChatRequest, ChatResponse } from '../harness/providers/adapter'

const { mockGenerateContentStream } = vi.hoisted(() => ({ mockGenerateContentStream: vi.fn() }))

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = { generateContentStream: mockGenerateContentStream }
  }
}))

vi.mock('../keys', () => ({
  loadByokEnv: vi.fn(() => ({ GEMINI_API_KEY: 'gemini-mock-key-2222' }))
}))

type Chunk = Record<string, unknown>

async function* streamOf(chunks: Chunk[]): AsyncGenerator<Chunk> {
  for (const chunk of chunks) yield chunk
}

function queueStream(chunks: Chunk[]): void {
  mockGenerateContentStream.mockResolvedValueOnce(streamOf(chunks))
}

const TOOLS: ChatRequest['tools'] = [
  { type: 'function', function: { name: 'fs_read', description: 'read', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'grep', description: 'search', parameters: { type: 'object' } } }
]

function baseRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    requestId: 'run1-turn-0',
    model: 'gemini-3-pro-preview',
    messages: [{ role: 'user', content: 'go' }],
    tools: TOOLS,
    ...overrides
  }
}

/** The assistant ChatMessage the runner would append for a tool-call response. */
function assistantFrom(response: ChatResponse): ChatMessage {
  return {
    role: 'assistant',
    content: response.content.length > 0 ? response.content : null,
    tool_calls: response.toolCalls,
    ...(response.providerReplay ? { providerReplay: response.providerReplay } : {})
  }
}

function lastCall(): { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>; config: Record<string, unknown> } {
  const calls = mockGenerateContentStream.mock.calls
  return calls[calls.length - 1][0]
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
  mockGenerateContentStream.mockReset()
})

describe('Gemini thought signatures', () => {
  it('round-trips signatures: stream -> providerReplay -> next request body, same parts in same order', async () => {
    queueStream([
      {
        candidates: [{
          content: {
            parts: [
              { thought: true, text: 'I should read both files.' },
              { text: 'Reading now. ' }
            ]
          }
        }]
      },
      {
        candidates: [{
          finishReason: 'STOP',
          content: {
            parts: [
              { functionCall: { name: 'fs_read', args: { path: 'a.ts' } }, thoughtSignature: 'SIG_FIRST_CALL' },
              { functionCall: { name: 'fs_read', args: { path: 'b.ts' } } }
            ]
          }
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
      }
    ])

    const adapter = new GeminiAdapter()
    const first = await adapter.chat(baseRequest())

    expect(first.finishReason).toBe('tool_calls')
    expect(first.providerReplay).toBeDefined()
    expect(JSON.stringify(first.providerReplay)).toContain('SIG_FIRST_CALL')

    // Next turn: the harness replays the assistant message and appends the tool results.
    queueStream([{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'done' }] } }] }])
    await adapter.chat(baseRequest({
      requestId: 'run1-turn-1',
      messages: [
        { role: 'user', content: 'go' },
        assistantFrom(first),
        { role: 'tool', tool_call_id: first.toolCalls![0].id, content: 'A' },
        { role: 'tool', tool_call_id: first.toolCalls![1].id, content: 'B' }
      ]
    }))

    const sent = lastCall().contents
    expect(sent).toHaveLength(3)
    expect(sent[1].role).toBe('model')
    // Thought summary without a signature is dropped; text and both calls keep their original order.
    expect(sent[1].parts).toEqual([
      { text: 'Reading now. ' },
      { functionCall: { name: 'fs_read', args: { path: 'a.ts' } }, thoughtSignature: 'SIG_FIRST_CALL' },
      { functionCall: { name: 'fs_read', args: { path: 'b.ts' } } }
    ])
    // Synthesised ids are never sent to the API.
    expect(JSON.stringify(sent[1].parts)).not.toContain('gemini-call-')
  })

  it('merges unsigned text chunks, closes a part at its signature, and keeps a signature that arrives on an empty trailing part', async () => {
    queueStream([
      { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'lo' }] } }] },
      { candidates: [{ content: { parts: [{ text: ' world' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '', thoughtSignature: 'SIG_TEXT' }] } }] }
    ])

    const adapter = new GeminiAdapter()
    const response = await adapter.chat(baseRequest({ tools: undefined }))

    expect(response.content).toBe('Hello world')
    expect(response.finishReason).toBe('stop')
    expect(response.providerReplay).toEqual({
      gemini: { parts: [{ text: 'Hello world', thoughtSignature: 'SIG_TEXT' }] }
    })

    // Echoed on the model turn when the text is unchanged.
    const converted = toGeminiContents([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello world', providerReplay: response.providerReplay }
    ])
    expect(converted.contents[1].parts).toEqual([{ text: 'Hello world', thoughtSignature: 'SIG_TEXT' }])

    // ...but not when the text was edited afterwards.
    const edited = toGeminiContents([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there', providerReplay: response.providerReplay }
    ])
    expect(edited.contents[1].parts).toEqual([{ text: 'Hello there' }])
  })

  it('does not merge signed text with the unsigned text that follows it', async () => {
    queueStream([
      { candidates: [{ content: { parts: [{ text: 'One.', thoughtSignature: 'S1' }] } }] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Two.' }] } }] }
    ])
    const response = await new GeminiAdapter().chat(baseRequest({ tools: undefined }))
    expect(response.providerReplay).toEqual({
      gemini: { parts: [{ text: 'One.', thoughtSignature: 'S1' }, { text: 'Two.' }] }
    })
  })

  it('falls back to a signature-less rebuild when the replay does not match the tool calls', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'grep', arguments: '{"pattern":"a"}' } }],
        providerReplay: {
          gemini: {
            parts: [{ functionCall: { name: 'grep', args: {} }, callId: 'some_other_id', thoughtSignature: 'STALE' }]
          }
        }
      }
    ])
    expect(contents[1].parts).toEqual([
      { functionCall: { id: 'call_x', name: 'grep', args: { pattern: 'a' } } }
    ])
  })

  it('ignores malformed replay data from other providers', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }],
        providerReplay: { anthropic: { blocks: [] }, gemini: 'garbage' }
      }
    ])
    expect(contents[1].parts).toEqual([{ functionCall: { id: 'c1', name: 'grep', args: {} } }])
  })
})

describe('Gemini 3 placeholder signatures', () => {
  const DUMMY = 'skip_thought_signature_validator'
  const CALL_A = { name: 'fs_read', args: { path: 'a' } }
  const CALL_B = { name: 'fs_read', args: { path: 'b' } }

  /** A two-call parallel assistant turn plus its results, optionally carrying a stored replay. */
  function parallelHistory(providerReplay?: ChatMessage['providerReplay']): ChatMessage[] {
    return [
      { role: 'user', content: 'read both' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'gemini-call-h-0', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a"}' } },
          { id: 'gemini-call-h-1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"b"}' } }
        ],
        ...(providerReplay ? { providerReplay } : {})
      },
      { role: 'tool', tool_call_id: 'gemini-call-h-0', content: 'A' },
      { role: 'tool', tool_call_id: 'gemini-call-h-1', content: 'B' }
    ]
  }

  function replayOf(...parts: Array<Record<string, unknown>>): ChatMessage['providerReplay'] {
    return { gemini: { parts } }
  }

  /** Send `messages` through the adapter and return the parts of the model turn it put on the wire. */
  async function modelTurnSent(model: string, messages: ChatMessage[]): Promise<Array<Record<string, unknown>>> {
    queueStream([{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] }])
    await new GeminiAdapter().chat(baseRequest({ model, messages }))
    return lastCall().contents[1].parts
  }

  it.each(['gemini-3-pro-preview', 'models/gemini-3.5-flash'])(
    'puts the dummy on the first call only when %s gets history with no replay',
    async (model) => {
      const parts = await modelTurnSent(model, parallelHistory())
      expect(parts).toEqual([
        { functionCall: CALL_A, thoughtSignature: DUMMY },
        { functionCall: CALL_B }
      ])
      expect(parts[1]).not.toHaveProperty('thoughtSignature')
    }
  )

  it('keeps a real signature and never adds the dummy to a turn that already has one', async () => {
    const onFirst = await modelTurnSent('gemini-3-pro-preview', parallelHistory(replayOf(
      { functionCall: CALL_A, callId: 'gemini-call-h-0', thoughtSignature: 'SIG_REAL' },
      { functionCall: CALL_B, callId: 'gemini-call-h-1' }
    )))
    expect(onFirst).toEqual([
      { functionCall: CALL_A, thoughtSignature: 'SIG_REAL' },
      { functionCall: CALL_B }
    ])
    expect(JSON.stringify(onFirst)).not.toContain(DUMMY)

    // A signature on any call of the turn counts, wherever it sits.
    const onSecond = await modelTurnSent('gemini-3-pro-preview', parallelHistory(replayOf(
      { functionCall: CALL_A, callId: 'gemini-call-h-0' },
      { functionCall: CALL_B, callId: 'gemini-call-h-1', thoughtSignature: 'SIG_REAL' }
    )))
    expect(onSecond).toEqual([
      { functionCall: CALL_A },
      { functionCall: CALL_B, thoughtSignature: 'SIG_REAL' }
    ])
    expect(JSON.stringify(onSecond)).not.toContain(DUMMY)
  })

  it('adds the dummy to the first call of a usable replay recorded without signatures', async () => {
    const parts = await modelTurnSent('gemini-3-pro-preview', parallelHistory(replayOf(
      { text: 'Reading. ' },
      { functionCall: CALL_A, callId: 'gemini-call-h-0' },
      { functionCall: CALL_B, callId: 'gemini-call-h-1' }
    )))
    expect(parts).toEqual([
      { text: 'Reading. ' },
      { functionCall: CALL_A, thoughtSignature: DUMMY },
      { functionCall: CALL_B }
    ])
  })

  it('does not add a signature for Gemini 2.5, with or without a replay, or when no model is given', async () => {
    const unsignedReplay = replayOf(
      { functionCall: CALL_A, callId: 'gemini-call-h-0' },
      { functionCall: CALL_B, callId: 'gemini-call-h-1' }
    )
    const rebuilt = await modelTurnSent('gemini-2.5-flash', parallelHistory())
    expect(rebuilt).toEqual([{ functionCall: CALL_A }, { functionCall: CALL_B }])
    expect(JSON.stringify(rebuilt)).not.toContain('thoughtSignature')

    const replayed = await modelTurnSent('gemini-2.5-pro', parallelHistory(unsignedReplay))
    expect(replayed).toEqual([{ functionCall: CALL_A }, { functionCall: CALL_B }])
    expect(JSON.stringify(replayed)).not.toContain('thoughtSignature')

    const noModel = toGeminiContents(parallelHistory()).contents[1].parts
    expect(JSON.stringify(noModel)).not.toContain('thoughtSignature')
  })
})

describe('Gemini finish reasons and tool-call ids', () => {
  it('reports tool_calls when STOP arrives together with functionCall parts', async () => {
    queueStream([{
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ functionCall: { id: 'g-1', name: 'grep', args: { pattern: 'x' } } }] }
      }]
    }])
    const response = await new GeminiAdapter().chat(baseRequest())
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls).toEqual([
      { id: 'g-1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } }
    ])
  })

  it('maps MAX_TOKENS to length and plain STOP to stop', async () => {
    queueStream([{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'cut' }] } }] }])
    const truncated = await new GeminiAdapter().chat(baseRequest({ tools: undefined }))
    expect(truncated.finishReason).toBe('length')
    expect(truncated.content).toBe('cut')

    queueStream([{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }] }])
    const done = await new GeminiAdapter().chat(baseRequest({ tools: undefined }))
    expect(done.finishReason).toBe('stop')
  })

  it.each(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST'])(
    'surfaces finishReason %s as an error instead of an empty answer',
    async (reason) => {
      queueStream([{ candidates: [{ finishReason: reason }] }])
      await expect(new GeminiAdapter().chat(baseRequest({ tools: undefined }))).rejects.toThrow(
        new RegExp(`Gemini stopped without a usable answer \\(${reason}\\)`)
      )
    }
  )

  it('surfaces a prompt-level block reported in promptFeedback', async () => {
    queueStream([{ promptFeedback: { blockReason: 'SAFETY' } }])
    await expect(new GeminiAdapter().chat(baseRequest({ tools: undefined }))).rejects.toThrow(/SAFETY/)
  })

  it('surfaces a withheld response even if some text streamed first', async () => {
    queueStream([
      { candidates: [{ content: { parts: [{ text: 'partial' }] } }] },
      { candidates: [{ finishReason: 'SAFETY' }] }
    ])
    await expect(new GeminiAdapter().chat(baseRequest({ tools: undefined }))).rejects.toThrow(/SAFETY/)
  })

  it('gives two parallel calls to the same function distinct ids', async () => {
    queueStream([{
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [
            { functionCall: { name: 'fs_read', args: { path: 'a' } } },
            { functionCall: { name: 'fs_read', args: { path: 'b' } } }
          ]
        }
      }]
    }])
    const response = await new GeminiAdapter().chat(baseRequest())
    const ids = response.toolCalls!.map((c) => c.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => id !== 'fs_read')).toBe(true)
  })

  it('answers same-name parallel calls with one user turn of correctly named functionResponses', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'read both' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'gemini-call-r-0', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a"}' } },
          { id: 'gemini-call-r-1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"b"}' } },
          { id: 'gemini-call-r-2', type: 'function', function: { name: 'fs_read', arguments: '{"path":"c"}' } }
        ]
      },
      // Results arrive out of order.
      { role: 'tool', tool_call_id: 'gemini-call-r-2', content: '{"text":"C"}' },
      { role: 'tool', tool_call_id: 'gemini-call-r-0', content: '{"text":"A"}' },
      { role: 'tool', tool_call_id: 'gemini-call-r-1', content: '["match"]' }
    ]
    const { contents } = toGeminiContents(messages, TOOLS)

    expect(contents).toHaveLength(3)
    const resultTurn = contents[2]
    expect(resultTurn.role).toBe('user')
    // Same order as the calls, names looked up from the call (not the id), no synthetic ids sent.
    expect(resultTurn.parts).toEqual([
      { functionResponse: { name: 'fs_read', response: { text: 'A' } } },
      { functionResponse: { name: 'grep', response: { result: ['match'] } } },
      { functionResponse: { name: 'fs_read', response: { text: 'C' } } }
    ])
  })

  it('echoes the id Gemini supplied on both the call and its response', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'abc123', type: 'function', function: { name: 'grep', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'abc123', content: 'ok' }
    ])
    expect(contents[1].parts?.[0]).toEqual({ functionCall: { id: 'abc123', name: 'grep', args: {} } })
    expect(contents[2].parts?.[0]).toEqual({ functionResponse: { id: 'abc123', name: 'grep', response: { result: 'ok' } } })
  })

  it('resolves a repeated tool_call_id against the most recent turn that issued it', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_0', content: 'one' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_0', content: 'two' }
    ])
    expect(contents[2].parts?.[0]?.functionResponse?.name).toBe('grep')
    expect(contents[4].parts?.[0]?.functionResponse?.name).toBe('fs_read')
  })

  it('merges multiple system messages instead of keeping only the last', () => {
    const { systemInstruction, contents } = toGeminiContents([
      { role: 'system', content: 'You are a coder.' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'Prefer small diffs.' }
    ])
    expect(systemInstruction).toBe('You are a coder.\n\nPrefer small diffs.')
    expect(contents).toHaveLength(1)
  })
})

describe('Gemini thinking', () => {
  it('streams thought parts as thinkingContent, never as answer text', async () => {
    queueStream([
      { candidates: [{ content: { parts: [{ thought: true, text: 'Weighing options. ' }] } }] },
      { candidates: [{ content: { parts: [{ thought: true, text: 'Picking one.' }, { text: 'Answer.' }] } }] },
      { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 7 } }
    ])
    const deltas: ChatDelta[] = []
    const response = await new GeminiAdapter().chat(
      baseRequest({ tools: undefined, thinking: { enabled: true } }),
      (d) => deltas.push(d)
    )

    expect(response.content).toBe('Answer.')
    expect(response.thinkingContent).toBe('Weighing options. Picking one.')
    expect(response.usage).toEqual({ input: 3, output: 2, reasoning: 7 })
    expect(deltas.filter((d) => d.thinkingContent).map((d) => d.thinkingContent)).toEqual(['Weighing options. ', 'Picking one.'])
    expect(deltas.filter((d) => d.content).map((d) => d.content)).toEqual(['Answer.'])
  })

  it('sends includeThoughts plus thinkingLevel (no budget) for Gemini 3', async () => {
    queueStream([{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x' }] } }] }])
    await new GeminiAdapter().chat(baseRequest({ model: 'gemini-3-flash-preview', thinking: { enabled: true, budget: 2048 } }))
    expect(lastCall().config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'LOW' })
  })

  it('sends includeThoughts plus thinkingBudget (no level) for Gemini 2.5', async () => {
    queueStream([{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x' }] } }] }])
    await new GeminiAdapter().chat(baseRequest({ model: 'gemini-2.5-flash', thinking: { enabled: true, budget: 4096 } }))
    expect(lastCall().config.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 4096 })
  })

  it('sends no thinkingConfig when thinking is off', async () => {
    queueStream([{ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'x' }] } }] }])
    await new GeminiAdapter().chat(baseRequest({ model: 'gemini-2.5-flash' }))
    expect(lastCall().config.thinkingConfig).toBeUndefined()
  })

  it('buildGeminiThinkingConfig picks the right knob per model family', () => {
    expect(buildGeminiThinkingConfig('gemini-3-pro-preview', { enabled: true })).toEqual({ includeThoughts: true })
    expect(buildGeminiThinkingConfig('models/gemini-3.1-pro', { enabled: true, budget: 32000 })).toEqual({
      includeThoughts: true,
      thinkingLevel: 'HIGH'
    })
    expect(buildGeminiThinkingConfig('gemini-2.5-pro', { enabled: true })).toEqual({ includeThoughts: true, thinkingBudget: 8192 })
    // Clamped into the supported range.
    expect(buildGeminiThinkingConfig('gemini-2.5-flash', { enabled: true, budget: 1_000_000 })).toEqual({
      includeThoughts: true,
      thinkingBudget: 24576
    })
    expect(buildGeminiThinkingConfig('gemini-2.5-pro', { enabled: true, budget: 10 })).toEqual({
      includeThoughts: true,
      thinkingBudget: 512
    })
    // Models without thinking support must not receive a thinkingConfig (HTTP 400).
    expect(buildGeminiThinkingConfig('gemini-2.0-flash', { enabled: true })).toBeUndefined()
    expect(buildGeminiThinkingConfig('gemini-1.5-pro', { enabled: true })).toBeUndefined()
    expect(buildGeminiThinkingConfig('gemini-2.5-flash', { enabled: false })).toBeUndefined()
  })
})

describe('Gemini security', () => {
  it('redacts the API key from SDK errors', async () => {
    mockGenerateContentStream.mockRejectedValueOnce(
      new Error('request to https://x/models?key=gemini-mock-key-2222 failed; key gemini-mock-key-2222 rejected')
    )
    const error = await rejectionOf(new GeminiAdapter().chat(baseRequest()))
    expect(error.message).toMatch(/^Gemini harness request failed:/)
    expect(error.message).not.toContain('gemini-mock-key-2222')
    expect(error.message).toContain('[redacted]')
  })

  it('probe() sends the key in a header, not in the URL', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(new GeminiAdapter().probe()).resolves.toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).not.toContain('key=')
    expect(url).not.toContain('gemini-mock-key-2222')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('gemini-mock-key-2222')
  })

  it('reports an aborted request as aborted, not as a provider failure', async () => {
    const controller = new AbortController()
    mockGenerateContentStream.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('The operation was aborted')
    })
    await expect(new GeminiAdapter().chat(baseRequest({ signal: controller.signal }))).rejects.toThrow('Request aborted.')
  })
})
