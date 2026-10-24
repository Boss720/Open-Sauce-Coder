import { describe, expect, it } from 'vitest'
import {
  computeBezierCurve,
  computeDagLayout,
  deriveDagWaves
} from '../dagLayout'
import type { DagNodeDefinition, WorkflowDefinition } from '../types'

describe('dagLayout', () => {
  describe('deriveDagWaves (Kahn topological sort)', () => {
    it('partitions a single independent node into wave 0', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'solo', profileId: 'coder', prompt: 'test' }
      ]
      const { waves, hasCycle } = deriveDagWaves(nodes)
      expect(hasCycle).toBe(false)
      expect(waves).toEqual([['solo']])
    })

    it('partitions a linear pipeline into sequential wave ranks', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'step3', profileId: 'p3', prompt: 'c', dependencies: ['step2'] },
        { id: 'step1', profileId: 'p1', prompt: 'a' },
        { id: 'step2', profileId: 'p2', prompt: 'b', dependencies: ['step1'] }
      ]
      const { waves, hasCycle } = deriveDagWaves(nodes)
      expect(hasCycle).toBe(false)
      expect(waves).toEqual([['step1'], ['step2'], ['step3']])
    })

    it('flattens diamond graph parallel branches into wave 1', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'plan', profileId: 'planner', prompt: 'plan' },
        { id: 'workerB', profileId: 'coder', prompt: 'b', dependencies: ['plan'] },
        { id: 'workerA', profileId: 'coder', prompt: 'a', dependencies: ['plan'] },
        { id: 'review', profileId: 'reviewer', prompt: 'rev', dependencies: ['workerA', 'workerB'] }
      ]
      const { waves, hasCycle } = deriveDagWaves(nodes)
      expect(hasCycle).toBe(false)
      expect(waves.length).toBe(3)
      expect(waves[0]).toEqual(['plan'])
      // Sorted alphabetically within wave
      expect(waves[1]).toEqual(['workerA', 'workerB'])
      expect(waves[2]).toEqual(['review'])
    })

    it('handles multiple disconnected root components in wave 0', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'branchA_root', profileId: 'p1', prompt: 'a' },
        { id: 'branchB_root', profileId: 'p2', prompt: 'b' },
        { id: 'branchA_leaf', profileId: 'p3', prompt: 'c', dependencies: ['branchA_root'] }
      ]
      const { waves, hasCycle } = deriveDagWaves(nodes)
      expect(hasCycle).toBe(false)
      expect(waves[0]).toEqual(['branchA_root', 'branchB_root'])
      expect(waves[1]).toEqual(['branchA_leaf'])
    })

    it('detects direct 2-node cyclic dependencies without infinite looping', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'nodeA', profileId: 'p1', prompt: 'a', dependencies: ['nodeB'] },
        { id: 'nodeB', profileId: 'p2', prompt: 'b', dependencies: ['nodeA'] }
      ]
      const { waves, hasCycle, cycleNodeIds } = deriveDagWaves(nodes)
      expect(hasCycle).toBe(true)
      expect(cycleNodeIds).toEqual(['nodeA', 'nodeB'])
      // Cyclic nodes are captured in fallback wave
      expect(waves[0]).toEqual(['nodeA', 'nodeB'])
    })

    it('detects cycles in graphs with valid entry roots and preserves root execution', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'root', profileId: 'p0', prompt: 'root' },
        { id: 'cycle1', profileId: 'p1', prompt: 'c1', dependencies: ['root', 'cycle2'] },
        { id: 'cycle2', profileId: 'p2', prompt: 'c2', dependencies: ['cycle1'] }
      ]
      const { waves, hasCycle, cycleNodeIds } = deriveDagWaves(nodes)
      expect(hasCycle).toBe(true)
      expect(waves[0]).toEqual(['root'])
      expect(cycleNodeIds).toEqual(['cycle1', 'cycle2'])
      expect(waves[1]).toEqual(['cycle1', 'cycle2'])
    })

    it('ignores unknown dependency IDs and resolves valid nodes', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'validNode', profileId: 'p1', prompt: 'a', dependencies: ['nonExistent'] }
      ]
      const { waves, hasCycle } = deriveDagWaves(nodes)
      expect(hasCycle).toBe(false)
      expect(waves[0]).toEqual(['validNode'])
    })
  })

  describe('computeBezierCurve', () => {
    it('produces valid SVG cubic bezier syntax', () => {
      const path = computeBezierCurve(100, 50, 300, 150)
      expect(path).toMatch(/^M 100 50 C \d+ 50, \d+ 150, 300 150$/)
    })

    it('enforces minimum curvature of 40 for close horizontal anchors', () => {
      const path = computeBezierCurve(100, 50, 120, 50)
      // dx = 20, max(40, 20 * 0.45) = 40 => cx1 = 140, cx2 = 80
      expect(path).toBe('M 100 50 C 140 50, 80 50, 120 50')
    })
  })

  describe('computeDagLayout (Geometry & Centering)', () => {
    it('handles empty workflow gracefully', () => {
      const layout = computeDagLayout([])
      expect(layout.nodes).toEqual([])
      expect(layout.edges).toEqual([])
      expect(layout.width).toBe(96)
      expect(layout.height).toBe(96)
    })

    it('computes monotonic X coordinates and vertically centered Y coordinates', () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-diamond',
        name: 'Diamond Workflow',
        nodes: [
          { id: 'start', profileId: 'p', prompt: 'start' },
          { id: 'branchA', profileId: 'p', prompt: 'a', dependencies: ['start'] },
          { id: 'branchB', profileId: 'p', prompt: 'b', dependencies: ['start'] },
          { id: 'end', profileId: 'p', prompt: 'end', dependencies: ['branchA', 'branchB'] }
        ]
      }

      const layout = computeDagLayout(workflow, {
        nodeWidth: 200,
        nodeHeight: 100,
        horizontalGap: 50,
        verticalGap: 20,
        padding: 40
      })

      const start = layout.nodes.find((n) => n.id === 'start')!
      const branchA = layout.nodes.find((n) => n.id === 'branchA')!
      const branchB = layout.nodes.find((n) => n.id === 'branchB')!
      const end = layout.nodes.find((n) => n.id === 'end')!

      // X coordinates monotonic across waves
      expect(start.x).toBe(40)
      expect(branchA.x).toBe(40 + 200 + 50)
      expect(branchB.x).toBe(branchA.x)
      expect(end.x).toBe(branchA.x + 200 + 50)

      // Column heights:
      // Wave 0 (1 node): 100
      // Wave 1 (2 nodes): 2 * 100 + 20 = 220 (max height)
      // Wave 2 (1 node): 100
      // Vertical centering offset for waves with 1 node: (220 - 100) / 2 = 60
      expect(start.y).toBe(40 + 60)
      expect(end.y).toBe(40 + 60)
      expect(branchA.y).toBe(40 + 0)
      expect(branchB.y).toBe(40 + 100 + 20)

      // Total dimensions
      expect(layout.width).toBe(2 * 40 + 3 * 200 + 2 * 50) // 80 + 600 + 100 = 780
      expect(layout.height).toBe(2 * 40 + 220) // 80 + 220 = 300
    })

    it('generates edges with correct connection anchors', () => {
      const nodes: DagNodeDefinition[] = [
        { id: 'u', profileId: 'p', prompt: 'u' },
        { id: 'v', profileId: 'p', prompt: 'v', dependencies: ['u'] }
      ]

      const layout = computeDagLayout(nodes, { nodeWidth: 100, nodeHeight: 60 })
      expect(layout.edges.length).toBe(1)
      const edge = layout.edges[0]
      expect(edge.fromId).toBe('u')
      expect(edge.toId).toBe('v')

      const uNode = layout.nodes.find((n) => n.id === 'u')!
      const vNode = layout.nodes.find((n) => n.id === 'v')!

      // Curve starts at u right-center: x1 = u.x + 100, y1 = u.y + 30
      // Curve ends at v left-center: x2 = v.x, y2 = v.y + 30
      expect(edge.pathD).toContain(`M ${uNode.x + 100} ${uNode.y + 30}`)
      expect(edge.pathD).toContain(`${vNode.x} ${vNode.y + 30}`)
    })
  })
})
