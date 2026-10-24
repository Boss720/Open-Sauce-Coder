import { beforeEach, describe, expect, it } from 'vitest'
import { loadIpc, type IpcHarness, HOSTILE_STRINGS, HOSTILE_OBJECTS, expectRejectsAll } from './ipcHarness'

describe('ipc projects channels', () => {
  let h: IpcHarness

  beforeEach(async () => {
    h = await loadIpc()
  })

  describe('oc:projects:list', () => {
    it('registers the channel', () => {
      expect(h.has('oc:projects:list')).toBe(true)
    })

    it('calls listProjects with no arguments', async () => {
      h.mocks.listProjects.mockResolvedValueOnce([
        { id: '1', name: 'proj1', directory: '/path/1' },
        { id: '2', name: 'proj2', directory: '/path/2' }
      ])

      const result = await h.invoke('oc:projects:list')

      expect(h.mocks.listProjects).toHaveBeenCalledOnce()
      expect(h.mocks.listProjects).toHaveBeenCalledWith()
      expect(result).toEqual([
        { id: '1', name: 'proj1', directory: '/path/1' },
        { id: '2', name: 'proj2', directory: '/path/2' }
      ])
    })

    it('returns empty array when no projects exist', async () => {
      h.mocks.listProjects.mockResolvedValueOnce([])

      const result = await h.invoke('oc:projects:list')

      expect(result).toEqual([])
    })
  })

  describe('oc:projects:create', () => {
    it('registers the channel', () => {
      expect(h.has('oc:projects:create')).toBe(true)
    })

    it('calls createProject with name from args.name', async () => {
      h.mocks.createProject.mockResolvedValueOnce({ id: 'new', name: 'my-project', directory: '/path/new' })

      const result = await h.invoke('oc:projects:create', { name: 'my-project' })

      expect(h.mocks.createProject).toHaveBeenCalledOnce()
      expect(h.mocks.createProject).toHaveBeenCalledWith('my-project')
      expect(result).toEqual({ id: 'new', name: 'my-project', directory: '/path/new' })
    })

    it('rejects when args is not an object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:create', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects when args.name is not a non-empty string', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:create', { name: value }),
        HOSTILE_STRINGS
      )
    })

    it('rejects when args.name is whitespace-only', async () => {
      await expect(h.invoke('oc:projects:create', { name: '   ' })).rejects.toThrow()
    })
  })

  describe('oc:projects:instructions:get', () => {
    it('registers the channel', () => {
      expect(h.has('oc:projects:instructions:get')).toBe(true)
    })

    it('calls getProjectInstructions with directory string', async () => {
      h.mocks.getProjectInstructions.mockResolvedValueOnce('# Project Instructions\nDo the thing.')

      const result = await h.invoke('oc:projects:instructions:get', '/path/to/project')

      expect(h.mocks.getProjectInstructions).toHaveBeenCalledOnce()
      expect(h.mocks.getProjectInstructions).toHaveBeenCalledWith('/path/to/project')
      expect(result).toBe('# Project Instructions\nDo the thing.')
    })

    it('returns empty string when no instructions exist', async () => {
      h.mocks.getProjectInstructions.mockResolvedValueOnce('')

      const result = await h.invoke('oc:projects:instructions:get', '/path/to/project')

      expect(result).toBe('')
    })

    it('rejects when directory is not a non-empty string', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:instructions:get', value),
        HOSTILE_STRINGS
      )
    })

    it('rejects when directory is whitespace-only', async () => {
      await expect(h.invoke('oc:projects:instructions:get', '   ')).rejects.toThrow()
    })
  })

  describe('oc:projects:instructions:set', () => {
    it('registers the channel', () => {
      expect(h.has('oc:projects:instructions:set')).toBe(true)
    })

    it('calls setProjectInstructions with directory and text', async () => {
      h.mocks.setProjectInstructions.mockResolvedValueOnce(true)

      await h.invoke('oc:projects:instructions:set', {
        directory: '/path/to/project',
        text: '# New Instructions'
      })

      expect(h.mocks.setProjectInstructions).toHaveBeenCalledOnce()
      expect(h.mocks.setProjectInstructions).toHaveBeenCalledWith('/path/to/project', '# New Instructions')
    })

    it('rejects when args is not an object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:instructions:set', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects when args.directory is not a non-empty string', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:instructions:set', { directory: value, text: 'text' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects when args.text is not a string', async () => {
      await expect(
        h.invoke('oc:projects:instructions:set', { directory: '/path', text: undefined })
      ).rejects.toThrow('text must be a string')

      await expect(
        h.invoke('oc:projects:instructions:set', { directory: '/path', text: 42 })
      ).rejects.toThrow('text must be a string')

      await expect(
        h.invoke('oc:projects:instructions:set', { directory: '/path', text: {} })
      ).rejects.toThrow('text must be a string')
    })

    it('allows empty string for text', async () => {
      h.mocks.setProjectInstructions.mockResolvedValueOnce(true)

      await h.invoke('oc:projects:instructions:set', { directory: '/path', text: '' })

      expect(h.mocks.setProjectInstructions).toHaveBeenCalledWith('/path', '')
    })
  })

  describe('oc:projects:knowledge:list', () => {
    it('registers the channel', () => {
      expect(h.has('oc:projects:knowledge:list')).toBe(true)
    })

    it('calls listKnowledge with directory string', async () => {
      h.mocks.listKnowledge.mockResolvedValueOnce([
        { id: '1', name: 'doc1.md', path: '/path/doc1.md' },
        { id: '2', name: 'doc2.md', path: '/path/doc2.md' }
      ])

      const result = await h.invoke('oc:projects:knowledge:list', '/path/to/project')

      expect(h.mocks.listKnowledge).toHaveBeenCalledOnce()
      expect(h.mocks.listKnowledge).toHaveBeenCalledWith('/path/to/project')
      expect(result).toEqual([
        { id: '1', name: 'doc1.md', path: '/path/doc1.md' },
        { id: '2', name: 'doc2.md', path: '/path/doc2.md' }
      ])
    })

    it('returns empty array when no knowledge exists', async () => {
      h.mocks.listKnowledge.mockResolvedValueOnce([])

      const result = await h.invoke('oc:projects:knowledge:list', '/path/to/project')

      expect(result).toEqual([])
    })

    it('rejects when directory is not a non-empty string', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:knowledge:list', value),
        HOSTILE_STRINGS
      )
    })

    it('rejects when directory is whitespace-only', async () => {
      await expect(h.invoke('oc:projects:knowledge:list', '   ')).rejects.toThrow()
    })
  })

  describe('oc:projects:knowledge:add', () => {
    it('registers the channel', () => {
      expect(h.has('oc:projects:knowledge:add')).toBe(true)
    })

    it('calls addKnowledge with directory and provided filePaths', async () => {
      h.mocks.addKnowledge.mockResolvedValueOnce([
        { id: '1', name: 'doc1.md', path: '/path/doc1.md' }
      ])

      const result = await h.invoke('oc:projects:knowledge:add', {
        directory: '/path/to/project',
        filePaths: ['/path/doc1.md']
      })

      expect(h.mocks.addKnowledge).toHaveBeenCalledOnce()
      expect(h.mocks.addKnowledge).toHaveBeenCalledWith('/path/to/project', ['/path/doc1.md'])
      expect(result).toEqual([{ id: '1', name: 'doc1.md', path: '/path/doc1.md' }])
    })

    it('calls addKnowledge with multiple file paths', async () => {
      h.mocks.addKnowledge.mockResolvedValueOnce([
        { id: '1', name: 'doc1.md', path: '/path/doc1.md' },
        { id: '2', name: 'doc2.md', path: '/path/doc2.md' }
      ])

      await h.invoke('oc:projects:knowledge:add', {
        directory: '/path/to/project',
        filePaths: ['/path/doc1.md', '/path/doc2.md']
      })

      expect(h.mocks.addKnowledge).toHaveBeenCalledWith('/path/to/project', ['/path/doc1.md', '/path/doc2.md'])
    })

    it('opens file dialog when filePaths is not provided', async () => {
      h.mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/selected/doc.md']
      })
      h.mocks.addKnowledge.mockResolvedValueOnce([
        { id: '1', name: 'doc.md', path: '/selected/doc.md' }
      ])

      const result = await h.invoke('oc:projects:knowledge:add', {
        directory: '/path/to/project'
      })

      expect(h.mocks.showOpenDialog).toHaveBeenCalledOnce()
      const call = h.mocks.showOpenDialog.mock.calls[0]
      const options = call[call.length - 1]
      expect(options.title).toBe('Add knowledge files')
      expect(options.buttonLabel).toBe('Add knowledge')
      expect(options.properties).toContain('openFile')
      expect(options.properties).toContain('multiSelections')
      expect(options.filters).toEqual([{ name: 'Markdown', extensions: ['md'] }])

      expect(h.mocks.addKnowledge).toHaveBeenCalledWith('/path/to/project', ['/selected/doc.md'])
      expect(result).toEqual([{ id: '1', name: 'doc.md', path: '/selected/doc.md' }])
    })

    it('opens file dialog when filePaths is empty array', async () => {
      h.mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/selected/doc.md']
      })
      h.mocks.addKnowledge.mockResolvedValueOnce([
        { id: '1', name: 'doc.md', path: '/selected/doc.md' }
      ])

      await h.invoke('oc:projects:knowledge:add', {
        directory: '/path/to/project',
        filePaths: []
      })

      expect(h.mocks.showOpenDialog).toHaveBeenCalledOnce()
      expect(h.mocks.addKnowledge).toHaveBeenCalledWith('/path/to/project', ['/selected/doc.md'])
    })

    it('returns listKnowledge result when file dialog is canceled', async () => {
      h.mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: true,
        filePaths: []
      })
      h.mocks.listKnowledge.mockResolvedValueOnce([
        { id: '1', name: 'existing.md', path: '/path/existing.md' }
      ])

      const result = await h.invoke('oc:projects:knowledge:add', {
        directory: '/path/to/project'
      })

      expect(h.mocks.addKnowledge).not.toHaveBeenCalled()
      expect(h.mocks.listKnowledge).toHaveBeenCalledWith('/path/to/project')
      expect(result).toEqual([{ id: '1', name: 'existing.md', path: '/path/existing.md' }])
    })

    it('rejects when args is not an object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:knowledge:add', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects when args.directory is not a non-empty string', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:knowledge:add', { directory: value }),
        HOSTILE_STRINGS
      )
    })

    it('rejects when args.filePaths is not a string array (if provided)', async () => {
      await expect(
        h.invoke('oc:projects:knowledge:add', { directory: '/path', filePaths: 'not-an-array' })
      ).rejects.toThrow('filePaths must be a string array')

      await expect(
        h.invoke('oc:projects:knowledge:add', { directory: '/path', filePaths: [42, 'string'] })
      ).rejects.toThrow('filePaths must be a string array')

      await expect(
        h.invoke('oc:projects:knowledge:add', { directory: '/path', filePaths: [null] })
      ).rejects.toThrow('filePaths must be a string array')
    })

    it('passes the event to BrowserWindow.fromWebContents when opening dialog', async () => {
      h.mocks.fromWebContents.mockReturnValueOnce({})
      h.mocks.showOpenDialog.mockResolvedValueOnce({
        canceled: true,
        filePaths: []
      })
      h.mocks.listKnowledge.mockResolvedValueOnce([])

      // The handler resolves its parent window from the event before opening the dialog;
      // the harness supplies a stub event, so reaching showOpenDialog at all proves that
      // lookup did not throw.
      await h.invoke('oc:projects:knowledge:add', { directory: '/path' })

      expect(h.mocks.fromWebContents).toHaveBeenCalled()
      expect(h.mocks.showOpenDialog).toHaveBeenCalled()

      expect(h.mocks.listKnowledge).toHaveBeenCalled()
    })
  })

  describe('oc:projects:knowledge:remove', () => {
    it('registers the channel', () => {
      expect(h.has('oc:projects:knowledge:remove')).toBe(true)
    })

    it('calls removeKnowledge with directory and filename', async () => {
      h.mocks.removeKnowledge.mockResolvedValueOnce([])

      await h.invoke('oc:projects:knowledge:remove', {
        directory: '/path/to/project',
        filename: 'doc.md'
      })

      expect(h.mocks.removeKnowledge).toHaveBeenCalledOnce()
      expect(h.mocks.removeKnowledge).toHaveBeenCalledWith('/path/to/project', 'doc.md')
    })

    it('rejects when args is not an object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:knowledge:remove', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects when args.directory is not a non-empty string', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:knowledge:remove', { directory: value, filename: 'doc.md' }),
        HOSTILE_STRINGS
      )
    })

    it('rejects when args.filename is not a non-empty string', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:projects:knowledge:remove', { directory: '/path', filename: value }),
        HOSTILE_STRINGS
      )
    })

    it('rejects when args.filename is whitespace-only', async () => {
      await expect(
        h.invoke('oc:projects:knowledge:remove', { directory: '/path', filename: '   ' })
      ).rejects.toThrow()
    })
  })

  describe('all channels registered', () => {
    it('has all 7 expected projects channels', () => {
      const expected = [
        'oc:projects:list',
        'oc:projects:create',
        'oc:projects:instructions:get',
        'oc:projects:instructions:set',
        'oc:projects:knowledge:list',
        'oc:projects:knowledge:add',
        'oc:projects:knowledge:remove'
      ]
      const channels = h.channels()
      for (const channel of expected) {
        expect(channels).toContain(channel)
      }
    })
  })
})
