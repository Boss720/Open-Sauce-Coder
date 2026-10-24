import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OpencodeBridgeAdapter,
  type OpencodeBridgeServerSeam
} from '../harness/providers/opencodeBridge'
import type { Event as OpencodeEvent, OpencodeClient } from '@opencode-ai/sdk'
import type { ChatDelta, ChatRequest } from '../harness/providers/adapter'

const SID = 'ephemeral-session-123'

describe('OpencodeBridgeAdapter hardening', () => {
  let mockClient: Record<string, Record<string, ReturnType<typeof vi.fn>>>
  let listeners: Set<(event: OpencodeEvent) => void>
  let seam: OpencodeBridgeServerSeam

  const assistantDone = {
    data: [
      {
        info: { role: 'assistant', finish: 'stop', tokens: { input: 1, output: 2, reasoning: 0 } },
        parts: [{ id: 'pt', type: 'text', text: 'final answer' }]
      }
    ]
  }

  beforeEach(() => {
    listeners = new Set()
    mockClient = {
      tool: { ids: vi.fn().mockResolvedValue({ data: ['bash', 'read'] }) },
      session: {
        create: vi.fn().mockResolvedValue({ data: { id: SID } }),
        promptAsync: vi.fn().mockResolvedValue(undefined),
        messages: vi.fn().mockResolvedValue(assistantDone),
        abort: vi.fn().mockResolvedValue(true),
        delete: vi.fn().mockResolvedValue(true)
      }
    }
    seam = {
      getStatus: vi.fn(() => ({ running: true, url: 'http://127.0.0.1:4599', streamConnected: true })),
      getClient: vi.fn(() => mockClient as unknown as OpencodeClient),
      onEvent: vi.fn((cb: (event: OpencodeEvent) => void) => {
        listeners.add(cb)
        return () => {
          listeners.delete(cb)
        }
      })
    } as unknown as OpencodeBridgeServerSeam
  })

  function emit(event: Record<string, unknown>): void {
    for (const l of listeners) l(event as unknown as OpencodeEvent)
  }

  const req = (extra: Partial<ChatRequest> = {}): ChatRequest => ({
    requestId: 'r1',
    model: 'default',
    messages: [{ role: 'user', content: 'SECRET PROMPT' }],
    ...extra
  })

  it('does not echo the session user message back as model output', async () => {
    mockClient.session.promptAsync.mockImplementation(async () => {
      emit({ type: 'message.updated', properties: { info: { id: 'u1', role: 'user', sessionID: SID } } })
      emit({
        type: 'message.part.updated',
        properties: {
          part: { id: 'up', messageID: 'u1', sessionID: SID, type: 'text', text: 'SECRET PROMPT' },
          delta: 'SECRET PROMPT'
        }
      })
      emit({
        type: 'message.part.updated',
        properties: {
          part: { id: 'ap', messageID: 'a1', sessionID: SID, type: 'text', text: 'hi' },
          delta: 'hi'
        }
      })
      emit({ type: 'session.idle', properties: { sessionID: SID } })
    })

    const deltas: ChatDelta[] = []
    const adapter = new OpencodeBridgeAdapter({ serverSeam: seam })
    await adapter.chat(req(), (d) => deltas.push(d))

    const streamed = deltas.map((d) => d.content ?? '').join('')
    expect(streamed).toBe('hi')
    expect(streamed).not.toContain('SECRET PROMPT')
  })

  it('appends only new text when part updates carry no delta', async () => {
    mockClient.session.promptAsync.mockImplementation(async () => {
      for (const text of ['Hel', 'Hello', 'Hello world']) {
        emit({
          type: 'message.part.updated',
          properties: { part: { id: 'ap', messageID: 'a1', sessionID: SID, type: 'text', text } }
        })
      }
      emit({ type: 'session.idle', properties: { sessionID: SID } })
    })

    const deltas: ChatDelta[] = []
    const adapter = new OpencodeBridgeAdapter({ serverSeam: seam })
    await adapter.chat(req(), (d) => deltas.push(d))

    expect(deltas.map((d) => d.content).join('')).toBe('Hello world')
  })

  it('rejects a request carrying tools before touching the session', async () => {
    const adapter = new OpencodeBridgeAdapter({ serverSeam: seam })
    await expect(
      adapter.chat(
        req({ tools: [{ name: 'read_file', description: 'd', parameters: {} }] as never })
      )
    ).rejects.toThrow(/does not support harness tools/)
    expect(mockClient.session.create).not.toHaveBeenCalled()
  })

  it('accepts an empty tools array', async () => {
    mockClient.session.promptAsync.mockImplementation(async () => {
      emit({ type: 'session.idle', properties: { sessionID: SID } })
    })
    const adapter = new OpencodeBridgeAdapter({ serverSeam: seam })
    const res = await adapter.chat(req({ tools: [] }))
    expect(res.content).toBe('final answer')
  })

  it('completes via message polling when session.idle never arrives', async () => {
    const adapter = new OpencodeBridgeAdapter({ serverSeam: seam, completionPollMs: 10, timeoutMs: 2000 })
    const res = await adapter.chat(req())
    expect(res.content).toBe('final answer')
    expect(mockClient.session.messages).toHaveBeenCalled()
  })

  it('fails fast when a polled assistant message carries an error', async () => {
    mockClient.session.messages.mockResolvedValue({
      data: [{ info: { role: 'assistant', error: { name: 'ProviderAuthError', data: { message: 'bad key' } } }, parts: [] }]
    })
    const adapter = new OpencodeBridgeAdapter({ serverSeam: seam, completionPollMs: 10, timeoutMs: 2000 })
    await expect(adapter.chat(req())).rejects.toThrow(/OpenCode session error/)
  })

  it('an early session.error does not leak an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      mockClient.tool.ids.mockImplementation(async () => {
        emit({ type: 'session.error', properties: { sessionID: SID, error: { message: 'boom' } } })
        return { data: ['bash'] }
      })
      mockClient.session.promptAsync.mockImplementation(async () => {
        emit({ type: 'session.idle', properties: { sessionID: SID } })
      })
      const adapter = new OpencodeBridgeAdapter({ serverSeam: seam, completionPollMs: 5000 })
      await adapter.chat(req()).catch(() => {})
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
