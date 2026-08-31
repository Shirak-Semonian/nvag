/**
 * @nvag/providers/databricks — Databricks SQL-provider via
 * `@databricks/sql` (DBSQLClient).
 *
 * F2-9: Databricks SQL (dialect `databricks` — backtick-quoting, LIMIT).
 * - connect/test via host + token (HTTP-pad optioneel via extraParams)
 * - metadata via information_schema (catalog/database-gelimiteerd)
 * - executeQuery: SELECT met maxRows, DML, multi-statement weigering
 *
 * Tests zijn env-gated op NVAG_TEST_DATABRICKS_URL
 * (bijv. databricks://token@host:443/default?httpPath=/sql/1.0/warehouses/xxx).
 */

import { DBSQLClient } from '@databricks/sql'
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
  ServerInfo,
  TableInfo,
  TableMetadata,
  TestResult,
  TriggerInfo,
  ViewInfo
} from '@nvag/contracts'
import { buildLimit, containsKeyword, quoteIdentifier, splitStatements } from '@nvag/sql-dialect'

export interface DatabricksSessionHandle {
  client: DBSQLClient
  session: Awaited<ReturnType<DBSQLClient['openSession']>>
}

const CAPABILITIES: ProviderCapabilities = {
  supportsSchemas: true,
  supportsSequences: false,
  supportsTriggers: false,
  supportsExecutionPlans: false,
  supportsMonitoring: false,
  supportsTransactions: false,
  supportsIdentityColumns: false,
  supportsGeneratedColumns: true,
  supportsDdlAdmin: true,
  supportsUsersAndRoles: false,
  supportsBackupRestore: false,
  maxResultRowsDefault: 1000,
  dialect: 'databricks'
}

function toCell(v: unknown): QueryCellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v
  return v as QueryCellValue
}

