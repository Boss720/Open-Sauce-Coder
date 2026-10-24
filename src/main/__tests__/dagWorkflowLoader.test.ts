import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  loadWorkflow,
  saveWorkflow,
  seedBuiltinWorkflows
} from '../harness/dag/workflowLoader'
import type { WorkflowDefinition } from '../harness/dag/types'

describe('WorkflowLoader', () => {
  let tempDir: string

  const sampleWorkflow: WorkflowDefinition = {
    id: 'sample-workflow',
    name: 'Sample Workflow',
    description: 'A test workflow definition',
    nodes: [
      {
        id: 'step_1',
        name: 'Step 1',
        profileId: 'gemini-flash',
        prompt: 'Do initial work'
      },
      {
        id: 'step_2',
        name: 'Step 2',
        profileId: 'claude-coder',
        prompt: 'Follow up: {{inputs.step_1.output}}',
        dependencies: ['step_1']
      }
    ]
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-workflow-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('returns an empty list by default when .opencode/workflows does not exist', async () => {
    const list = await listWorkflows(tempDir)
    expect(list).toEqual([])
  })

  it('returns built-in workflows when includeBuiltin is true even if .opencode/workflows does not exist', async () => {
    const list = await listWorkflows(tempDir, { includeBuiltin: true })
    expect(list.length).toBeGreaterThanOrEqual(2)
    const ids = list.map((w) => w.id)
    expect(ids).toContain('code-review-fix')
    expect(ids).toContain('feature-implementation')
  })

  it('saves and lists workflows correctly', async () => {
    await saveWorkflow(tempDir, sampleWorkflow)

    // Default: disk only
    const diskList = await listWorkflows(tempDir)
    expect(diskList).toHaveLength(1)
    expect(diskList[0].id).toBe('sample-workflow')
    expect(diskList[0].name).toBe('Sample Workflow')
    expect(diskList[0].nodes).toHaveLength(2)

    // With includeBuiltin: merges disk and builtins
    const mergedList = await listWorkflows(tempDir, { includeBuiltin: true })
    expect(mergedList).toHaveLength(3)
    const ids = mergedList.map((w) => w.id)
    expect(ids).toContain('sample-workflow')
    expect(ids).toContain('code-review-fix')
    expect(ids).toContain('feature-implementation')
    const found = mergedList.find((w) => w.id === 'sample-workflow')
    expect(found?.name).toBe('Sample Workflow')
    expect(found?.nodes).toHaveLength(2)
  })

  it('merges disk workflows with disk workflow overriding built-in workflow by ID', async () => {
    const customReview: WorkflowDefinition = {
      id: 'code-review-fix',
      name: 'Custom Review Workflow Override',
      description: 'Project-specific override of code review',
      nodes: [
        {
          id: 'custom_step',
          name: 'Custom Step',
          profileId: 'gemini-flash',
          prompt: 'Custom review prompt'
        }
      ]
    }
    await saveWorkflow(tempDir, customReview)

    const list = await listWorkflows(tempDir, { includeBuiltin: true })
    const review = list.find((w) => w.id === 'code-review-fix')
    expect(review).toBeDefined()
    expect(review?.name).toBe('Custom Review Workflow Override')
    expect(review?.nodes).toHaveLength(1)
    expect(list.map((w) => w.id)).toContain('feature-implementation')
  })

  it('loads a specific workflow by id via getWorkflow', async () => {
    await saveWorkflow(tempDir, sampleWorkflow)

    const loaded = await getWorkflow(tempDir, 'sample-workflow')
    expect(loaded).toBeDefined()
    expect(loaded?.id).toBe('sample-workflow')
    expect(loaded?.nodes[0].id).toBe('step_1')
    expect(loaded?.nodes[1].id).toBe('step_2')
  })

  it('loads built-in workflow fallback by id via getWorkflow when file not on disk', async () => {
    const loaded = await getWorkflow(tempDir, 'code-review-fix')
    expect(loaded).toBeDefined()
    expect(loaded?.id).toBe('code-review-fix')
    expect(loaded?.name).toBe('Code Review -> Test Writer -> Fixer')
  })

  it('returns null when loading a non-existent workflow id', async () => {
    const loaded = await getWorkflow(tempDir, 'missing-workflow')
    expect(loaded).toBeNull()
  })

  it('loads built-in workflow fallback by ID when file not on disk', async () => {
    const wf = await loadWorkflow(tempDir, 'code-review-fix')
    expect(wf.id).toBe('code-review-fix')
    expect(wf.name).toBe('Code Review -> Test Writer -> Fixer')
    expect(wf.nodes.length).toBeGreaterThan(0)

    const wfWithExt = await loadWorkflow(tempDir, 'code-review-fix.json')
    expect(wfWithExt.id).toBe('code-review-fix')

    const wfFeature = await loadWorkflow(tempDir, 'feature-implementation')
    expect(wfFeature.id).toBe('feature-implementation')

    await expect(loadWorkflow(tempDir, 'missing-workflow')).rejects.toThrow(
      /Workflow not found/
    )
  })

  it('loads disk workflow instead of built-in when disk file exists in loadWorkflow', async () => {
    const customReview: WorkflowDefinition = {
      id: 'code-review-fix',
      name: 'Custom On Disk Review',
      description: 'Disk override',
      nodes: [
        {
          id: 'only_step',
          name: 'Only Step',
          profileId: 'gemini-flash',
          prompt: 'Do something'
        }
      ]
    }
    await saveWorkflow(tempDir, customReview)

    const loaded = await loadWorkflow(tempDir, 'code-review-fix')
    expect(loaded.name).toBe('Custom On Disk Review')
  })

  it('seeds built-in workflows to disk when .opencode/workflows is empty', async () => {
    const seeded = await seedBuiltinWorkflows(tempDir)
    expect(seeded.length).toBe(2)

    // Verify files were actually written to disk
    const list = await listWorkflows(tempDir)
    expect(list.length).toBeGreaterThanOrEqual(2)

    // Calling seed again does not duplicate or overwrite existing files
    const secondSeeded = await seedBuiltinWorkflows(tempDir)
    expect(secondSeeded).toEqual([])
  })

  it('skips invalid JSON or malformed workflow files when listing', async () => {
    await saveWorkflow(tempDir, sampleWorkflow)

    // Write a corrupted file into the workflows folder
    const corruptedPath = join(tempDir, '.opencode', 'workflows', 'corrupt.json')
    writeFileSync(corruptedPath, '{"broken": json', 'utf-8')

    // Write an invalid workflow (cyclic dependency)
    const cyclicPath = join(tempDir, '.opencode', 'workflows', 'cycle.json')
    const cyclicWorkflow = {
      id: 'cycle',
      name: 'Cyclic',
      nodes: [
        { id: 'a', profileId: 'p', prompt: 'a', dependencies: ['b'] },
        { id: 'b', profileId: 'p', prompt: 'b', dependencies: ['a'] }
      ]
    }
    writeFileSync(cyclicPath, JSON.stringify(cyclicWorkflow), 'utf-8')

    // Default disk-only listing skips corrupt and cyclic
    const diskList = await listWorkflows(tempDir)
    expect(diskList).toHaveLength(1)
    expect(diskList[0].id).toBe('sample-workflow')

    // Merged listing skips corrupt and cyclic while including built-ins
    const list = await listWorkflows(tempDir, { includeBuiltin: true })
    expect(list.map((w) => w.id)).toContain('sample-workflow')
    expect(list.map((w) => w.id)).toContain('code-review-fix')
    expect(list.map((w) => w.id)).not.toContain('corrupt')
    expect(list.map((w) => w.id)).not.toContain('cycle')
  })

  it('rejects saving invalid workflow definitions', async () => {
    const invalidWorkflow = {
      id: 'bad-wf',
      name: 'Bad',
      nodes: [
        { id: 'a', profileId: 'p', prompt: 'a', dependencies: ['nonexistent'] }
      ]
    } as WorkflowDefinition

    await expect(saveWorkflow(tempDir, invalidWorkflow)).rejects.toThrow(
      /Invalid workflow definition/
    )
  })

  it('deletes an existing workflow and returns true', async () => {
    await saveWorkflow(tempDir, sampleWorkflow)

    const deleted = await deleteWorkflow(tempDir, 'sample-workflow')
    expect(deleted).toBe(true)

    const loaded = await getWorkflow(tempDir, 'sample-workflow')
    expect(loaded).toBeNull()
  })

  it('returns false when deleting a non-existent workflow', async () => {
    const deleted = await deleteWorkflow(tempDir, 'not-there')
    expect(deleted).toBe(false)
  })

  it('strictly rejects path containment violations (directory traversal / .. escapes)', async () => {
    await expect(getWorkflow(tempDir, '../../escaped')).rejects.toThrow(
      /strictly inside the project directory/i
    )

    await expect(deleteWorkflow(tempDir, '..\\..\\evil')).rejects.toThrow(
      /strictly inside the project directory/i
    )

    const escapingWorkflow: WorkflowDefinition = {
      ...sampleWorkflow,
      id: '../../outside'
    }

    await expect(saveWorkflow(tempDir, escapingWorkflow)).rejects.toThrow(
      /strictly inside the project directory/i
    )

    await expect(loadWorkflow(tempDir, '../../escaped')).rejects.toThrow(
      /strictly inside the project directory/i
    )
  })
})
