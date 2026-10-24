import { describe, expect, it } from 'vitest'
import {
  computeDagLayout,
  type DagGraphLayout,
  type LayoutNode
} from '../dagLayout'
import type { DagNodeDefinition, WorkflowDefinition } from '../types'

/**
 * Universal layout invariant assertions:
 * 1. Dimensions: width > 0, height > 0, all numbers finite.
 * 2. Nodes: x >= 0, y >= 0, width > 0, height > 0, all finite, contained within bounding box.
 * 3. Waves: no vertical overlaps among nodes in the same wave column.
 * 4. Edges: well-formed SVG cubic bezier syntax 'M x1 y1 C cx1 cy1, cx2 cy2, x2 y2',
 *    all control point values finite, anchor coordinates match source right-center and target left-center.
 */
function assertLayoutInvariants(layout: DagGraphLayout, expectedNodeCount?: number): void {
  // 1. Dimensions
  expect(Number.isFinite(layout.width)).toBe(true)
  expect(Number.isFinite(layout.height)).toBe(true)
  expect(layout.width).toBeGreaterThan(0)
  expect(layout.height).toBeGreaterThan(0)

  if (expectedNodeCount !== undefined) {
    expect(layout.nodes.length).toBe(expectedNodeCount)
  }

  const svgBezierRegex = /^M\s+([0-9.-]+)\s+([0-9.-]+)\s+C\s+([0-9.-]+)\s+([0-9.-]+),\s*([0-9.-]+)\s+([0-9.-]+),\s*([0-9.-]+)\s+([0-9.-]+)$/

  // 2. Nodes
  const nodeMap = new Map<string, LayoutNode>()
  for (const node of layout.nodes) {
    expect(Number.isFinite(node.x)).toBe(true)
    expect(Number.isFinite(node.y)).toBe(true)
    expect(node.x).toBeGreaterThanOrEqual(0)
    expect(node.y).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(node.width)).toBe(true)
    expect(Number.isFinite(node.height)).toBe(true)
    expect(node.width).toBeGreaterThan(0)
    expect(node.height).toBeGreaterThan(0)
    expect(Number.isFinite(node.waveIndex)).toBe(true)
    expect(node.waveIndex).toBeGreaterThanOrEqual(0)

    // Node is contained within canvas bounds
    expect(node.x + node.width).toBeLessThanOrEqual(layout.width)
    expect(node.y + node.height).toBeLessThanOrEqual(layout.height)

    nodeMap.set(node.id, node)
  }

  // 3. No vertical overlaps in the same wave column
  const waveNodesMap = new Map<number, LayoutNode[]>()
  for (const node of layout.nodes) {
    if (!waveNodesMap.has(node.waveIndex)) {
      waveNodesMap.set(node.waveIndex, [])
    }
    waveNodesMap.get(node.waveIndex)!.push(node)
  }
  for (const [, columnNodes] of waveNodesMap.entries()) {
    columnNodes.sort((a, b) => a.y - b.y)
    for (let i = 0; i < columnNodes.length - 1; i++) {
      const current = columnNodes[i]
      const next = columnNodes[i + 1]
      expect(next.y).toBeGreaterThanOrEqual(current.y + current.height)
    }
  }

  // 4. Edges and SVG bezier path syntax
  for (const edge of layout.edges) {
    expect(edge.fromId).toBeTruthy()
    expect(edge.toId).toBeTruthy()
    expect(edge.pathD).toMatch(svgBezierRegex)

    const match = edge.pathD.match(svgBezierRegex)
    expect(match).not.toBeNull()
    if (match) {
      for (let i = 1; i <= 8; i++) {
        const val = parseFloat(match[i])
        expect(Number.isFinite(val)).toBe(true)
        expect(Number.isNaN(val)).toBe(false)
      }
    }

    const source = nodeMap.get(edge.fromId)
    const target = nodeMap.get(edge.toId)
    expect(source).toBeDefined()
    expect(target).toBeDefined()
    if (source && target) {
      const expectedStartX = source.x + source.width
      const expectedStartY = source.y + source.height / 2
      const expectedEndX = target.x
      const expectedEndY = target.y + target.height / 2
      expect(edge.pathD.startsWith(`M ${expectedStartX} ${expectedStartY}`)).toBe(true)
      expect(edge.pathD.endsWith(`${expectedEndX} ${expectedEndY}`)).toBe(true)
    }
  }
}

