/**
 * The single `AppState` shape, plus the plumbing types every slice creator uses.
 *
 * `AppState` is the one source of truth for the store's surface. Each slice declares
 * what it owns as a `Pick<AppState, …>`, so a slice can never drift from the contract:
 * changing a signature here is the only way to change it anywhere.
 */

import type { Theme, RoutingMode } from '../prefs'
import type { ViewMode } from '../viewMode'
import type { CompareRun } from '../compare'
import type {
  AppSettings,
  MessageWithParts,
  OcEvent,
  Permission,
  PermissionResponse,
  Provider,
  ServerStatus,
  Session,
  Todo,
  Agent,
  ServerCommand,
  ProjectRecord,
  PromptPart,
  UpdateStatus,
  FileNode,
  FileContent,
  FileDiff,
  GitStatus,
  GitBranch,
  TermId,
  NanoUsage,
  NanoBalance,
  WeeklyTokenData,
  AgentProfile,
  RunStatus,
  HarnessToolDefinition,
  HarnessEventPayload,
  DagNodeState,
  DagNodeOutput,
  DagEvent,
  DagRunSummary,
  WorkflowDefinition,
  WorkflowSummary
} from '../types'

export interface AppState {
  // connection
  server: ServerStatus
  // project
  directory: string | null
  // sessions
  sessions: Session[]
  activeSessionID: string | null
  // messages for the active session, ordered oldest -> newest
  messages: MessageWithParts[]
  busy: boolean
  // model
  providers: Provider[]
  defaultModels: Record<string, string>
  /** Main-process verified only; never inferred from OpenCode's provider metadata. */
  linkedProviderIDs: string[]
  providerID: string | null
  modelID: string | null
  /** User's pinned choice — mutated only by setModel. Never overwritten by failover. */
  pinnedProviderID: string | null
  pinnedModelID: string | null
  modelPool: string[] | null
  /**
   * The ONLY source of truth for routing behaviour. The legacy `autoRotate`/`stickyModel`
   * booleans are gone from state: they were a second, divergent source that no gate ever
   * read, so the UI could advertise auto-routing while `locked` silently suppressed it.
   * They survive on disk only as derived keys written by `savePrefs` for downgrade safety.
   * Auto model-switching is active iff `routingMode !== 'locked'`.
   */
  routingMode: RoutingMode
  showPaidModels: boolean
  // permissions awaiting user answer, oldest first
  permissions: Permission[]
  // last error banner text, null when clear
  error: string | null

  todos: Todo[]
  branch: string | null
  queuedPrompts: Array<{ text: string, parts?: PromptPart[] }>
  serverCommands: ServerCommand[]
  projects: ProjectRecord[]
  activeView: 'chats' | 'projects' | 'images' | 'harness' | 'dag'
  appSettings: AppSettings
  shortcutRegistered: boolean
  shortcutError: string | null
  updateStatus: UpdateStatus
  theme: Theme
  activeArtifactID: string | null

  /* ---- NanoGPT Subscription Quota & Balance ---- */
  nanoUsage: NanoUsage | null
  nanoBalance: NanoBalance | null
  nanoWeeklyUsage: WeeklyTokenData | null
  showBalanceInStatus: boolean
  /** Resolves true when usage/weekly/balance all came back with usable (non-null) data. */
  fetchNanoQuota(): Promise<boolean>
  setShowBalanceInStatus(show: boolean): void

  /* ---- multi-model fan-out (compare runs) ---- */
  /** The active compare run, or null. While non-null, Chat renders CompareView. */
  compare: CompareRun | null
  /** Persisted `"providerID/modelID"` targets for the next fan-out. */
  compareTargets: string[]
  setCompareTargets(keys: string[]): void
  /**
   * Fan one prompt out to every target as its own read-only session.
   * Never engages the failover machinery — see the note on `applyCompareEvent`.
   */
  sendToMany(text: string, parts?: PromptPart[]): Promise<void>
  abortCompare(): Promise<void>
  /** Adopt a column's session as the active (fully tool-enabled) session and clear the run. */
  promoteCompareColumn(index: number): Promise<void>
  /** Delete every session in the run and clear it. */
  discardCompare(): Promise<void>
  /** Leave the run's sessions in place but stop showing the comparison. */
  clearCompare(): void

  /* ---- subagent viewing tabs (Task-tool child sessions) ---- */
  /** Open child session ids, in open order. The chat shows a tab strip when non-empty. */
  subagentTabs: string[]
  /** The tab being viewed, or null for the main (parent) transcript. */
  activeSubagentTab: string | null
  /** Per-child transcripts, keyed by session id, ordered oldest -> newest. */
  subagentMessages: Record<string, MessageWithParts[]>
  /** Per-child busy flags, driven by session.status / session.idle events. */
  subagentBusy: Record<string, boolean>
  /** Per-child error text (absent key = no error). */
  subagentError: Record<string, string | null>
  /** Open a tab for a child session, view it, and backfill its history once. */
  openSubagentTab(sessionID: string): Promise<void>
  /** Drop a tab and its cached records; viewing it falls back to the main transcript. */
  closeSubagentTab(sessionID: string): void
  /** Switch the viewed tab. Null = main transcript; unknown ids are ignored. */
  setActiveSubagentTab(sessionID: string | null): void
  /** Abort a running child session. */
  stopSubagent(sessionID: string): Promise<void>
  /** Send a follow-up prompt into an open tab's child session (uses the parent's model pick). */
  promptSubagent(sessionID: string, text: string): Promise<void>
  /** `/btw` — open a child session for a tangent question, leaving the main transcript alone. */
  startSideChat(question: string): Promise<void>
  /** Reset everything — runs on session switch and directory change. */
  clearSubagents(): void

