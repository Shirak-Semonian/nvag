/**
 * IPC-handlers — typed, gevalideerd; renderer praat alleen via deze laag.
 * (ADR: renderer is dom, alle logica in main process)
 */

import { ipcMain } from 'electron'
import type { ConnectionConfig, ConnectionSecret } from '@nvag/contracts'
import { connectionStore } from './ipc-bootstrap'
import { sessionManager } from './session-manager'
import { queryRunner } from './query-runner'
import * as metadata from './metadata-service'
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
    async (
      _e,
      req: { connectionId: string; sql: string; maxRows?: number; selection?: { start: number; end: number } }
    ) => {
      // Environment safety (ADR-009): alleen wanneer verbinding bekend is
      const conn = connectionStore.get(req.connectionId)
      if (conn) {
        const guard = checkQuery(req.sql, conn.environment)
        if (!guard.allowed) {
          return {
            executionId: '',
            columns: [],
            rows: [],
            truncated: false,
            rowCount: 0,
            durationMs: 0,
            error: `Query geblokkeerd door environment safety (${guard.reasons.join(', ')}). Bevestiging vereist.`,
            blocked: guard.reasons
          }
        }
      }
      return queryRunner.run(req)
    }
  )

  ipcMain.handle('query:cancel', async (_e, executionId: string) => {
    await queryRunner.cancel(executionId)
    return { ok: true }
  })

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

  // ------------------------------------------------------------------ app
  ipcMain.handle('app:getVersion', () => process.env.npm_package_version ?? '0.1.0')
}
