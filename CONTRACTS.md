# CONTRACTS.md — interfaces every agent codes against (CURRENT)

Binding. Do not invent alternatives. If something is missing, follow the nearest pattern here.

## Architecture

Electron app. **Main process owns the OpenCode server and the SDK client.** Renderer never talks HTTP
(avoids CORS on `file://`). All traffic goes over IPC. Main subscribes once to the SSE event stream and
rebroadcasts every event to the renderer.

```
renderer (React)  <--IPC-->  main (Electron)  <--HTTP/SSE-->  `opencode serve` child process
```

Renderer imports SDK **types only** (`import type { ... } from '@opencode-ai/sdk'`) — never runtime SDK code.

## Ground truth: OpenCode SDK 1.18.4

Verified from installed `.d.ts`. Response style is `"fields"` — every call resolves to
`{ data?, error?, request, response }`. Always read `.data`.

```ts
import { createOpencodeClient } from '@opencode-ai/sdk'
const client = createOpencodeClient({ baseUrl: 'http://127.0.0.1:4599' })
```

Methods used by this app:

| Call | Signature |
|---|---|
| list sessions | `client.session.list({ query: { directory } })` -> `data: Session[]` |
| create session | `client.session.create({ body: { title? }, query: { directory } })` -> `data: Session` |
| delete session | `client.session.delete({ path: { id }, query: { directory } })` |
| messages | `client.session.messages({ path: { id }, query: { directory } })` -> `data: { info: Message, parts: Part[] }[]` |
| send prompt | `client.session.promptAsync({ path: { id }, query: { directory }, body: { model: { providerID, modelID }, parts: [{ type: 'text', text }] } })` |
| abort | `client.session.abort({ path: { id }, query: { directory } })` |
| providers | `client.config.providers()` -> `data: { providers: Provider[], default: Record<string,string> }` |
| permission reply | `client.postSessionIdPermissionsPermissionId({ path: { id, permissionID }, body: { response: 'once' \| 'always' \| 'reject' } })` |
| events | `client.event.subscribe()` -> `{ stream: AsyncIterable<Event> }` |

Use `promptAsync` (fire-and-forget) — the reply arrives as SSE events. Never `prompt` (blocks).

`directory` = the session's project folder; pass it on every call.

### Types (abridged, exact field names)

```ts
type Session = { id, projectID, directory, parentID?, title, version,
                 time: { created, updated }, share?: { url },
                 revert?: { messageID, partID?, snapshot?, diff? } }
// `revert` is present only while the session is in a reverted state; it clears on unrevert.

type UserMessage      = { id, sessionID, role: 'user', time: { created }, agent,
                          model: { providerID, modelID } }
type AssistantMessage = { id, sessionID, role: 'assistant', time: { created, completed? },
                          error?, parentID, modelID, providerID, mode, cost,
                          tokens: { input, output, reasoning, cache: { read, write } }, finish? }
type Message = UserMessage | AssistantMessage

type TextPart      = { id, sessionID, messageID, type: 'text', text, synthetic?, time?: { start, end? } }
type ReasoningPart = { id, sessionID, messageID, type: 'reasoning', text, time: { start, end? } }
type FilePart      = { id, sessionID, messageID, type: 'file', mime, filename?, url }
type ToolPart      = { id, sessionID, messageID, type: 'tool', callID, tool, state: ToolState }
type ToolState =
  | { status: 'pending',   input, raw }
  | { status: 'running',   input, title?, metadata?, time: { start } }
  | { status: 'completed', input, output, title, metadata, time: { start, end } }
  | { status: 'error',     input, error, metadata?, time: { start, end } }
// Part union also includes: subtask | step-start | step-finish | snapshot | patch | agent | retry | compaction
// Render only text / reasoning / tool / file; ignore the rest.

type Permission = { id, type, pattern?, sessionID, messageID, callID?, title, metadata,
                    time: { created } }

type Provider = { id, name, source: 'env'|'config'|'custom'|'api', env: string[], key?,
                  options, models: Record<string, Model> }
type Model = { id, providerID, name, capabilities: { temperature, reasoning, attachment, toolcall,
               input: {...}, output: {...} }, cost: { input, output, cache: { read, write } },
               limit: { context, output }, status: 'alpha'|'beta'|'deprecated'|'active' }

type Todo     = { id: string; content: string;
                  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
                  priority: 'high' | 'medium' | 'low' }
type Command  = { name: string; description?: string; agent?: string; model?: string;
                  template: string; subtask?: boolean }
type Project  = { id: string; worktree: string; vcsDir?: string; vcs?: 'git';
                  time: { created: number; initialized?: number } }
type VcsInfo  = { branch: string }
```

### SSE event types (`Event` union) that matter

`message.updated` `{ info: Message }` · `message.removed` · `message.part.updated` `{ part: Part, delta? }` ·
`message.part.removed` · `permission.updated` (properties **are** the `Permission`) · `permission.replied` ·
`session.idle` · `session.error` · `session.created` / `.updated` / `.deleted` `{ info: Session }` ·
`session.status` · `server.connected` (always first) · `file.edited` ·
`todo.updated` · `vcs.branch.updated` · `session.compacted`.

Every event is `{ type: string, properties: {...} }`.

## IPC contract

Channel names are literal strings. Renderer calls them through `window.api` (preload bridge).

### Invoke channels (renderer -> main, `ipcMain.handle`)

Every handler returns `Promise<T>` and **throws** on failure (renderer catches).

```ts
'oc:status'            () => { running: boolean; url: string | null; streamConnected: boolean; error?: string }
'oc:restart'           () => { running: boolean; url: string | null; streamConnected: boolean; error?: string }
'oc:pickDirectory'     () => string | null              // native folder dialog
'oc:pickFiles'         () => string[]                   // native multi-select file dialog; [] on cancel
'oc:clipboard:saveImage' (args: { data: string; ext: string }) => string
                        // persists a pasted clipboard image (base64 data, ext allowlisted
                        // to png|jpg|jpeg|gif|webp — no svg) under
                        // userData/pasted-images/paste-<epochMs>-<counter>.<ext>. Main
                        // generates the filename; a 5 MiB decoded-byte cap is enforced.
                        // Prunes files older than 7 days on each write (best-effort).
'oc:sessions:list'     (directory: string) => Session[]
'oc:sessions:create'   (directory: string, title?: string, parentID?: string) => Session
                       // parentID creates a child session (subagent tab, side chat).
'oc:sessions:delete'   (directory: string, id: string) => void
'oc:messages:list'     (directory: string, sessionID: string) => { info: Message; parts: Part[] }[]
'oc:prompt'            (args: { directory: string; sessionID: string;
                                providerID: string; modelID: string; text: string;
                                parts?: PromptPart[]; tools?: Record<string, boolean>;
                                agent?: string }) => void
                       // tools: per-request tool policy (validated allowlist charset).
                       // agent: agent-name override (1-64 [A-Za-z0-9._-]); omitted = default.
'oc:abort'             (directory: string, sessionID: string) => void
'oc:providers'         () => { providers: Provider[]; default: Record<string, string> }
'oc:permission:reply'  (args: { directory: string; sessionID: string; permissionID: string;
                                response: 'once' | 'always' | 'reject' }) => void
'oc:openExternal'      (url: string) => void
'oc:sessions:update'   (directory: string, id: string, title: string) => Session
'oc:sessions:summarize' (args: { directory: string; sessionID: string;
                                 providerID: string; modelID: string }) => boolean
'oc:sessions:init'      (args: { directory: string; sessionID: string;
                                 providerID: string; modelID: string;
                                 messageID: string }) => boolean
'oc:sessions:todos'     (directory: string, sessionID: string) => Todo[]
'oc:sessions:command'   (args: { directory: string; sessionID: string;
                                 command: string; arguments: string }) => void
'oc:commands:list'      (directory: string) => Command[]
'oc:find:files'         (directory: string, query: string) => string[]
'oc:vcs:get'            (directory: string) => VcsInfo | null   // 404 → null
'oc:projects:list'      () => ProjectRecord[]
'oc:projects:create'    (args: { name: string }) => ProjectRecord
'oc:projects:instructions:get' (directory: string) => string
'oc:projects:instructions:set' (args: { directory: string; text: string }) => void
'oc:projects:knowledge:list' (directory: string) => KnowledgeFile[]
'oc:projects:knowledge:add' (args: { directory: string; filePaths: string[] }) => KnowledgeFile[]
                        // an empty filePaths array opens the native multi-file picker
'oc:projects:knowledge:remove' (args: { directory: string; filename: string }) => void
'oc:mcp:status'         (directory: string) => McpSnapshot
'oc:mcp:add'            (args: { directory: string; name: string; config: McpConfig }) => McpSnapshot
'oc:mcp:remove'         (args: { directory: string; name: string }) => McpSnapshot
'oc:mcp:connect'        (args: { directory: string; name: string }) => McpSnapshot
'oc:mcp:disconnect'     (args: { directory: string; name: string }) => McpSnapshot
'oc:mcp:auth'           (args: { directory: string; name: string }) => McpSnapshot
'oc:quick:submit'       (text: string) => void
'oc:appSettings:get'    () => AppSettingsResult
'oc:appSettings:set'    (patch: Partial<AppSettings>) => AppSettingsResult
'oc:exportChat'         (defaultName: string, content: string) => Promise<boolean>
'oc:messages:revert'    (args: { directory: string; sessionID: string;
                                 messageID: string }) => void
                        // reverts server to before messageID; ALSO restores
                        // workspace file snapshots (renderer confirms first).
'oc:messages:unrevert'  (args: { directory: string; sessionID: string }) => Session
                        // restores all reverted messages; response is the session
                        // with `revert` cleared (renderer upserts it directly).
'oc:session:fork'      (args: { directory: string; sessionID: string;
                                 messageID: string }) => Session
                        // branches a NEW session from messageID via the SDK's native
                        // session.fork — the source session is left untouched (no
                        // revert/replay). Renderer upserts the returned session and
                        // switches to it.
'oc:agents:list'        (directory: string) => Agent[]
                        // the server's agent registry; the composer picker filters
                        // to mode 'primary' | 'all'.
'oc:config:permission:get' (directory: string) => PermissionConfig
                        // the resolved `permission` key of the project config
                        // ({} when unset).
'oc:config:permission:set' (args: { directory: string; permission: PermissionConfig }) => boolean
                        // merges ONLY the permission key. Strictly validated in main
                        // (known keys, ask|allow|deny; bash may be a pattern map).
                        // Uses config.update; on failure rewrites opencode.json
                        // atomically + restarts the server (returns true).
'oc:search:chats'       (directory: string, query: string, options?: { scope?: 'project' | 'all' }) => ChatSearchHit[]
                        // chat-content search, runs in main with a bounded
                        // (concurrency 4) per-directory message-fetch pool + LRU cache.
                        // scope defaults to 'project' (current directory only, unchanged
                        // behaviour); 'all' additionally searches every directory from
                        // listProjects(), fanned out through the same pool helper at
                        // concurrency 2 so total fan-out stays bounded.
'oc:saveFile'           (args: { defaultName: string; content: string }) => boolean
                        // generalized save dialog for artifact export/download

// --- BYOK: encrypted API-key management (Stream 3A) ---
'oc:keys:list'          () => KeyRow[]        // masked rows only; NEVER the full key
'oc:keys:set'           (args: { providerID: string; key: string }) => void
                        // full key crosses IPC ONLY here (renderer -> main).
                        // On error, throws a message that excludes the key.
'oc:keys:delete'        (providerID: string) => void   // note the channel is :delete
'oc:keys:test'          (providerID: string) =>
                          { ok: boolean; status?: number; detail?: string }
                        // live-pings the provider's test endpoint with the
                        // decrypted key; key never logged or returned.

// --- NanoGPT: subscription catalogue + quota ---
'oc:nanogpt:models'     () => NanogptModelsResult   // cached, no network
'oc:nanogpt:refresh'    () => NanogptRefreshResult  // re-fetch both catalogues
'oc:nanogpt:usage'      () => NanoUsage | null      // live subscription quota; null on failure (T2)
'oc:nanogpt:balance'    () => NanoBalance | null    // live pay-per-prompt balance; null on failure (T2)
'oc:nanogpt:weeklyUsage' () => WeeklyTokenData      // weekly input/output token usage
'oc:nanogpt:images:today' () => number              // local-index count of images generated since UTC midnight

// --- NanoGPT: image generation (SPENDS MONEY — see the guard rules below) ---
'oc:nanogpt:generate'   (args: NanogptGenerateArgs) => NanogptGenerateResult
'oc:nanogpt:images:list'   (sessionID?: string) => GeneratedImageMeta[]  // METADATA ONLY
'oc:nanogpt:images:read'   (id: string) => string | null                // base64 PNG
'oc:nanogpt:images:delete' (id: string) => void

// --- Gemini Live (WebRTC-style realtime audio/video) ---
'oc:live:start'  (config?: GeminiLiveConfig) => void
                        // opens a Live session (defaults: model
                        // gemini-3.1-flash-live-preview, voice Kore). config is
                        // validated in main (voice allowlist, model charset,
                        // systemInstruction ≤4000 chars); bad values throw.
'oc:live:stop'   () => void
'oc:live:saveTranscript' (args: { messages: LiveTranscriptMessage[] }) => string
                        // writes userData/live-transcripts/<timestamp>.md and
                        // returns the path. Bounds: ≤5000 messages, ≤32k chars each.
'oc:live:transcripts:reveal' () => void
                        // opens userData/live-transcripts in the OS file manager,
                        // creating it if absent. Takes NO renderer-supplied path —
                        // the directory is derived in main, so there is nothing to
                        // validate and no way to point it at an arbitrary location.

// --- Leroy sidecar (the gemini-live-agent Python harness) ---
'oc:leroy:start'  (options?: { agentDir?: string; settings?: Record<string, unknown> }) => void
                        // spawns one sidecar for the calling window, replacing any
                        // existing one (the child owns the audio devices, so two
                        // would fight over the microphone). `settings` is a partial
                        // Python-side AppSettings; unknown keys are dropped there.
                        // Throws when the checkout or a Google key is missing.
'oc:leroy:stop'   () => void   // disconnect, then kill; idempotent
'oc:leroy:status' () => boolean // is a sidecar running for this window

// --- Crash log (main's own crash.log in userData, written by src/main/crashlog.ts) ---
'oc:crashlog:read'   () => CrashLogReport
                        // BOUNDED tail read: at most the last 64 KiB of crash.log
                        // (never the whole file), plus metadata (path, sizeBytes,
                        // hasOld for the rotated crash.log.old, entryCount over the
                        // returned tail). Missing log returns an empty report — never
                        // throws.
'oc:crashlog:reveal' () => void
                        // shell.showItemInFolder on crash.log. The renderer passes
                        // NOTHING — main builds the path from crashlog.getCrashLogPath(),
                        // so there is no way to point it at an arbitrary location.

// --- Gemini Live copilot window (a separate floating BrowserWindow) ---
'oc:liveWindow:open'           () => void
                        // shows and focuses the floating `#/live` window, creating
                        // it on demand. The copilot runs in its own window so chat
                        // keeps running behind it; because geminiLive.ts keys every
                        // session by webContents id, that window owns its own Live
                        // session and closing it tears the session down.
