/**
 * @nvag/providers/sqlite — SQLite-provider via node:sqlite (ingebouwd).
 *
 * F0: eerste provider die het DatabaseProvider-contract bewijst.
 * Geen native builds, geen externe drivers.
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import type {
  BackupOptions,
  BackupRestoreApi,
  BackupResult,
  ColumnInfo,
  ConnectionConfig,
  ConstraintInfo,
  DatabaseInfo,
  DatabaseProvider,
  DbObjectRef,
  DbSession,
  DependencyInfo,
  ForeignKeyInfo,
  FuncInfo,
  IndexInfo,
  ProcInfo,
  ProviderCapabilities,
  QueryChunk,
  QueryCellValue,
  QueryOptions,
  QueryRow,
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
import { buildLimit, containsKeyword, splitStatements, wrapErrorPosition } from '@nvag/sql-dialect'

export interface SqliteSessionHandle {
  db: DatabaseSync
  path: string
}

const CAPABILITIES: ProviderCapabilities = {
  supportsSchemas: true, // SQLite: schema = main/temp (beperkt, maar aanwezig)
  supportsSequences: false, // SQLite: AUTOINCREMENT i.p.v. sequences
  supportsSynonyms: false, // SQLite: geen synonyms
  supportsTriggers: true,
  supportsExecutionPlans: false,
  supportsMonitoring: false,
  supportsTransactions: true,
  supportsIdentityColumns: true,
  supportsGeneratedColumns: true,
  supportsDdlAdmin: true,
  supportsUsersAndRoles: false,
  supportsBackupRestore: true, // F4: bestandskopie via VACUUM INTO / restore-reopen
  maxResultRowsDefault: 1000,
  dialect: 'sqlite'
}

/** SQLite gebruikt het bestandspad als host + database. */
function resolvePath(config: ConnectionConfig): string {
  return config.host || config.database || ''
}

function openDb(path: string): DatabaseSync {
  return new DatabaseSync(path)
}

