import type {
  AdminTableCreateRequest,
  ConnectionConfig,
  ConnectionSecret,
  DatabaseInfo,
  DbObjectRef,
  ExportRequest,
  ExportResult,
  GuardSeverity,
  NvagIpcApi,
  ProviderCapabilities,
  QueryChunk,
  QueryChunkEvent,
  QueryFileOpenResult,
  QueryFileSaveResult,
  QueryRunResponse,
  SchemaInfo,
  ScriptKind,
  ServerInfo,
  TableInfo,
  TableMetadata,
  TestResult,
  ViewInfo
} from '@nvag/contracts'
import { buildCreateTable, scriptObject as buildScriptObject } from '@nvag/sql-dialect'

export interface MockNvagOptions {
  connections?: ConnectionConfig[]
  tables?: string[]
  views?: string[]
  procedures?: string[]
  functions?: string[]
  synonyms?: string[]
  users?: string[]
  roles?: string[]
  tableMetadata?: Record<string, TableMetadata>
  /** Overschrijft admin.capabilities (SAL-32: folder-gating per provider). */
  capabilities?: ProviderCapabilities
  queryResults?: Record<string, QueryRunResponse>
  defaultQueryResult?: QueryRunResponse
  /** SQL → redenen waarom environment-safety de query blokkeert (F1-8: met severity). */
  blockedQueries?: Record<string, string[] | { reasons: string[]; severity?: GuardSeverity }>
  failOpenConnectionIds?: string[]
  /** Metadata-methoden die moeten falen: methodenaam → foutmelding (SAL-29). */
  metadataErrors?: Record<string, string>
  /** Databases die listDatabases retourneert (default: ['main']). */
  databases?: DatabaseInfo[]
  openFileResult?: QueryFileOpenResult
  saveFileResult?: QueryFileSaveResult
  /** Overschrijft de default `start`-streaming (voor cancel/progressie-tests). */
  startHandler?: (
    executionId: string,
    emit: (chunk: QueryChunk) => void
  ) => Promise<void> | void
  /** SQL waarvan `start` niet automatisch done emitteert maar naar
   *  `startHandler` gaat (SAL-33: hangende query voor cancel-tests). */
  hangingQuerySql?: string[]
  /** Wordt aangeroepen wanneer `query.cancel` wordt aangeroepen (SAL-33: mag
   *  via `emit` het done(cancelled)-chunk sturen, zoals de echte runner doet). */
  onCancel?: (executionId: string, emit: (chunk: QueryChunk) => void) => void
  /** SAL-34: admin-DROP-acties blokkeren (guard) tot `confirmed: true`. */
  adminDropBlocked?: boolean
}

const SERVER_INFO: ServerInfo = {
  providerId: 'sqlite',
  providerName: 'SQLite',
  serverVersion: '3.53.1',
  productName: 'SQLite',
  currentDatabase: 'test.db'
}

function defaultResult(): QueryRunResponse {
  return {
    executionId: 'exec-0',
    columns: [],
    rows: [],
    truncated: false,
    rowCount: 0,
    durationMs: 0
  }
}

/**
 * In-memory fake van window.nvag (preload-brug) voor renderer-tests.
 * Implementeert het F1-4 streaming-protocol: `run` geeft een executionId,
 * `start` emitteert columns/rows/done-chunks naar de onChunk-listeners.
 */