'oc:liveWindow:close'          () => void
'oc:liveWindow:setAlwaysOnTop' (on: boolean) => void
                        // no-op when the window does not exist.
```

### Listener channels (renderer -> main, `ipcMain.on`)

```ts
'oc:live:send'   (input: GeminiLiveInput) => void  // realtime audio / video / text input
'oc:leroy:send'  (command: LeroyCommand) => void   // validated in main; a malformed
                        // command comes back as a `sidecar_error` event rather
                        // than rejecting, since this channel has no reply.
```

`oc:saveFile` gained an optional `encoding?: 'utf8' | 'base64'` (defaults to `'utf8'`, so existing
callers are unaffected) so generated PNGs can be written as bytes.

`KeyRow` (exported from `src/preload/index.ts`, importable by the renderer):

```ts
export type KeyRow = { providerID: string; envVar: string; maskedTail: string | null }
```

The full key **never** crosses IPC back to the renderer. `oc:keys:list` returns only the last-4
tail (or `null`). The renderer sends the plaintext once, on `oc:keys:set`; it is encrypted in main
and never read back in the clear across the bridge.

`ChatSearchHit` (exported from `src/preload/index.ts`, importable by the renderer):

```ts
export type ChatSearchScope = 'project' | 'all'

export type ChatSearchHit = {
  sessionID: string; title: string; messageID: string; snippet: string; time: number
  directory: string // absolute directory the hit came from; always set
}
```

`CrashLogReport` (exported from `src/preload/index.ts`, importable by the renderer) — the
bounded payload of `oc:crashlog:read`:

```ts
export type CrashLogReport = {
  path: string        // absolute path to crash.log ('' until main has initialised it)
  exists: boolean     // crash.log exists (regardless of size)
  sizeBytes: number   // on-disk size of crash.log (0 when absent)
  hasOld: boolean     // a rotated crash.log.old exists alongside the active log
  entryCount: number  // entry headers in the returned tail; a lower bound once truncated
  tail: string        // most recent bytes of crash.log, capped at 64 KiB
  truncated: boolean  // true when the file was larger than the cap
}
```

`PermissionConfig` (exported from `src/preload/index.ts`, importable by the renderer) — the
validated shape accepted by `oc:config:permission:set`:

```ts
export type PermissionLevel = 'ask' | 'allow' | 'deny'
export type PermissionConfig = {
  edit?: PermissionLevel
  bash?: PermissionLevel | Record<string, PermissionLevel>
  webfetch?: PermissionLevel
  doom_loop?: PermissionLevel
  external_directory?: PermissionLevel
}
```

Module 6 project records are owned by the desktop app (not the OpenCode SDK) and persisted in
`userData/projects-registry.json`:

```ts
export type ProjectRecord = {
  id: string
  name: string
  directory: string
  createdAt: number
  updatedAt: number
}
export type KnowledgeFile = { filename: string; size: number; updatedAt: number }

