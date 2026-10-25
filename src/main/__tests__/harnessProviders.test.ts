import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProviderRegistry } from '../harness/providers/registry'
import { OpenAiCompatibleAdapter } from '../harness/providers/openaiCompatible'
import { AnthropicAdapter } from '../harness/providers/anthropic'
import { OpenAiAdapter } from '../harness/providers/openai'
import { NanoGptAdapter } from '../harness/providers/nanogpt'
import {
  GeminiAdapter,
  toGeminiContents,
  toGeminiTools,
  extractGeminiToolCalls,
  extractGeminiText,
  extractGeminiUsage
} from '../harness/providers/gemini'
import { ThinkTagStreamer, extractThinkTags } from '../harness/providers/thinkTagStreamer'
import type { ChatRequest, ChatDelta, ChatMessage, FunctionDefinition } from '../harness/providers/adapter'

const mockGenerateContentStream = vi.fn()

vi.mock('@google/genai', () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContentStream: mockGenerateContentStream
    }
  }
}))

vi.mock('../keys', () => ({
  loadByokEnv: vi.fn(() => ({
    NANOGPT_API_KEY: 'nano-mock-key-1111',
    GEMINI_API_KEY: 'gemini-mock-key-2222',
    GROQ_API_KEY: 'gsk-mock-key-1234',
    MISTRAL_API_KEY: 'mistral-mock-key-5678',
    ANTHROPIC_API_KEY: 'sk-ant-mock-key-9012',
    OPENAI_API_KEY: 'sk-openai-mock-key-3456',
    DEEPSEEK_API_KEY: 'sk-deepseek-mock-key-7890'
  }))
}))

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + '\n\n'))
      }
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  })
}

describe('ProviderRegistry multi-provider support', () => {
  it('supports all 12 providers', () => {
    const registry = new ProviderRegistry()
    const expected = [
      'nanogpt', 'google', 'anthropic', 'openai', 'openrouter',
      'groq', 'mistral', 'deepseek', 'moonshot', 'xai', 'cerebras', 'custom'
    ]
    for (const id of expected) {
      expect(registry.isSupported(id)).toBe(true)
    }
    expect(registry.isSupported('unsupported-provider')).toBe(false)
  })

  it('resolves dedicated adapters correctly', () => {
    const registry = new ProviderRegistry()
    expect(registry.resolve('nanogpt')).toBeInstanceOf(NanoGptAdapter)
    expect(registry.resolve('google')).toBeInstanceOf(GeminiAdapter)
    expect(registry.resolve('anthropic')).toBeInstanceOf(AnthropicAdapter)
    expect(registry.resolve('openai')).toBeInstanceOf(OpenAiAdapter)
  })

  it('resolves OpenAI-compatible and custom providers to OpenAiCompatibleAdapter', () => {
    const registry = new ProviderRegistry()
    const groqAdapter = registry.resolve('groq')
    expect(groqAdapter).toBeInstanceOf(OpenAiCompatibleAdapter)
    expect(groqAdapter.id).toBe('groq')

    const mistralAdapter = registry.resolve('mistral')
    expect(mistralAdapter).toBeInstanceOf(OpenAiCompatibleAdapter)
    expect(mistralAdapter.id).toBe('mistral')

    const deepseekAdapter = registry.resolve('deepseek')
    expect(deepseekAdapter).toBeInstanceOf(OpenAiCompatibleAdapter)
    expect(deepseekAdapter.id).toBe('deepseek')

    const customAdapter = registry.resolve('custom')
    expect(customAdapter).toBeInstanceOf(OpenAiCompatibleAdapter)
    expect(customAdapter.id).toBe('custom')
  })

  it('throws descriptive error on unknown provider', () => {
    const registry = new ProviderRegistry()
    expect(() => registry.resolve('unknown-provider')).toThrow(/Unsupported harness provider/)
  })
})

