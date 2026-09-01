/**
 * @nvag/providers/mysql — MySQL/MariaDB-provider via `mysql2`.
 *
 * F1: connect/test/metadata/execute conform het DatabaseProvider-contract;
 * dezelfde contracttests als SQLite/PostgreSQL via @nvag/contract-tests.
 */

import { createConnection } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2'
import type {
  ColumnInfo,
  ConnectionConfig,
  ConnectionSecret,
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
  QueryCellValue,
  QueryChunk,
  QueryOptions,
  QueryRow,
  QueryStats,
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
import { buildLimit, containsKeyword, splitStatements } from '@nvag/sql-dialect'

export interface MySqlSessionHandle {
  conn: Awaited<ReturnType<typeof createConnection>>
  /** SAL-33: verbindingsconfig (in-memory) voor de aparte KILL-verbinding. */
  connConfig: ReturnType<typeof buildConnConfig>
}

type Conn = Awaited<ReturnType<typeof createConnection>>

/** Actieve MySQL-query per executionId (SAL-33): cancel via KILL QUERY. */
interface ActiveMySqlQuery {
  threadId: number
  connConfig: ReturnType<typeof buildConnConfig>
}
const activeMySqlQueries = new Map<string, ActiveMySqlQuery>()

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
  supportsSchemas: false, // MySQL: database = schema
  supportsSequences: false, // AUTO_INCREMENT
  supportsSynonyms: false, // MySQL: geen synonyms (SAL-32)
  supportsTriggers: true,
  supportsExecutionPlans: true,
  supportsMonitoring: true,
  supportsTransactions: true,
  supportsIdentityColumns: true,
  supportsGeneratedColumns: true,
  supportsDdlAdmin: true,
  supportsUsersAndRoles: true,
  supportsBackupRestore: false,
  maxResultRowsDefault: 1000,
  dialect: 'mysql'
}

function buildConnConfig(config: ConnectionConfig, secret?: ConnectionSecret) {
  return {
    host: config.host,
    port: config.port ?? 3306,
    database: config.database || undefined,
    user: config.username,
    password: secret?.password,
    connectTimeout: config.connectionTimeoutMs ?? 10000,
    ssl: config.ssl.mode !== 'disable' ? { rejectUnauthorized: config.ssl.mode === 'verify-full' } : undefined
  }
}

/** mysql2 query-helper: cast rows naar het gewenste type (RowDataPacket-basis). */
async function queryRows<T>(conn: Conn, sql: string, params?: unknown[]): Promise<T[]> {
  const [rows] = await conn.query<RowDataPacket[]>(sql, params)
  return rows as unknown as T[]
}

