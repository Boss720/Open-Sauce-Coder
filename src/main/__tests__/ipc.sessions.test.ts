import { beforeEach, describe, expect, it } from 'vitest'
import { loadIpc, type IpcHarness, HOSTILE_STRINGS, HOSTILE_OBJECTS, expectRejectsAll } from './ipcHarness'

describe('ipc sessions, messages, and agent channels', () => {
  let h: IpcHarness

  beforeEach(async () => {
    h = await loadIpc()
  })

  /* ================================================================ */
  /* oc:sessions:list                                                */
  /* ================================================================ */

  describe('oc:sessions:list', () => {
    it('calls getClient().session.list with the directory', async () => {
      const mockSessions = [{ id: 'sess-1', title: 'Chat 1' }]
      h.mocks.getClient.mockReturnValue({
        session: { list: (_args: unknown) => ({ data: mockSessions, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:sessions:list', '/project')

      expect(result).toEqual(mockSessions)
      expect(h.mocks.getClient).toHaveBeenCalled()
    })

    it('rejects hostile directory values', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:list', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:sessions:create                                              */
  /* ================================================================ */

  describe('oc:sessions:create', () => {
    it('creates a session with directory only', async () => {
      const mockSession = { id: 'sess-1', title: null }
      h.mocks.getClient.mockReturnValue({
        session: { create: () => ({ data: mockSession, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:sessions:create', '/project', undefined, undefined)

      expect(result).toEqual(mockSession)
    })

    it('creates a session with title', async () => {
      const mockSession = { id: 'sess-1', title: 'My Title' }
      const createFn = () => ({ data: mockSession, error: null, response: { ok: true, status: 200, statusText: 'OK' } })
      h.mocks.getClient.mockReturnValue({ session: { create: createFn } })

      const result = await h.invoke('oc:sessions:create', '/project', 'My Title', undefined)

      expect(result).toEqual(mockSession)
    })

    it('creates a child session with parentID', async () => {
      const mockSession = { id: 'sess-2', title: null, parentID: 'sess-1' }
      const createFn = () => ({ data: mockSession, error: null, response: { ok: true, status: 200, statusText: 'OK' } })
      h.mocks.getClient.mockReturnValue({ session: { create: createFn } })

      const result = await h.invoke('oc:sessions:create', '/project', undefined, 'sess-1')

      expect(result).toEqual(mockSession)
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:create', value, 'title', undefined),
        HOSTILE_STRINGS
      )
    })

    it('accepts whitespace title as omitted', async () => {
      const mockSession = { id: 'sess-1', title: null }
      h.mocks.getClient.mockReturnValue({
        session: { create: () => ({ data: mockSession, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:sessions:create', '/project', '   ', undefined)

      expect(result).toEqual(mockSession)
    })

    it('accepts whitespace parentID as omitted', async () => {
      const mockSession = { id: 'sess-1', title: null }
      h.mocks.getClient.mockReturnValue({
        session: { create: () => ({ data: mockSession, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:sessions:create', '/project', undefined, '   ')

      expect(result).toEqual(mockSession)
    })
  })

  /* ================================================================ */
  /* oc:sessions:delete                                              */
  /* ================================================================ */

  describe('oc:sessions:delete', () => {
    it('deletes a session', async () => {
      h.mocks.getClient.mockReturnValue({
        session: { delete: () => ({ data: true, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:sessions:delete', '/project', 'sess-123')

      expect(result).toBeUndefined()
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:delete', value, 'id'),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:delete', '/project', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:sessions:summarize                                           */
  /* ================================================================ */

  describe('oc:sessions:summarize', () => {
    it('summarizes a session', async () => {
      h.mocks.getClient.mockReturnValue({
        session: { summarize: () => ({ data: true, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) },
        config: { providers: () => ({ data: { providers: [{ id: 'openai', models: { 'gpt-4': {} } }] }, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })
      h.mocks.isAuthorizedProvider.mockReturnValue(true)

      const result = await h.invoke('oc:sessions:summarize', {
        directory: '/project',
        sessionID: 'sess-123',
        providerID: 'openai',
        modelID: 'gpt-4'
      })

      expect(result).toBe(true)
    })

    it('rejects unauthorized provider', async () => {
      h.mocks.isAuthorizedProvider.mockReturnValue(false)

      await expect(
        h.invoke('oc:sessions:summarize', {
          directory: '/project',
          sessionID: 'sess-123',
          providerID: 'unknown',
          modelID: 'gpt-4'
        })
      ).rejects.toThrow()
    })

    it('rejects hostile args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:summarize', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:summarize', { directory: value, sessionID: 'id', providerID: 'p', modelID: 'm' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:summarize', { directory: '/proj', sessionID: value, providerID: 'p', modelID: 'm' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile providerID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:summarize', { directory: '/proj', sessionID: 'id', providerID: value, modelID: 'm' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile modelID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:summarize', { directory: '/proj', sessionID: 'id', providerID: 'p', modelID: value }),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:sessions:init                                                */
  /* ================================================================ */

  describe('oc:sessions:init', () => {
    it('initializes a session from a message', async () => {
      h.mocks.getClient.mockReturnValue({
        session: { init: () => ({ data: true, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) },
        config: { providers: () => ({ data: { providers: [{ id: 'openai', models: { 'gpt-4': {} } }] }, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })
      h.mocks.isAuthorizedProvider.mockReturnValue(true)

      const result = await h.invoke('oc:sessions:init', {
        directory: '/project',
        sessionID: 'sess-123',
        providerID: 'openai',
        modelID: 'gpt-4',
        messageID: 'msg-456'
      })

      expect(result).toBe(true)
    })

    it('rejects unauthorized provider', async () => {
      h.mocks.isAuthorizedProvider.mockReturnValue(false)

      await expect(
        h.invoke('oc:sessions:init', {
          directory: '/project',
          sessionID: 'sess-123',
          providerID: 'unknown',
          modelID: 'gpt-4',
          messageID: 'msg-456'
        })
      ).rejects.toThrow()
    })

    it('rejects hostile args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:init', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:init', { directory: value, sessionID: 'id', providerID: 'p', modelID: 'm', messageID: 'msg' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:init', { directory: '/proj', sessionID: value, providerID: 'p', modelID: 'm', messageID: 'msg' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile providerID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:init', { directory: '/proj', sessionID: 'id', providerID: value, modelID: 'm', messageID: 'msg' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile modelID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:init', { directory: '/proj', sessionID: 'id', providerID: 'p', modelID: value, messageID: 'msg' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile messageID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:init', { directory: '/proj', sessionID: 'id', providerID: 'p', modelID: 'm', messageID: value }),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:sessions:command                                             */
  /* ================================================================ */

  describe('oc:sessions:command', () => {
    it('sends a command to a session', async () => {
      h.mocks.getClient.mockReturnValue({
        session: { command: () => ({ data: undefined, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:sessions:command', {
        directory: '/project',
        sessionID: 'sess-123',
        command: 'install',
        arguments: 'pkg-name'
      })

      expect(result).toBeUndefined()
    })

    it('treats undefined arguments as empty string', async () => {
      h.mocks.getClient.mockReturnValue({
        session: { command: (args: { body: { arguments: string } }) => {
          expect(args.body.arguments).toBe('')
          return { data: undefined, error: null, response: { ok: true, status: 200, statusText: 'OK' } }
        } }
      })

      await h.invoke('oc:sessions:command', {
        directory: '/project',
        sessionID: 'sess-123',
        command: 'test'
      })
    })

    it('rejects hostile args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:command', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:command', { directory: value, sessionID: 'id', command: 'cmd' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:command', { directory: '/proj', sessionID: value, command: 'cmd' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile command', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:sessions:command', { directory: '/proj', sessionID: 'id', command: value }),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:messages:list                                                */
  /* ================================================================ */

  describe('oc:messages:list', () => {
    it('lists messages for a session', async () => {
      const mockMessages = [
        { info: { id: 'msg-1', text: 'Hello' }, parts: [{ type: 'text', text: 'Hello' }] }
      ]
      h.mocks.getClient.mockReturnValue({
        session: { messages: () => ({ data: mockMessages, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:messages:list', '/project', 'sess-123')

      expect(result).toEqual(mockMessages)
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:messages:list', value, 'sess-123'),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:messages:list', '/project', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:messages:revert                                              */
  /* ================================================================ */

  describe('oc:messages:revert', () => {
    it('reverts a message', async () => {
      const mockSession = { id: 'sess-123', revert: 'msg-456' }
      h.mocks.getClient.mockReturnValue({
        session: { revert: () => ({ data: mockSession, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:messages:revert', {
        directory: '/project',
        sessionID: 'sess-123',
        messageID: 'msg-456'
      })

      expect(result).toBeUndefined()
    })

    it('rejects hostile args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:messages:revert', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:messages:revert', { directory: value, sessionID: 'sid', messageID: 'mid' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:messages:revert', { directory: '/proj', sessionID: value, messageID: 'mid' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile messageID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:messages:revert', { directory: '/proj', sessionID: 'sid', messageID: value }),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:messages:unrevert                                            */
  /* ================================================================ */

  describe('oc:messages:unrevert', () => {
    it('clears revert state on a session', async () => {
      const mockSession = { id: 'sess-123', revert: null }
      h.mocks.getClient.mockReturnValue({
        session: { unrevert: () => ({ data: mockSession, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:messages:unrevert', {
        directory: '/project',
        sessionID: 'sess-123'
      })

      expect(result).toEqual(mockSession)
    })

    it('rejects hostile args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:messages:unrevert', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:messages:unrevert', { directory: value, sessionID: 'sid' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:messages:unrevert', { directory: '/proj', sessionID: value }),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:prompt                                                       */
  /* ================================================================ */

  describe('oc:prompt', () => {
    const mockClient = () => ({
      session: { promptAsync: () => ({ data: undefined, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) },
      config: { providers: () => ({ data: { providers: [{ id: 'openai', models: { 'gpt-4': {} } }] }, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
    })

    it('sends a prompt with text-only parts', async () => {
      h.mocks.getClient.mockReturnValue(mockClient())
      h.mocks.isAuthorizedProvider.mockReturnValue(true)

      const result = await h.invoke('oc:prompt', {
        directory: '/project',
        sessionID: 'sess-123',
        providerID: 'openai',
        modelID: 'gpt-4',
        text: 'Hello, world!'
      })

      expect(result).toBeUndefined()
    })

    it('sends a prompt with custom parts', async () => {
      h.mocks.getClient.mockReturnValue({
        session: { promptAsync: (args: { body: { parts?: unknown[] } }) => {
          expect(args.body.parts).toBeDefined()
          return { data: undefined, error: null, response: { ok: true, status: 200, statusText: 'OK' } }
        } },
        config: { providers: () => ({ data: { providers: [{ id: 'openai', models: { 'gpt-4': {} } }] }, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })
      h.mocks.isAuthorizedProvider.mockReturnValue(true)

      await h.invoke('oc:prompt', {
        directory: '/project',
        sessionID: 'sess-123',
        providerID: 'openai',
        modelID: 'gpt-4',
        text: 'fallback',
        parts: [{ type: 'text', text: 'actual prompt' }]
      })
    })

    it('sends a prompt with optional tool policy', async () => {
      h.mocks.getClient.mockReturnValue({
        session: { promptAsync: (args: { body: { tools: Record<string, boolean> } }) => {
          expect(args.body.tools).toBeDefined()
          expect(args.body.tools.some_tool).toBe(true)
          return { data: undefined, error: null, response: { ok: true, status: 200, statusText: 'OK' } }
        } },
        config: { providers: () => ({ data: { providers: [{ id: 'openai', models: { 'gpt-4': {} } }] }, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })
      h.mocks.isAuthorizedProvider.mockReturnValue(true)

      await h.invoke('oc:prompt', {
        directory: '/project',
        sessionID: 'sess-123',
        providerID: 'openai',
        modelID: 'gpt-4',
        text: 'test',
        tools: { some_tool: true, other_tool: false }
      })
    })

    it('sends a prompt with optional agent override', async () => {
      h.mocks.getClient.mockReturnValue({
        session: { promptAsync: (args: { body: { agent?: string } }) => {
          expect(args.body.agent).toBe('plan')
          return { data: undefined, error: null, response: { ok: true, status: 200, statusText: 'OK' } }
        } },
        config: { providers: () => ({ data: { providers: [{ id: 'openai', models: { 'gpt-4': {} } }] }, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })
      h.mocks.isAuthorizedProvider.mockReturnValue(true)

      await h.invoke('oc:prompt', {
        directory: '/project',
        sessionID: 'sess-123',
        providerID: 'openai',
        modelID: 'gpt-4',
        text: 'test',
        agent: 'plan'
      })
    })

    it('rejects unauthorized provider', async () => {
      h.mocks.isAuthorizedProvider.mockReturnValue(false)

      await expect(
        h.invoke('oc:prompt', {
          directory: '/project',
          sessionID: 'sess-123',
          providerID: 'unknown',
          modelID: 'gpt-4',
          text: 'hello'
        })
      ).rejects.toThrow()
    })

    it('rejects hostile args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:prompt', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:prompt', { directory: value, sessionID: 'sid', providerID: 'p', modelID: 'm', text: 'text' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:prompt', { directory: '/proj', sessionID: value, providerID: 'p', modelID: 'm', text: 'text' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile providerID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:prompt', { directory: '/proj', sessionID: 'sid', providerID: value, modelID: 'm', text: 'text' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile modelID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:prompt', { directory: '/proj', sessionID: 'sid', providerID: 'p', modelID: value, text: 'text' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile text', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:prompt', { directory: '/proj', sessionID: 'sid', providerID: 'p', modelID: 'm', text: value }),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:abort                                                        */
  /* ================================================================ */

  describe('oc:abort', () => {
    it('aborts a session', async () => {
      h.mocks.getClient.mockReturnValue({
        session: { abort: () => ({ data: true, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:abort', '/project', 'sess-123')

      expect(result).toBeUndefined()
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:abort', value, 'sid'),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:abort', '/proj', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:session:fork                                                 */
  /* ================================================================ */

  describe('oc:session:fork', () => {
    it('forks a session at a message', async () => {
      const mockSession = { id: 'sess-new', parentID: 'sess-old' }
      h.mocks.getClient.mockReturnValue({
        session: { fork: () => ({ data: mockSession, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:session:fork', {
        directory: '/project',
        sessionID: 'sess-old',
        messageID: 'msg-456'
      })

      expect(result).toEqual(mockSession)
    })

    it('rejects hostile args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:session:fork', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:session:fork', { directory: value, sessionID: 'sid', messageID: 'mid' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile sessionID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:session:fork', { directory: '/proj', sessionID: value, messageID: 'mid' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects hostile messageID', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:session:fork', { directory: '/proj', sessionID: 'sid', messageID: value }),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* oc:agents:list                                                  */
  /* ================================================================ */

  describe('oc:agents:list', () => {
    it('lists available agents', async () => {
      const mockAgents = [{ name: 'plan', role: 'architect' }]
      h.mocks.getClient.mockReturnValue({
        app: { agents: () => ({ data: mockAgents, error: null, response: { ok: true, status: 200, statusText: 'OK' } }) }
      })

      const result = await h.invoke('oc:agents:list', '/project')

      expect(result).toEqual(mockAgents)
    })

    it('rejects hostile directory', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:agents:list', value),
        HOSTILE_STRINGS
      )
    })
  })

  /* ================================================================ */
  /* Verify all channels are registered                              */
  /* ================================================================ */

  describe('channel registration', () => {
    it('registers all sessions/messages/prompt channels', () => {
      const sessionsChannels = [
        'oc:sessions:list',
        'oc:sessions:create',
        'oc:sessions:delete',
        'oc:sessions:summarize',
        'oc:sessions:init',
        'oc:sessions:command',
        'oc:messages:list',
        'oc:messages:revert',
        'oc:messages:unrevert',
        'oc:prompt',
        'oc:abort',
        'oc:session:fork',
        'oc:agents:list'
      ]
      for (const channel of sessionsChannels) {
        expect(h.has(channel)).toBe(true)
      }
    })
  })
})