export type McpLocalConfig = {
  type: 'local'; command: string[]; environment?: Record<string, string>;
  enabled?: boolean; timeout?: number
}
export type McpRemoteConfig = {
  type: 'remote'; url: string; enabled?: boolean; headers?: Record<string, string>;
  oauth?: { clientId?: string; clientSecret?: string; scope?: string } | false;
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
```

### Send channels (main -> renderer, `webContents.send`)

```ts
'oc:event'                 (event: { type: string; properties: any })   // every SSE event, verbatim
'oc:live:message'          (event: GeminiLiveEvent)                      // Gemini Live message/error/closed/reconnecting
'oc:leroy:event'           (event: LeroyEvent)                           // Leroy sidecar NDJSON stream + sidecar_exit/sidecar_error
'oc:server'                (status: { running: boolean; url: string | null; streamConnected: boolean; error?: string })
//   `running` means the HTTP server answers. `streamConnected` means the SSE
//   subscription is live. They are independent: the stream can drop and
//   silently reconnect (500ms..10s backoff) while the server stays up, during
//   which no events arrive. The UI must distinguish the two or it shows a
//   healthy dot on an app that has stopped responding to the agent.
'main-menu:new-session'    ()   // File > New Session menu / Ctrl+N accelerator
```

### Preload bridge shape (`window.api`)

```ts
export interface OpencodeApi {
  status(): Promise<ServerStatus>
  restart(): Promise<ServerStatus>
  pickDirectory(): Promise<string | null>
  pickFiles(): Promise<string[]>
  sessions: {
    list(directory: string): Promise<Session[]>
    create(directory: string, title?: string, parentID?: string): Promise<Session>
    remove(directory: string, id: string): Promise<void>
    update(directory: string, id: string, title: string): Promise<Session>
    summarize(a: SummarizeArgs): Promise<boolean>
    init(a: InitArgs): Promise<boolean>
    todos(directory: string, sessionID: string): Promise<Todo[]>
    command(a: CommandArgs): Promise<void>
  }
  commands: { list(directory: string): Promise<Command[]> }
  find: { files(directory: string, query: string): Promise<string[]> }
  vcs: { get(directory: string): Promise<VcsInfo | null> }
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
  quick: { submit(text: string): Promise<void> }
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
    getPermission(directory: string): Promise<PermissionConfig>
    setPermission(a: { directory: string; permission: PermissionConfig }): Promise<boolean>
  }
  keys: {
    list(): Promise<KeyRow[]>                                   // masked rows only
    set(a: { providerID: string; key: string }): Promise<void> // plaintext one-way in
    remove(providerID: string): Promise<void>                  // -> 'oc:keys:delete'
    test(providerID: string): Promise<{ ok: boolean; status?: number; detail?: string }>
  }
  live: {
    start(config?: GeminiLiveConfig): Promise<void>
    send(input: GeminiLiveInput): void
    stop(): Promise<void>
    onMessage(cb: (event: GeminiLiveEvent) => void): () => void
    saveTranscript(a: { messages: LiveTranscriptMessage[] }): Promise<string> // -> saved file path
    revealTranscripts(): Promise<void>
  }
  leroy: {
    start(options?: LeroyStartOptions): Promise<void>
    send(command: LeroyCommand): void
    stop(): Promise<void>
    status(): Promise<boolean>
    onEvent(cb: (event: LeroyEvent) => void): () => void
  }
  crashLog: {
    read(): Promise<CrashLogReport>   // bounded tail read; empty report when no log exists
    reveal(): Promise<void>           // reveals crash.log in the OS file manager (main-owned path)
  }
  nanogpt: {
    /** Cached catalogues — cheap, synchronous in main, no network. */
    models(): Promise<NanogptModelsResult>
    refresh(): Promise<NanogptRefreshResult>
    usage(): Promise<NanoUsage | null>
    balance(): Promise<NanoBalance | null>
    weeklyUsage(): Promise<WeeklyTokenData>
    generate(a: NanogptGenerateArgs): Promise<NanogptGenerateResult>
    images: {
      list(sessionID?: string): Promise<GeneratedImageMeta[]>
      read(id: string): Promise<string | null>
      remove(id: string): Promise<void>
      today(): Promise<number>
    }
  }
  harness: {
    profiles: {
      list(): Promise<AgentProfile[]>
      get(id: string): Promise<AgentProfile | null>
      save(profile: unknown): Promise<AgentProfile>      // validated in main; THROWS on builtin
      remove(id: string): Promise<boolean>               // -> 'oc:harness:profiles:delete'
      test(id: string): Promise<boolean>                 // provider connectivity probe
    }
    run: {
      start(a: { profileId: string; task: string; directory: string }): Promise<string> // runId
      stop(runId: string): Promise<void>
      status(runId: string): Promise<RunStatus | null>
      list(): Promise<RunStatus[]>
    }
    tools: { list(): Promise<ToolDefinition[]> }
    onEvent(cb: (e: { runId: string; event: RunnerEvent }) => void): () => void  // returns unsubscribe
  }
  messages(directory: string, sessionID: string): Promise<MessageWithParts[]>
  revertMessage(a: { directory: string; sessionID: string; messageID: string }): Promise<void>
  unrevertMessage(a: { directory: string; sessionID: string }): Promise<Session>
  forkSession(a: { directory: string; sessionID: string; messageID: string }): Promise<Session>
  agents(directory: string): Promise<Agent[]>
  searchChats(directory: string, query: string, options?: { scope?: ChatSearchScope }): Promise<ChatSearchHit[]>
  prompt(a: { directory: string; sessionID: string; providerID: string; modelID: string; text: string; parts?: PromptPart[]; tools?: Record<string, boolean>; agent?: string }): Promise<void>
  abort(directory: string, sessionID: string): Promise<void>
  providers(): Promise<ProvidersResult>
  replyPermission(a: { directory: string; sessionID: string; permissionID: string; response: PermissionResponse }): Promise<void>
  openExternal(url: string): Promise<void>
  exportChat(defaultName: string, content: string): Promise<boolean>
  saveFile(a: { defaultName: string; content: string }): Promise<boolean>
  pickFiles(): Promise<string[]>      // native multi-select file dialog; [] on cancel
  saveClipboardImage(a: { data: string; ext: string }): Promise<string>  // pasted clipboard image -> absolute path
  pathForFile(file: File): string     // wraps electron.webUtils.getPathForFile for drag-drop
  onEvent(cb: (e: OcEvent) => void): () => void            // returns unsubscribe
  onServer(cb: (s: ServerStatus) => void): () => void
  onMainMenuNewSession(cb: () => void): () => void
  onQuickEntryPrompt(cb: (text: string) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}
export type GeminiLiveInput = {
  audio?: { data: string; mimeType: 'audio/pcm;rate=16000' }
  video?: { data: string; mimeType: 'image/jpeg' }
  text?: string
}
export type GeminiLiveConfig = {
  voice?: string            // allowlist enforced in main (Kore, Puck, Aoede, …)
  model?: string            // 1-128 chars of [A-Za-z0-9._-]
  systemInstruction?: string // ≤4000 chars
}
export type LiveTranscriptMessage = {
  role: 'you' | 'gemini' | 'system'
  text: string
  at?: number               // epoch ms
}
export type GeminiLiveEvent =
  | { type: 'message'; data: unknown }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }
  | { type: 'reconnecting'; attempt: number; maxAttempts: number }
// Session resumption: main enables `sessionResumption` and auto-reconnects an
// abnormally-dropped socket up to 3 times (1s/2s/4s backoff) with the stored
// handle, emitting `reconnecting` per attempt. A further `message` event means
// the resume succeeded; exhaustion arrives as the normal `closed` event.
declare global { interface Window { api: OpencodeApi } }
```

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`.

## BYOK — bring-your-own-key (Stream 3A, security-critical)

Users store LLM-provider API keys in-app; keys are encrypted at rest and injected into the
`opencode serve` child process env at spawn.

**Store.** `src/main/keys.ts` is the ONLY module that touches Electron `safeStorage`. Keys live in
`userData/byok-keys.json`:

```json
{ "version": 1, "keys": { "NANOGPT_API_KEY": "<base64 of safeStorage.encryptString(value)>" } }
```

One entry per canonical env var (resolved from the provider catalog). Written pretty, mode `0o600`
best-effort. A missing/corrupt file reads as `{ version: 1, keys: {} }`. `setKey` **throws** if
`safeStorage.isEncryptionAvailable()` is false — it never writes plaintext.

**Env injection at spawn.** `server.ts` `doStart()` calls `loadByokEnv()` (decrypts all keys, applies
the same ALIAS expansion as `env.ts`) and merges **BYOK on top of the `.env` vars — BYOK wins on
conflict** — before `buildChildEnv`. `loadByokEnv` never throws: undecryptable/unavailable keys are
skipped so the server still starts. The existing `.env` log line is kept; a second `record()` line
logs `loaded N BYOK keys (encrypted store): <names>` using `redactedSummary` (key NAMES only).

`env.ts` now `export`s `ALLOWLIST` and `ALIASES` so `keys.ts` validates every env var against the
restricted NanoGPT/Gemini allowlist and reuses the Google alias logic. Existing
blocklist/allowlist/CVE hardening is otherwise untouched.

**DECISION — env-injection, NOT the SDK `auth.set`.** opencode's `auth.set` persists the raw key in
**plaintext** to opencode's `auth.json`. We reject that: the only at-rest copy must be under OS
encryption (`safeStorage`). Env-injection keeps the plaintext transient (decrypted in main, handed to
the child process, never written to disk by us).

**Key never crosses IPC back to the renderer.** The plaintext enters main once via `oc:keys:set`.
`oc:keys:list` returns `KeyRow[]` (last-4 tail or `null`). No key value is ever written to any log,
error message, or crash file — errors reference only the providerID/envVar.

**Catalog dependency.** `keys.ts` imports `PROVIDER_CATALOG`, `catalogByProvider` from
`src/main/providerCatalog.ts` for the providerID → envVar mapping and per-provider test endpoints.

**Supported BYOK providers.** The catalog intentionally contains only `nanogpt` (the
subscription-scoped NanoGPT coding path) and `google` (Gemini, including Gemini Live). Other
OpenCode providers may still appear in the SDK's read-only model inventory when configured outside
this app, but this app does not accept, persist, list, or inject their BYOK keys.

## NanoGPT provider (subscription-scoped)

NanoGPT is not an OpenCode built-in. It is registered as an OpenCode **custom provider** whose block
is generated in `src/main/nanogptConfig.ts` and injected into the child process as
`OPENCODE_CONFIG_CONTENT` at spawn (`server.ts` `doStart()`, via the new `buildChildEnv(providerVars,
extraVars)` second parameter). `src/main/nanogpt.ts` is the REST client and the ONLY module that
talks to `nano-gpt.com`.

**DECISION — env injection, NOT writing `opencode.json`.** Verified against opencode 1.18.4:
`OPENCODE_CONFIG_CONTENT` **deep-merges** with project/global config — a project `opencode.json`
carrying `instructions: ["knowledge/**/*.md"]` survives injection intact. Env injection keeps the
generated block ephemeral and never mutates a user-owned config file.

**DECISION — subscription-scoped `baseURL`.** `options.baseURL` is pinned to
`https://nano-gpt.com/api/subscription/v1` and `models` is populated solely from
`GET /api/subscription/v1/models?detailed=true`. Both the catalogue **and** the billing path are
therefore subscription-scoped: no pay-per-token model is reachable under `nanogpt/`, even by typing
its id. That invariant is the sole justification for the `'subscription'` verdict in `freeTier.ts`.

`options.apiKey` is the literal placeholder `{env:NANOGPT_API_KEY}` — OpenCode substitutes it from
the child env. **The generated config never contains a key value** and is safe to log.

Per-model capability keys, verified empirically against `/config/providers`:

| Config key | Resolved capability | Default for a custom provider |
|---|---|---|
| `tool_call` (snake) | `capabilities.toolcall` | `true` |
| `attachment` | `capabilities.attachment` | `false` |
| `reasoning` | `capabilities.reasoning` | `false` |
| `temperature` | `capabilities.temperature` | `false` |
| `modalities: { input: [], output: [] }` | `capabilities.input.*` / `output.*` | text only |

Writing `toolcall` instead of `tool_call` is **silently ignored**. `cost` resolves to all-zeros for a
custom provider, which is exactly the false positive the `cost == 0` free-model predicate was
rejected for — `isFreeModel` classifies by provider, never by cost.

Cache: `userData/nanogpt-models.json`,
`{ version: 1, fetchedAt, chat[], image[], balanceBilled[] }`. Missing/corrupt reads as empty and
never throws. `refreshCatalogs()` fetches both catalogues before writing, so a failure leaves the
existing cache untouched; `restartRequired` compares chat-model **id sets** because the generated
block is only read at spawn.

**Bootstrap ordering.** On a fresh install there is no key → no cache → no provider. `ProviderPanel`
lists `nanogpt` in `BUILTIN_PROVIDERS` so the key can be entered anyway, and `handleSave` runs
`keys.set` → `nanogpt.refresh()` → `restart()` in that order. Refreshing after the restart would
inject an empty model map.

`balanceBilled` records image model ids observed to bill the pay-as-you-go balance rather than the
subscription. NanoGPT exposes **no** API field marking per-image-model subscription inclusion (the
help page states the included set varies), so the generation response's `paymentSource` is the only
machine-readable ground truth and inclusion is learned empirically.

