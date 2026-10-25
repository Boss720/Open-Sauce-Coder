import { describe, expect, it } from 'vitest'
import { applyDagWheel, clampDagZoom, DAG_MAX_ZOOM, DAG_MIN_ZOOM, type DagView } from '../dagView'

const base: DagView = { pan: { x: 40, y: -20 }, zoom: 1 }
const wheel = (over: Partial<Parameters<typeof applyDagWheel>[1]> = {}) => ({
  ctrlKey: false,
  metaKey: false,
  deltaX: 0,
  deltaY: 0,
  x: 300,
  y: 200,
  ...over
})

/** Canvas-space coordinate shown under viewport point (x, y). */
const canvasAt = (view: DagView, x: number, y: number) => ({
  x: (x - view.pan.x) / view.zoom,
  y: (y - view.pan.y) / view.zoom
})

describe('applyDagWheel', () => {
  it('pans on a plain wheel without changing zoom', () => {
    const next = applyDagWheel(base, wheel({ deltaX: 15, deltaY: 30 }))
    expect(next).toEqual({ pan: { x: 25, y: -50 }, zoom: 1 })
  })

  it('zooms in on ctrl+wheel up and keeps the point under the pointer fixed', () => {
    const next = applyDagWheel(base, wheel({ ctrlKey: true, deltaY: -100 }))
    expect(next.zoom).toBeCloseTo(1.1)
    const before = canvasAt(base, 300, 200)
    const after = canvasAt(next, 300, 200)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('zooms out on ctrl+wheel down, and meta works like ctrl', () => {
    const next = applyDagWheel(base, wheel({ metaKey: true, deltaY: 100 }))
    expect(next.zoom).toBeCloseTo(0.9)
  })

  it('compounds when several events are applied in a row (trackpad pinch before a render)', () => {
    let view = base
    for (let i = 0; i < 3; i++) view = applyDagWheel(view, wheel({ ctrlKey: true, deltaY: -10 }))
    expect(view.zoom).toBeCloseTo(1.1 ** 3)
    const before = canvasAt(base, 300, 200)
    const after = canvasAt(view, 300, 200)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('clamps zoom and leaves pan unchanged at the limits', () => {
    const atMax: DagView = { pan: { x: 10, y: 10 }, zoom: DAG_MAX_ZOOM }
    expect(applyDagWheel(atMax, wheel({ ctrlKey: true, deltaY: -1 }))).toEqual(atMax)
    const atMin: DagView = { pan: { x: 10, y: 10 }, zoom: DAG_MIN_ZOOM }
    expect(applyDagWheel(atMin, wheel({ ctrlKey: true, deltaY: 1 }))).toEqual(atMin)
  })

  it('ignores ctrl+wheel with no vertical delta', () => {
    expect(applyDagWheel(base, wheel({ ctrlKey: true, deltaX: 50 }))).toBe(base)
  })
})

describe('clampDagZoom', () => {
  it('bounds zoom to the DAG limits', () => {
    expect(clampDagZoom(5)).toBe(DAG_MAX_ZOOM)
    expect(clampDagZoom(0.01)).toBe(DAG_MIN_ZOOM)
    expect(clampDagZoom(1.2)).toBe(1.2)
  })
})
