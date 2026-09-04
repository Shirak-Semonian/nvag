/**
 * @nvag/providers/oracle — Oracle-provider via `oracledb` (thin mode).
 *
 * F2-9: Oracle Database 12c+ (thin mode vereist geen Oracle Client).
 * - dialect `oracle` (`"x"`-quoting, FETCH FIRST n ROWS ONLY)
 * - metadata via ALL_* catalogus-views (schema-gelimiteerd)
 * - executeQuery: SELECT (maxRows via FETCH FIRST), DML, multi-statement weigering
 *
 * Tests zijn env-gated op NVAG_TEST_ORACLE_URL (zie oracle-harness).
 */

import oracledb from 'oracledb'
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

export interface OracleSessionHandle {
  conn: oracledb.Connection
  /**
   * Actuele schema van de sessie (CURRENT_SCHEMA, doorgaans de username).
   * Oracle-schema's zijn gebruikers, géén servicenamen — `session.database`
   * (bv. FREEPDB1) is daarvoor onbruikbaar (SAL-36).
   */
  currentSchema: string
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
  supportsSynonyms: false, // Oracle: synonyms/security nog niet ontsloten (SAL-32)
  supportsTriggers: true,
  supportsExecutionPlans: false,
  supportsMonitoring: true,
  supportsTransactions: true,
  supportsIdentityColumns: true,
  supportsGeneratedColumns: false,
  supportsDdlAdmin: true,
  supportsUsersAndRoles: true,
  supportsBackupRestore: false,
  maxResultRowsDefault: 1000,
  dialect: 'oracle'
}

/** connectString: host:port/service (via config.extraParams of host). */
function buildConnectString(config: ConnectionConfig): string {
  const service = config.database ?? config.extraParams?.['service'] ?? config.host
  return `${config.host}:${config.port ?? 1521}/${service}`
}

/** Oracle-waarden → QueryCellValue (Date → ISO, Buffer → bytes). */
function toCell(v: unknown): QueryCellValue {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return new Uint8Array(v)
  if (typeof v === 'object' && 'toISOString' in (v as object)) return String(v)
  return v as QueryCellValue
}

/**
 * Resolveert het metadata-schema (owner): een expliciet doorgegeven schema
 * wint; anders het actuele schema van de sessie (CURRENT_SCHEMA). Oracle-
 * schema's zijn usernames — nooit de servicenaam (`session.database`).
 */
function resolveOwner(session: DbSession, schema?: string): string {
  if (schema && schema.trim() !== '') return schema.toUpperCase()
  const { currentSchema } = session.handle as OracleSessionHandle
  return (currentSchema ?? '').toUpperCase()
}

