import { describe, expect, it, vi } from 'vitest'
import { DagController, getDagController } from '../harness/dag/controller'
import type { DagEvent, DagNodeDefinition, WorkflowDefinition } from '../harness/dag/types'
import type { AgentRunner, RunnerResult } from '../harness/runner'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function makeValidWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  const node1: DagNodeDefinition = {
    id: 'step-1',
    profileId: 'mock-profile',
    prompt: 'Initial step'
  }
  const node2: DagNodeDefinition = {
    id: 'step-2',
    profileId: 'mock-profile',
    prompt: 'Follow-up: {{inputs.step-1.output}}',
    dependencies: ['step-1']
  }

  return {
    id: 'wf-' + Math.random().toString(36).slice(2, 7),
    name: 'Sample Workflow',
    nodes: [node1, node2],
    ...overrides
  }
}

function mockRunnerFactory(delayMs = 0) {
  return (params: { id: string; nodeId: string }) => {
    const abortFn = vi.fn()
    const runFn = vi.fn(async (): Promise<RunnerResult> => {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs))
      }
      return {
        content: `Completed ${params.nodeId}`,
        toolCallCount: 0,
        usage: { input: 10, output: 10, reasoning: 0 },
        turns: 1,
        finishReason: 'complete'
      }
    })

    return {
      id: params.id,
      run: runFn,
      abort: abortFn,
      getStatus: () => ({ turns: 1, usage: { input: 10, output: 10 }, running: false })
    } as unknown as AgentRunner
  }
}