describe('GeminiAdapter and toGeminiContents mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    mockGenerateContentStream.mockReset()
  })

  it('converts role "tool" function response to role "user" (NOT "function")', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Run command' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"file.txt"}' } }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '{"status":"ok","bytes":42}'
      }
    ]

    const result = toGeminiContents(messages)
    expect(result.contents).toHaveLength(3)

    // User prompt
    expect(result.contents[0].role).toBe('user')

    // Assistant / model call
    expect(result.contents[1]?.role).toBe('model')
    expect(result.contents[1]?.parts?.[0]?.functionCall?.name).toBe('fs_read')

    // Tool result MUST use role 'user', not 'function'
    const toolContent = result.contents[2]
    expect(toolContent?.role).toBe('user')
    expect(toolContent?.role).not.toBe('function')

    const part = toolContent?.parts?.[0]
    expect(part?.functionResponse).toBeDefined()
    expect(part?.functionResponse?.name).toBe('fs_read')
    expect(part?.functionResponse?.id).toBe('call_1')
    expect(part?.functionResponse?.response).toEqual({ status: 'ok', bytes: 42 })
  })

  it('groups contiguous tool messages into a single user turn with multiple functionResponse parts', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Search and read' },
      {
        role: 'assistant',
        content: 'Running tools',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"abc"}' } },
          { id: 'c2', type: 'function', function: { name: 'fs_read', arguments: '{"path":"def.txt"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'grep result' },
      { role: 'tool', tool_call_id: 'c2', content: 'file content' }
    ]

    const result = toGeminiContents(messages)
    // 3 entries: user, model, single combined user message
    expect(result.contents).toHaveLength(3)

    const groupedToolContent = result.contents[2]
    expect(groupedToolContent?.role).toBe('user')
    expect(groupedToolContent?.parts).toHaveLength(2)

    expect(groupedToolContent?.parts?.[0]?.functionResponse).toEqual({
      name: 'grep',
      id: 'c1',
      response: { result: 'grep result' }
    })
    expect(groupedToolContent?.parts?.[1]?.functionResponse).toEqual({
      name: 'fs_read',
      id: 'c2',
      response: { result: 'file content' }
    })
  })

  it('keeps non-contiguous tool messages in separate user messages', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', tool_call_id: 'c1', content: 'res1' },
      { role: 'user', content: 'Follow-up query' },
      { role: 'tool', tool_call_id: 'c2', content: 'res2' }
    ]

    const declaredTools: FunctionDefinition[] = [
      { type: 'function', function: { name: 'fs_read', description: '', parameters: {} } },
      { type: 'function', function: { name: 'grep', description: '', parameters: {} } }
    ]

    const result = toGeminiContents(messages, declaredTools)
    expect(result.contents).toHaveLength(3)
    expect(result.contents[0]?.role).toBe('user')
    expect(result.contents[1]?.role).toBe('user')
    expect(result.contents[2]?.role).toBe('user')
  })

  it('robustly resolves function names from declared tools', () => {
    const declaredTools: FunctionDefinition[] = [
      { type: 'function', function: { name: 'fs_patch', description: '', parameters: {} } },
      { type: 'function', function: { name: 'shell', description: '', parameters: {} } }
    ]

    // Case 1: callId directly matches declared tool name
    const msg1: ChatMessage[] = [{ role: 'tool', tool_call_id: 'shell', content: 'executed' }]
    const res1 = toGeminiContents(msg1, declaredTools)
    expect(res1.contents[0]?.parts?.[0]?.functionResponse?.name).toBe('shell')
    expect(res1.contents[0]?.parts?.[0]?.functionResponse?.id).toBe('shell')

    // Case 2: callId contains declared tool name as substring
    const msg2: ChatMessage[] = [{ role: 'tool', tool_call_id: 'call_fs_patch_456', content: 'patched' }]
    const res2 = toGeminiContents(msg2, declaredTools)
    expect(res2.contents[0]?.parts?.[0]?.functionResponse?.name).toBe('fs_patch')
    expect(res2.contents[0]?.parts?.[0]?.functionResponse?.id).toBe('call_fs_patch_456')

    // Case 3: single declared tool fallback
    const singleTool: FunctionDefinition[] = [
      { type: 'function', function: { name: 'only_tool', description: '', parameters: {} } }
    ]
    const msg3: ChatMessage[] = [{ role: 'tool', tool_call_id: 'random_id_999', content: 'done' }]
    const res3 = toGeminiContents(msg3, singleTool)
    expect(res3.contents[0]?.parts?.[0]?.functionResponse?.name).toBe('only_tool')

    // Case 4: unmapped fallback
    const msg4: ChatMessage[] = [{ role: 'tool', tool_call_id: 'unknown_id', content: 'fallback' }]
    const res4 = toGeminiContents(msg4)
    expect(res4.contents[0]?.parts?.[0]?.functionResponse?.name).toBe('unknown_id')
  })

  it('handles string, object, and primitive tool response bodies correctly', () => {
    const messages: ChatMessage[] = [
      { role: 'tool', tool_call_id: 'c1', content: 'plain string response' },
      { role: 'tool', tool_call_id: 'c2', content: '{"status":"ok","code":200}' },
      { role: 'tool', tool_call_id: 'c3', content: '42' },
      { role: 'tool', tool_call_id: 'c4', content: 'true' }
    ]

    const result = toGeminiContents(messages)
    expect(result.contents).toHaveLength(1)
    const parts = result.contents[0]?.parts

    expect(parts?.[0]?.functionResponse?.response).toEqual({ result: 'plain string response' })
    expect(parts?.[1]?.functionResponse?.response).toEqual({ status: 'ok', code: 200 })
    expect(parts?.[2]?.functionResponse?.response).toEqual({ result: 42 })
    expect(parts?.[3]?.functionResponse?.response).toEqual({ result: true })
  })

  it('toGeminiTools converts FunctionDefinition[] to Gemini SDK Tool[] format', () => {
    const tools: FunctionDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'fs_read',
          description: 'Read file content',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path']
          }
        }
      }
    ]

    const geminiTools = toGeminiTools(tools)
    expect(geminiTools).toHaveLength(1)
    expect(geminiTools[0].functionDeclarations).toHaveLength(1)
    expect(geminiTools[0].functionDeclarations?.[0]).toEqual({
      name: 'fs_read',
      description: 'Read file content',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    })
  })

  it('extractGeminiToolCalls preserves fc.id and synthesises a unique id when absent', () => {
    // When fc.id is provided
    const responseWithId = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: 'call_unique_777',
                  name: 'fs_write',
                  args: { path: 'a.txt', content: 'b' }
                }
              }
            ]
          }
        }
      ]
    }
    const callsWithId = extractGeminiToolCalls(responseWithId as unknown as Parameters<typeof extractGeminiToolCalls>[0])
    expect(callsWithId).toHaveLength(1)
    expect(callsWithId?.[0].id).toBe('call_unique_777')
    expect(callsWithId?.[0].function.name).toBe('fs_write')

    // When fc.id is missing, a unique id is synthesised (never the bare function name)
    const responseWithoutId = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'fs_list',
                  args: { path: '.' }
                }
              }
            ]
          }
        }
      ]
    }
    const callsWithoutId = extractGeminiToolCalls(responseWithoutId as unknown as Parameters<typeof extractGeminiToolCalls>[0])
    expect(callsWithoutId).toHaveLength(1)
    expect(callsWithoutId?.[0].id).toMatch(/^gemini-call-.+-0$/)
    expect(callsWithoutId?.[0].id).not.toBe('fs_list')
    expect(callsWithoutId?.[0].function.name).toBe('fs_list')
  })

  it('extractGeminiText and extractGeminiUsage extract metadata accurately', () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [{ text: 'Part 1. ' }, { text: 'Part 2.' }]
          }
        }
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 10
      }
    }

    expect(extractGeminiText(response as unknown as Parameters<typeof extractGeminiToolCalls>[0])).toBe('Part 1. Part 2.')
    expect(extractGeminiUsage(response as unknown as Parameters<typeof extractGeminiToolCalls>[0])).toEqual({
      input: 15,
      output: 30,
      reasoning: 10
    })
  })

  it('GeminiAdapter.chat streams thinking and text deltas, and preserves tool call id', async () => {
    async function* mockStream() {
      yield {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: 'Thinking step 1...' },
                { text: 'Starting tool execution.' }
              ]
            }
          }
        ]
      }
      yield {
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'call_stream_99',
                    name: 'fs_read',
                    args: { path: 'src/main/index.ts' }
                  }
                }
              ]
            }
          }
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 35,
          thoughtsTokenCount: 12
        }
      }
    }

    mockGenerateContentStream.mockResolvedValue(mockStream())

    const adapter = new GeminiAdapter()
    const deltas: ChatDelta[] = []
    const request: ChatRequest = {
      requestId: 'req-gem-1',
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Inspect index' }],
      tools: [
        {
          type: 'function',
          function: { name: 'fs_read', description: '', parameters: {} }
        }
      ],
      thinking: { enabled: true, budget: 4096 }
    }

    const response = await adapter.chat(request, (d) => deltas.push(d))

    expect(response.content).toBe('Starting tool execution.')
    expect(response.thinkingContent).toBe('Thinking step 1...')
    expect(response.finishReason).toBe('tool_calls')
    expect(response.usage).toEqual({ input: 20, output: 35, reasoning: 12 })
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls?.[0]).toEqual({
      id: 'call_stream_99',
      type: 'function',
      function: {
        name: 'fs_read',
        arguments: '{"path":"src/main/index.ts"}'
      }
    })

    // Delts emitted in real time
    expect(deltas.some((d) => d.thinkingContent === 'Thinking step 1...')).toBe(true)
    expect(deltas.some((d) => d.content === 'Starting tool execution.')).toBe(true)
  })
})

