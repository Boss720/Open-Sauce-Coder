/**
 * Shared harness for the IPC-boundary tests (roadmap M2.3).
 *
 * `ipc.ts` registers every renderer -> main channel against the real `ipcMain`. These tests
 * drive the *real* handlers through a stub `ipcMain`, with every collaborating service
 * mocked, so a test can assert what a handler does with hostile input without booting
 * Electron or the OpenCode server.
 *
 * Mocks are installed with `vi.doMock` + a dynamic import rather than top-level `vi.mock`,
 * because `vi.mock` hoists only within the file it is written in and would not apply to
 * callers of this module.
 */
import { vi, type Mock } from 'vitest'

export type StubHandler = (event: unknown, ...args: unknown[]) => unknown

/** Minimal `WebContents`-alike accepted by the handlers that reach for `event.sender`. */
export function stubEvent(id = 1): { sender: { id: number } } {
  return { sender: { id } }
}

export type IpcHarness = {
  /**
   * Call a registered `ipcMain.handle` channel exactly as the renderer would.
   *
   * Returns `any` deliberately: handler return shapes vary per channel and the tests
   * assert on them directly. Typing this `unknown` would force a cast at every call site
   * for no safety gain — the values are already validated by the assertions.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (channel: string, ...args: unknown[]) => Promise<any>
  /** Emit to a registered `ipcMain.on` channel. */
  send: (channel: string, ...args: unknown[]) => void
  /** Channel names currently registered via `handle`. */
  channels: () => string[]
  /** True when the channel has a registered `handle` listener. */
  has: (channel: string) => boolean
  mocks: HarnessMocks
  ipc: typeof import('../ipc')
}

export type HarnessMocks = ReturnType<typeof buildMocks>

