/**
 * The preload bridge surface, plus the error normaliser every slice shares.
 *
 * The renderer never speaks HTTP and never imports SDK runtime code — all traffic
 * goes through `window.api`.
 */

import type {
  AppSettings,
  AppSettingsResult,
  MessageWithParts,
  OcEvent,
  PermissionConfig,
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
  GeneratedImageMeta,
  NanogptGenerateArgs,
  NanogptGenerateResult,
  NanogptModelsResult,
  NanogptRefreshResult,
  NanoUsage,
  NanoBalance,
  WeeklyTokenData,
  FileNode,
  FileContent,
  FileDiff,
  GitStatus,
  GitBranch,
  TermId,
  AgentProfile,
  RunStatus,
  HarnessToolDefinition,
  HarnessEventPayload,
  KeyRow
} from '../types'

export interface OpencodeApi {
  status(): Promise<ServerStatus>
  restart(): Promise<ServerStatus>
  pickDirectory(): Promise<string | null>
  sessions: {
    list(directory: string): Promise<Session[]>
    /** parentID creates a child session (subagent tab, side chat) instead of a root one. */
    create(directory: string, title?: string, parentID?: string): Promise<Session>
    remove(directory: string, id: string): Promise<void>
    update(directory: string, id: string, title: string): Promise<Session>
    summarize(a: { directory: string; sessionID: string; providerID: string; modelID: string }): Promise<boolean>
    init(a: { directory: string; sessionID: string; providerID: string; modelID: string; messageID: string }): Promise<boolean>
    todos(directory: string, sessionID: string): Promise<Todo[]>
    command(a: { directory: string; sessionID: string; command: string; arguments: string }): Promise<void>
  }
  commands: { list(directory: string): Promise<ServerCommand[]> }
  find: { files(directory: string, query: string): Promise<string[]> }
  vcs: { get(directory: string): Promise<{ branch: string } | null> }
  projects: {
    list(): Promise<ProjectRecord[]>
    create(name: string): Promise<ProjectRecord>
    getInstructions(directory: string): Promise<string>
    setInstructions(directory: string, text: string): Promise<void>
    listKnowledge(directory: string): Promise<import('../types').KnowledgeFile[]>
    addKnowledge(directory: string, filePaths?: string[]): Promise<import('../types').KnowledgeFile[]>
    removeKnowledge(directory: string, filename: string): Promise<void>
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
    list(): Promise<KeyRow[]>
    set(a: { providerID: string; key: string }): Promise<void>
    remove(providerID: string): Promise<void>
    test(providerID: string): Promise<{ ok: boolean; status?: number; detail?: string }>
  }
  nanogpt: {
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
  messages(directory: string, sessionID: string): Promise<MessageWithParts[]>
  revertMessage(a: { directory: string; sessionID: string; messageID: string }): Promise<void>
  unrevertMessage(a: { directory: string; sessionID: string }): Promise<Session>
  /** Branches a new session from `messageID`, leaving the source session untouched. */
  forkSession(a: { directory: string; sessionID: string; messageID: string }): Promise<Session>
  agents(directory: string): Promise<Agent[]>
  prompt(a: {
    directory: string
    sessionID: string
    providerID: string
    modelID: string
    text: string
    parts?: PromptPart[]
    /** Per-request tool policy; compare runs use it to disable every mutating tool. */
    tools?: Record<string, boolean>
    /** Agent override from the composer picker; omit for the server default agent. */
    agent?: string
  }): Promise<void>
  abort(directory: string, sessionID: string): Promise<void>
  providers(): Promise<{ providers: Provider[]; default: Record<string, string>; linkedProviderIDs: string[] }>
  replyPermission(a: {
    directory: string
    sessionID: string
    permissionID: string
    response: PermissionResponse
  }): Promise<void>
  openExternal(url: string): Promise<void>
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
      save(profile: unknown): Promise<AgentProfile>
      remove(id: string): Promise<boolean>
      test(id: string): Promise<boolean>
    }
    run: {
      start(params: { profileId: string; task: string; directory: string }): Promise<string>
      stop(runId: string): Promise<void>
      status(runId: string): Promise<RunStatus | null>
      list(): Promise<RunStatus[]>
    }
    tools: { list(): Promise<HarnessToolDefinition[]> }
    onEvent(cb: (payload: HarnessEventPayload) => void): () => void
  }
  onEvent(cb: (e: OcEvent) => void): () => void
  onServer(cb: (s: ServerStatus) => void): () => void
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void
}

export function api(): OpencodeApi {
  const bridge = (window as unknown as { api?: OpencodeApi }).api
  if (!bridge) {
    throw new Error('Preload bridge unavailable — window.api is not defined.')
  }
  return bridge
}

/** Turn anything thrown across IPC into a readable one-liner. */
export function errText(e: unknown): string {
  let raw: string
  if (e instanceof Error) raw = e.message
  else if (typeof e === 'string') raw = e
  else {
    try {
      raw = JSON.stringify(e)
    } catch {
      raw = String(e)
    }
  }
  const cleaned = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').trim()
  return cleaned.length > 0 ? cleaned : 'Something went wrong.'
}