describe('AnthropicAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('streams text deltas, thinking deltas, and tool calls with correct format', async () => {
    let capturedBody: Record<string, unknown> | null = null
    const sseLines = [
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":25}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan carefully..."}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"I will check the file."}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"call_1","name":"fs_read"}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\""}}',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"foo.txt\\"}"}}',
      'data: {"type":"content_block_stop","index":2}',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}',
      'data: {"type":"message_stop"}'
    ]

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body))
      return sseResponse(sseLines)
    }))

    const adapter = new AnthropicAdapter()
    const deltas: ChatDelta[] = []
    const request: ChatRequest = {
      requestId: 'req-ant-1',
      model: 'claude-3-7-sonnet-20250219',
      messages: [
        { role: 'system', content: 'You are an engineer.' },
        { role: 'user', content: 'Read foo.txt' }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'fs_read',
            description: 'read file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } }
          }
        }
      ],
      temperature: 0.2,
      thinking: { enabled: true, budget: 4096 }
    }

    const response = await adapter.chat(request, (d) => deltas.push(d))

    expect(response.content).toBe('I will check the file.')
    expect(response.thinkingContent).toBe('Plan carefully...')
    expect(response.finishReason).toBe('tool_calls')
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls?.[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: {
        name: 'fs_read',
        arguments: '{"path":"foo.txt"}'
      }
    })
    expect(response.usage).toEqual({ input: 25, output: 42 })

    // Extended thinking safety: temperature and top_p must be omitted when thinking is enabled
    expect(capturedBody).not.toBeNull()
    const body = capturedBody!
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
    // max_tokens must strictly exceed budget
    expect(body.max_tokens).toBeGreaterThan(4096)
  })

  it('groups contiguous tool results into single user turn with tool_result blocks', async () => {
    let capturedBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body))
      return sseResponse([
        'data: {"type":"message_start","message":{"id":"msg_2","usage":{"input_tokens":10}}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"File contents reviewed."}}',
        'data: {"type":"content_block_stop","index":0}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}',
        'data: {"type":"message_stop"}'
      ])
    }))

    const adapter = new AnthropicAdapter()
    const request: ChatRequest = {
      requestId: 'req-ant-2',
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'user', content: 'Check files' },
        {
          role: 'assistant',
          content: 'Checking...',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a"}' } },
            { id: 'c2', type: 'function', function: { name: 'fs_read', arguments: '{"path":"b"}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'c1', content: 'content of a' },
        { role: 'tool', tool_call_id: 'c2', content: 'content of b' }
      ]
    }

    await adapter.chat(request)
    expect(capturedBody).not.toBeNull()
    const messages = capturedBody!.messages as Array<{ role: string; content: unknown }>
    expect(messages).toHaveLength(3) // user, assistant, user (with 2 tool results)
    expect(messages[2].role).toBe('user')
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'c1', content: 'content of a' },
      { type: 'tool_result', tool_use_id: 'c2', content: 'content of b' }
    ])
  })
})

