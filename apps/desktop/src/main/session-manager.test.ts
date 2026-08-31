import { beforeEach, describe, expect, it } from 'vitest'
import type {
  ConnectionConfig,
  ConnectionSecret,
  DatabaseProvider,
  DbSession,
  ProviderCapabilities,
  QueryChunk,
  QueryOptions,
  ServerInfo
} from '@nvag/contracts'
import { SessionManager } from './session-manager'
import { registry } from './registry'

/**
 * SessionManager (main process, F1-10): openSaved opent een sessie met het
 * vault-secret (snelle switch via dropdown), switchDatabase wisselt de
 * database in-place (USE) of via reconnect.
 */

const BASE_CAPS: Omit<ProviderCapabilities, 'dialect'> = {
  supportsSchemas: true,
  supportsSequences: false,
  supportsTriggers: true,
  supportsExecutionPlans: false,
  supportsMonitoring: false,
  supportsTransactions: true,
  supportsIdentityColumns: true,
  supportsGeneratedColumns: true,
  supportsDdlAdmin: true,
  supportsUsersAndRoles: false,
  supportsBackupRestore: false,
  maxResultRowsDefault: 1000
}

interface FakeState {
  connections: number
  closes: number
  executed: string[]
  databases: string[]
  secret?: string
}

function makeProvider(
  id: string,
  dialect: ProviderCapabilities['dialect'],
  state: FakeState,
  onConnect?: (config: ConnectionConfig, secret?: ConnectionSecret) => void
): DatabaseProvider {
  const sessions = new Set<DbSession>()
  return {
    id,
    displayName: id,
    defaultPort: 0,
    capabilities: { ...BASE_CAPS, dialect },
    async connect(config: ConnectionConfig, secret?: ConnectionSecret): Promise<DbSession> {
      state.connections += 1
      if (secret?.password) state.secret = secret.password
      onConnect?.(config, secret)
      const session: DbSession = {
        handle: { state },
        connectionId: config.id,
        providerId: id,
        database: config.database ?? 'master'
      }
      sessions.add(session)
      return session
    },
    async testConnection() {
      return { ok: true }
    },
    async getServerInfo(session: DbSession): Promise<ServerInfo> {
      return {
        providerId: id,
        providerName: id,
        serverVersion: '1.0',
        currentDatabase: session.database
      }
    },
    async close(session: DbSession): Promise<void> {
      state.closes += 1
      sessions.delete(session)
    },
    async listDatabases() {
      return []
    },
    async listSchemas() {
      return []
    },
    async listTables() {
      return []
    },
    async listViews() {
      return []
    },
    async listProcedures() {
      return []
    },
    async listFunctions() {
      return []
    },
    async listTriggers() {
      return []
    },
    async listSequences() {
      return []
    },
    async getTableMetadata() {
      return { columns: [], primaryKey: [], foreignKeys: [], indexes: [], constraints: [], triggers: [], dependencies: [] }
    },
    async getObjectDefinition() {
      return 'CREATE TABLE t (id int);'
    },
    async *executeQuery(
      session: DbSession,
      sql: string,
      _opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      state.executed.push(sql)
      if (sql.includes('FORCE_ERROR')) {
        yield { kind: 'error', message: 'USE mislukt' }
        return
      }
      // USE-wissel: sessie-database bijwerken (zoals een echte provider doet).
      const useMatch = /^USE\s+[\[`](.+)[\]`]$/i.exec(sql.trim())
      if (useMatch) {
        session.database = useMatch[1]!
        state.databases.push(session.database)
      }
      yield { kind: 'done', rowCount: 0, durationMs: 1 }
    },
    async cancel() {},
    async getExecutionStats() {
      return { rowCount: 0, durationMs: 0 }
    }
  }
}

let manager: SessionManager
let sqliteState: FakeState
let tsqlState: FakeState
let pgState: FakeState
let lastConnectConfig: ConnectionConfig | undefined

const CONFIG: ConnectionConfig = {
  id: 'conn-1',
  name: 'Test',
  providerId: 'test-sqlite',
  environment: 'DEV',
  host: 'localhost',
  auth: 'username-password',
  ssl: { mode: 'disable' },
  connectionTimeoutMs: 10000,
  database: 'dbA',
  group: 'Development'
}

beforeEach(() => {
  sqliteState = { connections: 0, closes: 0, executed: [], databases: [] }
  tsqlState = { connections: 0, closes: 0, executed: [], databases: [] }
  pgState = { connections: 0, closes: 0, executed: [], databases: [] }
  lastConnectConfig = undefined
  registry.register(makeProvider('test-sqlite', 'sqlite', sqliteState))
  registry.register(makeProvider('test-tsql', 'tsql', tsqlState))
  registry.register(
    makeProvider('test-postgres', 'postgres', pgState, (config) => {
      lastConnectConfig = config
    })
  )
  manager = new SessionManager()
  manager.configProvider = (connectionId) => {
    if (connectionId !== 'conn-1') return undefined
    return { config: CONFIG, secret: { password: 'geheim' } }
  }
})

describe('SessionManager (F1-10)', () => {
  it('opent een sessie via openSaved met config + vault-secret', async () => {
    const result = await manager.openSaved('conn-1')
    expect(result.connectionId).toBe('conn-1')
    expect(result.sessionId).toBeTruthy()
    expect(sqliteState.connections).toBe(1)
    expect(sqliteState.secret).toBe('geheim')
    expect(manager.getByConnectionId('conn-1')?.database).toBe('dbA')
  })

  it('hergebruikt een bestaande sessie bij openSaved (snelle switch)', async () => {
    const first = await manager.openSaved('conn-1')
    const second = await manager.openSaved('conn-1')
    expect(second.sessionId).toBe(first.sessionId)
    expect(sqliteState.connections).toBe(1)
  })

  it('gooit wanneer de verbinding niet bekend is', async () => {
    await expect(manager.openSaved('conn-onbekend')).rejects.toThrow('Verbinding niet gevonden')
  })

  it('gooit wanneer er geen sessie is voor switchDatabase', async () => {
    await expect(manager.switchDatabase('conn-1', 'dbB')).rejects.toThrow('Geen actieve sessie')
  })

  it('voert USE uit bij tsql en werkt de sessie-database bij', async () => {
    const pgConfig = { ...CONFIG, providerId: 'test-tsql', database: 'dbA' }
    manager.configProvider = () => ({ config: pgConfig, secret: { password: 'x' } })
    const opened = await manager.openSaved('conn-1')
    expect(tsqlState.executed).toEqual([])

    const switched = await manager.switchDatabase('conn-1', 'dbB')
    expect(tsqlState.executed).toEqual(['USE [dbB]'])
    expect(switched.serverInfo.currentDatabase).toBe('dbB')
    expect(switched.sessionId).toBe(opened.sessionId)
    expect(manager.getByConnectionId('conn-1')?.database).toBe('dbB')
  })

  it('voert USE uit bij mysql met backtick-quoting', async () => {
    const mysqlConfig = { ...CONFIG, providerId: 'test-tsql', database: 'dbA' }
    // pas dialect aan: gebruik een mysql-dialect-provider
    registry.register(makeProvider('test-mysql', 'mysql', tsqlState))
    manager.configProvider = () => ({ config: { ...mysqlConfig, providerId: 'test-mysql' }, secret: {} })
    await manager.openSaved('conn-1')
    await manager.switchDatabase('conn-1', 'my-db')
    expect(tsqlState.executed).toEqual(['USE `my-db`'])
  })

  it('doet niets bij dezelfde database', async () => {
    const result = await manager.openSaved('conn-1')
    const switched = await manager.switchDatabase('conn-1', 'dbA')
    expect(switched.sessionId).toBe(result.sessionId)
    expect(sqliteState.connections).toBe(1)
  })

  it('reconnect bij postgres met de nieuwe database', async () => {
    const pgConfig = { ...CONFIG, providerId: 'test-postgres', database: 'dbA' }
    manager.configProvider = () => ({ config: pgConfig, secret: { password: 'x' } })
    await manager.openSaved('conn-1')
    expect(pgState.connections).toBe(1)

    const switched = await manager.switchDatabase('conn-1', 'dbB')
    expect(pgState.closes).toBe(1)
    expect(pgState.connections).toBe(2)
    expect(lastConnectConfig?.database).toBe('dbB')
    expect(switched.serverInfo.currentDatabase).toBe('dbB')
  })

  it('geeft een duidelijke fout wanneer USE mislukt', async () => {
    const cfg = { ...CONFIG, providerId: 'test-tsql', database: 'dbA' }
    manager.configProvider = () => ({ config: cfg, secret: {} })
    await manager.openSaved('conn-1')
    await expect(manager.switchDatabase('conn-1', 'FORCE_ERROR')).rejects.toThrow('USE mislukt')
  })

  it('sluit sessies en ruimt de connectionId-index op', async () => {
    const opened = await manager.openSaved('conn-1')
    await manager.close(opened.sessionId)
    expect(manager.getByConnectionId('conn-1')).toBeUndefined()
    expect(sqliteState.closes).toBe(1)
  })
})
