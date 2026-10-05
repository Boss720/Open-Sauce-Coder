/**
 * Electron app lifecycle: window creation, OpenCode server supervision, event fan-out.
 */
import { app, BrowserWindow, desktopCapturer, dialog, session } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attachContextMenu } from './contextMenu'
import { initCrashLog, logCrash } from './crashlog'
import { isTrustedRendererUrl } from './trustedUrl'
import { createBoundsStore } from './windowBounds'
import { stopAllGeminiLive } from './geminiLive'
import { registerIpc, unregisterIpc } from './ipc'
import { setupApplicationMenu } from './menu'
import { createAppSettingsController, type AppSettingsController } from './appSettings'
import { setupQuickEntry, type QuickEntryController } from './quickEntry'
import { setupLiveWindow, type LiveWindowController } from './liveWindow'
import { setupTray, type TrayController } from './tray'
import { checkForUpdates, cleanupUpdater, setupUpdater, type UpdateStatus } from './updater'
import { getStatus, onEvent, onStatus, startServer, stopServer, type ServerStatus } from './server'
import { stopAllLeroy } from './leroy/sidecar'
import { getHarnessController } from './harness/controller'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL

app.setName('opencode-desktop')
app.setPath('userData', join(app.getPath('appData'), 'opencode-desktop'))

let mainWindow: BrowserWindow | null = null
let shuttingDown = false
let quitRequested = false
let appSettings: AppSettingsController | null = null
let quickEntry: QuickEntryController | null = null
let liveWindow: LiveWindowController | null = null
let tray: TrayController | null = null
const rendererReady = new WeakSet<BrowserWindow>()
const pendingQuickPrompts: string[] = []
let lastUpdateStatus: UpdateStatus = { state: 'idle' }

/* ------------------------------------------------------------------ */
/* window bounds persistence                                           */
/* ------------------------------------------------------------------ */

const MIN_WIDTH = 780
const MIN_HEIGHT = 500

/** The main window's geometry. The Live copilot window owns a separate store. */
const mainBounds = createBoundsStore({
  fileName: 'window-state.json',
  defaults: { x: -1, y: -1, width: 1200, height: 800, maximized: false },
  minWidth: MIN_WIDTH,
  minHeight: MIN_HEIGHT
})

/* ------------------------------------------------------------------ */
/* paths                                                               */
/* ------------------------------------------------------------------ */

/**
 * Electron requires an ESM preload to be named `.mjs`; a CJS build emits `.js`.
 * Probe both so the app works whichever way electron-vite emits the bundle.
 */
