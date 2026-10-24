import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { getCrashLogPath } from './crashlog'

/**
 * Configure standard native application menu bar.
 */
export type ApplicationMenuActions = {
  onCheckForUpdates?: () => void
  onQuit?: () => void
  onLiveScreen?: () => void
  onQuickEntry?: () => void
}

export function setupApplicationMenu(actions: ApplicationMenuActions = {}): void {
  const isMac = process.platform === 'darwin'

  const quitItem: MenuItemConstructorOptions = actions.onQuit
    ? {
        label: `Quit ${app.name}`,
        accelerator: 'CmdOrCtrl+Q',
        click: actions.onQuit
      }
    : { role: 'quit' as const }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              quitItem
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Session',
          accelerator: 'CmdOrCtrl+N',
          click: (): void => {
            const win = BrowserWindow.getFocusedWindow()
            win?.webContents.send('main-menu:new-session')
          }
        },
        { type: 'separator' as const },
        isMac ? { role: 'close' as const } : quitItem
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const, visible: !app.isPackaged },
        { type: 'separator' as const },
        { role: 'resetZoom' as const },
        { role: 'zoomIn' as const },
        { role: 'zoomOut' as const },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Gemini Live',
          accelerator: 'CmdOrCtrl+Shift+L',
          enabled: Boolean(actions.onLiveScreen),
          click: actions.onLiveScreen
        },
        {
          label: 'Quick Entry',
          enabled: Boolean(actions.onQuickEntry),
          click: actions.onQuickEntry
        }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          enabled: Boolean(actions.onCheckForUpdates),
          click: actions.onCheckForUpdates
        },
        { type: 'separator' as const },
        {
          label: 'Show Crash Log',
          click: (): void => {
            const logPath = getCrashLogPath()
            if (logPath) shell.showItemInFolder(logPath)
          }
        },
        { type: 'separator' as const },
        {
          label: 'OpenCode Desktop on GitHub',
          click: () => {
            void shell.openExternal('https://github.com/Boss720/Open-Sauce-Coder')
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}