export function createOracleProvider(): DatabaseProvider {
  const sessions = new Map<string, DbSession>()

  return {
    id: 'oracle',
    displayName: 'Oracle',
    defaultPort: 1521,
    capabilities: CAPABILITIES,

    async connect(config: ConnectionConfig, secret?: ConnectionSecret): Promise<DbSession> {
      if (!config.host) throw new Error('Oracle: no host provided')
      const conn = await oracledb.getConnection({
        user: config.username,
        password: secret?.password,
        connectString: buildConnectString(config),
        connectTimeout: config.connectionTimeoutMs ?? 10000
      })
      // Oracle-schema = username; resolveer het actuele schema van de sessie
      // (CURRENT_SCHEMA) zodat metadata zonder expliciet schema werkt (SAL-36).
      const schemaRow = await conn.execute<{ schema: string }>(
        `SELECT sys_context('USERENV','CURRENT_SCHEMA') AS "schema" FROM dual`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      const session: DbSession = {
        handle: {
          conn,
          currentSchema: schemaRow.rows?.[0]?.schema ?? config.username ?? ''
        } satisfies OracleSessionHandle,
        connectionId: config.id,
        providerId: 'oracle',
        database: config.database ?? config.host
      }
      sessions.set(config.id, session)
      return session
    },

    async testConnection(config: ConnectionConfig, secret?: ConnectionSecret): Promise<TestResult> {
      let conn: oracledb.Connection | undefined
      try {
        conn = await oracledb.getConnection({
          user: config.username,
          password: secret?.password,
          connectString: buildConnectString(config),
          connectTimeout: config.connectionTimeoutMs ?? 10000
        })
        const r = await conn.execute<{ v: string }>(
          `SELECT banner AS "v" FROM v$version WHERE ROWNUM = 1`,
          {},
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        )
        const banner = r.rows?.[0]?.v ?? ''
        await conn.close()
        return { ok: true, serverInfo: { providerId: 'oracle', providerName: 'Oracle', serverVersion: banner.split(' ')[2] ?? banner } }
      } catch (err) {
        if (conn) {
          try {
            await conn.close()
          } catch {
            /* negeren */
          }
        }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },

    async getServerInfo(session: DbSession): Promise<ServerInfo> {
      const { conn } = session.handle as OracleSessionHandle
      const r = await conn.execute<{ v: string; db: string; u: string }>(
        `SELECT banner AS "v", sys_context('USERENV','DB_NAME') AS "db", USER AS "u" FROM v$version WHERE ROWNUM = 1`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      const row = r.rows?.[0]
      return {
        providerId: 'oracle',
        providerName: 'Oracle',
        serverVersion: (row?.v ?? '').split(' ')[2] ?? '?',
        productName: 'Oracle',
        currentDatabase: row?.db,
        currentUser: row?.u
      }
    },

    async close(session: DbSession): Promise<void> {
      const { conn } = session.handle as OracleSessionHandle
      try {
        await conn.close()
      } catch {
        /* al gesloten */
      }
      sessions.delete(session.connectionId)
    },

    async listDatabases(session: DbSession): Promise<DatabaseInfo[]> {
      const { conn } = session.handle as OracleSessionHandle
      const r = await conn.execute<{ name: string }>(
        `SELECT name AS "name" FROM v$database`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      return (r.rows ?? []).map((row) => ({ name: row.name }))
    },

    async listSchemas(session: DbSession): Promise<SchemaInfo[]> {
      const { conn } = session.handle as OracleSessionHandle
      const r = await conn.execute<{ name: string }>(
        `SELECT username AS "name" FROM all_users ORDER BY username`,
        {},
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      return (r.rows ?? []).map((row) => ({ name: row.name }))
    },

    async listTables(session: DbSession, _db: string, schema?: string): Promise<TableInfo[]> {
      const { conn } = session.handle as OracleSessionHandle
      const owner = resolveOwner(session, schema)
      const r = await conn.execute<{ name: string }>(
        `SELECT table_name AS "name" FROM all_tables WHERE owner = :owner ORDER BY table_name`,
        { owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      return (r.rows ?? []).map((row) => ({ name: row.name, schema: owner, type: 'table' }))
    },

    async listViews(session: DbSession, _db: string, schema?: string): Promise<ViewInfo[]> {
      const { conn } = session.handle as OracleSessionHandle
      const owner = resolveOwner(session, schema)
      const r = await conn.execute<{ name: string }>(
        `SELECT view_name AS "name" FROM all_views WHERE owner = :owner ORDER BY view_name`,
        { owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      return (r.rows ?? []).map((row) => ({ name: row.name, schema: owner }))
    },

    async listProcedures(session: DbSession, _db: string, schema?: string): Promise<ProcInfo[]> {
      const { conn } = session.handle as OracleSessionHandle
      const owner = resolveOwner(session, schema)
      const r = await conn.execute<{ name: string }>(
        `SELECT object_name AS "name" FROM all_objects WHERE owner = :owner AND object_type = 'PROCEDURE' ORDER BY object_name`,
        { owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      return (r.rows ?? []).map((row) => ({ name: row.name, schema: owner, type: 'procedure' }))
    },

    async listFunctions(session: DbSession, _db: string, schema?: string): Promise<FuncInfo[]> {
      const { conn } = session.handle as OracleSessionHandle
      const owner = resolveOwner(session, schema)
      const r = await conn.execute<{ name: string }>(
        `SELECT object_name AS "name" FROM all_objects WHERE owner = :owner AND object_type = 'FUNCTION' ORDER BY object_name`,
        { owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      return (r.rows ?? []).map((row) => ({ name: row.name, schema: owner }))
    },

    async listTriggers(session: DbSession, _db: string, schema?: string): Promise<TriggerInfo[]> {
      const { conn } = session.handle as OracleSessionHandle
      const owner = resolveOwner(session, schema)
      const r = await conn.execute<{ name: string; table: string }>(
        `SELECT trigger_name AS "name", table_name AS "table" FROM all_triggers WHERE owner = :owner ORDER BY trigger_name`,
        { owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      return (r.rows ?? []).map((row) => ({ name: row.name, schema: owner, table: row.table }))
    },

    async listSequences(session: DbSession, _db: string, schema?: string): Promise<SeqInfo[]> {
      const { conn } = session.handle as OracleSessionHandle
      const owner = resolveOwner(session, schema)
      const r = await conn.execute<{ name: string }>(
        `SELECT sequence_name AS "name" FROM all_sequences WHERE sequence_owner = :owner ORDER BY sequence_name`,
        { owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      return (r.rows ?? []).map((row) => ({ name: row.name, schema: owner }))
    },

    async listSynonyms(): Promise<SynonymInfo[]> {
      return [] // Oracle: synonyms/security nog niet ontsloten (SAL-32)
    },

    async listUsers(): Promise<DbUserInfo[]> {
      return [] // Oracle: security nog niet ontsloten (SAL-32)
    },

    async listRoles(): Promise<DbRoleInfo[]> {
      return [] // Oracle: security nog niet ontsloten (SAL-32)
    },

    async getTableMetadata(
      session: DbSession,
      _db: string,
      schema: string,
      table: string
    ): Promise<TableMetadata> {
      const { conn } = session.handle as OracleSessionHandle
      const owner = schema.toUpperCase()
      const tbl = table.toUpperCase()

      const colRows = await conn.execute<{
        name: string
        type: string
        length: number
        precision: number
        scale: number
        nullable: string
        default_value: string | null
        identity: string
        position: number
      }>(
        `SELECT column_name AS "name", data_type AS "type", data_length AS "length",
                data_precision AS "precision", data_scale AS "scale",
                nullable AS "nullable", data_default AS "default_value",
                identity_column AS "identity", column_id AS "position"
         FROM all_tab_columns WHERE owner = :owner AND table_name = :tbl ORDER BY column_id`,
        { owner, tbl },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )

      const pkRows = await conn.execute<{ name: string; position: number }>(
        `SELECT cc.column_name AS "name", cc.position AS "position"
         FROM all_constraints c
         JOIN all_cons_columns cc ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name
         WHERE c.owner = :owner AND c.table_name = :tbl AND c.constraint_type = 'P'
         ORDER BY cc.position`,
        { owner, tbl },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      const pkNames = (pkRows.rows ?? []).map((r) => r.name)
      const pkSet = new Set(pkNames)

      const fkRows = await conn.execute<{
        name: string
        column: string
        ref_owner: string
        ref_table: string
        ref_column: string
      }>(
        `SELECT c.constraint_name AS "name", cc.column_name AS "column",
                r.owner AS "ref_owner", r.table_name AS "ref_table", rc.column_name AS "ref_column"
         FROM all_constraints c
         JOIN all_cons_columns cc ON c.owner = cc.owner AND c.constraint_name = cc.constraint_name
         JOIN all_constraints r ON c.r_owner = r.owner AND c.r_constraint_name = r.constraint_name
         JOIN all_cons_columns rc ON r.owner = rc.owner AND r.constraint_name = rc.constraint_name AND rc.position = cc.position
         WHERE c.owner = :owner AND c.table_name = :tbl AND c.constraint_type = 'R'`,
        { owner, tbl },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      const fkMap = new Map<string, ForeignKeyInfo>()
      for (const fk of fkRows.rows ?? []) {
        const existing = fkMap.get(fk.name)
        if (existing) {
          existing.columns.push(fk.column)
          existing.referencedColumns.push(fk.ref_column)
        } else {
          fkMap.set(fk.name, {
            name: fk.name,
            columns: [fk.column],
            referencedTable: fk.ref_table,
            referencedSchema: fk.ref_owner,
            referencedColumns: [fk.ref_column]
          })
        }
      }

      const idxRows = await conn.execute<{ name: string; column: string; unique: string }>(
        `SELECT i.index_name AS "name", ic.column_name AS "column", i.uniqueness AS "unique"
         FROM all_indexes i
         JOIN all_ind_columns ic ON i.owner = ic.index_owner AND i.index_name = ic.index_name
         WHERE i.table_owner = :owner AND i.table_name = :tbl
         ORDER BY i.index_name, ic.column_position`,
        { owner, tbl },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      const idxMap = new Map<string, IndexInfo>()
      for (const idx of idxRows.rows ?? []) {
        const existing = idxMap.get(idx.name)
        if (existing) existing.columns.push(idx.column)
        else idxMap.set(idx.name, { name: idx.name, columns: [idx.column], isUnique: idx.unique === 'UNIQUE' })
      }

      const trigRows = await conn.execute<{ name: string }>(
        `SELECT trigger_name AS "name" FROM all_triggers WHERE owner = :owner AND table_name = :tbl ORDER BY trigger_name`,
        { owner, tbl },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )

      const constraints: ConstraintInfo[] = []
      for (const c of colRows.rows ?? []) {
        if (c.default_value) constraints.push({ name: `default_${c.name}`, type: 'DEFAULT', definition: c.default_value })
      }
      if (pkNames.length > 0) constraints.push({ name: 'pk', type: 'PRIMARY KEY', definition: pkNames.join(', ') })
      for (const idx of idxMap.values()) {
        if (idx.isUnique) constraints.push({ name: idx.name, type: 'UNIQUE', definition: idx.columns.join(', ') })
      }

      const columns: ColumnInfo[] = (colRows.rows ?? []).map((c, i) => ({
        name: c.name,
        dataType: c.type,
        length: c.length ?? undefined,
        precision: c.precision ?? undefined,
        scale: c.scale ?? undefined,
        nullable: c.nullable === 'Y' && !pkSet.has(c.name),
        defaultValue: c.default_value,
        isIdentity: c.identity === 'YES',
        isComputed: false,
        isPrimaryKey: pkSet.has(c.name),
        ordinalPosition: c.position ?? i + 1
      }))

      let rowCount: number | undefined
      try {
        const r = await conn.execute<{ n: number }>(
          `SELECT num_rows AS "n" FROM all_tables WHERE owner = :owner AND table_name = :tbl`,
          { owner, tbl },
          { outFormat: oracledb.OUT_FORMAT_OBJECT }
        )
        rowCount = r.rows?.[0]?.n ?? undefined
      } catch {
        rowCount = undefined
      }

      return {
        columns,
        primaryKey: pkNames,
        foreignKeys: [...fkMap.values()],
        indexes: [...idxMap.values()],
        constraints,
        triggers: (trigRows.rows ?? []).map((t) => t.name),
        dependencies: [] as DependencyInfo[],
        rowCount
      }
    },

    async getObjectDefinition(session: DbSession, obj: DbObjectRef): Promise<string> {
      const { conn } = session.handle as OracleSessionHandle
      const owner = resolveOwner(session, obj.schema)
      const type = obj.type === 'view' ? 'VIEW' : obj.type === 'procedure' ? 'PROCEDURE' : obj.type === 'function' ? 'FUNCTION' : 'TABLE'
      const r = await conn.execute<{ text: string | null }>(
        `SELECT dbms_metadata.get_ddl(:type, :name, :owner) AS "text" FROM dual`,
        { type, name: obj.name.toUpperCase(), owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      )
      // dbms_metadata.get_ddl retourneert een CLOB → oracledb geeft een Lob
      // (stream) terug; lees die expliciet uit als string (SAL-36).
      const raw = r.rows?.[0]?.text
      const text = raw == null ? null : typeof raw === 'string' ? raw : await (raw as unknown as oracledb.Lob).getData()
      if (!text) throw new Error(`Oracle: no definition found for ${owner}.${obj.name}`)
      return `${text};`
    },

    async *executeQuery(
      session: DbSession,
      sql: string,
      opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      const { conn } = session.handle as OracleSessionHandle
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

      const stmt = statements[0]!
      const isSelect = /^\s*(SELECT|WITH)\b/i.test(stmt)
      const capped =
        isSelect && !containsKeyword(stmt, 'FETCH') && !containsKeyword(stmt, 'ROWNUM')
          ? `${stmt} ${buildLimit('oracle', maxRows)}`.trim()
          : stmt

      const start = performance.now()
      // SAL-33: race het abort-signaal zodat de generator nooit blijft hangen;
      // echte server-side cancel (oracledb.break) vereist een eigen break-
      // handler — cancel() meldt duidelijk dat dit (nog) niet ondersteund is.
      const q = conn.execute(capped, {}, {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
        maxRows: isSelect ? maxRows : 0
      })
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
        const result = value!
        if (isSelect) {
          const meta = result.metaData ?? []
          const columns = meta.map((m) => ({ name: m.name, dataType: m.dbTypeName ?? undefined }))
          yield { kind: 'columns', columns }
          const rows: QueryRow[] = []
          for (const row of (result.rows ?? []) as Record<string, unknown>[]) {
            rows.push({ values: columns.map((c) => toCell(row[c.name])) })
            if (rows.length >= 1000) {
              yield { kind: 'rows', rows }
              rows.length = 0
            }
          }
          if (rows.length > 0) yield { kind: 'rows', rows }
          yield {
            kind: 'done',
            rowCount: result.rows?.length ?? 0,
            durationMs: Math.round(performance.now() - start)
          }
        } else {
          yield {
            kind: 'done',
            rowCount: result.rowsAffected ?? 0,
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
          yield {
            kind: 'error',
            message: err instanceof Error ? err.message : String(err)
          }
        }
      }
    },

    async cancel(): Promise<void> {
      // oracledb.break vereist een eigen break-handler (F2-4); tot die tijd is
      // dit géén stille no-op: de gebruiker krijgt een duidelijke melding.
      throw new Error(
        'Oracle: canceling an active query is not supported (yet). The query is stopped locally; server-side execution may continue.'
      )
    },

    async getExecutionStats(): Promise<QueryStats> {
      return { rowCount: 0, durationMs: 0 }
    }
  }
}
