import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { expectRejectsAll, HOSTILE_STRINGS, loadIpc, type IpcHarness } from './ipcHarness'
import { loadWorkflow as realLoadWorkflow } from '../harness/dag/workflowLoader'

const DAG_CHANNELS = [
  'oc:dag:listWorkflows',
  'oc:dag:loadWorkflow',
  'oc:dag:startRun',
  'oc:dag:stopRun',
  'oc:dag:getRunStatus',
  'oc:dag:listRuns'
]

describe('ipc dag channels', () => {
  let h: IpcHarness

  beforeEach(async () => {
    h = await loadIpc()
  })

  it('registers every oc:dag:* channel exactly once', () => {
    for (const channel of DAG_CHANNELS) {
      expect(h.has(channel), `expected handler for ${channel}`).toBe(true)
    }
  })

  it('unregisters every dag channel via unregisterIpc', () => {
    h.ipc.unregisterIpc()
    for (const channel of DAG_CHANNELS) {
      expect(h.has(channel)).toBe(false)
    }
  })

  it('stopRun requires a non-empty string runId', async () => {
    await expectRejectsAll((v) => h.invoke('oc:dag:stopRun', v), HOSTILE_STRINGS)
  })

  it('getRunStatus requires a non-empty string runId', async () => {
    await expectRejectsAll((v) => h.invoke('oc:dag:getRunStatus', v), HOSTILE_STRINGS)
  })

  it('startRun requires an object with workflow and directory', async () => {
    await expectRejectsAll((v) => h.invoke('oc:dag:startRun', v), [undefined, null, 'x', 42])
  })

  it('listRuns delegates to dagController', async () => {
    const res = await h.invoke('oc:dag:listRuns')
    expect(res).toEqual([])
    expect(h.mocks.dagController.listDagRuns).toHaveBeenCalled()
  })

  it('loadWorkflow falls back to built-in workflow when no file exists on disk', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oc-dag-builtin-'))
    try {
      const h2 = await loadIpc({ loadWorkflow: vi.fn(realLoadWorkflow) })

      const wfById = await h2.invoke('oc:dag:loadWorkflow', tempDir, 'code-review-fix')
      expect(wfById.id).toBe('code-review-fix')
      expect(wfById.name).toBe('Code Review -> Test Writer -> Fixer')
      expect(wfById.nodes.length).toBeGreaterThan(0)

      const wfByFilename = await h2.invoke('oc:dag:loadWorkflow', tempDir, 'code-review-fix.json')
      expect(wfByFilename.id).toBe('code-review-fix')

      const wfFeature = await h2.invoke('oc:dag:loadWorkflow', tempDir, 'feature-implementation')
      expect(wfFeature.id).toBe('feature-implementation')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('loadWorkflow requires a validated directory and a non-empty workflowId', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oc-dag-args-'))
    try {
      await expectRejectsAll((v) => h.invoke('oc:dag:loadWorkflow', tempDir, v), HOSTILE_STRINGS)
      // The directory must itself exist, so a hostile value is refused before
      // anything is resolved or read.
      await expectRejectsAll(
        (v) => h.invoke('oc:dag:loadWorkflow', v, 'code-review-fix'),
        HOSTILE_STRINGS
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('listWorkflows requires a directory and never defaults to process.cwd()', async () => {
    await expectRejectsAll((v) => h.invoke('oc:dag:listWorkflows', v), HOSTILE_STRINGS)
    expect(h.mocks.listWorkflows).not.toHaveBeenCalled()
  })

  it('listWorkflows merges builtins and only gives a filePath to disk workflows', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oc-dag-list-'))
    try {
      // First call is the disk-only pass, second is the merged pass.
      h.mocks.listWorkflows
        .mockResolvedValueOnce([{ id: 'on-disk', name: 'On Disk', nodes: [] }])
        .mockResolvedValueOnce([
          { id: 'on-disk', name: 'On Disk', nodes: [] },
          { id: 'code-review-fix', name: 'Code Review', description: 'desc', nodes: [] }
        ])

      const list = await h.invoke('oc:dag:listWorkflows', tempDir)

      expect(h.mocks.listWorkflows).toHaveBeenCalledWith(tempDir)
      expect(h.mocks.listWorkflows).toHaveBeenCalledWith(tempDir, { includeBuiltin: true })
      expect(list).toHaveLength(2)

      const onDisk = list.find((w: { id: string }) => w.id === 'on-disk')
      expect(onDisk.filePath).toBe(join(tempDir, '.opencode', 'workflows', 'on-disk.json'))

      // A builtin has no file, so it must not be handed a fabricated path.
      const builtin = list.find((w: { id: string }) => w.id === 'code-review-fix')
      expect(builtin.filePath).toBeUndefined()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('loadWorkflow contains reads to the project workflows directory', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oc-dag-contain-'))
    try {
      const h2 = await loadIpc({ loadWorkflow: vi.fn(realLoadWorkflow) })
      const traversal = ['../../outside', '..\\..\\evil', '../../../package']

      for (const hostile of traversal) {
        await expect(h2.invoke('oc:dag:loadWorkflow', tempDir, hostile)).rejects.toThrow(
          /strictly inside the project directory|escapes the project directory/i
        )
      }

      // An absolute path to a file elsewhere on disk is refused too: the
      // containment base is the validated directory and is never derived from
      // this argument.
      await expect(
        h2.invoke('oc:dag:loadWorkflow', tempDir, resolve(process.cwd(), 'package.json'))
      ).rejects.toThrow(/strictly inside the project directory|escapes the project directory/i)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('loadWorkflow reads a disk workflow from the contained workflows path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oc-dag-custom-proj-'))
    try {
      const workflowsDir = join(tempDir, '.opencode', 'workflows')
      await mkdir(workflowsDir, { recursive: true })
      const customWf = {
        id: 'custom-pipe',
        name: 'Custom Pipeline',
        description: 'Test custom workflow',
        nodes: [{ id: 'step1', profileId: 'code-reviewer', prompt: 'Review code' }]
      }
      const wfPath = join(workflowsDir, 'custom-pipe.json')
      await writeFile(wfPath, JSON.stringify(customWf, null, 2), 'utf-8')

      const h2 = await loadIpc({ loadWorkflow: vi.fn(realLoadWorkflow) })
      // Read for real from <tempDir>/.opencode/workflows/custom-pipe.json: the
      // id resolved to the contained path under the project, nowhere else.
      const loaded = await h2.invoke('oc:dag:loadWorkflow', tempDir, 'custom-pipe')
      expect(loaded.id).toBe('custom-pipe')
      expect(loaded.name).toBe('Custom Pipeline')
      expect(loaded.nodes).toHaveLength(1)
      expect(loaded.nodes[0].id).toBe('step1')

      // A different project directory does not see this workflow at all.
      const otherDir = await mkdtemp(join(tmpdir(), 'oc-dag-other-'))
      try {
        await expect(
          h2.invoke('oc:dag:loadWorkflow', otherDir, 'custom-pipe')
        ).rejects.toThrow(/Workflow not found/)
      } finally {
        await rm(otherDir, { recursive: true, force: true })
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('loadWorkflow prefers a disk workflow over a built-in template of the same id', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oc-dag-override-'))
    try {
      const workflowsDir = join(tempDir, '.opencode', 'workflows')
      await mkdir(workflowsDir, { recursive: true })
      const overriddenWf = {
        id: 'code-review-fix',
        name: 'Overridden Custom Code Review',
        description: 'Company-specific quality pipeline',
        nodes: [{ id: 'custom_reviewer', profileId: 'reviewer', prompt: 'Custom review prompt' }]
      }
      const wfPath = join(workflowsDir, 'code-review-fix.json')
      await writeFile(wfPath, JSON.stringify(overriddenWf, null, 2), 'utf-8')

      const h2 = await loadIpc({ loadWorkflow: vi.fn(realLoadWorkflow) })
      // The disk file shadows the builtin of the same id.
      const loaded = await h2.invoke('oc:dag:loadWorkflow', tempDir, 'code-review-fix')
      expect(loaded.name).toBe('Overridden Custom Code Review')
      expect(loaded.name).not.toBe('Code Review -> Test Writer -> Fixer')
      expect(loaded.nodes[0].id).toBe('custom_reviewer')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('loadWorkflow safely ignores directories that share the workflow name', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'oc-dag-dir-conflict-'))
    try {
      // A directory named like the workflow sits in the project root.
      await mkdir(join(tempDir, 'conflict-wf'), { recursive: true })

      const workflowsDir = join(tempDir, '.opencode', 'workflows')
      await mkdir(workflowsDir, { recursive: true })
      const validWf = {
        id: 'conflict-wf',
        name: 'Conflict Workflow',
        nodes: [{ id: 'n1', profileId: 'coder', prompt: 'Do work' }]
      }
      const wfFile = join(workflowsDir, 'conflict-wf.json')
      await writeFile(wfFile, JSON.stringify(validWf, null, 2), 'utf-8')

      const h2 = await loadIpc({ loadWorkflow: vi.fn(realLoadWorkflow) })
      // The .json under .opencode/workflows wins over the same-named directory.
      const loaded = await h2.invoke('oc:dag:loadWorkflow', tempDir, 'conflict-wf')
      expect(loaded.id).toBe('conflict-wf')
      expect(loaded.name).toBe('Conflict Workflow')
      expect(loaded.nodes[0].id).toBe('n1')    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  describe('startRun maxWorkerConcurrency forwarding', () => {
    const wf = { id: 'w', name: 'w', nodes: [{ id: 'n', profileId: 'p', prompt: 'x' }] }

    async function forwarded(value: unknown): Promise<unknown> {
      h.mocks.dagController.startDagRun.mockClear()
      const dir = process.cwd()
      await h.invoke('oc:dag:startRun', { workflow: wf, directory: dir, maxWorkerConcurrency: value })
      return h.mocks.dagController.startDagRun.mock.calls[0][0].options
    }

    it('drops NaN, Infinity, values below 1 and non-numbers', async () => {
      for (const bad of [Number.NaN, Infinity, -Infinity, 0, 0.5, -3, '4', null]) {
        expect(await forwarded(bad), String(bad)).toBeUndefined()
      }
    })

    it('floors a valid value and forwards it', async () => {
      expect(await forwarded(3.9)).toEqual({ maxConcurrency: 3 })
    })
  })
})