describe('OpenAiAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('adapts parameters for reasoning models (o1, o3-mini)', async () => {
    let capturedBody: Record<string, unknown> | null = null
    const sseLines = [
      'data: {"id":"chatcmpl-o1","choices":[{"delta":{"reasoning_content":"Thinking...","content":"Answer"}}],"usage":{"prompt_tokens":15,"completion_tokens":20,"completion_tokens_details":{"reasoning_tokens":12}}}',
      'data: [DONE]'
    ]

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body))
      return sseResponse(sseLines)
    }))

    const adapter = new OpenAiAdapter()
    const deltas: ChatDelta[] = []
    const request: ChatRequest = {
      requestId: 'req-o1-1',
      model: 'o3-mini',
      messages: [
        { role: 'system', content: 'Developer guidelines.' },
        { role: 'user', content: 'Solve puzzle.' }
      ],
      maxTokens: 5000,
      temperature: 0.7,
      thinking: { enabled: true }
    }

    const response = await adapter.chat(request, (d) => deltas.push(d))

    expect(response.content).toBe('Answer')
    expect(response.thinkingContent).toBe('Thinking...')
    expect(response.usage).toEqual({ input: 15, output: 20, reasoning: 12 })

    // Reasoning model adaptations
    expect(capturedBody).not.toBeNull()
    const body = capturedBody!
    expect(body.temperature).toBeUndefined()
    expect(body.max_completion_tokens).toBe(5000)
    expect(body.reasoning_effort).toBe('medium')

    // System role converted to developer for reasoning models
    const msgs = body.messages as Array<{ role: string; content: unknown }>
    expect(msgs[0].role).toBe('developer')
  })

  it('handles standard models (gpt-4o) with temperature and max_tokens', async () => {
    let capturedBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body))
      return sseResponse([
        'data: {"id":"chatcmpl-4o","choices":[{"delta":{"content":"Standard response"}}],"usage":{"prompt_tokens":8,"completion_tokens":4}}',
        'data: [DONE]'
      ])
    }))

    const adapter = new OpenAiAdapter()
    const request: ChatRequest = {
      requestId: 'req-4o-1',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: 2048,
      temperature: 0.5
    }

    const response = await adapter.chat(request)
    expect(response.content).toBe('Standard response')
    const body = capturedBody!
    expect(body.temperature).toBe(0.5)
    expect(body.max_tokens).toBe(2048)
    expect(body.max_completion_tokens).toBeUndefined()
  })
})

