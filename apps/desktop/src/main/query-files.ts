/**
 * Query Files — openen/opslaan van querybestanden (.sql) via de
 * native dialoog in main process. Renderer krijgt nooit Node-toegang;
 * alles loopt via IPC (ADR: renderer is dom).
 */

import { BrowserWindow, dialog } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'

const SQL_FILTERS = [
  { name: 'SQL files', extensions: ['sql'] },
  { name: 'All files', extensions: ['*'] }
]

function parentWindow(webContents: Electron.WebContents | null): BrowserWindow | null {
  return webContents ? BrowserWindow.fromWebContents(webContents) : null
}

export interface QueryFileOpenResult {
  canceled: boolean
  path?: string
  name?: string
  content?: string
}

export async function openQueryFile(
  webContents: Electron.WebContents | null
): Promise<QueryFileOpenResult> {
  const win = parentWindow(webContents)
  const options = { filters: SQL_FILTERS, properties: ['openFile' as const] }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }
  const path = result.filePaths[0]!
  const content = await readFile(path, 'utf8')
  return { canceled: false, path, name: basename(path), content }
}

export interface QueryFileSaveResult {
  canceled: boolean
  path?: string
}

export async function saveQueryFile(
  content: string,
  path: string | undefined,
  webContents: Electron.WebContents | null
): Promise<QueryFileSaveResult> {
  let target = path
  if (!target) {
    const win = parentWindow(webContents)
    const options = { filters: SQL_FILTERS, defaultPath: 'query.sql' }
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }
    target = result.filePath
  }
  await writeFile(target, content, 'utf8')
  return { canceled: false, path: target }
}