**Balance shape (T1).** The documented `POST /api/check-balance` response carries `usd_balance` /
`nano_balance` as STRINGS, parsed with `Number.parseFloat`:

```ts
export type NanoBalance = {
  usd: number             // parsed from usd_balance; a non-finite parse is a hard error (throws)
  nano: number             // parsed from nano_balance; non-finite falls back to 0
  depositAddress?: string  // documented as nanoDepositAddress; omitted when absent
}
```

**Nullability on failure (T2).** `oc:nanogpt:balance` and `oc:nanogpt:usage` resolve to `null` on a
network/parse failure rather than a zero-valued placeholder — `$0.00` and "unknown" are different UI
states. `usage(): Promise<NanoUsage | null>`, `balance(): Promise<NanoBalance | null>` in preload and
the renderer.

**Weekly token budget (T3).** The documented subscription cap is 60 million **input** tokens per
week, not total. `WEEKLY_INPUT_TOKEN_CAP = 60_000_000` is exported from
`src/main/tokenBudgetTracker.ts`; any gauge/percentage MUST compare `weeklyUsage.inputTokens`
against that constant, never `totalTokens`.

```ts
export type WeeklyTokenData = { weekKey: string; inputTokens: number; outputTokens: number; totalTokens: number }
```

## NanoGPT image generation

`src/main/nanogptImages.ts` owns the on-disk gallery; `src/main/nanogptBilling.ts` is a dependency-free
module holding the one rule that decides whether the app spends money again.

**Billing is three-valued** — `classifyBilling(paymentSource)` → `'subscription' | 'balance' |
'unknown'`. An **absent** `paymentSource` is `'unknown'`, never assumed to be balance: assuming the
worst would blacklist every model after one generation and break image support outright if NanoGPT
stopped sending the field. Only positive evidence blacklists. The renderer keeps a deliberate second
copy in `src/renderer/src/lib/imageModels.ts` (main and renderer cannot share modules, as with the
duplicated types); **keep the two in step.**

`oc:nanogpt:generate` guards, in order:
1. `prompt` ≤ 4000 chars; `n` ∈ 1..4; `size` from a fixed allowlist.
2. `model` MUST be a member of the cached image catalogue — no arbitrary passthrough to a paid API.
3. Refused when `nanogptSubscriptionOnly` and the model is in `balanceBilled`, unless the call passes
   explicit `allowBalance: true`. The renderer never sets that flag implicitly.
4. **Serialised per model** via an in-flight set. The blacklist can only reject a model whose billing
   is already known, and billing only becomes known when a generation returns — so two concurrent
   calls on an untested model would both pass step 3 and both spend, across a window as wide as a full
   generation. The second call is refused so it sees the first call's verdict.

The first generation on an untested model is an unavoidable probe; the UI labels it as such rather
than hiding it.

**Storage.** PNGs live in `userData/nanogpt-images/<uuid>.png` with an `index.json` of
`GeneratedImageMeta`, capped at 500 retained (oldest pruned from index *and* disk). `reconcile()`
drops entries whose file vanished and orphan PNGs. An `id` arriving from the renderer is validated
against `/^[a-f0-9-]{16,64}$/i` plus a `basename` identity check before it reaches a path — an
allowlist, not a traversal blocklist.

**Why base64 crosses IPC rather than a path.** The renderer CSP is `img-src 'self' data: blob:` and
the renderer is served from `file://` in production, so a `file://` URL into userData is not
same-origin and would be blocked. `images:list` therefore returns **metadata only** and
`images:read` fetches bytes on demand; the Images view loads tiles lazily via IntersectionObserver
with a concurrency cap, and session rehydration is bounded to the 12 most recent (and says so in the
transcript when it truncates).

**Rendering reuses existing machinery.** `makeImageNotice` in `collections.ts` builds a synthetic
assistant message with a text caption plus one `file` part per image (`mime: 'image/png'`, `url` a
`data:` URI). `MessageView` already renders image file parts as thumbnails backed by
`ImageLightbox`, so there is no bespoke image-rendering path. These messages have no server-side
counterpart, which is why they must be rehydrated from the index on `selectSession`.

New CSS namespace: `.images` in `src/renderer/src/components/images.css`. No new global tokens.
`activeView` is now `'chats' | 'projects' | 'images'`.

## Shared renderer types — `src/renderer/src/lib/types.ts` (Agent B owns)

```ts
export type MessageWithParts = { info: Message; parts: Part[] }
export type ServerStatus = { running: boolean; url: string | null; error?: string }
export type PermissionResponse = 'once' | 'always' | 'reject'
export type OcEvent = { type: string; properties: any }
```

## Renderer store — `src/renderer/src/lib/store.ts` (Agent B owns, zustand)

Single store. Components read via selectors; they never hold their own copy of server state.

```ts
interface AppState {
  // connection
  server: ServerStatus
  // project
  directory: string | null
  // sessions
  sessions: Session[]
  activeSessionID: string | null
  // messages for the active session, ordered oldest -> newest
  messages: MessageWithParts[]
  busy: boolean                      // assistant currently working
  // model
  providers: Provider[]
  defaultModels: Record<string, string>
  providerID: string | null
  modelID: string | null
  // permissions awaiting user answer, oldest first
  permissions: Permission[]
  // last error banner text, null when clear
  error: string | null

  // todos for the active session
  todos: Todo[]
  // current git branch
  branch: string | null
  // prompts waiting to be sent when session goes idle
  queuedPrompts: Array<{ text: string; parts?: PromptPart[] }>
  // commands from the server (project-level slash commands)
  serverCommands: Command[]
  // desktop-managed projects, each mapped to an isolated directory
  projects: ProjectRecord[]
  activeView: 'chats' | 'projects'
  appSettings: AppSettings
  shortcutRegistered: boolean
  shortcutError: string | null
  updateStatus: UpdateStatus
  // ui theme
  theme: 'auto' | 'dark' | 'light'

  // actions
  init(): Promise<void>                       // status + providers + restore persisted prefs
  pickDirectory(): Promise<void>
  setDirectory(dir: string): Promise<void>    // loads sessions
  loadProjects(): Promise<void>
  createProject(name: string): Promise<ProjectRecord>
  openProject(project: ProjectRecord): Promise<void> // delegates to setDirectory(project.directory)
  setActiveView(view: 'chats' | 'projects'): void
  loadAppSettings(): Promise<void>
  updateAppSettings(patch: Partial<AppSettings>): Promise<void>
  setUpdateStatus(status: UpdateStatus): void
  newSession(): Promise<void>
  selectSession(id: string): Promise<void>    // loads messages
  deleteSession(id: string): Promise<void>
  send(text: string, parts?: PromptPart[]): Promise<void>
  queuePrompt(text: string, parts?: PromptPart[]): void
  abort(): Promise<void>
  setModel(providerID: string, modelID: string): void
  replyPermission(id: string, response: PermissionResponse): Promise<void>
  applyEvent(e: OcEvent): void                // SSE reducer
  dismissError(): void
  renameSession(id: string, title: string): Promise<void>
  setTheme(t: 'auto' | 'dark' | 'light'): void
  queuePrompt(text: string, parts?: PromptPart[]): void
  removeQueued(index: number): void
  retryExchange(messageID: string): Promise<void>
  // Edit a prior USER message and resend: reverts the server to before that
  // message (also restoring workspace file snapshots), optimistically truncates
  // local messages to before it, then reuses send() so routing/rotation/queueing
  // all apply. No-op if the id is not a loaded user message.
  editAndResend(messageID: string, newText: string): Promise<void>
  // Smart routing v2 (Module 4)
  modelPool: string[] | null               // candidate "providerID/modelID" pairs; null = default pool
  stickyModel: boolean                     // derived from routingMode ('failover') for legacy readers
  toggleStickyModel(): void                // legacy — flips routingMode failover ↔ locked
  setModelPool(pool: string[] | null): void

  // Reactive-failover routing (Intelligent Auto Model Router)
  routingMode: 'locked' | 'failover' | 'auto'  // failover (default) uses your pick, swaps only on 429/stall
  setRoutingMode(mode: RoutingMode): void
  showPaidModels: boolean                  // reveals paid models in picker; auto-failover NEVER picks paid
  setShowPaidModels(v: boolean): void

  // Chosen/effective split (R4): pinned* is user intent, providerID/modelID is what's currently running.
  // Only setModel mutates pinned*. rotateToNextFreeModel mutates providerID/modelID only.
  pinnedProviderID: string | null
  pinnedModelID: string | null
  revertToPinned(): void                   // click target for the failover chip in StatusBar
}
```

`applyEvent` rules:
- `message.updated` — upsert `info` by `info.id` into `messages` (append if new, keep order by `time.created`).
- `message.part.updated` — find the message by `part.messageID`; upsert the part by `part.id`. If the
  message is not loaded yet, ignore. Preserve part order by first-seen.
- `message.removed` / `message.part.removed` — remove by id.
- `permission.updated` — push `properties` onto `permissions` if not already present by `id`.
- `permission.replied` — drop the matching permission by `permissionID`.
- `session.idle` — `busy = false` when `properties.sessionID === activeSessionID`. Record success in routing ledger. Reset `rotateRetries` ONLY on clean completion (no failover in flight, R2).
- `session.error` — classify error via `classifyError`; if rate-limit, honor `Retry-After` / `X-RateLimit-Reset` from `error.data.responseHeaders`; single-entry `beginFailover` reverts the user message (transactional, R1+R3) then re-prompts on next healthy free model. Never auto-retry if any tool ran or tokens streamed (R1).
- `session.created` / `session.updated` / `session.deleted` — sync the `sessions` array.
- Ignore events whose `sessionID` is not the active session (except session list churn).

Persist `directory`, `providerID`, `modelID`, `autoRotate`, `theme`, `modelPool`, `stickyModel`, `routingMode`, `showPaidModels` to `localStorage` under key `opencode-desktop:prefs`. On load, `loadPrefs` migrates the legacy `autoRotate` + `stickyModel` booleans into `routingMode` (`stickyModel:true` → `'failover'`, `autoRotate:false` → `'locked'`, else `'failover'`) and prunes any persisted paid provider/model when `showPaidModels` is false. Legacy booleans are still written for one release for downgrade safety.

`AppSettings` (main-process, persisted under `app-settings.json`) additionally carries `showPaidModels`, `ttftMs` (min 5000, default 20 000), `stallMs` (min 10 000, default 90 000). The renderer store mirrors these into `AppState.appSettings`; the two watchdogs read the current values at arming time so config changes take effect on the next attempt.

## Projects (Module 6)