describe('OpenAiCompatibleAdapter and ThinkTagStreamer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ThinkTagStreamer separates <think> tags from text deltas across chunk boundaries', () => {
    const streamer = new ThinkTagStreamer()
    const textChunks: string[] = []
    const thoughtChunks: string[] = []

    const onDelta = (d: ChatDelta) => {
      if (d.content) textChunks.push(d.content)
      if (d.thinkingContent) thoughtChunks.push(d.thinkingContent)
    }

    streamer.process('<th', onDelta) // partial tag
    expect(textChunks).toEqual([])
    expect(thoughtChunks).toEqual([])

    streamer.process('ink>Deep reasoning', onDelta)
    expect(thoughtChunks).toEqual(['Deep reasoning'])

    streamer.process(' here</th', onDelta) // partial end tag
    expect(thoughtChunks).toEqual(['Deep reasoning', ' here'])

    streamer.process('ink>Final plain answer.', onDelta)
    expect(textChunks).toEqual(['Final plain answer.'])

    const flushed = streamer.flush(onDelta)
    expect(flushed.text).toBe('')
    expect(flushed.thinking).toBe('')
  })

  it('extractThinkTags extracts thought blocks from non-streaming text', () => {
    const raw = '<think>Analyze problem thoroughly</think>Here is the solution.'
    const result = extractThinkTags(raw)
    expect(result.thinking).toBe('Analyze problem thoroughly')
    expect(result.text).toBe('Here is the solution.')
  })

  it('sends content: null (never an empty string) for assistant tool-call messages without text', async () => {
    let capturedBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(String(init.body))
      return sseResponse([
        'data: {"id":"cmpl-groq","choices":[{"delta":{"content":"Tool output read."}}]}',
        'data: [DONE]'
      ])
    }))

    const adapter = new OpenAiCompatibleAdapter({
      providerId: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1'
    })

    const request: ChatRequest = {
      requestId: 'req-groq-1',
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'user', content: 'Find files' },
        {
          role: 'assistant',
          content: null, // tool-call-only turn: sent as null, strict servers reject ''
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'grep', arguments: '{}' } }]
        },
        { role: 'tool', tool_call_id: 'tc1', content: 'result' }
      ]
    }

    await adapter.chat(request)
    expect(capturedBody).not.toBeNull()
    const msgs = capturedBody!.messages as Array<{ role: string; content: unknown }>
    expect(msgs[1].role).toBe('assistant')
    expect(msgs[1].content).toBeNull() // null, never '' (prevents 400 on strict OpenAI-compatible servers)
  })

  it('respects baseUrl override for custom/local endpoints (Ollama, LM Studio)', async () => {
    let capturedUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      capturedUrl = url
      return sseResponse([
        'data: {"id":"cmpl-custom","choices":[{"delta":{"content":"Local model responded."}}]}',
        'data: [DONE]'
      ])
    }))

    const adapter = new OpenAiCompatibleAdapter({
      providerId: 'custom',
      baseUrl: 'http://localhost:11434/v1'
    })

    const request: ChatRequest = {
      requestId: 'req-custom-1',
      model: 'qwen2.5-coder:14b',
      baseUrl: 'http://127.0.0.1:8080/v1',
      messages: [{ role: 'user', content: 'Local hello' }]
    }

    const response = await adapter.chat(request)
    expect(response.content).toBe('Local model responded.')
    expect(capturedUrl).toBe('http://127.0.0.1:8080/v1/chat/completions')
  })
})