  /* ---- agent harness: per-session agent picker + read-only toggle ---- */
  /** The server's agent registry for the active directory (all modes; the picker filters). */
  agents: Agent[]
  /** Per-session chosen agent name; absent key = server default agent. In-memory only. */
  sessionAgents: Record<string, string>
  /** Per-session read-only flag; true sends the READONLY_TOOLS policy on every prompt. */
  sessionReadOnly: Record<string, boolean>
  /** Refetch the agent registry; quiet on failure. Runs on directory change. */
  loadAgents(directory: string): Promise<void>
  /** Pin an agent to a session (null clears back to the server default). */
  setSessionAgent(sessionID: string, agent: string | null): void
  /** Toggle a session's read-only tool policy. */
  setSessionReadOnly(sessionID: string, readOnly: boolean): void

  /* ---- agentic harness: profiles, runs, live event stream ---- */
  /** All agent profiles (built-in + custom), from `oc:harness:profiles:list`. */
  harnessProfiles: AgentProfile[]
  /** Registered harness tools, from `oc:harness:tools:list`. */
  harnessTools: HarnessToolDefinition[]
  /** The run the monitor is following, or null. */
  harnessActiveRunId: string | null
  /** Known runs, newest first. Status updates arrive via `handleHarnessEvent`. */
  harnessRuns: RunStatus[]
  /** Bounded live event log across runs (capped — see harnessSlice). */
  harnessRunEvents: HarnessEventPayload[]
  harnessLoading: boolean
  /** Harness-local error text (the global `error` banner stays chat-scoped). */
  harnessError: string | null
  loadHarnessProfiles(): Promise<void>
  /** Saves via main (validated there) and refreshes the list. False on failure. */
  saveHarnessProfile(profile: unknown): Promise<boolean>
  deleteHarnessProfile(id: string): Promise<void>
  /** Provider connectivity probe; false when unreachable or the call failed. */
  testHarnessProfile(id: string): Promise<boolean>
  loadHarnessTools(): Promise<void>
  /** Starts a run in the active project directory and makes it the monitored one. */
  startHarnessRun(profileId: string, task: string): Promise<void>
  stopHarnessRun(): Promise<void>
  /** The `oc:harness:event` reducer: appends to the log, folds done/error into runs. */
  handleHarnessEvent(payload: HarnessEventPayload): void

  // actions
  init(): Promise<void>
  pickDirectory(): Promise<void>
  setDirectory(dir: string): Promise<void>
  loadProjects(): Promise<void>
  createProject(name: string): Promise<ProjectRecord>
  openProject(project: ProjectRecord): Promise<void>
  setActiveView(view: 'chats' | 'projects' | 'images' | 'harness' | 'dag'): void
  loadAppSettings(): Promise<void>
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>
  setUpdateStatus(status: UpdateStatus): void
  newSession(): Promise<void>
  selectSession(id: string): Promise<void>
  deleteSession(id: string): Promise<void>
  send(text: string, parts?: PromptPart[]): Promise<void>
  abort(): Promise<void>
  setModel(providerID: string, modelID: string): void
  revertToPinned(): void
  /** Toggles auto model-switching: `locked` <-> `failover`. Any non-locked mode toggles off. */
  toggleAutoRotate(): void
  setRoutingMode(mode: RoutingMode): void
  setShowPaidModels(v: boolean): void
  setModelPool(pool: string[] | null): void
  rotateToNextFreeModel(exclude?: string, excludeProviderID?: string): { providerID: string; modelID: string; providerName: string; modelName: string } | null
  addSystemNotice(text: string): void
  executeSlashCommand(cmdText: string): Promise<void>
  replyPermission(id: string, response: PermissionResponse): Promise<void>
  applyEvent(e: OcEvent): void
  dismissError(): void
  renameSession(id: string, title: string): Promise<void>
  setTheme(t: Theme): void
  queuePrompt(text: string, parts?: PromptPart[]): void
  removeQueued(index: number): void
  /** `override` is a one-shot providerID/modelID for this resend only; omit to reuse the current store selection. */
  retryExchange(messageID: string, override?: { providerID: string; modelID: string }): Promise<void>
  editAndResend(messageID: string, newText: string): Promise<void>
  /** Restore a reverted session (unrevert), then reload its transcript. */
  unrevertSession(): Promise<void>
  /** Branch a new, non-destructive session from `messageID` (server-side fork), then switch to it. */
  branchFromMessage(messageID: string): Promise<void>
  setActiveArtifactID(id: string | null): void

