/**
 * Typing for the preload bridge. Kept structurally identical to CONTRACTS.md and to
 * `src/renderer/src/lib/types.ts` (which owns the renderer-side copies of these shapes).
 */
import type { Agent, Command, Message, Part, Permission, Provider, Session, Todo } from '@opencode-ai/sdk'

export type ServerStatus = {
  running: boolean
  url: string | null
  /** SSE subscription is live. Independent of `running` — see CONTRACTS.md. */
  streamConnected: boolean
  error?: string
}

export type MessageWithParts = {
  info: Message
  parts: Part[]
}

export type PermissionResponse = 'once' | 'always' | 'reject'

export type OcEvent = {
  type: string
  properties: unknown
}

export type ProvidersResult = {
  providers: Provider[]
  default: Record<string, string>
  linkedProviderIDs: string[]
}

export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename: string; url: string }

export type PromptArgs = {
  directory: string
  sessionID: string
  providerID: string
  modelID: string
  text: string
  parts?: PromptPart[]
  /**
   * Per-request tool policy. Compare runs pass `{ write: false, edit: false, … }` so N concurrent
   * columns cannot race on one working tree. Omit for normal chat.
   */
  tools?: Record<string, boolean>
  /** Agent override (e.g. "plan") from the composer picker. Omit for the server default agent. */
  agent?: string
}

export type PermissionReplyArgs = {
  directory: string
  sessionID: string
  permissionID: string
  response: PermissionResponse
}

export type SummarizeArgs = {
  directory: string
  sessionID: string
  providerID: string
  modelID: string
}

export type InitArgs = {
  directory: string
  sessionID: string
  providerID: string
  modelID: string
  messageID: string
}

export type CommandArgs = {
  directory: string
  sessionID: string
  command: string
  arguments: string
}

export type RevertArgs = {
  directory: string
  sessionID: string
  messageID: string
}

export type UnrevertArgs = {
  directory: string
  sessionID: string
}

export type ForkArgs = {
  directory: string
  sessionID: string
  messageID: string
}

/** Project-config permission levels, as validated by `oc:config:permission:set`. */
export type PermissionLevel = 'ask' | 'allow' | 'deny'
export type PermissionConfig = {
  edit?: PermissionLevel
  bash?: PermissionLevel | Record<string, PermissionLevel>
  webfetch?: PermissionLevel
  doom_loop?: PermissionLevel
  external_directory?: PermissionLevel
}

/** Scope for `oc:search:chats`: the active project only, or every known project. */
export type ChatSearchScope = 'project' | 'all'

/** One result row from `oc:search:chats`. Importable by renderer streams. */
export type ChatSearchHit = {
  sessionID: string
  title: string
  messageID: string
  snippet: string
  time: number
  /** Absolute directory of the project the hit came from (always set, incl. `scope: 'project'`). */
  directory: string
}

/** One masked BYOK key row from `oc:keys:list`. Never carries the full key. */
export type KeyRow = {
  providerID: string
  envVar: string
  maskedTail: string | null
}

export type ProjectRecord = {
  id: string
  name: string
  directory: string
  createdAt: number
  updatedAt: number
}

export type KnowledgeFile = { filename: string; size: number; updatedAt: number }

export type McpLocalConfig = {
  type: 'local'
  command: string[]
  environment?: Record<string, string>
  enabled?: boolean
  timeout?: number
}
export type McpRemoteConfig = {
  type: 'remote'
  url: string
  enabled?: boolean
  headers?: Record<string, string>
  oauth?: { clientId?: string; clientSecret?: string; scope?: string } | false
  timeout?: number
}
export type McpConfig = McpLocalConfig | McpRemoteConfig
export type McpStatus =
  | { status: 'connected' | 'disabled' | 'needs_auth' }
  | { status: 'failed' | 'needs_client_registration'; error: string }
export type McpSnapshot = {
  configs: Record<string, McpConfig>
  statuses: Record<string, McpStatus>
}

export type AppSettings = {
  closeToTray: boolean
  globalShortcut: string
  showPaidModels: boolean
  ttftMs: number
  stallMs: number
  /** Refuse NanoGPT image generation on models observed to bill balance. Default true. */
  nanogptSubscriptionOnly: boolean
}
export type AppSettingsResult = {
  settings: AppSettings
  shortcutRegistered: boolean
  shortcutError?: string
}
export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'not-available' | 'downloaded' }
  | { state: 'available'; version: string }
  | { state: 'progress'; percent: number }
  | { state: 'error'; message: string }
