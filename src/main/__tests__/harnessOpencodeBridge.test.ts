import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OpencodeBridgeAdapter,
  type OpencodeBridgeServerSeam
} from '../harness/providers/opencodeBridge'
import { providerRegistry } from '../harness/providers/registry'
import { BUILTIN_PROFILES } from '../harness/profiles'
import { catalogByProvider, OPENCODE_PROVIDER } from '../providerCatalog'
import type { Event as OpencodeEvent, OpencodeClient } from '@opencode-ai/sdk'
import type { ChatRequest, ChatDelta } from '../harness/providers/adapter'
import type { ServerStatus } from '../server'

describe('OpencodeBridgeAdapter', () => {
  let mockStatus: ServerStatus
  let mockClient: Record<string, Record<string, ReturnType<typeof vi.fn>>>
  let eventListeners: Set<(event: OpencodeEvent) => void>
  let serverSeam: OpencodeBridgeServerSeam

  beforeEach(() => {
    mockStatus = {
      running: true,
      url: 'http://127.0.0.1:4599',
      streamConnected: true
    }

    eventListeners = new Set()

    mockClient = {
      tool: {
        ids: vi.fn().mockResolvedValue({ data: ['bash', 'edit', 'read', 'write', 'mcp__example__run'] })
      },
      session: {
        create: vi.fn().mockResolvedValue({
          data: { id: 'ephemeral-session-123' }
        }),
        promptAsync: vi.fn().mockResolvedValue(undefined),
        messages: vi.fn().mockResolvedValue({
          data: [
            {
              info: {
                role: 'assistant',
                finish: 'stop',
                tokens: { input: 12, output: 42, reasoning: 8 }
              },
              parts: [
                {
                  id: 'part-r1',
                  sessionID: 'ephemeral-session-123',
                  messageID: 'msg-1',
                  type: 'reasoning',
                  text: 'Pondering the solution...'
                },
                {
                  id: 'part-t1',
                  sessionID: 'ephemeral-session-123',
                  messageID: 'msg-1',
                  type: 'text',
                  text: 'Here is the answer.'
                }
              ]
            }
          ]
        }),
        abort: vi.fn().mockResolvedValue(true),
        delete: vi.fn().mockResolvedValue(true)
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

  function emitEvent(event: Record<string, unknown>): void {
    for (const listener of eventListeners) {
      listener(event as unknown as OpencodeEvent)
    }
  }

  describe('probe', () => {
    it('returns true when the OpenCode server is running', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const result = await adapter.probe()
      expect(result).toBe(true)
      expect(serverSeam.getStatus).toHaveBeenCalled()
    })

    it('returns false when the OpenCode server is offline', async () => {
      mockStatus.running = false
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const result = await adapter.probe()
      expect(result).toBe(false)
    })

    it('returns false when getStatus throws an error', async () => {
      ;(serverSeam.getStatus as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('Process table unreadable')
      })
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const result = await adapter.probe()
      expect(result).toBe(false)
    })
  })

  describe('chat validation and offline guard', () => {
    it('throws descriptive error if server is not running', async () => {
      mockStatus.running = false
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const req: ChatRequest = {
        requestId: 'req-offline',
        model: 'default',
        messages: [{ role: 'user', content: 'hello' }]
      }

      await expect(adapter.chat(req)).rejects.toThrow(
        'OpenCode server is not running. Please start the server or wait for initialization.'
      )
      expect(mockClient.session.create).not.toHaveBeenCalled()
    })

    it('throws immediately if request signal is already aborted', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const controller = new AbortController()
      controller.abort()

      const req: ChatRequest = {
        requestId: 'req-pre-aborted',
        model: 'default',
        messages: [{ role: 'user', content: 'hello' }],
        signal: controller.signal
      }

      await expect(adapter.chat(req)).rejects.toThrow(
        'Request req-pre-aborted was aborted prior to execution.'
      )
      expect(mockClient.session.create).not.toHaveBeenCalled()
    })
  })

  describe('single-turn execution and streaming', () => {
    it('successfully completes single-turn chat with promptAsync and session.idle', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const deltas: ChatDelta[] = []

      // When promptAsync is called, emit streaming part updates and then session.idle
      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        // Emit reasoning chunk
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'ephemeral-session-123',
              type: 'reasoning',
              text: 'Pondering the solution...'
            },
            delta: 'Pondering '
          }
        })
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'ephemeral-session-123',
              type: 'reasoning',
              text: 'Pondering the solution...'
            },
            delta: 'the solution...'
          }
        })

        // Emit text chunk
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'ephemeral-session-123',
              type: 'text',
              text: 'Here is the answer.'
            },
            delta: 'Here is '
          }
        })
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'ephemeral-session-123',
              type: 'text',
              text: 'Here is the answer.'
            },
            delta: 'the answer.'
          }
        })

        // Complete generation
        emitEvent({
          type: 'session.idle',
          properties: {
            sessionID: 'ephemeral-session-123'
          }
        })
      })

      const req: ChatRequest = {
        requestId: 'req-chat-1',
        model: 'default',
        messages: [
          { role: 'system', content: 'You are a helpful coding assistant.' },
          { role: 'user', content: 'Write a quicksort in TypeScript.' }
        ]
      }

      const response = await adapter.chat(req, (delta) => {
        deltas.push(delta)
      })

      // Verify session creation
      expect(mockClient.session.create).toHaveBeenCalledWith({
        query: { directory: expect.any(String) },
        body: { title: 'Harness [req-chat-1]' }
      })

      // Verify prompt dispatch
      expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
        path: { id: 'ephemeral-session-123' },
        query: { directory: expect.any(String) },
        body: {
          parts: [{ type: 'text', text: 'Write a quicksort in TypeScript.' }],
          system: 'You are a helpful coding assistant.',
          tools: { bash: false, edit: false, read: false, write: false, mcp__example__run: false }
        }
      })

      expect(mockClient.tool.ids).toHaveBeenCalledWith({ query: { directory: expect.any(String) } })

      // Verify streaming deltas delivered
      expect(deltas.length).toBe(4)
      expect(deltas[0]).toEqual({ thinkingContent: 'Pondering ' })
      expect(deltas[1]).toEqual({ thinkingContent: 'the solution...' })
      expect(deltas[2]).toEqual({ content: 'Here is ' })
      expect(deltas[3]).toEqual({ content: 'the answer.' })

      // Verify response structure
      expect(response.id).toBe('ephemeral-session-123')
      expect(response.content).toBe('Here is the answer.')
      expect(response.thinkingContent).toBe('Pondering the solution...')
      expect(response.finishReason).toBe('stop')
      expect(response.usage).toEqual({ input: 12, output: 42, reasoning: 8 })

      // Verify session cleanup
      expect(mockClient.session.delete).toHaveBeenCalledWith({
        path: { id: 'ephemeral-session-123' },
        query: { directory: expect.any(String) }
      })
      // Verify listener unsubscribed
      expect(eventListeners.size).toBe(0)
    })

    it('passes model specification when custom model with provider prefix is provided', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'ephemeral-session-123' }
        })
      })

      const req: ChatRequest = {
        requestId: 'req-model-custom',
        model: 'anthropic/claude-3-7-sonnet',
        messages: [{ role: 'user', content: 'Hello model' }]
      }

      await adapter.chat(req)

      expect(mockClient.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            model: { providerID: 'anthropic', modelID: 'claude-3-7-sonnet' }
          })
        })
      )
    })

    it('fails closed and cleans up the session when tool IDs cannot be loaded', async () => {
      mockClient.tool.ids.mockRejectedValueOnce(new Error('tool inventory unavailable'))
      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      await expect(adapter.chat({
        requestId: 'req-tool-inventory-failed',
        model: 'default',
        messages: [{ role: 'user', content: 'run something' }]
      })).rejects.toThrow('tool inventory unavailable')

      expect(mockClient.session.promptAsync).not.toHaveBeenCalled()
      expect(mockClient.session.delete).toHaveBeenCalledWith(expect.objectContaining({
        path: { id: 'ephemeral-session-123' }
      }))
    })

    it('handles fallback token calculation when session messages provides no tokens', async () => {
      mockClient.session.messages.mockResolvedValueOnce({
        data: []
      })

      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'ephemeral-session-123',
              type: 'text'
            },
            delta: 'Fallback response text'
          }
        })
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'ephemeral-session-123' }
        })
      })

      const response = await adapter.chat({
        requestId: 'req-fallback',
        model: 'default',
        messages: [{ role: 'user', content: 'Ping' }]
      })

      expect(response.content).toBe('Fallback response text')
      expect(response.usage.output).toBeGreaterThan(0)
      expect(response.usage.input).toBeGreaterThan(0)
    })
  })

  describe('ephemeral session cleanup', () => {
    it('cleans up session even when promptAsync rejects', async () => {
      mockClient.session.promptAsync.mockRejectedValueOnce(
        new Error('Network transport collapsed')
      )

      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      await expect(
        adapter.chat({
          requestId: 'req-fail',
          model: 'default',
          messages: [{ role: 'user', content: 'Boom' }]
        })
      ).rejects.toThrow('Network transport collapsed')

      expect(mockClient.session.delete).toHaveBeenCalledWith({
        path: { id: 'ephemeral-session-123' },
        query: { directory: expect.any(String) }
      })
      expect(eventListeners.size).toBe(0)
    })

    it('cleans up session when session.error event is received', async () => {
      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'session.error',
          properties: {
            sessionID: 'ephemeral-session-123',
            error: { message: 'Context window exceeded maximum budget' }
          }
        })
      })

      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      await expect(
        adapter.chat({
          requestId: 'req-error-event',
          model: 'default',
          messages: [{ role: 'user', content: 'Trigger error' }]
        })
      ).rejects.toThrow('OpenCode session error: Context window exceeded maximum budget')

      expect(mockClient.session.delete).toHaveBeenCalledWith({
        path: { id: 'ephemeral-session-123' },
        query: { directory: expect.any(String) }
      })
      expect(eventListeners.size).toBe(0)
    })
  })

  describe('abort handling', () => {
    it('aborts in-flight execution when abort(requestId) is called', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        // Asynchronously call adapter.abort after prompt starts
        setTimeout(() => {
          adapter.abort('req-to-abort')
        }, 10)
      })

      await expect(
        adapter.chat({
          requestId: 'req-to-abort',
          model: 'default',
          messages: [{ role: 'user', content: 'Long running task' }]
        })
      ).rejects.toThrow('Request req-to-abort was aborted.')

      // Verifies client.session.abort was invoked
      expect(mockClient.session.abort).toHaveBeenCalledWith({
        path: { id: 'ephemeral-session-123' },
        query: { directory: expect.any(String) }
      })

      // Verifies cleanup ran
      expect(mockClient.session.delete).toHaveBeenCalledWith({
        path: { id: 'ephemeral-session-123' },
        query: { directory: expect.any(String) }
      })
    })

    it('aborts when request AbortSignal fires during execution', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const controller = new AbortController()

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        setTimeout(() => {
          controller.abort()
        }, 10)
      })

      await expect(
        adapter.chat({
          requestId: 'req-signal-abort',
          model: 'default',
          messages: [{ role: 'user', content: 'Cancel me' }],
          signal: controller.signal
        })
      ).rejects.toThrow('Request req-signal-abort was aborted.')

      expect(mockClient.session.delete).toHaveBeenCalled()
    })
  })

  describe('timeout handling', () => {
    it('rejects with timeout error when generation exceeds timeoutMs', async () => {
      const adapter = new OpencodeBridgeAdapter({
        serverSeam,
        timeoutMs: 30
      })

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        // Do not emit session.idle; let it stall
      })

      await expect(
        adapter.chat({
          requestId: 'req-timeout',
          model: 'default',
          messages: [{ role: 'user', content: 'Stall test' }]
        })
      ).rejects.toThrow('timed out after 30ms')

      expect(mockClient.session.delete).toHaveBeenCalled()
    })

    it('uses request.directory for session creation, prompt, messages, and cleanup when provided', async () => {
      const adapter = new OpencodeBridgeAdapter({ serverSeam })
      const customDir = '/custom/workspace/dir'

      mockClient.session.promptAsync.mockImplementationOnce(async () => {
        emitEvent({
          type: 'session.idle',
          properties: { sessionID: 'ephemeral-session-123' }
        })
      })

      const req: ChatRequest = {
        requestId: 'req-dir-test',
        model: 'default',
        messages: [{ role: 'user', content: 'hello with directory' }],
        directory: customDir
      }

      await adapter.chat(req)

      expect(mockClient.session.create).toHaveBeenCalledWith(
        expect.objectContaining({ query: { directory: customDir } })
      )
      expect(mockClient.session.promptAsync).toHaveBeenCalledWith(
        expect.objectContaining({ query: { directory: customDir } })
      )
      expect(mockClient.session.messages).toHaveBeenCalledWith(
        expect.objectContaining({ query: { directory: customDir } })
      )
      expect(mockClient.session.delete).toHaveBeenCalledWith(
        expect.objectContaining({ query: { directory: customDir } })
      )
    })
  })

  describe('registry and profile integration', () => {
    it('is registered in providerRegistry', () => {
      expect(providerRegistry.isSupported('opencode')).toBe(true)
      const resolved = providerRegistry.resolve('opencode')
      expect(resolved).toBeInstanceOf(OpencodeBridgeAdapter)
      expect(resolved.id).toBe('opencode')
    })

    it('has a built-in profile in BUILTIN_PROFILES', () => {
      const opencodeProfile = BUILTIN_PROFILES.find((p) => p.id === 'opencode-agent')
      expect(opencodeProfile).toBeDefined()
      expect(opencodeProfile?.provider).toBe('opencode')
      expect(opencodeProfile?.model).toBe('default')
      expect(opencodeProfile?.builtin).toBe(true)
    })

    it('resolves in providerCatalog via catalogByProvider', () => {
      expect(OPENCODE_PROVIDER).toBeDefined()
      expect(OPENCODE_PROVIDER.providerID).toBe('opencode')
      expect(OPENCODE_PROVIDER.label).toBe('OpenCode (Local Server)')

      const catalogEntry = catalogByProvider('opencode')
      expect(catalogEntry).toBeDefined()
      expect(catalogEntry?.providerID).toBe('opencode')
      expect(catalogEntry?.label).toBe('OpenCode (Local Server)')
    })
  })
})