- Managed roots live at `app.getPath('userData')/Projects/<slug>/`; the registry is versioned JSON
  at `app.getPath('userData')/projects-registry.json` and malformed records are ignored.
- Custom instructions occupy only the marker-delimited block in `<project>/AGENTS.md` between
  `<!-- OPENCODE-DESKTOP-INSTRUCTIONS-START -->` and
  `<!-- OPENCODE-DESKTOP-INSTRUCTIONS-END -->`; unrelated user content is preserved.
- Knowledge files are copied into `<project>/knowledge/`. Only Markdown knowledge formats are
  accepted, duplicate basenames are replaced, and all list/add/remove targets are containment-checked.
- `<project>/opencode.json` is merged without discarding existing keys and always includes
  `knowledge/**/*.md` in its `instructions` array.
- `assertSubpath(baseDir, candidate)` rejects the base directory itself, traversal, absolute paths
  outside the base, and any existing symlink/reparse-point segment. Filesystem-changing operations
  also validate the registered project directory before use.
- `.projects` owns Module 6 styling in `src/renderer/src/components/projects.css`; no new CSS tokens.

## MCP connectors (Module 7)

- Main owns all MCP SDK/config calls. Every call is scoped by `directory`; the renderer imports only
  `McpLocalConfig`, `McpRemoteConfig`, `McpStatus`, and `McpSnapshot` types.
- `oc:mcp:add` validates the name/config, calls `mcp.add`, then persists the merged `Config.mcp`
  through `config.get` + `config.update`. Remove persists the map without that entry and disconnects
  the live server best-effort. If `config.update` fails at runtime, main safely merges the same map
  into `<directory>/opencode.json` and restarts the local OpenCode server.
- OAuth calls `mcp.auth.start`, opens only the returned HTTP(S) authorization URL through Electron,
  and returns a refreshed snapshot. Credentials never pass through the renderer.
- Snapshot configs are display-safe: local `environment`, remote `headers`, and OAuth
  `clientSecret` values are omitted in main before crossing IPC.
- Local command strings are split in the renderer with the tested quote-aware `splitCommandLine`
  helper. Environment/header rows become trimmed key-value maps; empty or duplicate keys are rejected.
- MCP styling uses the `.mcp` namespace in `src/renderer/src/components/mcp.css`; no new CSS tokens.

## OS integration (Module 8)

- App settings are versioned JSON at `userData/app-settings.json`. Main validates all patches and
  owns registration of the configurable global shortcut (default `Ctrl+Alt+Space`); conflicts are
  returned as `shortcutError` and never crash startup.
- Closing the main window hides it when `closeToTray` is enabled. Explicit Quit from tray/menu sets
  the quitting flag, unregisters shortcuts, destroys tray/quick-entry windows, and stops the server.
- The tray offers Show/Hide, New Chat, Quick Entry, and Quit. `resources/tray-icon.svg/.png/.ico`
  contain an original neutral geometric mark; no third-party branding.
- Quick Entry is a frameless always-on-top window loading the same renderer at `#/quick`.
  `oc:quick:submit` accepts non-empty text in main, hides the quick window, focuses/creates the main
  window, and sends `quick-entry:prompt`; the main renderer calls the existing Zustand `send()` so
  smart routing and the single SSE pipeline remain unchanged.
- `electron-updater` is a runtime dependency. Main owns update checks and emits sanitized
  `update:status` events. The application menu exposes `Check for Updates...`; downloaded updates
  require explicit user confirmation before `quitAndInstall()`.
- GitHub publishing targets `bosscube1/OPENCCODE`; NSIS is the update-capable target. Portable builds
  remain available but are not auto-updated. Unsigned builds may trigger Windows SmartScreen.
- Quick Entry uses the `.quick-entry` CSS namespace. No new global CSS tokens.

## Smart Routing v2 — `src/renderer/src/lib/routing.ts` (Module 4)

Pure module for proactive health tracking and model selection.

```ts
export type ModelKey = string // format "providerID/modelID"

export type ModelHealth = {
  cooldownUntil: number
  cooldownMs: number
  success: number
  error: number
  last429: number | null
  latencyEwma: number | null
  sends: number[] // epoch-ms timestamps, pruned to last 24h
}

export type Ledger = Record<ModelKey, ModelHealth>

export type ProviderCaps = { rpm?: number; rpd?: number }
export type ModelCapsMap = Record<string, ProviderCaps>

export const DEFAULT_PROVIDER_CAPS: ModelCapsMap

// record429 accepts an optional retryAfterMs (from provider Retry-After header).
// When present, cooldown is set to min(retryAfterMs, 120s). Otherwise falls back
// to exponential backoff: 30s doubling up to 30 min (R8 fix).
export function record429(ledger: Ledger, key: ModelKey, now: number, retryAfterMs?: number): Ledger
export function recordSuccess(ledger: Ledger, key: ModelKey, latencyMs: number, now: number): Ledger
export function recordFailure(ledger: Ledger, key: ModelKey, now: number): Ledger
export function recordTimeout(ledger: Ledger, key: ModelKey, now: number): Ledger
export function reserveAttempt(ledger: Ledger, key: ModelKey, now: number): Ledger
// releaseAttempt removes the most recent send timestamp — for catch blocks that
// fail before dispatch completes so the reservation doesn't count against caps (R9).
export function releaseAttempt(ledger: Ledger, key: ModelKey): Ledger

// Provider-level (sums across all models of a provider) — kept for legacy call sites.
export function underRateCaps(ledger: Ledger, key: ModelKey, caps: ModelCapsMap, now: number): boolean
// Model-level (counts only this specific model) — for per-model throttling checks (R9).
export function underModelRateCaps(ledger: Ledger, key: ModelKey, caps: ModelCapsMap, now: number): boolean

export function selectModel(
  pool: ModelKey[] | null,
  ledger: Ledger,
  caps: ModelCapsMap,
  now: number,
  opts: {
    sticky: boolean
    current: ModelKey | null
    available: ReadonlySet<ModelKey>
    authenticatedProviders: ReadonlySet<string>
  }
): ModelKey | null
export function selectModelDetailed(
  pool: ModelKey[] | null,
  ledger: Ledger,
  caps: ModelCapsMap,
  now: number,
  opts: {
    sticky: boolean
    current: ModelKey | null
    available: ReadonlySet<ModelKey>
    authenticatedProviders: ReadonlySet<string>
  }
): ModelSelectionExplanation
// selectModel hard-floor (R11): skips any candidate with ≥5 total attempts and <20% success ratio.
// Scoring: healthScore ∈ [-∞, 1] dominates; coding quality contributes at most 0.12 (normalized from /6),
// so a healthy model always outranks a broken high-quality one.

export function loadLedger(): Ledger
export function saveLedger(ledger: Ledger): void
```

Storage: `localStorage` key `opencode-desktop:routing-ledger`.

### Free-tier registry — `src/renderer/src/lib/freeTier.ts`

Curated ranked list of tool-calling-capable free models (S / A / B / C tiers), verified against
models.dev + provider docs 2026-07-22. Everything downstream — `PREFERRED_MODELS`, `pickDefaultModel`,
`codingQuality`, `RoutingPanel`, and the picker's free filter — derives from this table.

The predicate is four-valued as of the NanoGPT landing: `'quota' | 'zero-price' | 'subscription' |
'never'`. `'subscription'` returns `true` for the provider's ENTIRE catalogue and is deliberately not
model-gated (the catalogue is fetched live and changes without a desktop release). Only add a
provider to `SUBSCRIPTION_PROVIDERS` when its exposed catalogue and billing path are both
subscription-scoped — see the NanoGPT section above. `isSubscriptionProvider(providerID)` is exported
for UI badging.

```ts
export type Tier = 'S' | 'A' | 'B' | 'C'
export type TaskKind = 'code' | 'title' | 'summary' | 'commit'

export interface FreeTierEntry {
  providerID: string
  modelID: string
  tier: Tier
  rpm: number
  rpd: number | null // null = opaque quota (e.g. Google)
  note: string
}

export const FREE_MODEL_TIERS: readonly FreeTierEntry[]

// Three-valued predicate: quota-providers use the allowlist; openrouter/huggingface use
// zero-price detection with :free-suffix fallback; every other provider is never free.
// Rejects the broken `cost == 0` predicate — SDK Model.cost defaults to 0 for unknowns.
export function isFreeModel(providerID: string, modelID: string, cost?: { input: number; output: number } | null): boolean

// Sub-pools by task kind. 'code' → S+A; 'title'/'summary'/'commit' → C+B (save quota).
// NOTE: taskKind wiring for internal paths (sessions.summarize, /commit, /compact) is out of scope
// for this landing — the pool selector is ready but call sites still route through 'code'.
export function poolForTask(task: TaskKind): readonly FreeTierEntry[]

export const FREE_PROVIDER_CAPS: ModelCapsMap        // seed caps (google rpm:10, groq rpm:30 rpd:1000, …)
export const FREE_PREFERRED_MODELS                   // ordered S→A, drives PREFERRED_MODELS
export const FREE_FALLBACK_PROVIDER_ORDER            // drives FALLBACK_PROVIDER_ORDER
export function freeCodingQuality(providerID, modelID): number | null   // tier-based (S=5 … C=2)
```

### Structured error classifier — `src/renderer/src/lib/rotation.ts`

Replaces the old `isRateLimitError` substring matcher. Rejects false-positive `overloaded` /
`capacity` as rate limits (R10), splits daily quota (`rpd-drop`) from per-minute (`rpm-wait`),
supports `statusCode` + `isRetryable` from SDK ApiError:

```ts
export type ErrorClass = 'rpm-wait' | 'rpd-drop' | 'timeout' | 'transient' | 'client' | 'server'
export function classifyError(
  errStr: string,
  opts?: { statusCode?: number; isRetryable?: boolean; retryAfterMs?: number }
): ErrorClass

/** @deprecated Wrapper over classifyError. Kept for one release. */
export function isRateLimitError(errStr: string): boolean
```

### Attempt state machine — `src/renderer/src/lib/attempts.ts`

Pure reducer + effect descriptors specifying the correct failover semantics. Store.ts implements
the same semantics inline; the reducer + 31 unit tests are the executable spec:

```ts
export interface AttemptState {
  attemptId: number
  messageID: string | null
  chosenProviderID / chosenModelID: string | null          // user pin
  effectiveProviderID / effectiveModelID: string | null    // currently running
  retries: number  maxRetries: number                       // per-exchange, reset on clean idle
  toolExecuted: boolean  hasStreamed: boolean               // R1 side-effect guards
  ttftMs: number  stallMs: number
  watchdog: 'ttft' | 'stall' | 'paused' | 'idle'
  pauseReason: 'tool' | 'permission' | 'retry' | null       // R5
  failoverInFlight: boolean                                 // R3 single-entry guard
  history: FailoverRecord[]
  taskKind: TaskKind
}

export type AttemptEvent =
  | { type: 'send' | 'stream' | 'tool_started' | 'tool_completed'
      | 'permission_asked' | 'permission_replied'
      | 'session_retry' | 'session_retry_done'
      | 'idle' | 'abort' | 'set_chosen'
      | 'error' | 'ttft_fired' | 'stall_fired' | 'failover_complete', … }

export type Effect =
  | 'arm_ttft' | 'arm_stall' | 'clear_timer'
  | 'begin_failover' | 'wait_and_retry_same' | 'transient_retry'
  | 'stop' | 'continue_with_next'

export function attemptReducer(state, event): { state, effects[] }
export function isFailedOver(state): boolean
export function canAutoRetry(state): boolean
```

### Store integration (Module 7)

`store.ts` runs a mirror machine over module-level `activeAttempt` — same fixes, no reducer import,
so all edits stay local. Highlights:

- Single-entry `beginFailover(sessionID, directory, text, parts, reason)` — the ONLY retry path.
  Guards: `failoverInFlight`, `rotateRetries < 3`, `!toolExecuted && !hasStreamed`, revert succeeds.
- Transactional: `await api().revertMessage({ …, messageID: lastPrompt.userMessageID })` before every re-send.
- Two watchdogs: TTFT (arm on send, clear on first text/reasoning part) and stall (re-arm on each new part;
  paused during `pauseForTool` / `pauseForPermission` / `session.status.type === 'retry'`).
- `parseRetryAfterMs()` consumes `Retry-After`, `X-RateLimit-Reset`, and `X-RateLimit-Reset-After` from
  the SDK's `ApiError.data.responseHeaders`. No main-process changes required — the SDK type already
  plumbs these; the old renderer cast just discarded them.
- `rotateToNextFreeModel` filters by `isFreeModel` and mutates only `providerID`/`modelID` (never
  `pinnedProviderID`/`pinnedModelID` or prefs). Failover chip in StatusBar shows the delta.

## Artifacts Side Panel — `src/renderer/src/lib/artifacts.ts` (Module 5)

Pure module for extracting, versioning, and managing code/renderable artifacts from chat messages.

```ts
export type ArtifactType = 'code' | 'html' | 'svg' | 'mermaid' | 'markdown'

export type ArtifactVersion = {
  version: number
  content: string
  messageID: string
}

export type Artifact = {
  id: string
  title: string
  type: ArtifactType
  language?: string
  version: number
  versions: ArtifactVersion[]
  currentContent: string
  messageID: string
}

export function extractArtifactsFromMessages(messages: MessageWithParts[]): Artifact[]
export function getArtifactTitle(type: ArtifactType, lang?: string, filename?: string): string
```

Store additions in `AppState`:
- `activeArtifactID: string | null`
- `setActiveArtifactID(id: string | null): void`

Security model:
- Sandboxed iframe host for HTML/SVG previews: `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer">`
- **NEVER** set `allow-same-origin` on artifact previews to prevent renderer context leakage.
- Main process `will-navigate` / `will-frame-navigate` / `setWindowOpenHandler` blocks external frame navigation.


Agent C (chat) and Agent D (shell) both import from the store; props stay minimal.

```tsx
// Agent D
<Sidebar />                                    // reads store directly
<ModelPicker />                                // reads store directly
<ProviderPanel open={boolean} onClose={() => void} />
<SettingsPanel open={boolean} onClose={() => void} />

// Agent C
<Chat />                                       // reads store directly
<MessageView message={MessageWithParts} />
<ToolCall part={ToolPart} />
<Composer />
<PermissionPrompt permission={Permission}
                  onRespond={(r: PermissionResponse) => void} />
```

## Styling

One stylesheet: `src/renderer/src/index.css` (Agent D owns). No Tailwind, no CSS-in-JS.
Plain CSS with custom properties + BEM-ish class names. Dark theme by default,
`@media (prefers-color-scheme: light)` override (and `[data-theme='light']` for explicit
user choice).

Visual language: warm charcoal dark theme / warm ivory light theme, terracotta-clay accent,
serif display headings on top of a sans body. No blue/green accents anywhere.

Class-name namespaces so agents don't collide:
- Agent D: `.app`, `.sidebar`, `.titlebar`, `.modelpicker`, `.providers`, `.banner`
- Agent C: `.chat`, `.msg`, `.tool`, `.composer`, `.perm`

Agent C must **not** edit `index.css`. It writes its own `src/renderer/src/components/chat.css`
and imports it from `Chat.tsx`. Design tokens both use, defined by Agent D in `index.css`:

```
--bg, --bg-alt, --bg-inset, --fg, --fg-dim, --border, --accent, --accent-fg,
--danger, --warn, --ok, --press, --radius, --mono
```

Additional tokens (Agent D owns, added on top of the contract set above — do not remove
any of the names above, only these are new):

```
--serif        display/heading font stack (system serif — Georgia/Iowan/Times), used only
               on .app__boot-title / .app__card-title style headings. Body text stays --sans.
--bg-sunken    darkest/lightest well surface, one step past --bg-inset (e.g. code wells)
--accent-soft  low-opacity accent tint for subtle highlight backgrounds
--card-radius  ~14px, rounder radius for card-like surfaces (.app__card, boot card).
               --radius (~8px) is unchanged and still used for buttons/inputs/etc.
--chat-max-w   ~48rem, the max width of the centered chat column. Agent D defines the
               token only; Agent C (messages.css) is responsible for applying it to
               center the chat content — Agent D's index.css does not reach into chat markup.
```

Palette (dark is default; light applies under `[data-theme='light']` and under
`@media (prefers-color-scheme: light)` for `:root:not([data-theme])` / `[data-theme='auto']`):

- Dark: `--bg #1f1e1d` `--bg-alt #262624` `--bg-inset #30302e` `--bg-sunken #1a1917`
  `--fg #f5f4ee` `--fg-dim #9a968c` `--border #3a3936` `--accent #d97757`
  `--accent-fg #1a1917` `--accent-soft rgba(217,119,87,0.14)`
- Light: `--bg #faf9f5` `--bg-alt #f0eee6` `--bg-inset #e9e6dc` `--bg-sunken #f5f3ec`
  `--fg #2b2a27` `--fg-dim #6b6862` `--border #ddd9cd` `--accent #c96442`
  `--accent-fg #ffffff` `--accent-soft rgba(201,100,66,0.12)`

Reserved right panel: `.app` grid has a 4th `panel` column, collapsed to `0px` width by
default. Adding the `.app--panel` class to the root `.app` element expands that column
(currently unused — reserved for a future Artifacts panel). No component renders into it yet.

## Phase 1 — Code surface (fs / git / terminal / editor deep-links)

Adds a review surface: a scoped file tree, a Monaco diff panel with hunk-level accept/reject, a
real terminal, and a git panel. **This is a review surface, not an IDE** — single-file editing,
no multi-tab workspace, no debugger. Anything beyond reviewing and steering agent output is out
of scope.

**Process ownership is unchanged.** All filesystem, git and PTY work happens in **main**. The
renderer never touches `node:fs`, never shells out, and never holds a PTY handle.

**Module registration pattern (new).** Each new main-process service exports
`register(ipc: IpcMain): void` and owns its own handlers. `ipc.ts` calls `register()` once per
service and adds the channel names to `CHANNELS`. Services never import each other.

```ts
// src/main/fsService.ts, gitService.ts, terminal.ts
export function register(ipc: IpcMain): void
```

### Shared types (exported from `src/preload/index.ts`, importable by the renderer)

```ts
export type GitFileStatus =
  | 'untracked' | 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted' | 'ignored'

export type FileNode = {
  name: string
  path: string                  // POSIX-separated, ALWAYS relative to the session directory
  kind: 'file' | 'dir'
  gitStatus: GitFileStatus | null
  touched: boolean              // edited by the agent during this session
}

export type FileContent = {
  path: string
  text: string
  bytes: number
  truncated: boolean            // true when the file exceeded MAX_READ_BYTES
  sha: string                   // sha256 of the on-disk bytes; the concurrency token
  language: string | null       // Monaco language id, inferred from extension
}

export type DiffLine = { kind: 'ctx' | 'add' | 'del'; text: string }

export type Hunk = {
  id: string                    // stable within one FileDiff: `${oldStart}-${newStart}`
  header: string                // "@@ -a,b +c,d @@"
  oldStart: number; oldLines: number
  newStart: number; newLines: number
  lines: DiffLine[]
  // Set when that side ends without a trailing newline ("\ No newline at end of file").
  // Load-bearing, not cosmetic: without it, applying a file's final hunk silently
  // appends a newline that was never in the source.
  oldNoEofNewline?: boolean
  newNoEofNewline?: boolean
}

export type FileDiff = {
  path: string
  oldPath?: string              // set on renames
  binary: boolean               // when true, `hunks` is empty
  truncated: boolean            // true when hunks were dropped at the 5000-line cap
  hunks: Hunk[]
}

export type GitStatusEntry = {
  path: string
  index: GitFileStatus | null       // staged side
  worktree: GitFileStatus | null    // unstaged side
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
```

### Invoke channels

