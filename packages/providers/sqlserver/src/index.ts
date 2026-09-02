/**
 * @nvag/providers/sqlserver — SQL Server-provider via de `mssql`-driver (tedious).
 *
 * F1-1 (SAL-14): eerste netwerk-provider die het DatabaseProvider-contract
 * implementeert. Metadata uit de sys.*-catalogus; executeQuery streamt SELECTs
 * en past maxRows toe via TOP (dialect tsql). Multi-statement wordt geweigerd
 * (contract: één statement per executeQuery).
 *
 * De driver is pure JS (geen native builds) en werkt op Node 20+/Electron.
 */

import sql from 'mssql'
import type { config as MssqlConfig } from 'mssql'
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
  DbRoleInfo,
  DbSession,
  DbUserInfo,
  DependencyInfo,
  ForeignKeyInfo,
  FuncInfo,
  IndexInfo,
  ProcInfo,
  ProviderCapabilities,
  QueryCellValue,
  QueryChunk,
  QueryColumn,
  QueryOptions,
  QueryRow,
  QueryStats,
  RestoreOptions,
  RestoreResult,
  SchemaInfo,
  SeqInfo,
  ServerInfo,
  SynonymInfo,
  TableInfo,
  TableMetadata,
  TestResult,
  TriggerInfo,
  ViewInfo
} from '@nvag/contracts'
import { quoteIdentifier, quoteLiteral, splitStatements, containsKeyword, wrapErrorPosition, buildBackupDatabase, buildRestoreDatabase } from '@nvag/sql-dialect'

export interface SqlServerSessionHandle {
  pool: sql.ConnectionPool
  server: string
  database: string
}

const CAPABILITIES: ProviderCapabilities = {
  supportsSchemas: true, // SQL Server: schemas (dbo, ...)
  supportsSequences: true,
  supportsSynonyms: true, // sys.synonyms (SAL-32)
  supportsTriggers: true,
  supportsExecutionPlans: false, // F3
  supportsMonitoring: true, // F3
  supportsTransactions: true,
  supportsIdentityColumns: true,
  supportsGeneratedColumns: true, // computed columns
  supportsDdlAdmin: true,
  supportsUsersAndRoles: true,
  supportsBackupRestore: true,
  maxResultRowsDefault: 1000,
  dialect: 'tsql'
}

/** Map de Nvag-ssl-mode naar tedious-opties. */
function resolveSslOptions(config: ConnectionConfig): {
  encrypt: boolean
  trustServerCertificate: boolean
} {
  const mode = config.ssl?.mode ?? 'disable'
  if (mode === 'disable') {
    return { encrypt: false, trustServerCertificate: true }
  }
  if (mode === 'prefer') {
    // tedious heeft geen 'prefer'; encrypt aan + cert niet verifiëren is het
    // dichtst bij wat lokale dev-omgevingen verwachten.
    return { encrypt: true, trustServerCertificate: true }
  }
  if (mode === 'require') {
    return { encrypt: true, trustServerCertificate: true }
  }
  // verify-ca / verify-full: cert wél verifiëren (trustServerCertificate=false)
  return { encrypt: true, trustServerCertificate: false }
}

function toMssqlConfig(config: ConnectionConfig, password?: string): MssqlConfig {
  const ssl = resolveSslOptions(config)
  const cfg: MssqlConfig = {
    server: config.host,
    port: config.port ?? 1433,
    user: config.username,
    password,
    database: config.database ?? 'master',
    connectionTimeout: config.connectionTimeoutMs ?? 15000,
    requestTimeout: 30000,
    options: {
      encrypt: ssl.encrypt,
      trustServerCertificate: ssl.trustServerCertificate,
      enableArithAbort: true,
      // Extra provider-specifieke opties uit de config (bijv. appName)
      ...(config.encryption ?? {})
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000
    }
  }
  // Vrije connection-string parameters (extraParams) als tedious-opties doorgeven
  if (config.extraParams) {
    for (const [k, v] of Object.entries(config.extraParams)) {
      const opts = cfg.options as Record<string, unknown>
      if (k === 'appName' || k === 'useUTC' || k === 'cancelTimeout') {
        opts[k] = v === 'true' ? true : v === 'false' ? false : v
      }
    }
  }
  return cfg
}