export function createMockNvag(options: MockNvagOptions = {}): NvagIpcApi & {
  savedConfigs: ConnectionConfig[]
  openedSessions: string[]
  closedSessions: string[]
  queriedSql: string[]
  savedFiles: { content: string; path?: string }[]
  /** Alle query:run-aanvragen (F1-8: om `confirmed` te kunnen asserten). */
  runRequests: { sql: string; confirmed?: boolean }[]
  /** Alle sessions:openSaved-aanvragen (F1-10). */
  openSavedCalls: string[]
  /** Alle sessions:useDatabase-aanvragen (F1-10). */
  useDatabaseCalls: { connectionId: string; database: string }[]
  /** SAL-34: alle admin-acties (naam + args + confirmed) voor asserties. */
  adminRequests: { action: string; args: unknown[]; confirmed?: boolean }[]
} {
  const savedConfigs: ConnectionConfig[] = [...(options.connections ?? [])]
  const openedSessions: string[] = []
  const closedSessions: string[] = []
  const queriedSql: string[] = []
  const savedFiles: { content: string; path?: string }[] = []
  const runRequests: { sql: string; confirmed?: boolean }[] = []
  const openSavedCalls: string[] = []
  const useDatabaseCalls: { connectionId: string; database: string }[] = []
  const adminRequests: { action: string; args: unknown[]; confirmed?: boolean }[] = []
  const chunkListeners = new Set<(evt: QueryChunkEvent) => void>()
  const pendingRuns = new Map<string, QueryRunResponse>()
  const pendingSql = new Map<string, string>()
  let sessionSeq = 0
  let execSeq = 0
  /** Database van een geopende sessie (useDatabase-mock; F1-10). */
  let sessionDatabase = SERVER_INFO.currentDatabase

  const emit = (evt: QueryChunkEvent): void => {
    for (const listener of chunkListeners) listener(evt)
  }

  const api: NvagIpcApi & {
    savedConfigs: ConnectionConfig[]
    openedSessions: string[]
    closedSessions: string[]
    queriedSql: string[]
    savedFiles: { content: string; path?: string }[]
    runRequests: { sql: string; confirmed?: boolean }[]
    openSavedCalls: string[]
    useDatabaseCalls: { connectionId: string; database: string }[]
    adminRequests: { action: string; args: unknown[]; confirmed?: boolean }[]
  } = {
    savedConfigs,
    openedSessions,
    closedSessions,
    queriedSql,
    savedFiles,
    runRequests,
    openSavedCalls,
    useDatabaseCalls,
    adminRequests,

    providers: {
      list: async () => [{ id: 'sqlite', displayName: 'SQLite', dialect: 'sqlite', defaultPort: 0 }]
    },

    connections: {
      list: async () => [...savedConfigs],
      save: async (config: ConnectionConfig, _secret?: ConnectionSecret) => {
        const existing = savedConfigs.findIndex((c) => c.id === config.id)
        if (existing >= 0) savedConfigs[existing] = config
        else savedConfigs.push(config)
        return config
      },
      remove: async (id: string) => {
        const index = savedConfigs.findIndex((c) => c.id === id)
        if (index >= 0) savedConfigs.splice(index, 1)
      },
      test: async (_config: ConnectionConfig, _secret?: ConnectionSecret): Promise<TestResult> => ({
        ok: true,
        serverInfo: SERVER_INFO
      })
    },

    sessions: {
      open: async (config: ConnectionConfig, _secret?: ConnectionSecret) => {
        if (options.failOpenConnectionIds?.includes(config.id) === true) {
          throw new Error(`SQLite: bestand niet gevonden: ${config.host}`)
        }
        openedSessions.push(config.id)
        sessionSeq += 1
        return {
          sessionId: `session-${sessionSeq}`,
          serverInfo: { ...SERVER_INFO, currentDatabase: config.database ?? sessionDatabase }
        }
      },
      close: async (sessionId: string) => {
        closedSessions.push(sessionId)
      },
      openSaved: async (connectionId: string) => {
        openSavedCalls.push(connectionId)
        const config = savedConfigs.find((c) => c.id === connectionId)
        if (!config) throw new Error('Verbinding niet gevonden. Bewaar de verbinding eerst in de Connection Manager.')
        if (options.failOpenConnectionIds?.includes(connectionId) === true) {
          throw new Error(`SQLite: bestand niet gevonden: ${config.host}`)
        }
        openedSessions.push(connectionId)
        sessionSeq += 1
        return {
          sessionId: `session-${sessionSeq}`,
          serverInfo: { ...SERVER_INFO, currentDatabase: config.database ?? sessionDatabase }
        }
      },
      useDatabase: async (connectionId: string, database: string) => {
        useDatabaseCalls.push({ connectionId, database })
        sessionDatabase = database
        return { sessionId: `session-${sessionSeq}`, serverInfo: { ...SERVER_INFO, currentDatabase: database } }
      }
    },

    query: {
      run: async (req) => {
        queriedSql.push(req.sql)
        runRequests.push({ sql: req.sql, confirmed: req.confirmed })
        // Net als de echte IPC-handler: een bevestigde run passeert de guard.
        const blocked = req.confirmed ? undefined : options.blockedQueries?.[req.sql]
        if (blocked && (Array.isArray(blocked) ? blocked.length > 0 : blocked.reasons.length > 0)) {
          const reasons = Array.isArray(blocked) ? blocked : blocked.reasons
          const severity = Array.isArray(blocked) ? undefined : blocked.severity
          return { executionId: '', blocked: reasons, ...(severity ? { guardSeverity: severity } : {}) }
        }
        execSeq += 1
        const executionId = `exec-${execSeq}`
        pendingSql.set(executionId, req.sql)
        pendingRuns.set(
          executionId,
          options.queryResults?.[req.sql] ?? options.defaultQueryResult ?? defaultResult()
        )
        return { executionId }
      },
      start: async (executionId: string) => {
        const response = pendingRuns.get(executionId)
        if (response) {
          pendingRuns.delete(executionId)
          // SAL-33: hangende query's gaan naar de startHandler (geen automatische done).
          const sql = pendingSql.get(executionId)
          pendingSql.delete(executionId)
          if (sql && options.hangingQuerySql?.includes(sql)) {
            if (options.startHandler) {
              await options.startHandler(executionId, (chunk) => emit({ executionId, chunk }))
            }
            return
          }
          if (response.error && response.columns.length === 0 && response.rows.length === 0) {
            emit({ executionId, chunk: { kind: 'error', message: response.error, position: response.errorPosition } })
            emit({ executionId, chunk: { kind: 'done', rowCount: 0, durationMs: response.durationMs } })
            return
          }
          if (response.columns.length > 0) {
            emit({ executionId, chunk: { kind: 'columns', columns: response.columns } })
          }
          if (response.rows.length > 0) {
            emit({ executionId, chunk: { kind: 'rows', rows: response.rows } })
          }
          emit({
            executionId,
            chunk: {
              kind: 'done',
              rowCount: response.rowCount,
              durationMs: response.durationMs,
              truncated: response.truncated
            }
          })
          return
        }
        if (options.startHandler) {
          await options.startHandler(executionId, (chunk) => emit({ executionId, chunk }))
        }
      },
      cancel: async (executionId: string) => {
        options.onCancel?.(executionId, (chunk) => emit({ executionId, chunk }))
      },
      onChunk: (cb: (evt: QueryChunkEvent) => void) => {
        chunkListeners.add(cb)
        return () => {
          chunkListeners.delete(cb)
        }
      },
      exportCsv: async () => ({ canceled: true }),
      exportResults: async (_req: ExportRequest): Promise<ExportResult> => ({ canceled: true })
    },

    metadata: {
      listDatabases: async (): Promise<DatabaseInfo[]> => {
        if (options.metadataErrors?.listDatabases) throw new Error(options.metadataErrors.listDatabases)
        return options.databases ?? [{ name: 'main' }]
      },
      listSchemas: async (): Promise<SchemaInfo[]> => {
        if (options.metadataErrors?.listSchemas) throw new Error(options.metadataErrors.listSchemas)
        return [{ name: 'main' }]
      },
      listTables: async (): Promise<TableInfo[]> => {
        if (options.metadataErrors?.listTables) throw new Error(options.metadataErrors.listTables)
        return (options.tables ?? []).map((name) => ({ name, schema: 'main', type: 'table' }))
      },
      listViews: async (): Promise<ViewInfo[]> => {
        if (options.metadataErrors?.listViews) throw new Error(options.metadataErrors.listViews)
        return (options.views ?? []).map((name) => ({ name, schema: 'main' }))
      },
      listProcedures: async () =>
        (options.procedures ?? []).map((name) => ({ name, schema: 'main', type: 'procedure' as const })),
      listFunctions: async () =>
        (options.functions ?? []).map((name) => ({ name, schema: 'main' })),
      listTriggers: async () => [],
      listSequences: async () => [],
      listSynonyms: async () =>
        (options.synonyms ?? []).map((name) => ({ name, schema: 'main' })),
      listUsers: async () =>
        (options.users ?? []).map((name) => ({ name, type: 'S' })),
      listRoles: async () =>
        (options.roles ?? []).map((name) => ({ name, type: 'R' })),
      getTableMetadata: async (_connId: string, _db: string, _schema: string, _table: string): Promise<TableMetadata> => {
        const meta = options.tableMetadata?.[_table]
        if (meta) return meta
        return { columns: [], primaryKey: [], foreignKeys: [], indexes: [], constraints: [], triggers: [], dependencies: [] }
      },
      getObjectDefinition: async (_connId: string, obj: DbObjectRef): Promise<string> => {
        if (obj.type === 'view') return `CREATE VIEW ${JSON.stringify(obj.name)} AS SELECT 1;`
        return `CREATE TABLE ${JSON.stringify(obj.name)} (\n  "id" INTEGER PRIMARY KEY\n);`
      },
      scriptObject: async (_connId: string, obj: DbObjectRef, kind: ScriptKind) => {
        // Zelfde routing als main process: CREATE op niet-tabel → providerdefinitie.
        if (kind === 'CREATE' && obj.type !== 'table') {
          return {
            sql: `CREATE VIEW ${JSON.stringify(obj.name)} AS SELECT 1;`,
            title: `${obj.name} — CREATE`
          }
        }
        const meta = options.tableMetadata?.[obj.name] ?? {
          columns: [],
          primaryKey: [],
          foreignKeys: [],
          indexes: [],
          constraints: [],
          triggers: [],
          dependencies: []
        }
        const sql =
          kind === 'CREATE'
            ? buildCreateTable('sqlite', obj.name, obj.schema ?? null, meta)
            : buildScriptObject(kind, 'sqlite', obj.name, obj.schema ?? null, meta)
        return { sql, title: `${obj.name} — ${kind}` }
      }
    },

    queryFiles: {
      open: async (): Promise<QueryFileOpenResult> =>
        options.openFileResult ?? { canceled: true },
      save: async (content: string, path?: string): Promise<QueryFileSaveResult> => {
        savedFiles.push({ content, path })
        return options.saveFileResult ?? { canceled: false, path: path ?? '/tmp/query.sql' }
      }
    },

    history: {
      list: async () => [],
      clear: async () => {}
    },

    tableData: {
      getRows: async () => ({
        columns: [],
        rows: [],
        truncated: false,
        rowCount: 0,
        primaryKey: [],
        editableColumns: []
      }),
      edit: async () => ({ rowCount: 0, sql: '' })
    },

    transactions: {
      begin: async (connectionId: string) => ({ connectionId, state: 'active' as const }),
      commit: async (connectionId: string) => ({ connectionId, state: 'none' as const }),
      rollback: async (connectionId: string) => ({ connectionId, state: 'none' as const }),
      status: async (connectionId: string) => ({ connectionId, state: 'none' as const })
    },

    admin: {
      createDatabase: async (_connId: string, name: string) => {
        // SAL-31: net als de echte provider beïnvloedt CREATE DATABASE de
        // databaselijst; de Object Explorer-refresh-test hangt hierop.
        if (options.databases && !options.databases.some((d) => d.name === name)) {
          options.databases.push({ name })
        }
        return { ok: true, sql: '' }
      },
      dropDatabase: async (connId: string, name: string, confirmed?: boolean) => {
        adminRequests.push({ action: 'dropDatabase', args: [connId, name], confirmed })
        if (options.adminDropBlocked && !confirmed) {
          return { ok: false, sql: `DROP DATABASE ${name};`, blocked: ['DROP op PROD-omgeving vereist bevestiging'], guardSeverity: 'confirm' }
        }
        if (options.databases) {
          const i = options.databases.findIndex((d) => d.name === name)
          if (i >= 0) options.databases.splice(i, 1)
        }
        return { ok: true, sql: '' }
      },
      createSchema: async () => ({ ok: true, sql: '' }),
      dropSchema: async (connId: string, _db: string, name: string, confirmed?: boolean) => {
        adminRequests.push({ action: 'dropSchema', args: [connId, name], confirmed })
        if (options.adminDropBlocked && !confirmed) {
          return { ok: false, sql: `DROP SCHEMA ${name};`, blocked: ['DROP op PROD-omgeving vereist bevestiging'], guardSeverity: 'confirm' }
        }
        return { ok: true, sql: '' }
      },
      createTable: async (req: AdminTableCreateRequest) => {
        // SAL-32: net als de echte provider beïnvloedt CREATE TABLE de
        // tabel-lijst; de Object Explorer auto-refresh-test hangt hierop.
        if (options.tables && req.table && !options.tables.includes(req.table)) {
          options.tables.push(req.table)
        }
        return { ok: true, sql: '' }
      },
      dropTable: async (connId: string, _db: string, _schema: string, table: string, confirmed?: boolean) => {
        adminRequests.push({ action: 'dropTable', args: [connId, table], confirmed })
        if (options.adminDropBlocked && !confirmed) {
          return { ok: false, sql: `DROP TABLE ${table};`, blocked: ['DROP op PROD-omgeving vereist bevestiging'], guardSeverity: 'confirm' }
        }
        if (options.tables) {
          const i = options.tables.indexOf(table)
          if (i >= 0) options.tables.splice(i, 1)
        }
        return { ok: true, sql: '' }
      },
      createView: async (_connId: string, _db: string, _schema: string, name: string) => {
        if (options.views && name && !options.views.includes(name)) {
          options.views.push(name)
        }
        return { ok: true, sql: '' }
      },
      dropView: async (connId: string, _db: string, _schema: string, name: string, confirmed?: boolean) => {
        adminRequests.push({ action: 'dropView', args: [connId, name], confirmed })
        if (options.adminDropBlocked && !confirmed) {
          return { ok: false, sql: `DROP VIEW ${name};`, blocked: ['DROP op PROD-omgeving vereist bevestiging'], guardSeverity: 'confirm' }
        }
        if (options.views) {
          const i = options.views.indexOf(name)
          if (i >= 0) options.views.splice(i, 1)
        }
        return { ok: true, sql: '' }
      },
      createIndex: async () => ({ ok: true, sql: '' }),
      dropIndex: async () => ({ ok: true, sql: '' }),
      listUsers: async () => [],
      createUser: async () => ({ ok: true, sql: '' }),
      dropUser: async () => ({ ok: true, sql: '' }),
      capabilities: async () =>
        options.capabilities ?? {
          supportsSchemas: true,
          supportsSequences: false,
          supportsSynonyms: false,
          supportsTriggers: true,
          supportsExecutionPlans: false,
          supportsMonitoring: false,
          supportsTransactions: true,
          supportsIdentityColumns: true,
          supportsGeneratedColumns: true,
          supportsDdlAdmin: true,
          supportsUsersAndRoles: false,
          supportsBackupRestore: true,
          maxResultRowsDefault: 1000,
          dialect: 'sqlite' as const
        },
      backupDatabase: async () => ({ ok: true, targetPath: '/tmp/backup.db', durationMs: 1 }),
      restoreDatabase: async () => ({ ok: true, sourcePath: '/tmp/backup.db', durationMs: 1 })
    },

    performance: {
      getStats: async () => ({ elapsedMs: 0, rowsReturned: 0 })
    },

    search: {
      search: async () => []
    },

    snippets: {
      list: async () => [],
      save: async (entry) => ({ id: 1, folder: entry.folder, title: entry.title, sql: entry.sql, updatedAt: new Date().toISOString() }),
      remove: async () => {},
      listFolders: async () => ['Algemeen']
    },

    import: {
      pickFile: async () => ({ canceled: true }),
      preview: async () => ({ fileName: 'x.csv', format: 'csv', columns: [], rows: [], totalRows: 0, uniqueColumns: [] }),
      generate: async () => ({ sql: '', rowCount: 0 }),
      execute: async () => ({ ok: true, rowCount: 0 })
    },

    audit: {
      list: async () => [],
      clear: async () => {}
    },

    dashboard: {
      get: async () => ({
        serverInfo: SERVER_INFO,
        databases: [],
        activeQueries: []
      })
    },

    monitoring: {
      activeQueries: async () => [],
      locks: async () => []
    },

    compare: {
      schemas: async () => ({ tablesOnlyInSource: [], tablesOnlyInTarget: [], columnDiffs: [], missingTables: 0, missingColumns: 0 }),
      data: async () => ({ table: 't', sourceRowCount: 0, targetRowCount: 0, differs: false }),
      deployScript: async () => ''
    },

    ai: {
      saveConfig: async () => {},
      chat: async () => ({ text: '-- AI-antwoord' })
    },

    plugins: {
      list: async () => [],
      reload: async () => []
    },

    app: {
      getVersion: async () => '0.1.0'
    }
  }

  return api
}