```ts
// --- filesystem (src/main/fsService.ts) ---
'oc:fs:tree'    (args: { directory: string; path?: string; depth?: number }) => FileNode[]
                // LAZY, one level by default (depth 1, max 3). Never a full recursive walk —
                // a 200k-file repo must not block the main process. Sorted dirs-first, then
                // name. Honours .gitignore. Returns a flat array; consumers must reconstruct
                // nesting from the `path` field and must not rely on array order (merges from
                // multiple levels may append out of sequence).
'oc:fs:read'    (args: { directory: string; path: string }) => FileContent
                // Refuses binaries (NUL byte in the first 8 KB). Truncates past MAX_READ_BYTES
                // (2 MiB) and sets `truncated`.
'oc:fs:write'   (args: { directory: string; path: string; text: string; baseSha: string })
                  => { sha: string }
                // Optimistic concurrency: THROWS if the on-disk sha256 !== baseSha, so an
                // in-flight agent edit is never silently clobbered by the editor panel.
                // Renderer catches and offers reload-or-overwrite.

// --- git (src/main/gitService.ts) ---
'oc:git:status'     (directory: string) => GitStatus | null
                    // `null` = the directory is not a git repository (expected state, not an error).
'oc:git:diff'       (args: { directory: string; path: string; staged?: boolean }) => FileDiff
'oc:git:stage'      (args: { directory: string; paths: string[] }) => GitStatus | null
                    // Returns `null` if the directory is no longer a git repository when re-read.
'oc:git:unstage'    (args: { directory: string; paths: string[] }) => GitStatus | null
                    // Returns `null` if the directory is no longer a git repository when re-read.
'oc:git:stageHunks' (args: { directory: string; path: string; patch: string }) => GitStatus | null
                    // `patch` is a unified diff built in the renderer by lib/hunks.ts and
                    // applied with `git apply --cached -` over stdin.
                    // Returns `null` if the directory is no longer a git repository when re-read.
'oc:git:commit'     (args: { directory: string; message: string; amend?: boolean })
                      => { sha: string }
'oc:git:branches'   (directory: string) => GitBranch[]
                    // Returns `[]` when the directory is not a git repository.
'oc:git:checkout'   (args: { directory: string; branch: string; create?: boolean }) => GitStatus | null
                    // Returns `null` if the directory is no longer a git repository when re-read.
'oc:git:remoteUrl'  (directory: string) => string | null   // normalised https URL, for PR links

// --- terminal (src/main/terminal.ts) ---
'oc:term:start'  (args: { directory: string; cols: number; rows: number }) => { id: TermId }
'oc:term:write'  (args: { id: TermId; data: string }) => void
'oc:term:resize' (args: { id: TermId; cols: number; rows: number }) => void
'oc:term:kill'   (id: TermId) => void

// --- external editor deep link ---
'oc:openEditor'  (args: { directory: string; path: string; line?: number; column?: number }) => void
```

### Send channels (main -> renderer)

```ts
'oc:term:data' ({ id: TermId; data: string })      // PTY output, base64-free UTF-8 chunks
'oc:term:exit' ({ id: TermId; code: number })
```

### Preload bridge additions (`window.api`)

```ts
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
```

### Security invariants — binding, not advisory

1. **Path containment.** Every `path` arriving from the renderer is resolved against the session
   `directory` and validated with `assertSubpath` from `src/main/projectsPaths.ts`. **Reuse it —
   do not write a second containment check.** It already rejects traversal, absolute escapes, the
   base directory itself, and existing symlink/reparse-point segments.
2. **No shell string interpolation for git.** Every git invocation uses an **argv array** through
   `execFile`, never a concatenated command string and never `shell: true`. A branch named
   `; rm -rf /` must be inert.
3. **Never push, never force.** `gitService` exposes no push, no `--force`, no `reset --hard`, no
   history rewriting beyond `commit --amend`. Those are user actions in a real terminal.
4. **PTY confinement.** `oc:term:start` pins `cwd` to the validated session directory and builds
   its environment through the existing `ALLOWLIST`/`ALIASES` in `src/main/env.ts` — a terminal
   must not inherit decrypted BYOK keys. Every PTY is killed on window close and on app quit;
   PTY handles are keyed per `WebContents` so a reload cannot orphan one.
5. **`oc:openEditor` is scheme-allowlisted.** Only `vscode://`, `vscode-insiders://`, and `cursor://`
   URLs are constructed, and only from a contained path. The renderer never passes a URL — it passes
   a path, and main builds the URL. This prevents `shell.openExternal` becoming an arbitrary-protocol
   gadget. JetBrains support is not implemented (their IDEs use proprietary deep-link schemes like
   `jetbrains://idea/navigate/reference?...` that require project-specific context).
6. **Write concurrency.** `oc:fs:write` is the only renderer-driven write path and is gated on
   `baseSha`. The agent's own edits go through OpenCode's tools as before and are unaffected.
7. **Output bounds.** `oc:fs:read` caps at 2 MiB; `oc:git:diff` caps at 5 000 lines per file and
   sets `binary` rather than streaming blobs; PTY output is chunked and back-pressured.

### Renderer modules

```ts
// src/renderer/src/lib/hunks.ts — PURE. No store, no React, no IPC. Fully unit-tested.
export function parseUnifiedDiff(text: string): FileDiff
export function selectedHunksToPatch(diff: FileDiff, hunkIds: string[]): string
export function applyHunksToText(original: string, diff: FileDiff, hunkIds: string[]): string
// applyHunksToText backs "accept some hunks" in the editor; selectedHunksToPatch backs
// "stage some hunks" through git apply --cached. Both must agree on hunk identity.

// src/renderer/src/lib/filelinks.ts — PURE.
export function findFileRefs(text: string, directory: string): Array<{ path: string; line?: number; column?: number; start: number; end: number }>
// Recognises "src/foo.ts:42", "at src/foo.ts:42:7", and bare repo-relative paths. Used to
// linkify tool output and stack traces. Must not match URLs or bare numbers.
```

### Store slices

`store.ts` is split into slices under `src/renderer/src/lib/slices/` (see Phase 0). Phase 1 adds:

```ts
// fileTree slice
treeRoot: FileNode[]; treeExpanded: Set<string>; treeLoading: boolean
loadTree(path?: string): Promise<void>; toggleTreeDir(path: string): Promise<void>
refreshTree(): Promise<void>               // debounced ~300ms; re-fetches root + expanded dirs, keeps expansion

// editor slice
openFile: FileContent | null; openFileDirty: boolean
openFileBaseText: string | null            // last on-disk text; the baseline openFileDirty compares against
openFileDiff: FileDiff | null; acceptedHunkIds: string[]
openPath(path: string, line?: number): Promise<void>
setOpenFileText(text: string): void        // buffer an edit; openFileDirty = text !== openFileBaseText
saveOpenFile(): Promise<void>              // writes via oc:fs:write; THROWS on baseSha conflict
toggleHunk(id: string): void; applyAcceptedHunks(): Promise<void>; closeFile(): void

// git slice
gitStatus: GitStatus | null; gitBranches: GitBranch[]
gitStatusFor: string | null                // directory the last status resolved for; null gitStatus + match === not a repo
refreshGit(): Promise<void>; stagePaths(paths: string[]): Promise<void>
unstagePaths(paths: string[]): Promise<void>
checkoutBranch(branch: string, create?: boolean): Promise<void>
stageHunks(path: string, hunkIds: string[]): Promise<void>
commit(message: string): Promise<void>; generateCommitMessage(): Promise<string>
changedDiffs: Record<string, FileDiff>     // every changed path's diff, keyed by path — backs the Changes tab
changedDiffsLoading: boolean
loadChangedDiffs(): Promise<void>          // refetches from current gitStatus; per-file failures drop, batch survives

// terminal slice
terminals: Array<{ id: TermId; title: string }>; activeTermID: TermId | null
startTerminal(): Promise<void>; setActiveTermID(id: TermId | null): void
killTerminal(id: TermId): Promise<void>

// ui slice
panelTab: 'files' | 'editor' | 'git' | 'terminal' | 'artifacts' | 'changes' | null   // null = panel collapsed
setPanelTab(tab: AppState['panelTab']): void
paletteOpen: boolean; setPaletteOpen(open: boolean): void

// agent slice (harness controls — in-memory, keyed by session id)
agents: Agent[]                              // registry for the active directory; picker filters primary/all
sessionAgents: Record<string, string>        // pinned agent per session; absent = server default
sessionReadOnly: Record<string, boolean>     // true sends READONLY_TOOLS (lib/toolPolicies.ts) on every prompt
loadAgents(directory: string): Promise<void>
setSessionAgent(sessionID: string, agent: string | null): void
setSessionReadOnly(sessionID: string, readOnly: boolean): void
// sessionSlice also owns unrevertSession(): oc:messages:unrevert, upserts the returned
// session (revert cleared), then reloads the transcript.
// sessionSlice also owns branchFromMessage(messageID): oc:session:fork, upserts the
// returned (new, non-destructive) session, then switches to it via selectSession.
```

Renderer-internal drag contract: dragging a file out of the tree sets the MIME type
`application/x-opencode-file-path` (exported as `FILE_TREE_DRAG_MIME` from
`FileTree.tsx`) to the workspace-relative `FileNode.path`, plus the same string on
`text/plain` for external drop targets. The composer accepts both this and an OS file
drag — a same-window HTML5 drag never populates `dataTransfer.files`, which is why the
custom type exists.

`refreshGit()` and `refreshTree()` are each debounced (300 ms) and are both triggered by the
existing `file.edited` SSE event — the agent editing a file must update the git panel, and an
agent creating or deleting one must update the file tree, without polling.

### CSS namespaces

New per-component stylesheets, imported from their own `.tsx`. No new global tokens beyond the
two below; everything else reuses the existing token set.

- `.tree`  → `src/renderer/src/components/tree.css`
- `.editor` → `src/renderer/src/components/editor.css`
- `.git`   → `src/renderer/src/components/git.css`
- `.term`  → `src/renderer/src/components/term.css`
- `.palette` → `src/renderer/src/components/palette.css`
- `.panel` (shared panel chrome: tab strip, resizer, empty states) →
  `src/renderer/src/components/panels.css`

New global tokens (added to `index.css`):

```
--panel-w      default width of the right panel column when expanded (~34rem)
--panel-min-w  minimum drag width (~22rem)
```

The reserved 4th `panel` grid column in `.app` becomes a **real, resizable, tabbed region**.
`.app--panel` continues to expand it; the width is driven by `--panel-w`, persisted to prefs.

### Dependencies added

| Package | Used by | Risk |
|---|---|---|
| `monaco-editor` | editor panel | Large bundle; must be lazy-imported and locally bundled — no CDN (the renderer CSP forbids it). |
| `xterm` + `xterm-addon-fit` | terminal UI | Low. |
| `node-pty` | terminal backend | **HIGH — native module.** Requires a rebuild against Electron 43 ABI on Windows (ConPTY). This is spiked and go/no-go'd before any terminal UI work is scheduled. Fallback if it fails: a non-interactive `child_process` command runner with streamed output — degraded, but shippable, and the `oc:term:*` contract above is deliberately shaped so the fallback can satisfy it unchanged. |

## Agentic harness (single-agent runner)

A main-process orchestration layer (`src/main/harness/`) that runs self-contained,
single-agent LLM tasks with tool calling across multiple providers. It runs **alongside** the
`opencode serve` integration — the serve flow remains the primary chat path; the harness is
for one-shot agentic task runs, not interactive chat. All state lives in main; the renderer
talks to it only through the `oc:harness:*` channels below.

Providers are resolved through the `ProviderAdapter` interface
(`src/main/harness/providers/adapter.ts`); the registry
(`src/main/harness/providers/registry.ts`) currently supports the provider ids `nanogpt`
and `google` (Gemini) and **throws on any other id**. Custom profiles persist to
`userData/harness-profiles.json`; the built-in profiles (`orchestrator`, `researcher`,
`coder`, `reviewer`) are merged in at read time, are never persisted, and cannot be saved
over or deleted — clone them first.

