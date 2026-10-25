/**
 * Pure pan/zoom math for the DAG canvas (DagPanel). Kept out of the component so the wheel
 * behaviour is unit-testable without a DOM.
 */

export interface DagView {
  pan: { x: number; y: number }
  zoom: number
}

export interface DagWheelInput {
  ctrlKey: boolean
  metaKey: boolean
  deltaX: number
  deltaY: number
  /** Pointer position relative to the viewport's top-left corner. */
  x: number
  y: number
}

export const DAG_MIN_ZOOM = 0.3
export const DAG_MAX_ZOOM = 2.0

export function clampDagZoom(zoom: number): number {
  return Math.min(DAG_MAX_ZOOM, Math.max(DAG_MIN_ZOOM, zoom))
}

/**
 * Ctrl/Cmd+wheel zooms 10% per event and keeps the canvas point under the pointer fixed (the
 * canvas is scaled with `transform-origin: 0 0`); a plain wheel pans.
 */
export function applyDagWheel(view: DagView, input: DagWheelInput): DagView {
  if (!(input.ctrlKey || input.metaKey)) {
    return { pan: { x: view.pan.x - input.deltaX, y: view.pan.y - input.deltaY }, zoom: view.zoom }
  }
  if (input.deltaY === 0) return view
  const zoom = clampDagZoom(view.zoom * (input.deltaY < 0 ? 1.1 : 0.9))
  const ratio = zoom / view.zoom
  return {
    pan: {
      x: input.x - (input.x - view.pan.x) * ratio,
      y: input.y - (input.y - view.pan.y) * ratio
    },
    zoom
  }
}
