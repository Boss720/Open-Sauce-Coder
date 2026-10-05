/**
 * Shared renderer types.
 *
 * The renderer imports SDK **types only** — never runtime SDK code (see CONTRACTS.md).
 * Everything the UI needs is re-exported from here so components have a single import site.
 */

import type {
  AssistantMessage,
  FilePart,
  Message,
  Part,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessage
} from '@opencode-ai/sdk'

export type {
  Session,
  Message,
  UserMessage,
  AssistantMessage,
  Part,
  TextPart,
  ReasoningPart,
  FilePart,
  ToolPart,
  ToolState,
  Provider,
  Model,
  Permission,
  Agent
} from '@opencode-ai/sdk'

// SDK types for new features (Phase 0+)
export type { Todo, VcsInfo } from '@opencode-ai/sdk'

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
  /**
   * Refuse NanoGPT image generation on any model observed to bill the pay-as-you-go balance.
   * Default true, so the app never silently spends money.
   */
  nanogptSubscriptionOnly: boolean
}

export type AppSettingsResult = {
  settings: AppSettings
  shortcutRegistered: boolean
  shortcutError?: string
}

/* ------------------------------------------------------------------ *
 * Project-config permissions (`oc:config:permission:get/set`)
 * Structurally identical to the preload and main-process copies.
 * ------------------------------------------------------------------ */

export type PermissionLevel = 'ask' | 'allow' | 'deny'

export type PermissionConfig = {
  edit?: PermissionLevel
  bash?: PermissionLevel | Record<string, PermissionLevel>
  webfetch?: PermissionLevel
  doom_loop?: PermissionLevel
  external_directory?: PermissionLevel
}

/* ------------------------------------------------------------------ *
 * NanoGPT — subscription catalogue + image sidecar
 * Structurally identical to the main-process and preload copies.
 * ------------------------------------------------------------------ */

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

export type NanoBalance = {
  /** Parsed from the documented string field `usd_balance`. */
  usd: number
  /** Parsed from the documented string field `nano_balance`. */
  nano: number
  /** Documented as `nanoDepositAddress`. Omitted when absent. */
  depositAddress?: string
}
export type WeeklyTokenData = { weekKey: string; inputTokens: number; outputTokens: number; totalTokens: number }

/**
 * Documented NanoGPT subscription cap (contract T3): 60 million INPUT tokens per week — NOT a
 * total-token cap. Mirrors `WEEKLY_INPUT_TOKEN_CAP` in `src/main/tokenBudgetTracker.ts` (the
 * renderer cannot import that module — it pulls in Electron `app`/node fs at module scope).
 * Keep the two values in step.
 */
export const WEEKLY_INPUT_TOKEN_CAP = 60_000_000

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

/**
 * Documented free-tier allowance (contract T4): 100 images/day, reset 00:00 UTC. Mirrors
 * `DAILY_FREE_IMAGE_CAP` in `src/main/nanogptImages.ts` (the renderer cannot import that module —
 * it pulls in Electron `app`/node fs at module scope). Keep the two values in step.
 */
export const DAILY_FREE_IMAGE_CAP = 100

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
  sessionID?: string
  /** Explicit per-call consent to bill the pay-as-you-go balance. Never defaults to true. */
  allowBalance?: boolean
}

/** How a completed generation was billed. `unknown` = NanoGPT omitted `paymentSource`. */
export type ImageBilling = 'subscription' | 'balance' | 'unknown'

export type NanogptGenerateResult = {
  images: Array<{ meta: GeneratedImageMeta; base64: string }>
  billing: ImageBilling
  paymentSource?: string
  cost?: number
  remainingBalance?: number
  route: 'subscription' | 'standard'
  /** True when this call caused the model to be recorded as balance-billing. */
  blacklisted: boolean
}

export type UpdateStatus =
  | { state: 'idle' | 'checking' | 'not-available' | 'downloaded' }
  | { state: 'available'; version: string }
  | { state: 'progress'; percent: number }
  | { state: 'error'; message: string }

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

/**
 * Re-exported as ServerCommand to avoid collision with the DOM `Command` interface.
 * These are project-level slash commands registered on the server.
 */
import type { Command as SdkCommand } from '@opencode-ai/sdk'
export type ServerCommand = SdkCommand

/** Input shape for prompt parts sent over IPC to session.promptAsync. */
export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename: string; url: string }

/** A message plus the parts that belong to it, as returned by `oc:messages:list`. */
export type MessageWithParts = { info: Message; parts: Part[] }

/** Status of the `opencode serve` child process, owned by the main process. */
export type ServerStatus = {
  running: boolean
  url: string | null
  /** SSE subscription is live. Independent of `running` — see CONTRACTS.md. */
  streamConnected: boolean
  error?: string
}

/** Answer to a permission request. */
export type PermissionResponse = 'once' | 'always' | 'reject'

/** Every SSE event, forwarded verbatim from main over the `oc:event` channel. */
export type OcEvent = { type: string; properties: any }

/** Shape returned by `oc:providers`. */
export type ProvidersResult = {
  providers: import('@opencode-ai/sdk').Provider[]
  default: Record<string, string>
}

/* ------------------------------------------------------------------ *
 * Narrowing helpers
 * ------------------------------------------------------------------ */

export function isTextPart(part: Part): part is TextPart {
  return part.type === 'text'
}

export function isReasoningPart(part: Part): part is ReasoningPart {
  return part.type === 'reasoning'
}

export function isToolPart(part: Part): part is ToolPart {
  return part.type === 'tool'
}

export function isFilePart(part: Part): part is FilePart {
  return part.type === 'file'
}

export function isAssistant(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

export function isUser(message: Message): message is UserMessage {
  return message.role === 'user'
}

/* ------------------------------------------------------------------ *
 * Phase 1 code surface (fs / git / terminal / editor deep-links)
 * Deliberately duplicated rather than imported from src/preload (the renderer
 * never imports main/preload runtime modules) — kept structurally identical
 * to src/preload/index.d.ts and CONTRACTS.md "Phase 1 — Code surface".
 * ------------------------------------------------------------------ */

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
  /** True when the diff exceeded the 5000-line cap and hunks were dropped. */
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

/* ------------------------------------------------------------------ *
 * Agentic harness (multi-provider profiles + single-agent runs)
 * Deliberately duplicated rather than imported from src/main/harness/* (the
 * renderer never imports main-process modules) — kept structurally identical
 * to src/main/harness/profiles.ts, runner.ts, controller.ts and
 * tools/registry.ts.
 * ------------------------------------------------------------------ */

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
  /** Base URL override for custom endpoints (Ollama, LM Studio) or proxying. */
  baseUrl?: string
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

export type KeyRow = { providerID: string; envVar: string; maskedTail: string | null }