export type GeminiLiveInput = {
  audio?: { data: string; mimeType: 'audio/pcm;rate=16000' }
  video?: { data: string; mimeType: 'image/jpeg' }
  text?: string
}
/** Optional session overrides for `oc:live:start`; validated against allowlists/bounds in main. */
export type GeminiLiveConfig = {
  voice?: string
  model?: string
  systemInstruction?: string
}
export type LiveTranscriptMessage = {
  role: 'you' | 'gemini' | 'system'
  text: string
  at?: number
}

/** Bounded snapshot of the main-process crash log, from `oc:crashlog:read`. */
export type CrashLogReport = {
  /** Absolute path to crash.log ('' when the main process has not initialised it yet). */
  path: string
  /** True when crash.log exists (regardless of size). */
  exists: boolean
  /** On-disk size of crash.log in bytes (0 when absent). */
  sizeBytes: number
  /** True when a rotated crash.log.old exists alongside the active log. */
  hasOld: boolean
  /** Entry headers observed in the returned tail — a lower bound once `truncated`. */
  entryCount: number
  /** The most recent bytes of crash.log, capped at 64 KiB (see `truncated`). */
  tail: string
  /** True when the file was larger than the cap and `tail` is only the end of it. */
  truncated: boolean
}
export type GeminiLiveEvent =
  | { type: 'message'; data: unknown }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }
  | { type: 'reconnecting'; attempt: number; maxAttempts: number }

/* --- Leroy sidecar (the gemini-live-agent harness) ------------------------
 * Structurally identical to src/main/leroy/protocol.ts, duplicated rather than
 * imported: preload must not import main (see CONTRACTS.md). Keep in sync. */

export type LeroyConnectionState =
  | 'idle' | 'connecting' | 'live' | 'draining' | 'reconnecting'
  | 'disconnecting' | 'disconnected' | 'error' | 'failed'