export function createSqliteProvider(): DatabaseProvider {
  const sessions = new Map<string, DbSession>()

  return {
    id: 'sqlite',
    displayName: 'SQLite',
    defaultPort: 0,
    capabilities: CAPABILITIES,

    async connect(config: ConnectionConfig): Promise<DbSession> {
      const path = resolvePath(config)
      if (!path) throw new Error('SQLite: no database path provided (host)')
      // Alleen openen wanneer bestand bestaat (voorkomt per ongeluk lege db's aanmaken),
      // tenzij createIfMissing expliciet is aangevraagd (F0-6 verbindingsdialoog).
      if (!existsSync(path)) {
        if (config.createIfMissing === true) {
          const dir = path.split(/[\\/]/).slice(0, -1).join('/')
          if (dir && !existsSync(dir)) {
            const { mkdirSync } = await import('node:fs')
            mkdirSync(dir, { recursive: true })
          }
        } else {
          throw new Error(`SQLite: file not found: ${path}`)
        }
      }
      const db = openDb(path)
      db.exec('PRAGMA foreign_keys = ON')
      const session: DbSession = {
        handle: { db, path } satisfies SqliteSessionHandle,
        connectionId: config.id,
        providerId: 'sqlite',
        database: path
      }
      sessions.set(config.id, session)
      return session
    },

    async testConnection(config: ConnectionConfig): Promise<TestResult> {
      try {
        const session = await this.connect(config)
        const info = await this.getServerInfo(session)
        await this.close(session)
        return { ok: true, serverInfo: info }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },

    async getServerInfo(session: DbSession): Promise<ServerInfo> {
      const { db } = session.handle as SqliteSessionHandle
      const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
      return {
        providerId: 'sqlite',
        providerName: 'SQLite',
        serverVersion: row.v,
        productName: 'SQLite',
        currentDatabase: session.database
      }
    },

    async close(session: DbSession): Promise<void> {
      const { db } = session.handle as SqliteSessionHandle
      try {
        db.close()
      } catch {
        // al gesloten
      }
      sessions.delete(session.connectionId)
    },

    async listDatabases(session: DbSession): Promise<DatabaseInfo[]> {
      const { db } = session.handle as SqliteSessionHandle
      const rows = db
        .prepare("SELECT name FROM pragma_database_list WHERE name NOT IN ('temp')")
        .all() as { name: string }[]
      return rows.map((r) => ({ name: r.name }))
    },

    async listSchemas(session: DbSession): Promise<SchemaInfo[]> {
      const { db } = session.handle as SqliteSessionHandle
      // SQLite kent geen echte schemas; main is de default
      const rows = db.prepare('PRAGMA database_list').all() as { name: string }[]
      return rows.map((r) => ({ name: r.name })).filter((s) => s.name !== 'temp')
    },

    async listTables(session: DbSession, _db: string, schema?: string): Promise<TableInfo[]> {
      const { db } = session.handle as SqliteSessionHandle
      const rows = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as { name: string }[]
      return rows.map((r) => ({ name: r.name, schema: schema ?? 'main', type: 'table' }))
    },

    async listViews(session: DbSession, _db: string, schema?: string): Promise<ViewInfo[]> {
      const { db } = session.handle as SqliteSessionHandle
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`)
        .all() as { name: string }[]
      return rows.map((r) => ({ name: r.name, schema: schema ?? 'main' }))
    },

    async listProcedures(): Promise<ProcInfo[]> {
      return [] // SQLite heeft geen stored procedures
    },

    async listFunctions(): Promise<FuncInfo[]> {
      return [] // SQLite heeft geen opgeslagen functies
    },

    async listTriggers(session: DbSession, _db: string, schema?: string): Promise<TriggerInfo[]> {
      const { db } = session.handle as SqliteSessionHandle
      const rows = db
        .prepare(`SELECT name, tbl_name AS table FROM sqlite_master WHERE type='trigger' ORDER BY name`)
        .all() as { name: string; table: string }[]
      return rows.map((r) => ({ name: r.name, schema: schema ?? 'main', table: r.table }))
    },

    async listSequences(): Promise<SeqInfo[]> {
      return [] // SQLite: AUTOINCREMENT
    },

    async listSynonyms(): Promise<SynonymInfo[]> {
      return [] // SQLite: geen synonyms
    },

    async listUsers(): Promise<DbUserInfo[]> {
      return [] // SQLite: geen gebruikers/rollen
    },

    async listRoles(): Promise<DbRoleInfo[]> {
      return [] // SQLite: geen gebruikers/rollen
    },

    async getTableMetadata(
      session: DbSession,
      _db: string,
      _schema: string,
      table: string
    ): Promise<TableMetadata> {
      const { db } = session.handle as SqliteSessionHandle

      // Kolommen
      const colRows = db.prepare(`PRAGMA table_xinfo(${quoteLit(table)})`).all() as {
        cid: number
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        pk: number
        hidden: number
      }[]

      // PK-informatie (volgorde)
      const pkCols = colRows.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk)
      const pkNames = new Set(pkCols.map((c) => c.name))

      // Foreign keys
      const fkRows = db.prepare(`PRAGMA foreign_key_list(${quoteLit(table)})`).all() as {
        id: number
        seq: number
        table: string
        from: string
        to: string
        on_update: string
        on_delete: string
      }[]
      const fkMap = new Map<number, ForeignKeyInfo>()
      for (const fk of fkRows) {
        const existing = fkMap.get(fk.id)
        if (existing) {
          existing.columns.push(fk.from)
          existing.referencedColumns.push(fk.to)
        } else {
          fkMap.set(fk.id, {
            name: `fk_${table}_${fk.id}`,
            columns: [fk.from],
            referencedTable: fk.table,
            referencedSchema: 'main',
            referencedColumns: [fk.to],
            onDelete: fk.on_delete,
            onUpdate: fk.on_update
          })
        }
      }

      // Indexen
      const idxRows = db.prepare(`PRAGMA index_list(${quoteLit(table)})`).all() as {
        name: string
        unique: number
        origin: string
      }[]
      const indexes: IndexInfo[] = []
      for (const idx of idxRows) {
        const colRows2 = db.prepare(`PRAGMA index_info(${quoteLit(idx.name)})`).all() as {
          name: string
        }[]
        indexes.push({
          name: idx.name,
          columns: colRows2.map((c) => c.name),
          isUnique: idx.unique === 1,
          isPrimaryKey: idx.origin === 'pk'
        })
      }

      // Constraints: CHECK/DEFAULT uit CREATE TABLE parsen (beperkt) + PK/FK/UNIQUE
      const constraints: ConstraintInfo[] = []
      for (const c of colRows) {
        if (c.dflt_value !== null && c.dflt_value !== undefined) {
          constraints.push({
            name: `default_${c.name}`,
            type: 'DEFAULT',
            definition: String(c.dflt_value)
          })
        }
      }
      if (pkNames.size > 0) {
        constraints.push({ name: 'pk', type: 'PRIMARY KEY', definition: [...pkNames].join(', ') })
      }
      for (const idx of indexes) {
        if (idx.isUnique && !idx.isPrimaryKey) {
          constraints.push({ name: idx.name, type: 'UNIQUE', definition: idx.columns.join(', ') })
        }
      }

      // Triggers
      const trigRows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name = ? ORDER BY name`)
        .all(table) as { name: string }[]

      // Afhankelijkheden (F1-5): FK-doelen als 'depends-on', objecten die
      // deze tabel in hun SQL noemen (views, triggers, FK-referenties) als
      // 'used-by'. SQLite heeft geen catalogus hiervoor; we scannen
      // sqlite_master.sql op een identifier-wijze vermelding.
      const dependencies: DependencyInfo[] = []
      for (const fk of fkMap.values()) {
        dependencies.push({
          objectName: fk.referencedTable,
          objectSchema: fk.referencedSchema ?? 'main',
          objectType: 'table',
          direction: 'depends-on'
        })
      }
      const refRows = db
        .prepare(
          `SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','view','trigger')`
        )
        .all() as { name: string; type: string; sql: string }[]
      const usedBySeen = new Set<string>()
      const tableRe = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegex(table)}(?=$|[^A-Za-z0-9_$])`)
      for (const r of refRows) {
        if (r.name === table || r.name.startsWith('sqlite_')) continue
        if (!tableRe.test(r.sql)) continue
        const key = `${r.type}:${r.name}`
        if (usedBySeen.has(key)) continue
        usedBySeen.add(key)
        dependencies.push({
          objectName: r.name,
          objectSchema: 'main',
          objectType: r.type === 'view' ? 'view' : r.type === 'trigger' ? 'trigger' : 'table',
          direction: 'used-by'
        })
      }

      // Rijtelling (benadering; exact via COUNT is duur op grote tabellen)
      let rowCount: number | undefined
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`).get() as { n: number }
        rowCount = r.n
      } catch {
        rowCount = undefined
      }

      const columns: ColumnInfo[] = colRows
        .filter((c) => c.hidden === 0) // hidden = generated verborgen kolommen
        .map((c, i) => ({
          name: c.name,
          dataType: c.type || 'TEXT',
          nullable: c.notnull === 0 && c.pk === 0,
          defaultValue: c.dflt_value,
          isIdentity: c.pk > 0 && c.type.toUpperCase().includes('INT'), // AUTOINCREMENT vereist integer PK
          isComputed: c.hidden !== 0,
          isPrimaryKey: c.pk > 0,
          ordinalPosition: i + 1
        }))

      return {
        columns,
        primaryKey: pkCols.map((c) => c.name),
        foreignKeys: [...fkMap.values()],
        indexes,
        constraints,
        triggers: trigRows.map((t) => t.name),
        dependencies,
        rowCount
      }
    },

    async getObjectDefinition(session: DbSession, obj: DbObjectRef): Promise<string> {
      const { db } = session.handle as SqliteSessionHandle
      const row = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type = ? AND name = ?`
        )
        .get(obj.type === 'view' ? 'view' : 'table', obj.name) as { sql: string } | undefined
      if (!row?.sql) {
        throw new Error(`SQLite: no definition found for ${obj.name}`)
      }
      return `${row.sql};`
    },

    async *executeQuery(
      session: DbSession,
      sql: string,
      opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      const { db } = session.handle as SqliteSessionHandle
      const maxRows = opts.maxRows ?? CAPABILITIES.maxResultRowsDefault
      const signal = opts.signal

      // Statements splitsen op ';' (quote/comment-bewust; F1: echte parser per dialect).
      // Contract: maximaal één statement per executeQuery; node:sqlite zou de
      // rest stilletjes negeren, dus weigeren is veiliger dan stilletjes truncaten.
      const statements = splitStatements(sql, CAPABILITIES.dialect)

      if (statements.length === 0) {
        yield { kind: 'done', rowCount: 0, durationMs: 0 }
        return
      }

      if (statements.length > 1) {
        yield {
          kind: 'error',
          message:
            'Multiple SQL statements in one execution are not supported (MULTIPLE_STATEMENTS). Execute one statement at a time.'
        }
        return
      }

      const start = performance.now()
      let totalRows = 0
      let returnedColumns = false
      let currentStmt = ''
      let cancelled = false

      try {
        const stmt = statements[0]!
        currentStmt = stmt
        const isSelect = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(stmt)
        // Alleen lees-statements zonder eigen LIMIT krijgen een maxRows-cap
        // (nooit DML/DDL, en nooit een tweede LIMIT naast een bestaande).
        const capped = isSelect && !containsKeyword(stmt, 'LIMIT') ? `${stmt} ${buildLimit('sqlite', maxRows)}`.trim() : stmt
        let st: ReturnType<DatabaseSync['prepare']>
        try {
          st = db.prepare(capped)
        } catch (err) {
          yield {
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
            position: wrapErrorPosition('sqlite', err instanceof Error ? err.message : String(err), currentStmt) ?? undefined
          }
          return
        }

        if (isSelect) {
          const cols = st.columns().map((c) => ({
            name: c.name,
            dataType: c.type ?? undefined
          }))
          if (!returnedColumns) {
            yield { kind: 'columns', columns: cols }
            returnedColumns = true
          }
          const it = st.iterate() as Iterable<Record<string, unknown>>
          let rows: QueryRow[] = []
          let stmtCount = 0
          // SAL-33: batch-level cancel — node:sqlite heeft geen interrupt-API;
          // de runner stopt tussen rij-batches (en de iterator wordt beëindigd).
          for (const row of it) {
            if (signal?.aborted) {
              cancelled = true
              break
            }
            stmtCount++
            rows.push({ values: cols.map((c) => toCell(row[c.name])) })
            if (rows.length >= 1000) {
              yield { kind: 'rows', rows }
              rows = []
            }
          }
          if (!cancelled && rows.length > 0) yield { kind: 'rows', rows }
          totalRows += stmtCount
        } else {
          const result = st.run()
          totalRows += Number(result.changes ?? 0)
        }
        if (cancelled) {
          yield {
            kind: 'done',
            rowCount: totalRows,
            durationMs: Math.round(performance.now() - start),
            cancelled: true
          }
        } else {
          yield {
            kind: 'done',
            rowCount: totalRows,
            durationMs: Math.round(performance.now() - start)
          }
        }
      } catch (err) {
        yield {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
          position: wrapErrorPosition('sqlite', err instanceof Error ? err.message : String(err), currentStmt) ?? undefined
        }
      }
    },

    async cancel(): Promise<void> {
      // node:sqlite heeft geen interrupt/cancel-API; de runner stopt de
      // consumptie tussen rij-batches (batch-level). Dit is géén stille no-op:
      // de gebruiker krijgt een duidelijke melding.
      throw new Error(
        'SQLite: cancel only works between row batches; the running local query stops once the current batch is done.'
      )
    },

    async getExecutionStats(
      _session: DbSession,
      _executionId: string
    ): Promise<QueryStats> {
      return { rowCount: 0, durationMs: 0 }
    },

    // ------------------------------------------------------------------ F4
    // Backup & Restore (DBA) — SQLite is een bestand; backup via VACUUM INTO
    // (consistente snapshot), restore via bestandskopie + heropenen.
    backupRestore: {
      async backupDatabase(
        session: DbSession,
        _database: string,
        targetPath: string,
        options?: BackupOptions
      ): Promise<BackupResult> {
        const { db } = session.handle as SqliteSessionHandle
        const start = performance.now()
        try {
          const { existsSync, rmSync } = await import('node:fs')
          if (existsSync(targetPath)) {
            if (!options?.overwrite) {
              return {
                ok: false,
                targetPath,
                durationMs: Math.round(performance.now() - start),
                message: `Backup file already exists: ${targetPath} (use overwrite to replace)`
              }
            }
            rmSync(targetPath, { force: true })
          }
          db.exec(`VACUUM INTO ${quoteLit(targetPath)}`)
          return { ok: true, targetPath, durationMs: Math.round(performance.now() - start) }
        } catch (err) {
          return {
            ok: false,
            targetPath,
            durationMs: Math.round(performance.now() - start),
            message: err instanceof Error ? err.message : String(err)
          }
        }
      },

      async restoreDatabase(
        session: DbSession,
        _database: string,
        sourcePath: string,
        _options?: RestoreOptions
      ): Promise<RestoreResult> {
        const handle = session.handle as SqliteSessionHandle
        const start = performance.now()
        try {
          const { existsSync, copyFileSync } = await import('node:fs')
          if (!existsSync(sourcePath)) {
            return {
              ok: false,
              sourcePath,
              durationMs: Math.round(performance.now() - start),
              message: `Backup file not found: ${sourcePath}`
            }
          }
          // Bestand vervangen terwijl de database open is, is onveilig:
          // eerst sluiten, dan kopiëren, daarna her-openen (zelfde path).
          handle.db.close()
          copyFileSync(sourcePath, handle.path)
          const reopened = openDb(handle.path)
          reopened.exec('PRAGMA foreign_keys = ON')
          handle.db = reopened
          return { ok: true, sourcePath, durationMs: Math.round(performance.now() - start) }
        } catch (err) {
          return {
            ok: false,
            sourcePath,
            durationMs: Math.round(performance.now() - start),
            message: err instanceof Error ? err.message : String(err)
          }
        }
      }
    } satisfies BackupRestoreApi
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function quoteLit(name: string): string {
  return `'${name.replace(/'/g, "''")}'`
}

/** Regex-escape voor identifier-matching in opgeslagen SQL. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** SQLite-waarden naar QueryCellValue; Uint8Array/Buffer blijft binair. */
function toCell(v: unknown): QueryCellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
    return v
  }
  if (v instanceof Uint8Array) return v
  if (v instanceof Date) return v.toISOString()
  return String(v)
}