function resolvePreload(): string {
  const candidates = [
    join(moduleDir, '../preload/index.mjs'),
    join(moduleDir, '../preload/index.js'),
    join(moduleDir, '../preload/index.cjs')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

function resolveResource(name: string): string {
  const candidates = [
    join(moduleDir, '../../resources', name),
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', name),
    join(process.resourcesPath, 'resources', name)
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

/* ------------------------------------------------------------------ */
/* renderer messaging                                                  */
/* ------------------------------------------------------------------ */

function broadcast(channel: 'oc:event' | 'oc:server' | 'oc:harness:event', payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const contents = win.webContents
    if (contents.isDestroyed()) continue
    contents.send(channel, payload)
  }
}

function broadcastUpdateStatus(payload: UpdateStatus): void {
  lastUpdateStatus = payload
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('update:status', payload)
    }
  }
}

function flushQuickPrompts(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  while (pendingQuickPrompts.length > 0) {
    const text = pendingQuickPrompts.shift()
    if (text) win.webContents.send('quick-entry:prompt', text)
  }
}

/* ------------------------------------------------------------------ */
/* window                                                              */
/* ------------------------------------------------------------------ */

function createWindow(): BrowserWindow {
  const saved = mainBounds.load()
  const usePosition = saved.x !== -1 && saved.y !== -1

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(usePosition ? { x: saved.x, y: saved.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: '#1f1e1d',
    autoHideMenuBar: true,
    title: rendererDevUrl ? 'OpenCode Desktop (Dev)' : 'OpenCode Desktop',
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  attachContextMenu(win.webContents)

  // Restore maximized state after showing
  win.on('ready-to-show', () => {
    rendererReady.add(win)
    if (saved.maximized) win.maximize()
    win.show()
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('oc:server', getStatus())
      win.webContents.send('update:status', lastUpdateStatus)
    }
    flushQuickPrompts(win)
    tray?.refresh()
  })

  // Debounced resize/move persistence plus an immediate save on close.
  mainBounds.attach(win)

  win.on('close', (event) => {
    if (!quitRequested && appSettings?.get().settings.closeToTray) {
      event.preventDefault()
      win.hide()
      tray?.refresh()
    }
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    tray?.refresh()
  })

  // Links must use the explicit, validated `oc:openExternal` IPC capability.
  // Never turn a renderer navigation or popup into an OS-level navigation.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url, rendererDevUrl, join(moduleDir, '../renderer/index.html')))
      event.preventDefault()
  })

  win.webContents.on('will-frame-navigate', (event) => {
    // The application has no legitimate subframe navigations.
    event.preventDefault()
  })

  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  win.webContents.on('console-message', (event) => {
    console.log(`[Renderer Console] [level ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Renderer fail load] code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
  })

  if (rendererDevUrl) {
    void win.loadURL(rendererDevUrl)
  } else {
    void win.loadFile(join(moduleDir, '../renderer/index.html'))
  }

  mainWindow = win
  return win
}

function focusExistingWindow(): void {
  const existing = mainWindow
  if (!existing || existing.isDestroyed()) return
  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
  tray?.refresh()
}

function showMainWindow(): BrowserWindow {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  tray?.refresh()
  return win
}

function hideMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
  tray?.refresh()
}

function sendMainWindowCommand(channel: 'main-menu:new-session'): void {
  const win = showMainWindow()
  const send = (): void => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel)
  }
  if (rendererReady.has(win)) send()
  else win.once('ready-to-show', send)
}

function requestQuit(): void {
  quitRequested = true
  app.quit()
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                           */
/* ------------------------------------------------------------------ */

// Production keeps exactly one instance. Development may opt out so a local build can
// be tested while the installed tray app is still running.
const allowDevelopmentInstance = !app.isPackaged && process.env.OPENCODE_DESKTOP_ALLOW_MULTIPLE === '1'
if (!allowDevelopmentInstance && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusExistingWindow()
  })

  onEvent((event) => {
    broadcast('oc:event', event)
  })

  getHarnessController().setEventCallback((runId, event) => {
    broadcast('oc:harness:event', { runId, event })
  })

  onStatus((serverStatus: ServerStatus) => {
    broadcast('oc:server', serverStatus)
  })

  process.on('uncaughtException', (err) => {
    logCrash('uncaughtException', err)
    try {
      dialog.showErrorBox(
        'OpenCode Desktop crashed',
        String(err instanceof Error ? err.stack ?? err.message : err)
      )
    } catch {
      /* dialog unavailable this early / this late in shutdown — crash log still has it */
    }
    app.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    logCrash('unhandledRejection', reason)
  })

  app.whenReady().then(() => {
    initCrashLog(app)
    app.setAppUserModelId(rendererDevUrl ? 'dev.opencode.desktop.dev' : 'dev.opencode.desktop')

    // Prefer Windows' native share picker. The fallback keeps screen sharing usable on
    // systems where Chromium does not expose that picker to Electron.
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] })
      callback({ video: sources[0] })
    }, { useSystemPicker: true })

    quickEntry = setupQuickEntry({
      preloadPath: resolvePreload(),
      rendererUrl: rendererDevUrl,
      rendererHtmlPath: join(moduleDir, '../renderer/index.html'),
      getMainWindow: () => mainWindow,
      createMainWindow: createWindow,
      onSubmit: (text, win) => {
        if (rendererReady.has(win)) win.webContents.send('quick-entry:prompt', text)
        else pendingQuickPrompts.push(text)
      }
    })
    // The Gemini Live copilot lives in its own floating window so the chat UI
    // keeps running behind it. geminiLive.ts keys sessions by webContents id,
    // so that window owns its Live session independently of the main window.
    liveWindow = setupLiveWindow({
      preloadPath: resolvePreload(),
      rendererUrl: rendererDevUrl,
      rendererHtmlPath: join(moduleDir, '../renderer/index.html')
    })
    appSettings = createAppSettingsController({ onShortcut: () => quickEntry?.toggle() })
    tray = setupTray({
      iconPath: resolveResource('tray-icon.png'),
      isMainWindowVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
      onShow: () => { showMainWindow() },
      onHide: hideMainWindow,
      onNewChat: () => sendMainWindowCommand('main-menu:new-session'),
      onQuickEntry: () => quickEntry?.show(),
      onLiveScreen: () => { liveWindow?.show() },
      onQuit: requestQuit
    })
    setupUpdater(broadcastUpdateStatus, { beforeInstall: () => { quitRequested = true } })
    setupApplicationMenu({
      onCheckForUpdates: () => { void checkForUpdates() },
      onLiveScreen: () => { liveWindow?.show() },
      onQuickEntry: () => quickEntry?.show(),
      onQuit: requestQuit
    })
    registerIpc({
      appSettings,
      onQuickSubmit: (text) => quickEntry?.submit(text),
      ...(liveWindow ? { liveWindow } : {})
    })
    createWindow()

    void startServer().then((serverStatus) => {
      broadcast('oc:server', serverStatus)
    })
    if (app.isPackaged) void checkForUpdates()

    app.on('activate', () => {
      // Keyed on the MAIN window, not the window count: with the Live copilot
      // window open, a window-count check would see a live window and refuse to
      // bring the closed main window back, stranding the user in the copilot.
      if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return
    if (!quitRequested && appSettings?.get().settings.closeToTray) return
    app.quit()
  })

  app.on('before-quit', () => {
    if (shuttingDown) return
    shuttingDown = true
    quitRequested = true
    cleanupUpdater()
    appSettings?.dispose()
    appSettings = null
    tray?.destroy()
    tray = null
    quickEntry?.destroy()
    quickEntry = null
    liveWindow?.destroy()
    liveWindow = null
    stopAllGeminiLive()
    stopAllLeroy()
    stopServer()
    unregisterIpc()
  })

  app.on('will-quit', () => {
    if (shuttingDown) return
    shuttingDown = true
    stopAllGeminiLive()
    stopAllLeroy()
    stopServer()
    unregisterIpc()
  })
}
