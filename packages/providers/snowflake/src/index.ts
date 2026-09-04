/**
 * @nvag/providers/snowflake — Snowflake-provider via `snowflake-sdk`.
 *
 * F2-9: Snowflake (dialect `snowflake` — `"x"`-quoting, LIMIT).
 * - connect/test via account + username/password (of token)
 * - metadata via INFORMATION_SCHEMA (schema-gelimiteerd)
 * - executeQuery: SELECT met maxRows, DML, multi-statement weigering
 *
 * Tests zijn env-gated op NVAG_TEST_SNOWFLAKE_URL.
 */

import snowflake from 'snowflake-sdk'
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
import { buildLimit, containsKeyword, quoteIdentifier, splitStatements } from '@nvag/sql-dialect'

export interface SnowflakeSessionHandle {
  conn: snowflake.Connection
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
  supportsSchemas: true,
  supportsSequences: true,
  supportsSynonyms: false, // Snowflake: geen synonyms (SAL-32)
  supportsTriggers: false,
  supportsExecutionPlans: false,
  supportsMonitoring: false,
  supportsTransactions: true,
  supportsIdentityColumns: true,
  supportsGeneratedColumns: true,
  supportsDdlAdmin: true,
  supportsUsersAndRoles: true,
  supportsBackupRestore: false,
  maxResultRowsDefault: 1000,
  dialect: 'snowflake'
}

function buildConnection(config: ConnectionConfig, secret?: ConnectionSecret): snowflake.Connection {
  return snowflake.createConnection({
    account: config.host,
    username: config.username,
    password: secret?.password,
    database: config.database,
    schema: config.extraParams?.['schema'],
    warehouse: config.extraParams?.['warehouse'],
    role: config.extraParams?.['role'],
    authenticator: config.auth === 'oauth' ? 'oauth' : undefined,
    token: secret?.token,
    timeout: Math.floor((config.connectionTimeoutMs ?? 10000) / 1000)
  })
}

function connectAsync(conn: snowflake.Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.connect((err) => (err ? reject(err) : resolve()))
  })
}

function destroyAsync(conn: snowflake.Connection): Promise<void> {
  return new Promise((resolve) => {
    try {
      conn.destroy(() => resolve())
    } catch {
      resolve()
    }
  })
}

function executeAsync(
  conn: snowflake.Connection,
  sqlText: string,
  options: Omit<snowflake.StatementOption, 'sqlText'> = {}
): Promise<{ stmt: snowflake.RowStatement; rows: unknown[][] }> {
  return new Promise((resolve, reject) => {
    conn.execute({
      ...options,
      sqlText,
      complete: (err, stmt, rows) => (err ? reject(err) : resolve({ stmt, rows: (rows ?? []) as unknown[][] }))
    })
  })
}

function toCell(v: unknown): QueryCellValue {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return v
  return v as QueryCellValue
}

