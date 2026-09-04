import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerBuiltinProviders } from './registry'
import { bootstrapApp } from './ipc-bootstrap'
import { sessionManager } from './session-manager'
import { installCrashGuards } from './crash-guard'

// SAL-29: zo vroeg mogelijk installeren — een verbroken stdout/stderr-pipe
// (EPIPE) tijdens het loggen van een IPC-fout mag nooit een crashdialoog
// in het main process veroorzaken.
installCrashGuards()

// SAL-81: single-instance lock. Vóór app.whenReady() aanvragen zodat een
// tweede launch nooit een tweede main-process/venster opstart.
const gotTheLock = app.requestSingleInstanceLock()

// Wordt true zodra de initiële startup zelf een venster heeft aangemaakt.
let startupFinished = false

function focusMainWindow(): void {
  const mainWindow = BrowserWindow.getAllWindows()[0]
  if (!mainWindow) {
    // macOS: app draait zonder vensters (window-all-closed quit niet) —
    // tweede start maakt dan een nieuw venster aan. Alleen ná de initiële
    // startup; tijdens het opstarten zorgt de eigen createWindow daarvoor.
    if (startupFinished) createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!gotTheLock) {
  // Tweede instantie: geen eigen venster/lifecycle starten; de actieve
  // instantie wordt via 'second-instance' gefocust.
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.nvag.desktop')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    await registerBuiltinProviders()
    bootstrapApp()
    createWindow()
    startupFinished = true

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    sessionManager.closeAll()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