  /* ---- Phase 1 code surface: fs / editor / git / terminal / panel UI ---- */

  // fileTree slice
  treeRoot: FileNode[]
  treeExpanded: Set<string>
  treeLoading: boolean
  loadTree(path?: string): Promise<void>
  toggleTreeDir(path: string): Promise<void>
  /**
   * Re-fetch the root level plus every currently expanded directory, keeping the
   * expansion state intact. Debounced (~300ms); driven by the `file.edited` SSE
   * event so agent-created/deleted files appear without a manual reload.
   */
  refreshTree(): Promise<void>

  // editor slice
  openFile: FileContent | null
  openFileDirty: boolean
  /**
   * The file's text as last read from or written to disk. `openFileDirty` is
   * this compared against the live buffer — comparing against the previous
   * buffer instead would clear the flag whenever an edit happens to repeat the
   * text before it, while the buffer still differs from disk.
   */
  openFileBaseText: string | null
  openFileDiff: FileDiff | null
  acceptedHunkIds: string[]
  openPath(path: string, line?: number): Promise<void>
  /** Buffer an editor change. Does not touch disk; sets `openFileDirty`. */
  setOpenFileText(text: string): void
  /** Persist the buffer. Throws on a `baseSha` conflict rather than clobbering. */
  saveOpenFile(): Promise<void>
  toggleHunk(id: string): void
  applyAcceptedHunks(): Promise<void>
  closeFile(): void

  // git slice
  gitStatus: GitStatus | null
  gitBranches: GitBranch[]
  /**
   * The directory a git status fetch has actually completed for, or null before the
   * first one lands. Disambiguates `gitStatus === null`: still loading (this !==
   * directory) vs. the folder is not a git repository (this === directory).
   */
  gitStatusFor: string | null
  refreshGit(): Promise<void>
  stagePaths(paths: string[]): Promise<void>
  unstagePaths(paths: string[]): Promise<void>
  /** Switches branch, then closes the open file and reloads the tree — both are stale after a checkout. */
  checkoutBranch(branch: string, create?: boolean): Promise<void>
  stageHunks(path: string, hunkIds: string[]): Promise<void>
  commit(message: string): Promise<void>
  generateCommitMessage(): Promise<string>
  /**
   * Diffs for every changed path in `gitStatus.entries`, keyed by path — backs the
   * multi-file "Changes" review surface (ChangesPanel). Unlike `openFileDiff` (one
   * file, editor slice), this fetches every changed file's diff up front so the
   * whole working tree can be reviewed as one scrollable surface.
   */
  changedDiffs: Record<string, FileDiff>
  changedDiffsLoading: boolean
  /** Re-fetches `changedDiffs` from the current `gitStatus`. No-ops without a directory or status. */
  loadChangedDiffs(): Promise<void>

  // terminal slice
  terminals: Array<{ id: TermId; title: string }>
  activeTermID: TermId | null
  startTerminal(): Promise<void>
  /** Selects a tab. Ignores ids that are not live terminals. */
  setActiveTermID(id: TermId | null): void
  killTerminal(id: TermId): Promise<void>

  // ui slice — panel additions
  panelTab: 'files' | 'editor' | 'git' | 'terminal' | 'artifacts' | 'changes' | 'harness' | 'dag' | null
  setPanelTab(tab: AppState['panelTab']): void
  paletteOpen: boolean
  setPaletteOpen(open: boolean): void
  /** Transcript density: Normal / Verbose / Summary. Persisted in prefs. */
  viewMode: ViewMode
  setViewMode(mode: ViewMode): void

  /* ---- Multi-Agent DAG Orchestration ---- */
  dagWorkflows: WorkflowSummary[]
  dagActiveWorkflowId: string | null
  dagActiveWorkflow: WorkflowDefinition | null
  dagActiveRunId: string | null
  dagSelectedNodeId: string | null
  dagRuns: DagRunSummary[]
  dagNodeStates: Record<string, DagNodeState>
  dagNodeOutputs: Record<string, DagNodeOutput>
  dagNodeStreams: Record<string, { text: string; thinking: string }>
  dagLoading: boolean
  dagError: string | null

  loadWorkflows(): Promise<void>
  loadRuns(): Promise<void>
  selectWorkflow(workflowId: string): Promise<void>
  startWorkflow(workflow?: WorkflowDefinition): Promise<void>
  cancelWorkflow(runId?: string): Promise<void>
  selectNode(nodeId: string | null): void
  handleDagEvent(event: DagEvent): void
}

/**
 * The zustand `set` handed to every slice.
 *
 * It is the WHOLE-store setter, not a per-slice one: a slice may legitimately write keys
 * another slice owns (deleting a session clears `permissions`, for example). Keeping one
 * setter is what stops cross-cutting writes from tearing.
 */
export type SetState = {
  (partial: Partial<AppState>): void
  (updater: (state: AppState) => Partial<AppState>): void
}

export type GetState = () => AppState

/** A slice is a plain factory over the shared `set` / `get`. */
export type SliceCreator<T> = (set: SetState, get: GetState) => T