describe('NanoGptAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extracts <think> tags in streaming mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return sseResponse([
        'data: {"id":"chatcmpl-nano","choices":[{"delta":{"content":"<think>Nano thinking block</think>Final answer."}}],"usage":{"prompt_tokens":10,"completion_tokens":20}}',
        'data: [DONE]'
      ])
    }))

    const adapter = new NanoGptAdapter()
    const deltas: ChatDelta[] = []
    const request: ChatRequest = {
      requestId: 'req-nano-1',
      model: 'zai-org/glm-5.2:thinking',
      messages: [{ role: 'user', content: 'Hello' }]
    }

    const response = await adapter.chat(request, (d) => deltas.push(d))
    expect(response.content).toBe('Final answer.')
    expect(response.thinkingContent).toBe('Nano thinking block')
  })

  it('extracts <think> tags in non-streaming mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: 'nano-json-1',
          choices: [
            {
              message: {
                role: 'assistant',
                content: '<think>Non-streaming thoughts</think>Direct result.'
              },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 5, completion_tokens: 15 }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }))

    const adapter = new NanoGptAdapter()
    const request: ChatRequest = {
      requestId: 'req-nano-2',
      model: 'deepseek/deepseek-v4-flash:thinking',
      messages: [{ role: 'user', content: 'Hello non-stream' }]
    }

    const response = await adapter.chat(request) // no onDelta callback -> non-streaming
    expect(response.content).toBe('Direct result.')
    expect(response.thinkingContent).toBe('Non-streaming thoughts')
  })
})
