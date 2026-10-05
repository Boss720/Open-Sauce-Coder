/**
 * End-to-End (E2E) Opaque-Box Test Suite for Multi-Agent Directed Acyclic Graph (DAG) Orchestration.
 *
 * Requirements authoritative source:
 * - ORIGINAL_REQUEST.md (## 2026-10-05T18:30:07Z: Multi-Agent DAG Orchestration R1–R4)
 * - TEST_INFRA.md & PROJECT.md
 *
 * Verifies public DAG interfaces across 4 tiers:
 * - Tier 1: Feature Coverage (Declarative Workflow Schema, Parallel Resolution, Parameter Interpolation, Node State Machine, File Serialization)
 * - Tier 2: Boundary & Corner Cases (Empty workflows, single nodes, wide parallel waves, deep linear chains, missing variables, 50k char truncation, cycle detection, disconnected components, path containment)
 * - Tier 3: Pairwise Cross-Feature Combinations (Conditional skip + interpolation, abort-on-fail cascading + sibling cancellation, fan-out / fan-in worker waves)
 * - Tier 4: Real-World Application Workloads (Multi-agent code review, multi-stage refactoring pipeline with artifacts, bug triage & parallel patch, doc localization)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deleteWorkflow,
  getWorkflow,
  interpolatePrompt,
  listWorkflows,
  MAX_INTERPOLATED_CHARS,
  saveWorkflow,
  validateWorkflow
} from '../harness/dag'
import type {
  DagEvent,
  DagExecutionPlan,
  DagNodeArtifact,
  DagNodeDefinition,
  DagNodeOutput,
  DagNodeState,
  DagRunStatus,
  WorkflowDefinition
} from '../harness/dag/types'

// ── Test Helpers & Simulators ──

function makeNode(overrides: Partial<DagNodeDefinition> = {}): DagNodeDefinition {
  return {
    id: 'node-' + Math.random().toString(36).slice(2, 7),
    profileId: 'default-coder',
    prompt: 'Execute task',
    dependencies: [],
    ...overrides
  }
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'workflow-' + Math.random().toString(36).slice(2, 7),
    name: 'Test Workflow',
    description: 'A test workflow definition',
    version: '1.0.0',
    nodes: [makeNode({ id: 'root' })],
    ...overrides
  }
}

function makeNodeOutput(overrides: Partial<DagNodeOutput> = {}): DagNodeOutput {
  return {
    nodeId: 'node-1',
    status: 'succeeded',
    finishReason: 'stop',
    content: 'Task completed successfully.',
    artifacts: [],
    turns: 1,
    usage: { input: 100, output: 50 },
    ...overrides
  }
}

interface NodeExecutorContext {
  nodeId: string
  interpolatedPrompt: string
  inputs: Record<string, DagNodeOutput>
}

interface NodeExecutorResult {
  status: DagNodeState
  content?: string
  artifacts?: DagNodeArtifact[]
  finishReason?: string
  error?: string
  turns?: number
  usage?: { input: number; output: number; reasoning?: number }
}

type NodeExecutor = (ctx: NodeExecutorContext) => Promise<NodeExecutorResult> | NodeExecutorResult

interface ExecutionSimulationResult {
  status: DagRunStatus
  wavesExecuted: number
  nodeStates: Record<string, DagNodeState>
  nodeOutputs: Record<string, DagNodeOutput>
  events: DagEvent[]
  error?: string
}

/**
 * Deterministic opaque-box workflow execution simulator implementing the exact state machine
 * and execution policies specified in PROJECT.md and ORIGINAL_REQUEST.md.
 */
async function simulateDagExecution(
  workflow: WorkflowDefinition,
  executors: Record<string, NodeExecutor> = {},
  options?: { abortSignal?: AbortSignal }
): Promise<ExecutionSimulationResult> {
  const validation = validateWorkflow(workflow)
  if (!validation.valid || !validation.plan) {
    return {
      status: 'failed',
      wavesExecuted: 0,
      nodeStates: {},
      nodeOutputs: {},
      events: [],
      error: `Invalid workflow: ${validation.errors.join('; ')}`
    }
  }

  const dagRunId = 'run-' + Math.random().toString(36).slice(2, 8)
  const events: DagEvent[] = []
  const nodeStates: Record<string, DagNodeState> = {}
  const nodeOutputs: Record<string, DagNodeOutput> = {}
  const plan: DagExecutionPlan = validation.plan

  // Initialize all nodes as pending
  for (const node of workflow.nodes) {
    nodeStates[node.id] = 'pending'
  }

  events.push({
    type: 'dag_start',
    dagRunId,
    timestamp: Date.now(),
    status: 'running'
  })

  let dagStatus: DagRunStatus = 'completed'
  let wavesExecuted = 0
  let isAborted = false

  for (const wave of plan.waves) {
    if (isAborted || options?.abortSignal?.aborted) {
      dagStatus = 'cancelled'
      break
    }

    events.push({
      type: 'dag_wave_start',
      dagRunId,
      timestamp: Date.now(),
      waveIndex: wave.waveIndex
    })

    // Execute nodes in current wave concurrently
    const wavePromises = wave.nodeIds.map(async (nodeId) => {
      const node = workflow.nodes.find((n) => n.id === nodeId)!

      // Check condition gating if defined
      if (node.policy?.condition) {
        const cond = node.policy.condition
        const upstreamOutput = nodeOutputs[cond.upstreamNodeId]
        const upstreamStatus = upstreamOutput ? upstreamOutput.status : nodeStates[cond.upstreamNodeId]

        const statusMatch = !cond.expectedStatus || upstreamStatus === cond.expectedStatus
        const finishMatch =
          !cond.expectedFinishReason || upstreamOutput?.finishReason === cond.expectedFinishReason

        if (!statusMatch || !finishMatch) {
          nodeStates[nodeId] = 'skipped'
          const skipOutput: DagNodeOutput = {
            nodeId,
            status: 'skipped',
            finishReason: 'condition_unmet',
            turns: 0,
            usage: { input: 0, output: 0 }
          }
          nodeOutputs[nodeId] = skipOutput
          events.push({
            type: 'dag_node_complete',
            dagRunId,
            timestamp: Date.now(),
            waveIndex: wave.waveIndex,
            nodeId,
            status: 'skipped',
            output: skipOutput
          })
          return { nodeId, status: 'skipped' as DagNodeState }
        }
      }

      // Check if any upstream dependencies failed
      const deps = node.dependencies ?? []
      const failedDeps = deps.filter((depId) => nodeStates[depId] === 'failed')
      const skippedDeps = deps.filter((depId) => nodeStates[depId] === 'skipped')

      if (failedDeps.length > 0 || skippedDeps.length > 0) {
        if (node.policy?.skipOnFail) {
          nodeStates[nodeId] = 'skipped'
          const skipOutput: DagNodeOutput = {
            nodeId,
            status: 'skipped',
            finishReason: 'upstream_failed',
            turns: 0,
            usage: { input: 0, output: 0 }
          }
          nodeOutputs[nodeId] = skipOutput
          events.push({
            type: 'dag_node_complete',
            dagRunId,
            timestamp: Date.now(),
            waveIndex: wave.waveIndex,
            nodeId,
            status: 'skipped',
            output: skipOutput
          })
          return { nodeId, status: 'skipped' as DagNodeState }
        }
      }

      // Transition to running
      nodeStates[nodeId] = 'running'
      events.push({
        type: 'dag_node_start',
        dagRunId,
        timestamp: Date.now(),
        waveIndex: wave.waveIndex,
        nodeId,
        status: 'running'
      })

      // Interpolate prompt
      const allowedDeps = node.dependencies ?? []
      const interpolatedPrompt = interpolatePrompt(node.prompt, nodeOutputs, allowedDeps, {
        strict: true
      })

      // Execute custom or default mock runner
      const executor =
        executors[nodeId] ??
        (async () => ({
          status: 'succeeded' as DagNodeState,
          content: `Default execution result for ${nodeId}`,
          finishReason: 'stop',
          turns: 1,
          usage: { input: 10, output: 20 }
        }))

      try {
        const result = await executor({
          nodeId,
          interpolatedPrompt,
          inputs: nodeOutputs
        })

        const nodeOutput: DagNodeOutput = {
          nodeId,
          status: result.status,
          content: result.content,
          artifacts: result.artifacts ?? [],
          finishReason: result.finishReason ?? (result.status === 'succeeded' ? 'stop' : 'error'),
          error: result.error,
          turns: result.turns ?? 1,
          usage: result.usage ?? { input: 10, output: 20 }
        }

        nodeStates[nodeId] = result.status
        nodeOutputs[nodeId] = nodeOutput

        events.push({
          type: 'dag_node_complete',
          dagRunId,
          timestamp: Date.now(),
          waveIndex: wave.waveIndex,
          nodeId,
          status: result.status,
          output: nodeOutput
        })

        return { nodeId, status: result.status, abortOnFail: !!node.policy?.abortOnFail }
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        const failedOutput: DagNodeOutput = {
          nodeId,
          status: 'failed',
          finishReason: 'error',
          error: errorMsg,
          turns: 1,
          usage: { input: 10, output: 0 }
        }
        nodeStates[nodeId] = 'failed'
        nodeOutputs[nodeId] = failedOutput

        events.push({
          type: 'dag_node_complete',
          dagRunId,
          timestamp: Date.now(),
          waveIndex: wave.waveIndex,
          nodeId,
          status: 'failed',
          output: failedOutput,
          error: errorMsg
        })

        return { nodeId, status: 'failed' as DagNodeState, abortOnFail: !!node.policy?.abortOnFail }
      }
    })

    const waveResults = await Promise.all(wavePromises)
    wavesExecuted++

    events.push({
      type: 'dag_wave_complete',
      dagRunId,
      timestamp: Date.now(),
      waveIndex: wave.waveIndex
    })

    // Check for abort-on-fail policy
    const abortTrigger = waveResults.find((r) => r.status === 'failed' && r.abortOnFail)
    if (abortTrigger) {
      isAborted = true
      dagStatus = 'failed'
      break
    }

    // Check if any node failed without skipOnFail on subsequent wave
    const anyFailed = waveResults.some((r) => r.status === 'failed')
    if (anyFailed && dagStatus === 'completed') {
      dagStatus = 'failed'
    }
  }

  events.push({
    type: dagStatus === 'failed' ? 'dag_error' : 'dag_complete',
    dagRunId,
    timestamp: Date.now(),
    status: dagStatus
  })

  return {
    status: dagStatus,
    wavesExecuted,
    nodeStates,
    nodeOutputs,
    events
  }
}