export type LeroyEvent =
  | { type: 'ready'; protocol: number; runId: string }
  | { type: 'connection_state_changed'; state: LeroyConnectionState; detail: string }
  | { type: 'partial_transcript'; text: string; source: 'user' | 'model'; turnId: number }
  | { type: 'turn_complete'; source: 'user' | 'model'; text: string; turnId: number }
  | { type: 'tool_call_received'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_approval_requested'; callId: string; name: string; args: Record<string, unknown>; allowText: string }
  | { type: 'tool_result_sent'; callId: string; name: string; ok: boolean; result: string; orphaned: boolean }
  | { type: 'tool_call_cancelled'; callIds: string[]; reason: string }
  | { type: 'session_expiring'; seconds: number | null }
  | { type: 'audio_level'; source: string; level: number }
  | { type: 'session_error'; message: string; fatal: boolean }
  | { type: 'rate_limit_hit'; model: string; tier: string; tpmUsed: number; tpmLimit: number; cooldownSeconds: number }
  | { type: 'context_reset'; reason: string }
  | { type: 'usage_update'; promptTokens: number; cachedTokens: number; completionTokens: number; audioTokens: number; videoTokens: number; totalTokens: number; estimatedUsd: number | null }
  | { type: 'session_ended'; code: string; detail: string }
  | { type: 'fatal'; message: string }
  | { type: 'sidecar_exit'; code: number | null; signal: string | null; stderr: string }
  | { type: 'sidecar_error'; message: string }

export type LeroyCommand =
  | { type: 'disconnect' }
  | { type: 'send_text'; text: string }
  | { type: 'set_mic_gate'; open: boolean }
  | { type: 'set_share_screen'; enabled: boolean; monitor?: number }
  | { type: 'approve_tool'; call_id: string }
  | { type: 'deny_tool'; call_id: string; reason?: string }
  | { type: 'cancel_tool'; call_ids: string[] }
  | { type: 'set_gating_mode'; mode: 'guarded' | 'yolo'; duration_minutes?: number }
  | { type: 'ping' }

export type LeroyStartOptions = {
  /** Overrides the `LEROY_AGENT_DIR` / `~/projects/gemini-live-agent` lookup. */
  agentDir?: string
  /** Partial `AppSettings` for the Python harness (voice, model, working_dir, ...). */
  settings?: Record<string, unknown>
}

/* --- NanoGPT (subscription provider + image sidecar) ---------------------- */

export type NanoChatModel = {
  id: string
  name?: string
  description?: string
  context_length?: number
  max_output_tokens?: number
  capabilities?: { vision?: boolean; tool_calling?: boolean }
}
export type NanoImageModel = {
  id: string
  name?: string
  description?: string
  pricing?: unknown
  supported_parameters?: string[]
  tags?: string[]
}
export type NanogptModelsResult = {
  chat: NanoChatModel[]
  image: NanoImageModel[]
  /** Image model ids observed to bill balance rather than the subscription. */
  balanceBilled: string[]
  fetchedAt: number
}
export type NanogptRefreshResult = {
  chatCount: number
  imageCount: number
  /** True when the chat model set changed — the OpenCode server must restart to see it. */
  restartRequired: boolean
  fetchedAt: number
}
/** Every field is independently optional — NanoGPT's usage endpoint can omit fields per bucket. */
export type NanoUsageBucket = {
  used?: number
  remaining?: number
  percentUsed?: number
  resetAt?: number
}
/**
 * Real buckets are `dailyInputTokens`, `weeklyInputTokens`, `dailyImages` — there is no
 * `monthly` bucket. Each bucket/limit is `| null | undefined`: `null` means "no cap" / "no such
 * quota" (a known fact), `undefined` means unknown/absent. Period end is `period.currentPeriodEnd`.
 */
export type NanoUsage = {
  active: boolean
  limits: {
    dailyInputTokens?: number | null
    weeklyInputTokens?: number | null
    dailyImages?: number | null
  }
  dailyInputTokens?: NanoUsageBucket | null
  weeklyInputTokens?: NanoUsageBucket | null
  dailyImages?: NanoUsageBucket | null
  period?: { currentPeriodEnd?: string }
  state: string
  graceUntil?: string | null
}
export type NanoBalance = {
  /** Parsed from the documented string field `usd_balance`. */
  usd: number
  /** Parsed from the documented string field `nano_balance`. */
  nano: number
  /** Documented as `nanoDepositAddress`. Omitted when absent. */
  depositAddress?: string
}
export type WeeklyTokenData = { weekKey: string; inputTokens: number; outputTokens: number; totalTokens: number }
export type GeneratedImageMeta = {
  id: string
  sessionID: string | null
  prompt: string
  model: string
  size?: string
  paymentSource?: string
  cost?: number
  createdAt: number
  bytes: number
}
export type NanogptGenerateArgs = {
  prompt: string
  model: string
  n?: number
  size?: string
  /** Attach the generation to a chat session so the transcript can be rehydrated. */
  sessionID?: string
  /** Explicit per-call consent to bill the pay-as-you-go balance. Never defaults to true. */
  allowBalance?: boolean
}
export type NanogptGenerateResult = {
  images: Array<{ meta: GeneratedImageMeta; base64: string }>
  billing: 'subscription' | 'balance' | 'unknown'
  paymentSource?: string
  cost?: number
  remainingBalance?: number
  route: 'subscription' | 'standard'
  /** True when this call caused the model to be recorded as balance-billing. */
  blacklisted: boolean
}

/* --- Phase 1 code surface (fs / git / terminal / editor deep-links) -------
 * Deliberately duplicated rather than imported from src/main/fsService.ts / gitService.ts
 * (main must not be imported by preload — see CONTRACTS.md "Phase 1 — Code surface"). Kept
 * structurally identical to the main-process service definitions. */

export type GitFileStatus =
  | 'untracked'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'conflicted'
  | 'ignored'

export type FileNode = {
  name: string
  /** POSIX-separated, ALWAYS relative to the session directory. */
  path: string
  kind: 'file' | 'dir'
  gitStatus: GitFileStatus | null
  /** Edited by the agent during this session. */
  touched: boolean
}

export type FileContent = {
  path: string
  text: string
  bytes: number
  /** True when the file exceeded MAX_READ_BYTES. */
  truncated: boolean
  /** sha256 of the on-disk bytes; the optimistic-concurrency token. */
  sha: string
  /** Monaco language id, inferred from extension. */
  language: string | null
}

export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string }

