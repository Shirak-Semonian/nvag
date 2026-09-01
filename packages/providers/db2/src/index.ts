/**
 * @nvag/providers/db2 — Db2-provider via een JDBC-bridge (F1-9, SAL-22).
 *
 * Driverkeuze (ADR-005): niet `ibm_db` (vereist IBM Data Server Driver +
 * native rebuild per Electron-update), maar een kleine Java-sidecar die de
 * IBM DB2 JDBC-driver (`jcc.jar`) draait — zie src/bridge/README.md. Node en
 * Java wisselen NDJSON uit; de core merkt niets van de bridge.
 *
 * Dialect `db2`: `"x"`-quoting, `FETCH FIRST n ROWS ONLY` als maxRows-cap
 * (nooit een tweede limiet-clausule, SAL-8-les), metadata uit SYSCAT.*.
 * Contracttests via @nvag/contract-tests (env-gated: NVAG_TEST_DB2_URL of
 * NVAG_TEST_DB2_HOST; zonder server wordt de suite overgeslagen).
 */

import type {
  BackupOptions,
  BackupRestoreApi,
  BackupResult,
  ColumnInfo,
  ConnectionConfig,
  DatabaseInfo,
  DatabaseProvider,
  DbObjectRef,
  DbSession,
  ForeignKeyInfo,
  FuncInfo,
  IndexInfo,
  ProcInfo,
  ProviderCapabilities,
  QueryCellValue,
  QueryChunk,
  QueryOptions,
  QueryStats,
  RestoreOptions,
  RestoreResult,
  SchemaInfo,
  SeqInfo,
  SynonymInfo,
  DbUserInfo,
  DbRoleInfo,
  ServerInfo,
  TableInfo,
  TableMetadata,
  TestResult,
  TriggerInfo,
  ViewInfo
} from '@nvag/contracts'
import { buildCreateTable, splitStatements, buildBackupDatabase, buildRestoreDatabase } from '@nvag/sql-dialect'
import { BridgeClient } from './bridge-client.ts'
import * as meta from './db2-metadata.ts'
import { parseDb2ErrorPosition } from './error-position.ts'
import { DB2_DEFAULT_PORT, buildJdbcUrl } from './jcc.ts'
import { applyFetchFirstLimit } from './limit.ts'

export interface Db2SessionHandle {
  bridge: BridgeClient
  connId: string
  server: string
  database: string
}

/** Resolveert zodra het signaal afgaat (voor het race-mechanisme in executeQuery). */
function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/** Wacht op een promise maar eindig direct wanneer het abort-signaal afgaat. */
async function raceWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<{ aborted: boolean; value?: T }> {
  if (!signal) return { aborted: false, value: await promise }
  if (signal.aborted) return { aborted: true }
  return Promise.race([
    promise.then((value) => ({ aborted: false, value })),
    abortPromise(signal).then(() => ({ aborted: true }))
  ])
}

const CAPABILITIES: ProviderCapabilities = {
  supportsSchemas: true, // DB2: schemas (SYSCAT.SCHEMATA)
  supportsSequences: true,
  supportsSynonyms: false, // DB2: synonyms/security nog niet ontsloten (SAL-32)
  supportsTriggers: true,
  supportsExecutionPlans: false, // F3
  supportsMonitoring: false, // F3
  supportsTransactions: true,
  supportsIdentityColumns: true, // GENERATED ALWAYS/BY DEFAULT AS IDENTITY
  supportsGeneratedColumns: true,
  supportsDdlAdmin: true,
  supportsUsersAndRoles: true,
  supportsBackupRestore: true,
  maxResultRowsDefault: 1000,
  dialect: 'db2'
}

/** Binaire cellen komen uit de bridge als {"$bin":"<base64>"}. */
export function decodeCellValue(v: unknown): QueryCellValue {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>
    if (typeof rec.$bin === 'string') {
      return Uint8Array.from(Buffer.from(rec.$bin, 'base64'))
    }
    return String(v)
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
    return v as QueryCellValue
  }
  return String(v)
}

/** Draai een catalogusquery via de bridge en geef kolommen + rijen terug. */
async function queryRows(
  handle: Db2SessionHandle,
  sql: string
): Promise<meta.QueryRows> {
  const columns: string[] = []
  const rows: unknown[][] = []
  for await (const evt of handle.bridge.executeQuery(handle.connId, sql, 0)) {
    if (evt.kind === 'columns') columns.push(...evt.columns.map((c) => c.name))
    else if (evt.kind === 'rows') rows.push(...evt.rows)
    else if (evt.kind === 'error') throw new Error(evt.message)
  }
  return { columns, rows }
}

