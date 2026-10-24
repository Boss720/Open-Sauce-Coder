import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { JSX, MouseEvent as ReactMouseEvent } from 'react'
import { useStore } from '../lib/store'
import { computeDagLayout, type DagGraphLayout } from '../lib/dagLayout'
import type { DagNodeDefinition, WorkflowDefinition } from '../lib/types'
import './DagPanel.css'

interface DagPanelProps {
  compact?: boolean
}

type InspectorTab = 'stream' | 'prompt' | 'artifacts'

export function DagPanel({ compact = false }: DagPanelProps): JSX.Element {
  const markerNs = `dag-arrow-${useId().replace(/:/g, '')}`
  const directory = useStore((s) => s.directory)
  const workflows = useStore((s) => s.dagWorkflows ?? [])
  const activeWorkflowId = useStore((s) => s.dagActiveWorkflowId)
  const activeWorkflowFromStore = useStore((s) => s.dagActiveWorkflow)
  const activeRunId = useStore((s) => s.dagActiveRunId)
  const dagRuns = useStore((s) => s.dagRuns ?? [])
  const nodeStates = useStore((s) => s.dagNodeStates ?? {})
  const loading = useStore((s) => s.dagLoading ?? false)
  const error = useStore((s) => s.dagError)

  const loadWorkflows = useStore((s) => s.loadWorkflows)
  const loadRuns = useStore((s) => s.loadRuns)
  const selectWorkflow = useStore((s) => s.selectWorkflow)
  const startWorkflow = useStore((s) => s.startWorkflow)
  const cancelWorkflow = useStore((s) => s.cancelWorkflow)
  const selectNode = useStore((s) => s.selectNode)
  const selectedNodeId = useStore((s) => s.dagSelectedNodeId)

  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 40, y: 40 })
  const [zoom, setZoom] = useState<number>(1.0)
  const [isDragging, setIsDragging] = useState(false)
  const [dragOrigin, setDragOrigin] = useState({ startX: 0, startY: 0, panX: 0, panY: 0 })

  const viewportRef = useRef<HTMLDivElement | null>(null)

  // Load available workflows on mount or directory change
  useEffect(() => {
    void loadWorkflows()
    void loadRuns()
  }, [loadWorkflows, loadRuns, directory])

  // Select first workflow if none active and workflows exist
  useEffect(() => {
    if (!activeWorkflowId && workflows.length > 0) {
      void selectWorkflow(workflows[0].id)
    }
  }, [activeWorkflowId, workflows, selectWorkflow])

  // Active workflow object (prefer full loaded definition from store)
  const activeWorkflow = useMemo<WorkflowDefinition | null>(() => {
    if (activeWorkflowFromStore && activeWorkflowFromStore.id === activeWorkflowId) {
      return activeWorkflowFromStore
    }
    return null
  }, [activeWorkflowFromStore, activeWorkflowId])

  // Compute layout
  const layout = useMemo<DagGraphLayout | null>(() => {
    if (!activeWorkflow || !activeWorkflow.nodes || activeWorkflow.nodes.length === 0) {
      return null
    }
    return computeDagLayout(activeWorkflow, {
      nodeWidth: compact ? 200 : 240,
      nodeHeight: compact ? 84 : 96,
      horizontalGap: compact ? 64 : 96,
      verticalGap: compact ? 24 : 32,
      padding: 40
    })
  }, [activeWorkflow, compact])

  // Active run state
  const currentRun = activeRunId ? dagRuns.find((r) => r.dagRunId === activeRunId) : null
  const isRunning = currentRun?.status === 'running'

  // Fit to view
  const handleFitView = useCallback(() => {
    if (!viewportRef.current || !layout || layout.width === 0 || layout.height === 0) return
    const vpW = viewportRef.current.clientWidth
    const vpH = viewportRef.current.clientHeight
    const pad = 48
    const scaleX = (vpW - pad * 2) / layout.width
    const scaleY = (vpH - pad * 2) / layout.height
    const fitZoom = Math.min(1.2, Math.max(0.3, Math.min(scaleX, scaleY)))
    const fitPanX = Math.max(20, (vpW - layout.width * fitZoom) / 2)
    const fitPanY = Math.max(20, (vpH - layout.height * fitZoom) / 2)
    setZoom(fitZoom)
    setPan({ x: fitPanX, y: fitPanY })
  }, [layout])

  // Auto-fit on workflow change
  useEffect(() => {
    handleFitView()
  }, [handleFitView])

  // Pan controls
  const handleMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0) return // Left click only
    setIsDragging(true)
    setDragOrigin({
      startX: e.clientX,
      startY: e.clientY,
      panX: pan.x,
      panY: pan.y
    })
  }

  const handleMouseMove = (e: ReactMouseEvent) => {
    if (!isDragging) return
    const dx = e.clientX - dragOrigin.startX
    const dy = e.clientY - dragOrigin.startY
    setPan({
      x: dragOrigin.panX + dx,
      y: dragOrigin.panY + dy
    })
  }

  const handleMouseUp = () => {
    setIsDragging(false)
  }

  // Wheel zoom/pan. Attached natively (non-passive) so preventDefault works;
  // React's onWheel is passive and would ignore it. Reads the latest view via
  // a ref so the listener is bound once.
  const viewRef = useRef({ pan, zoom })
  useEffect(() => {
    viewRef.current = { pan, zoom }
  }, [pan, zoom])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const { pan: curPan, zoom: curZoom } = viewRef.current
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const factor = e.deltaY < 0 ? 1.1 : 0.9
        const newZoom = Math.min(2.0, Math.max(0.3, curZoom * factor))
        const rect = el.getBoundingClientRect()
        const mouseX = e.clientX - rect.left
        const mouseY = e.clientY - rect.top
        setZoom(newZoom)
        setPan({
          x: mouseX - (mouseX - curPan.x) * (newZoom / curZoom),
          y: mouseY - (mouseY - curPan.y) * (newZoom / curZoom)
        })
      } else {
        setPan((prev) => ({ x: prev.x - e.deltaX, y: prev.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [layout])

  // Zoom button handlers
  const handleZoomDelta = (factor: number) => {
    setZoom((z) => Math.min(2.0, Math.max(0.3, z * factor)))
  }

  const handleResetZoom = () => {
    setZoom(1.0)
  }

  // Selected node details
  const selectedNode = useMemo<DagNodeDefinition | null>(() => {
    if (!selectedNodeId || !activeWorkflow) return null
    return activeWorkflow.nodes.find((n) => n.id === selectedNodeId) ?? null
  }, [selectedNodeId, activeWorkflow])


  return (
    <div className={`dag ${compact ? 'dag--compact' : ''}`}>
      {/* Header Toolbar */}
      <header className="dag__toolbar">
        <div className="dag__toolbar-left">
          <h1 className="dag__title">Workflows</h1>
          <select
            className="dag__select"
            value={activeWorkflowId ?? ''}
            onChange={(e) => void selectWorkflow(e.target.value)}
            disabled={workflows.length === 0}
            aria-label="Select workflow"
          >
            {workflows.length === 0 ? (
              <option value="">No workflows found</option>
            ) : (
              workflows.map((wf) => (
                <option key={wf.id} value={wf.id}>
                  {wf.name} ({wf.nodeCount} nodes)
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            className="dag__btn dag__btn--icon"
            onClick={() => {
              void loadWorkflows()
              void loadRuns()
            }}
            title="Reload workflows from .opencode/workflows/"
          >
            ↻
          </button>
        </div>

        <div className="dag__toolbar-center">
          {currentRun && (
            <div className="dag__run-meta">
              <span className={`dag__badge dag__badge--${currentRun.status}`}>
                {currentRun.status}
              </span>
              <span className="dag__run-id">{currentRun.dagRunId.slice(0, 12)}…</span>
            </div>
          )}
        </div>

        <div className="dag__toolbar-right">
          <div className="dag__zoom-controls">
            <button
              type="button"
              className="dag__btn dag__btn--sm"
              onClick={() => handleZoomDelta(0.85)}
              title="Zoom out"
            >
              -
            </button>
            <button
              type="button"
              className="dag__btn dag__btn--sm"
              onClick={handleResetZoom}
              title="Reset zoom to 100%"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="dag__btn dag__btn--sm"
              onClick={() => handleZoomDelta(1.15)}
              title="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              className="dag__btn dag__btn--sm"
              onClick={handleFitView}
              title="Fit workflow to view"
            >
              Fit
            </button>
          </div>

          {isRunning ? (
            <button
              type="button"
              className="dag__btn dag__btn--danger"
              onClick={() => activeRunId && void cancelWorkflow(activeRunId)}
            >
              Cancel Run
            </button>
          ) : (
            <button
              type="button"
              className="dag__btn dag__btn--primary"
              disabled={!activeWorkflow || loading || layout?.hasCycle}
              onClick={() => activeWorkflow && void startWorkflow(activeWorkflow)}
            >
              Run Workflow
            </button>
          )}
        </div>
      </header>

      {/* Global Error or Cycle Banner */}
      {error && <div className="dag__banner dag__banner--error">{error}</div>}
      {layout?.hasCycle && (
        <div className="dag__banner dag__banner--error">
          ⚠️ Cyclic dependency detected! Workflow cannot be executed.
        </div>
      )}

      {/* Main Body: Canvas + Drawer */}
      <div className="dag__body">
        {/* Canvas Viewport */}
        <div
          ref={viewportRef}
          className={`dag__viewport ${isDragging ? 'dag__viewport--dragging' : ''}`}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {layout ? (
            <div
              className="dag__canvas"
              style={{
                width: `${layout.width}px`,
                height: `${layout.height}px`,
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0'
              }}
            >
              {/* Layer 1: SVG Edge Paths */}
              <svg className="dag__svg" width={layout.width} height={layout.height}>
                <defs>
                  <marker
                    id={markerNs}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--border)" />
                  </marker>
                  <marker
                    id={`${markerNs}--running`}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--accent)" />
                  </marker>
                  <marker
                    id={`${markerNs}--succeeded`}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--ok)" />
                  </marker>
                  <marker
                    id={`${markerNs}--failed`}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--danger)" />
                  </marker>
                </defs>
                {layout.edges.map((edge) => {
                  const fromSt = nodeStates[edge.fromId] ?? 'pending'
                  const toSt = nodeStates[edge.toId] ?? 'pending'
                  const edgeRunning =
                    fromSt === 'running' || (fromSt === 'succeeded' && toSt === 'running')
                  const edgeSucceeded = fromSt === 'succeeded' && toSt === 'succeeded'
                  const edgeFailed = fromSt === 'failed' || toSt === 'failed'

                  let edgeClass = 'dag__edge--pending'
                  let marker = markerNs
                  if (edgeRunning) {
                    edgeClass = 'dag__edge--running'
                    marker = `${markerNs}--running`
                  } else if (edgeSucceeded) {
                    edgeClass = 'dag__edge--succeeded'
                    marker = `${markerNs}--succeeded`
                  } else if (edgeFailed) {
                    edgeClass = 'dag__edge--failed'
                    marker = `${markerNs}--failed`
                  }

                  return (
                    <path
                      key={`${edge.fromId}->${edge.toId}`}
                      d={edge.pathD}
                      className={`dag__edge ${edgeClass}`}
                      markerEnd={`url(#${marker})`}
                    />
                  )
                })}
              </svg>

              {/* Layer 2: HTML Node Cards */}
              <div className="dag__nodes-layer">
                {layout.nodes.map((node) => {
                  const st = nodeStates[node.id] ?? 'pending'
                  const isSelected = node.id === selectedNodeId

                  return (
                    <div
                      key={node.id}
                      className={`dag__node dag__node--${st} ${isSelected ? 'dag__node--selected' : ''}`}
                      style={{
                        left: `${node.x}px`,
                        top: `${node.y}px`,
                        width: `${node.width}px`,
                        height: `${node.height}px`
                      }}
                      onClick={(e) => {
                        e.stopPropagation()
                        selectNode(node.id)
                      }}
                      tabIndex={0}
                      role="button"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          selectNode(node.id)
                        }
                      }}
                    >
                      <div className="dag__node-head">
                        <span className="dag__node-title" title={node.name || node.id}>
                          {node.name || node.id}
                        </span>
                        <span className={`dag__badge dag__badge--${st}`}>{st}</span>
                      </div>
                      <div className="dag__node-meta">
                        <span className="dag__node-profile" title={`Profile: ${node.profile}`}>
                          {node.profile}
                        </span>
                        {st === 'running' && <span className="dag__node-pulse" aria-hidden="true" />}
                      </div>
                      {node.dependencies.length > 0 && (
                        <div className="dag__node-footer">
                          <span className="dag__node-deps">
                            ↳ {node.dependencies.length} dep{node.dependencies.length > 1 ? 's' : ''}
                          </span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="dag__empty">
              <span className="dag__empty-icon">🗺️</span>
              <h2>No Workflow Selected</h2>
              <p>
                Select a workflow from the dropdown above or add definitions in{' '}
                <code>.opencode/workflows/*.json</code> to visualize agent execution graphs.
              </p>
            </div>
          )}
        </div>

        {/* Node Detail Drawer */}
        {selectedNode && <DagDrawer node={selectedNode} onClose={() => selectNode(null)} />}
      </div>
    </div>
  )
}

const INSPECTOR_TABS: ReadonlyArray<{ id: InspectorTab; label: string }> = [
  { id: 'stream', label: 'Stream & Logs' },
  { id: 'prompt', label: 'Prompt & Inputs' },
  { id: 'artifacts', label: 'Artifacts' }
]

interface DagDrawerProps {
  node: DagNodeDefinition
  onClose: () => void
}

/**
 * Node inspector. Owns the only subscription to the selected node's token
 * stream, so per-token updates re-render this drawer and nothing else.
 */
function DagDrawer({ node, onClose }: DagDrawerProps): JSX.Element {
  const uid = useId().replace(/:/g, '')
  const stream = useStore((s) => s.dagNodeStreams?.[node.id])
  const nodeOutput = useStore((s) => s.dagNodeOutputs?.[node.id])
  const nodeStates = useStore((s) => s.dagNodeStates)
  const nodeState = nodeStates?.[node.id] ?? 'pending'
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('stream')
  const [copiedArtifact, setCopiedArtifact] = useState<string | null>(null)
  const streamEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (stream?.text && streamEndRef.current) {
      streamEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [stream?.text])

  const handleCopy = async (text: string, id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedArtifact(id)
      setTimeout(() => setCopiedArtifact(null), 1500)
    } catch {
      // ignore
    }
  }

  return (
    <aside className="dag__drawer">
      <div className="dag__drawer-header">
        <div className="dag__drawer-title-area">
          <h2>{node.name || node.id}</h2>
          <div className="dag__drawer-meta">
            <span className={`dag__badge dag__badge--${nodeState}`}>
              {nodeState}
            </span>
            <span className="dag__drawer-profile">Profile: {node.profileId}</span>
          </div>
        </div>
        <button
          type="button"
          className="dag__drawer-close"
          onClick={onClose}
          title="Close drawer"
        >
          ×
        </button>
      </div>

      {/* Drawer Tabs */}
      <div className="dag__drawer-tabs" role="tablist" aria-label="Node inspector">
  {INSPECTOR_TABS.map((tab) => (
    <button
      key={tab.id}
      type="button"
      role="tab"
      id={`${uid}-tab-${tab.id}`}
      aria-selected={inspectorTab === tab.id}
      aria-controls={`${uid}-panel`}
      className={`dag__drawer-tab ${inspectorTab === tab.id ? 'dag__drawer-tab--active' : ''}`}
      onClick={() => setInspectorTab(tab.id)}
    >
      {tab.label}
    </button>
  ))}
</div>

      {/* Drawer Body */}
      <div
  className="dag__drawer-body"
  role="tabpanel"
  id={`${uid}-panel`}
  aria-labelledby={`${uid}-tab-${inspectorTab}`}
>
        {inspectorTab === 'stream' && (
          <div className="dag__stream-view">
            {stream?.thinking && (
              <details open className="dag__thinking-block">
                <summary>Thinking ({stream.thinking.length} chars)…</summary>
                <pre>{stream.thinking}</pre>
              </details>
            )}
            <div className="dag__text-block">
              <pre>
                {stream?.text ||
                  nodeOutput?.content ||
                  (nodeState === 'running'
                    ? 'Streaming in progress…'
                    : 'No text output.')}
              </pre>
              <div ref={streamEndRef} />
            </div>
            {nodeOutput && (
              <div className="dag__output-summary">
                <div className="dag__summary-item">
                  <span className="dag__summary-label">Finish Reason:</span>
                  <span className="dag__summary-value">
                    {nodeOutput.finishReason || 'n/a'}
                  </span>
                </div>
                <div className="dag__summary-item">
                  <span className="dag__summary-label">Turns:</span>
                  <span className="dag__summary-value">{nodeOutput.turns}</span>
                </div>
                <div className="dag__summary-item">
                  <span className="dag__summary-label">Tokens:</span>
                  <span className="dag__summary-value">
                    {nodeOutput.usage?.input ?? 0} in /{' '}
                    {nodeOutput.usage?.output ?? 0} out
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {inspectorTab === 'prompt' && (
          <div className="dag__prompt-view">
            <div className="dag__field">
              <label>Task Prompt Template</label>
              <pre className="dag__code-well">{node.prompt}</pre>
            </div>

            <div className="dag__field">
              <label>Dependencies ({node.dependencies?.length ?? 0})</label>
              {node.dependencies?.length ? (
                <ul className="dag__deps-list">
                  {node.dependencies.map((depId) => {
                    const depSt = nodeStates[depId] ?? 'pending'
                    return (
                      <li key={depId} className="dag__dep-item">
                        <span className="dag__dep-id">{depId}</span>
                        <span className={`dag__badge dag__badge--${depSt}`}>{depSt}</span>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <span className="dag__muted">None (Root Node)</span>
              )}
            </div>

            {node.policy && (
              <div className="dag__field">
                <label>Execution Policy</label>
                <div className="dag__policy-box">
                  <div>skipOnFail: {String(node.policy.skipOnFail ?? false)}</div>
                  <div>abortOnFail: {String(node.policy.abortOnFail ?? false)}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {inspectorTab === 'artifacts' && (
          <div className="dag__artifacts-view">
            {nodeOutput?.artifacts && nodeOutput.artifacts.length > 0 ? (
              nodeOutput.artifacts.map((art, idx) => (
                <div key={idx} className="dag__artifact-card">
                  <div className="dag__artifact-head">
                    <span className="dag__artifact-name">{art.name}</span>
                    <button
                      type="button"
                      className="dag__btn dag__btn--xs"
                      onClick={() => void handleCopy(art.content, `art-${idx}`)}
                    >
                      {copiedArtifact === `art-${idx}` ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="dag__artifact-content">{art.content}</pre>
                </div>
              ))
            ) : (
              <div className="dag__muted">No artifacts produced by this node.</div>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