/**
 * Mock return types are deliberately widened to `any`. Tests routinely override a mock
 * with a richer shape than the default (a BrowserWindow-alike for `getFocusedWindow`, a
 * populated `filePaths`, a `{ ok, status, detail }` for `testKey`); inferring the narrow
 * default type would reject those overrides at compile time even though they are exactly
 * what the handler expects at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any

function buildMocks() {
  return {
    // --- electron ---
    showOpenDialog: vi.fn<AnyFn>(async () => ({ canceled: true, filePaths: [] as string[] })),
    showMessageBox: vi.fn<AnyFn>(async () => ({ response: 0, checkboxChecked: false })),
    showSaveDialog: vi.fn<AnyFn>(async () => ({
      canceled: true,
      filePath: undefined as string | undefined
    })),
    openExternal: vi.fn<AnyFn>(async () => undefined),
    showItemInFolder: vi.fn<AnyFn>(),
    fromWebContents: vi.fn<AnyFn>(() => null),
    getFocusedWindow: vi.fn<AnyFn>(() => null),
    writeFile: vi.fn<AnyFn>(async () => undefined),

    // --- server ---
    getStatus: vi.fn<AnyFn>(() => ({ state: 'ready' })),
    restartServer: vi.fn<AnyFn>(async () => ({ state: 'ready' })),
    setEventDirectory: vi.fn<AnyFn>(),
    isAuthorizedProvider: vi.fn<AnyFn>(() => true),
    getAuthorizedProviderIDs: vi.fn<AnyFn>(() => ['openai']),
    getClient: vi.fn<AnyFn>(() => ({})),

    // --- configService ---
    getPermissionConfig: vi.fn<AnyFn>(() => ({}) as Record<string, unknown>),
    setPermissionConfig: vi.fn<AnyFn>(async () => true),
    validatePermissionConfig: vi.fn<AnyFn>((value: unknown) => value),

    // --- keys ---
    listKeys: vi.fn<AnyFn>(() => [] as unknown[]),
    setKey: vi.fn<AnyFn>(),
    deleteKey: vi.fn<AnyFn>(),
    testKey: vi.fn<AnyFn>(async () => true),
    // Read by leroy/sidecar.ts at import time (its default dependency table).
    loadByokEnv: vi.fn<AnyFn>(() => ({}) as Record<string, string>),

    // --- projects ---
    listProjects: vi.fn<AnyFn>(async () => [] as unknown[]),
    createProject: vi.fn<AnyFn>(async () => ({})),
    getProjectInstructions: vi.fn<AnyFn>(async () => ''),
    setProjectInstructions: vi.fn<AnyFn>(async () => true),
    listKnowledge: vi.fn<AnyFn>(async () => [] as unknown[]),
    addKnowledge: vi.fn<AnyFn>(async () => [] as unknown[]),
    removeKnowledge: vi.fn<AnyFn>(async () => [] as unknown[]),

    // --- mcp ---
    getMcpSnapshot: vi.fn<AnyFn>(async () => ({ servers: [] })),
    addMcp: vi.fn<AnyFn>(async () => ({ servers: [] })),
    removeMcp: vi.fn<AnyFn>(async () => ({ servers: [] })),
    connectMcp: vi.fn<AnyFn>(async () => ({ servers: [] })),
    disconnectMcp: vi.fn<AnyFn>(async () => ({ servers: [] })),
    authMcp: vi.fn<AnyFn>(async () => ({ servers: [] })),

    // --- gemini live ---
    startGeminiLive: vi.fn<AnyFn>(async () => undefined),
    stopGeminiLive: vi.fn<AnyFn>(),
    sendGeminiLive: vi.fn<AnyFn>(),
    saveLiveTranscript: vi.fn<AnyFn>(() => 'C:/tmp/transcript.md'),
    revealTranscriptsFolder: vi.fn<AnyFn>(),

    // --- nanogpt ---
    readCache: vi.fn<AnyFn>(async () => ({ chat: [], image: [], balanceBilled: [], fetchedAt: 0 })),
    readCacheSync: vi.fn<AnyFn>(() => ({ chat: [], image: [], balanceBilled: [], fetchedAt: 0 })),
    refreshCatalogs: vi.fn<AnyFn>(async () => ({ ok: true })),
    markBalanceBilled: vi.fn<AnyFn>(),
    fetchSubscriptionUsage: vi.fn<AnyFn>(async () => null),
    fetchBalance: vi.fn<AnyFn>(async () => null),
    generateImage: vi.fn<AnyFn>(async () => ({ images: [] })),
    classifyBilling: vi.fn<AnyFn>(() => 'subscription'),
    listImages: vi.fn<AnyFn>(async () => [] as unknown[]),
    readImage: vi.fn<AnyFn>(async () => null),
    deleteImage: vi.fn<AnyFn>(async () => undefined),
    saveImage: vi.fn<AnyFn>(async () => ({})),
    reconcile: vi.fn<AnyFn>(async () => undefined),
    imagesToday: vi.fn<AnyFn>(async () => 0),
    acquireSlot: vi.fn<AnyFn>(async () => () => {}),
    getWeeklyTokens: vi.fn<AnyFn>(() => ({ used: 0 })),

    // --- crashlog ---
    readCrashLog: vi.fn<AnyFn>(() => ({ entries: [] })),
    getCrashLogPath: vi.fn<AnyFn>(() => 'C:/tmp/crash.log'),

    // --- sub-registrars: assert they are wired, nothing more ---
    registerFs: vi.fn<AnyFn>(),
    registerGit: vi.fn<AnyFn>(),
    registerTerminal: vi.fn<AnyFn>(),
    registerOpenEditor: vi.fn<AnyFn>(),

    // --- fsService argument guard used by the harness run:start handler ---
    requireDirectory: vi.fn<AnyFn>((value: unknown) => {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Invalid IPC argument: directory must be a non-empty string.')
      }
      return value
    }),

    // --- agentic harness controller (singleton accessor) ---
    harnessController: {
      listProfiles: vi.fn<AnyFn>(() => [] as unknown[]),
      getProfile: vi.fn<AnyFn>(() => null),
      saveProfile: vi.fn<AnyFn>(async (profile: unknown) => profile),
      deleteProfile: vi.fn<AnyFn>(async () => true),
      testProfile: vi.fn<AnyFn>(async () => true),
      startRun: vi.fn<AnyFn>(async () => 'run-1'),
      stopRun: vi.fn<AnyFn>(),
      getRunStatus: vi.fn<AnyFn>(() => null),
      listRuns: vi.fn<AnyFn>(() => [] as unknown[]),
      listTools: vi.fn<AnyFn>(() => [] as unknown[]),
      setEventCallback: vi.fn<AnyFn>()
    },
    /** Wired to return `harnessController` in loadIpc unless overridden. */
    getHarnessController: vi.fn<AnyFn>(),

    // --- injected controllers ---
    appSettingsGet: vi.fn<AnyFn>(() => ({ settings: {} })),
    appSettingsSet: vi.fn<AnyFn>(() => ({ settings: {} })),
    liveWindowShow: vi.fn<AnyFn>(),
    liveWindowSetAlwaysOnTop: vi.fn<AnyFn>(),
    liveWindowGetWindow: vi.fn<AnyFn>(() => null),
    onQuickSubmit: vi.fn<AnyFn>()
  }
}