/** Haal de verbindings-pool voor de bridge op (lazy). */
async function ensureBridge(bridge: BridgeClient): Promise<void> {
  await bridge.ensureStarted()
}

export function createDb2Provider(): DatabaseProvider {
  const bridge = new BridgeClient()
  const sessions = new Map<string, DbSession>()

  return {
    id: 'db2',
    displayName: 'Db2',
    defaultPort: DB2_DEFAULT_PORT,
    capabilities: CAPABILITIES,

    async connect(config: ConnectionConfig, secret?): Promise<DbSession> {
      if (!config.host) throw new Error('Db2: geen host opgegeven')
      if (!config.database) {
        throw new Error('Db2: geen database opgegeven (Db2 vereist een database in de verbinding)')
      }
      await ensureBridge(bridge)
      const url = buildJdbcUrl(config)
      const result = await bridge.request<{ connId: string }>('connect', {
        url,
        user: config.username ?? '',
        password: secret?.password ?? '',
        connectionTimeoutMs: config.connectionTimeoutMs ?? 15000
      })
      const session: DbSession = {
        handle: {
          bridge,
          connId: result.connId,
          server: config.host,
          database: config.database
        } satisfies Db2SessionHandle,
        connectionId: config.id,
        providerId: 'db2',
        database: config.database
      }
      sessions.set(config.id, session)
      return session
    },

    async testConnection(config, secret): Promise<TestResult> {
      try {
        const session = await this.connect(config, secret)
        const info = await this.getServerInfo(session)
        await this.close(session)
        return { ok: true, serverInfo: info }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },

    async getServerInfo(session: DbSession): Promise<ServerInfo> {
      const handle = session.handle as Db2SessionHandle
      const info = await handle.bridge.request<{
        dbmsName: string
        dbmsVersion: string
        database: string | null
        user: string | null
      }>('serverInfo', { connId: handle.connId })
      return {
        providerId: 'db2',
        providerName: 'Db2',
        serverVersion: info.dbmsVersion ?? 'onbekend',
        productName: info.dbmsName,
        currentDatabase: info.database ?? session.database,
        currentUser: info.user ?? undefined
      }
    },

    async close(session: DbSession): Promise<void> {
      const handle = session.handle as Db2SessionHandle
      try {
        await handle.bridge.request('close', { connId: handle.connId })
      } catch {
        // sessie al gesloten of bridge weg
      }
      sessions.delete(session.connectionId)
    },

    async listDatabases(session: DbSession): Promise<DatabaseInfo[]> {
      const handle = session.handle as Db2SessionHandle
      return meta.mapDatabases(await queryRows(handle, meta.listDatabasesSql()))
    },

    async listSchemas(session: DbSession, _db: string): Promise<SchemaInfo[]> {
      const handle = session.handle as Db2SessionHandle
      return meta.mapSchemas(await queryRows(handle, meta.listSchemasSql()))
    },

    async listTables(session: DbSession, _db: string, schema?: string): Promise<TableInfo[]> {
      const handle = session.handle as Db2SessionHandle
      return meta.mapTables(await queryRows(handle, meta.listTablesSql(schema)))
    },

    async listViews(session: DbSession, _db: string, schema?: string): Promise<ViewInfo[]> {
      const handle = session.handle as Db2SessionHandle
      return meta.mapViews(await queryRows(handle, meta.listViewsSql(schema)))
    },

    async listProcedures(session: DbSession, _db: string, schema?: string): Promise<ProcInfo[]> {
      const handle = session.handle as Db2SessionHandle
      return meta.mapProcedures(await queryRows(handle, meta.listProceduresSql(schema)))
    },

    async listFunctions(session: DbSession, _db: string, schema?: string): Promise<FuncInfo[]> {
      const handle = session.handle as Db2SessionHandle
      return meta.mapFunctions(await queryRows(handle, meta.listFunctionsSql(schema)))
    },

    async listTriggers(session: DbSession, _db: string, schema?: string): Promise<TriggerInfo[]> {
      const handle = session.handle as Db2SessionHandle
      return meta.mapTriggers(await queryRows(handle, meta.listTriggersSql(schema)))
    },

    async listSequences(session: DbSession, _db: string, schema?: string): Promise<SeqInfo[]> {
      const handle = session.handle as Db2SessionHandle
      return meta.mapSequences(await queryRows(handle, meta.listSequencesSql(schema)))
    },

    async listSynonyms(): Promise<SynonymInfo[]> {
      return [] // DB2: synonyms/security nog niet ontsloten (SAL-32)
    },

    async listUsers(): Promise<DbUserInfo[]> {
      return [] // DB2: synonyms/security nog niet ontsloten (SAL-32)
    },

    async listRoles(): Promise<DbRoleInfo[]> {
      return [] // DB2: synonyms/security nog niet ontsloten (SAL-32)
    },

    async getTableMetadata(
      session: DbSession,
      _db: string,
      schema: string,
      table: string
    ): Promise<TableMetadata> {
      const handle = session.handle as Db2SessionHandle
      const columns = meta.mapColumns(await queryRows(handle, meta.columnsSql(schema, table)))
      const pkRows = await queryRows(handle, meta.primaryKeySql(schema, table))
      const fkRows = await queryRows(handle, meta.foreignKeysSql(schema, table))
      const idxRows = await queryRows(handle, meta.indexesSql(schema, table))
      const checks = await queryRows(handle, meta.checksSql(schema, table))
      const uniqueIdx = await queryRows(handle, meta.uniqueIndexesSql(schema, table))
      const trigRows = await queryRows(handle, meta.triggersSql(schema, table))
      const depRows = await queryRows(handle, meta.dependenciesSql(schema, table))

      // Rijtelling is een optimizer-schatting (NUMROWS); bij fout → undefined.
      let rowCount: number | undefined
      try {
        const rc = await queryRows(handle, meta.rowCountSql(schema, table))
        const first = meta.rowsToObjects(rc)[0]
        rowCount = typeof first?.ROW_COUNT === 'number' ? first.ROW_COUNT : undefined
      } catch {
        rowCount = undefined
      }

      return meta.assembleTableMetadata(
        columns,
        pkRows,
        fkRows,
        idxRows,
        checks,
        uniqueIdx,
        trigRows,
        depRows,
        rowCount
      )
    },

    async getObjectDefinition(session: DbSession, obj: DbObjectRef): Promise<string> {
      const handle = session.handle as Db2SessionHandle
      const schema = obj.schema ?? ''
      if (obj.type === 'view') {
        const q = await queryRows(handle, meta.viewDefinitionSql(schema, obj.name))
        const def = meta.rowsToObjects(q)[0]?.DEFINITION
        if (typeof def === 'string' && def.trim()) return def
        throw new Error(`Db2: geen definitie gevonden voor ${schema}.${obj.name}`)
      }
      if (obj.type === 'procedure' || obj.type === 'function') {
        const q = await queryRows(
          handle,
          meta.routineDefinitionSql(schema, obj.name, obj.type === 'procedure' ? 'P' : 'F')
        )
        const def = meta.rowsToObjects(q)[0]?.DEFINITION
        if (typeof def === 'string' && def.trim()) return def
        throw new Error(`Db2: geen definitie gevonden voor ${schema}.${obj.name}`)
      }
      // Tabellen hebben geen catalogustekst; genereer CREATE TABLE uit metadata.
      const tableMeta = await this.getTableMetadata(session, obj.database, schema, obj.name)
      return buildCreateTable('db2', obj.name, schema, tableMeta)
    },

    async *executeQuery(
      session: DbSession,
      sqlText: string,
      opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      const handle = session.handle as Db2SessionHandle
      const maxRows = opts.maxRows ?? CAPABILITIES.maxResultRowsDefault

      const statements = splitStatements(sqlText)
      if (statements.length === 0) {
        yield { kind: 'done', rowCount: 0, durationMs: 0 }
        return
      }
      if (statements.length > 1) {
        yield {
          kind: 'error',
          message:
            'Meerdere SQL-statements in één uitvoering worden niet ondersteund (MULTIPLE_STATEMENTS). Voer één statement tegelijk uit.'
        }
        return
      }

      const stmt = statements[0]!
      const start = performance.now()
      // maxRows via dialect: FETCH FIRST n ROWS ONLY — maar nooit dubbel (SAL-8-les)
      const isSelect = /^\s*SELECT\b/i.test(stmt)
      const capped = isSelect ? applyFetchFirstLimit(stmt, maxRows) : stmt

      try {
        let rowCount = 0
        // SAL-33: manuale iteratie met abort-race zodat de generator nooit
        // blijft hangen; de JDBC-bridge heeft geen cancel-API — cancel()
        // meldt dat duidelijk (geen stille no-op).
        const bridgeIter = handle.bridge.executeQuery(handle.connId, capped, maxRows)[Symbol.asyncIterator]()
        for (;;) {
          const { aborted, value } = await raceWithSignal(bridgeIter.next(), opts.signal)
          if (aborted) {
            yield {
              kind: 'done',
              rowCount,
              durationMs: Math.round(performance.now() - start),
              cancelled: true
            }
            return
          }
          if (value!.done) break
          const evt = value!.value
          if (evt.kind === 'columns') {
            yield { kind: 'columns', columns: evt.columns }
          } else if (evt.kind === 'rows') {
            const rows = evt.rows.map((r) => ({ values: r.map(decodeCellValue) }))
            rowCount += rows.length
            yield { kind: 'rows', rows }
          } else if (evt.kind === 'done') {
            yield {
              kind: 'done',
              rowCount: evt.rowCount > 0 ? evt.rowCount : rowCount,
              durationMs: evt.durationMs > 0 ? evt.durationMs : Math.round(performance.now() - start)
            }
          } else {
            yield {
              kind: 'error',
              message: evt.message,
              position: parseDb2ErrorPosition(stmt, evt.message) ?? undefined
            }
          }
        }
      } catch (err) {
        if (opts.signal?.aborted) {
          yield {
            kind: 'done',
            rowCount: 0,
            durationMs: Math.round(performance.now() - start),
            cancelled: true
          }
        } else {
          const message = err instanceof Error ? err.message : String(err)
          yield {
            kind: 'error',
            message,
            position: parseDb2ErrorPosition(stmt, message) ?? undefined
          }
        }
      }
    },

    async cancel(_session: DbSession, _executionId: string): Promise<void> {
      // De JDBC-bridge biedt geen cancel-API voor een actieve query. Dit is
      // géén stille no-op: de gebruiker krijgt een duidelijke melding.
      throw new Error(
        'Db2: annuleren van een actieve query wordt niet ondersteund door de JDBC-bridge. De query wordt lokaal gestopt; de server-side uitvoering kan nog doorlopen.'
      )
    },

    async getExecutionStats(
      _session: DbSession,
      _executionId: string
    ): Promise<QueryStats> {
      return { rowCount: 0, durationMs: 0 }
    },

    // ------------------------------------------------------------------ F4
    // Backup & Restore (DBA) — gated via `supportsBackupRestore` (true).
    // Draait via de JDBC-bridge: BACKUP DB / RESTORE DB zijn catalogus-SQL.
    backupRestore: {
      async backupDatabase(
        session: DbSession,
        database: string,
        targetPath: string,
        _options?: BackupOptions
      ): Promise<BackupResult> {
        const handle = session.handle as Db2SessionHandle
        const sqlText = buildBackupDatabase('db2', database, targetPath)
        const start = performance.now()
        try {
          await drain(handle, sqlText)
          return { ok: true, sql: sqlText, targetPath, durationMs: Math.round(performance.now() - start) }
        } catch (err) {
          return {
            ok: false,
            sql: sqlText,
            targetPath,
            durationMs: Math.round(performance.now() - start),
            message: err instanceof Error ? err.message : String(err)
          }
        }
      },

      async restoreDatabase(
        session: DbSession,
        database: string,
        sourcePath: string,
        _options?: RestoreOptions
      ): Promise<RestoreResult> {
        const handle = session.handle as Db2SessionHandle
        const sqlText = buildRestoreDatabase('db2', database, sourcePath)
        const start = performance.now()
        try {
          await drain(handle, sqlText)
          return { ok: true, sql: sqlText, sourcePath, durationMs: Math.round(performance.now() - start) }
        } catch (err) {
          return {
            ok: false,
            sql: sqlText,
            sourcePath,
            durationMs: Math.round(performance.now() - start),
            message: err instanceof Error ? err.message : String(err)
          }
        }
      }
    } satisfies BackupRestoreApi
  }
}

/** Draai één statement via de bridge en gooi bij een error-chunk. */
async function drain(handle: Db2SessionHandle, sql: string): Promise<void> {
  for await (const evt of handle.bridge.executeQuery(handle.connId, sql, 0)) {
    if (evt.kind === 'error') throw new Error(evt.message)
  }
}

export { applyFetchFirstLimit } from './limit.ts'
export { parseDb2ErrorPosition } from './error-position.ts'
export { buildJdbcUrl, resolveJccJar } from './jcc.ts'
export { BridgeClient } from './bridge-client.ts'
export type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableMetadata }
