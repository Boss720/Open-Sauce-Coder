import { describe, expect, it } from 'vitest'
import { MAX_WORKFLOW_NODES, validateWorkflow } from '../harness/dag/validator'
import { interpolatePrompt } from '../harness/dag/interpolator'
import type { DagNodeDefinition, DagNodeOutput, WorkflowDefinition } from '../harness/dag/types'

// Helper to generate a random DAG with N nodes and given edge probability
function generateRandomDag(
  nodeCount: number,
  edgeProbability: number,
  seed = 42
): WorkflowDefinition {
  // Simple pseudo-random number generator for reproducible tests
  let s = seed
  function rand(): number {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }

  const nodes: DagNodeDefinition[] = []
  // Topological order: node i can only depend on nodes j < i to guarantee acyclicity
  for (let i = 0; i < nodeCount; i++) {
    const id = `node_${i}`
    const deps: string[] = []
    for (let j = 0; j < i; j++) {
      if (rand() < edgeProbability) {
        deps.push(`node_${j}`)
      }
    }
    nodes.push({
      id,
      name: `Node ${i}`,
      profileId: 'test-profile',
      prompt: `Prompt for ${id}`,
      dependencies: deps.length > 0 ? deps : undefined
    })
  }

  // Shuffle nodes to ensure validator doesn't rely on array ordering
  const shuffledNodes = [...nodes].sort(() => rand() - 0.5)

  return {
    id: `random-dag-${nodeCount}-${seed}`,
    name: `Random DAG ${nodeCount}`,
    nodes: shuffledNodes
  }
}

