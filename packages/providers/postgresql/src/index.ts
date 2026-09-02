/**
 * @nvag/providers/postgresql — PostgreSQL-provider via `pg`.
 *
 * F1: connect/test/metadata/execute conform het DatabaseProvider-contract;
 * dezelfde contracttests als SQLite via @nvag/contract-tests.
 */

import { Client } from 'pg'
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

export interface PostgresSessionHandle {
  client: Client
  /** SAL-33: clientconfig (in-memory) voor de aparte cancel-verbinding. */
  cancelConfig: ReturnType<typeof buildClientConfig>
}

/** Actieve pg-query per executionId (SAL-33): cancel via pg_cancel_backend. */
interface ActivePgQuery {
  processId: number
  cancelConfig: ReturnType<typeof buildClientConfig>
}
const activePgQueries = new Map<string, ActivePgQuery>()

/** PostgreSQL-cancel-fout (SQLSTATE 57014 / 'canceling statement...'). */
function isPgCancelError(err: unknown): boolean {
  const code = (err as { code?: string })?.code
  if (code === '57014') return true
  const message = err instanceof Error ? err.message : String(err)
  return /canceling statement due to user request/i.test(message)
}

const CAPABILITIES: ProviderCapabilities = {
  supportsSchemas: true,
  supportsSequences: true,
  supportsSynonyms: false, // PostgreSQL: geen synonyms (SAL-32)
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
  dialect: 'postgres'
}

function buildClientConfig(config: ConnectionConfig, secret?: ConnectionSecret) {
  return {
    host: config.host,
    port: config.port ?? 5432,
    database: config.database || config.host,
    user: config.username,
    password: secret?.password,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 10000,
    ssl: config.ssl.mode !== 'disable' ? { rejectUnauthorized: config.ssl.mode === 'verify-full' } : undefined
  }
}

/** PG-foutpositie: pg geeft `position` (1-based karakter-offset) op het foutobject. */
function positionFromPgError(err: unknown, sql: string): { line: number; column: number } | undefined {
  const raw = (err as { position?: unknown })?.position
  const offsetNum = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) - 1 : NaN
  if (!Number.isFinite(offsetNum) || offsetNum < 0) return undefined
  const safe = Math.min(offsetNum, sql.length)
  let line = 1
  let lineStart = 0
  for (let i = 0; i < safe; i++) {
    if (sql.charCodeAt(i) === 10) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: safe - lineStart + 1 }
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