describe('dagLayout Adversarial Stress Test Suite', () => {
  describe('1. Empty and Single-Node Topologies', () => {
    it('handles an empty node array', () => {
      const layout = computeDagLayout([])
      assertLayoutInvariants(layout, 0)
      expect(layout.edges.length).toBe(0)
      expect(layout.waves.length).toBe(0)
      expect(layout.hasCycle).toBe(false)
    })

    it('handles a workflow object with empty nodes array', () => {
      const wf: WorkflowDefinition = {
        id: 'wf-empty',
        name: 'Empty Workflow',
        nodes: []
      }
      const layout = computeDagLayout(wf)
      assertLayoutInvariants(layout, 0)
      expect(layout.edges.length).toBe(0)
      expect(layout.hasCycle).toBe(false)
    })

    it('handles a workflow object with undefined nodes array', () => {
      const wf = {
        id: 'wf-missing-nodes',
        name: 'No Nodes Field'
      } as unknown as WorkflowDefinition
      const layout = computeDagLayout(wf)
      assertLayoutInvariants(layout, 0)
      expect(layout.edges.length).toBe(0)
    })

    it('handles a single isolated node', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'singleton', profileId: 'default', prompt: 'Only me' }
      ]
      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 1)
      expect(layout.waves).toEqual([['singleton']])
      expect(layout.edges.length).toBe(0)
      expect(layout.hasCycle).toBe(false)
      expect(layout.nodes[0].x).toBe(48) // default padding
      expect(layout.nodes[0].y).toBe(48)
    })
  })

  describe('2. Deep Linear Chains (50+ and 100+ Nodes)', () => {
    it('layouts 50 sequential nodes into 50 monotonic waves', () => {
      const count = 50
      const nodes: DagNodeDefinition[] = Array.from({ length: count }, (_, i) => ({
        id: `node_${i}`,
        profileId: 'worker',
        prompt: `Step ${i}`,
        dependencies: i === 0 ? [] : [`node_${i - 1}`]
      }))

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, count)

      expect(layout.waves.length).toBe(count)
      expect(layout.edges.length).toBe(count - 1)
      expect(layout.hasCycle).toBe(false)

      // Verify strict horizontal monotonicity
      for (let i = 0; i < count - 1; i++) {
        const curr = layout.nodes.find((n) => n.id === `node_${i}`)!
        const next = layout.nodes.find((n) => n.id === `node_${i + 1}`)!
        expect(next.x).toBeGreaterThan(curr.x)
        expect(curr.waveIndex).toBe(i)
        expect(next.waveIndex).toBe(i + 1)
      }
    })

    it('layouts 100 sequential nodes without performance degradation or stack overflow', () => {
      const count = 100
      const nodes: DagNodeDefinition[] = Array.from({ length: count }, (_, i) => ({
        id: `chain_${i}`,
        profileId: 'worker',
        prompt: `Step ${i}`,
        dependencies: i === 0 ? [] : [`chain_${i - 1}`]
      }))

      const startTime = performance.now()
      const layout = computeDagLayout(nodes)
      const duration = performance.now() - startTime

      assertLayoutInvariants(layout, count)
      expect(layout.waves.length).toBe(count)
      expect(layout.edges.length).toBe(count - 1)
      expect(duration).toBeLessThan(100) // sub-100ms execution
    })
  })

  describe('3. Massive Wide Waves (50+ and 100+ Independent Nodes in Wave 0)', () => {
    it('layouts 50 independent nodes into a single wide wave column', () => {
      const count = 50
      const nodes: DagNodeDefinition[] = Array.from({ length: count }, (_, i) => ({
        id: `parallel_${String(i).padStart(3, '0')}`,
        profileId: 'worker',
        prompt: `Task ${i}`
      }))

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, count)

      expect(layout.waves.length).toBe(1)
      expect(layout.waves[0].length).toBe(count)
      expect(layout.edges.length).toBe(0)
      expect(layout.hasCycle).toBe(false)

      // All nodes share identical X coordinate
      const firstX = layout.nodes[0].x
      for (const node of layout.nodes) {
        expect(node.x).toBe(firstX)
        expect(node.waveIndex).toBe(0)
      }

      // Height should encompass all 50 nodes stacked vertically with gaps and padding
      // 50 * 96 + 49 * 32 = 4800 + 1568 = 6368 + 2 * 48 = 6464
      expect(layout.height).toBe(6464)
    })

    it('layouts 100 independent nodes in Wave 0 deterministically sorted', () => {
      const count = 100
      const nodes: DagNodeDefinition[] = Array.from({ length: count }, (_, i) => ({
        id: `node_${String(count - 1 - i).padStart(3, '0')}`, // reverse order
        profileId: 'worker',
        prompt: `Task`
      }))

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, count)

      expect(layout.waves.length).toBe(1)
      // Sorted alphabetically
      expect(layout.waves[0][0]).toBe('node_000')
      expect(layout.waves[0][count - 1]).toBe(`node_${String(count - 1).padStart(3, '0')}`)
    })
  })

  describe('4. Complex Dense Graphs, Diamonds and Skip Connections', () => {
    it('resolves multi-tiered diamond pipeline with skip connections across waves', () => {
      // Topology:
      // Root (Wave 0)
      // BranchA1, BranchA2, BranchA3 (Wave 1)
      // JoinB (Wave 2, depends on A1, A2, A3)
      // BranchC1, BranchC2 (Wave 3, depends on JoinB)
      // Sink (Wave 4, depends on C1, C2 AND Root as skip-connection)
      const nodes: DagNodeDefinition[] = [
        { id: 'Root', profileId: 'planner', prompt: 'start' },
        { id: 'BranchA1', profileId: 'worker', prompt: 'a1', dependencies: ['Root'] },
        { id: 'BranchA2', profileId: 'worker', prompt: 'a2', dependencies: ['Root'] },
        { id: 'BranchA3', profileId: 'worker', prompt: 'a3', dependencies: ['Root'] },
        { id: 'JoinB', profileId: 'merger', prompt: 'b', dependencies: ['BranchA1', 'BranchA2', 'BranchA3'] },
        { id: 'BranchC1', profileId: 'worker', prompt: 'c1', dependencies: ['JoinB'] },
        { id: 'BranchC2', profileId: 'worker', prompt: 'c2', dependencies: ['JoinB'] },
        { id: 'Sink', profileId: 'final', prompt: 'sink', dependencies: ['BranchC1', 'BranchC2', 'Root'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 8)

      expect(layout.waves.length).toBe(5)
      expect(layout.waves[0]).toEqual(['Root'])
      expect(layout.waves[1]).toEqual(['BranchA1', 'BranchA2', 'BranchA3'])
      expect(layout.waves[2]).toEqual(['JoinB'])
      expect(layout.waves[3]).toEqual(['BranchC1', 'BranchC2'])
      expect(layout.waves[4]).toEqual(['Sink'])

      // Skip connection: Root -> Sink (from Wave 0 to Wave 4)
      const skipEdge = layout.edges.find((e) => e.fromId === 'Root' && e.toId === 'Sink')
      expect(skipEdge).toBeDefined()
      const rootNode = layout.nodes.find((n) => n.id === 'Root')!
      const sinkNode = layout.nodes.find((n) => n.id === 'Sink')!
      expect(sinkNode.x).toBeGreaterThan(rootNode.x + 3 * (rootNode.width + 96))
    })

    it('layouts a dense mesh (4x4 bipartite layers, 48 inter-node edges)', () => {
      // 4 layers of 4 nodes each, fully connected to the next layer (16 + 16 + 16 = 48 edges)
      const nodes: DagNodeDefinition[] = []
      for (let layer = 0; layer < 4; layer++) {
        for (let idx = 0; idx < 4; idx++) {
          const id = `L${layer}_N${idx}`
          const dependencies = layer === 0 ? [] : [0, 1, 2, 3].map((prevIdx) => `L${layer - 1}_N${prevIdx}`)
          nodes.push({ id, profileId: 'mesh', prompt: 'p', dependencies })
        }
      }

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 16)

      expect(layout.waves.length).toBe(4)
      expect(layout.edges.length).toBe(48)
      expect(layout.hasCycle).toBe(false)
    })
  })

  describe('5. Cyclic Topologies (Graceful Fallback & No Infinite Loops)', () => {
    it('detects a direct 2-node cycle without hanging or generating NaN coordinates', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'C1', profileId: 'p', prompt: 'c1', dependencies: ['C2'] },
        { id: 'C2', profileId: 'p', prompt: 'c2', dependencies: ['C1'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 2)

      expect(layout.hasCycle).toBe(true)
      expect(layout.waves.length).toBe(1)
      expect(layout.waves[0]).toEqual(['C1', 'C2'])
      expect(layout.edges.length).toBe(2)
    })

    it('detects a 3-node cycle (A -> B -> C -> A)', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'NodeA', profileId: 'p', prompt: 'a', dependencies: ['NodeC'] },
        { id: 'NodeB', profileId: 'p', prompt: 'b', dependencies: ['NodeA'] },
        { id: 'NodeC', profileId: 'p', prompt: 'c', dependencies: ['NodeB'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 3)

      expect(layout.hasCycle).toBe(true)
      expect(layout.waves.length).toBe(1)
      expect(layout.waves[0]).toEqual(['NodeA', 'NodeB', 'NodeC'])
      expect(layout.edges.length).toBe(3)
    })

    it('detects a self-loop (NodeA -> NodeA) gracefully', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'SelfLoop', profileId: 'p', prompt: 'self', dependencies: ['SelfLoop'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 1)

      expect(layout.hasCycle).toBe(true)
      expect(layout.waves.length).toBe(1)
      expect(layout.waves[0]).toEqual(['SelfLoop'])
      expect(layout.edges.length).toBe(1)
      expect(layout.edges[0].fromId).toBe('SelfLoop')
      expect(layout.edges[0].toId).toBe('SelfLoop')
    })

    it('handles a large 50-node circular cycle (C0 -> C1 -> ... -> C49 -> C0)', () => {
      const count = 50
      const nodes: DagNodeDefinition[] = Array.from({ length: count }, (_, i) => ({
        id: `ring_${String(i).padStart(2, '0')}`,
        profileId: 'ring',
        prompt: `Ring step ${i}`,
        dependencies: [`ring_${String((i + count - 1) % count).padStart(2, '0')}`]
      }))

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, count)

      expect(layout.hasCycle).toBe(true)
      expect(layout.waves.length).toBe(1)
      expect(layout.waves[0].length).toBe(count)
      expect(layout.edges.length).toBe(count)
    })

    it('preserves valid DAG prefix while placing entangled cycle and downstream in fallback wave', () => {
      // Topology:
      // ValidRoot -> ValidMid -> CycleA -> CycleB -> CycleA
      // CycleB -> DownstreamLeaf
      const nodes: DagNodeDefinition[] = [
        { id: 'ValidRoot', profileId: 'p', prompt: 'root' },
        { id: 'ValidMid', profileId: 'p', prompt: 'mid', dependencies: ['ValidRoot'] },
        { id: 'CycleA', profileId: 'p', prompt: 'ca', dependencies: ['ValidMid', 'CycleB'] },
        { id: 'CycleB', profileId: 'p', prompt: 'cb', dependencies: ['CycleA'] },
        { id: 'DownstreamLeaf', profileId: 'p', prompt: 'leaf', dependencies: ['CycleB'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 5)

      expect(layout.hasCycle).toBe(true)
      // Valid nodes are in waves 0 and 1
      expect(layout.waves[0]).toEqual(['ValidRoot'])
      expect(layout.waves[1]).toEqual(['ValidMid'])
      // Unresolved nodes (cycle + downstream) placed in fallback wave 2
      expect(layout.waves[2]).toEqual(['CycleA', 'CycleB', 'DownstreamLeaf'])
    })
  })

  describe('6. Disconnected Subgraphs and Island Topologies', () => {
    it('layouts 10 completely disconnected island nodes into wave 0', () => {
      const nodes: DagNodeDefinition[] = Array.from({ length: 10 }, (_, i) => ({
        id: `island_${i}`,
        profileId: 'solo',
        prompt: `Island ${i}`
      }))

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 10)

      expect(layout.waves.length).toBe(1)
      expect(layout.edges.length).toBe(0)
      expect(layout.hasCycle).toBe(false)
    })

    it('layouts 5 independent parallel pipelines of varying lengths without collisions', () => {
      // Subgraph 1: A1 -> A2 -> A3 (3 waves)
      // Subgraph 2: B1 -> B2 (2 waves)
      // Subgraph 3: C1 (1 wave)
      // Subgraph 4: D1 -> D2 -> D3 -> D4 (4 waves)
      // Subgraph 5: E1 -> (E2a, E2b) -> E3 (diamond: 3 waves)
      const nodes: DagNodeDefinition[] = [
        // A
        { id: 'A1', profileId: 'p', prompt: 'a1' },
        { id: 'A2', profileId: 'p', prompt: 'a2', dependencies: ['A1'] },
        { id: 'A3', profileId: 'p', prompt: 'a3', dependencies: ['A2'] },
        // B
        { id: 'B1', profileId: 'p', prompt: 'b1' },
        { id: 'B2', profileId: 'p', prompt: 'b2', dependencies: ['B1'] },
        // C
        { id: 'C1', profileId: 'p', prompt: 'c1' },
        // D
        { id: 'D1', profileId: 'p', prompt: 'd1' },
        { id: 'D2', profileId: 'p', prompt: 'd2', dependencies: ['D1'] },
        { id: 'D3', profileId: 'p', prompt: 'd3', dependencies: ['D2'] },
        { id: 'D4', profileId: 'p', prompt: 'd4', dependencies: ['D3'] },
        // E
        { id: 'E1', profileId: 'p', prompt: 'e1' },
        { id: 'E2a', profileId: 'p', prompt: 'e2a', dependencies: ['E1'] },
        { id: 'E2b', profileId: 'p', prompt: 'e2b', dependencies: ['E1'] },
        { id: 'E3', profileId: 'p', prompt: 'e3', dependencies: ['E2a', 'E2b'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, nodes.length)

      expect(layout.waves.length).toBe(4) // Max depth is 4 (D1..D4)
      expect(layout.hasCycle).toBe(false)

      // Wave 0 contains all 5 roots: A1, B1, C1, D1, E1
      expect(layout.waves[0]).toEqual(['A1', 'B1', 'C1', 'D1', 'E1'])
    })

    it('handles mixture of a valid disconnected DAG and an independent cyclic component', () => {
      // Subgraph 1: DAG (Valid_1 -> Valid_2)
      // Subgraph 2: Cycle (Deadlock_A <-> Deadlock_B)
      const nodes: DagNodeDefinition[] = [
        { id: 'Valid_1', profileId: 'p', prompt: 'v1' },
        { id: 'Valid_2', profileId: 'p', prompt: 'v2', dependencies: ['Valid_1'] },
        { id: 'Deadlock_A', profileId: 'p', prompt: 'da', dependencies: ['Deadlock_B'] },
        { id: 'Deadlock_B', profileId: 'p', prompt: 'db', dependencies: ['Deadlock_A'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 4)

      expect(layout.hasCycle).toBe(true)
      expect(layout.waves[0]).toEqual(['Valid_1'])
      expect(layout.waves[1]).toEqual(['Valid_2'])
      expect(layout.waves[2]).toEqual(['Deadlock_A', 'Deadlock_B'])
    })
  })

  describe('7. Edge Cases & Boundary Conditions', () => {
    it('safely ignores nonexistent dependency IDs without creating orphan edges', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'RealNode', profileId: 'p', prompt: 'real', dependencies: ['GhostNode_1', 'GhostNode_2'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 1)

      expect(layout.waves[0]).toEqual(['RealNode'])
      expect(layout.edges.length).toBe(0)
      expect(layout.hasCycle).toBe(false)
    })

    it('handles nodes with missing optional fields (name, role, undefined dependencies)', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'BareNode', profileId: 'p', prompt: 'bare' }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 1)

      const node = layout.nodes[0]
      expect(node.name).toBe('BareNode')
      expect(node.dependencies).toEqual([])
    })

    it('tolerates duplicate entries in dependencies list', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'parent', profileId: 'p', prompt: 'p' },
        { id: 'child', profileId: 'p', prompt: 'c', dependencies: ['parent', 'parent'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 2)

      expect(layout.waves.length).toBe(2)
      expect(layout.hasCycle).toBe(false)
    })

    it('respects custom layout geometry options', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'custom1', profileId: 'p', prompt: 'c1' },
        { id: 'custom2', profileId: 'p', prompt: 'c2', dependencies: ['custom1'] }
      ]

      const options = {
        nodeWidth: 320,
        nodeHeight: 120,
        horizontalGap: 160,
        verticalGap: 40,
        padding: 60
      }

      const layout = computeDagLayout(nodes, options)
      assertLayoutInvariants(layout, 2)

      const n1 = layout.nodes.find((n) => n.id === 'custom1')!
      const n2 = layout.nodes.find((n) => n.id === 'custom2')!

      expect(n1.width).toBe(320)
      expect(n1.height).toBe(120)
      expect(n1.x).toBe(60)
      expect(n2.x).toBe(60 + 320 + 160) // 540
      expect(layout.width).toBe(2 * 60 + 2 * 320 + 160) // 920
      expect(layout.height).toBe(2 * 60 + 120) // 240
    })

    it('handles special characters and unicode in node IDs and names', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'node:🔥:root', name: 'Root 🚀 <Special> & "Quotes"', profileId: 'p', prompt: 'root' },
        { id: 'node:🎯:child', name: "Child 'Single' & `Ticks`", profileId: 'p', prompt: 'c', dependencies: ['node:🔥:root'] }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, 2)

      expect(layout.nodes[0].name).toBe('Root 🚀 <Special> & "Quotes"')
      expect(layout.nodes[1].name).toBe("Child 'Single' & `Ticks`")
      expect(layout.edges.length).toBe(1)
      expect(layout.edges[0].fromId).toBe('node:🔥:root')
      expect(layout.edges[0].toId).toBe('node:🎯:child')
    })
  })

  describe('8. Extreme Scale and Bottleneck Topologies', () => {
    it('handles extreme 1-to-50 fan-out and 50-to-1 fan-in bottleneck (52 nodes, 100 edges)', () => {
      const workerCount = 50
      const nodes: DagNodeDefinition[] = [
        { id: 'Root', profileId: 'planner', prompt: 'start' },
        ...Array.from({ length: workerCount }, (_, i) => ({
          id: `Worker_${String(i).padStart(2, '0')}`,
          profileId: 'worker',
          prompt: `task ${i}`,
          dependencies: ['Root']
        })),
        {
          id: 'Aggregator',
          profileId: 'merger',
          prompt: 'combine',
          dependencies: Array.from({ length: workerCount }, (_, i) => `Worker_${String(i).padStart(2, '0')}`)
        }
      ]

      const layout = computeDagLayout(nodes)
      assertLayoutInvariants(layout, workerCount + 2)

      expect(layout.waves.length).toBe(3)
      expect(layout.waves[0]).toEqual(['Root'])
      expect(layout.waves[1].length).toBe(workerCount)
      expect(layout.waves[2]).toEqual(['Aggregator'])
      expect(layout.edges.length).toBe(workerCount * 2) // 100 edges

      // Vertical centering verification:
      // Root and Aggregator should be centered relative to the tall worker column
      const rootNode = layout.nodes.find((n) => n.id === 'Root')!
      const aggNode = layout.nodes.find((n) => n.id === 'Aggregator')!
      expect(rootNode.y).toBe(aggNode.y)
      expect(rootNode.y).toBeGreaterThan(layout.nodes.find((n) => n.id === 'Worker_00')!.y)
      expect(rootNode.y).toBeLessThan(layout.nodes.find((n) => n.id === 'Worker_49')!.y)
    })

    it('scales to 500 nodes in sub-100ms without memory pressure', () => {
      const count = 500
      // 5 waves of 100 nodes each
      const nodes: DagNodeDefinition[] = []
      for (let wave = 0; wave < 5; wave++) {
        for (let idx = 0; idx < 100; idx++) {
          const id = `W${wave}_N${String(idx).padStart(3, '0')}`
          const dependencies = wave === 0 ? [] : [`W${wave - 1}_N${String(idx).padStart(3, '0')}`]
          nodes.push({ id, profileId: 'p', prompt: 'test', dependencies })
        }
      }

      const start = performance.now()
      const layout = computeDagLayout(nodes)
      const duration = performance.now() - start

      assertLayoutInvariants(layout, count)
      expect(layout.waves.length).toBe(5)
      expect(layout.edges.length).toBe(400)
      expect(duration).toBeLessThan(150)
    })
  })
})
