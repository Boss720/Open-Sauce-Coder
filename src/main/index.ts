/**
 * Electron app lifecycle: window creation, OpenCode server supervision, event fan-out.
 */
import { app, BrowserWindow, desktopCapturer, dialog, session } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
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
import { getHarnessController, stopAllHarnessRuns } from './harness/controller'
import { getDagController, stopAllDagRuns } from './harness/dag'
import { setSyncProcessKill } from './harness/tools/processKill'
import { sanitizeLogLine } from './logRedact'

/** Cap on lifecycle.log; past this it is rotated to lifecycle.log.1 (one generation). */
const LIFECYCLE_LOG_MAX_BYTES = 1024 * 1024

function logLifecycle(msg: string): void {
  try {
    const dir = join(app.getPath('appData'), 'opencode-desktop')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'lifecycle.log')
    try {
      if (statSync(file).size > LIFECYCLE_LOG_MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      /* no log yet */
    }
    appendFileSync(
      file,
      `[${new Date().toISOString()}] [PID ${process.pid}] ${sanitizeLogLine(msg)}\n`
    )
  } catch {
    /* best-effort */
  }
}

/**
 * Abort live harness and DAG runs so the shells their tools spawned die with the app.
 * Electron exits ~60 ms after 'before-quit', so tree kills are made synchronous first;
 * an async taskkill would be cut off mid-run and orphan the grandchildren.
 */
function abortHarnessRuns(): void {
  try {
    setSyncProcessKill(true)
  } catch (err) {
    logLifecycle(`setSyncProcessKill failed: ${err}`)
  }
  try {
    stopAllHarnessRuns()
  } catch (err) {
    logLifecycle(`stopAllHarnessRuns failed: ${err}`)
  }
  try {
    stopAllDagRuns()
  } catch (err) {
    logLifecycle(`stopAllDagRuns failed: ${err}`)
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url))
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const isDevelopmentRun = !app.isPackaged && Boolean(rendererDevUrl)

app.setName('opencode-desktop')
// Keep Chromium's profile lock and development settings separate from the installed app.
// Otherwise launching `npm run dev` while the tray app is open makes Electron exit before
// it can create a window.
app.setPath('userData', join(app.getPath('appData'), isDevelopmentRun ? 'opencode-desktop-dev' : 'opencode-desktop'))

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

function broadcast(
  channel: 'oc:event' | 'oc:server' | 'oc:harness:event' | 'oc:dag:event',
  payload: unknown
): void {
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

  logLifecycle(`createWindow starting width=${saved.width} height=${saved.height}`)
  attachContextMenu(win.webContents)

  // Restore maximized state after showing
  // Fallback: if ready-to-show never fires, show anyway so the window cannot stay invisible.
  const showFallback = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      logLifecycle('win ready-to-show fallback timer: showing window')
      win.show()
    }
  }, 10_000)
  showFallback.unref()
  win.once('closed', () => clearTimeout(showFallback))

  win.on('ready-to-show', () => {
    clearTimeout(showFallback)
    logLifecycle('win.ready-to-show fired')
    rendererReady.add(win)
    if (saved.maximized) win.maximize()
    win.show()
    try {
      const hwnd = win.getNativeWindowHandle().readInt32LE(0)
      logLifecycle(`win ready-to-show complete: HWND=${hwnd} isVisible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}`)
    } catch (e) {
      logLifecycle(`win error getting HWND: ${e}`)
    }
    if (!win.webContents.isDestroyed()) {
      win.webContents.send('oc:server', getStatus())
      win.webContents.send('update:status', lastUpdateStatus)
    }
    flushQuickPrompts(win)
    tray?.refresh()
  })

  win.webContents.on('did-finish-load', () => {
    logLifecycle('win.webContents did-finish-load')
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logLifecycle(`win.webContents render-process-gone: ${JSON.stringify(details)}`)
  })

  // Debounced resize/move persistence plus an immediate save on close.
  mainBounds.attach(win)

  win.on('close', (event) => {
    logLifecycle(`win.close fired, quitRequested=${quitRequested}, closeToTray=${appSettings?.get().settings.closeToTray}`)
    if (!quitRequested && appSettings?.get().settings.closeToTray) {
      event.preventDefault()
      win.hide()
      tray?.refresh()
    }
  })

  win.on('closed', () => {
    logLifecycle('win.closed fired')
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
    // Warnings and errors only (0 verbose, 1 info, 2 warning, 3 error): routine
    // renderer logging does not belong in a persistent on-disk log.
    const level = typeof event.level === 'number' ? event.level : Number(event.level)
    const isWarnOrError = event.level === 'warning' || event.level === 'error' || level >= 2
    // Dev only: echo every level to stdout (never to disk) so tooling can watch
    // for renderer readiness, e.g. "[vite] connected.".
    if (rendererDevUrl) console.log(`[Renderer Console] ${sanitizeLogLine(event.message)}`)
    if (!isWarnOrError) return
    logLifecycle(`[Renderer Console] [level ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logLifecycle(`[Renderer fail load] code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
  })

  if (rendererDevUrl) {
    void win.loadURL(rendererDevUrl)
  } else {
    void win.loadFile(join(moduleDir, '../renderer/index.html'))
  }

  mainWindow = win
  return win
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
  logLifecycle('requestQuit called')
  quitRequested = true
  app.quit()
}