export type Hunk = {
  /** Stable within one FileDiff: `${oldStart}-${newStart}`. */
  id: string
  /** "@@ -a,b +c,d @@" */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
  /**
   * Set when that side ends without a trailing newline ("\ No newline at end of
   * file"). Load-bearing: without it, applying a file's final hunk silently adds a
   * newline that was never in the source.
   */
  oldNoEofNewline?: boolean
  newNoEofNewline?: boolean
}

export type FileDiff = {
  path: string
  /** Set on renames. */
  oldPath?: string
  /** When true, `hunks` is empty. */
  binary: boolean
  /**
   * True when the diff exceeded the 5000-line cap and hunks were dropped.
   * The UI MUST surface this — a partial diff that looks complete lets the
   * user stage "all hunks" and silently lose everything past the cap.
   */
  truncated: boolean
  hunks: Hunk[]
}

export type GitStatusEntry = {
  path: string
  /** Staged side. */
  index: GitFileStatus | null
  /** Unstaged side. */
  worktree: GitFileStatus | null
  renamedFrom?: string
}

export type GitStatus = {
  branch: string
  upstream: string | null
  ahead: number
  behind: number
  entries: GitStatusEntry[]
  clean: boolean
}

export type GitBranch = { name: string; current: boolean; remote: boolean }

export type TermId = string

/* --- Agentic harness (structurally identical to src/main/harness/*) -------- */

export type AgentProfile = {
  id: string
  name: string
  description?: string
  provider: string
  model: string
  fallbackModels?: string[]
  temperature?: number
  maxTokens?: number
  topP?: number
  thinking?: { enabled: boolean; budget?: number }
  systemPrompt?: string
  systemPromptFile?: string
  /** Tool allowlist; `'*'` as an element means every registered tool. */
  tools?: string[]
  toolDenyList?: string[]
  readOnly?: boolean
  maxConcurrent?: number
  maxTurns?: number
  tokenBudget?: number
  costBudget?: number
  routingSuffix?: string
  billingRoute?: 'subscription' | 'standard'
  caching?: boolean
  /** Built-in profiles are read-only; clone to customise. */
  builtin?: boolean
  createdAt?: number
  updatedAt?: number
}

export type RunnerResult = {
  content: string
  toolCallCount: number
  usage: { input: number; output: number; reasoning?: number }
  turns: number
  finishReason: 'complete' | 'budget_exceeded' | 'max_turns' | 'aborted' | 'error'
  error?: string
}

export type RunnerEvent =
  | { type: 'thinking'; content: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; output: string; error?: string }
  | { type: 'error'; message: string }
  | { type: 'done'; result: RunnerResult }
  | { type: 'budget_warning'; field: string; used: number; limit: number }

export type RunStatus = {
  id: string
  profileId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  turns: number
  usage: { input: number; output: number }
  startedAt: number
  completedAt?: number
  result?: RunnerResult
  error?: string
}

export type HarnessToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  category: 'read' | 'write' | 'shell' | 'web' | 'custom'
}

/** Payload of the `oc:harness:event` channel. */
export type HarnessEventPayload = { runId: string; event: RunnerEvent }