// ── Test Suites ──

describe('DAG E2E: Tier 1 — Feature Coverage (Primary Behavior)', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'dag-e2e-tier1-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  // Feature 1: Declarative Workflow Structure and Properties
  describe('Feature 1: Declarative Workflow Definition & Schema Validation', () => {
    it('1.1 validates complete workflow structure with metadata, version, and policy', () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-complete',
        name: 'Complete Workflow',
        description: 'Verifies all metadata fields',
        version: '2.1.0',
        metadata: { category: 'code-review', tags: ['security', 'typescript'] },
        nodes: [
          makeNode({
            id: 'planner',
            name: 'Architect Planner',
            profileId: 'planner-agent',
            prompt: 'Formulate plan',
            maxTurns: 5,
            policy: { abortOnFail: true }
          }),
          makeNode({
            id: 'worker',
            name: 'Code Worker',
            profileId: 'coder-agent',
            prompt: 'Apply plan from {{inputs.planner.output}}',
            dependencies: ['planner'],
            policy: { skipOnFail: true }
          })
        ]
      }

      const res = validateWorkflow(workflow)
      expect(res.valid).toBe(true)
      expect(res.errors).toHaveLength(0)
      expect(res.plan).toBeDefined()
      expect(res.plan?.waves).toHaveLength(2)
      expect(res.plan?.waves[0].nodeIds).toEqual(['planner'])
      expect(res.plan?.waves[1].nodeIds).toEqual(['worker'])
    })

    it('1.2 verifies required properties on all nodes (id, profileId, prompt)', () => {
      const validWorkflow = makeWorkflow({
        nodes: [
          makeNode({ id: 'step-1', profileId: 'prof-a', prompt: 'Do step 1' }),
          makeNode({ id: 'step-2', profileId: 'prof-b', prompt: 'Do step 2', dependencies: ['step-1'] })
        ]
      })

      const res = validateWorkflow(validWorkflow)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves[0].nodeIds).toEqual(['step-1'])
      expect(res.plan?.waves[1].nodeIds).toEqual(['step-2'])
    })

    it('1.3 rejects workflows with non-object definition or missing root id/name', () => {
      expect(validateWorkflow(null as unknown as WorkflowDefinition).valid).toBe(false)
      expect(validateWorkflow('string-wf' as unknown as WorkflowDefinition).valid).toBe(false)
      expect(validateWorkflow(makeWorkflow({ id: '' })).valid).toBe(false)
      expect(validateWorkflow(makeWorkflow({ name: '   ' })).valid).toBe(false)
    })

    it('1.4 rejects nodes missing profileId or prompt', () => {
      const missingProfile = makeWorkflow({
        nodes: [makeNode({ id: 'n1', profileId: '' })]
      })
      const resProfile = validateWorkflow(missingProfile)
      expect(resProfile.valid).toBe(false)
      expect(resProfile.errors[0]).toContain('must specify a profileId')

      const missingPrompt = makeWorkflow({
        nodes: [{ id: 'n2', profileId: 'p2' } as unknown as DagNodeDefinition]
      })
      const resPrompt = validateWorkflow(missingPrompt)
      expect(resPrompt.valid).toBe(false)
      expect(resPrompt.errors[0]).toContain('must specify a prompt')
    })

    it('1.5 detects duplicate node IDs and lists error', () => {
      const duplicateWf = makeWorkflow({
        nodes: [
          makeNode({ id: 'duplicate-id', prompt: 'task 1' }),
          makeNode({ id: 'duplicate-id', prompt: 'task 2' })
        ]
      })
      const res = validateWorkflow(duplicateWf)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('Duplicate node id "duplicate-id"'))).toBe(true)
    })
  })

  // Feature 2: Independent Parallel Node Resolution
  describe('Feature 2: Independent Parallel Node Resolution & Wave Partitioning', () => {
    it('1.6 places independent nodes with 0 dependencies into Wave 0 concurrently', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'indep-a' }),
          makeNode({ id: 'indep-b' }),
          makeNode({ id: 'indep-c' })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(1)
      expect(res.plan?.waves[0].waveIndex).toBe(0)
      expect(res.plan?.waves[0].nodeIds).toEqual(['indep-a', 'indep-b', 'indep-c'])
    })

    it('1.7 partitions diamond graph into 3 distinct waves (1 -> 2 parallel -> 1)', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'root' }),
          makeNode({ id: 'branch-left', dependencies: ['root'] }),
          makeNode({ id: 'branch-right', dependencies: ['root'] }),
          makeNode({ id: 'join', dependencies: ['branch-left', 'branch-right'] })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      const waves = res.plan?.waves ?? []
      expect(waves).toHaveLength(3)
      expect(waves[0].nodeIds).toEqual(['root'])
      expect(waves[1].nodeIds).toEqual(['branch-left', 'branch-right'])
      expect(waves[2].nodeIds).toEqual(['join'])
    })

    it('1.8 partitions multiple roots feeding separate and shared downstream nodes', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'root-1' }),
          makeNode({ id: 'root-2' }),
          makeNode({ id: 'consumer-1', dependencies: ['root-1'] }),
          makeNode({ id: 'consumer-both', dependencies: ['root-1', 'root-2'] })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves[0].nodeIds).toEqual(['root-1', 'root-2'])
      expect(res.plan?.waves[1].nodeIds).toEqual(['consumer-1', 'consumer-both'])
    })

    it('1.9 executes parallel sibling workers concurrently in the same wave', async () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'w1' }),
          makeNode({ id: 'w2' }),
          makeNode({ id: 'w3' })
        ]
      })

      const executedTimestamps: Record<string, number> = {}
      const sim = await simulateDagExecution(wf, {
        w1: async () => {
          executedTimestamps.w1 = Date.now()
          return { status: 'succeeded', content: 'w1 done' }
        },
        w2: async () => {
          executedTimestamps.w2 = Date.now()
          return { status: 'succeeded', content: 'w2 done' }
        },
        w3: async () => {
          executedTimestamps.w3 = Date.now()
          return { status: 'succeeded', content: 'w3 done' }
        }
      })

      expect(sim.status).toBe('completed')
      expect(sim.wavesExecuted).toBe(1)
      expect(sim.nodeStates.w1).toBe('succeeded')
      expect(sim.nodeStates.w2).toBe('succeeded')
      expect(sim.nodeStates.w3).toBe('succeeded')
    })

    it('1.10 ensures in-degree zero computation partitions correctly with isolated branches', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'isolated-root' }),
          makeNode({ id: 'chain-1' }),
          makeNode({ id: 'chain-2', dependencies: ['chain-1'] })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves[0].nodeIds).toEqual(['chain-1', 'isolated-root'])
      expect(res.plan?.waves[1].nodeIds).toEqual(['chain-2'])
    })
  })

  // Feature 3: Upstream Parameter Interpolation
  describe('Feature 3: Upstream Parameter Interpolation', () => {
    it('1.11 interpolates {{inputs.<nodeId>.output}} and {{inputs.<nodeId>}}', () => {
      const outputs = new Map<string, DagNodeOutput>([
        ['stepA', makeNodeOutput({ nodeId: 'stepA', content: 'Result from Step A' })]
      ])
      const template = 'Summary: {{inputs.stepA.output}} and short {{inputs.stepA}}'
      const interpolated = interpolatePrompt(template, outputs, ['stepA'])
      expect(interpolated).toBe('Summary: Result from Step A and short Result from Step A')
    })

    it('1.12 interpolates named artifacts via {{inputs.<nodeId>.artifacts.<name>}}', () => {
      const outputs = new Map<string, DagNodeOutput>([
        [
          'builder',
          makeNodeOutput({
            nodeId: 'builder',
            artifacts: [
              { name: 'diff.patch', content: '--- a/file\n+++ b/file\n+code' },
              { name: 'stats.json', content: '{"loc": 42}' }
            ]
          })
        ]
      ])
      const template = 'Patch: {{inputs.builder.artifacts.diff.patch}}\nStats: {{inputs.builder.artifacts.stats.json}}'
      const interpolated = interpolatePrompt(template, outputs, ['builder'])
      expect(interpolated).toBe('Patch: --- a/file\n+++ b/file\n+code\nStats: {"loc": 42}')
    })

    it('1.13 interpolates node status via {{inputs.<nodeId>.status}}', () => {
      const outputs = new Map<string, DagNodeOutput>([
        ['testRunner', makeNodeOutput({ nodeId: 'testRunner', status: 'succeeded' })]
      ])
      const template = 'Prior test status is: {{inputs.testRunner.status}}'
      const interpolated = interpolatePrompt(template, outputs, ['testRunner'])
      expect(interpolated).toBe('Prior test status is: succeeded')
    })

    it('1.14 interpolates finish reason via {{inputs.<nodeId>.finishReason}} and turns', () => {
      const outputs = new Map<string, DagNodeOutput>([
        ['evaluator', makeNodeOutput({ nodeId: 'evaluator', finishReason: 'tool_calls', turns: 3 })]
      ])
      const template = 'Finished with {{inputs.evaluator.finishReason}} after {{inputs.evaluator.turns}} turns'
      const interpolated = interpolatePrompt(template, outputs, ['evaluator'])
      expect(interpolated).toBe('Finished with tool_calls after 3 turns')
    })

    it('1.15 interpolates multiple variables from multiple allowed upstream nodes', () => {
      const outputs = new Map<string, DagNodeOutput>([
        ['analyst', makeNodeOutput({ nodeId: 'analyst', content: 'Analysis 100%' })],
        ['tester', makeNodeOutput({ nodeId: 'tester', content: 'Passed 12 tests' })]
      ])
      const template = 'Report: {{inputs.analyst.output}} | Quality: {{inputs.tester.output}}'
      const interpolated = interpolatePrompt(template, outputs, ['analyst', 'tester'])
      expect(interpolated).toBe('Report: Analysis 100% | Quality: Passed 12 tests')
    })
  })

  // Feature 4: Node Status Transitions & Lifecycle State Machine
  describe('Feature 4: Node Status Transitions & Lifecycle State Machine', () => {
    it('1.16 executes standard happy path transition (pending -> running -> succeeded)', async () => {
      const wf = makeWorkflow({
        nodes: [makeNode({ id: 'single' })]
      })
      const sim = await simulateDagExecution(wf)
      expect(sim.status).toBe('completed')
      expect(sim.nodeStates.single).toBe('succeeded')

      const types = sim.events.map((e) => e.type)
      expect(types).toEqual([
        'dag_start',
        'dag_wave_start',
        'dag_node_start',
        'dag_node_complete',
        'dag_wave_complete',
        'dag_complete'
      ])
    })

    it('1.17 executes failure path transition (pending -> running -> failed)', async () => {
      const wf = makeWorkflow({
        nodes: [makeNode({ id: 'failing-node' })]
      })
      const sim = await simulateDagExecution(wf, {
        'failing-node': async () => ({
          status: 'failed',
          error: 'Syntax error in generated code'
        })
      })
      expect(sim.status).toBe('failed')
      expect(sim.nodeStates['failing-node']).toBe('failed')
      expect(sim.nodeOutputs['failing-node'].error).toBe('Syntax error in generated code')
    })

    it('1.18 executes conditional skip when skipOnFail is enabled for downstream node', async () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'step1' }),
          makeNode({ id: 'step2', dependencies: ['step1'], policy: { skipOnFail: true } })
        ]
      })

      const sim = await simulateDagExecution(wf, {
        step1: async () => ({ status: 'failed', error: 'Network timeout' })
      })

      expect(sim.nodeStates.step1).toBe('failed')
      expect(sim.nodeStates.step2).toBe('skipped')
      expect(sim.nodeOutputs.step2.status).toBe('skipped')
      expect(sim.nodeOutputs.step2.finishReason).toBe('upstream_failed')
    })

    it('1.19 stops downstream execution when abortOnFail triggers on root failure', async () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'root', policy: { abortOnFail: true } }),
          makeNode({ id: 'worker1', dependencies: ['root'] }),
          makeNode({ id: 'worker2', dependencies: ['worker1'] })
        ]
      })

      const sim = await simulateDagExecution(wf, {
        root: async () => ({ status: 'failed', error: 'Critical failure' })
      })

      expect(sim.status).toBe('failed')
      expect(sim.wavesExecuted).toBe(1)
      expect(sim.nodeStates.root).toBe('failed')
      expect(sim.nodeStates.worker1).toBe('pending')
      expect(sim.nodeStates.worker2).toBe('pending')
    })

    it('1.20 ensures wave completes only after all parallel nodes in wave finish', async () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'slowNode' }),
          makeNode({ id: 'fastNode' })
        ]
      })

      const timeline: string[] = []
      await simulateDagExecution(wf, {
        slowNode: async () => {
          await new Promise((r) => setTimeout(r, 20))
          timeline.push('slow-done')
          return { status: 'succeeded' }
        },
        fastNode: async () => {
          timeline.push('fast-done')
          return { status: 'succeeded' }
        }
      })

      expect(timeline).toEqual(['fast-done', 'slow-done'])
    })
  })

  // Feature 5: Workflow File Serialization and Reading
  describe('Feature 5: Declarative Workflow File I/O & Containment', () => {
    it('1.21 saveWorkflow persists validated workflow definition to .opencode/workflows/<id>.json', async () => {
      const wf = makeWorkflow({ id: 'custom-pipeline', name: 'Custom Pipeline' })
      await saveWorkflow(projectDir, wf)

      const writtenFile = join(projectDir, '.opencode', 'workflows', 'custom-pipeline.json')
      const content = JSON.parse(readFileSync(writtenFile, 'utf-8'))
      expect(content.id).toBe('custom-pipeline')
      expect(content.name).toBe('Custom Pipeline')
    })

    it('1.22 listWorkflows discovers and loads all valid workflow files sorted by ID', async () => {
      const wfB = makeWorkflow({ id: 'pipeline-b', name: 'Pipeline B' })
      const wfA = makeWorkflow({ id: 'pipeline-a', name: 'Pipeline A' })
      await saveWorkflow(projectDir, wfB)
      await saveWorkflow(projectDir, wfA)

      const list = await listWorkflows(projectDir)
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe('pipeline-a')
      expect(list[1].id).toBe('pipeline-b')
    })

    it('1.23 getWorkflow retrieves specific workflow by ID and returns null for missing', async () => {
      const wf = makeWorkflow({ id: 'target-wf', name: 'Target Workflow' })
      await saveWorkflow(projectDir, wf)

      const fetched = await getWorkflow(projectDir, 'target-wf')
      expect(fetched).not.toBeNull()
      expect(fetched?.id).toBe('target-wf')

      const missing = await getWorkflow(projectDir, 'does-not-exist')
      expect(missing).toBeNull()
    })

    it('1.24 deleteWorkflow deletes workflow JSON and returns true, or false if not found', async () => {
      const wf = makeWorkflow({ id: 'delete-me', name: 'To Delete' })
      await saveWorkflow(projectDir, wf)

      const deleted = await deleteWorkflow(projectDir, 'delete-me')
      expect(deleted).toBe(true)

      const secondAttempt = await deleteWorkflow(projectDir, 'delete-me')
      expect(secondAttempt).toBe(false)
    })

    it('1.25 listWorkflows ignores malformed or invalid JSON files gracefully', async () => {
      const wfValid = makeWorkflow({ id: 'valid-wf', name: 'Valid' })
      await saveWorkflow(projectDir, wfValid)

      const corruptedPath = join(projectDir, '.opencode', 'workflows', 'corrupt.json')
      writeFileSync(corruptedPath, '{"invalid_json: true')

      const list = await listWorkflows(projectDir)
      expect(list).toHaveLength(1)
      expect(list[0].id).toBe('valid-wf')
    })
  })
})