export function createPostgresProvider(): DatabaseProvider {
  return {
    id: 'postgresql',
    displayName: 'PostgreSQL',
    defaultPort: 5432,
    capabilities: CAPABILITIES,

    async connect(config: ConnectionConfig, secret?: ConnectionSecret): Promise<DbSession> {
      const cancelConfig = buildClientConfig(config, secret)
      const client = new Client(cancelConfig)
      await client.connect()
      const session: DbSession = {
        handle: { client, cancelConfig } satisfies PostgresSessionHandle,
        connectionId: config.id,
        providerId: 'postgresql',
        database: config.database ?? config.host
      }
      return session
    },

    async testConnection(config: ConnectionConfig, secret?: ConnectionSecret): Promise<TestResult> {
      let client: Client | undefined
      try {
        client = new Client(buildClientConfig(config, secret))
        await client.connect()
        const r = await client.query<{ v: string }>('SELECT version() AS v')
        await client.end()
        return {
          ok: true,
          serverInfo: {
            providerId: 'postgresql',
            providerName: 'PostgreSQL',
            serverVersion: (r.rows[0]?.v ?? '').split(' ')[1] ?? '?'
          }
        }
      } catch (err) {
        if (client) {
          try {
            await client.end()
          } catch {
            /* negeren */
          }
        }
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },

    async getServerInfo(session: DbSession): Promise<ServerInfo> {
      const { client } = session.handle as PostgresSessionHandle
      const r = await client.query<{ v: string; db: string; user: string }>(
        'SELECT version() AS v, current_database() AS db, current_user AS "user"'
      )
      return {
        providerId: 'postgresql',
        providerName: 'PostgreSQL',
        serverVersion: (r.rows[0]?.v ?? '').split(' ')[1] ?? '?',
        productName: 'PostgreSQL',
        currentDatabase: r.rows[0]?.db,
        currentUser: r.rows[0]?.user
      }
    },

    async close(session: DbSession): Promise<void> {
      const { client } = session.handle as PostgresSessionHandle
      try {
        await client.end()
      } catch {
        /* al gesloten */
      }
    },

    async listDatabases(session: DbSession): Promise<DatabaseInfo[]> {
      const { client } = session.handle as PostgresSessionHandle
      const r = await client.query<{ name: string }>(
        "SELECT datname AS name FROM pg_database WHERE datistemplate = false ORDER BY datname"
      )
      return r.rows.map((row) => ({ name: row.name }))
    },

    async listSchemas(session: DbSession): Promise<SchemaInfo[]> {
      const { client } = session.handle as PostgresSessionHandle
      const r = await client.query<{ name: string }>(
        `SELECT schema_name AS name FROM information_schema.schemata
         WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
         ORDER BY schema_name`
      )
      return r.rows.map((row) => ({ name: row.name }))
    },

    async listTables(session: DbSession, _db: string, schema = 'public'): Promise<TableInfo[]> {
      const { client } = session.handle as PostgresSessionHandle
      const r = await client.query<{ name: string; schema: string }>(
        `SELECT table_name AS name, table_schema AS schema FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [schema]
      )
      return r.rows.map((row) => ({ name: row.name, schema: row.schema, type: 'table' }))
    },

    async listViews(session: DbSession, _db: string, schema = 'public'): Promise<ViewInfo[]> {
      const { client } = session.handle as PostgresSessionHandle
      const r = await client.query<{ name: string; schema: string }>(
        `SELECT table_name AS name, table_schema AS schema FROM information_schema.views
         WHERE table_schema = $1 ORDER BY table_name`,
        [schema]
      )
      return r.rows.map((row) => ({ name: row.name, schema: row.schema }))
    },

    async listProcedures(session: DbSession, _db: string, schema = 'public'): Promise<ProcInfo[]> {
      const { client } = session.handle as PostgresSessionHandle
      const r = await client.query<{ name: string; schema: string; type: string }>(
        `SELECT routine_name AS name, routine_schema AS schema, routine_type AS type
         FROM information_schema.routines
         WHERE routine_schema = $1 ORDER BY routine_name`,
        [schema]
      )
      return r.rows.map((row) => ({
        name: row.name,
        schema: row.schema,
        type: row.type === 'PROCEDURE' ? 'procedure' : 'function'
      }))
    },

    async listFunctions(session: DbSession, _db: string, schema = 'public'): Promise<FuncInfo[]> {
      const { client } = session.handle as PostgresSessionHandle
      const r = await client.query<{ name: string; schema: string }>(
        `SELECT routine_name AS name, routine_schema AS schema
         FROM information_schema.routines
         WHERE routine_schema = $1 AND routine_type = 'FUNCTION'
         ORDER BY routine_name`,
        [schema]
      )
      return r.rows.map((row) => ({ name: row.name, schema: row.schema }))
    },

    async listTriggers(session: DbSession, _db: string, schema = 'public'): Promise<TriggerInfo[]> {
      const { client } = session.handle as PostgresSessionHandle
      const r = await client.query<{ name: string; table: string; schema: string }>(
        `SELECT t.tgname AS name, c.relname AS table, n.nspname AS schema
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND n.nspname = $1
         ORDER BY t.tgname`,
        [schema]
      )
      return r.rows.map((row) => ({ name: row.name, schema: row.schema, table: row.table }))
    },

    async listSequences(session: DbSession, _db: string, schema = 'public'): Promise<SeqInfo[]> {
      const { client } = session.handle as PostgresSessionHandle
      const r = await client.query<{ name: string; schema: string }>(
        `SELECT sequence_name AS name, sequence_schema AS schema
         FROM information_schema.sequences WHERE sequence_schema = $1 ORDER BY sequence_name`,
        [schema]
      )
      return r.rows.map((row) => ({ name: row.name, schema: row.schema }))
    },

    async listSynonyms(): Promise<SynonymInfo[]> {
      return [] // PostgreSQL: geen synonyms (SAL-32)
    },

    async listUsers(): Promise<DbUserInfo[]> {
      return [] // PostgreSQL: nog niet ontsloten (SAL-32)
    },

    async listRoles(): Promise<DbRoleInfo[]> {
      return [] // PostgreSQL: nog niet ontsloten (SAL-32)
    },

    async getTableMetadata(
      session: DbSession,
      _db: string,
      schema = 'public',
      table: string
    ): Promise<TableMetadata> {
      const { client } = session.handle as PostgresSessionHandle

      // Kolommen
      const colRows = await client.query<{
        name: string
        data_type: string
        is_nullable: string
        column_default: string | null
        is_identity: string
        ordinal: number
      }>(
        `SELECT column_name AS name, data_type, is_nullable, column_default, is_identity, ordinal_position AS ordinal
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table]
      )

      // PK
      const pkRows = await client.query<{ name: string; position: number }>(
        `SELECT kcu.column_name AS name, kcu.ordinal_position AS position
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
         ORDER BY kcu.ordinal_position`,
        [schema, table]
      )
      const pkNames = pkRows.rows.map((r) => r.name)
      const pkSet = new Set(pkNames)

      // FKs
      const fkRows = await client.query<{
        name: string
        column: string
        ref_schema: string
        ref_table: string
        ref_column: string
      }>(
        `SELECT tc.constraint_name AS name, kcu.column_name AS column,
                ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
        [schema, table]
      )
      const fkMap = new Map<string, ForeignKeyInfo>()
      for (const fk of fkRows.rows) {
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
      const idxRows = await client.query<{ name: string; column: string; unique: boolean }>(
        `SELECT i.relname AS name, a.attname AS column, ix.indisunique AS unique
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         WHERE n.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary
         ORDER BY i.relname, k.ord`,
        [schema, table]
      )
      const idxMap = new Map<string, IndexInfo>()
      for (const idx of idxRows.rows) {
        const existing = idxMap.get(idx.name)
        if (existing) {
          existing.columns.push(idx.column)
        } else {
          idxMap.set(idx.name, { name: idx.name, columns: [idx.column], isUnique: idx.unique })
        }
      }

      // Triggers
      const trigRows = await client.query<{ name: string }>(
        `SELECT t.tgname AS name FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND n.nspname = $1 AND c.relname = $2
         ORDER BY t.tgname`,
        [schema, table]
      )

      // Constraints (DEFAULT + PK + UNIQUE)
      const constraints: ConstraintInfo[] = []
      for (const c of colRows.rows) {
        if (c.column_default) {
          constraints.push({ name: `default_${c.name}`, type: 'DEFAULT', definition: c.column_default })
        }
      }
      if (pkNames.length > 0) {
        constraints.push({ name: `${table}_pkey`, type: 'PRIMARY KEY', definition: pkNames.join(', ') })
      }
      for (const idx of idxMap.values()) {
        if (idx.isUnique) constraints.push({ name: idx.name, type: 'UNIQUE', definition: idx.columns.join(', ') })
      }

      const columns: ColumnInfo[] = colRows.rows.map((c, i) => ({
        name: c.name,
        dataType: c.data_type,
        nullable: c.is_nullable === 'YES' && !pkSet.has(c.name),
        defaultValue: c.column_default,
        isIdentity: c.is_identity === 'YES' || c.column_default?.startsWith('nextval(') === true,
        isComputed: false,
        isPrimaryKey: pkSet.has(c.name),
        ordinalPosition: c.ordinal ?? i + 1
      }))

      let rowCount: number | undefined
      try {
        const r = await client.query<{ n: string }>(
          `SELECT reltuples::bigint AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relname = $2`,
          [schema, table]
        )
        rowCount = Number(r.rows[0]?.n ?? 0)
      } catch {
        rowCount = undefined
      }

      return {
        columns,
        primaryKey: pkNames,
        foreignKeys: [...fkMap.values()],
        indexes: [...idxMap.values()],
        constraints,
        triggers: trigRows.rows.map((t) => t.name),
        dependencies: [] as DependencyInfo[],
        rowCount
      }
    },

    async getObjectDefinition(session: DbSession, obj: DbObjectRef): Promise<string> {
      const { client } = session.handle as PostgresSessionHandle
      const schema = obj.schema ?? 'public'
      if (obj.type === 'view') {
        const r = await client.query<{ def: string }>(
          'SELECT pg_get_viewdef($1::regclass, true) AS def',
          [`${schema}.${obj.name}`]
        )
        if (!r.rows[0]?.def) throw new Error(`PostgreSQL: view niet gevonden: ${schema}.${obj.name}`)
        return `CREATE VIEW ${quoteIdentifier('postgres', obj.name)} AS\n${r.rows[0].def};`
      }
      if (obj.type === 'function') {
        const r = await client.query<{ def: string }>(
          'SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2',
          [schema, obj.name]
        )
        if (!r.rows[0]?.def) throw new Error(`PostgreSQL: functie niet gevonden: ${schema}.${obj.name}`)
        return `${r.rows[0].def};`
      }
      // Tabel: genereer CREATE TABLE uit metadata (basis; F1-5 breidt uit)
      const meta = await this.getTableMetadata(session, obj.database, schema, obj.name)
      const lines = meta.columns.map((c) => {
        let def = `  ${quoteIdentifier('postgres', c.name)} ${c.dataType}`
        if (c.isPrimaryKey) def += ' PRIMARY KEY'
        if (!c.nullable && !c.isPrimaryKey) def += ' NOT NULL'
        if (c.defaultValue) def += ` DEFAULT ${c.defaultValue}`
        return def
      })
      return `CREATE TABLE ${quoteIdentifier('postgres', schema)}.${quoteIdentifier('postgres', obj.name)} (\n${lines.join(',\n')}\n);`
    },

    async *executeQuery(
      session: DbSession,
      sql: string,
      opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      const { client } = session.handle as PostgresSessionHandle
      const maxRows = opts.maxRows ?? CAPABILITIES.maxResultRowsDefault
      const executionId = opts.executionId
      const signal = opts.signal

      const statements = splitStatements(sql, CAPABILITIES.dialect)
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
      const isSelect = /^\s*(SELECT|WITH|TABLE|EXPLAIN)\b/i.test(stmt)
      const capped = isSelect && !containsKeyword(stmt, 'LIMIT') ? `${stmt} ${buildLimit('postgres', maxRows)}`.trim() : stmt

      const start = performance.now()
      // SAL-33: echte cancel — `provider.cancel()` roept pg_cancel_backend aan
      // (via een aparte verbinding); daarnaast raced het abort-signaal de
      // wacht op de query, zodat de generator nooit blijft hangen.
      const q = client.query(capped)
      const { cancelConfig } = session.handle as PostgresSessionHandle
      if (executionId) {
        const processId = (client as unknown as { processID: number }).processID
        activePgQueries.set(executionId, { processId, cancelConfig })
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
        const result = value!
        if (isSelect) {
          const columns = (result.fields ?? []).map((f) => ({ name: f.name, dataType: f.dataTypeID ? String(f.dataTypeID) : undefined }))
          yield { kind: 'columns', columns }
          const rows: QueryRow[] = []
          for (const row of result.rows as Record<string, unknown>[]) {
            rows.push({ values: columns.map((c) => toCell(row[c.name])) })
            if (rows.length >= 1000) {
              yield { kind: 'rows', rows }
              rows.length = 0
            }
          }
          if (rows.length > 0) yield { kind: 'rows', rows }
          yield {
            kind: 'done',
            rowCount: result.rowCount ?? rows.length,
            durationMs: Math.round(performance.now() - start)
          }
        } else {
          yield {
            kind: 'done',
            rowCount: result.rowCount ?? 0,
            durationMs: Math.round(performance.now() - start)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (signal?.aborted || isPgCancelError(err)) {
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
            message,
            position: positionFromPgError(err, stmt)
          }
        }
      } finally {
        if (executionId) activePgQueries.delete(executionId)
      }
    },

    async cancel(_session: DbSession, executionId: string): Promise<void> {
      // Echte cancel (SAL-33): pg_cancel_backend op de actieve backend-PID,
      // uitgevoerd via een aparte verbinding (de hoofdclient is bezet).
      const entry = activePgQueries.get(executionId)
      if (!entry) return
      let cancelClient: Client | undefined
      try {
        cancelClient = new Client(entry.cancelConfig)
        await cancelClient.connect()
        await cancelClient.query('SELECT pg_cancel_backend($1)', [entry.processId])
      } finally {
        if (cancelClient) {
          try {
            await cancelClient.end()
          } catch {
            // negeren
          }
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