export interface OpencodeApi {
  status(): Promise<ServerStatus>
  restart(): Promise<ServerStatus>
  pickDirectory(): Promise<string | null>
  /** Native multi-select file picker. Returns absolute paths, or [] when canceled. */
  pickFiles(): Promise<string[]>
  sessions: {
    list(directory: string): Promise<Session[]>
    /** parentID creates a child session (subagent tab, side chat) instead of a root one. */
    create(directory: string, title?: string, parentID?: string): Promise<Session>
    remove(directory: string, id: string): Promise<void>
    update(directory: string, id: string, title: string): Promise<Session>
    summarize(a: SummarizeArgs): Promise<boolean>
    init(a: InitArgs): Promise<boolean>
    todos(directory: string, sessionID: string): Promise<Todo[]>
    command(a: CommandArgs): Promise<void>
  }
  commands: {
    list(directory: string): Promise<Command[]>
  }
  find: {
    files(directory: string, query: string): Promise<string[]>
  }
  vcs: {
    get(directory: string): Promise<{ branch: string } | null>
  }
  projects: {
    list(): Promise<ProjectRecord[]>
    create(name: string): Promise<ProjectRecord>
    getInstructions(directory: string): Promise<string>
    setInstructions(directory: string, text: string): Promise<void>
    listKnowledge(directory: string): Promise<KnowledgeFile[]>
    addKnowledge(directory: string, filePaths?: string[]): Promise<KnowledgeFile[]>
    removeKnowledge(directory: string, filename: string): Promise<void>
  }
  mcp: {
    status(directory: string): Promise<McpSnapshot>
    add(a: { directory: string; name: string; config: McpConfig }): Promise<McpSnapshot>
    remove(directory: string, name: string): Promise<McpSnapshot>
    connect(directory: string, name: string): Promise<McpSnapshot>
    disconnect(directory: string, name: string): Promise<McpSnapshot>
    auth(directory: string, name: string): Promise<McpSnapshot>
  }
  quick: {
    submit(text: string): Promise<void>
  }
  liveWindow: {
    open(): Promise<void>
    close(): Promise<void>
    setAlwaysOnTop(on: boolean): Promise<void>
  }
  appSettings: {
    get(): Promise<AppSettingsResult>
    set(patch: Partial<AppSettings>): Promise<AppSettingsResult>
  }
  config: {
    /** The resolved `permission` key of the project config ({} when unset). */
    getPermission(directory: string): Promise<PermissionConfig>
    /**
     * Merges ONLY the permission key into the project config. Resolves true when the
     * direct-file fallback ran and the server is restarting instead of `config.update`.
     */
    setPermission(a: { directory: string; permission: PermissionConfig }): Promise<boolean>
  }
  keys: {
    list(): Promise<KeyRow[]>
    set(a: { providerID: string; key: string }): Promise<void>
    remove(providerID: string): Promise<void>
    test(providerID: string): Promise<{ ok: boolean; status?: number; detail?: string }>
  }
  live: {
    start(config?: GeminiLiveConfig): Promise<void>
    send(input: GeminiLiveInput): void
    stop(): Promise<void>
    onMessage(cb: (event: GeminiLiveEvent) => void): () => void
    /** Saves the transcript as markdown under userData/live-transcripts; resolves to the file path. */
    saveTranscript(a: { messages: LiveTranscriptMessage[] }): Promise<string>
    revealTranscripts(): Promise<void>
  }
  /**
   * The Leroy sidecar: tool calling with approval gating, dual-key tier
   * failover and session resumption, run by the `gemini-live-agent` Python
   * harness. The child owns the microphone, speaker and screen capture, so a
   * window must not also run the `live.*` media pipeline while this is up.
   */
  leroy: {
    start(options?: LeroyStartOptions): Promise<void>
    send(command: LeroyCommand): void
    stop(): Promise<void>
    /** True when a sidecar is running for this window. */
    status(): Promise<boolean>
    onEvent(cb: (event: LeroyEvent) => void): () => void
  }
  crashLog: {
    /** Bounded tail read of the main-process crash log; empty report when no log exists. */
    read(): Promise<CrashLogReport>
    /** Reveals crash.log in the OS file manager. Main builds the path itself. */
    reveal(): Promise<void>
  }
  nanogpt: {
    /** Cached catalogues — no network call. */
    models(): Promise<NanogptModelsResult>
    /** Re-fetch both catalogues from NanoGPT and rewrite the cache. */
    refresh(): Promise<NanogptRefreshResult>
    usage(): Promise<NanoUsage | null>
    balance(): Promise<NanoBalance | null>
    weeklyUsage(): Promise<WeeklyTokenData>
    /** Generate images. Throws when the model is known to bill balance and consent was not given. */
    generate(a: NanogptGenerateArgs): Promise<NanogptGenerateResult>
    images: {
      /** Metadata only — call `read` for the bytes. Omit sessionID for the whole gallery. */
      list(sessionID?: string): Promise<GeneratedImageMeta[]>
      /** Base64 PNG bytes, or null when the file is gone. */
      read(id: string): Promise<string | null>
      remove(id: string): Promise<void>
      today(): Promise<number>
    }
  }
  messages(directory: string, sessionID: string): Promise<MessageWithParts[]>
  revertMessage(a: RevertArgs): Promise<void>
  /** Restores all reverted messages; resolves to the session with `revert` cleared. */
  unrevertMessage(a: UnrevertArgs): Promise<Session>
  /** Branches a new session from `messageID`, leaving the source session untouched. */
  forkSession(a: ForkArgs): Promise<Session>
  /** The server's agent registry for a directory; the picker filters to primary/all modes. */
  agents(directory: string): Promise<Agent[]>
  searchChats(directory: string, query: string, options?: { scope?: ChatSearchScope }): Promise<ChatSearchHit[]>
  prompt(a: PromptArgs): Promise<void>
  abort(directory: string, sessionID: string): Promise<void>
  providers(): Promise<ProvidersResult>
  replyPermission(a: PermissionReplyArgs): Promise<void>
  openExternal(url: string): Promise<void>
  pathForFile(file: File): string
  exportChat(defaultName: string, content: string): Promise<boolean>
  /** `encoding` defaults to 'utf8'; pass 'base64' to write bytes (e.g. a generated PNG). */
  saveFile(a: { defaultName: string; content: string; encoding?: 'utf8' | 'base64' }): Promise<boolean>
  /** Persists a pasted clipboard image (base64 `data`, allowlisted `ext`) and returns its absolute path. */
  saveClipboardImage(a: { data: string; ext: string }): Promise<string>
  fs: {
    tree(directory: string, path?: string, depth?: number): Promise<FileNode[]>
    read(directory: string, path: string): Promise<FileContent>
    write(a: { directory: string; path: string; text: string; baseSha: string }): Promise<{ sha: string }>
  }
  git: {
    status(directory: string): Promise<GitStatus | null>
    diff(a: { directory: string; path: string; staged?: boolean }): Promise<FileDiff>
    stage(directory: string, paths: string[]): Promise<GitStatus | null>
    unstage(directory: string, paths: string[]): Promise<GitStatus | null>
    stageHunks(a: { directory: string; path: string; patch: string }): Promise<GitStatus | null>
    commit(a: { directory: string; message: string; amend?: boolean }): Promise<{ sha: string }>
    branches(directory: string): Promise<GitBranch[]>
    checkout(a: { directory: string; branch: string; create?: boolean }): Promise<GitStatus | null>
    remoteUrl(directory: string): Promise<string | null>
  }
  term: {
    start(a: { directory: string; cols: number; rows: number }): Promise<{ id: TermId }>
    write(id: TermId, data: string): Promise<void>
    resize(id: TermId, cols: number, rows: number): Promise<void>
    kill(id: TermId): Promise<void>
    onData(cb: (e: { id: TermId; data: string }) => void): () => void
    onExit(cb: (e: { id: TermId; code: number }) => void): () => void
  }
  openEditor(a: { directory: string; path: string; line?: number; column?: number }): Promise<void>
  harness: {
    profiles: {
      list(): Promise<AgentProfile[]>
      get(id: string): Promise<AgentProfile | null>
      /** Validated and normalised in main; returns the saved profile. */
      save(profile: unknown): Promise<AgentProfile>
      remove(id: string): Promise<boolean>
      /** Connectivity probe for the profile's provider. */
      test(id: string): Promise<boolean>
    }
    run: {
      /** Starts a run; resolves to its runId. Events stream over `onEvent`. */
      start(params: { profileId: string; task: string; directory: string }): Promise<string>
      stop(runId: string): Promise<void>
      status(runId: string): Promise<RunStatus | null>
      list(): Promise<RunStatus[]>
    }
    tools: {
      list(): Promise<HarnessToolDefinition[]>
    }
    /** Registers a harness-event listener; call the returned function to unsubscribe. */
    onEvent(cb: (payload: HarnessEventPayload) => void): () => void
  }
  /** Registers an SSE listener; call the returned function to unsubscribe. */
  onEvent(cb: (e: OcEvent) => void): () => void
  /** Registers a server-status listener; call the returned function to unsubscribe. */
  onServer(cb: (s: ServerStatus) => void): () => void
  /** Registers a main-menu new-session listener; call the returned function to unsubscribe. */
  onMainMenuNewSession(cb: () => void): () => void
  /** Registers a quick-entry prompt listener; call the returned function to unsubscribe. */
  onQuickEntryPrompt(cb: (text: string) => void): () => void
  /** Registers an updater-status listener; call the returned function to unsubscribe. */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}

export type { Message, Part, Permission, Provider, Session }

declare global {
  interface Window {
    api: OpencodeApi
  }
}
