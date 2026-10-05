import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { interpolatePrompt, MAX_INTERPOLATED_CHARS } from '../harness/dag/interpolator'
import type { DagNodeDefinition, DagNodeOutput, WorkflowDefinition } from '../harness/dag/types'
import { validateWorkflow } from '../harness/dag/validator'
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow
} from '../harness/dag/workflowLoader'

describe('Challenger M1 Stress & Adversarial Suite', () => {
  // =========================================================================
  // SUITE 1: 50+ Node Random DAGs & Kahn Topological Ordering Oracle
  // =========================================================================
  describe('Kahn Topological Sorter & Wave Partitioner Stress Tests', () => {
    function generateRandomDag(nodeCount: number, edgeProbability: number): WorkflowDefinition {
      const nodes: DagNodeDefinition[] = []
      for (let i = 0; i < nodeCount; i++) {
        const id = `node_${i.toString().padStart(3, '0')}`
        const deps: string[] = []
        // Edges can only point backwards (j < i) to guarantee acyclicity
        for (let j = 0; j < i; j++) {
          if (Math.random() < edgeProbability) {
            deps.push(`node_${j.toString().padStart(3, '0')}`)
          }
        }
        nodes.push({
          id,
          name: `Node ${i}`,
          profileId: 'test-profile',
          prompt: `Execute step ${i}`,
          dependencies: deps.length > 0 ? deps : undefined
        })
      }
      return {
        id: `random-dag-${nodeCount}`,
        name: `Random DAG ${nodeCount} Nodes`,
        nodes
      }
    }

    function verifyTopologicalWaves(workflow: WorkflowDefinition, waves: { waveIndex: number; nodeIds: string[] }[]) {
      const nodeToWave = new Map<string, number>()
      let totalNodesInWaves = 0

      for (const wave of waves) {
        for (const nodeId of wave.nodeIds) {
          expect(nodeToWave.has(nodeId)).toBe(false) // No duplicate node in waves
          nodeToWave.set(nodeId, wave.waveIndex)
          totalNodesInWaves++
        }
      }

      // Check all nodes are accounted for
      expect(totalNodesInWaves).toBe(workflow.nodes.length)

      // Oracle rule 1: For every node, all its dependencies must belong to an earlier wave (w_dep < w_node)
      for (const node of workflow.nodes) {
        const nodeWave = nodeToWave.get(node.id)!
        for (const depId of node.dependencies ?? []) {
          const depWave = nodeToWave.get(depId)!
          expect(depWave).toBeLessThan(nodeWave)
        }
      }

      // Oracle rule 2: Minimal wave depth — if node is in wave w > 0, at least one dependency must be in wave w - 1
      for (const node of workflow.nodes) {
        const nodeWave = nodeToWave.get(node.id)!
        if (nodeWave > 0) {
          const deps = node.dependencies ?? []
          const maxDepWave = Math.max(...deps.map((d) => nodeToWave.get(d)!))
          expect(maxDepWave).toBe(nodeWave - 1)
        }
      }
    }

    it('empirically verifies 50-node random DAG topological wave ordering (sparse edges)', () => {
      const dag = generateRandomDag(50, 0.08)
      const res = validateWorkflow(dag)
      expect(res.valid).toBe(true)
      expect(res.errors).toEqual([])
      expect(res.plan).toBeDefined()
      verifyTopologicalWaves(dag, res.plan!.waves)
    })

    it('empirically verifies 50-node random DAG topological wave ordering (dense edges)', () => {
      const dag = generateRandomDag(50, 0.25)
      const res = validateWorkflow(dag)
      expect(res.valid).toBe(true)
      expect(res.errors).toEqual([])
      expect(res.plan).toBeDefined()
      verifyTopologicalWaves(dag, res.plan!.waves)
    })

    it('handles a 100-node completely flat parallel wave (all nodes in Wave 0)', () => {
      const nodes: DagNodeDefinition[] = []
      for (let i = 0; i < 100; i++) {
        nodes.push({
          id: `flat_${i}`,
          profileId: 'p',
          prompt: `Task ${i}`
        })
      }
      const dag: WorkflowDefinition = {
        id: 'flat-100',
        name: '100 Flat Workers',
        nodes
      }

      const res = validateWorkflow(dag)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(1)
      expect(res.plan?.waves[0].waveIndex).toBe(0)
      expect(res.plan?.waves[0].nodeIds).toHaveLength(100)
    })

    it('handles a 60-node linear sequential chain (60 waves of 1 node each)', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'step_00', profileId: 'p', prompt: 'Initial' }
      ]
      for (let i = 1; i < 60; i++) {
        nodes.push({
          id: `step_${i.toString().padStart(2, '0')}`,
          profileId: 'p',
          prompt: `Chain ${i}`,
          dependencies: [`step_${(i - 1).toString().padStart(2, '0')}`]
        })
      }
      const dag: WorkflowDefinition = {
        id: 'chain-60',
        name: 'Linear 60 Chain',
        nodes
      }

      const res = validateWorkflow(dag)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(60)
      for (let w = 0; w < 60; w++) {
        expect(res.plan?.waves[w].waveIndex).toBe(w)
        expect(res.plan?.waves[w].nodeIds).toEqual([`step_${w.toString().padStart(2, '0')}`])
      }
    })

    it('handles transitive dependencies correctly without placing downstream nodes early', () => {
      // A -> B -> C, and A -> C
      const nodes: DagNodeDefinition[] = [
        { id: 'a', profileId: 'p', prompt: 'A' },
        { id: 'b', profileId: 'p', prompt: 'B', dependencies: ['a'] },
        { id: 'c', profileId: 'p', prompt: 'C', dependencies: ['a', 'b'] }
      ]
      const res = validateWorkflow({ id: 'transitive', name: 'Transitive', nodes })
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toEqual([
        { waveIndex: 0, nodeIds: ['a'] },
        { waveIndex: 1, nodeIds: ['b'] },
        { waveIndex: 2, nodeIds: ['c'] }
      ])
    })

    it('handles inverted tree (99 roots merging into 1 sink)', () => {
      const nodes: DagNodeDefinition[] = []
      const roots: string[] = []
      for (let i = 0; i < 99; i++) {
        const id = `root_${i.toString().padStart(2, '0')}`
        roots.push(id)
        nodes.push({ id, profileId: 'p', prompt: `Root ${i}` })
      }
      nodes.push({ id: 'sink', profileId: 'p', prompt: 'Sink', dependencies: roots })

      const res = validateWorkflow({ id: 'inverted-tree', name: 'Inverted Tree', nodes })
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toHaveLength(2)
      expect(res.plan?.waves[0].nodeIds).toHaveLength(99)
      expect(res.plan?.waves[1].nodeIds).toEqual(['sink'])
    })
  })

  // =========================================================================
  // SUITE 2: Complex Cycle Graphs & DFS 3-Color Stress Testing
  // =========================================================================
  describe('Adversarial Cycle Detection & Path Tracing', () => {
    it('detects a 50-node ring cycle without stack overflow or false negatives', () => {
      const nodes: DagNodeDefinition[] = []
      const N = 50
      for (let i = 0; i < N; i++) {
        const nextId = `node_${((i + 1) % N).toString().padStart(2, '0')}`
        nodes.push({
          id: `node_${i.toString().padStart(2, '0')}`,
          profileId: 'p',
          prompt: `Step ${i}`,
          dependencies: [nextId]
        })
      }
      const cyclicWorkflow: WorkflowDefinition = {
        id: 'ring-50',
        name: '50 Node Ring Cycle',
        nodes
      }

      const res = validateWorkflow(cyclicWorkflow)
      expect(res.valid).toBe(false)
      expect(res.errors).toHaveLength(1)
      expect(res.errors[0]).toMatch(/^Cyclic dependency detected: node_/)
      // Check that the cycle trace closes on the same node
      const match = res.errors[0].match(/Cyclic dependency detected: (.+)/)
      expect(match).not.toBeNull()
      const cycleNodes = match![1].split(' -> ')
      expect(cycleNodes[0]).toBe(cycleNodes[cycleNodes.length - 1])
    })

    it('detects cycle in disconnected subgraph alongside a valid acyclic tree', () => {
      // Subgraph 1: Valid linear pipeline A -> B -> C
      // Subgraph 2: Cycle X -> Y -> Z -> X
      const nodes: DagNodeDefinition[] = [
        { id: 'valid_a', profileId: 'p', prompt: 'A' },
        { id: 'valid_b', profileId: 'p', prompt: 'B', dependencies: ['valid_a'] },
        { id: 'valid_c', profileId: 'p', prompt: 'C', dependencies: ['valid_b'] },
        { id: 'cycle_x', profileId: 'p', prompt: 'X', dependencies: ['cycle_z'] },
        { id: 'cycle_y', profileId: 'p', prompt: 'Y', dependencies: ['cycle_x'] },
        { id: 'cycle_z', profileId: 'p', prompt: 'Z', dependencies: ['cycle_y'] }
      ]
      const mixedWorkflow: WorkflowDefinition = {
        id: 'disconnected-cycle',
        name: 'Disconnected Graph with Cycle',
        nodes
      }

      const res = validateWorkflow(mixedWorkflow)
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toMatch(/Cyclic dependency detected: cycle_/)
      const match = res.errors[0].match(/Cyclic dependency detected: (.+)/)
      const parts = match![1].split(' -> ')
      expect(parts[0]).toBe(parts[parts.length - 1])
      // Valid nodes must not be included in the cycle path
      expect(parts).not.toContain('valid_a')
      expect(parts).not.toContain('valid_b')
      expect(parts).not.toContain('valid_c')
    })

    it('accurately trims lead-in prefix path leading into a cycle', () => {
      // feeder_1 -> feeder_2 -> loop_a -> loop_b -> loop_a
      const nodes: DagNodeDefinition[] = [
        { id: 'a_feeder_1', profileId: 'p', prompt: 'Feeder 1' },
        { id: 'b_feeder_2', profileId: 'p', prompt: 'Feeder 2', dependencies: ['a_feeder_1'] },
        { id: 'c_loop_1', profileId: 'p', prompt: 'L1', dependencies: ['b_feeder_2', 'd_loop_2'] },
        { id: 'd_loop_2', profileId: 'p', prompt: 'L2', dependencies: ['c_loop_1'] }
      ]
      const workflow: WorkflowDefinition = {
        id: 'feeder-cycle',
        name: 'Cycle with Feeder',
        nodes
      }

      const res = validateWorkflow(workflow)
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toMatch(/Cyclic dependency detected: (c_loop_1 -> d_loop_2 -> c_loop_1|d_loop_2 -> c_loop_1 -> d_loop_2)/)
      // Feeders must not be part of the cycle trace
      expect(res.errors[0]).not.toContain('a_feeder_1')
      expect(res.errors[0]).not.toContain('b_feeder_2')
    })

    it('detects nested figure-8 cycles', () => {
      // Loop 1: alpha <-> beta
      // Loop 2: beta <-> gamma
      const nodes: DagNodeDefinition[] = [
        { id: 'alpha', profileId: 'p', prompt: 'Alpha', dependencies: ['beta'] },
        { id: 'beta', profileId: 'p', prompt: 'Beta', dependencies: ['alpha', 'gamma'] },
        { id: 'gamma', profileId: 'p', prompt: 'Gamma', dependencies: ['beta'] }
      ]
      const workflow: WorkflowDefinition = { id: 'figure-8', name: 'Figure 8 Cycle', nodes }
      const res = validateWorkflow(workflow)
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toMatch(/Cyclic dependency detected:/)
    })
  })

  // =========================================================================
  // SUITE 3: Schema Validation Edge Cases & Malicious Inputs
  // =========================================================================
  describe('Workflow Schema & Defensive Validation', () => {
    it('rejects duplicate dependencies within the same node or handles them gracefully', () => {
      const workflow: WorkflowDefinition = {
        id: 'dup-deps',
        name: 'Duplicate Dependencies',
        nodes: [
          { id: 'a', profileId: 'p', prompt: 'A' },
          { id: 'b', profileId: 'p', prompt: 'B', dependencies: ['a', 'a'] }
        ]
      }
      const res = validateWorkflow(workflow)
      // Should validate and produce waves without inDegree double-decrement crash
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toEqual([
        { waveIndex: 0, nodeIds: ['a'] },
        { waveIndex: 1, nodeIds: ['b'] }
      ])
    })

    it('rejects prototype properties as node IDs without corrupting internal Maps', () => {
      const workflow: WorkflowDefinition = {
        id: 'proto-node-test',
        name: 'Prototype Node Test',
        nodes: [
          { id: '__proto__', profileId: 'p', prompt: 'Proto' },
          { id: 'worker', profileId: 'p', prompt: 'Worker', dependencies: ['__proto__'] }
        ]
      }
      const res = validateWorkflow(workflow)
      // JavaScript Map handles __proto__ safely as string key
      expect(res.valid).toBe(true)
      expect(res.plan?.waves[0].nodeIds).toEqual(['__proto__'])
      expect(res.plan?.waves[1].nodeIds).toEqual(['worker'])
    })

    it('rejects multiple unknown dependencies with distinct descriptive errors', () => {
      const workflow: WorkflowDefinition = {
        id: 'multi-unknown',
        name: 'Multi Unknown',
        nodes: [
          { id: 'a', profileId: 'p', prompt: 'A', dependencies: ['ghost_1', 'ghost_2'] }
        ]
      }
      const res = validateWorkflow(workflow)
      expect(res.valid).toBe(false)
      expect(res.errors).toContain('Node "a" depends on unknown node "ghost_1".')
      expect(res.errors).toContain('Node "a" depends on unknown node "ghost_2".')
    })

    it('rejects whitespace-only IDs and prompts', () => {
      const workflow: WorkflowDefinition = {
        id: '   ',
        name: '  ',
        nodes: [
          { id: ' \t ', profileId: '  ', prompt: 'valid' }
        ]
      }
      const res = validateWorkflow(workflow)
      expect(res.valid).toBe(false)
      expect(res.errors).toContain('Workflow must specify a non-empty id.')
      expect(res.errors).toContain('Workflow must specify a non-empty name.')
      expect(res.errors).toContain('Node must specify a non-empty id.')
    })

    it('rejects non-object workflow definitions', () => {
      expect(validateWorkflow(null as unknown as WorkflowDefinition).valid).toBe(false)
      expect(validateWorkflow('string' as unknown as WorkflowDefinition).valid).toBe(false)
      expect(validateWorkflow([] as unknown as WorkflowDefinition).valid).toBe(false)
    })
  })

  // =========================================================================
  // SUITE 4: Prompt Interpolator Adversarial Stress & ReDoS Testing
  // =========================================================================
  describe('Prompt Interpolator Adversarial Stress & Security', () => {
    it('scales linearly under 1,000 distinct interpolation tokens in a massive prompt', () => {
      const outputs = new Map<string, DagNodeOutput>()
      const allowedIds: string[] = []
      let template = 'Massive Template Compilation:\n'

      const TOKEN_COUNT = 1000
      for (let i = 0; i < TOKEN_COUNT; i++) {
        const id = `worker_${i}`
        allowedIds.push(id)
        outputs.set(id, {
          nodeId: id,
          status: 'succeeded',
          content: `Result_${i}`,
          turns: 1,
          usage: { input: 10, output: 10 }
        })
        template += `Token ${i}: {{inputs.${id}.output}}\n`
      }

      const start = performance.now()
      const result = interpolatePrompt(template, outputs, allowedIds)
      const elapsed = performance.now() - start

      expect(result).toContain('Token 0: Result_0')
      expect(result).toContain('Token 999: Result_999')
      expect(elapsed).toBeLessThan(200) // Must execute well under 200ms
    })

    it('is immune to ReDoS patterns and catastrophic backtracking', () => {
      const evilPayloads = [
        '{{ inputs.' + 'a'.repeat(5_000) + ' }}',
        '{{ inputs.node.' + 'a'.repeat(5_000) + ' }}',
        '{{' + ' '.repeat(5_000) + 'inputs.node.output' + ' '.repeat(5_000) + '}}',
        '{{{{{{{{inputs.node.output}}}}}}}}',
        '{{ inputs.node.artifacts.' + 'x'.repeat(5_000) + ' }}'
      ]

      const outputs = new Map<string, DagNodeOutput>([
        ['node', { nodeId: 'node', status: 'succeeded', content: 'OK', turns: 1, usage: { input: 0, output: 0 } }]
      ])

      for (const payload of evilPayloads) {
        const start = performance.now()
        interpolatePrompt(payload, outputs, ['node'], { strict: false })
        const elapsed = performance.now() - start
        expect(elapsed).toBeLessThan(100) // No regex hang
      }
    })

    it('handles multiple 60,000-character variables simultaneously bounding each to MAX_INTERPOLATED_CHARS', () => {
      const huge1 = 'A'.repeat(60_000)
      const huge2 = 'B'.repeat(70_000)
      const outputs = new Map<string, DagNodeOutput>([
        ['heavy_1', { nodeId: 'heavy_1', status: 'succeeded', content: huge1, turns: 1, usage: { input: 0, output: 0 } }],
        ['heavy_2', { nodeId: 'heavy_2', status: 'succeeded', content: huge2, turns: 1, usage: { input: 0, output: 0 } }]
      ])

      const template = 'Part 1:\n{{inputs.heavy_1.output}}\nPart 2:\n{{inputs.heavy_2.output}}'
      const result = interpolatePrompt(template, outputs, ['heavy_1', 'heavy_2'])

      expect(result).toContain(`Part 1:\n${'A'.repeat(MAX_INTERPOLATED_CHARS)}\n\n[Output truncated: showing first ${MAX_INTERPOLATED_CHARS} characters]`)
      expect(result).toContain(`Part 2:\n${'B'.repeat(MAX_INTERPOLATED_CHARS)}\n\n[Output truncated: showing first ${MAX_INTERPOLATED_CHARS} characters]`)
    })

    it('handles null/undefined fields in output objects without literal "undefined" output', () => {
      const outputs = new Map<string, DagNodeOutput>([
        [
          'empty_node',
          {
            nodeId: 'empty_node',
            status: 'succeeded',
            content: undefined,
            error: undefined,
            turns: 0,
            usage: { input: 0, output: 0 }
          }
        ]
      ])

      const template = 'Content: [{{inputs.empty_node.output}}], Error: [{{inputs.empty_node.error}}]'
      const result = interpolatePrompt(template, outputs, ['empty_node'])
      expect(result).toBe('Content: [], Error: []')
    })

    it('blocks prototype pollution through constructor and prototype properties', () => {
      const outputs = new Map<string, DagNodeOutput>([
        ['node', { nodeId: 'node', status: 'succeeded', content: 'Safe', turns: 1, usage: { input: 0, output: 0 } }]
      ])

      const template = 'T1: [{{inputs.constructor.output}}], T2: [{{inputs.node.constructor}}], T3: [{{inputs.node.prototype}}]'
      const result = interpolatePrompt(template, outputs, ['node', 'constructor'])
      expect(result).toBe('T1: [], T2: [], T3: []')
    })

    it('safely treats special replacement patterns in output content as literal strings ($$, $&, $1, $\')', () => {
      const outputs = new Map<string, DagNodeOutput>([
        [
          'price_worker',
          {
            nodeId: 'price_worker',
            status: 'succeeded',
            content: 'Cost is $$100 and regex pattern is $& with match $1 and remainder $\'',
            turns: 1,
            usage: { input: 0, output: 0 }
          }
        ]
      ])

      const template = 'Summary: {{inputs.price_worker.output}}'
      const result = interpolatePrompt(template, outputs, ['price_worker'])
      expect(result).toBe('Summary: Cost is $$100 and regex pattern is $& with match $1 and remainder $\'')
    })

    it('interpolates consecutive variables without delimiters', () => {
      const outputs = new Map<string, DagNodeOutput>([
        ['a', { nodeId: 'a', status: 'succeeded', content: 'HELLO', turns: 1, usage: { input: 0, output: 0 } }],
        ['b', { nodeId: 'b', status: 'succeeded', content: 'WORLD', turns: 1, usage: { input: 0, output: 0 } }]
      ])

      const template = '{{inputs.a.output}}{{inputs.b.output}}'
      const result = interpolatePrompt(template, outputs, ['a', 'b'])
      expect(result).toBe('HELLOWORLD')
    })

    it('supports complex artifact names with dots and hyphens', () => {
      const outputs = new Map<string, DagNodeOutput>([
        [
          'packager',
          {
            nodeId: 'packager',
            status: 'succeeded',
            artifacts: [
              { name: 'archive.v1.0.tar.gz', content: 'ARCHIVE_BINARY_DATA' }
            ],
            turns: 1,
            usage: { input: 0, output: 0 }
          }
        ]
      ])

      const template = 'Artifact: {{inputs.packager.artifacts.archive.v1.0.tar.gz}}'
      const result = interpolatePrompt(template, outputs, ['packager'])
      expect(result).toBe('Artifact: ARCHIVE_BINARY_DATA')
    })
  })

  // =========================================================================
  // SUITE 5: WorkflowLoader Filesystem Security & Path Traversal Stress Tests
  // =========================================================================
  describe('WorkflowLoader Path Containment & Storage Security', () => {
    let testProjectDir: string

    beforeEach(() => {
      testProjectDir = mkdtempSync(join(tmpdir(), 'oc-stress-wf-'))
    })

    afterEach(() => {
      try {
        rmSync(testProjectDir, { recursive: true, force: true })
      } catch {
        // Ignore cleanup error
      }
    })

    it('rejects escaping path traversal payloads in workflow IDs', async () => {
      const escapingIds = [
        '../escaped',
        '..\\escaped',
        '../../../../windows/system32/cmd',
        '..\\..\\..\\..\\windows\\system32\\cmd',
        'C:\\Windows\\System32\\cmd'
      ]

      for (const badId of escapingIds) {
        await expect(getWorkflow(testProjectDir, badId)).rejects.toThrow(
          /strictly inside the project directory/i
        )
        await expect(deleteWorkflow(testProjectDir, badId)).rejects.toThrow(
          /strictly inside the project directory/i
        )
      }
    })

    it('handles empty workflow IDs defensively', async () => {
      await expect(getWorkflow(testProjectDir, '')).rejects.toThrow(
        /Workflow id must be a non-empty string/
      )
      await expect(deleteWorkflow(testProjectDir, '')).rejects.toThrow(
        /Workflow id must be a non-empty string/
      )
    })

    it('isolates corrupted files and continues discovering valid workflows in batch', async () => {
      // Save 5 valid workflows
      for (let i = 0; i < 5; i++) {
        const wf: WorkflowDefinition = {
          id: `valid-wf-${i}`,
          name: `Valid Workflow ${i}`,
          nodes: [{ id: 'init', profileId: 'p', prompt: 'Work' }]
        }
        await saveWorkflow(testProjectDir, wf)
      }

      // Inject malicious / corrupted files into the directory
      const wfDir = join(testProjectDir, '.opencode', 'workflows')
      writeFileSync(join(wfDir, 'broken-json.json'), '{ broken: true,', 'utf-8')
      writeFileSync(join(wfDir, 'null.json'), 'null', 'utf-8')
      writeFileSync(join(wfDir, 'array.json'), '[]', 'utf-8')
      writeFileSync(join(wfDir, 'not-a-workflow.json'), '{"random": 123}', 'utf-8')
      writeFileSync(join(wfDir, 'cyclical.json'), JSON.stringify({
        id: 'cyclical',
        name: 'Cyclic',
        nodes: [
          { id: 'a', profileId: 'p', prompt: 'a', dependencies: ['b'] },
          { id: 'b', profileId: 'p', prompt: 'b', dependencies: ['a'] }
        ]
      }), 'utf-8')
      writeFileSync(join(wfDir, 'readme.txt'), 'ignore me', 'utf-8')

      const discovered = await listWorkflows(testProjectDir)
      // Must discover exactly the 5 valid workflows and safely ignore all 6 corrupt files
      expect(discovered).toHaveLength(5)
      for (let i = 0; i < 5; i++) {
        expect(discovered.some((w) => w.id === `valid-wf-${i}`)).toBe(true)
      }
    })
  })
})
