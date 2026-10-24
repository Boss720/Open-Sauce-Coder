import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OpencodeBridgeAdapter,
  type OpencodeBridgeServerSeam
} from '../harness/providers/opencodeBridge'
import type { Event as OpencodeEvent, OpencodeClient } from '@opencode-ai/sdk'
import type { ChatRequest } from '../harness/providers/adapter'
import type { ServerStatus } from '../server'

describe('OpencodeBridgeAdapter Adversarial Stress Tests', () => {
  let mockStatus: ServerStatus
  let mockClient: Record<string, Record<string, ReturnType<typeof vi.fn>>>
  let eventListeners: Set<(event: OpencodeEvent) => void>
  let serverSeam: OpencodeBridgeServerSeam
  let createdSessions: Set<string>
  let deletedSessions: Set<string>

  const listenerErrors: unknown[] = []

  beforeEach(() => {
    listenerErrors.length = 0
    mockStatus = {
      running: true,
      url: 'http://127.0.0.1:4599',
      streamConnected: true
    }

    eventListeners = new Set()
    createdSessions = new Set()
    deletedSessions = new Set()

    mockClient = {
      tool: {
        ids: vi.fn().mockResolvedValue({ data: ['bash', 'edit', 'read', 'write', 'mcp__example__run'] })
      },
      session: {
        create: vi.fn(async ({ body }: { body: { title: string } }) => {
          const match = body?.title?.match(/\[(.*?)\]/)
          const reqId = match ? match[1] : 'unknown'
          const id = `session-for-${reqId}`
          createdSessions.add(id)
          return { data: { id } }
        }),
        promptAsync: vi.fn().mockResolvedValue(undefined),
        messages: vi.fn(async ({ path }: { path: { id: string } }) => {
          return {
            data: [
              {
                info: {
                  role: 'assistant',
                  finish: 'stop',
                  tokens: { input: 10, output: 20, reasoning: 5 }
                },
                parts: [
                  {
                    id: `part-t-${path.id}`,
                    sessionID: path.id,
                    type: 'text',
                    text: `Final response for ${path.id}`
                  }
                ]
              }
            ]
          }
        }),
        abort: vi.fn().mockResolvedValue(true),
        delete: vi.fn(async ({ path }: { path: { id: string } }) => {
          deletedSessions.add(path.id)
          return true
        })
      }
    }

    serverSeam = {
      getStatus: vi.fn(() => mockStatus),
      getClient: vi.fn(() => mockClient as unknown as OpencodeClient),
      onEvent: vi.fn((cb: (event: OpencodeEvent) => void) => {
        eventListeners.add(cb)
        return () => {
          eventListeners.delete(cb)
        }
      })
    }
  })


  function emitEvent(event: Record<string, unknown> | null | undefined): void {
    for (const listener of Array.from(eventListeners)) {
      try {
        listener(event as unknown as OpencodeEvent)
      } catch (err) {
        // Mirrors server.ts: the server loop swallows listener errors, but we record them
        listenerErrors.push(err)
      }
    }
  }

  // =========================================================================
  // 1. Concurrent turns / requests through the adapter
  // =========================================================================
  describe('1. Concurrency Stress Tests', () => {
    it('handles 20 concurrent chat turns without cross-talk or race conditions', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const turnCount = 20
      const receivedDeltas: Map<string, string[]> = new Map()

      // Track promptAsync invocations
      const activeIds: string[] = []
      mockClient.session.promptAsync.mockImplementation(async ({ path }: { path: { id: string } }) => {
        activeIds.push(path.id)
      })

      // Launch 20 concurrent requests
      const promises = Array.from({ length: turnCount }, (_, i) => {
        const reqId = `req-concurrent-${i}`
        receivedDeltas.set(reqId, [])
        const req: ChatRequest = {
          requestId: reqId,
          model: 'default',
          messages: [{ role: 'user', content: `Task ${i}` }]
        }
        return adapter.chat(req, (delta) => {
          if (delta.content) {
            receivedDeltas.get(reqId)!.push(delta.content)
          }
        })
      })

      // Wait a tick for all sessions to be created and promptAsync called
      await new Promise((r) => setTimeout(r, 20))

      expect(createdSessions.size).toBe(turnCount)
      expect(eventListeners.size).toBe(turnCount)

      // Emit interleaved events across all 20 sessions in shuffled order
      for (let step = 0; step < 3; step++) {
        for (let i = 0; i < turnCount; i++) {
          const sid = `session-for-req-concurrent-${i}`
          emitEvent({
            type: 'message.part.updated',
            properties: {
              part: {
                sessionID: sid,
                type: 'text'
              },
              delta: `chunk_${step}_for_${i} `
            }
          })
        }
      }

      // Conclude each session with session.idle
      for (let i = 0; i < turnCount; i++) {
        const sid = `session-for-req-concurrent-${i}`
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: sid }
        })
      }

      const results = await Promise.all(promises)

      // Verify each request received only its own deltas and correct responses
      expect(results.length).toBe(turnCount)
      for (let i = 0; i < turnCount; i++) {
        const reqId = `req-concurrent-${i}`
        const deltas = receivedDeltas.get(reqId)!
        expect(deltas).toEqual([`chunk_0_for_${i} `, `chunk_1_for_${i} `, `chunk_2_for_${i} `])
        expect(results[i].id).toBe(`session-for-${reqId}`)
        expect(results[i].content).toBe(`Final response for session-for-${reqId}`)
      }

      // Verify all sessions were deleted in finally
      expect(deletedSessions.size).toBe(turnCount)
      for (let i = 0; i < turnCount; i++) {
        expect(deletedSessions.has(`session-for-req-concurrent-${i}`)).toBe(true)
      }

      // Verify all listeners unsubscribed
      expect(eventListeners.size).toBe(0)
    })

    it('handles partial aborts among concurrent requests cleanly without affecting surviving requests', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const abortSignals = [new AbortController(), new AbortController(), new AbortController()]

      const reqs: ChatRequest[] = [
        { requestId: 'req-survivor-1', model: 'default', messages: [{ role: 'user', content: '1' }] },
        { requestId: 'req-aborted-adapter', model: 'default', messages: [{ role: 'user', content: '2' }] },
        { requestId: 'req-aborted-signal', model: 'default', messages: [{ role: 'user', content: '3' }], signal: abortSignals[2].signal },
        { requestId: 'req-survivor-2', model: 'default', messages: [{ role: 'user', content: '4' }] }
      ]

      const p0 = adapter.chat(reqs[0])
      const p1 = adapter.chat(reqs[1])
      const p2 = adapter.chat(reqs[2])
      const p3 = adapter.chat(reqs[3])

      await new Promise((r) => setTimeout(r, 20))

      // Abort p1 via adapter.abort
      adapter.abort('req-aborted-adapter')

      // Abort p2 via AbortController signal
      abortSignals[2].abort()

      // Allow survivors to complete via session.idle
      emitEvent({
        type: 'session.idle',
        properties: { sessionID: 'session-for-req-survivor-1' }
      })
      emitEvent({
        type: 'session.idle',
        properties: { sessionID: 'session-for-req-survivor-2' }
      })

      const [res0, err1, err2, res3] = await Promise.all([
        p0,
        p1.catch((e) => e),
        p2.catch((e) => e),
        p3
      ])

      // Survivors succeeded
      expect(res0.id).toBe('session-for-req-survivor-1')
      expect(res3.id).toBe('session-for-req-survivor-2')

      // Aborted rejected with proper abort messages
      expect(err1).toBeInstanceOf(Error)
      expect(err1.message).toMatch(/aborted/)
      expect(err2).toBeInstanceOf(Error)
      expect(err2.message).toMatch(/aborted/)

      // All 4 sessions deleted
      expect(deletedSessions.size).toBe(4)
      expect(eventListeners.size).toBe(0)
    })

    it('demonstrates duplicate requestId collision: composite keying preserves active entry of second request', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      // Two requests sharing the same requestId
      const req1: ChatRequest = { requestId: 'collision-id', model: 'default', messages: [{ role: 'user', content: '1' }] }
      const req2: ChatRequest = { requestId: 'collision-id', model: 'default', messages: [{ role: 'user', content: '2' }] }

      // Custom create to distinguish sessions
      let callCount = 0
      mockClient.session.create.mockImplementation(async () => {
        callCount++
        const id = `session-collision-${callCount}`
        createdSessions.add(id)
        return { data: { id } }
      })

      const p1 = adapter.chat(req1)
      await new Promise((r) => setTimeout(r, 10))
      const p2 = adapter.chat(req2)
      await new Promise((r) => setTimeout(r, 10))

      // Complete req1 first
      emitEvent({
        type: 'session.idle',
        properties: { sessionID: 'session-collision-1' }
      })

      await p1

      // Now req1's finally has run.
      // Abort req2 using adapter.abort('collision-id')
      adapter.abort('collision-id')

      // With composite keying, req2 was NOT evicted and was properly aborted
      expect(mockClient.session.abort).toHaveBeenCalledWith(
        expect.objectContaining({ path: { id: 'session-collision-2' } })
      )

      await expect(p2).rejects.toThrow('Request collision-id was aborted.')
    })
  })

  // =========================================================================
  // 2. Sudden server crash or stream error during streaming
  // =========================================================================
  describe('2. Crash, Stream Error & Socket Termination Tests', () => {
    it('handles session.error with various error shapes without hanging or crashing', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'session.error',
          properties: {
            sessionID: 'session-for-req-err-shape',
            error: { data: { message: 'Custom API error message from server' } }
          }
        })
      })

      await expect(
        adapter.chat({
          requestId: 'req-err-shape',
          model: 'default',
          messages: [{ role: 'user', content: 'test' }]
        })
      ).rejects.toThrow('Custom API error message from server')

      expect(deletedSessions.has('session-for-req-err-shape')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })

    it('handles session.error with string error directly', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'session.error',
          properties: {
            sessionID: 'session-for-req-err-str',
            error: 'Direct string error payload'
          }
        })
      })

      await expect(
        adapter.chat({
          requestId: 'req-err-str',
          model: 'default',
          messages: [{ role: 'user', content: 'test' }]
        })
      ).rejects.toThrow('Direct string error payload')

      expect(deletedSessions.has('session-for-req-err-str')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })

    it('handles circular error objects in session.error without hanging indefinitely', async () => {
      // Adversarial case: error is an object with circular reference and no message property
      const adapter = new OpencodeBridgeAdapter({
        serverSeam,
        timeoutMs: 100 // Short timeout for testing hang resilience
      })

      const circularObj: Record<string, unknown> = {}
      circularObj.self = circularObj

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'session.error',
          properties: {
            sessionID: 'session-for-req-circ',
            error: circularObj
          }
        })
      })

      // What happens here?
      // In opencodeBridge.ts, line 174 does `JSON.stringify(err)`.
      // If it throws TypeError: Converting circular structure to JSON,
      // it might crash inside onEvent or cause rejectIdle to not be called.
      // Let's observe the behavior!
      try {
        await adapter.chat({
          requestId: 'req-circ',
          model: 'default',
          messages: [{ role: 'user', content: 'test' }]
        })
        expect.fail('Should have rejected')
      } catch (err: unknown) {
        expect(err instanceof Error ? err.message : String(err)).toMatch(/OpenCode session error:/)
        expect(deletedSessions.has('session-for-req-circ')).toBe(true)
        expect(eventListeners.size).toBe(0)
      }
    })

    it('handles sudden transport failure when promptAsync rejects (ECONNREFUSED / crash)', async () => {
      mockClient.session.promptAsync.mockRejectedValueOnce(
        new Error('connect ECONNREFUSED 127.0.0.1:4599')
      )

      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      await expect(
        adapter.chat({
          requestId: 'req-econnrefused',
          model: 'default',
          messages: [{ role: 'user', content: 'test' }]
        })
      ).rejects.toThrow('connect ECONNREFUSED 127.0.0.1:4599')

      expect(deletedSessions.has('session-for-req-econnrefused')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })

    it('handles double-fault: promptAsync rejects AND session.delete rejects without masking original error', async () => {
      mockClient.session.promptAsync.mockRejectedValueOnce(
        new Error('Primary transport failure')
      )
      mockClient.session.delete.mockRejectedValueOnce(
        new Error('Secondary deletion failure - server process dead')
      )

      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      // Original error must be preserved
      await expect(
        adapter.chat({
          requestId: 'req-double-fault',
          model: 'default',
          messages: [{ role: 'user', content: 'test' }]
        })
      ).rejects.toThrow('Primary transport failure')

      expect(eventListeners.size).toBe(0)
    })

    it('handles socket termination / stream stall where no events ever arrive via timeout', async () => {
      const adapter = new OpencodeBridgeAdapter({
        serverSeam,
        timeoutMs: 40
      })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        // Socket closed silently; no session.idle or session.error ever arrives
      })

      await expect(
        adapter.chat({
          requestId: 'req-stall',
          model: 'default',
          messages: [{ role: 'user', content: 'stall test' }]
        })
      ).rejects.toThrow(/timed out after 40ms/)

      expect(deletedSessions.has('session-for-req-stall')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })
  })

  // =========================================================================
  // 3. Abort signal triggered mid-stream
  // =========================================================================
  describe('3. Abort Signal Triggered Mid-Stream', () => {
    it('aborts mid-stream when request.signal fires after partial chunks', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const controller = new AbortController()
      const deltas: string[] = []

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        // Emit first chunk
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: { sessionID: 'session-for-req-mid-abort', type: 'text' },
            delta: 'First chunk '
          }
        })
        // Mid-stream abort
        setTimeout(() => {
          controller.abort()
        }, 10)
      })

      await expect(
        adapter.chat(
          {
            requestId: 'req-mid-abort',
            model: 'default',
            messages: [{ role: 'user', content: 'cancel mid stream' }],
            signal: controller.signal
          },
          (d) => {
            if (d.content) deltas.push(d.content)
          }
        )
      ).rejects.toThrow('Request req-mid-abort was aborted.')

      expect(deltas).toEqual(['First chunk '])
      expect(deletedSessions.has('session-for-req-mid-abort')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })

    it('aborts mid-stream via adapter.abort(requestId) after reasoning chunks', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const thinkingDeltas: string[] = []

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: { sessionID: 'session-for-req-mid-adapter-abort', type: 'reasoning' },
            delta: 'Thinking start...'
          }
        })
        setTimeout(() => {
          adapter.abort('req-mid-adapter-abort')
        }, 10)
      })

      await expect(
        adapter.chat(
          {
            requestId: 'req-mid-adapter-abort',
            model: 'default',
            messages: [{ role: 'user', content: 'cancel mid thinking' }]
          },
          (d) => {
            if (d.thinkingContent) thinkingDeltas.push(d.thinkingContent)
          }
        )
      ).rejects.toThrow('Request req-mid-adapter-abort was aborted.')

      expect(thinkingDeltas).toEqual(['Thinking start...'])
      expect(mockClient.session.abort).toHaveBeenCalledWith({
        path: { id: 'session-for-req-mid-adapter-abort' },
        query: { directory: expect.any(String) }
      })
      expect(deletedSessions.has('session-for-req-mid-adapter-abort')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })

    it('guards against pre-dispatch abort and does not call promptAsync', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const controller = new AbortController()

      mockClient.session.create.mockImplementationOnce(async () => {
        // Abort happens right after session creation, before promptAsync is dispatched
        controller.abort()
        return { data: { id: 'session-aborted-before-prompt' } }
      })

      await expect(
        adapter.chat({
          requestId: 'req-abort-before-prompt',
          model: 'default',
          messages: [{ role: 'user', content: 'test' }],
          signal: controller.signal
        })
      ).rejects.toThrow(/was aborted/)

      expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
      expect(mockClient.session.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          path: { id: 'session-aborted-before-prompt' }
        })
      )
    })

    it('calling adapter.abort on non-existent or already finished request is safe no-op', () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      expect(() => adapter.abort('non-existent-id')).not.toThrow()
    })

    it('late abort after turn has settled does not cause unhandled rejections', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const controller = new AbortController()

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'session-for-req-late-abort' }
        })
      })

      const res = await adapter.chat({
        requestId: 'req-late-abort',
        model: 'default',
        messages: [{ role: 'user', content: 'fast task' }],
        signal: controller.signal
      })

      expect(res.id).toBe('session-for-req-late-abort')

      // Trigger late abort now that chat has returned
      expect(() => controller.abort()).not.toThrow()

      // Give a tick for any asynchronous event loops
      await new Promise((r) => setTimeout(r, 20))
    })
  })

  // =========================================================================
  // 4. Malformed SSE payloads or unexpected event sequences
  // =========================================================================
  describe('4. Malformed SSE Payloads & Event Sequences', () => {
    it('safely tolerates malformed, null, undefined, or unknown SSE events without throwing', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        // Emit hostile/corrupted event payloads
        emitEvent(null)
        emitEvent(undefined)
        emitEvent({} as unknown as OpencodeEvent)
        emitEvent({ type: 'unknown.exotic.event', properties: { foo: 'bar' } })
        emitEvent({ type: 'message.part.updated' } as unknown as OpencodeEvent) // missing properties
        emitEvent({ type: 'message.part.updated', properties: null } as unknown as OpencodeEvent)
        emitEvent({ type: 'message.part.updated', properties: { part: null } } as unknown as OpencodeEvent)
        emitEvent({ type: 'session.idle', properties: null } as unknown as OpencodeEvent)
        emitEvent({ type: 'session.error', properties: null } as unknown as OpencodeEvent)
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: { sessionID: 'session-for-req-malformed', type: 'unknown_type' }
          }
        } as unknown as OpencodeEvent)

        // Then emit valid text delta
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: { sessionID: 'session-for-req-malformed', type: 'text' },
            delta: 'Recovered from malformed events!'
          }
        })

        // Finish
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'session-for-req-malformed' }
        })
      })

      const res = await adapter.chat({
        requestId: 'req-malformed',
        model: 'default',
        messages: [{ role: 'user', content: 'test malformed' }]
      })

      expect(listenerErrors).toEqual([])
      expect(res.id).toBe('session-for-req-malformed')
      expect(res.content).toBe('Final response for session-for-req-malformed')
      expect(deletedSessions.has('session-for-req-malformed')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })

    it('completely ignores events from other session IDs', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const deltas: string[] = []

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        // Alien events for other session
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: { sessionID: 'alien-session-id', type: 'text' },
            delta: 'ALIEN DELTA'
          }
        })
        emitEvent({
          type: 'session.error',
          properties: { sessionID: 'alien-session-id', error: 'Alien error' }
        })
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'alien-session-id' }
        })

        // Real events for our session
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: { sessionID: 'session-for-req-alien-test', type: 'text' },
            delta: 'REAL DELTA'
          }
        })
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'session-for-req-alien-test' }
        })
      })

      const res = await adapter.chat(
        {
          requestId: 'req-alien-test',
          model: 'default',
          messages: [{ role: 'user', content: 'test isolation' }]
        },
        (d) => {
          if (d.content) deltas.push(d.content)
        }
      )

      expect(deltas).toEqual(['REAL DELTA'])
      expect(res.id).toBe('session-for-req-alien-test')
      expect(deletedSessions.has('session-for-req-alien-test')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })

    it('handles multiple consecutive session.idle events idempotently', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'session-for-req-multi-idle' }
        })
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'session-for-req-multi-idle' }
        })
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'session-for-req-multi-idle' }
        })
      })

      const res = await adapter.chat({
        requestId: 'req-multi-idle',
        model: 'default',
        messages: [{ role: 'user', content: 'multi idle' }]
      })

      expect(res.id).toBe('session-for-req-multi-idle')
      expect(deletedSessions.has('session-for-req-multi-idle')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })

    it('tolerates session.messages failure gracefully by returning accumulated streaming text', async () => {
      mockClient.session.messages.mockRejectedValueOnce(
        new Error('HTTP 502 Bad Gateway while fetching messages')
      )

      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: { sessionID: 'session-for-req-msg-fail', type: 'text' },
            delta: 'Accumulated stream text'
          }
        })
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'session-for-req-msg-fail' }
        })
      })

      const res = await adapter.chat({
        requestId: 'req-msg-fail',
        model: 'default',
        messages: [{ role: 'user', content: 'test' }]
      })

      expect(res.content).toBe('Accumulated stream text')
      expect(deletedSessions.has('session-for-req-msg-fail')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })

    it('examines behavior when session.messages returns only user prompt without assistant response', async () => {
      // Adversarial test: what happens if session.messages only contains user message?
      mockClient.session.messages.mockResolvedValueOnce({
        data: [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'This is the user prompt' }]
          }
        ]
      })

      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'session-for-req-user-only' }
        })
      })

      await expect(
        adapter.chat({
          requestId: 'req-user-only',
          model: 'default',
          messages: [{ role: 'user', content: 'This is the user prompt' }]
        })
      ).rejects.toThrow('OpenCode server session ended without producing an assistant response.')

      expect(deletedSessions.has('session-for-req-user-only')).toBe(true)
      expect(eventListeners.size).toBe(0)
    })
  })

  // =========================================================================
  // 5. Verify sessions are always deleted in finally and no memory/listener leaks
  // =========================================================================
  describe('5. Session Deletion & Leak Prevention', () => {
    it('guarantees session deletion across all possible failure paths', async () => {
      const adapter = new OpencodeBridgeAdapter({
        serverSeam,
        timeoutMs: 30
      })

      const paths = [
        // Path A: normal completion
        {
          id: 'path-normal',
          setup: () => {
            mockClient.session.promptAsync.mockImplementationOnce(async () => {
              emitEvent({
                type: 'session.idle',
                properties: { sessionID: 'session-for-path-normal' }
              })
            })
          },
          action: () => adapter.chat({ requestId: 'path-normal', model: 'default', messages: [{ role: 'user', content: 'ok' }] }),
          shouldFail: false
        },
        // Path B: promptAsync network error
        {
          id: 'path-prompt-err',
          setup: () => {
            mockClient.session.promptAsync.mockRejectedValueOnce(new Error('Prompt error'))
          },
          action: () => adapter.chat({ requestId: 'path-prompt-err', model: 'default', messages: [{ role: 'user', content: 'err' }] }),
          shouldFail: true
        },
        // Path C: session.error event
        {
          id: 'path-session-err',
          setup: () => {
            mockClient.session.promptAsync.mockImplementationOnce(async () => {
              emitEvent({
                type: 'session.error',
                properties: { sessionID: 'session-for-path-session-err', error: 'Server error' }
              })
            })
          },
          action: () => adapter.chat({ requestId: 'path-session-err', model: 'default', messages: [{ role: 'user', content: 'err' }] }),
          shouldFail: true
        },
        // Path D: timeout
        {
          id: 'path-timeout',
          setup: () => {
            mockClient.session.promptAsync.mockImplementationOnce(async () => {
              /* never emits idle */
            })
          },
          action: () => adapter.chat({ requestId: 'path-timeout', model: 'default', messages: [{ role: 'user', content: 'timeout' }] }),
          shouldFail: true
        },
        // Path E: mid-stream adapter.abort
        {
          id: 'path-abort-adapter',
          setup: () => {
            mockClient.session.promptAsync.mockImplementationOnce(async () => {
              setTimeout(() => adapter.abort('path-abort-adapter'), 5)
            })
          },
          action: () => adapter.chat({ requestId: 'path-abort-adapter', model: 'default', messages: [{ role: 'user', content: 'abort' }] }),
          shouldFail: true
        }
      ]

      for (const p of paths) {
        p.setup()
        if (p.shouldFail) {
          await expect(p.action()).rejects.toThrow()
        } else {
          const out = await p.action()
          expect(out.id).toBe(`session-for-${p.id}`)
          expect(out.content).toBe(`Final response for session-for-${p.id}`)
        }
        expect(deletedSessions.has(`session-for-${p.id}`)).toBe(true)
        expect(eventListeners.size).toBe(0)
      }
    })

    it('tests memory leak / listener leak on reused AbortSignal across multiple sequential turns', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const controller = new AbortController()

      mockClient.session.promptAsync.mockImplementation(async ({ path }: { path: { id: string } }) => {
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: path.id }
        })
      })

      // Track removeEventListener calls
      const removeSpy = vi.spyOn(controller.signal, 'removeEventListener')

      // Run 15 sequential turns using the same AbortController signal
      for (let i = 0; i < 15; i++) {
        await adapter.chat({
          requestId: `req-reuse-${i}`,
          model: 'default',
          messages: [{ role: 'user', content: `turn ${i}` }],
          signal: controller.signal
        })
      }

      // Empirically verify that removeEventListener was NEVER called across all 15 completed turns!
      // Verify that removeEventListener was cleanly called for each turn
      expect(removeSpy).toHaveBeenCalledTimes(15)

      // Verify all sessions cleaned up
      expect(createdSessions.size).toBe(15)
      expect(deletedSessions.size).toBe(15)
      expect(eventListeners.size).toBe(0)
    })
  })
})