/**
 * Install mocks, import `ipc.ts` fresh, and register every handler against a stub
 * `ipcMain`. Call inside `beforeEach` so module-level caches in `ipc.ts` do not leak
 * between tests.
 */
export async function loadIpc(
  overrides: Partial<Record<keyof HarnessMocks, unknown>> = {}
): Promise<IpcHarness> {
  vi.resetModules()
  const mocks = buildMocks()
  for (const [key, value] of Object.entries(overrides)) {
    ;(mocks as Record<string, unknown>)[key] = value
  }
  if (!overrides.getHarnessController) {
    mocks.getHarnessController.mockReturnValue(mocks.harnessController)
  }

  const handlers = new Map<string, StubHandler>()
  const listeners = new Map<string, Set<StubHandler>>()

  const ipcMain = {
    handle: vi.fn((channel: string, handler: StubHandler) => {
      if (handlers.has(channel)) {
        throw new Error(`duplicate ipcMain.handle for ${channel} — registerIpc is not idempotent`)
      }
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    on: vi.fn((channel: string, listener: StubHandler) => {
      const set = listeners.get(channel) ?? new Set<StubHandler>()
      set.add(listener)
      listeners.set(channel, set)
    }),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel))
  }

  vi.doMock('electron', () => ({
    app: { getPath: vi.fn(() => 'C:/tmp'), isPackaged: false },
    BrowserWindow: { fromWebContents: mocks.fromWebContents, getAllWindows: vi.fn(() => []), getFocusedWindow: mocks.getFocusedWindow },
    dialog: { showOpenDialog: mocks.showOpenDialog, showMessageBox: mocks.showMessageBox, showSaveDialog: mocks.showSaveDialog },
    ipcMain,
    shell: { openExternal: mocks.openExternal, showItemInFolder: mocks.showItemInFolder }
  }))

  vi.doMock('../server', () => ({
    getStatus: mocks.getStatus,
    restartServer: mocks.restartServer,
    setEventDirectory: mocks.setEventDirectory,
    isAuthorizedProvider: mocks.isAuthorizedProvider,
    getAuthorizedProviderIDs: mocks.getAuthorizedProviderIDs,
    getClient: mocks.getClient
  }))
  vi.doMock('../configService', () => ({
    getPermissionConfig: mocks.getPermissionConfig,
    setPermissionConfig: mocks.setPermissionConfig,
    validatePermissionConfig: mocks.validatePermissionConfig
  }))
  vi.doMock('../keys', () => ({
    listKeys: mocks.listKeys,
    setKey: mocks.setKey,
    deleteKey: mocks.deleteKey,
    testKey: mocks.testKey,
    loadByokEnv: mocks.loadByokEnv
  }))
  vi.doMock('../projects', () => ({
    listProjects: mocks.listProjects,
    createProject: mocks.createProject,
    getProjectInstructions: mocks.getProjectInstructions,
    setProjectInstructions: mocks.setProjectInstructions,
    listKnowledge: mocks.listKnowledge,
    addKnowledge: mocks.addKnowledge,
    removeKnowledge: mocks.removeKnowledge
  }))
  vi.doMock('../mcp', () => ({
    getMcpSnapshot: mocks.getMcpSnapshot,
    addMcp: mocks.addMcp,
    removeMcp: mocks.removeMcp,
    connectMcp: mocks.connectMcp,
    disconnectMcp: mocks.disconnectMcp,
    authMcp: mocks.authMcp
  }))
  vi.doMock('../geminiLive', () => ({
    startGeminiLive: mocks.startGeminiLive,
    stopGeminiLive: mocks.stopGeminiLive,
    sendGeminiLive: mocks.sendGeminiLive
  }))
  vi.doMock('../liveTranscripts', () => ({
    saveLiveTranscript: mocks.saveLiveTranscript,
    revealTranscriptsFolder: mocks.revealTranscriptsFolder
  }))
  vi.doMock('../nanogptConfig', () => ({
    readCache: mocks.readCache,
    readCacheSync: mocks.readCacheSync,
    refreshCatalogs: mocks.refreshCatalogs,
    markBalanceBilled: mocks.markBalanceBilled
  }))
  vi.doMock('../nanogpt', () => ({
    fetchSubscriptionUsage: mocks.fetchSubscriptionUsage,
    fetchBalance: mocks.fetchBalance,
    generateImage: mocks.generateImage
  }))
  vi.doMock('../nanogptBilling', () => ({ classifyBilling: mocks.classifyBilling }))
  vi.doMock('../nanogptImages', () => ({
    listImages: mocks.listImages,
    readImage: mocks.readImage,
    deleteImage: mocks.deleteImage,
    saveImage: mocks.saveImage,
    reconcile: mocks.reconcile,
    imagesToday: mocks.imagesToday
  }))
  vi.doMock('../nanogptLimiter', () => ({
    nanogptLimiter: { acquireSlot: mocks.acquireSlot }
  }))
  vi.doMock('../tokenBudgetTracker', () => ({
    tokenBudgetTracker: { getWeeklyTokens: mocks.getWeeklyTokens }
  }))
  vi.doMock('../crashlog', () => ({
    readCrashLog: mocks.readCrashLog,
    getCrashLogPath: mocks.getCrashLogPath
  }))
  vi.doMock('../fsService', () => ({ register: mocks.registerFs, requireDirectory: mocks.requireDirectory }))
  vi.doMock('../gitService', () => ({ register: mocks.registerGit }))
  vi.doMock('../terminal', () => ({ register: mocks.registerTerminal }))
  vi.doMock('../openEditor', () => ({ register: mocks.registerOpenEditor }))
  vi.doMock('../harness/controller', () => ({ getHarnessController: mocks.getHarnessController }))
  vi.doMock('node:fs/promises', () => ({ writeFile: mocks.writeFile, mkdir: vi.fn(), readdir: vi.fn(), stat: vi.fn(), unlink: vi.fn() }))

  const ipc = await import('../ipc')
  ipc.registerIpc({
    appSettings: { get: mocks.appSettingsGet, set: mocks.appSettingsSet } as never,
    onQuickSubmit: mocks.onQuickSubmit as never,
    liveWindow: {
      show: mocks.liveWindowShow,
      setAlwaysOnTop: mocks.liveWindowSetAlwaysOnTop,
      getWindow: mocks.liveWindowGetWindow
    } as never
  })

  return {
    invoke: async (channel, ...args) => {
      const handler = handlers.get(channel)
      if (!handler) throw new Error(`no handler registered for ${channel}`)
      return await handler(stubEvent(), ...args)
    },
    send: (channel, ...args) => {
      for (const listener of listeners.get(channel) ?? []) listener(stubEvent(), ...args)
    },
    channels: () => [...handlers.keys()],
    has: (channel) => handlers.has(channel),
    mocks,
    ipc
  }
}

/** Inputs every `requireString` / `requireObject` guard must reject. */
export const HOSTILE_STRINGS: unknown[] = [undefined, null, '', '   ', 42, true, {}, [], Symbol.for('x')]
export const HOSTILE_OBJECTS: unknown[] = [undefined, null, 'string', 42, true]

/** Assert a handler rejects each hostile value with the standard guard error. */
export async function expectRejectsAll(
  invoke: (value: unknown) => Promise<unknown>,
  values: unknown[]
): Promise<void> {
  const { expect } = await import('vitest')
  for (const value of values) {
    await expect(invoke(value), `expected rejection for ${String(value)}`).rejects.toThrow()
  }
}

export type { Mock }