export function sampleConnection(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: 'conn-1',
    name: 'Klantendatabase',
    providerId: 'sqlite',
    environment: 'DEV',
    host: '/tmp/klanten.db',
    auth: 'username-password',
    ssl: { mode: 'disable' },
    connectionTimeoutMs: 10000,
    createIfMissing: true,
    group: 'Development',
    ...overrides
  }
}

export function sampleTableMetadata(_table: string): TableMetadata {
  return {
    columns: [
      { name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true, isIdentity: true, isComputed: false, ordinalPosition: 1, defaultValue: null },
      { name: 'naam', dataType: 'TEXT', nullable: false, isPrimaryKey: false, isIdentity: false, isComputed: false, ordinalPosition: 2, defaultValue: null }
    ],
    primaryKey: ['id'],
    foreignKeys: [],
    indexes: [],
    constraints: [],
    triggers: [],
    dependencies: [],
    rowCount: 2
  }
}

export function sampleQueryResult(): QueryRunResponse {
  return {
    executionId: 'exec-1',
    columns: [
      { name: 'id', dataType: 'INTEGER' },
      { name: 'naam', dataType: 'TEXT' }
    ],
    rows: [
      { values: [1, 'Jan'] },
      { values: [2, null] }
    ],
    truncated: false,
    rowCount: 2,
    durationMs: 3
  }
}