describe('DagController', () => {
  it('starts a DAG run and queries status', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'dag-test-'))
    try {
      const controller = new DagController({ runnerFactory: mockRunnerFactory(5) })
      const workflow = makeValidWorkflow()

      const { dagRunId } = await controller.startDagRun({ workflow, directory: testDir })
      expect(typeof dagRunId).toBe('string')
      expect(dagRunId.length).toBeGreaterThan(0)

      const statusImmediately = controller.getDagRunStatus(dagRunId)
      expect(statusImmediately).not.toBeNull()
      expect(statusImmediately?.dagRunId).toBe(dagRunId)
      expect(statusImmediately?.workflowId).toBe(workflow.id)

      // Wait for run to settle
      await new Promise((r) => setTimeout(r, 60))

      const statusAfter = controller.getDagRunStatus(dagRunId)
      expect(statusAfter?.status).toBe('completed')
      expect(statusAfter?.nodeStates['step-1']).toBe('succeeded')
      expect(statusAfter?.nodeStates['step-2']).toBe('succeeded')
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('stops an active DAG run and transitions status to cancelled', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'dag-test-'))
    try {
      const controller = new DagController({ runnerFactory: mockRunnerFactory(200) })
      const workflow = makeValidWorkflow()

      const { dagRunId } = await controller.startDagRun({ workflow, directory: testDir })
      expect(controller.getDagRunStatus(dagRunId)?.status).toBe('running')

      // Stop active run
      const stopped = await controller.stopDagRun(dagRunId)
      expect(stopped).toBe(true)

      const statusAfterStop = controller.getDagRunStatus(dagRunId)
      expect(statusAfterStop?.status).toBe('cancelled')
      expect(typeof statusAfterStop?.completedAt).toBe('number')

      // Stopping an already cancelled run returns false
      const stoppedAgain = await controller.stopDagRun(dagRunId)
      expect(stoppedAgain).toBe(false)
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('returns null when querying status for unknown dagRunId', () => {
    const controller = new DagController()
    expect(controller.getDagRunStatus('non-existent-id')).toBeNull()
  })

  it('returns false when stopping unknown dagRunId', async () => {
    const controller = new DagController()
    const stopped = await controller.stopDagRun('unknown-run-id')
    expect(stopped).toBe(false)
  })

  it('lists summaries of all recorded DAG runs', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'dag-test-'))
    try {
      const controller = new DagController({ runnerFactory: mockRunnerFactory(5) })
      const wf1 = makeValidWorkflow({ id: 'wf-first' })
      const wf2 = makeValidWorkflow({ id: 'wf-second' })

      const { dagRunId: id1 } = await controller.startDagRun({ workflow: wf1, directory: testDir })
      const { dagRunId: id2 } = await controller.startDagRun({ workflow: wf2, directory: testDir })

      const runs = controller.listDagRuns()
      expect(runs.length).toBe(2)
      const ids = runs.map((r) => r.dagRunId)
      expect(ids).toContain(id1)
      expect(ids).toContain(id2)

      const summary1 = runs.find((r) => r.dagRunId === id1)
      expect(summary1?.workflowId).toBe('wf-first')
      expect(typeof summary1?.startedAt).toBe('number')
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('rejects invalid workflows on startDagRun with descriptive validation errors', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'dag-test-'))
    try {
      const controller = new DagController()

      // Cyclic workflow
      const cyclicWorkflow: WorkflowDefinition = {
        id: 'cyclic',
        name: 'Cyclic',
        nodes: [
          { id: 'nodeA', profileId: 'p', prompt: 'prompt', dependencies: ['nodeB'] },
          { id: 'nodeB', profileId: 'p', prompt: 'prompt', dependencies: ['nodeA'] }
        ]
      }

      await expect(
        controller.startDagRun({ workflow: cyclicWorkflow, directory: testDir })
      ).rejects.toThrow(/Cyclic dependency detected/i)

      // Missing dependency
      const missingDepWorkflow: WorkflowDefinition = {
        id: 'missing-dep',
        name: 'Missing Dep',
        nodes: [
          { id: 'nodeA', profileId: 'p', prompt: 'prompt', dependencies: ['ghost-node'] }
        ]
      }

      await expect(
        controller.startDagRun({ workflow: missingDepWorkflow, directory: testDir })
      ).rejects.toThrow(/depends on unknown node "ghost-node"/i)

      // Empty nodes
      const emptyNodesWorkflow = {
        id: 'empty',
        name: 'Empty',
        nodes: []
      } as unknown as WorkflowDefinition

      await expect(
        controller.startDagRun({ workflow: emptyNodesWorkflow, directory: testDir })
      ).rejects.toThrow(/at least one node/i)
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('rejects directory path escaping via assertSubpath', async () => {
    const controller = new DagController()
    const workflow = makeValidWorkflow()

    await expect(
      controller.startDagRun({ workflow, directory: '   ' })
    ).rejects.toThrow(/non-empty/i)
  })

  it('forwards DAG execution events to registered event callback', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'dag-test-'))
    try {
      const controller = new DagController({ runnerFactory: mockRunnerFactory(5) })
      const workflow = makeValidWorkflow()

      const receivedEvents: Array<{ dagRunId: string; event: DagEvent }> = []
      controller.setEventCallback((dagRunId, event) => {
        receivedEvents.push({ dagRunId, event })
      })

      const { dagRunId } = await controller.startDagRun({ workflow, directory: testDir })

      // Await completion
      await new Promise((r) => setTimeout(r, 60))

      expect(receivedEvents.length).toBeGreaterThan(0)
      for (const item of receivedEvents) {
        expect(item.dagRunId).toBe(dagRunId)
      }

      const types = receivedEvents.map((e) => e.event.type)
      expect(types).toContain('dag_start')
      expect(types).toContain('dag_wave_start')
      expect(types).toContain('dag_node_start')
      expect(types).toContain('dag_node_complete')
      expect(types).toContain('dag_wave_complete')
      expect(types).toContain('dag_complete')
    } finally {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('provides a singleton instance via getDagController()', () => {
    const c1 = getDagController()
    const c2 = getDagController()
    expect(c1).toBe(c2)
    expect(c1).toBeInstanceOf(DagController)
  })
})