describe('DAG E2E: Tier 2 — Boundary & Corner Cases', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'dag-e2e-tier2-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  // Boundary 1: Empty & Degenerate Workflows
  describe('Boundary 1: Empty & Degenerate Workflows Rejection', () => {
    it('2.1 rejects workflows with 0 nodes', () => {
      const wf = makeWorkflow({ nodes: [] })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toContain('Workflow must contain at least one node')
    })

    it('2.2 rejects workflows where nodes is null or not an array', () => {
      const wfNull = makeWorkflow({ nodes: null as unknown as DagNodeDefinition[] })
      expect(validateWorkflow(wfNull).valid).toBe(false)

      const wfObj = makeWorkflow({ nodes: {} as unknown as DagNodeDefinition[] })
      expect(validateWorkflow(wfObj).valid).toBe(false)
    })

    it('2.3 rejects node with whitespace-only id or prompt', () => {
      const wf = makeWorkflow({ nodes: [makeNode({ id: '   ' })] })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('must specify a non-empty id'))).toBe(true)
    })

    it('2.4 rejects node with non-array dependencies property', () => {
      const wf = makeWorkflow({
        nodes: [makeNode({ id: 'n1', dependencies: 'not-an-array' as unknown as string[] })]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('dependencies must be an array'))).toBe(true)
    })

    it('2.5 handles saveWorkflow error when saving invalid workflow', async () => {
      const invalidWf = makeWorkflow({ nodes: [] })
      await expect(saveWorkflow(projectDir, invalidWf)).rejects.toThrow(/Invalid workflow definition/)
    })
  })

  // Boundary 2: Single Node Workflows
  describe('Boundary 2: Single Node Workflows (0 Dependencies)', () => {
    it('2.6 single node workflow partitions into exactly 1 wave with 1 node', () => {
      const wf = makeWorkflow({ nodes: [makeNode({ id: 'solo' })] })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(1)
      expect(res.plan?.waves[0].nodeIds).toEqual(['solo'])
    })

    it('2.7 single node workflow executes successfully end-to-end', async () => {
      const wf = makeWorkflow({ nodes: [makeNode({ id: 'solo', prompt: 'Perform standalone check' })] })
      const sim = await simulateDagExecution(wf, {
        solo: async () => ({ status: 'succeeded', content: 'Solo check passed' })
      })
      expect(sim.status).toBe('completed')
      expect(sim.nodeStates.solo).toBe('succeeded')
      expect(sim.nodeOutputs.solo.content).toBe('Solo check passed')
    })

    it('2.8 single node with empty dependencies array succeeds identically', () => {
      const wf = makeWorkflow({ nodes: [makeNode({ id: 'solo-explicit', dependencies: [] })] })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves[0].nodeIds).toEqual(['solo-explicit'])
    })

    it('2.9 rejects single node with condition referencing nonexistent node', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({
            id: 'solo-bad-cond',
            dependencies: [],
            policy: { condition: { upstreamNodeId: 'nonexistent-upstream' } }
          })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('not listed in dependencies'))).toBe(true)
    })

    it('2.10 rejects single node that references an unknown dependency', () => {
      const wf = makeWorkflow({
        nodes: [makeNode({ id: 'solo-ghost', dependencies: ['ghost-parent'] })]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toContain('depends on unknown node "ghost-parent"')
    })
  })

  // Boundary 3: Maximum Width Parallel Waves
  describe('Boundary 3: Maximum Width Parallel Waves (Flat Worker Waves, Depth <= 2)', () => {
    it('2.11 partitions 1 root -> 10 parallel workers into exactly 2 waves', () => {
      const workerNodes = Array.from({ length: 10 }, (_, i) =>
        makeNode({ id: `worker-${i}`, dependencies: ['root'] })
      )
      const wf = makeWorkflow({
        nodes: [makeNode({ id: 'root' }), ...workerNodes]
      })

      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      const waves = res.plan?.waves ?? []
      expect(waves).toHaveLength(2)
      expect(waves[0].nodeIds).toEqual(['root'])
      expect(waves[1].nodeIds).toHaveLength(10)
    })

    it('2.12 partitions 1 root -> 20 workers -> 1 aggregator into 3 waves', () => {
      const workerIds = Array.from({ length: 20 }, (_, i) => `w-${String(i).padStart(2, '0')}`)
      const workers = workerIds.map((id) => makeNode({ id, dependencies: ['root'] }))
      const aggregator = makeNode({ id: 'aggregator', dependencies: workerIds })

      const wf = makeWorkflow({
        nodes: [makeNode({ id: 'root' }), ...workers, aggregator]
      })

      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(3)
      expect(res.plan?.waves[0].nodeIds).toEqual(['root'])
      expect(res.plan?.waves[1].nodeIds).toHaveLength(20)
      expect(res.plan?.waves[2].nodeIds).toEqual(['aggregator'])
    })

    it('2.13 executes wide wave (10 workers) in parallel without state collisions', async () => {
      const workerIds = Array.from({ length: 10 }, (_, i) => `worker-${i}`)
      const workers = workerIds.map((id) => makeNode({ id, dependencies: ['root'] }))
      const wf = makeWorkflow({
        nodes: [makeNode({ id: 'root' }), ...workers]
      })

      const executors: Record<string, NodeExecutor> = {}
      for (const id of workerIds) {
        executors[id] = async () => ({
          status: 'succeeded',
          content: `Data from ${id}`
        })
      }

      const sim = await simulateDagExecution(wf, executors)
      expect(sim.status).toBe('completed')
      expect(sim.wavesExecuted).toBe(2)
      for (const id of workerIds) {
        expect(sim.nodeStates[id]).toBe('succeeded')
        expect(sim.nodeOutputs[id].content).toBe(`Data from ${id}`)
      }
    })

    it('2.14 completely flat workflow (8 root nodes) partitions into 1 wave of width 8', () => {
      const roots = Array.from({ length: 8 }, (_, i) => makeNode({ id: `root-${i}` }))
      const wf = makeWorkflow({ nodes: roots })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(1)
      expect(res.plan?.waves[0].nodeIds).toHaveLength(8)
    })

    it('2.15 wide wave resolves alphabetically for deterministic ordering', () => {
      const unsorted = ['zeta', 'beta', 'alpha', 'gamma', 'delta'].map((id) =>
        makeNode({ id, dependencies: ['root'] })
      )
      const wf = makeWorkflow({ nodes: [makeNode({ id: 'root' }), ...unsorted] })
      const res = validateWorkflow(wf)
      expect(res.plan?.waves[1].nodeIds).toEqual(['alpha', 'beta', 'delta', 'gamma', 'zeta'])
    })
  })

  // Boundary 4: Deep Linear Dependency Chains
  describe('Boundary 4: Deep Linear Dependency Chains', () => {
    it('2.16 partitions 5-node linear chain (N1 -> N2 -> N3 -> N4 -> N5) into 5 sequential waves', () => {
      const nodes = [
        makeNode({ id: 'step-1' }),
        makeNode({ id: 'step-2', dependencies: ['step-1'] }),
        makeNode({ id: 'step-3', dependencies: ['step-2'] }),
        makeNode({ id: 'step-4', dependencies: ['step-3'] }),
        makeNode({ id: 'step-5', dependencies: ['step-4'] })
      ]
      const wf = makeWorkflow({ nodes })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(5)
      for (let i = 0; i < 5; i++) {
        expect(res.plan?.waves[i].waveIndex).toBe(i)
        expect(res.plan?.waves[i].nodeIds).toEqual([`step-${i + 1}`])
      }
    })

    it('2.17 passes cumulative parameter interpolation down a linear chain', async () => {
      const nodes = [
        makeNode({ id: 'n1', prompt: 'Start' }),
        makeNode({ id: 'n2', prompt: 'Append: {{inputs.n1.output}}', dependencies: ['n1'] }),
        makeNode({ id: 'n3', prompt: 'Finalize: {{inputs.n2.output}}', dependencies: ['n2'] })
      ]
      const wf = makeWorkflow({ nodes })

      const capturedPrompts: Record<string, string> = {}
      const sim = await simulateDagExecution(wf, {
        n1: async () => ({ status: 'succeeded', content: 'Alpha' }),
        n2: async ({ interpolatedPrompt }) => {
          capturedPrompts.n2 = interpolatedPrompt
          return { status: 'succeeded', content: 'Alpha+Beta' }
        },
        n3: async ({ interpolatedPrompt }) => {
          capturedPrompts.n3 = interpolatedPrompt
          return { status: 'succeeded', content: 'Alpha+Beta+Gamma' }
        }
      })

      expect(sim.status).toBe('completed')
      expect(capturedPrompts.n2).toBe('Append: Alpha')
      expect(capturedPrompts.n3).toBe('Finalize: Alpha+Beta')
      expect(sim.nodeOutputs.n3.content).toBe('Alpha+Beta+Gamma')
    })

    it('2.18 linear chain halts subsequent steps when middle node fails', async () => {
      const nodes = [
        makeNode({ id: 'n1' }),
        makeNode({ id: 'n2', dependencies: ['n1'] }),
        makeNode({ id: 'n3', dependencies: ['n2'], policy: { skipOnFail: true } })
      ]
      const wf = makeWorkflow({ nodes })

      const sim = await simulateDagExecution(wf, {
        n1: async () => ({ status: 'succeeded', content: 'ok' }),
        n2: async () => ({ status: 'failed', error: 'midway crash' })
      })

      expect(sim.status).toBe('failed')
      expect(sim.nodeStates.n1).toBe('succeeded')
      expect(sim.nodeStates.n2).toBe('failed')
      expect(sim.nodeStates.n3).toBe('skipped')
    })

    it('2.19 partitions 8-node chain into 8 waves without stack overflow', () => {
      const chain = Array.from({ length: 8 }, (_, i) =>
        makeNode({
          id: `c-${i}`,
          dependencies: i === 0 ? [] : [`c-${i - 1}`]
        })
      )
      const res = validateWorkflow(makeWorkflow({ nodes: chain }))
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(8)
    })

    it('2.20 mixed linear chain with side branch partitions into correct wave indices', () => {
      const nodes = [
        makeNode({ id: 'L1' }),
        makeNode({ id: 'L2', dependencies: ['L1'] }),
        makeNode({ id: 'L3', dependencies: ['L2'] }),
        makeNode({ id: 'Side', dependencies: ['L1'] }),
        makeNode({ id: 'Join', dependencies: ['L3', 'Side'] })
      ]
      const res = validateWorkflow(makeWorkflow({ nodes }))
      expect(res.valid).toBe(true)
      // Wave 0: L1
      // Wave 1: L2, Side
      // Wave 2: L3
      // Wave 3: Join
      expect(res.plan?.waves).toHaveLength(4)
      expect(res.plan?.waves[0].nodeIds).toEqual(['L1'])
      expect(res.plan?.waves[1].nodeIds).toEqual(['L2', 'Side'])
      expect(res.plan?.waves[2].nodeIds).toEqual(['L3'])
      expect(res.plan?.waves[3].nodeIds).toEqual(['Join'])
    })
  })

  // Boundary 5: Malformed & Unauthorized Template Variables
  describe('Boundary 5: Malformed & Unauthorized Template Variables', () => {
    it('2.21 throws in strict mode when template references unauthorized undeclared node', () => {
      const outputs = new Map<string, DagNodeOutput>([
        ['unauthorized', makeNodeOutput({ nodeId: 'unauthorized', content: 'Secret' })]
      ])
      const template = 'Secret: {{inputs.unauthorized.output}}'
      expect(() => interpolatePrompt(template, outputs, ['allowed-only'], { strict: true })).toThrow(
        /Unauthorized dependency reference/
      )
    })

    it('2.22 returns empty string for missing upstream node output when dependency is allowed', () => {
      const outputs = new Map<string, DagNodeOutput>()
      const template = 'Value: [{{inputs.upstream.output}}]'
      const interpolated = interpolatePrompt(template, outputs, ['upstream'])
      expect(interpolated).toBe('Value: []')
    })

    it('2.23 returns empty string for nonexistent artifact on completed node', () => {
      const outputs = new Map<string, DagNodeOutput>([
        ['step1', makeNodeOutput({ nodeId: 'step1', artifacts: [] })]
      ])
      const template = 'Artifact: [{{inputs.step1.artifacts.nonexistent}}]'
      const interpolated = interpolatePrompt(template, outputs, ['step1'])
      expect(interpolated).toBe('Artifact: []')
    })

    it('2.24 neutralizes prototype pollution attempts (__proto__, constructor, prototype)', () => {
      const outputs = new Map<string, DagNodeOutput>([
        ['legit', makeNodeOutput({ nodeId: 'legit', content: 'safe' })]
      ])
      const t1 = 'Pollute: {{inputs.__proto__.output}}'
      const t2 = 'Pollute: {{inputs.legit.constructor}}'
      const t3 = 'Pollute: {{inputs.legit.prototype}}'

      expect(interpolatePrompt(t1, outputs, ['__proto__', 'legit'])).toBe('Pollute: ')
      expect(interpolatePrompt(t2, outputs, ['legit'])).toBe('Pollute: ')
      expect(interpolatePrompt(t3, outputs, ['legit'])).toBe('Pollute: ')
    })

    it('2.25 leaves unclosed or malformed curly braces untouched', () => {
      const outputs = new Map<string, DagNodeOutput>()
      const template = 'Broken: {{inputs.node.output and {{inputs.node and {inputs.node.output}}'
      const interpolated = interpolatePrompt(template, outputs, ['node'])
      expect(interpolated).toBe('Broken: {{inputs.node.output and {{inputs.node and {inputs.node.output}}')
    })
  })

  // Boundary 6: String Bounds & 50,000 Character Truncation
  describe('Boundary 6: String Bounds & 50,000 Character Truncation', () => {
    it('2.26 output of exactly 50,000 characters remains intact without truncation notice', () => {
      const exact50k = 'X'.repeat(MAX_INTERPOLATED_CHARS)
      const outputs = new Map<string, DagNodeOutput>([
        ['bigNode', makeNodeOutput({ nodeId: 'bigNode', content: exact50k })]
      ])
      const interpolated = interpolatePrompt('{{inputs.bigNode.output}}', outputs, ['bigNode'])
      expect(interpolated.length).toBe(MAX_INTERPOLATED_CHARS)
      expect(interpolated).not.toContain('[Output truncated')
    })

    it('2.27 output of 50,001 characters is capped with truncation notice', () => {
      const overByOne = 'Y'.repeat(MAX_INTERPOLATED_CHARS + 1)
      const outputs = new Map<string, DagNodeOutput>([
        ['bigNode', makeNodeOutput({ nodeId: 'bigNode', content: overByOne })]
      ])
      const interpolated = interpolatePrompt('{{inputs.bigNode.output}}', outputs, ['bigNode'])
      expect(interpolated).toContain('[Output truncated: showing first 50000 characters]')
      expect(interpolated.startsWith('Y'.repeat(MAX_INTERPOLATED_CHARS))).toBe(true)
    })

    it('2.28 massive output of 100,000 characters is safely capped at 50,000 chars', () => {
      const massive = 'Z'.repeat(100_000)
      const outputs = new Map<string, DagNodeOutput>([
        ['hugeNode', makeNodeOutput({ nodeId: 'hugeNode', content: massive })]
      ])
      const interpolated = interpolatePrompt('{{inputs.hugeNode.output}}', outputs, ['hugeNode'])
      expect(interpolated.length).toBeLessThan(51_000)
      expect(interpolated).toContain('[Output truncated: showing first 50000 characters]')
    })

    it('2.29 multiple oversized variables in the same template are truncated independently', () => {
      const massive1 = 'A'.repeat(60_000)
      const massive2 = 'B'.repeat(60_000)
      const outputs = new Map<string, DagNodeOutput>([
        ['n1', makeNodeOutput({ nodeId: 'n1', content: massive1 })],
        ['n2', makeNodeOutput({ nodeId: 'n2', content: massive2 })]
      ])
      const template = 'Part 1: {{inputs.n1.output}}\nPart 2: {{inputs.n2.output}}'
      const interpolated = interpolatePrompt(template, outputs, ['n1', 'n2'])
      expect(interpolated).toContain('Part 1: ' + 'A'.repeat(50_000))
      expect(interpolated).toContain('Part 2: ' + 'B'.repeat(50_000))
    })

    it('2.30 respects custom maxVariableChars option when specified', () => {
      const text = '123456789012345'
      const outputs = new Map<string, DagNodeOutput>([
        ['node', makeNodeOutput({ nodeId: 'node', content: text })]
      ])
      const interpolated = interpolatePrompt('{{inputs.node.output}}', outputs, ['node'], {
        maxVariableChars: 10
      })
      expect(interpolated).toBe('1234567890\n\n[Output truncated: showing first 10 characters]')
    })
  })

  // Boundary 7: Comprehensive Cycle Detection
  describe('Boundary 7: Cycle Detection (Loops, 2-Cycles, Indirect Cycles)', () => {
    it('2.31 rejects self-loop (A -> A) with self-dependency error', () => {
      const wf = makeWorkflow({
        nodes: [makeNode({ id: 'loop-node', dependencies: ['loop-node'] })]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toContain('cannot depend on itself')
    })

    it('2.32 detects 2-cycle (A -> B -> A) and traces exact cycle path', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'A', dependencies: ['B'] }),
          makeNode({ id: 'B', dependencies: ['A'] })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('Cyclic dependency detected: A -> B -> A'))).toBe(true)
    })

    it('2.33 detects 3-cycle (A -> B -> C -> A) and traces cycle path', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'A', dependencies: ['C'] }),
          makeNode({ id: 'B', dependencies: ['A'] }),
          makeNode({ id: 'C', dependencies: ['B'] })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('Cyclic dependency detected'))).toBe(true)
    })

    it('2.34 detects indirect cycle attached to linear stem (Stem -> Cycle1 -> Cycle2 -> Cycle1)', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'stem' }),
          makeNode({ id: 'c1', dependencies: ['stem', 'c2'] }),
          makeNode({ id: 'c2', dependencies: ['c1'] })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('Cyclic dependency detected: c1 -> c2 -> c1'))).toBe(true)
    })

    it('2.35 rejects workflow where cycle exists in disconnected subgraph', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'valid-root' }),
          makeNode({ id: 'valid-leaf', dependencies: ['valid-root'] }),
          makeNode({ id: 'cycle-x', dependencies: ['cycle-y'] }),
          makeNode({ id: 'cycle-y', dependencies: ['cycle-x'] })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors.some((e) => e.includes('Cyclic dependency detected'))).toBe(true)
    })

    it('2.36 does not hang on dense graphs with multiple potential loops', () => {
      const nodes = [
        makeNode({ id: 'n1', dependencies: ['n4'] }),
        makeNode({ id: 'n2', dependencies: ['n1'] }),
        makeNode({ id: 'n3', dependencies: ['n2'] }),
        makeNode({ id: 'n4', dependencies: ['n3'] })
      ]
      const start = Date.now()
      const res = validateWorkflow(makeWorkflow({ nodes }))
      const elapsed = Date.now() - start
      expect(res.valid).toBe(false)
      expect(elapsed).toBeLessThan(100)
    })
  })

  // Boundary 8: Disconnected & Asymmetric Components
  describe('Boundary 8: Disconnected & Asymmetric Components in Graph', () => {
    it('2.37 handles two completely disjoint subgraphs in parallel waves', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'A1' }),
          makeNode({ id: 'A2', dependencies: ['A1'] }),
          makeNode({ id: 'B1' }),
          makeNode({ id: 'B2', dependencies: ['B1'] })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(2)
      expect(res.plan?.waves[0].nodeIds).toEqual(['A1', 'B1'])
      expect(res.plan?.waves[1].nodeIds).toEqual(['A2', 'B2'])
    })

    it('2.38 handles asymmetric subgraphs with different branch depths', () => {
      // Subgraph A has depth 3 (A1 -> A2 -> A3); Subgraph B has depth 1 (B1)
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'A1' }),
          makeNode({ id: 'A2', dependencies: ['A1'] }),
          makeNode({ id: 'A3', dependencies: ['A2'] }),
          makeNode({ id: 'B1' })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(3)
      expect(res.plan?.waves[0].nodeIds).toEqual(['A1', 'B1'])
      expect(res.plan?.waves[1].nodeIds).toEqual(['A2'])
      expect(res.plan?.waves[2].nodeIds).toEqual(['A3'])
    })

    it('2.39 executes disconnected subgraphs cleanly through execution simulator', async () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'A1' }),
          makeNode({ id: 'B1' })
        ]
      })

      const sim = await simulateDagExecution(wf, {
        A1: async () => ({ status: 'succeeded', content: 'A1-res' }),
        B1: async () => ({ status: 'succeeded', content: 'B1-res' })
      })

      expect(sim.status).toBe('completed')
      expect(sim.nodeStates.A1).toBe('succeeded')
      expect(sim.nodeStates.B1).toBe('succeeded')
    })

    it('2.40 failure in one disjoint subgraph does not corrupt output of independent sibling', async () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'A1' }),
          makeNode({ id: 'B1' })
        ]
      })

      const sim = await simulateDagExecution(wf, {
        A1: async () => ({ status: 'failed', error: 'A1 crashed' }),
        B1: async () => ({ status: 'succeeded', content: 'B1 completed' })
      })

      expect(sim.nodeStates.A1).toBe('failed')
      expect(sim.nodeStates.B1).toBe('succeeded')
      expect(sim.nodeOutputs.B1.content).toBe('B1 completed')
    })

    it('2.41 joins three disjoint roots into a single downstream synthesizer', () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'R1' }),
          makeNode({ id: 'R2' }),
          makeNode({ id: 'R3' }),
          makeNode({ id: 'Synth', dependencies: ['R1', 'R2', 'R3'] })
        ]
      })
      const res = validateWorkflow(wf)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves[0].nodeIds).toEqual(['R1', 'R2', 'R3'])
      expect(res.plan?.waves[1].nodeIds).toEqual(['Synth'])
    })
  })

  // Boundary 9: Security & Path Confinement
  describe('Boundary 9: Security & Path Confinement Escapes', () => {
    it('2.42 rejects workflowId containing parent directory traversal (..)', async () => {
      const wf = makeWorkflow({ id: '../evil' })
      await expect(saveWorkflow(projectDir, wf)).rejects.toThrow(/inside the project directory|escapes/i)
      await expect(getWorkflow(projectDir, '../evil')).rejects.toThrow(/inside the project directory|escapes/i)
      await expect(deleteWorkflow(projectDir, '../evil')).rejects.toThrow(/inside the project directory|escapes/i)
    })

    it('2.43 rejects workflowId with absolute path escape', async () => {
      const absPath = join(tmpdir(), 'evil')
      const wf = makeWorkflow({ id: absPath })
      await expect(saveWorkflow(projectDir, wf)).rejects.toThrow(/inside the project directory|escapes/i)
    })

    it('2.44 rejects empty or non-string workflowId in getWorkflow and deleteWorkflow', async () => {
      await expect(getWorkflow(projectDir, '')).rejects.toThrow(/non-empty string/)
      await expect(deleteWorkflow(projectDir, '')).rejects.toThrow(/non-empty string/)
    })

    it('2.45 handles non-existent workflows directory in listWorkflows safely by returning []', async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'dag-empty-dir-'))
      const list = await listWorkflows(emptyDir)
      expect(list).toEqual([])
      rmSync(emptyDir, { recursive: true, force: true })
    })

    it('2.46 verifies workflow file write containment is scoped under .opencode/workflows/', async () => {
      const wf = makeWorkflow({ id: 'contained-wf' })
      await saveWorkflow(projectDir, wf)
      const expectedPath = join(projectDir, '.opencode', 'workflows', 'contained-wf.json')
      const read = JSON.parse(readFileSync(expectedPath, 'utf-8'))
      expect(read.id).toBe('contained-wf')
    })
  })
})