/** SQL Server-waarden naar QueryCellValue; dates → ISO, buffers blijven binair. */
function toCell(v: unknown): QueryCellValue {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
    return v
  }
  if (v instanceof Uint8Array) return v
  if (v instanceof Date) return v.toISOString()
  return String(v)
}

/** Column-metadata van mssql naar QueryColumn. */
function columnName(col: { name: string }): QueryColumn {
  return { name: col.name }
}

/**
 * Voeg TOP (n) toe aan een SELECT wanneer het statement er nog geen heeft.
 * Gebaseerd op de SAL-8-les: nooit een tweede LIMIT/TOP-clausule toevoegen.
 * Werkt op het eerste statement (multi-statement wordt elders geweigerd).
 * Leading whitespace en commentaar (-- en blok-commentaar) worden overgeslagen.
 */
export function applyTopLimit(sql: string, maxRows: number): string {
  const leading = /^(\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*)/.exec(sql)
  const prefix = leading?.[1] ?? ''
  const rest = sql.slice(prefix.length)
  if (!/^\s*SELECT\b/i.test(rest)) return sql
  if (containsKeyword(rest, 'TOP')) return sql
  if (/^\s*SELECT\s+(DISTINCT|ALL)\s+/i.test(rest)) {
    return prefix + rest.replace(/^(\s*SELECT\s+(?:DISTINCT|ALL)\s+)/i, `$1TOP (${maxRows}) `)
  }
  return prefix + rest.replace(/^(\s*SELECT\s+)/i, `$1TOP (${maxRows}) `)
}

/** Actieve mssql-requests per executionId (SAL-33): koppelt cancel(executionId)
 * aan de juiste request, ook bij parallelle queries/meerdere tabs. */
interface ActiveSqlServerRequest {
  request: sql.Request
  pool: sql.ConnectionPool
  cancelled: boolean
}
const activeRequests = new Map<string, ActiveSqlServerRequest>()

/** Herken een annuleringsfout van mssql/tedious (RequestError 'ECANCEL'). */
function isCancellationError(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: string }).code === 'ECANCEL') return true
  const message = err instanceof Error ? err.message : String(err)
  return /cancel/i.test(message)
}