### Core types

Transcribed from the harness sources. These types cross IPC, so the preload re-exports
them (or structurally identical mirrors) for the renderer.

```ts
// src/main/harness/profiles.ts
export type AgentProfile = {
  id: string                       // lowercase [a-z0-9_-], ≤64 chars (validated)
  name: string
  description?: string

  // ── Model Selection ──
  provider: string                 // must be a registry-supported id ('nanogpt' | 'google')
  model: string
  fallbackModels?: string[]

  // ── Generation Parameters ──
  temperature?: number             // 0..2
  maxTokens?: number               // 1..1_000_000
  topP?: number                    // 0..1
  thinking?: { enabled: boolean; budget?: number }

  // ── System Prompt & Persona ──
  systemPrompt?: string
  systemPromptFile?: string

  // ── Tool Access ──
  tools?: string[]                 // tool names; '*' = all
  toolDenyList?: string[]
  readOnly?: boolean               // restricts the run to category 'read' tools

  // ── Concurrency & Budget ──
  maxConcurrent?: number           // 1..50
  maxTurns?: number                // 1..500; default 50
  tokenBudget?: number             // input-token hard stop (enforced by AgentRunner)
  costBudget?: number              // accepted + reserved; NOT yet enforced (no pricing source)

  // ── Routing (NanoGPT only) ──
  routingSuffix?: string           // ':fast' | ':cheap' | ':speed' | ':price'
  billingRoute?: 'subscription' | 'standard'
  caching?: boolean

  // ── Metadata ──
  builtin?: boolean                // built-ins are read-only
  createdAt?: number
  updatedAt?: number
}

// src/main/harness/tools/registry.ts
export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>           // JSON Schema object
  category: 'read' | 'write' | 'shell' | 'web' | 'custom'
}

// src/main/harness/runner.ts
export type RunnerEvent =
  | { type: 'thinking'; content: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; output: string; error?: string }
  | { type: 'error'; message: string }
  | { type: 'done'; result: RunnerResult }
  | { type: 'budget_warning'; field: string; used: number; limit: number }

export type RunnerResult = {
  content: string
  toolCallCount: number
  usage: { input: number; output: number; reasoning?: number }
  turns: number
  finishReason: 'complete' | 'budget_exceeded' | 'max_turns' | 'aborted' | 'error'
  error?: string
}

// src/main/harness/controller.ts
export type RunStatus = {
  id: string                       // runId (uuid, minted by main on start)
  profileId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  turns: number
  usage: { input: number; output: number }
  startedAt: number
  completedAt?: number
  result?: RunnerResult
  error?: string
}
```

Built-in tools (registered by `src/main/harness/tools/builtins.ts`):

| Tool | Category | Purpose |
|---|---|---|
| `fs_read` | read | Read file contents (contained, 2 MiB cap) |
| `fs_write` | write | Write file contents (contained) |
| `fs_list` | read | List directory contents (contained) |
| `grep` | read | ripgrep search (contained) |
| `shell` | shell | Execute a command, cwd contained, output capped |
| `web_search` | web | Web search |
| `web_fetch` | web | Fetch a URL |
| `think` | read | Scratchpad — returns its input |

A profile's effective tool set is filtered by `tools` / `toolDenyList` / `readOnly`
(`ToolRegistry.forProfile`). Custom tools are declared per project under
`{project}/.opencode/harness/tools/*.json` and surface with category `'custom'`.

### Invoke channels (renderer -> main, `ipcMain.handle`)

```ts
// --- agentic harness (src/main/harness/, via HarnessController) ---
'oc:harness:profiles:list'   () => AgentProfile[]       // built-ins + custom merged
'oc:harness:profiles:get'    (id: string) => AgentProfile | null
'oc:harness:profiles:save'   (profile: unknown) => AgentProfile
                             // validated in main (validateProfile); THROWS on a
                             // profile marked builtin — clone it first.
'oc:harness:profiles:delete' (id: string) => boolean    // THROWS on a built-in id
'oc:harness:profiles:test'   (id: string) => boolean
                             // probes the profile's provider connectivity; false
                             // for unknown ids or unreachable providers.
'oc:harness:run:start'       (args: { profileId: string; task: string; directory: string })
                               => string                 // the runId
                             // THROWS on unknown profile or unsupported provider.
'oc:harness:run:stop'        (runId: string) => void    // aborts; no-op if not running
'oc:harness:run:status'      (runId: string) => RunStatus | null
'oc:harness:run:list'        () => RunStatus[]
'oc:harness:tools:list'      () => ToolDefinition[]     // built-ins + project custom tools
```

### Send channels (main -> renderer, `webContents.send`)

```ts
'oc:harness:event'  ({ runId: string; event: RunnerEvent })
                    // every runner event, forwarded verbatim per run; a run always
                    // terminates in a 'done' (or 'error') event.
```

### Preload bridge additions (`window.api`)

```ts
harness: {
  profiles: {
    list(): Promise<AgentProfile[]>
    get(id: string): Promise<AgentProfile | null>
    save(profile: unknown): Promise<AgentProfile>
    remove(id: string): Promise<boolean>                 // -> 'oc:harness:profiles:delete'
    test(id: string): Promise<boolean>
  }
  run: {
    start(a: { profileId: string; task: string; directory: string }): Promise<string> // runId
    stop(runId: string): Promise<void>
    status(runId: string): Promise<RunStatus | null>
    list(): Promise<RunStatus[]>
  }
  tools: { list(): Promise<ToolDefinition[]> }
  onEvent(cb: (e: { runId: string; event: RunnerEvent }) => void): () => void  // returns unsubscribe
}
```

### Security invariants — binding, not advisory

1. **Keys never cross IPC.** Provider keys are resolved transiently in main via
   `loadByokEnv()` (the same encrypted BYOK store as the serve flow) at request time and
   are handed only to the provider adapter. No key material is ever returned across the
   bridge, logged, or written to `harness-profiles.json` — the renderer never sees it.
2. **Path containment.** Filesystem tool executors validate every path with
   `assertSubpath` from `src/main/projectsPaths.ts` against the run's `directory` — the
   same containment helper as the rest of the app, not a second check.
3. **Custom tools are argv-array only.** Tools declared under
   `{project}/.opencode/harness/tools/*.json` execute via `execFile` argv arrays with
   `cwd` pinned to the project directory — never a concatenated shell string, never
   `shell: true`.
4. **Enforced budgets are hard stops in code.** `maxTurns` and `tokenBudget` are enforced
   by `AgentRunner` before each turn — they are not instructions to the LLM and cannot be
   talked past. Exhaustion ends the run with
   `finishReason: 'budget_exceeded' | 'max_turns'` (plus a `budget_warning` event).
   `costBudget` is accepted on profiles and reserved for a future pricing data source,
   but is **not yet enforced** — do not rely on it as a spend cap.
5. **NanoGPT goes through the existing rate limiter.** Harness NanoGPT requests share the
   app's rate limiting, so a runaway agent loop cannot hammer the API.

### Deferred follow-ups — do not code against these

The multi-agent DAG orchestrator and the additional provider adapters (`openai-compat`,
`anthropic`, `opencode-bridge`) are deliberately deferred. The `opencode serve` flow
remains the primary chat path; the harness does not replace it.

## Leroy sidecar (gemini-live-agent)

The Live window can run the **Leroy** harness — the `gemini-live-agent` Python project — as
a child process instead of the built-in `oc:live:*` path. It adds local tool calling with
per-call approval gating, dual-key tier failover on 429, session resumption, and a
usage/cost readout. The built-in path stays the default and is unchanged.

```
Live window (renderer) --oc:leroy:*--> main/leroy/sidecar.ts --NDJSON--> python bridge_stdio.py --> Supervisor
```

- **One child per window**, keyed by `webContents.id` exactly like `geminiLive.ts`, killed
  when that window is destroyed and on app quit (`stopAllLeroy`).
- **The child owns the microphone, speaker and screen capture.** In Leroy mode the renderer
  must NOT also run the mic worklet or the canvas frame pump — the two would compete for
  the same devices.
- **NDJSON both ways**, one JSON object per line. stdout carries only protocol frames; the
  Python side logs to stderr. `LEROY_PROTOCOL_VERSION` (1) is checked at the `ready`
  handshake and a mismatch kills the child rather than guessing.
- **Frames sent before `ready` are queued**, then flushed in order — the child emits its
  handshake before it will read a `connect`.
- **Location:** `agentDir` option, else `LEROY_AGENT_DIR`, else `~/projects/gemini-live-agent`.
  The interpreter is that checkout's `.venv` when present, else `python`/`python3` on PATH.

### Security invariants — binding, not advisory

1. **Keys go through the environment, never argv or the protocol.** `startLeroy` reads the
   Google key via `loadByokEnv()` and passes it in the child env built by `buildChildEnv`
   (the same allowlist the opencode child gets). argv is world-readable in the process table.
2. **A second key is optional and opt-in.** `GOOGLE_API_KEY_FREE` is forwarded only when
   configured; its presence is what arms the dual-tier fallback cascade on the Python side.
3. **Every renderer command is validated in main** (`validateLeroyCommand`) before it
   reaches stdin. `call_id` is charset-restricted and text is length-capped so a crafted
   value cannot forge a second NDJSON frame — notably a `set_gating_mode: yolo` that would
   disable approval prompts.
4. **Nothing the child writes is trusted.** `parseLeroyEvent` drops unknown types, non-JSON
   lines and wrongly-typed fields instead of forwarding them, so a stray print or a newer
   sidecar cannot take the session down.
5. **stderr is redacted** before it reaches the renderer in a `sidecar_exit` frame.
6. **Approval gating is the user's, not the model's.** A `tool_approval_requested` event
   must be answered by an explicit user action; the renderer never auto-approves.

### Deferred follow-ups — do not code against these

The audit journal still writes to disk on the Python side but is not surfaced in the UI,
and the sidecar is not bundled by electron-builder — Leroy mode requires the checkout.

## Conventions

- TypeScript strict. No `any` in exported signatures (`any` inside event payload narrowing is fine).
- React 19 function components, hooks only. No class components.
- Named exports for components; `export function Chat() {}`.
- Node built-ins in main use the `node:` prefix (`node:child_process`, `node:path`).
- No `console.log` left in renderer code paths that run per-event.
- Windows first: spawn OpenCode via `opencode.cmd`; never assume a POSIX shell.
