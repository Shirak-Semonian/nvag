import type {
  ConnectionConfig,
  ConnectionSecret,
  DatabaseInfo,
  NvagIpcApi,
  QueryRunResponse,
  SchemaInfo,
  ServerInfo,
  TableInfo,
  TableMetadata,
  TestResult,
  ViewInfo
} from '@nvag/contracts'

export interface MockNvagOptions {
  connections?: ConnectionConfig[]
  tables?: string[]
  views?: string[]
  tableMetadata?: Record<string, TableMetadata>
  queryResults?: Record<string, QueryRunResponse>
  defaultQueryResult?: QueryRunResponse
  failOpenConnectionIds?: string[]
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
 */
export function createMockNvag(options: MockNvagOptions = {}): NvagIpcApi & {
  savedConfigs: ConnectionConfig[]
  openedSessions: string[]
  closedSessions: string[]
  queriedSql: string[]
} {
  const savedConfigs: ConnectionConfig[] = [...(options.connections ?? [])]
  const openedSessions: string[] = []
  const closedSessions: string[] = []
  const queriedSql: string[] = []
  let sessionSeq = 0

  const api: NvagIpcApi & {
    savedConfigs: ConnectionConfig[]
    openedSessions: string[]
    closedSessions: string[]
    queriedSql: string[]
  } = {
    savedConfigs,
    openedSessions,
    closedSessions,
    queriedSql,

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
        return { sessionId: `session-${sessionSeq}`, serverInfo: SERVER_INFO }
      },
      close: async (sessionId: string) => {
        closedSessions.push(sessionId)
      }
    },

    query: {
      run: async (req) => {
        queriedSql.push(req.sql)
        return options.queryResults?.[req.sql] ?? options.defaultQueryResult ?? defaultResult()
      },
      cancel: async () => {}
    },

    metadata: {
      listDatabases: async (): Promise<DatabaseInfo[]> => [{ name: 'main' }],
      listSchemas: async (): Promise<SchemaInfo[]> => [{ name: 'main' }],
      listTables: async (): Promise<TableInfo[]> =>
        (options.tables ?? []).map((name) => ({ name, schema: 'main', type: 'table' })),
      listViews: async (): Promise<ViewInfo[]> =>
        (options.views ?? []).map((name) => ({ name, schema: 'main' })),
      listProcedures: async () => [],
      listFunctions: async () => [],
      listTriggers: async () => [],
      listSequences: async () => [],
      getTableMetadata: async (_connId: string, _db: string, _schema: string, _table: string): Promise<TableMetadata> => {
        const meta = options.tableMetadata?.[_table]
        if (meta) return meta
        return { columns: [], primaryKey: [], foreignKeys: [], indexes: [], constraints: [], triggers: [], dependencies: [] }
      }
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