export function createMySqlProvider(): DatabaseProvider {
  return {
    id: 'mysql',
    displayName: 'MySQL',
    defaultPort: 3306,
    capabilities: CAPABILITIES,

    async connect(config: ConnectionConfig, secret?: ConnectionSecret): Promise<DbSession> {
      const connConfig = buildConnConfig(config, secret)
      const conn = await createConnection(connConfig)
      const session: DbSession = {
        handle: { conn, connConfig } satisfies MySqlSessionHandle,
        connectionId: config.id,
        providerId: 'mysql',
        database: config.database ?? ''
      }
      return session
    },

    async testConnection(config: ConnectionConfig, secret?: ConnectionSecret): Promise<TestResult> {
      let conn: Conn | undefined
      try {
        conn = await createConnection(buildConnConfig(config, secret))
        const rows = await queryRows<{ version: string }>(conn, 'SELECT VERSION() AS version')
        await conn.end()
        return {
          ok: true,
          serverInfo: {
            providerId: 'mysql',
            providerName: 'MySQL',
            serverVersion: rows[0]?.version ?? '?'
          }
        }
      } catch (err) {
        if (conn) {
          try {
            await conn.end()
          } catch {
            /* negeren */
          }
        }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },

    async getServerInfo(session: DbSession): Promise<ServerInfo> {
      const { conn } = session.handle as MySqlSessionHandle
      const rows = await queryRows<{ version: string; db: string | null; user: string }>(
        conn,
        'SELECT VERSION() AS version, DATABASE() AS db, CURRENT_USER() AS user'
      )
      return {
        providerId: 'mysql',
        providerName: 'MySQL',
        serverVersion: rows[0]?.version ?? '?',
        productName: 'MySQL',
        currentDatabase: rows[0]?.db ?? undefined,
        currentUser: rows[0]?.user
      }
    },

    async close(session: DbSession): Promise<void> {
      const { conn } = session.handle as MySqlSessionHandle
      try {
        await conn.end()
      } catch {
        /* al gesloten */
      }
    },

    async listDatabases(session: DbSession): Promise<DatabaseInfo[]> {
      const { conn } = session.handle as MySqlSessionHandle
      const rows = await queryRows<{ name: string }>(
        conn,
        'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'
      )
      return rows.map((row) => ({ name: row.name }))
    },

    async listSchemas(_session: DbSession, db: string): Promise<SchemaInfo[]> {
      // MySQL: database = schema; één entry per database.
      return [{ name: db }]
    },

    async listTables(session: DbSession, db: string): Promise<TableInfo[]> {
      const { conn } = session.handle as MySqlSessionHandle
      const rows = await queryRows<{ name: string }>(
        conn,
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
        [db]
      )
      return rows.map((row) => ({ name: row.name, schema: db, type: 'table' }))
    },

    async listViews(session: DbSession, db: string): Promise<ViewInfo[]> {
      const { conn } = session.handle as MySqlSessionHandle
      const rows = await queryRows<{ name: string }>(
        conn,
        `SELECT TABLE_NAME AS name FROM information_schema.VIEWS
         WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [db]
      )
      return rows.map((row) => ({ name: row.name, schema: db }))
    },

    async listProcedures(session: DbSession, db: string): Promise<ProcInfo[]> {
      const { conn } = session.handle as MySqlSessionHandle
      const rows = await queryRows<{ name: string; type: string }>(
        conn,
        `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
         WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
        [db]
      )
      return rows.map((row) => ({
        name: row.name,
        schema: db,
        type: row.type === 'PROCEDURE' ? 'procedure' : 'function'
      }))
    },

    async listFunctions(session: DbSession, db: string): Promise<FuncInfo[]> {
      const { conn } = session.handle as MySqlSessionHandle
      const rows = await queryRows<{ name: string }>(
        conn,
        `SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES
         WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION' ORDER BY ROUTINE_NAME`,
        [db]
      )
      return rows.map((row) => ({ name: row.name, schema: db }))
    },

    async listTriggers(session: DbSession, db: string): Promise<TriggerInfo[]> {
      const { conn } = session.handle as MySqlSessionHandle
      const rows = await queryRows<{ name: string; table: string }>(
        conn,
        `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS \`table\` FROM information_schema.TRIGGERS
         WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
        [db]
      )
      return rows.map((row) => ({ name: row.name, schema: db, table: row.table }))
    },

    async listSequences(): Promise<SeqInfo[]> {
      return [] // MySQL: AUTO_INCREMENT
    },

    async listSynonyms(): Promise<SynonymInfo[]> {
      return [] // MySQL: geen synonyms (SAL-32)
    },

    async listUsers(): Promise<DbUserInfo[]> {
      return [] // MySQL: nog niet ontsloten (SAL-32)
    },

    async listRoles(): Promise<DbRoleInfo[]> {
      return [] // MySQL: nog niet ontsloten (SAL-32)
    },

    async getTableMetadata(
      session: DbSession,
      db: string,
      _schema: string,
      table: string
    ): Promise<TableMetadata> {
      const { conn } = session.handle as MySqlSessionHandle

      // Kolommen
      const colRows = await queryRows<{
        name: string
        data_type: string
        is_nullable: string
        column_default: string | null
        extra: string
        ordinal: number
        column_key: string
      }>(
        conn,
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable,
                COLUMN_DEFAULT AS column_default, EXTRA AS extra, ORDINAL_POSITION AS ordinal, COLUMN_KEY AS column_key
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [db, table]
      )

      const pkSet = new Set(colRows.filter((c) => c.column_key === 'PRI').map((c) => c.name))

      // FKs
      const fkRows = await queryRows<{
        name: string
        column: string
        ref_schema: string
        ref_table: string
        ref_column: string
      }>(
        conn,
        `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS \`column\`,
                k.REFERENCED_TABLE_SCHEMA AS ref_schema, k.REFERENCED_TABLE_NAME AS ref_table,
                k.REFERENCED_COLUMN_NAME AS ref_column
         FROM information_schema.KEY_COLUMN_USAGE k
         WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
        [db, table]
      )
      const fkMap = new Map<string, ForeignKeyInfo>()
      for (const fk of fkRows) {
        const existing = fkMap.get(fk.name)
        if (existing) {
          existing.columns.push(fk.column)
          existing.referencedColumns.push(fk.ref_column)
        } else {
          fkMap.set(fk.name, {
            name: fk.name,
            columns: [fk.column],
            referencedTable: fk.ref_table,
            referencedSchema: fk.ref_schema,
            referencedColumns: [fk.ref_column]
          })
        }
      }

      // Indexen
      const idxRows = await queryRows<{ name: string; column: string; unique: number; seq: number }>(
        conn,
        `SELECT INDEX_NAME AS name, COLUMN_NAME AS \`column\`, NON_UNIQUE AS \`unique\`, SEQ_IN_INDEX AS seq
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME != 'PRIMARY'
         ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [db, table]
      )
      const idxMap = new Map<string, IndexInfo>()
      for (const idx of idxRows) {
        const existing = idxMap.get(idx.name)
        if (existing) {
          existing.columns.push(idx.column)
        } else {
          idxMap.set(idx.name, { name: idx.name, columns: [idx.column], isUnique: idx.unique === 0 })
        }
      }

      // Triggers
      const trigRows = await queryRows<{ name: string }>(
        conn,
        `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
         WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`,
        [db, table]
      )

      const constraints: ConstraintInfo[] = []
      for (const c of colRows) {
        if (c.column_default !== null && c.column_default !== undefined) {
          constraints.push({ name: `default_${c.name}`, type: 'DEFAULT', definition: String(c.column_default) })
        }
      }
      if (pkSet.size > 0) {
        constraints.push({ name: 'PRIMARY', type: 'PRIMARY KEY', definition: [...pkSet].join(', ') })
      }
      for (const idx of idxMap.values()) {
        if (idx.isUnique) constraints.push({ name: idx.name, type: 'UNIQUE', definition: idx.columns.join(', ') })
      }

      const columns: ColumnInfo[] = colRows.map((c, i) => ({
        name: c.name,
        dataType: c.data_type,
        nullable: c.is_nullable === 'YES' && !pkSet.has(c.name),
        defaultValue: c.column_default,
        isIdentity: c.extra.includes('auto_increment'),
        isComputed: c.extra.includes('GENERATED'),
        isPrimaryKey: pkSet.has(c.name),
        ordinalPosition: c.ordinal ?? i + 1
      }))

      let rowCount: number | undefined
      try {
        const r = await queryRows<{ n: string }>(
          conn,
          `SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
          [db, table]
        )
        rowCount = Number(r[0]?.n ?? 0)
      } catch {
        rowCount = undefined
      }

      return {
        columns,
        primaryKey: [...pkSet],
        foreignKeys: [...fkMap.values()],
        indexes: [...idxMap.values()],
        constraints,
        triggers: trigRows.map((t) => t.name),
        dependencies: [] as DependencyInfo[],
        rowCount
      }
    },

    async getObjectDefinition(session: DbSession, obj: DbObjectRef): Promise<string> {
      const { conn } = session.handle as MySqlSessionHandle
      const kind = obj.type === 'view' ? 'VIEW' : 'TABLE'
      const rows = await queryRows<Record<string, string>>(
        conn,
        `SHOW CREATE ${kind} \`${obj.database}\`.\`${obj.name}\``
      )
      const key = obj.type === 'view' ? 'Create View' : 'Create Table'
      const def = rows[0]?.[key]
      if (!def) throw new Error(`MySQL: geen definitie gevonden voor ${obj.name}`)
      return `${def};`
    },

    async *executeQuery(
      session: DbSession,
      sql: string,
      opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      const { conn, connConfig } = session.handle as MySqlSessionHandle
      const maxRows = opts.maxRows ?? CAPABILITIES.maxResultRowsDefault
      const executionId = opts.executionId
      const signal = opts.signal

      const statements = splitStatements(sql)
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
      const isSelect = /^\s*(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i.test(stmt)
      const capped = isSelect && !containsKeyword(stmt, 'LIMIT') ? `${stmt} ${buildLimit('mysql', maxRows)}`.trim() : stmt

      const start = performance.now()
      // SAL-33: echte cancel — `provider.cancel()` voert KILL QUERY <threadId>
      // uit via een aparte verbinding; daarnaast raced het abort-signaal de
      // wacht op de query zodat de generator nooit blijft hangen.
      const q = conn.query(capped)
      if (executionId) {
        activeMySqlQueries.set(executionId, { threadId: conn.threadId, connConfig })
      }

      try {
        const { aborted, value } = await raceWithSignal(q, signal)
        if (aborted) {
          yield {
            kind: 'done',
            rowCount: 0,
            durationMs: Math.round(performance.now() - start),
            cancelled: true
          }
          return
        }
        const result = value![0]
        if (isSelect) {
          const rowsArr = (result as Record<string, unknown>[]) ?? []
          const columns = rowsArr.length > 0 ? Object.keys(rowsArr[0]!) : []
          yield {
            kind: 'columns',
            columns: columns.map((name) => ({ name }))
          }
          const rows: QueryRow[] = []
          for (const row of rowsArr) {
            rows.push({ values: columns.map((c) => toCell(row[c])) })
            if (rows.length >= 1000) {
              yield { kind: 'rows', rows }
              rows.length = 0
            }
          }
          if (rows.length > 0) yield { kind: 'rows', rows }
          yield {
            kind: 'done',
            rowCount: rowsArr.length,
            durationMs: Math.round(performance.now() - start)
          }
        } else {
          const info = result as { affectedRows?: number }
          yield {
            kind: 'done',
            rowCount: info.affectedRows ?? 0,
            durationMs: Math.round(performance.now() - start)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (signal?.aborted) {
          // Annulering is géén fout.
          yield {
            kind: 'done',
            rowCount: 0,
            durationMs: Math.round(performance.now() - start),
            cancelled: true
          }
        } else {
          yield {
            kind: 'error',
            message
          }
        }
      } finally {
        if (executionId) activeMySqlQueries.delete(executionId)
      }
    },

    async cancel(_session: DbSession, executionId: string): Promise<void> {
      // Echte cancel (SAL-33): KILL QUERY <threadId> op een aparte verbinding
      // (de hoofdverbinding is bezet met de actieve query). Vereist de
      // PROCESS-privilege (of dezelfde gebruiker); anders gooit dit en meldt
      // de runner dat cancel niet volledig ondersteund wordt.
      const entry = activeMySqlQueries.get(executionId)
      if (!entry) return
      const killConn = await createConnection(entry.connConfig)
      try {
        // threadId is altijd een geheel getal van de server — safe om te
        // interpoleren (KILL accepteert geen placeholders in alle versies).
        await killConn.query(`KILL QUERY ${Number(entry.threadId)}`)
      } finally {
        try {
          await killConn.end()
        } catch {
          // negeren
        }
      }
    },

    async getExecutionStats(): Promise<QueryStats> {
      return { rowCount: 0, durationMs: 0 }
    }
  }
}

function toCell(v: unknown): QueryCellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return v
  if (v instanceof Date) return v.toISOString()
  if (v instanceof Uint8Array) return v
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
