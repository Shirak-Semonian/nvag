/**
 * IPC-handlers — typed, gevalideerd; renderer praat alleen via deze laag.
 * (ADR: renderer is dom, alle logica in main process)
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import type {
  AdminIndexCreateRequest,
  AdminTableCreateRequest,
  AdminUserRequest,
  ConnectionConfig,
  ConnectionSecret,
  DbObjectRef,
  ImportFileFormat,
  ScriptKind,
  TableEditRequest
} from '@nvag/contracts'
import { connectionStore, historyStore, snippetStore, auditStore } from './ipc-bootstrap'
import { sessionManager } from './session-manager'
import { queryRunner } from './query-runner'
import * as metadata from './metadata-service'
import * as queryFiles from './query-files'
import { exportResults, saveCsv } from './results-export'
import type { ExportRequest } from '@nvag/contracts'
import { checkQuery } from './security/query-guard'
import * as tableData from './table-data'
import { transactionManager } from './transactions'
import * as admin from './database-admin'
import * as performance from './performance'
import * as search from './database-search'
import * as importer from './importer'
import * as dashboard from './dashboard'
import * as compare from './compare'
import * as aiAssistant from './ai-assistant'
import { registry } from './registry'

function audit(action: Parameters<typeof auditStore.add>[0]['action'], detail: string, extra: { server?: string; database?: string; success?: boolean; error?: string } = {}) {
  try {
    auditStore.add({ action, detail, server: extra.server, database: extra.database, success: extra.success ?? true, error: extra.error })
  } catch {
    // audit is best-effort
  }
}

export function registerIpcHandlers(): void {
  // ------------------------------------------------------------------ providers (F2-9)
  ipcMain.handle('providers:list', () => {
    return registry
      .list()
      .map((p) => ({
        id: p.id,
        displayName: p.displayName,
        dialect: p.capabilities.dialect,
        defaultPort: p.defaultPort
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  })

  // ------------------------------------------------------------------ connections
  ipcMain.handle('connections:list', () => connectionStore.list())

  ipcMain.handle(
    'connections:save',
    (_e, config: ConnectionConfig, secret?: ConnectionSecret) => {
      const isNew = !connectionStore.get(config.id)
      const saved = connectionStore.save(config, secret)
      audit(isNew ? 'connection.created' : 'admin.ddl', `${isNew ? 'Verbinding aangemaakt' : 'Verbinding bijgewerkt'}: ${config.name} (${config.providerId})`, { server: config.name })
      return saved
    }
  )

  ipcMain.handle('connections:remove', (_e, id: string) => {
    const conn = connectionStore.get(id)
    connectionStore.remove(id)
    audit('connection.removed', `Verbinding verwijderd: ${conn?.name ?? id}`, { server: conn?.name })
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
      const result = await sessionManager.open(config, secret)
      audit('session.opened', `Sessie geopend: ${config.name}`, { server: config.name, database: config.database })
      return result
    }
  )

  ipcMain.handle('sessions:close', async (_e, sessionId: string) => {
    await sessionManager.close(sessionId)
    return { ok: true }
  })

  ipcMain.handle('sessions:openSaved', async (_e, connectionId: string) => {
    const result = await sessionManager.openSaved(connectionId)
    const conn = connectionStore.get(connectionId)
    audit('session.opened', `Sessie geopend (saved): ${conn?.name ?? connectionId}`, { server: conn?.name })
    return result
  })

  ipcMain.handle('sessions:useDatabase', async (_e, connectionId: string, database: string) => {
    return sessionManager.switchDatabase(connectionId, database)
  })

  // ------------------------------------------------------------------ query
  ipcMain.handle(
    'query:run',
    (
      event,
      req: {
        connectionId: string
        sql: string
        maxRows?: number
        selection?: { start: number; end: number }
        /** Environment-safety (F1-8): gebruiker bevestigde in de dialoog. */
        confirmed?: boolean
      }
    ) => {
      // Environment safety (ADR-009): alleen wanneer verbinding bekend is en
      // de query niet expliciet is bevestigd via de dialoog (F1-8).
      const conn = connectionStore.get(req.connectionId)
      if (conn && !req.confirmed) {
        const guard = checkQuery(req.sql, conn.environment)
        if (!guard.allowed) {
          return { executionId: '', blocked: guard.reasons, guardSeverity: guard.severity }
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
      const result = await exportResults(req, event.sender)
      if (!result.canceled && result.rowCount !== undefined) {
        audit('query.exported', `Export ${req.format.toUpperCase()} (${req.target}): ${result.rowCount} rijen — ${req.fileName}`, { server: undefined })
      }
      return result
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
    'metadata:listSynonyms',
    (_e, connectionId: string, db: string, schema?: string) =>
      metadata.listSynonyms(connectionId, db, schema)
  )
  ipcMain.handle(
    'metadata:listUsers',
    (_e, connectionId: string, db: string) =>
      metadata.listUsers(connectionId, db)
  )
  ipcMain.handle(
    'metadata:listRoles',
    (_e, connectionId: string, db: string) =>
      metadata.listRoles(connectionId, db)
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

  // ------------------------------------------------------------------ F2-1: table data (eis 8)
  ipcMain.handle(
    'tableData:getRows',
    (_e, connectionId: string, database: string, schema: string, table: string, maxRows?: number) =>
      tableData.getTableRows(connectionId, database, schema, table, maxRows)
  )

  ipcMain.handle('tableData:edit', async (_e, req: TableEditRequest) => {
    // Environment-safety (F2-1): zelfde guard als query:run; pas uitvoeren
    // wanneer de bewerking (of de bevestiging via `confirmed`-flag) door is.
    const conn = connectionStore.get(req.connectionId)
    const result = await tableData.editTableRow(req)
    if (conn && result.sql && !req.confirmed) {
      const guard = checkQuery(result.sql, conn.environment)
      if (!guard.allowed) {
        return { rowCount: 0, sql: result.sql, blocked: guard.reasons, guardSeverity: guard.severity }
      }
    }
    if (!result.blocked || result.blocked.length === 0) {
      audit('table.edit', `Tabelbewerking ${req.kind} op ${req.schema ? req.schema + '.' : ''}${req.table}: ${result.rowCount} rij(en)`, { server: conn?.name, database: req.database })
    }
    return result
  })

  // ------------------------------------------------------------------ F2-2: transactions (eis 23)
  ipcMain.handle('transactions:begin', async (_e, connectionId: string) => {
    const conn = connectionStore.get(connectionId)
    audit('admin.ddl', 'Transactie gestart (BEGIN)', { server: conn?.name })
    return transactionManager.begin(connectionId)
  })
  ipcMain.handle('transactions:commit', async (_e, connectionId: string) => {
    const conn = connectionStore.get(connectionId)
    audit('transaction.commit', 'Transactie gecommit (COMMIT)', { server: conn?.name })
    return transactionManager.commit(connectionId)
  })
  ipcMain.handle('transactions:rollback', async (_e, connectionId: string) => {
    const conn = connectionStore.get(connectionId)
    audit('transaction.rollback', 'Transactie teruggedraaid (ROLLBACK)', { server: conn?.name })
    return transactionManager.rollback(connectionId)
  })
  ipcMain.handle('transactions:status', (_e, connectionId: string) =>
    transactionManager.status(connectionId)
  )

  // ------------------------------------------------------------------ F2-3: database administration (eis 9)
  ipcMain.handle('admin:capabilities', (_e, connectionId: string) =>
    admin.capabilities(connectionId)
  )
  ipcMain.handle('admin:createDatabase', async (_e, connectionId: string, name: string, confirmed?: boolean) => {
    const r = await admin.createDatabase(connectionId, name, confirmed)
    if (r.ok) audit('admin.ddl', `CREATE DATABASE ${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropDatabase', async (_e, connectionId: string, name: string, confirmed?: boolean) => {
    const r = await admin.dropDatabase(connectionId, name, confirmed)
    if (r.ok) audit('admin.ddl', `DROP DATABASE ${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:createSchema', async (_e, connectionId: string, database: string, name: string, confirmed?: boolean) => {
    const r = await admin.createSchema(connectionId, database, name, confirmed)
    if (r.ok) audit('admin.ddl', `CREATE SCHEMA ${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropSchema', async (_e, connectionId: string, database: string, name: string, confirmed?: boolean) => {
    const r = await admin.dropSchema(connectionId, database, name, confirmed)
    if (r.ok) audit('admin.ddl', `DROP SCHEMA ${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:createTable', async (_e, req: AdminTableCreateRequest, confirmed?: boolean) => {
    const r = await admin.createTable(req.connectionId, req.database, req.schema, req.table, req.columns, confirmed)
    if (r.ok) audit('admin.ddl', `CREATE TABLE ${req.schema ? req.schema + '.' : ''}${req.table}`, { server: connectionStore.get(req.connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropTable', async (_e, connectionId: string, database: string, schema: string, table: string, confirmed?: boolean) => {
    const r = await admin.dropTable(connectionId, database, schema, table, confirmed)
    if (r.ok) audit('admin.ddl', `DROP TABLE ${schema ? schema + '.' : ''}${table}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:createView', async (_e, connectionId: string, database: string, schema: string, name: string, selectSql: string, confirmed?: boolean) => {
    const r = await admin.createView(connectionId, database, schema, name, selectSql, confirmed)
    if (r.ok) audit('admin.ddl', `CREATE VIEW ${schema ? schema + '.' : ''}${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropView', async (_e, connectionId: string, database: string, schema: string, name: string, confirmed?: boolean) => {
    const r = await admin.dropView(connectionId, database, schema, name, confirmed)
    if (r.ok) audit('admin.ddl', `DROP VIEW ${schema ? schema + '.' : ''}${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:createIndex', async (_e, req: AdminIndexCreateRequest, confirmed?: boolean) => {
    const r = await admin.createIndex(req.connectionId, req.database, req.schema, req.index, confirmed)
    if (r.ok) audit('admin.ddl', `CREATE INDEX ${req.index.name}`, { server: connectionStore.get(req.connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropIndex', async (_e, connectionId: string, database: string, schema: string, table: string, index: string, confirmed?: boolean) => {
    const r = await admin.dropIndex(connectionId, database, schema, table, index, confirmed)
    if (r.ok) audit('admin.ddl', `DROP INDEX ${index}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:listUsers', async (_e, connectionId: string) =>
    admin.listUsers(connectionId)
  )
  ipcMain.handle('admin:createUser', async (_e, req: AdminUserRequest, confirmed?: boolean) => {
    const r = await admin.createUser(req.connectionId, req.name, req.password, confirmed)
    if (r.ok) audit('admin.ddl', `CREATE USER ${req.name}`, { server: connectionStore.get(req.connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropUser', async (_e, connectionId: string, database: string, name: string, confirmed?: boolean) => {
    const r = await admin.dropUser(connectionId, database, name, confirmed)
    if (r.ok) audit('admin.ddl', `DROP USER ${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  // SAL-45: DROP-procedures voor de overige Object Explorer-objecttypen.
  ipcMain.handle('admin:dropProcedure', async (_e, connectionId: string, database: string, schema: string | undefined, name: string, confirmed?: boolean) => {
    const r = await admin.dropProcedure(connectionId, database, schema, name, confirmed)
    if (r.ok) audit('admin.ddl', `DROP PROCEDURE ${schema ? schema + '.' : ''}${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropFunction', async (_e, connectionId: string, database: string, schema: string | undefined, name: string, confirmed?: boolean) => {
    const r = await admin.dropFunction(connectionId, database, schema, name, confirmed)
    if (r.ok) audit('admin.ddl', `DROP FUNCTION ${schema ? schema + '.' : ''}${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropTrigger', async (_e, connectionId: string, database: string, schema: string | undefined, name: string, table?: string, confirmed?: boolean) => {
    const r = await admin.dropTrigger(connectionId, database, schema, name, table, confirmed)
    if (r.ok) audit('admin.ddl', `DROP TRIGGER ${schema ? schema + '.' : ''}${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropSequence', async (_e, connectionId: string, database: string, schema: string | undefined, name: string, confirmed?: boolean) => {
    const r = await admin.dropSequence(connectionId, database, schema, name, confirmed)
    if (r.ok) audit('admin.ddl', `DROP SEQUENCE ${schema ? schema + '.' : ''}${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropSynonym', async (_e, connectionId: string, database: string, schema: string | undefined, name: string, confirmed?: boolean) => {
    const r = await admin.dropSynonym(connectionId, database, schema, name, confirmed)
    if (r.ok) audit('admin.ddl', `DROP SYNONYM ${schema ? schema + '.' : ''}${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropRole', async (_e, connectionId: string, database: string, name: string, confirmed?: boolean) => {
    const r = await admin.dropRole(connectionId, database, name, confirmed)
    if (r.ok) audit('admin.ddl', `DROP ROLE ${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })
  ipcMain.handle('admin:dropConstraint', async (_e, connectionId: string, database: string, schema: string | undefined, table: string, name: string, confirmed?: boolean) => {
    const r = await admin.dropConstraint(connectionId, database, schema, table, name, confirmed)
    if (r.ok) audit('admin.ddl', `ALTER TABLE ${schema ? schema + '.' : ''}${table} DROP CONSTRAINT ${name}`, { server: connectionStore.get(connectionId)?.name })
    return r
  })

  // SAL-50: database-eigenschappen lezen/wijzigen (bewerkbare dialoog + ALTER DATABASE).
  ipcMain.handle('admin:getDatabaseProperties', (_e, connectionId: string, database: string) =>
    admin.getDatabaseProperties(connectionId, database)
  )
  ipcMain.handle('admin:alterDatabase', async (_e, connectionId: string, database: string, changes: Record<string, string>, confirmed?: boolean) => {
    const r = await admin.alterDatabase(connectionId, database, changes, confirmed)
    if (r.ok) {
      const detail = Object.keys(changes)
        .map((key) => (key === 'name' ? `MODIFY NAME → ${changes.name}` : `${key} = ${changes[key]}`))
        .join(', ')
      audit('admin.ddl', `ALTER DATABASE ${database} — ${detail}`, {
        server: connectionStore.get(connectionId)?.name,
        database: r.renamedTo ?? database
      })
    }
    return r
  })

  // ------------------------------------------------------------------ F4: backup & restore (DBA)
  ipcMain.handle('admin:backupDatabase', async (_e, connectionId: string, database: string, targetPath: string, confirmed?: boolean) => {
    const r = await admin.backupDatabase(connectionId, database, targetPath, confirmed)
    if (r.ok) audit('admin.ddl', `BACKUP DATABASE ${database} → ${targetPath}`, { server: connectionStore.get(connectionId)?.name, database })
    return r
  })
  ipcMain.handle('admin:restoreDatabase', async (_e, connectionId: string, database: string, sourcePath: string, confirmed?: boolean) => {
    const r = await admin.restoreDatabase(connectionId, database, sourcePath, confirmed)
    if (r.ok) audit('admin.ddl', `RESTORE DATABASE ${database} ← ${sourcePath}`, { server: connectionStore.get(connectionId)?.name, database })
    return r
  })

  // ------------------------------------------------------------------ F2-4: query performance (eis 11)
  ipcMain.handle('performance:getStats', (_e, connectionId: string, sql?: string) =>
    performance.getStats(connectionId, sql)
  )

  // ------------------------------------------------------------------ F2-5: database search (eis 13)
  ipcMain.handle(
    'search:search',
    (_e, connectionId: string, query: string, options?: { database?: string; limit?: number }) =>
      search.searchDatabase(connectionId, query, options)
  )

  // ------------------------------------------------------------------ F2-6: snippets (eis 20)
  ipcMain.handle('snippets:list', (_e, folder?: string) => snippetStore.list(folder))
  ipcMain.handle('snippets:save', (_e, entry: { folder: string; title: string; sql: string }) => {
    const saved = snippetStore.save(entry)
    audit('admin.ddl', `Snippet opgeslagen: ${saved.title}`, {})
    return saved
  })
  ipcMain.handle('snippets:remove', (_e, id: number) => {
    snippetStore.remove(id)
    return { ok: true }
  })
  ipcMain.handle('snippets:listFolders', () => snippetStore.listFolders())

  // ------------------------------------------------------------------ F2-7: import (eis 17)
  ipcMain.handle('import:pickFile', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win!, {
      title: 'Importbestand kiezen',
      properties: ['openFile'],
      filters: [
        { name: 'Data-bestanden', extensions: ['csv', 'json', 'xlsx', 'xml'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'Excel', extensions: ['xlsx'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'XML', extensions: ['xml'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true }
    }
    const filePath = result.filePaths[0]!
    const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
    const format: ImportFileFormat | undefined =
      ext === 'csv' ? 'csv' : ext === 'json' ? 'json' : ext === 'xlsx' ? 'xlsx' : ext === 'xml' ? 'xml' : undefined
    return { canceled: false, filePath, format }
  })
  ipcMain.handle('import:preview', (_e, req: { filePath: string; format: ImportFileFormat }) =>
    importer.previewImport(req)
  )
  ipcMain.handle('import:generate', async (_event, req: {
      filePath: string
      format: ImportFileFormat
      table: string
      schema?: string
      mapping: Record<number, string>
      rowLimit?: number
      connectionId: string
    }) => {
      const session = sessionManager.getByConnectionId(req.connectionId)
      if (!session) throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
      const { registry: reg } = await import('./registry')
      const dialect = reg.get(session.providerId).capabilities.dialect
      return importer.generateImport({ ...req, dialect })
    }
  )
  ipcMain.handle(
    'import:execute',
    async (_e, connectionId: string, sql: string, confirmed?: boolean) => {
      const result = await importer.executeImport(connectionId, sql, confirmed)
      if (result.ok) {
        const conn = connectionStore.get(connectionId)
        audit('import.executed', `Import uitgevoerd: ${result.rowCount} rij(en)`, { server: conn?.name })
      }
      return result
    }
  )

  // ------------------------------------------------------------------ F2-8: audit (eis 26)
  ipcMain.handle('audit:list', (_e, limit?: number) => auditStore.list(limit))
  ipcMain.handle('audit:clear', () => {
    auditStore.clear()
    return { ok: true }
  })

  // ------------------------------------------------------------------ F2-10: dashboard (eis 25)
  ipcMain.handle('dashboard:get', (_e, connectionId: string) =>
    dashboard.getDashboard(connectionId)
  )

  // ------------------------------------------------------------------ F3-2: monitoring (eis 12)
  ipcMain.handle('monitoring:activeQueries', async (_e, connectionId: string, includeIdle?: boolean) => {
    const { getActiveQueries } = await import('./monitoring')
    return getActiveQueries(connectionId, includeIdle)
  })
  ipcMain.handle('monitoring:locks', async (_e, connectionId: string) => {
    const { getLocks } = await import('./monitoring')
    return getLocks(connectionId)
  })

  // ------------------------------------------------------------------ F3-3: compare (eis 15 + 16)
  ipcMain.handle(
    'compare:schemas',
    (_e, sourceConnectionId: string, sourceSchema: string | undefined, targetConnectionId: string, targetSchema: string | undefined) =>
      compare.compareSchemas(sourceConnectionId, sourceSchema, targetConnectionId, targetSchema)
  )
  ipcMain.handle(
    'compare:data',
    (_e, sourceConnectionId: string, sourceSchema: string | undefined, targetConnectionId: string, targetSchema: string | undefined, table: string) =>
      compare.compareData(sourceConnectionId, sourceSchema, targetConnectionId, targetSchema, table)
  )
  ipcMain.handle(
    'compare:deployScript',
    (_e, sourceConnectionId: string, sourceSchema: string | undefined, targetConnectionId: string, targetSchema: string | undefined, diff: unknown) =>
      compare.buildDeployScript(sourceConnectionId, sourceSchema, targetConnectionId, targetSchema, diff as Parameters<typeof compare.buildDeployScript>[4])
  )

  // ------------------------------------------------------------------ F3-6: AI assistant (eis 27)
  ipcMain.handle('ai:saveConfig', (_e, config: { baseUrl?: string; model?: string; apiKey?: string }) => {
    aiAssistant.saveAiConfig(config)
    audit('admin.ddl', 'AI-configuratie opgeslagen (apiKey versleuteld in vault)', {})
    return { ok: true }
  })
  ipcMain.handle('ai:chat', async (_e, req: Parameters<typeof aiAssistant.aiChat>[0]) => {
    return aiAssistant.aiChat(req)
  })

  // ------------------------------------------------------------------ F3-7: plugins (eis 29)
  ipcMain.handle('plugins:list', async () => {
    const { loadPlugins } = await import('./plugin-loader')
    return loadPlugins(registry)
  })
  ipcMain.handle('plugins:reload', async () => {
    const { loadPlugins } = await import('./plugin-loader')
    return loadPlugins(registry)
  })

  // ------------------------------------------------------------------ app
  ipcMain.handle('app:getVersion', () => process.env.npm_package_version ?? '0.1.0')
}