/* ------------------------------------------------------------------ */
/* bootstrap                                                           */
/* ------------------------------------------------------------------ */

// Production keeps exactly one instance. Development may opt out so a local build can
// be tested while the installed tray app is still running.
const allowDevelopmentInstance = !app.isPackaged && process.env.OPENCODE_DESKTOP_ALLOW_MULTIPLE === '1'
const singleInstance = app.requestSingleInstanceLock()
logLifecycle(`lock check: allowDev=${allowDevelopmentInstance} lockAcquired=${singleInstance}`)
if (!allowDevelopmentInstance && !singleInstance) {
  logLifecycle('singleInstanceLock failed -> app.quit()')
  app.quit()
} else {
  app.on('second-instance', () => {
    logLifecycle('second-instance event received -> showMainWindow')
    showMainWindow()
  })

  onEvent((event) => {
    broadcast('oc:event', event)
  })

  getHarnessController().setEventCallback((runId, event) => {
    broadcast('oc:harness:event', { runId, event })
  })

  getDagController().setEventCallback((_dagRunId, event) => {
    broadcast('oc:dag:event', event)
  })

  onStatus((serverStatus: ServerStatus) => {
    broadcast('oc:server', serverStatus)
  })

  process.on('uncaughtException', (err) => {
    logLifecycle(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
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
    logLifecycle(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`)
    logCrash('unhandledRejection', reason)
  })

  app.whenReady().then(() => {
    logLifecycle('app.whenReady resolved')
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

    logLifecycle('createWindow returned, calling startServer')
    void startServer()
      .then((serverStatus) => {
        logLifecycle(`startServer resolved: running=${serverStatus.running} url=${serverStatus.url} error=${serverStatus.error}`)
        broadcast('oc:server', serverStatus)
      })
      .catch((err) => {
        logLifecycle(`startServer rejected: ${err}`)
      })

    if (app.isPackaged) {
      logLifecycle('calling checkForUpdates()')
      void checkForUpdates()
        .then(() => {
          logLifecycle('checkForUpdates resolved')
        })
        .catch((err) => {
          logLifecycle(`checkForUpdates rejected: ${err}`)
        })
    }

    app.on('activate', () => {
      // Keyed on the MAIN window, not the window count: with the Live copilot
      // window open, a window-count check would see a live window and refuse to
      // bring the closed main window back, stranding the user in the copilot.
      if (!mainWindow || mainWindow.isDestroyed()) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    logLifecycle(`app window-all-closed, closeToTray=${appSettings?.get().settings.closeToTray}, quitRequested=${quitRequested}`)
    if (process.platform === 'darwin') return
    if (!quitRequested && appSettings?.get().settings.closeToTray) return
    app.quit()
  })

  app.on('before-quit', () => {
    logLifecycle(`app before-quit, shuttingDown=${shuttingDown}, quitRequested=${quitRequested}`)
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
    abortHarnessRuns()
    stopServer()
    unregisterIpc()
  })

  app.on('will-quit', () => {
    logLifecycle(`app will-quit, shuttingDown=${shuttingDown}`)
    if (shuttingDown) return
    shuttingDown = true
    stopAllGeminiLive()
    stopAllLeroy()
    abortHarnessRuns()
    stopServer()
    unregisterIpc()
  })

  app.on('quit', (_event, exitCode) => {
    logLifecycle(`app.on(quit) exitCode=${exitCode}`)
  })

  process.on('exit', (code) => {
    logLifecycle(`process.on(exit) code=${code}`)
  })
}