describe('M1 Empirical Stress Test Suite: DAG Invariants', () => {
  describe('Invariant 1: Wave Depth and Minimal Depth Ordering', () => {
    it('verifies that in 50 randomly generated DAGs, every node in Wave k depends strictly on nodes in Waves < k', () => {
      for (let run = 0; run < 50; run++) {
        const nodeCount = 10 + (run % 40) // 10 to 50 nodes
        const edgeProb = 0.1 + (run % 5) * 0.08
        const wf = generateRandomDag(nodeCount, edgeProb, 1000 + run)

        const result = validateWorkflow(wf)
        expect(result.valid).toBe(true)
        expect(result.plan).toBeDefined()

        const waves = result.plan!.waves
        const nodeToWaveMap = new Map<string, number>()

        // Check completeness and uniqueness across waves
        let totalNodesInWaves = 0
        for (const wave of waves) {
          for (const nid of wave.nodeIds) {
            expect(nodeToWaveMap.has(nid)).toBe(false) // node must appear in exactly one wave
            nodeToWaveMap.set(nid, wave.waveIndex)
            totalNodesInWaves++
          }
        }
        expect(totalNodesInWaves).toBe(wf.nodes.length)

        // Verify wave depth invariant: deps must be in strictly earlier waves
        for (const node of wf.nodes) {
          const myWave = nodeToWaveMap.get(node.id)!
          const deps = node.dependencies ?? []

          if (deps.length === 0) {
            // Roots must always be in Wave 0
            expect(myWave).toBe(0)
          } else {
            let maxDepWave = -1
            for (const depId of deps) {
              const depWave = nodeToWaveMap.get(depId)
              expect(depWave).toBeDefined()
              expect(depWave!).toBeLessThan(myWave)
              if (depWave! > maxDepWave) {
                maxDepWave = depWave!
              }
            }
            // Minimal depth invariant: wave must be exactly maxDepWave + 1
            expect(myWave).toBe(maxDepWave + 1)
          }
        }
      }
    })

    it('verifies minimal wave depth for diamond graphs with multi-level skips', () => {
      // Root -> [A, B, C] -> D, plus Root -> D directly
      const wf: WorkflowDefinition = {
        id: 'diamond-skip',
        name: 'Diamond with Skip Connection',
        nodes: [
          { id: 'root', profileId: 'p', prompt: 'r' },
          { id: 'branch_a', profileId: 'p', prompt: 'a', dependencies: ['root'] },
          { id: 'branch_b', profileId: 'p', prompt: 'b', dependencies: ['root'] },
          { id: 'branch_c', profileId: 'p', prompt: 'c', dependencies: ['root'] },
          {
            id: 'sink',
            profileId: 'p',
            prompt: 's',
            dependencies: ['root', 'branch_a', 'branch_b', 'branch_c']
          }
        ]
      }

      const result = validateWorkflow(wf)
      expect(result.valid).toBe(true)
      const waves = result.plan!.waves
      expect(waves.length).toBe(3)
      expect(waves[0].nodeIds).toEqual(['root'])
      expect(waves[1].nodeIds).toEqual(['branch_a', 'branch_b', 'branch_c'])
      expect(waves[2].nodeIds).toEqual(['sink'])
    })

    it('handles deep linear chain of 100 sequential waves without stack overflow', () => {
      const nodeCount = 100
      const nodes: DagNodeDefinition[] = []
      for (let i = 0; i < nodeCount; i++) {
        nodes.push({
          id: `step_${i}`,
          profileId: 'p',
          prompt: `Step ${i}`,
          dependencies: i > 0 ? [`step_${i - 1}`] : undefined
        })
      }
      const wf: WorkflowDefinition = { id: 'deep-chain', name: 'Deep Chain', nodes }

      const result = validateWorkflow(wf)
      expect(result.valid).toBe(true)
      expect(result.plan?.waves.length).toBe(100)
      for (let i = 0; i < 100; i++) {
        expect(result.plan!.waves[i].nodeIds).toEqual([`step_${i}`])
      }
    })
  })

  describe('Invariant 2: Wave Independence (No Intra-Wave Dependencies)', () => {
    it('verifies that no two nodes in the same wave have a dependency relationship', () => {
      for (let run = 0; run < 30; run++) {
        const wf = generateRandomDag(25, 0.25, 5000 + run)
        const result = validateWorkflow(wf)
        expect(result.valid).toBe(true)

        const nodeMap = new Map(wf.nodes.map((n) => [n.id, n]))

        for (const wave of result.plan!.waves) {
          const waveSet = new Set(wave.nodeIds)
          for (const nodeId of wave.nodeIds) {
            const node = nodeMap.get(nodeId)!
            const deps = node.dependencies ?? []
            for (const depId of deps) {
              // Intra-wave dependency assertion:
              // If node A is in wave K, no dependency of A may be in wave K
              expect(waveSet.has(depId)).toBe(false)
            }
          }
        }
      }
    })
  })

  describe('Invariant 3: Cycle Detection and Disconnect Property', () => {
    it('detects cycles and verifies that removing the cycle-closing edge makes the graph a valid DAG', () => {
      // Test across multiple cycle lengths: 2, 3, 4, 5, 10
      const cycleLengths = [2, 3, 4, 5, 10]

      for (const len of cycleLengths) {
        const nodes: DagNodeDefinition[] = []
        for (let i = 0; i < len; i++) {
          const next = (i + 1) % len
          nodes.push({
            id: `c_${i}`,
            profileId: 'p',
            prompt: `Node ${i}`,
            dependencies: [`c_${next}`] // c_0 -> c_1 -> ... -> c_{len-1} -> c_0
          })
        }

        const cyclicWf: WorkflowDefinition = {
          id: `cycle-${len}`,
          name: `Cycle of length ${len}`,
          nodes
        }

        // 1. Must fail validation with cyclic error
        const cyclicResult = validateWorkflow(cyclicWf)
        expect(cyclicResult.valid).toBe(false)
        expect(cyclicResult.plan).toBeUndefined()
        expect(cyclicResult.errors.length).toBeGreaterThan(0)
        expect(cyclicResult.errors[0]).toMatch(/Cyclic dependency detected/)

        // 2. Disconnect edge: remove dependency from the last node to the first node
        const fixedNodes = nodes.map((n) => {
          if (n.id === `c_${len - 1}`) {
            return { ...n, dependencies: undefined }
          }
          return { ...n }
        })

        const fixedWf: WorkflowDefinition = {
          ...cyclicWf,
          nodes: fixedNodes
        }

        const fixedResult = validateWorkflow(fixedWf)
        expect(fixedResult.valid).toBe(true)
        expect(fixedResult.plan).toBeDefined()
        expect(fixedResult.plan!.waves.length).toBe(len)
      }
    })

    it('detects a cycle embedded deep within a large valid DAG, and fixes it upon edge disconnect', () => {
      const validBase = generateRandomDag(30, 0.15, 999)
      const nodes = [...validBase.nodes]

      // Add a 3-node cycle: X -> Y -> Z -> X
      nodes.push({ id: 'bad_x', profileId: 'p', prompt: 'x', dependencies: ['bad_y'] })
      nodes.push({ id: 'bad_y', profileId: 'p', prompt: 'y', dependencies: ['bad_z'] })
      nodes.push({ id: 'bad_z', profileId: 'p', prompt: 'z', dependencies: ['bad_x'] })

      const taintedWf: WorkflowDefinition = {
        id: 'tainted-wf',
        name: 'Tainted Workflow',
        nodes
      }

      const taintedResult = validateWorkflow(taintedWf)
      expect(taintedResult.valid).toBe(false)
      expect(taintedResult.errors[0]).toMatch(/Cyclic dependency detected: bad_/)

      // Disconnect bad_z -> bad_x
      const cleanedNodes = nodes.map((n) =>
        n.id === 'bad_z' ? { ...n, dependencies: undefined } : n
      )
      const cleanedWf: WorkflowDefinition = { ...taintedWf, nodes: cleanedNodes }

      const cleanedResult = validateWorkflow(cleanedWf)
      expect(cleanedResult.valid).toBe(true)
      expect(cleanedResult.plan).toBeDefined()
    })

    it('correctly handles figure-8 overlapping double cycles', () => {
      // Cycle 1: A -> B -> A
      // Cycle 2: B -> C -> B
      const wf: WorkflowDefinition = {
        id: 'figure-8',
        name: 'Figure 8 Cycle',
        nodes: [
          { id: 'node_a', profileId: 'p', prompt: 'a', dependencies: ['node_b'] },
          { id: 'node_b', profileId: 'p', prompt: 'b', dependencies: ['node_a', 'node_c'] },
          { id: 'node_c', profileId: 'p', prompt: 'c', dependencies: ['node_b'] }
        ]
      }

      const res = validateWorkflow(wf)
      expect(res.valid).toBe(false)
      expect(res.errors[0]).toMatch(/Cyclic dependency detected/)
    })
  })

  describe('Invariant 4: Interpolation Invariants & Security Boundaries', () => {
    const outputs = new Map<string, DagNodeOutput>([
      [
        'auth_node',
        {
          nodeId: 'auth_node',
          status: 'succeeded',
          finishReason: 'complete',
          content: 'Authorized data',
          turns: 3,
          usage: { input: 100, output: 50 },
          artifacts: [{ name: 'bundle.js', content: 'console.log("secure");' }]
        }
      ],
      [
        'secret_node',
        {
          nodeId: 'secret_node',
          status: 'succeeded',
          finishReason: 'complete',
          content: 'SUPER_SECRET_KEY_12345',
          turns: 1,
          usage: { input: 10, output: 20 },
          artifacts: [{ name: 'credentials.env', content: 'SECRET=foo' }]
        }
      ]
    ])

    it('strictly rejects any unauthorized dependency access in strict mode', () => {
      const unauthorizedTemplates = [
        '{{inputs.secret_node.output}}',
        '{{inputs.secret_node}}',
        '{{inputs.secret_node.status}}',
        '{{inputs.secret_node.finishReason}}',
        '{{inputs.secret_node.artifacts.credentials.env}}',
        'Prefix {{inputs.auth_node.output}} Middle {{inputs.secret_node.output}} Suffix',
        '{{   inputs.secret_node.output   }}'
      ]

      for (const tmpl of unauthorizedTemplates) {
        expect(() =>
          interpolatePrompt(tmpl, outputs, ['auth_node'], { strict: true })
        ).toThrow(/Unauthorized dependency reference: node "secret_node" is not in allowed dependencies/)
      }
    })

    it('in non-strict mode, leaves unauthorized references un-interpolated while interpolating authorized ones', () => {
      const tmpl = 'Auth: {{inputs.auth_node.output}}, Secret: {{inputs.secret_node.output}}'
      const result = interpolatePrompt(tmpl, outputs, ['auth_node'], { strict: false })
      expect(result).toBe('Auth: Authorized data, Secret: {{inputs.secret_node.output}}')
    })

    it('bounds interpolation string length at exact boundaries', () => {
      // Exact boundary: 50,000 chars should NOT have truncation notice
      const exact50k = 'B'.repeat(50_000)
      const exactMap = new Map<string, DagNodeOutput>([
        [
          'node_50k',
          {
            nodeId: 'node_50k',
            status: 'succeeded',
            content: exact50k,
            turns: 1,
            usage: { input: 0, output: 50000 }
          }
        ]
      ])
      const res50k = interpolatePrompt('{{inputs.node_50k.output}}', exactMap, ['node_50k'])
      expect(res50k).toBe(exact50k)
      expect(res50k).not.toContain('[Output truncated')

      // Boundary + 1: 50,001 chars MUST be truncated to 50,000 with notice
      const over50k = 'C'.repeat(50_001)
      const overMap = new Map<string, DagNodeOutput>([
        [
          'node_over',
          {
            nodeId: 'node_over',
            status: 'succeeded',
            content: over50k,
            turns: 1,
            usage: { input: 0, output: 50001 }
          }
        ]
      ])
      const resOver = interpolatePrompt('{{inputs.node_over.output}}', overMap, ['node_over'])
      expect(resOver).toContain('[Output truncated: showing first 50000 characters]')
      expect(resOver.startsWith('C'.repeat(50_000))).toBe(true)

      // Custom maxVariableChars parameter
      const customRes = interpolatePrompt('{{inputs.auth_node.output}}', outputs, ['auth_node'], {
        maxVariableChars: 5
      })
      expect(customRes).toBe('Autho\n\n[Output truncated: showing first 5 characters]')
    })

    it('safely handles prototype pollution and constructor property access', () => {
      const evilTemplates = [
        '{{inputs.__proto__}}',
        '{{inputs.__proto__.output}}',
        '{{inputs.constructor}}',
        '{{inputs.constructor.output}}',
        '{{inputs.prototype}}',
        '{{inputs.auth_node.__proto__}}',
        '{{inputs.auth_node.constructor}}',
        '{{inputs.auth_node.prototype}}',
        '{{inputs.auth_node.artifacts.__proto__}}'
      ]

      for (const tmpl of evilTemplates) {
        const res = interpolatePrompt(tmpl, outputs, ['auth_node', '__proto__', 'constructor', 'prototype'])
        expect(res).toBe('')
      }
    })

    it('safely handles Record format (plain object) in addition to Map', () => {
      const recordOutputs: Record<string, DagNodeOutput> = {
        auth_node: {
          nodeId: 'auth_node',
          status: 'succeeded',
          content: 'Record content',
          turns: 1,
          usage: { input: 1, output: 1 }
        }
      }

      const res = interpolatePrompt('{{inputs.auth_node.output}}', recordOutputs, ['auth_node'])
      expect(res).toBe('Record content')
    })
  })

  describe('Edge Cases: Pathological Graphs and Invariants', () => {
    it('handles duplicate dependency declarations gracefully without crashing wave partitioning', () => {
      const wfWithDups: WorkflowDefinition = {
        id: 'dups-wf',
        name: 'Workflow with Duplicate Dependencies',
        nodes: [
          { id: 'parent', profileId: 'p', prompt: 'p' },
          {
            id: 'child',
            profileId: 'p',
            prompt: 'c',
            dependencies: ['parent', 'parent'] // duplicate dependency
          }
        ]
      }

      const res = validateWorkflow(wfWithDups)
      expect(res.valid).toBe(true)
      expect(res.plan?.waves).toEqual([
        { waveIndex: 0, nodeIds: ['parent'] },
        { waveIndex: 1, nodeIds: ['child'] }
      ])
    })

    it('correctly handles a stress graph at the MAX_WORKFLOW_NODES limit', () => {
      const start = Date.now()
      const largeWf = generateRandomDag(MAX_WORKFLOW_NODES, 0.05, 12345)
      const res = validateWorkflow(largeWf)
      const duration = Date.now() - start

      expect(res.valid).toBe(true)
      expect(res.plan).toBeDefined()
      expect(duration).toBeLessThan(1500) // Must execute well under 1.5 seconds
    })

    it('rejects a workflow over MAX_WORKFLOW_NODES before any graph analysis', () => {
      const start = Date.now()
      const res = validateWorkflow(generateRandomDag(500, 0.02, 12345))
      const duration = Date.now() - start

      expect(res.valid).toBe(false)
      expect(res.plan).toBeUndefined()
      expect(res.errors.join(' ')).toMatch(/maximum is 128/)
      expect(duration).toBeLessThan(200)
    })
  })
})
