/**
 * IPC-handlers — typed, gevalideerd; renderer praat alleen via deze laag.
 * (ADR: renderer is dom, alle logica in main process)
 */

import { ipcMain } from 'electron'
import type { ConnectionConfig, ConnectionSecret, DbObjectRef, ScriptKind } from '@nvag/contracts'
import { connectionStore, historyStore } from './ipc-bootstrap'
import { sessionManager } from './session-manager'
import { queryRunner } from './query-runner'
import * as metadata from './metadata-service'
import * as queryFiles from './query-files'
import { exportResults, saveCsv } from './results-export'
import type { ExportRequest } from '@nvag/contracts'
import { checkQuery } from './security/query-guard'

export function registerIpcHandlers(): void {
  // ------------------------------------------------------------------ connections
  ipcMain.handle('connections:list', () => connectionStore.list())

  ipcMain.handle(
    'connections:save',
    (_e, config: ConnectionConfig, secret?: ConnectionSecret) => {
      return connectionStore.save(config, secret)
    }
  )

  ipcMain.handle('connections:remove', (_e, id: string) => {
    connectionStore.remove(id)
    return { ok: true }
  })

  ipcMain.handle(
    'connections:test',
    async (_e, config: ConnectionConfig, secret?: ConnectionSecret) => {
      const { registry } = await import('./registry')
      const provider = registry.get(config.providerId)
      return provider.testConnection(config, secret)
    }
  )

  // ------------------------------------------------------------------ sessions
  ipcMain.handle(
    'sessions:open',
    async (_e, config: ConnectionConfig, secret?: ConnectionSecret) => {
      return sessionManager.open(config, secret)
    }
  )

  ipcMain.handle('sessions:close', async (_e, sessionId: string) => {
    await sessionManager.close(sessionId)
    return { ok: true }
  })

  // ------------------------------------------------------------------ query
  ipcMain.handle(
    'query:run',
    (event, req: { connectionId: string; sql: string; maxRows?: number; selection?: { start: number; end: number } }) => {
      // Environment safety (ADR-009): alleen wanneer verbinding bekend is
      const conn = connectionStore.get(req.connectionId)
      if (conn) {
        const guard = checkQuery(req.sql, conn.environment)
        if (!guard.allowed) {
          return { executionId: '', blocked: guard.reasons }
        }
      }
      // Verbindingsnaam meesturen voor de SQL-history (server-veld).
      return queryRunner.run({ ...req, server: conn?.name ?? req.connectionId }, event.sender)
    }
  )

  ipcMain.handle('query:start', (_e, executionId: string) => {
    return queryRunner.start(executionId)
  })

  ipcMain.handle('query:cancel', async (_e, executionId: string) => {
    await queryRunner.cancel(executionId)
    return { ok: true }
  })

  ipcMain.handle(
    'query:exportCsv',
    async (event, req: { defaultFileName: string; csv: string }) => {
      return saveCsv(req, event.sender)
    }
  )

  ipcMain.handle(
    'query:exportResults',
    async (event, req: ExportRequest) => {
      return exportResults(req, event.sender)
    }
  )

  // ------------------------------------------------------------------ metadata
  ipcMain.handle('metadata:listDatabases', (_e, connectionId: string) =>
    metadata.listDatabases(connectionId)
  )
  ipcMain.handle('metadata:listSchemas', (_e, connectionId: string, db: string) =>
    metadata.listSchemas(connectionId, db)
  )
  ipcMain.handle(
    'metadata:listTables',
    (_e, connectionId: string, db: string, schema?: string) =>
      metadata.listTables(connectionId, db, schema)
  )
  ipcMain.handle(
    'metadata:listViews',
    (_e, connectionId: string, db: string, schema?: string) =>
      metadata.listViews(connectionId, db, schema)
  )
  ipcMain.handle(
    'metadata:listProcedures',
    (_e, connectionId: string, db: string, schema?: string) =>
      metadata.listProcedures(connectionId, db, schema)
  )
  ipcMain.handle(
    'metadata:listFunctions',
    (_e, connectionId: string, db: string, schema?: string) =>
      metadata.listFunctions(connectionId, db, schema)
  )
  ipcMain.handle(
    'metadata:listTriggers',
    (_e, connectionId: string, db: string, schema?: string) =>
      metadata.listTriggers(connectionId, db, schema)
  )
  ipcMain.handle(
    'metadata:listSequences',
    (_e, connectionId: string, db: string, schema?: string) =>
      metadata.listSequences(connectionId, db, schema)
  )
  ipcMain.handle(
    'metadata:getTableMetadata',
    (_e, connectionId: string, db: string, schema: string, table: string) =>
      metadata.getTableMetadata(connectionId, db, schema, table)
  )
  ipcMain.handle(
    'metadata:getObjectDefinition',
    (_e, connectionId: string, obj: DbObjectRef) =>
      metadata.getObjectDefinition(connectionId, obj)
  )
  ipcMain.handle(
    'metadata:scriptObject',
    (_e, connectionId: string, obj: DbObjectRef, kind: ScriptKind) =>
      metadata.scriptObject(connectionId, obj, kind)
  )

  // ------------------------------------------------------------------ query files
  ipcMain.handle('queryFiles:open', async (event) => {
    return queryFiles.openQueryFile(event.sender)
  })

  ipcMain.handle('queryFiles:save', async (event, content: string, path?: string) => {
    return queryFiles.saveQueryFile(content, path, event.sender)
  })

  // ------------------------------------------------------------------ history (eis 19)
  ipcMain.handle('history:list', (_e, query?: string, limit?: number) => {
    return historyStore.list(query, limit)
  })

  ipcMain.handle('history:clear', () => {
    historyStore.clear()
    return { ok: true }
  })

  // ------------------------------------------------------------------ app
  ipcMain.handle('app:getVersion', () => process.env.npm_package_version ?? '0.1.0')
}