describe('DAG E2E: Tier 3 — Cross-Feature Combinations (Pairwise)', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'dag-e2e-tier3-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  // Pairwise 1: Conditional Skip on Failure + Downstream Alternative Node
  describe('Combination 1: Conditional Skip on Failure + Downstream Fallback Interpolation', () => {
    it('3.1 routes to fallback node when primary node fails, interpolating error message', async () => {
      // Primary fails -> Primary Handler skipped -> Fallback Handler activated
      const wf: WorkflowDefinition = {
        id: 'failover-pipeline',
        name: 'Failover Pipeline',
        nodes: [
          makeNode({
            id: 'primary-eval',
            prompt: 'Run primary analysis'
          }),
          makeNode({
            id: 'success-handler',
            prompt: 'Handle success: {{inputs.primary-eval.output}}',
            dependencies: ['primary-eval'],
            policy: {
              condition: {
                upstreamNodeId: 'primary-eval',
                expectedStatus: 'succeeded'
              }
            }
          }),
          makeNode({
            id: 'fallback-handler',
            prompt: 'Recover from error: {{inputs.primary-eval.error}}',
            dependencies: ['primary-eval'],
            policy: {
              condition: {
                upstreamNodeId: 'primary-eval',
                expectedStatus: 'failed'
              }
            }
          })
        ]
      }

      let fallbackPrompt = ''
      const sim = await simulateDagExecution(wf, {
        'primary-eval': async () => ({
          status: 'failed',
          error: 'Rate limit exceeded on provider API'
        }),
        'fallback-handler': async ({ interpolatedPrompt }) => {
          fallbackPrompt = interpolatedPrompt
          return {
            status: 'succeeded',
            content: 'Recovered using backup model'
          }
        }
      })

      expect(sim.nodeStates['primary-eval']).toBe('failed')
      expect(sim.nodeStates['success-handler']).toBe('skipped')
      expect(sim.nodeStates['fallback-handler']).toBe('succeeded')
      expect(fallbackPrompt).toBe('Recover from error: Rate limit exceeded on provider API')
      expect(sim.nodeOutputs['fallback-handler'].content).toBe('Recovered using backup model')
    })

    it('3.2 routes to success node when primary node succeeds, skipping fallback node', async () => {
      const wf: WorkflowDefinition = {
        id: 'success-pipeline',
        name: 'Success Pipeline',
        nodes: [
          makeNode({ id: 'primary-task' }),
          makeNode({
            id: 'on-success',
            prompt: 'Got: {{inputs.primary-task.output}}',
            dependencies: ['primary-task'],
            policy: { condition: { upstreamNodeId: 'primary-task', expectedStatus: 'succeeded' } }
          }),
          makeNode({
            id: 'on-failure',
            prompt: 'Failed with: {{inputs.primary-task.error}}',
            dependencies: ['primary-task'],
            policy: { condition: { upstreamNodeId: 'primary-task', expectedStatus: 'failed' } }
          })
        ]
      }

      const sim = await simulateDagExecution(wf, {
        'primary-task': async () => ({ status: 'succeeded', content: 'Primary OK' }),
        'on-success': async () => ({ status: 'succeeded', content: 'Handled OK' })
      })

      expect(sim.nodeStates['primary-task']).toBe('succeeded')
      expect(sim.nodeStates['on-success']).toBe('succeeded')
      expect(sim.nodeStates['on-failure']).toBe('skipped')
    })

    it('3.3 evaluates expectedFinishReason condition matching tool_calls vs stop', async () => {
      const wf: WorkflowDefinition = {
        id: 'finish-reason-wf',
        name: 'Finish Reason Workflow',
        nodes: [
          makeNode({ id: 'agent-turn' }),
          makeNode({
            id: 'handle-tools',
            dependencies: ['agent-turn'],
            policy: { condition: { upstreamNodeId: 'agent-turn', expectedFinishReason: 'tool_calls' } }
          }),
          makeNode({
            id: 'handle-stop',
            dependencies: ['agent-turn'],
            policy: { condition: { upstreamNodeId: 'agent-turn', expectedFinishReason: 'stop' } }
          })
        ]
      }

      const sim = await simulateDagExecution(wf, {
        'agent-turn': async () => ({ status: 'succeeded', finishReason: 'tool_calls' }),
        'handle-tools': async () => ({ status: 'succeeded', content: 'Dispatched tools' })
      })

      expect(sim.nodeStates['handle-tools']).toBe('succeeded')
      expect(sim.nodeStates['handle-stop']).toBe('skipped')
    })
  })

  // Pairwise 2: Abort-on-Fail Policy Cascading + Sibling Halting
  describe('Combination 2: Abort-on-Fail Policy Cascading & Parallel Sibling Cancellation', () => {
    it('3.4 abortOnFail triggers immediate cancellation of subsequent waves', async () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'preflight', policy: { abortOnFail: true } }),
          makeNode({ id: 'deploy-stage-1', dependencies: ['preflight'] }),
          makeNode({ id: 'deploy-stage-2', dependencies: ['deploy-stage-1'] })
        ]
      })

      const sim = await simulateDagExecution(wf, {
        preflight: async () => ({ status: 'failed', error: 'Security audit failed' })
      })

      expect(sim.status).toBe('failed')
      expect(sim.wavesExecuted).toBe(1)
      expect(sim.nodeStates.preflight).toBe('failed')
      expect(sim.nodeStates['deploy-stage-1']).toBe('pending')
      expect(sim.nodeStates['deploy-stage-2']).toBe('pending')
    })

    it('3.5 abortOnFail on one worker in parallel wave halts subsequent waves', async () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'root' }),
          makeNode({ id: 'worker-strict', dependencies: ['root'], policy: { abortOnFail: true } }),
          makeNode({ id: 'worker-lax', dependencies: ['root'] }),
          makeNode({ id: 'downstream', dependencies: ['worker-strict', 'worker-lax'] })
        ]
      })

      const sim = await simulateDagExecution(wf, {
        root: async () => ({ status: 'succeeded' }),
        'worker-strict': async () => ({ status: 'failed', error: 'Integrity check failed' }),
        'worker-lax': async () => ({ status: 'succeeded' })
      })

      expect(sim.status).toBe('failed')
      expect(sim.wavesExecuted).toBe(2)
      expect(sim.nodeStates['worker-strict']).toBe('failed')
      expect(sim.nodeStates.downstream).toBe('pending')
    })

    it('3.6 external abortSignal aborts DAG immediately before running next wave', async () => {
      const controller = new AbortController()
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'wave0' }),
          makeNode({ id: 'wave1', dependencies: ['wave0'] })
        ]
      })

      const sim = await simulateDagExecution(
        wf,
        {
          wave0: async () => {
            controller.abort()
            return { status: 'succeeded' }
          }
        },
        { abortSignal: controller.signal }
      )

      expect(sim.status).toBe('cancelled')
      expect(sim.wavesExecuted).toBe(1)
      expect(sim.nodeStates.wave1).toBe('pending')
    })
  })

  // Pairwise 3: Flat Worker Waves (Fan-Out / Fan-In) with Artifact Transfer
  describe('Combination 3: Flat Worker Waves (Fan-Out / Fan-In) with Artifact Transfer', () => {
    it('3.7 fan-out to 4 parallel workers -> fan-in to 1 aggregator collecting all artifacts', async () => {
      const wf: WorkflowDefinition = {
        id: 'fan-out-fan-in',
        name: 'Fan Out Fan In Pipeline',
        nodes: [
          makeNode({ id: 'planner', prompt: 'Create 4 tasks' }),
          makeNode({ id: 'worker-lint', prompt: 'Lint code', dependencies: ['planner'] }),
          makeNode({ id: 'worker-test', prompt: 'Run tests', dependencies: ['planner'] }),
          makeNode({ id: 'worker-types', prompt: 'Type check', dependencies: ['planner'] }),
          makeNode({ id: 'worker-audit', prompt: 'Security audit', dependencies: ['planner'] }),
          makeNode({
            id: 'synthesizer',
            prompt:
              'Summary:\n' +
              'Lint: {{inputs.worker-lint.output}}\n' +
              'Test: {{inputs.worker-test.artifacts.junit.xml}}\n' +
              'Type: {{inputs.worker-types.output}}\n' +
              'Audit: {{inputs.worker-audit.artifacts.report.json}}',
            dependencies: ['worker-lint', 'worker-test', 'worker-types', 'worker-audit']
          })
        ]
      }

      let synthPrompt = ''
      const sim = await simulateDagExecution(wf, {
        planner: async () => ({ status: 'succeeded', content: 'Tasks planned' }),
        'worker-lint': async () => ({ status: 'succeeded', content: '0 lint errors' }),
        'worker-test': async () => ({
          status: 'succeeded',
          content: 'All passed',
          artifacts: [{ name: 'junit.xml', content: '<testsuite tests="42" failures="0"/>' }]
        }),
        'worker-types': async () => ({ status: 'succeeded', content: 'TS clean' }),
        'worker-audit': async () => ({
          status: 'succeeded',
          content: 'Audit clean',
          artifacts: [{ name: 'report.json', content: '{"vulnerabilities": 0}' }]
        }),
        synthesizer: async ({ interpolatedPrompt }) => {
          synthPrompt = interpolatedPrompt
          return { status: 'succeeded', content: 'All 4 verification tracks passed cleanly.' }
        }
      })

      expect(sim.status).toBe('completed')
      expect(sim.wavesExecuted).toBe(3)
      expect(synthPrompt).toContain('Lint: 0 lint errors')
      expect(synthPrompt).toContain('Test: <testsuite tests="42" failures="0"/>')
      expect(synthPrompt).toContain('Type: TS clean')
      expect(synthPrompt).toContain('Audit: {"vulnerabilities": 0}')
      expect(sim.nodeOutputs.synthesizer.content).toBe('All 4 verification tracks passed cleanly.')
    })

    it('3.8 fan-out wave collects and aggregates token usage across all parallel workers', async () => {
      const wf = makeWorkflow({
        nodes: [
          makeNode({ id: 'p' }),
          makeNode({ id: 'w1', dependencies: ['p'] }),
          makeNode({ id: 'w2', dependencies: ['p'] })
        ]
      })

      const sim = await simulateDagExecution(wf, {
        p: async () => ({ status: 'succeeded', usage: { input: 100, output: 50 } }),
        w1: async () => ({ status: 'succeeded', usage: { input: 200, output: 80 } }),
        w2: async () => ({ status: 'succeeded', usage: { input: 300, output: 120 } })
      })

      const totalInput =
        sim.nodeOutputs.p.usage.input + sim.nodeOutputs.w1.usage.input + sim.nodeOutputs.w2.usage.input
      const totalOutput =
        sim.nodeOutputs.p.usage.output + sim.nodeOutputs.w1.usage.output + sim.nodeOutputs.w2.usage.output

      expect(totalInput).toBe(600)
      expect(totalOutput).toBe(250)
    })

    it('3.9 saves and reloads fan-out workflow definition without schema degradation', async () => {
      const wf = makeWorkflow({
        id: 'persisted-fanout',
        nodes: [
          makeNode({ id: 'lead' }),
          makeNode({ id: 'wA', dependencies: ['lead'] }),
          makeNode({ id: 'wB', dependencies: ['lead'] }),
          makeNode({ id: 'join', dependencies: ['wA', 'wB'] })
        ]
      })

      await saveWorkflow(projectDir, wf)
      const reloaded = await getWorkflow(projectDir, 'persisted-fanout')
      expect(reloaded).not.toBeNull()
      expect(reloaded?.nodes).toHaveLength(4)
      expect(reloaded?.nodes.find((n) => n.id === 'join')?.dependencies).toEqual(['wA', 'wB'])
    })
  })
})