export function createDatabricksProvider(): DatabaseProvider {
  const sessions = new Map<string, DbSession>()

  return {
    id: 'databricks',
    displayName: 'Databricks SQL',
    defaultPort: 443,
    capabilities: CAPABILITIES,

    async connect(config: ConnectionConfig, secret?: ConnectionSecret): Promise<DbSession> {
      if (!config.host) throw new Error('Databricks: geen host opgegeven')
      const client = new DBSQLClient()
      const port = config.port ?? 443
      const path = config.extraParams?.['httpPath'] ?? config.extraParams?.['path'] ?? '/sql/1.0/warehouses/default'
      await client.connect({
        host: config.host,
        port,
        path,
        token: secret?.token ?? secret?.password ?? '',
        authType: config.auth === 'oauth' ? 'databricks-oauth' : 'access-token',
        ...(config.ssl.mode !== 'disable' ? { tls: true } : {})
      })
      const session = await client.openSession({
        ...(config.database ? { initialCatalog: config.database, initialSchema: 'default' } : {})
      })
      const dbSession: DbSession = {
        handle: { client, session } satisfies DatabricksSessionHandle,
        connectionId: config.id,
        providerId: 'databricks',
        database: config.database ?? ''
      }
      sessions.set(config.id, dbSession)
      return dbSession
    },

    async testConnection(config: ConnectionConfig, secret?: ConnectionSecret): Promise<TestResult> {
      let client: DBSQLClient | undefined
      try {
        client = new DBSQLClient()
        const port = config.port ?? 443
        const path = config.extraParams?.['httpPath'] ?? '/sql/1.0/warehouses/default'
        await client.connect({
          host: config.host,
          port,
          path,
          token: secret?.token ?? secret?.password ?? '',
          authType: 'access-token'
        })
        const s = await client.openSession({})
        const r = await s.executeStatement('SELECT 1 AS v')
        await r.close()
        await s.close()
        await client.close()
        return { ok: true, serverInfo: { providerId: 'databricks', providerName: 'Databricks SQL', serverVersion: config.host } }
      } catch (err) {
        if (client) {
          try {
            await client.close()
          } catch {
            /* negeren */
          }
        }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },

    async getServerInfo(session: DbSession): Promise<ServerInfo> {
      const { session: s } = session.handle as DatabricksSessionHandle
      const stmt = await s.executeStatement('SELECT current_catalog() AS cat, current_user() AS u, current_database() AS db')
      const rows = (await stmt.fetchAll()) as Record<string, unknown>[]
      await stmt.close()
      const row = rows[0]
      return {
        providerId: 'databricks',
        providerName: 'Databricks SQL',
        serverVersion: 'Databricks SQL',
        productName: 'Databricks SQL',
        currentDatabase: row?.db != null ? String(row.db) : session.database,
        currentUser: row?.u != null ? String(row.u) : undefined
      }
    },

    async close(session: DbSession): Promise<void> {
      const { client, session: s } = session.handle as DatabricksSessionHandle
      try {
        await s.close()
      } catch {
        /* negeren */
      }
      try {
        await client.close()
      } catch {
        /* negeren */
      }
      sessions.delete(session.connectionId)
    },

    async listDatabases(session: DbSession): Promise<DatabaseInfo[]> {
      const { session: s } = session.handle as DatabricksSessionHandle
      const stmt = await s.executeStatement('SHOW DATABASES')
      const rows = await stmt.fetchAll()
      await stmt.close()
      return rows.map((r) => ({ name: String(Object.values(r)[0] ?? '') })).filter((d) => d.name)
    },

    async listSchemas(session: DbSession, _db: string): Promise<SchemaInfo[]> {
      const { session: s } = session.handle as DatabricksSessionHandle
      const stmt = await s.executeStatement('SHOW SCHEMAS')
      const rows = await stmt.fetchAll()
      await stmt.close()
      return rows.map((r) => ({ name: String(Object.values(r)[0] ?? '') })).filter((x) => x.name)
    },

    async listTables(session: DbSession, _db: string, schema = 'default'): Promise<TableInfo[]> {
      const { session: s } = session.handle as DatabricksSessionHandle
      const stmt = await s.executeStatement(`SHOW TABLES IN ${quoteIdentifier('databricks', schema)}`)
      const rows = (await stmt.fetchAll()) as Record<string, unknown>[]
      await stmt.close()
      const out: TableInfo[] = []
      for (const r of rows) {
        const vals = Object.values(r)
        const name = String(vals[2] ?? '')
        if (name) out.push({ name, schema, type: 'table' })
      }
      return out
    },

    async listViews(session: DbSession, _db: string, schema = 'default'): Promise<ViewInfo[]> {
      const { session: s } = session.handle as DatabricksSessionHandle
      const stmt = await s.executeStatement(
        `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_type = 'VIEW'`
      )
      const rows = (await stmt.fetchAll()) as Record<string, unknown>[]
      await stmt.close()
      const out: ViewInfo[] = []
      for (const r of rows) {
        const name = String(r.name ?? '')
        if (name) out.push({ name, schema })
      }
      return out
    },

    async listProcedures(): Promise<ProcInfo[]> {
      return []
    },

    async listFunctions(session: DbSession, _db: string, schema = 'default'): Promise<FuncInfo[]> {
      const { session: s } = session.handle as DatabricksSessionHandle
      const stmt = await s.executeStatement(
        `SELECT routine_name AS name FROM information_schema.routines WHERE routine_schema = '${schema.replace(/'/g, "''")}'`
      )
      const rows = (await stmt.fetchAll()) as Record<string, unknown>[]
      await stmt.close()
      const out: FuncInfo[] = []
      for (const r of rows) {
        const name = String(r.name ?? '')
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

    async getTableMetadata(
      session: DbSession,
      _db: string,
      schema = 'default',
      table: string
    ): Promise<TableMetadata> {
      const { session: s } = session.handle as DatabricksSessionHandle
      const stmt = await s.executeStatement(
        `SELECT column_name, data_type, is_nullable, column_default, ordinal_position
         FROM information_schema.columns
         WHERE table_schema = '${schema.replace(/'/g, "''")}' AND table_name = '${table.replace(/'/g, "''")}'
         ORDER BY ordinal_position`
      )
      const rows = (await stmt.fetchAll()) as Record<string, unknown>[]
      await stmt.close()
      const pkSet = new Set<string>()
      const columns: ColumnInfo[] = rows.map((r, i) => ({
        name: String(r.column_name ?? ''),
        dataType: String(r.data_type ?? 'STRING'),
        nullable: String(r.is_nullable ?? 'YES') === 'YES',
        defaultValue: r.column_default != null ? String(r.column_default) : null,
        isIdentity: false,
        isComputed: false,
        isPrimaryKey: false,
        ordinalPosition: Number(r.ordinal_position ?? i + 1)
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
      const { session: s } = session.handle as DatabricksSessionHandle
      const schema = obj.schema ?? 'default'
      const stmt = await s.executeStatement(
        `SHOW CREATE TABLE ${quoteIdentifier('databricks', schema)}.${quoteIdentifier('databricks', obj.name)}`
      )
      const rows = await stmt.fetchAll()
      await stmt.close()
      const ddl = rows[0] ? Object.values(rows[0])[0] : undefined
      if (ddl == null) throw new Error(`Databricks: geen definitie gevonden voor ${schema}.${obj.name}`)
      return `${String(ddl)};`
    },

    async *executeQuery(
      session: DbSession,
      sql: string,
      opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      const { session: s } = session.handle as DatabricksSessionHandle
      const maxRows = opts.maxRows ?? CAPABILITIES.maxResultRowsDefault

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

      const stmtText = statements[0]!
      const isSelect = /^\s*(SELECT|WITH|SHOW|DESCRIBE)\b/i.test(stmtText)
      const capped =
        isSelect && !containsKeyword(stmtText, 'LIMIT')
          ? `${stmtText} ${buildLimit('databricks', maxRows)}`.trim()
          : stmtText

      const start = performance.now()
      try {
        const stmt = await s.executeStatement(capped)
        const schema = await stmt.getSchema()
        const columns =
          schema?.columns.map((c) => ({ name: c.columnName, dataType: undefined })) ?? []
        const rows = (await stmt.fetchAll()) as Record<string, unknown>[]
        await stmt.close()
        if (isSelect) {
          yield { kind: 'columns', columns }
          const out: QueryRow[] = []
          for (const row of rows) {
            out.push({ values: columns.map((c) => toCell((row as Record<string, unknown>)[c.name])) })
            if (out.length >= 1000) {
              yield { kind: 'rows', rows: out }
              out.length = 0
            }
          }
          if (out.length > 0) yield { kind: 'rows', rows: out }
          yield { kind: 'done', rowCount: rows.length, durationMs: Math.round(performance.now() - start) }
        } else {
          yield { kind: 'done', rowCount: rows.length, durationMs: Math.round(performance.now() - start) }
        }
      } catch (err) {
        yield { kind: 'error', message: err instanceof Error ? err.message : String(err) }
      }
    },

    async cancel(): Promise<void> {
      // @databricks/sql biedt geen directe cancel-API; no-op.
    },

    async getExecutionStats(): Promise<QueryStats> {
      return { rowCount: 0, durationMs: 0 }
    }
  }
}