export function createSqlServerProvider(): DatabaseProvider {
  const sessions = new Map<string, DbSession>()

  return {
    id: 'sqlserver',
    displayName: 'SQL Server',
    defaultPort: 1433,
    capabilities: CAPABILITIES,

    async connect(config: ConnectionConfig, secret?): Promise<DbSession> {
      if (!config.host) throw new Error('SQL Server: geen host opgegeven')
      if (config.auth === 'windows') {
        throw new Error('SQL Server: Windows-authenticatie wordt op Linux niet ondersteund (gebruik username-password)')
      }
      const password = secret?.password
      const pool = new sql.ConnectionPool(toMssqlConfig(config, password))
      try {
        await pool.connect()
      } catch (err) {
        throw new Error(
          `SQL Server: verbinding mislukt (${config.host}:${config.port ?? 1433}) — ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
      const session: DbSession = {
        handle: {
          pool,
          server: config.host,
          database: config.database ?? 'master'
        } satisfies SqlServerSessionHandle,
        connectionId: config.id,
        providerId: 'sqlserver',
        database: config.database ?? 'master'
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
      const { pool } = session.handle as SqlServerSessionHandle
      const result = await pool.request().query<{
        version: string
        product: string
        db: string
        user: string
      }>(
        `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
                CAST(SERVERPROPERTY('ProductName') AS nvarchar(128)) AS product,
                DB_NAME() AS db,
                SUSER_SNAME() AS [user]`
      )
      const row = result.recordset[0]
      return {
        providerId: 'sqlserver',
        providerName: 'SQL Server',
        serverVersion: row?.version ?? 'onbekend',
        productName: row?.product,
        currentDatabase: row?.db ?? session.database,
        currentUser: row?.user
      }
    },

    async close(session: DbSession): Promise<void> {
      const { pool } = session.handle as SqlServerSessionHandle
      // Nog actieve requests van deze sessie beëindigen (voorkomt dat een
      // cancel/sluiting requests in de pool of op de server achterlaat).
      for (const [executionId, entry] of activeRequests) {
        if (entry.pool === pool) {
          entry.cancelled = true
          try {
            entry.request.cancel()
          } catch {
            // request is al beëindigd
          }
          activeRequests.delete(executionId)
        }
      }
      try {
        await pool.close()
      } catch {
        // al gesloten
      }
      sessions.delete(session.connectionId)
    },

    async listDatabases(session: DbSession): Promise<DatabaseInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      // SAL-31: sys.databases heeft géén `size`-kolom (die zit in
      // sys.master_files). Grootte per database = som over alle bestanden
      // (data + log) × 8 KB per page. LEFT JOIN zodat ook databases zonder
      // bestandsrijen (of een offline db) als sizeBytes 0 terugkomen i.p.v.
      // de hele lijst te laten crashen met "Invalid column name 'size'".
      const result = await pool.request().query<{ name: string; size: number | null; status: string }>(
        `SELECT d.name,
                CAST(ISNULL(SUM(mf.size), 0) * 8 * 1024 AS bigint) AS size,
                d.state_desc AS status
         FROM sys.databases d
         LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id
         GROUP BY d.name, d.state_desc
         ORDER BY d.name`
      )
      return result.recordset.map((r) => ({
        name: r.name,
        // tedious geeft bigint terug als JS-bigint; het contract verwacht number.
        sizeBytes: r.size == null ? 0 : Number(r.size),
        status: r.status
      }))
    },

    async listSchemas(session: DbSession, db: string): Promise<SchemaInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      const result = await pool
        .request()
        .query<{ name: string }>(`SELECT name FROM ${dbQ}.sys.schemas ORDER BY name`)
      return result.recordset.map((r) => ({ name: r.name }))
    },

    async listTables(session: DbSession, db: string, schema?: string): Promise<TableInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      const schemaFilter = schema ? `WHERE s.name = ${quoteLiteral('tsql', schema)}` : ''
      const result = await pool.request().query<{ schema: string; name: string }>(
        `SELECT s.name AS [schema], t.name AS name
         FROM ${dbQ}.sys.tables t
         JOIN ${dbQ}.sys.schemas s ON t.schema_id = s.schema_id
         ${schemaFilter}
         ORDER BY s.name, t.name`
      )
      return result.recordset.map((r) => ({ name: r.name, schema: r.schema, type: 'table' }))
    },

    async listViews(session: DbSession, db: string, schema?: string): Promise<ViewInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      const schemaFilter = schema ? `WHERE s.name = ${quoteLiteral('tsql', schema)}` : ''
      const result = await pool.request().query<{ schema: string; name: string }>(
        `SELECT s.name AS [schema], v.name AS name
         FROM ${dbQ}.sys.views v
         JOIN ${dbQ}.sys.schemas s ON v.schema_id = s.schema_id
         ${schemaFilter}
         ORDER BY s.name, v.name`
      )
      return result.recordset.map((r) => ({ name: r.name, schema: r.schema }))
    },

    async listProcedures(session: DbSession, db: string, schema?: string): Promise<ProcInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      const schemaFilter = schema ? `WHERE s.name = ${quoteLiteral('tsql', schema)}` : ''
      const result = await pool.request().query<{ schema: string; name: string }>(
        `SELECT s.name AS [schema], p.name AS name
         FROM ${dbQ}.sys.procedures p
         JOIN ${dbQ}.sys.schemas s ON p.schema_id = s.schema_id
         ${schemaFilter}
         ORDER BY s.name, p.name`
      )
      return result.recordset.map((r) => ({ name: r.name, schema: r.schema, type: 'procedure' }))
    },

    async listFunctions(session: DbSession, db: string, schema?: string): Promise<FuncInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      const schemaFilter = schema ? `AND s.name = ${quoteLiteral('tsql', schema)}` : ''
      const result = await pool.request().query<{ schema: string; name: string }>(
        `SELECT s.name AS [schema], o.name AS name
         FROM ${dbQ}.sys.objects o
         JOIN ${dbQ}.sys.schemas s ON o.schema_id = s.schema_id
         WHERE o.type IN ('FN','IF','TF','FS','FT') ${schemaFilter}
         ORDER BY s.name, o.name`
      )
      return result.recordset.map((r) => ({ name: r.name, schema: r.schema }))
    },

    async listTriggers(session: DbSession, db: string, schema?: string): Promise<TriggerInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      const schemaFilter = schema ? `AND s.name = ${quoteLiteral('tsql', schema)}` : ''
      const result = await pool.request().query<{ schema: string; name: string; table: string }>(
        `SELECT s.name AS [schema], tr.name AS name, OBJECT_NAME(tr.parent_id) AS [table]
         FROM ${dbQ}.sys.triggers tr
         JOIN ${dbQ}.sys.objects o ON tr.parent_id = o.object_id
         JOIN ${dbQ}.sys.schemas s ON o.schema_id = s.schema_id
         WHERE tr.parent_class = 1 ${schemaFilter}
         ORDER BY s.name, tr.name`
      )
      return result.recordset.map((r) => ({ name: r.name, schema: r.schema, table: r.table }))
    },

    async listSequences(session: DbSession, db: string, schema?: string): Promise<SeqInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      const schemaFilter = schema ? `WHERE s.name = ${quoteLiteral('tsql', schema)}` : ''
      const result = await pool.request().query<{ schema: string; name: string }>(
        `SELECT s.name AS [schema], seq.name AS name
         FROM ${dbQ}.sys.sequences seq
         JOIN ${dbQ}.sys.schemas s ON seq.schema_id = s.schema_id
         ${schemaFilter}
         ORDER BY s.name, seq.name`
      )
      return result.recordset.map((r) => ({ name: r.name, schema: r.schema }))
    },

    async listSynonyms(session: DbSession, db: string, schema?: string): Promise<SynonymInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      const schemaFilter = schema ? `WHERE s.name = ${quoteLiteral('tsql', schema)}` : ''
      const result = await pool.request().query<{ schema: string; name: string; base_object: string }>(
        `SELECT s.name AS [schema], sy.name AS name, sy.base_object_name AS base_object
         FROM ${dbQ}.sys.synonyms sy
         JOIN ${dbQ}.sys.schemas s ON sy.schema_id = s.schema_id
         ${schemaFilter}
         ORDER BY s.name, sy.name`
      )
      return result.recordset.map((r) => ({ name: r.name, schema: r.schema, baseObject: r.base_object }))
    },

    async listUsers(session: DbSession, db: string): Promise<DbUserInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      // SQL Server-principals: S = SQL-gebruiker, U = Windows-gebruiker,
      // G = Windows-groep, K = externe gebruiker. Systeem-objecten 'sys' en
      // 'INFORMATION_SCHEMA' worden niet als gebruikers getoond (SSMS doet dit ook).
      const result = await pool.request().query<{ name: string; type: string; default_schema: string | null }>(
        `SELECT name, type, default_schema_name AS default_schema
         FROM ${dbQ}.sys.database_principals
         WHERE type IN ('S','U','G','K')
           AND name NOT IN ('sys','INFORMATION_SCHEMA')
         ORDER BY name`
      )
      return result.recordset.map((r) => ({
        name: r.name,
        type: r.type,
        defaultSchema: r.default_schema ?? undefined
      }))
    },

    async listRoles(session: DbSession, db: string): Promise<DbRoleInfo[]> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      const result = await pool.request().query<{ name: string; type: string }>(
        `SELECT name, type
         FROM ${dbQ}.sys.database_principals
         WHERE type = 'R'
         ORDER BY name`
      )
      return result.recordset.map((r) => ({ name: r.name, type: r.type }))
    },

    async getTableMetadata(
      session: DbSession,
      db: string,
      schema: string,
      table: string
    ): Promise<TableMetadata> {
      const { pool } = session.handle as SqlServerSessionHandle
      const dbQ = quoteIdentifier('tsql', db)
      // SAL-32: OBJECT_ID('dbo'.'tbl') is géén geldig T-SQL — één literal:
      // OBJECT_ID('dbo.tbl') (gevonden via live-validatie op docker-mssql).
      const objectLit = quoteLiteral('tsql', `${schema}.${table}`)

      // Kolommen + PK-vlag
      const colResult = await pool.request().query<{
        name: string
        data_type: string
        max_length: number
        precision: number
        scale: number
        is_nullable: boolean
        is_identity: boolean
        is_computed: boolean
        default_definition: string | null
        is_pk: boolean
        ordinal: number
      }>(
        `SELECT c.name AS name,
                ty.name AS data_type,
                c.max_length,
                c.precision,
                c.scale,
                c.is_nullable,
                c.is_identity,
                c.is_computed,
                dc.definition AS default_definition,
                CASE WHEN pk.index_id IS NOT NULL THEN 1 ELSE 0 END AS is_pk,
                c.column_id AS ordinal
         FROM ${dbQ}.sys.columns c
         JOIN ${dbQ}.sys.types ty ON c.user_type_id = ty.user_type_id
         LEFT JOIN ${dbQ}.sys.default_constraints dc
                ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
         LEFT JOIN (
           SELECT ic.object_id, ic.column_id, i.index_id
           FROM ${dbQ}.sys.indexes i
           JOIN ${dbQ}.sys.index_columns ic
             ON i.object_id = ic.object_id AND i.index_id = ic.index_id
           WHERE i.is_primary_key = 1
         ) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id
         WHERE c.object_id = OBJECT_ID(${objectLit})
         ORDER BY c.column_id`
      )

      const columns: ColumnInfo[] = colResult.recordset.map((r) => ({
        name: r.name,
        dataType: r.data_type,
        length: r.data_type === 'nvarchar' || r.data_type === 'nchar' ? r.max_length / 2 : r.max_length,
        precision: r.precision,
        scale: r.scale,
        nullable: r.is_nullable,
        defaultValue: r.default_definition ?? null,
        isIdentity: r.is_identity,
        isComputed: r.is_computed,
        isPrimaryKey: Boolean(r.is_pk),
        ordinalPosition: r.ordinal
      }))

      const primaryKey = columns.filter((c) => c.isPrimaryKey).map((c) => c.name)

      // Foreign keys (met kolomvolgorde)
      const fkResult = await pool.request().query<{
        name: string
        col: string
        ref_table: string
        ref_schema: string
        ref_col: string
        on_delete: string
        on_update: string
        ord: number
      }>(
        `SELECT fk.name AS name,
                pc.name AS col,
                rt.name AS ref_table,
                rs.name AS ref_schema,
                rc.name AS ref_col,
                fk.delete_referential_action_desc AS on_delete,
                fk.update_referential_action_desc AS on_update,
                fkc.constraint_column_id AS ord
         FROM ${dbQ}.sys.foreign_keys fk
         JOIN ${dbQ}.sys.foreign_key_columns fkc
           ON fk.object_id = fkc.constraint_object_id
         JOIN ${dbQ}.sys.columns pc
           ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
         JOIN ${dbQ}.sys.columns rc
           ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
         JOIN ${dbQ}.sys.tables rt ON fk.referenced_object_id = rt.object_id
         JOIN ${dbQ}.sys.schemas rs ON rt.schema_id = rs.schema_id
         WHERE fk.parent_object_id = OBJECT_ID(${objectLit})
         ORDER BY fk.name, fkc.constraint_column_id`
      )
      const fkMap = new Map<string, ForeignKeyInfo>()
      for (const r of fkResult.recordset) {
        const existing = fkMap.get(r.name)
        if (existing) {
          existing.columns.push(r.col)
          existing.referencedColumns.push(r.ref_col)
        } else {
          fkMap.set(r.name, {
            name: r.name,
            columns: [r.col],
            referencedTable: r.ref_table,
            referencedSchema: r.ref_schema,
            referencedColumns: [r.ref_col],
            onDelete: r.on_delete,
            onUpdate: r.on_update
          })
        }
      }

      // Indexen (uniek + niet-PK)
      const idxResult = await pool.request().query<{
        name: string
        is_unique: boolean
        is_pk: boolean
        col: string
      }>(
        `SELECT i.name AS name,
                i.is_unique,
                i.is_primary_key AS is_pk,
                c.name AS col
         FROM ${dbQ}.sys.indexes i
         JOIN ${dbQ}.sys.index_columns ic
           ON i.object_id = ic.object_id AND i.index_id = ic.index_id
         JOIN ${dbQ}.sys.columns c
           ON ic.object_id = c.object_id AND ic.column_id = c.column_id
         WHERE i.object_id = OBJECT_ID(${objectLit})
           AND i.is_primary_key = 0
           AND i.type > 0
         ORDER BY i.name, ic.key_ordinal`
      )
      const idxMap = new Map<string, IndexInfo>()
      for (const r of idxResult.recordset) {
        const existing = idxMap.get(r.name)
        if (existing) existing.columns.push(r.col)
        else
          idxMap.set(r.name, {
            name: r.name,
            columns: [r.col],
            isUnique: Boolean(r.is_unique),
            isPrimaryKey: Boolean(r.is_pk)
          })
      }

      // Constraints (CHECK / DEFAULT / UNIQUE)
      const conResult = await pool.request().query<{ name: string; type: string; definition: string | null }>(
        `SELECT name, 'CHECK' AS type, definition
         FROM ${dbQ}.sys.check_constraints
         WHERE parent_object_id = OBJECT_ID(${objectLit})
         UNION ALL
         SELECT dc.name, 'DEFAULT', dc.definition
         FROM ${dbQ}.sys.default_constraints dc
         WHERE dc.parent_object_id = OBJECT_ID(${objectLit})
         UNION ALL
         SELECT i.name, 'UNIQUE', NULL
         FROM ${dbQ}.sys.indexes i
         WHERE i.object_id = OBJECT_ID(${objectLit})
           AND i.is_unique = 1 AND i.is_primary_key = 0`
      )
      const constraints: ConstraintInfo[] = conResult.recordset.map((r) => ({
        name: r.name,
        type: (r.type as ConstraintInfo['type']) ?? 'CHECK',
        definition: r.definition ?? undefined
      }))

      // Triggers
      const trigResult = await pool.request().query<{ name: string }>(
        `SELECT name FROM ${dbQ}.sys.triggers
         WHERE parent_id = OBJECT_ID(${objectLit}) AND parent_class = 1
         ORDER BY name`
      )

      // Dependencies (depends-on)
      const depResult = await pool.request().query<{ name: string; schema: string; type: string }>(
        `SELECT OBJECT_NAME(referenced_id) AS name,
                referenced_schema_name AS [schema],
                referenced_class_desc AS type
         FROM ${dbQ}.sys.sql_expression_dependencies
         WHERE referencing_id = OBJECT_ID(${objectLit})
         ORDER BY referenced_schema_name, OBJECT_NAME(referenced_id)`
      )
      const dependencies: DependencyInfo[] = depResult.recordset.map((r) => ({
        objectName: r.name,
        objectSchema: r.schema,
        objectType: r.type,
        direction: 'depends-on'
      }))

      // Rijtelling (benadering via partitions; exact COUNT is duur)
      let rowCount: number | undefined
      try {
        const rc = await pool.request().query<{ n: number }>(
          `SELECT SUM(rows) AS n
           FROM ${dbQ}.sys.partitions
           WHERE object_id = OBJECT_ID(${objectLit}) AND index_id IN (0,1)`
        )
        rowCount = rc.recordset[0]?.n ?? 0
      } catch {
        rowCount = undefined
      }

      return {
        columns,
        primaryKey,
        foreignKeys: [...fkMap.values()],
        indexes: [...idxMap.values()],
        constraints,
        triggers: trigResult.recordset.map((t) => t.name),
        dependencies,
        rowCount
      }
    },

    async getObjectDefinition(session: DbSession, obj: DbObjectRef): Promise<string> {
      const { pool } = session.handle as SqlServerSessionHandle
      const schema = obj.schema ?? 'dbo'
      const sql = `SELECT OBJECT_DEFINITION(OBJECT_ID(${quoteLiteral('tsql', `${schema}.${obj.name}`)})) AS def`
      const result = await pool.request().query<{ def: string | null }>(sql)
      const def = result.recordset[0]?.def
      if (!def) {
        // Tabellen hebben geen OBJECT_DEFINITION; genereer een CREATE TABLE
        // vanuit de metadata (F1-5: Script Object breidt dit verder uit).
        if (obj.type === 'table') {
          const meta = await this.getTableMetadata(session, obj.database, schema, obj.name)
          return buildCreateTable(schema, obj.name, meta)
        }
        throw new Error(`SQL Server: geen definitie gevonden voor ${schema}.${obj.name}`)
      }
      return def
    },

    async *executeQuery(
      session: DbSession,
      sqlText: string,
      opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      const { pool } = session.handle as SqlServerSessionHandle
      const maxRows = opts.maxRows ?? CAPABILITIES.maxResultRowsDefault
      const executionId = opts.executionId
      const signal = opts.signal

      const statements = splitStatements(sqlText, CAPABILITIES.dialect)
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
      // maxRows via dialect: TOP (n) — maar nooit dubbel (SAL-8-les)
      const isSelect = /^\s*SELECT\b/i.test(stmt)
      const capped = isSelect ? applyTopLimit(stmt, maxRows) : stmt

      // SELECT: streamen via request.stream; DML: direct uitvoeren en rowcount rapporteren.
      if (isSelect) {
        const request = pool.request()
        request.stream = true
        const entry: ActiveSqlServerRequest | null = executionId
          ? { request, pool, cancelled: false }
          : null
        if (executionId && entry) activeRequests.set(executionId, entry)

        const queue: QueryChunk[] = []
        let waiters: Array<() => void> = []
        const push = (c: QueryChunk): void => {
          queue.push(c)
          const w = waiters
          waiters = []
          for (const fn of w) fn()
        }
        const wait = (): Promise<void> =>
          new Promise((resolve) => {
            waiters.push(resolve)
          })

        let done = false
        let cancelled = false
        let streamError: { message: string; position?: { line: number; column: number } } | undefined

        // Rijen batchen in chunks van 1000 (zelfde aanpak als de sqlite-provider)
        const ROW_CHUNK = 1000
        let rowBuffer: QueryRow[] = []
        const flushRows = (): void => {
          if (rowBuffer.length > 0) {
            push({ kind: 'rows', rows: rowBuffer })
            rowBuffer = []
          }
        }
        const wake = (): void => {
          const w = waiters
          waiters = []
          for (const fn of w) fn()
        }

        // Echte cancel (SAL-33): mssql stuurt een attention-signaal naar de
        // server; de server beëindigt de query. De request wordt daarna via
        // het ECANCEL-error-event als geannuleerd afgesloten (geen rode fout).
        let requestStarted = false
        const cancelRequest = (): void => {
          if (entry) entry.cancelled = true
          cancelled = true
          if (requestStarted) {
            try {
              request.cancel()
            } catch {
              // request is al beëindigd
            }
          }
        }
        const onAbort = (): void => {
          cancelRequest()
          done = true
          flushRows()
          wake()
        }
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }

        request.on('recordset', (columns) => {
          push({ kind: 'columns', columns: (Object.values(columns) as { name: string }[]).map(columnName) })
        })
        request.on('row', (row) => {
          if (cancelled) return
          const values = (Object.values(row) as unknown[]).map(toCell)
          rowBuffer.push({ values })
          if (rowBuffer.length >= ROW_CHUNK) flushRows()
        })
        request.on('error', (err) => {
          const message = err instanceof Error ? err.message : String(err)
          if (cancelled || entry?.cancelled === true || isCancellationError(err)) {
            // Annulering is géén fout: eindig schoon als done(cancelled).
            cancelled = true
            done = true
            flushRows()
            wake()
            return
          }
          streamError = {
            message,
            position:
              wrapErrorPosition('tsql', message, stmt) ??
              undefined
          }
          // Ook bij een echte fout de loop wekken (voorkomt hangen).
          done = true
          wake()
        })
        request.on('done', () => {
          flushRows()
          done = true
          wake()
        })

        try {
          request.query(capped)
          requestStarted = true
          // Racede een annulering vóór de request-start? Dan nu alsnog cancelen.
          if (signal?.aborted) cancelRequest()

          let rowCount = 0
          while (!done || queue.length > 0) {
            if (queue.length > 0) {
              const chunk = queue.shift()!
              if (chunk.kind === 'rows') rowCount += chunk.rows.length
              yield chunk
            } else {
              await wait()
            }
          }
          if (cancelled) {
            yield {
              kind: 'done',
              rowCount,
              durationMs: Math.round(performance.now() - start),
              cancelled: true
            }
          } else if (streamError !== undefined) {
            yield { kind: 'error', message: streamError.message, position: streamError.position }
          } else {
            yield {
              kind: 'done',
              rowCount,
              durationMs: Math.round(performance.now() - start)
            }
          }
        } finally {
          if (signal) signal.removeEventListener('abort', onAbort)
          if (executionId) activeRequests.delete(executionId)
        }
      } else {
        const request = pool.request()
        const entry: ActiveSqlServerRequest | null = executionId
          ? { request, pool, cancelled: false }
          : null
        if (executionId && entry) activeRequests.set(executionId, entry)
        const onAbort = (): void => {
          if (entry) entry.cancelled = true
          try {
            request.cancel()
          } catch {
            // request is al beëindigd
          }
        }
        if (signal) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
        try {
          const result = await request.query(capped)
          const rowCount = (result.rowsAffected ?? []).reduce((a, b) => a + (b ?? 0), 0)
          yield {
            kind: 'done',
            rowCount,
            durationMs: Math.round(performance.now() - start)
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const cancelledByUser = entry?.cancelled === true || isCancellationError(err)
          if (cancelledByUser) {
            yield {
              kind: 'done',
              rowCount: 0,
              durationMs: Math.round(performance.now() - start),
              cancelled: true
            }
          } else {
            yield {
              kind: 'error',
              message,
              position: wrapErrorPosition('tsql', message, stmt) ?? undefined
            }
          }
        } finally {
          if (signal) signal.removeEventListener('abort', onAbort)
          if (executionId) activeRequests.delete(executionId)
        }
      }
    },

    async cancel(session: DbSession, executionId: string): Promise<void> {
      // Echte cancel (SAL-33): vind de actieve request via executionId en
      // stuur een attention-signaal naar SQL Server (request.cancel()).
      void session
      const entry = activeRequests.get(executionId)
      if (!entry) return
      entry.cancelled = true
      try {
        entry.request.cancel()
      } catch {
        // request is al beëindigd
      }
    },

    async getExecutionStats(
      _session: DbSession,
      _executionId: string
    ): Promise<QueryStats> {
      return { rowCount: 0, durationMs: 0 }
    },

    // ------------------------------------------------------------------ F4
    // Backup & Restore (DBA) — gated via `supportsBackupRestore` (true)
    backupRestore: {
      async backupDatabase(
        session: DbSession,
        database: string,
        targetPath: string,
        _options?: BackupOptions
      ): Promise<BackupResult> {
        const { pool } = session.handle as SqlServerSessionHandle
        const sqlText = buildBackupDatabase('tsql', database, targetPath)
        const start = performance.now()
        try {
          await pool.request().query(sqlText)
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
        const { pool } = session.handle as SqlServerSessionHandle
        const sqlText = buildRestoreDatabase('tsql', database, sourcePath)
        const start = performance.now()
        try {
          await pool.request().query(sqlText)
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

/** Genereer een CREATE TABLE-script uit metadata (voor objecten zonder OBJECT_DEFINITION). */
function buildCreateTable(schema: string, table: string, meta: TableMetadata): string {
  const lines: string[] = []
  for (const c of meta.columns) {
    let type = c.dataType
    if (c.length && ['varchar', 'nvarchar', 'char', 'nchar', 'varbinary', 'binary'].includes(c.dataType)) {
      type = `${c.dataType}(${c.length})`
    } else if (c.precision && c.scale !== undefined && ['decimal', 'numeric'].includes(c.dataType)) {
      type = `${c.dataType}(${c.precision},${c.scale})`
    }
    const nullable = c.nullable ? 'NULL' : 'NOT NULL'
    const identity = c.isIdentity ? ' IDENTITY(1,1)' : ''
    const def = c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ''
    lines.push(`  ${quoteIdentifier('tsql', c.name)} ${type}${identity} ${nullable}${def}`)
  }
  if (meta.primaryKey.length > 0) {
    lines.push(
      `  CONSTRAINT [PK_${table}] PRIMARY KEY (${meta.primaryKey
        .map((c) => quoteIdentifier('tsql', c))
        .join(', ')})`
    )
  }
  return `CREATE TABLE ${quoteIdentifier('tsql', schema)}.${quoteIdentifier('tsql', table)} (\n${lines.join(
    ',\n'
  )}\n);`
}