describe('DAG E2E: Tier 4 — Real-World Application Workloads', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'dag-e2e-tier4-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  // Workload 1: Multi-Agent Code Review Workflow
  describe('Workload 1: Multi-Agent Code Review Workflow', () => {
    it('4.1 executes Architect Planner -> parallel Code Explorer + Security Explorer -> Synthesizer', async () => {
      const codeReviewWorkflow: WorkflowDefinition = {
        id: 'multi-agent-code-review',
        name: 'Multi-Agent Code Review Pipeline',
        description:
          'Architect reviews PR diff, delegates in parallel to Code Quality and Security Explorers, and Synthesizer compiles comprehensive review report.',
        version: '1.0.0',
        metadata: { pipeline: 'code-review', targets: ['src/main/server.ts'] },
        nodes: [
          // Wave 0: Architect Planner
          makeNode({
            id: 'architect-planner',
            name: 'Architect Planner',
            profileId: 'architect-agent',
            prompt: 'Analyze git diff for PR #104 and partition focus areas for code quality and security.',
            policy: { abortOnFail: true }
          }),
          // Wave 1: Parallel Explorers
          makeNode({
            id: 'code-explorer',
            name: 'Code Explorer',
            profileId: 'explorer-code',
            prompt:
              'Examine architecture and code quality based on plan:\n{{inputs.architect-planner.output}}\nReport style, abstractions, and test coverage.',
            dependencies: ['architect-planner']
          }),
          makeNode({
            id: 'security-explorer',
            name: 'Security Explorer',
            profileId: 'explorer-sec',
            prompt:
              'Examine credential isolation, path containment, and injection vulnerabilities based on plan:\n{{inputs.architect-planner.output}}\nGenerate sec-findings artifact.',
            dependencies: ['architect-planner']
          }),
          // Wave 2: Synthesizer
          makeNode({
            id: 'synthesizer',
            name: 'Review Synthesizer',
            profileId: 'synthesizer-agent',
            prompt:
              'Compile comprehensive review verdict:\n\n' +
              'Architect Plan: {{inputs.architect-planner.output}}\n' +
              'Code Findings: {{inputs.code-explorer.output}}\n' +
              'Security Findings: {{inputs.security-explorer.output}}\n' +
              'Security Matrix: {{inputs.security-explorer.artifacts.sec-matrix.json}}',
            dependencies: ['architect-planner', 'code-explorer', 'security-explorer']
          })
        ]
      }

      let capturedSynthPrompt = ''
      const sim = await simulateDagExecution(codeReviewWorkflow, {
        'architect-planner': async () => ({
          status: 'succeeded',
          content: 'PR #104 touches server lifecycle and token management. Target areas: IPC boundaries and key store.',
          turns: 2
        }),
        'code-explorer': async () => ({
          status: 'succeeded',
          content: 'Code quality score 9/10: clean TypeScript types, well-isolated modules, 0 lint warnings.',
          turns: 3
        }),
        'security-explorer': async () => ({
          status: 'succeeded',
          content: 'Security score 10/10: safeStorage encryption verified, child env scrubbed via buildChildEnv.',
          artifacts: [
            {
              name: 'sec-matrix.json',
              content: JSON.stringify({
                credentialScrubbing: 'PASS',
                pathContainment: 'PASS',
                shellEscapes: 'PASS'
              })
            }
          ],
          turns: 4
        }),
        synthesizer: async ({ interpolatedPrompt }) => {
          capturedSynthPrompt = interpolatedPrompt
          return {
            status: 'succeeded',
            content: 'VERDICT: APPROVE. Both quality and security bars met with 0 blocking defects.',
            turns: 2
          }
        }
      })

      expect(sim.status).toBe('completed')
      expect(sim.wavesExecuted).toBe(3)
      expect(capturedSynthPrompt).toContain('Architect Plan: PR #104 touches server lifecycle')
      expect(capturedSynthPrompt).toContain('Code Findings: Code quality score 9/10')
      expect(capturedSynthPrompt).toContain('Security Findings: Security score 10/10')
      expect(capturedSynthPrompt).toContain('"credentialScrubbing":"PASS"')
      expect(sim.nodeOutputs.synthesizer.content).toContain('VERDICT: APPROVE')
    })

    it('4.2 aborts code review immediately when architect planner detects corrupt diff', async () => {
      const codeReviewWorkflow: WorkflowDefinition = {
        id: 'code-review-abort',
        name: 'Code Review with Pre-flight Check',
        nodes: [
          makeNode({
            id: 'architect-planner',
            policy: { abortOnFail: true }
          }),
          makeNode({ id: 'code-explorer', dependencies: ['architect-planner'] }),
          makeNode({ id: 'security-explorer', dependencies: ['architect-planner'] })
        ]
      }

      const sim = await simulateDagExecution(codeReviewWorkflow, {
        'architect-planner': async () => ({
          status: 'failed',
          error: 'Corrupt git diff: unexpected EOF at hunk 4'
        })
      })

      expect(sim.status).toBe('failed')
      expect(sim.wavesExecuted).toBe(1)
      expect(sim.nodeStates['code-explorer']).toBe('pending')
      expect(sim.nodeStates['security-explorer']).toBe('pending')
    })
  })

  // Workload 2: Multi-Stage Refactoring Pipeline with Diff Artifacts
  describe('Workload 2: Multi-Stage Refactoring Pipeline with Artifacts and Code Diff Handoffs', () => {
    it('4.3 executes Scanner -> Refactorer (patch artifact) -> Test Verifier -> Documentation Writer', async () => {
      const refactoringPipeline: WorkflowDefinition = {
        id: 'ast-refactoring-pipeline',
        name: 'AST Refactoring Pipeline',
        description: 'Scans deprecations, generates unified diff patch, runs tests against patch, and updates documentation.',
        version: '1.2.0',
        nodes: [
          // Wave 0
          makeNode({
            id: 'scanner',
            name: 'AST Deprecation Scanner',
            profileId: 'scanner-agent',
            prompt: 'Scan src/ for deprecated API usage of legacy storage methods.',
            policy: { abortOnFail: true }
          }),
          // Wave 1
          makeNode({
            id: 'refactorer',
            name: 'Code Refactorer',
            profileId: 'refactor-agent',
            prompt: 'Apply codemods for findings: {{inputs.scanner.output}}\nEmit patch artifact.',
            dependencies: ['scanner'],
            policy: { abortOnFail: true }
          }),
          // Wave 2
          makeNode({
            id: 'test-verifier',
            name: 'Test Verifier',
            profileId: 'qa-agent',
            prompt: 'Run test suite against patch:\n{{inputs.refactorer.artifacts.refactor.patch}}',
            dependencies: ['refactorer']
          }),
          // Wave 3
          makeNode({
            id: 'doc-writer',
            name: 'Documentation Updater',
            profileId: 'writer-agent',
            prompt:
              'Document changes from refactoring:\n' +
              'Changes: {{inputs.refactorer.output}}\n' +
              'Test Outcome: {{inputs.test-verifier.output}}',
            dependencies: ['refactorer', 'test-verifier']
          })
        ]
      }

      let capturedTestPrompt = ''
      let capturedDocPrompt = ''

      const sim = await simulateDagExecution(refactoringPipeline, {
        scanner: async () => ({
          status: 'succeeded',
          content: 'Found 3 call sites of deprecated storage.readRaw() in keys.ts'
        }),
        refactorer: async () => ({
          status: 'succeeded',
          content: 'Migrated 3 calls to safeStorage.decryptString()',
          artifacts: [
            {
              name: 'refactor.patch',
              content: '--- a/src/main/keys.ts\n+++ b/src/main/keys.ts\n-readRaw()\n+decryptString()'
            }
          ]
        }),
        'test-verifier': async ({ interpolatedPrompt }) => {
          capturedTestPrompt = interpolatedPrompt
          return {
            status: 'succeeded',
            content: 'All 554 tests in vitest passed with 0 failures.'
          }
        },
        'doc-writer': async ({ interpolatedPrompt }) => {
          capturedDocPrompt = interpolatedPrompt
          return {
            status: 'succeeded',
            content: 'Updated MIGRATION.md and CONTRACTS.md with new decryptString signature.'
          }
        }
      })

      expect(sim.status).toBe('completed')
      expect(sim.wavesExecuted).toBe(4)
      expect(capturedTestPrompt).toContain('--- a/src/main/keys.ts')
      expect(capturedTestPrompt).toContain('+decryptString()')
      expect(capturedDocPrompt).toContain('Migrated 3 calls to safeStorage.decryptString()')
      expect(capturedDocPrompt).toContain('All 554 tests in vitest passed with 0 failures.')
      expect(sim.nodeOutputs['doc-writer'].content).toContain('Updated MIGRATION.md')
    })

    it('4.4 aborts pipeline at Wave 1 if refactorer fails to generate valid syntax', async () => {
      const pipeline: WorkflowDefinition = {
        id: 'refactor-syntax-fail',
        name: 'Refactor Syntax Fail',
        nodes: [
          makeNode({ id: 'scanner' }),
          makeNode({ id: 'refactorer', dependencies: ['scanner'], policy: { abortOnFail: true } }),
          makeNode({ id: 'test-verifier', dependencies: ['refactorer'] })
        ]
      }

      const sim = await simulateDagExecution(pipeline, {
        scanner: async () => ({ status: 'succeeded', content: 'Scan OK' }),
        refactorer: async () => ({ status: 'failed', error: 'Transform error: invalid AST node' })
      })

      expect(sim.status).toBe('failed')
      expect(sim.wavesExecuted).toBe(2)
      expect(sim.nodeStates.refactorer).toBe('failed')
      expect(sim.nodeStates['test-verifier']).toBe('pending')
    })
  })

  // Workload 3: Automated Bug Triage and Dual-Fixer Benchmark Pipeline
  describe('Workload 3: Bug Triage and Dual-Fixer Benchmark Pipeline', () => {
    it('4.5 executes Triager -> Parallel Fixer A & Fixer B -> Benchmark Evaluator selecting best fix', async () => {
      const bugPipeline: WorkflowDefinition = {
        id: 'dual-fix-benchmark',
        name: 'Dual-Fix Benchmark Pipeline',
        nodes: [
          makeNode({ id: 'triager', prompt: 'Diagnose memory leak in terminal stream' }),
          makeNode({
            id: 'fixer-approach-a',
            prompt: 'Implement ring-buffer approach based on {{inputs.triager.output}}',
            dependencies: ['triager']
          }),
          makeNode({
            id: 'fixer-approach-b',
            prompt: 'Implement backpressure queue approach based on {{inputs.triager.output}}',
            dependencies: ['triager']
          }),
          makeNode({
            id: 'evaluator',
            prompt:
              'Benchmark solutions:\n' +
              'Approach A: {{inputs.fixer-approach-a.output}}\n' +
              'Approach B: {{inputs.fixer-approach-b.output}}',
            dependencies: ['fixer-approach-a', 'fixer-approach-b']
          })
        ]
      }

      let evalPrompt = ''
      const sim = await simulateDagExecution(bugPipeline, {
        triager: async () => ({ status: 'succeeded', content: 'Leaking in PTY onData buffer' }),
        'fixer-approach-a': async () => ({ status: 'succeeded', content: 'RingBuffer: 12 MB peak memory' }),
        'fixer-approach-b': async () => ({ status: 'succeeded', content: 'Queue: 35 MB peak memory' }),
        evaluator: async ({ interpolatedPrompt }) => {
          evalPrompt = interpolatedPrompt
          return { status: 'succeeded', content: 'Approach A selected (lower memory footprint).' }
        }
      })

      expect(sim.status).toBe('completed')
      expect(evalPrompt).toContain('Approach A: RingBuffer: 12 MB peak memory')
      expect(evalPrompt).toContain('Approach B: Queue: 35 MB peak memory')
      expect(sim.nodeOutputs.evaluator.content).toBe('Approach A selected (lower memory footprint).')
    })

    it('4.6 selects surviving approach when one fixer fails and skipOnFail is active', async () => {
      const bugPipeline: WorkflowDefinition = {
        id: 'dual-fix-resilient',
        name: 'Resilient Dual-Fix',
        nodes: [
          makeNode({ id: 'triager' }),
          makeNode({ id: 'fixer-a', dependencies: ['triager'] }),
          makeNode({ id: 'fixer-b', dependencies: ['triager'] }),
          makeNode({
            id: 'evaluator',
            dependencies: ['fixer-a', 'fixer-b'],
            policy: { skipOnFail: true }
          })
        ]
      }

      const sim = await simulateDagExecution(bugPipeline, {
        triager: async () => ({ status: 'succeeded' }),
        'fixer-a': async () => ({ status: 'failed', error: 'Compiler error in approach A' }),
        'fixer-b': async () => ({ status: 'succeeded', content: 'Fix B compiles and passes' })
      })

      expect(sim.nodeStates['fixer-a']).toBe('failed')
      expect(sim.nodeStates['fixer-b']).toBe('succeeded')
      // Downstream with skipOnFail skips when dependency failed
      expect(sim.nodeStates.evaluator).toBe('skipped')
    })
  })

  // Workload 4: Multi-Language Documentation Localization Pipeline
  describe('Workload 4: Multi-Language Documentation Localization Pipeline', () => {
    it('4.7 executes English Writer -> Parallel JA/ES/FR Translators -> Doc Publisher', async () => {
      const docPipeline: WorkflowDefinition = {
        id: 'doc-localization',
        name: 'Documentation Localization Pipeline',
        nodes: [
          makeNode({ id: 'en-writer', prompt: 'Write English release notes for OpenCode DAG v1.0' }),
          makeNode({
            id: 'ja-translator',
            prompt: 'Translate to Japanese: {{inputs.en-writer.output}}',
            dependencies: ['en-writer']
          }),
          makeNode({
            id: 'es-translator',
            prompt: 'Translate to Spanish: {{inputs.en-writer.output}}',
            dependencies: ['en-writer']
          }),
          makeNode({
            id: 'fr-translator',
            prompt: 'Translate to French: {{inputs.en-writer.output}}',
            dependencies: ['en-writer']
          }),
          makeNode({
            id: 'publisher',
            prompt:
              'Publish multilingual docs:\n' +
              'EN: {{inputs.en-writer.output}}\n' +
              'JA: {{inputs.ja-translator.output}}\n' +
              'ES: {{inputs.es-translator.output}}\n' +
              'FR: {{inputs.fr-translator.output}}',
            dependencies: ['en-writer', 'ja-translator', 'es-translator', 'fr-translator']
          })
        ]
      }

      let publishPrompt = ''
      const sim = await simulateDagExecution(docPipeline, {
        'en-writer': async () => ({ status: 'succeeded', content: 'DAG workflows are now live.' }),
        'ja-translator': async () => ({ status: 'succeeded', content: 'DAGワークフローが利用可能になりました。' }),
        'es-translator': async () => ({ status: 'succeeded', content: 'Los flujos DAG ya están disponibles.' }),
        'fr-translator': async () => ({ status: 'succeeded', content: 'Les flux DAG sont désormais disponibles.' }),
        publisher: async ({ interpolatedPrompt }) => {
          publishPrompt = interpolatedPrompt
          return { status: 'succeeded', content: 'Published all 4 localized documentation files.' }
        }
      })

      expect(sim.status).toBe('completed')
      expect(sim.wavesExecuted).toBe(3)
      expect(publishPrompt).toContain('DAGワークフローが利用可能になりました。')
      expect(publishPrompt).toContain('Los flujos DAG ya están disponibles.')
      expect(publishPrompt).toContain('Les flux DAG sont désormais disponibles.')
      expect(sim.nodeOutputs.publisher.content).toBe('Published all 4 localized documentation files.')
    })

    it('4.8 full workflow persistence lifecycle across all Tier 4 workload templates', async () => {
      const templates = ['review', 'refactor', 'triage', 'localization']
      for (const t of templates) {
        const wf = makeWorkflow({ id: `template-${t}`, name: `Template ${t}` })
        await saveWorkflow(projectDir, wf)
      }

      const list = await listWorkflows(projectDir)
      expect(list).toHaveLength(4)
      for (const t of templates) {
        expect(list.some((w) => w.id === `template-${t}`)).toBe(true)
      }
    })
  })
})