export function createSnowflakeProvider(): DatabaseProvider {
  const sessions = new Map<string, DbSession>()

  return {
    id: 'snowflake',
    displayName: 'Snowflake',
    defaultPort: 443,
    capabilities: CAPABILITIES,

    async connect(config: ConnectionConfig, secret?: ConnectionSecret): Promise<DbSession> {
      if (!config.host) throw new Error('Snowflake: no account provided (host = account)')
      const conn = buildConnection(config, secret)
      await connectAsync(conn)
      const session: DbSession = {
        handle: { conn } satisfies SnowflakeSessionHandle,
        connectionId: config.id,
        providerId: 'snowflake',
        database: config.database ?? ''
      }
      sessions.set(config.id, session)
      return session
    },

    async testConnection(config: ConnectionConfig, secret?: ConnectionSecret): Promise<TestResult> {
      let conn: snowflake.Connection | undefined
      try {
        conn = buildConnection(config, secret)
        await connectAsync(conn)
        const { rows: verRows } = await executeAsync(conn, 'SELECT CURRENT_VERSION() AS v')
        const v = String(verRows[0]?.[0] ?? '?')
        await destroyAsync(conn)
        return { ok: true, serverInfo: { providerId: 'snowflake', providerName: 'Snowflake', serverVersion: v } }
      } catch (err) {
        if (conn) {
          try {
            await destroyAsync(conn)
          } catch {
            /* negeren */
          }
        }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },

    async getServerInfo(session: DbSession): Promise<ServerInfo> {
      const { conn } = session.handle as SnowflakeSessionHandle
      const { rows: infoRows } = await executeAsync(conn, 'SELECT CURRENT_VERSION() AS v, CURRENT_DATABASE() AS db, CURRENT_USER() AS u')
      const row = infoRows[0]
      return {
        providerId: 'snowflake',
        providerName: 'Snowflake',
        serverVersion: String(row?.[0] ?? '?'),
        productName: 'Snowflake',
        currentDatabase: row?.[1] != null ? String(row[1]) : session.database,
        currentUser: row?.[2] != null ? String(row[2]) : undefined
      }
    },

    async close(session: DbSession): Promise<void> {
      const { conn } = session.handle as SnowflakeSessionHandle
      try {
        await destroyAsync(conn)
      } catch {
        /* al gesloten */
      }
      sessions.delete(session.connectionId)
    },

    async listDatabases(session: DbSession): Promise<DatabaseInfo[]> {
      const { conn } = session.handle as SnowflakeSessionHandle
      const { rows } = await executeAsync(conn, 'SHOW DATABASES')
      return rows.map((r) => ({ name: String(r[1] ?? '') })).filter((d) => d.name)
    },

    async listSchemas(session: DbSession, _db: string): Promise<SchemaInfo[]> {
      const { conn } = session.handle as SnowflakeSessionHandle
      const { rows } = await executeAsync(conn, 'SHOW SCHEMAS')
      return rows.map((r) => ({ name: String(r[1] ?? '') })).filter((s) => s.name)
    },

    async listTables(session: DbSession, _db: string, schema = 'PUBLIC'): Promise<TableInfo[]> {
      const { conn } = session.handle as SnowflakeSessionHandle
      const { rows } = await executeAsync(conn, `SHOW TABLES IN SCHEMA ${quoteIdentifier('snowflake', schema)}`)
      const out: TableInfo[] = []
      for (const r of rows) {
        const name = String(r[1] ?? '')
        if (name) out.push({ name, schema, type: 'table' })
      }
      return out
    },

    async listViews(session: DbSession, _db: string, schema = 'PUBLIC'): Promise<ViewInfo[]> {
      const { conn } = session.handle as SnowflakeSessionHandle
      const { rows } = await executeAsync(conn, `SHOW VIEWS IN SCHEMA ${quoteIdentifier('snowflake', schema)}`)
      const out: ViewInfo[] = []
      for (const r of rows) {
        const name = String(r[1] ?? '')
        if (name) out.push({ name, schema })
      }
      return out
    },

    async listProcedures(): Promise<ProcInfo[]> {
      return []
    },

    async listFunctions(session: DbSession, _db: string, schema = 'PUBLIC'): Promise<FuncInfo[]> {
      const { conn } = session.handle as SnowflakeSessionHandle
      const { rows } = await executeAsync(conn, `SHOW USER FUNCTIONS IN SCHEMA ${quoteIdentifier('snowflake', schema)}`)
      const out: FuncInfo[] = []
      for (const r of rows) {
        const name = String(r[1] ?? '')
        if (name) out.push({ name, schema })
      }
      return out
    },

    async listTriggers(): Promise<TriggerInfo[]> {
      return []
    },

    async listSequences(): Promise<SeqInfo[]> {
      return []
    },

    async listSynonyms(): Promise<SynonymInfo[]> {
      return [] // Snowflake: geen synonyms (SAL-32)
    },

    async listUsers(): Promise<DbUserInfo[]> {
      return [] // Snowflake: security nog niet ontsloten (SAL-32)
    },

    async listRoles(): Promise<DbRoleInfo[]> {
      return [] // Snowflake: security nog niet ontsloten (SAL-32)
    },

    async getTableMetadata(
      session: DbSession,
      _db: string,
      schema = 'PUBLIC',
      table: string
    ): Promise<TableMetadata> {
      const { conn } = session.handle as SnowflakeSessionHandle
      const { rows } = await executeAsync(
        conn,
        `SELECT column_name, data_type, is_nullable, column_default, ordinal_position
         FROM information_schema.columns
         WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}'
         ORDER BY ordinal_position`
      )
      const pkSet = new Set<string>()
      const columns: ColumnInfo[] = rows.map((r, i) => ({
        name: String(r[0] ?? ''),
        dataType: String(r[1] ?? 'TEXT'),
        nullable: String(r[2] ?? 'YES') === 'YES',
        defaultValue: r[3] != null ? String(r[3]) : null,
        isIdentity: /(AUTOINCREMENT|IDENTITY)/i.test(String(r[3] ?? '')),
        isComputed: false,
        isPrimaryKey: false,
        ordinalPosition: Number(r[4] ?? i + 1)
      }))
      return {
        columns,
        primaryKey: [...pkSet],
        foreignKeys: [] as ForeignKeyInfo[],
        indexes: [] as IndexInfo[],
        constraints: [] as ConstraintInfo[],
        triggers: [],
        dependencies: [] as DependencyInfo[]
      }
    },

    async getObjectDefinition(session: DbSession, obj: DbObjectRef): Promise<string> {
      const { conn } = session.handle as SnowflakeSessionHandle
      const schema = obj.schema ?? 'PUBLIC'
      const { rows } = await executeAsync(
        conn,
        `SELECT GET_DDL('TABLE', '${schema.replace(/'/g, "''")}.${obj.name.replace(/'/g, "''")}') AS ddl`
      )
      const ddl = rows[0]?.[0]
      if (ddl == null) throw new Error(`Snowflake: no definition found for ${schema}.${obj.name}`)
      return `${String(ddl)};`
    },

    async *executeQuery(
      session: DbSession,
      sql: string,
      opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      const { conn } = session.handle as SnowflakeSessionHandle
      const maxRows = opts.maxRows ?? CAPABILITIES.maxResultRowsDefault

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

      const stmtText = statements[0]!
      const isSelect = /^\s*(SELECT|WITH|SHOW)\b/i.test(stmtText)
      const capped =
        isSelect && !containsKeyword(stmtText, 'LIMIT')
          ? `${stmtText} ${buildLimit('snowflake', maxRows)}`.trim()
          : stmtText

      const start = performance.now()
      // SAL-33: race het abort-signaal zodat de generator nooit blijft hangen;
      // echte server-side cancel is voor Snowflake niet beschikbaar — cancel()
      // meldt dat duidelijk (geen stille no-op).
      const q = executeAsync(conn, capped, { fetchAsString: ['Date'] })
      try {
        const { aborted, value } = await raceWithSignal(q, opts.signal)
        if (aborted) {
          yield {
            kind: 'done',
            rowCount: 0,
            durationMs: Math.round(performance.now() - start),
            cancelled: true
          }
          return
        }
        const { stmt, rows } = value!
        if (isSelect) {
          const columns = stmt.getColumns().map((c) => ({ name: c.getName(), dataType: c.getType() }))
          yield { kind: 'columns', columns }
          const out: QueryRow[] = []
          for (const row of rows) {
            out.push({ values: row.map(toCell) })
            if (out.length >= 1000) {
              yield { kind: 'rows', rows: out }
              out.length = 0
            }
          }
          if (out.length > 0) yield { kind: 'rows', rows: out }
          yield { kind: 'done', rowCount: rows.length, durationMs: Math.round(performance.now() - start) }
        } else {
          yield {
            kind: 'done',
            rowCount: stmt.getNumRows() ?? 0,
            durationMs: Math.round(performance.now() - start)
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
          yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
        }
      }
    },

    async cancel(): Promise<void> {
      // Snowflake-sdk biedt geen directe cancel-API voor een actieve query.
      // Dit is géén stille no-op: de gebruiker krijgt een duidelijke melding.
      throw new Error(
        'Snowflake: canceling an active query is not supported by the driver. The query is stopped locally; server-side execution may continue.'
      )
    },

    async getExecutionStats(): Promise<QueryStats> {
      return { rowCount: 0, durationMs: 0 }
    }
  }
}
