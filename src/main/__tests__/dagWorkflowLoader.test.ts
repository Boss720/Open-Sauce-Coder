import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow
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

  it('returns an empty list when .opencode/workflows does not exist', async () => {
    const list = await listWorkflows(tempDir)
    expect(list).toEqual([])
  })

  it('saves and lists workflows correctly', async () => {
    await saveWorkflow(tempDir, sampleWorkflow)

    const list = await listWorkflows(tempDir)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('sample-workflow')
    expect(list[0].name).toBe('Sample Workflow')
    expect(list[0].nodes).toHaveLength(2)
  })

  it('loads a specific workflow by id via getWorkflow', async () => {
    await saveWorkflow(tempDir, sampleWorkflow)

    const loaded = await getWorkflow(tempDir, 'sample-workflow')
    expect(loaded).toBeDefined()
    expect(loaded?.id).toBe('sample-workflow')
    expect(loaded?.nodes[0].id).toBe('step_1')
    expect(loaded?.nodes[1].id).toBe('step_2')
  })

  it('returns null when loading a non-existent workflow id', async () => {
    const loaded = await getWorkflow(tempDir, 'missing-workflow')
    expect(loaded).toBeNull()
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

    const list = await listWorkflows(tempDir)
    // Only the valid sampleWorkflow should be returned
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('sample-workflow')
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
  })
})
