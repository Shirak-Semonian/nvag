/**
 * F2-3: Database Administration — environment-safety guard-flow
 * (warn-doorloop buiten PROD, confirm-blokkade + bevestiging).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteProvider } from '@nvag/provider-sqlite'
import type {
  ConnectionConfig,
  ConnectionSecret,
  DatabaseProvider,
  DbSession,
  Environment,
  ProviderCapabilities,
  QueryChunk,
  QueryOptions,
  QueryRow,
  ServerInfo
} from '@nvag/contracts'
import {
  alterDatabase,
  backupDatabase,
  createTable,
  dropConstraint,
  dropFunction,
  dropProcedure,
  dropRole,
  dropSchema,
  dropSequence,
  dropSynonym,
  dropTable,
  dropTrigger,
  dropUser,
  getDatabaseProperties,
  restoreDatabase
} from './database-admin'
import { sessionManager } from './session-manager'
import { registry } from './registry'

// ipc-bootstrap importeert electron; mock alleen de connectionStore die
// database-admin nodig heeft voor de guard (omgeving per test instelbaar).
vi.mock('./ipc-bootstrap', () => ({
  connectionStore: {
    get: vi.fn(() => ({ id: 'adm-1', name: 'Admin Test', environment: 'DEV' }))
  }
}))

import { connectionStore } from './ipc-bootstrap'

let dir: string
const cfg: ConnectionConfig = {
  id: 'adm-1',
  name: 'Admin Test',
  providerId: 'sqlite',
  environment: 'DEV',
  host: '',
  auth: 'username-password',
  ssl: { mode: 'disable' },
  connectionTimeoutMs: 5000,
  createIfMissing: true,
  group: 'Test'
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nvag-admin-'))
  cfg.host = join(dir, 'admin.db')
  const provider = createSqliteProvider()
  registry.register(provider)
  await sessionManager.open(cfg)
})

afterAll(async () => {
  await sessionManager.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

function setEnvironment(env: Environment): void {
  vi.mocked(connectionStore.get).mockReturnValue({ ...cfg, environment: env })
}

describe('F2-3 admin guard-flow', () => {
  beforeEach(() => {
    setEnvironment('DEV')
  })

  it('voert CREATE uit op DEV (warn-niveau) met waarschuwing', async () => {
    const r = await createTable('adm-1', '', 'main', 'klanten', [
      { name: 'id', dataType: 'INTEGER', primaryKey: true },
      { name: 'naam', dataType: 'TEXT' }
    ])
    expect(r.ok).toBe(true)
    expect(r.sql).toContain('CREATE TABLE')
    expect(r.warning).toBeDefined()
    expect(r.warning?.some((w) => /CREATE/i.test(w))).toBe(true)

    // De tabel bestaat echt (via de sessie).
    const session = sessionManager.getByConnectionId('adm-1')!
    const provider = registry.get('sqlite')
    let found = false
    for await (const chunk of provider.executeQuery(session, "SELECT name FROM sqlite_master WHERE type='table' AND name='klanten'", {})) {
      if (chunk.kind === 'rows' && chunk.rows.length > 0) found = true
    }
    expect(found).toBe(true)
  })

  it('blokkeert DROP op DEV (confirm-niveau) tot bevestiging', async () => {
    const r = await dropTable('adm-1', '', 'main', 'klanten')
    expect(r.ok).toBe(false)
    expect(r.blocked?.some((b) => /DROP/i.test(b))).toBe(true)
    expect(r.guardSeverity).toBe('confirm')

    // Zonder confirm is de tabel er nog.
    const session = sessionManager.getByConnectionId('adm-1')!
    const provider = registry.get('sqlite')
    let found = false
    for await (const chunk of provider.executeQuery(session, "SELECT name FROM sqlite_master WHERE type='table' AND name='klanten'", {})) {
      if (chunk.kind === 'rows' && chunk.rows.length > 0) found = true
    }
    expect(found).toBe(true)
  })

  it('voert DROP uit na bevestiging (confirmed=true)', async () => {
    const r = await dropTable('adm-1', '', 'main', 'klanten', true)
    expect(r.ok).toBe(true)
    expect(r.sql).toContain('DROP TABLE')

    const session = sessionManager.getByConnectionId('adm-1')!
    const provider = registry.get('sqlite')
    let found = false
    for await (const chunk of provider.executeQuery(session, "SELECT name FROM sqlite_master WHERE type='table' AND name='klanten'", {})) {
      if (chunk.kind === 'rows' && chunk.rows.length > 0) found = true
    }
    expect(found).toBe(false)
  })

  it('blokkeert CREATE op PROD (alles confirm) tot bevestiging', async () => {
    setEnvironment('PROD')
    // SQLite kent geen CREATE DATABASE; gebruik een tabel-CREATE.
    const r = await createTable('adm-1', '', 'main', 'prod_tabel', [
      { name: 'id', dataType: 'INTEGER', primaryKey: true }
    ])
    expect(r.ok).toBe(false)
    expect(r.guardSeverity).toBe('confirm')

    const confirmed = await createTable('adm-1', '', 'main', 'prod_tabel', [
      { name: 'id', dataType: 'INTEGER', primaryKey: true }
    ], true)
    expect(confirmed.ok).toBe(true)
    expect(confirmed.sql).toContain('CREATE TABLE')
  })
})

describe('F4 backup/restore guard-flow', () => {
  let backupFile: string

  beforeEach(() => {
    setEnvironment('DEV')
    backupFile = join(dir, 'f4-backup.db')
    rmSync(backupFile, { force: true })
  })

  it('backup voert uit op DEV (warn-niveau) met waarschuwing', async () => {
    const r = await backupDatabase('adm-1', 'main', backupFile)
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/BACKUP statement/)
  })

  it('backup op PROD vraagt bevestiging (confirm)', async () => {
    setEnvironment('PROD')
    const r = await backupDatabase('adm-1', 'main', backupFile)
    expect(r.ok).toBe(false)
    expect(r.blocked?.some((b) => /BACKUP/i.test(b))).toBe(true)
    expect(r.guardSeverity).toBe('confirm')

    // Bevestigd → uitvoeren.
    const confirmed = await backupDatabase('adm-1', 'main', backupFile, true)
    expect(confirmed.ok).toBe(true)
  })

  it('restore blokkeert op elke omgeving tot bevestiging (destructief)', async () => {
    // Eerst een backup maken zodat restore iets terugzet.
    const backup = await backupDatabase('adm-1', 'main', backupFile, true)
    expect(backup.ok).toBe(true)

    for (const env of ['DEV', 'PROD'] as const) {
      setEnvironment(env)
      const r = await restoreDatabase('adm-1', 'main', backupFile)
      expect(r.ok).toBe(false)
      expect(r.blocked?.some((b) => /RESTORE/i.test(b))).toBe(true)
      expect(r.guardSeverity).toBe('confirm')
    }

    // Bevestigd → uitvoeren.
    const confirmed = await restoreDatabase('adm-1', 'main', backupFile, true)
    expect(confirmed.ok).toBe(true)
    expect(confirmed.sourcePath).toBe(backupFile)
  })

  it('meldt een ontbrekend backupbestand bij restore', async () => {
    const r = await restoreDatabase('adm-1', 'main', join(dir, 'bestaand-niet.db'), true)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/niet gevonden/)
  })
})

// ---------------------------------------------------------------------------
// SAL-45: DROP voor procedure/function/trigger/sequence/synonym/user/role/
// constraint op een tsql-achtige provider (SQL Server-dialect). De fake
// provider registreert de uitgevoerde SQL zodat de gegenereerde DROP-statements
// gecontroleerd worden (de echte uitvoering valideert de live-tests).
// ---------------------------------------------------------------------------

const TSQL_BASE_CAPS: Omit<ProviderCapabilities, 'dialect'> = {
  supportsSchemas: true,
  supportsSequences: true,
  supportsSynonyms: true,
  supportsTriggers: true,
  supportsExecutionPlans: false,
  supportsMonitoring: false,
  supportsTransactions: true,
  supportsIdentityColumns: true,
  supportsGeneratedColumns: true,
  supportsDdlAdmin: true,
  supportsUsersAndRoles: true,
  supportsBackupRestore: false,
  maxResultRowsDefault: 1000
}

function makeFakeTsqlProvider(
  id: string,
  executed: string[],
  selectRows?: Array<{ startsWith: string; rows: QueryRow[] }>
): DatabaseProvider {
  const sessions = new Set<DbSession>()
  const caps: ProviderCapabilities = { ...TSQL_BASE_CAPS, dialect: 'tsql' }
  return {
    id,
    displayName: id,
    defaultPort: 1433,
    capabilities: caps,
    async connect(config: ConnectionConfig, _secret?: ConnectionSecret): Promise<DbSession> {
      const session: DbSession = {
        handle: {},
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
      return { providerId: id, providerName: id, serverVersion: 'x', currentDatabase: session.database }
    },
    async close(session: DbSession): Promise<void> {
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
    async listSynonyms() {
      return []
    },
    async listUsers() {
      return []
    },
    async listRoles() {
      return []
    },
    async getTableMetadata() {
      return { columns: [], primaryKey: [], foreignKeys: [], indexes: [], constraints: [], triggers: [], dependencies: [] }
    },
    async getObjectDefinition() {
      return 'CREATE TABLE t (id int);'
    },
    async *executeQuery(
      _session: DbSession,
      sql: string,
      _opts: QueryOptions
    ): AsyncIterable<QueryChunk> {
      executed.push(sql)
      const match = selectRows?.find((s) => sql.trim().startsWith(s.startsWith))
      if (match) {
        yield { kind: 'rows', rows: match.rows }
      }
      yield { kind: 'done', rowCount: 0, durationMs: 1 }
    },
    async cancel() {},
    async getExecutionStats() {
      return { rowCount: 0, durationMs: 0 }
    }
  }
}

describe('SAL-45 DROP-methods (tsql dialect, fake provider)', () => {
  const executed: string[] = []
  const cfg: ConnectionConfig = {
    id: 'adm-tsql',
    name: 'Admin TSQL',
    providerId: 'fake-sqlserver',
    environment: 'DEV',
    host: 'localhost',
    auth: 'username-password',
    ssl: { mode: 'disable' },
    connectionTimeoutMs: 5000,
    group: 'Test'
  }

  beforeAll(async () => {
    registry.register(makeFakeTsqlProvider('fake-sqlserver', executed))
    // SAL-51: database-context-DDL opent een tijdelijke sessie via
    // configProvider (config + secret van de opgeslagen verbinding).
    sessionManager.configProvider = () => ({ config: cfg, secret: undefined })
    await sessionManager.open(cfg)
  })

  afterAll(async () => {
    await sessionManager.closeAll()
    sessionManager.configProvider = null
  })

  beforeEach(() => {
    executed.length = 0
    setEnvironment('DEV')
  })

  it('blokkeert DROP zonder bevestiging (guard confirm) en voert na bevestiging uit', async () => {
    const blocked = await dropProcedure('adm-tsql', 'db', 'dbo', 'sp_x')
    expect(blocked.ok).toBe(false)
    expect(blocked.guardSeverity).toBe('confirm')
    expect(executed).toEqual([])

    const r = await dropProcedure('adm-tsql', 'db', 'dbo', 'sp_x', true)
    expect(r.ok).toBe(true)
    expect(executed).toEqual(['DROP PROCEDURE [dbo].[sp_x];'])
  })

  it('dropt procedure/function/sequence/synonym met schema-qualificatie', async () => {
    await dropFunction('adm-tsql', 'db', 'dbo', 'fn_x', true)
    await dropSequence('adm-tsql', 'db', 'dbo', 'seq_x', true)
    await dropSynonym('adm-tsql', 'db', 'dbo', 'syn_x', true)
    expect(executed).toEqual([
      'DROP FUNCTION [dbo].[fn_x];',
      'DROP SEQUENCE [dbo].[seq_x];',
      'DROP SYNONYM [dbo].[syn_x];'
    ])
  })

  it('dropt een trigger (tsql zonder ON-tabel)', async () => {
    await dropTrigger('adm-tsql', 'db', 'dbo', 'trg_x', undefined, true)
    expect(executed).toEqual(['DROP TRIGGER [dbo].[trg_x];'])
  })

  it('dropt user/role zonder schema (database-scoped principals)', async () => {
    // DROP USER/ROLE is ook confirm-gated (SAL-45: guard-patroon uitgebreid).
    const blockedUser = await dropUser('adm-tsql', '', 'app_ro')
    expect(blockedUser.ok).toBe(false)
    expect(executed).toEqual([])

    await dropUser('adm-tsql', '', 'app_ro', true)
    expect(executed).toEqual(['DROP USER [app_ro];'])
    executed.length = 0
    const blockedRole = await dropRole('adm-tsql', '', 'db_reader')
    expect(blockedRole.ok).toBe(false)
    await dropRole('adm-tsql', '', 'db_reader', true)
    expect(executed).toEqual(['DROP ROLE [db_reader];'])
  })

  it('dropt een constraint via ALTER TABLE … DROP CONSTRAINT', async () => {
    const r = await dropConstraint('adm-tsql', 'db', 'dbo', 'klanten', 'CK_leeftijd', true)
    expect(r.ok).toBe(true)
    expect(executed).toEqual(['ALTER TABLE [dbo].[klanten] DROP CONSTRAINT [CK_leeftijd];'])
  })

  it('weigert dropRole op providers zonder supportsUsersAndRoles', async () => {
    // de sqlite-provider uit de eerste suite ondersteunt geen users/roles.
    await expect(dropRole('adm-1', '', 'x', true)).rejects.toThrow(/does not support users\/roles/)
  })
})

// ---------------------------------------------------------------------------
// SAL-50: database-eigenschappen lezen/wijzigen (getDatabaseProperties +
// alterDatabase) op een tsql-fake met SELECT-rows.
// ---------------------------------------------------------------------------

describe('SAL-50 database-eigenschappen (tsql dialect, fake provider)', () => {
  const executed: string[] = []
  const cfg: ConnectionConfig = {
    id: 'adm-s50',
    name: 'Admin SAL-50',
    providerId: 'fake-sqlserver50',
    environment: 'DEV',
    host: 'localhost',
    auth: 'username-password',
    ssl: { mode: 'disable' },
    connectionTimeoutMs: 5000,
    group: 'Test'
  }

  // Rijvolgorde van getTsqlDatabaseProperties (sys.databases-query):
  // [name, collation_name, recovery_model_desc, containment_desc,
  //  compatibility_level, owner_name, create_date, state, size_bytes,
  //  user_access, is_auto_close, is_auto_shrink, is_read_only,
  //  page_verify, is_encrypted, is_trustworthy]
  const selectRows = [
    {
      startsWith: 'SELECT d.name AS name',
      rows: [
        {
          values: [
            'Klanten',
            'Dutch_CI_AS',
            'FULL',
            'NONE',
            150,
            'sa',
            '2024-01-15T08:30:00.000Z',
            'ONLINE',
            5242880n,
            'MULTI_USER',
            false,
            false,
            false,
            'CHECKSUM',
            false,
            true
          ]
        }
      ]
    },
    {
      startsWith: "SELECT CAST(SERVERPROPERTY('ProductMajorVersion')",
      rows: [{ values: [16, 0] }]
    },
    {
      // sys.master_files: [name, type, path, size_bytes, max_size_bytes,
      // is_percent_growth, growth_bytes]
      startsWith: 'SELECT f.name AS name',
      rows: [
        {
          values: ['Klanten', 'ROWS', '/var/opt/mssql/data/Klanten.mdf', 5242880n, -1, false, 1048576n]
        },
        {
          values: ['Klanten_log', 'LOG', '/var/opt/mssql/data/Klanten_log.ldf', 2097152n, 10485760n, false, 524288n]
        }
      ]
    }
  ]

  beforeAll(async () => {
    registry.register(makeFakeTsqlProvider('fake-sqlserver50', executed, selectRows))
    await sessionManager.open(cfg)
  })

  afterAll(async () => {
    await sessionManager.closeAll()
  })

  beforeEach(() => {
    executed.length = 0
    setEnvironment('DEV')
  })

  it('leest actuele database-eigenschappen uit sys.databases + serverconfiguratie', async () => {
    const props = await getDatabaseProperties('adm-s50', 'Klanten')
    expect(props.supportsAlter).toBe(true)
    expect(props.database).toBe('Klanten')
    expect(props.dialect).toBe('tsql')

    const nameProp = props.properties.find((p) => p.key === 'name')
    expect(nameProp?.editable).toBe(true)
    expect(nameProp?.renamesDatabase).toBe(true)

    const recovery = props.properties.find((p) => p.key === 'recovery')
    expect(recovery?.value).toBe('FULL')
    expect(recovery?.options?.map((o) => o.value)).toEqual(['FULL', 'SIMPLE', 'BULK_LOGGED'])

    const compat = props.properties.find((p) => p.key === 'compatibility_level')
    expect(compat?.value).toBe('150')
    // Server-major 16 (SQL Server 2022) → optie 160 aanwezig.
    expect(compat?.options?.some((o) => o.value === '160')).toBe(true)

    const readOnly = props.properties.find((p) => p.key === 'read_only')
    expect(readOnly?.value).toBe('READ_WRITE')

    // Read-only-info is gemarkeerd als niet bewerkbaar.
    const collation = props.properties.find((p) => p.key === 'collation')
    expect(collation?.value).toBe('Dutch_CI_AS')
    expect(collation?.editable).toBe(false)

    // Opties-sectie (SSMS-achtig overzicht: auto close/shrink, paginaverificatie).
    const autoClose = props.properties.find((p) => p.key === 'auto_close')
    expect(autoClose?.section).toBe('opties')
    expect(autoClose?.value).toBe('No')
    const autoShrink = props.properties.find((p) => p.key === 'auto_shrink')
    expect(autoShrink?.value).toBe('No')
    const pageVerify = props.properties.find((p) => p.key === 'page_verify')
    expect(pageVerify?.value).toBe('CHECKSUM')
    const encrypted = props.properties.find((p) => p.key === 'encrypted')
    expect(encrypted?.value).toBe('No')
    const trustworthy = props.properties.find((p) => p.key === 'trustworthy')
    expect(trustworthy?.value).toBe('Yes')

    // Bestanden uit sys.master_files (paden, grootte, groei).
    expect(props.files).toHaveLength(2)
    const dataFile = props.files?.[0]
    expect(dataFile?.name).toBe('Klanten')
    expect(dataFile?.type).toBe('ROWS')
    expect(dataFile?.physicalName).toBe('/var/opt/mssql/data/Klanten.mdf')
    expect(dataFile?.sizeMb).toBe(5)
    expect(dataFile?.maxSizeMb).toBeNull() // max_size = -1 → onbeperkt
    expect(dataFile?.growthMb).toBe(1)
    const logFile = props.files?.[1]
    expect(logFile?.type).toBe('LOG')
    expect(logFile?.sizeMb).toBe(2)
    expect(logFile?.maxSizeMb).toBe(10)
  })

  it('blokkeert ALTER zonder bevestiging (guard confirm) en voert daarna elk statement uit', async () => {
    const blocked = await alterDatabase('adm-s50', 'Klanten', { recovery: 'SIMPLE' })
    expect(blocked.ok).toBe(false)
    expect(blocked.guardSeverity).toBe('confirm')
    expect(blocked.sql).toContain('ALTER DATABASE [Klanten] SET RECOVERY SIMPLE;')
    expect(executed).toEqual([])

    const r = await alterDatabase(
      'adm-s50',
      'Klanten',
      { recovery: 'SIMPLE', compatibility_level: '160' },
      true
    )
    expect(r.ok).toBe(true)
    expect(executed).toEqual([
      'ALTER DATABASE [Klanten] SET RECOVERY SIMPLE;',
      'ALTER DATABASE [Klanten] SET COMPATIBILITY_LEVEL = 160;'
    ])
  })

  it('rapporteert renamedTo na een bevestigde MODIFY NAME', async () => {
    const r = await alterDatabase('adm-s50', 'Klanten', { name: 'Klanten2' }, true)
    expect(r.ok).toBe(true)
    expect(r.renamedTo).toBe('Klanten2')
    expect(executed).toEqual(['ALTER DATABASE [Klanten] MODIFY NAME = [Klanten2];'])
  })

  it('weigert een onbekende eigenschap en een niet-tsql-dialect', async () => {
    await expect(alterDatabase('adm-s50', 'Klanten', { owner: 'sa' }, true)).rejects.toThrow(
      /kan voor dit dialect/
    )
  })
})

describe('SAL-50 database-eigenschappen op niet-tsql-providers (sqlite)', () => {
  let dir2: string
  const sqliteCfg: ConnectionConfig = {
    id: 'adm-s50-sqlite',
    name: 'Admin SAL-50 SQLite',
    providerId: 'sqlite',
    environment: 'DEV',
    host: '',
    auth: 'username-password',
    ssl: { mode: 'disable' },
    connectionTimeoutMs: 5000,
    createIfMissing: true,
    group: 'Test'
  }

  beforeAll(async () => {
    dir2 = mkdtempSync(join(tmpdir(), 'nvag-admin-s50-'))
    sqliteCfg.host = join(dir2, 'admin-s50.db')
    registry.register(createSqliteProvider())
    await sessionManager.open(sqliteCfg)
  })

  afterAll(async () => {
    await sessionManager.closeAll()
    rmSync(dir2, { recursive: true, force: true })
  })

  it('markeert ALTER als niet-ondersteund en geeft een duidelijke boodschap', async () => {
    const props = await getDatabaseProperties('adm-s50-sqlite', 'main')
    expect(props.supportsAlter).toBe(false)
    expect(props.dialect).toBe('sqlite')
    expect(props.message).toMatch(/SQLite databases are files/)
    expect(props.properties).toEqual([])

    // De UI-gating voorkomt alterDatabase-aanroepen; mocht het toch gebeuren
    // dan gooit de builder een duidelijke fout.
    await expect(alterDatabase('adm-s50-sqlite', 'main', { name: 'x' }, true)).rejects.toThrow(
      /niet ondersteund/
    )
  })
})

// ---------------------------------------------------------------------------
// SAL-51: database-context voor admin-DDL. Wanneer een actie een doeldatabase
// meekrijgt die afwijkt van de sessie-database, voert runDdl de DDL uit op een
// korte, aparte sessie die direct op die database verbonden is (tsql/mysql/
// postgres) — niet op de sessie-database (master). Zo belandt CREATE TABLE van
// de Tables-folder van database X in X, en werkt DROP op objecten van X zonder
// eerst de sessie te wisselen.
// ---------------------------------------------------------------------------

describe('SAL-51 database-context admin-DDL (tsql dialect, fake provider)', () => {
  const executed: string[] = []
  const connectedDbs: string[] = []
  const closedSessions: number[] = []

  const cfg: ConnectionConfig = {
    id: 'adm-ctx',
    name: 'Admin Context',
    providerId: 'fake-sqlserver51',
    environment: 'DEV',
    host: 'localhost',
    database: 'master',
    auth: 'username-password',
    ssl: { mode: 'disable' },
    connectionTimeoutMs: 5000,
    group: 'Test'
  }

  function makeContextProvider(id: string): DatabaseProvider {
    const caps: ProviderCapabilities = { ...TSQL_BASE_CAPS, dialect: 'tsql' }
    let seq = 0
    return {
      id,
      displayName: id,
      defaultPort: 1433,
      capabilities: caps,
      async connect(config: ConnectionConfig): Promise<DbSession> {
        connectedDbs.push(config.database ?? 'master')
        seq += 1
        return {
          handle: {},
          connectionId: config.id,
          providerId: id,
          database: config.database ?? 'master',
          // @ts-expect-error test-only marker om gesloten sessies te tellen
          _seq: seq
        }
      },
      async testConnection() {
        return { ok: true }
      },
      async getServerInfo(session: DbSession): Promise<ServerInfo> {
        return { providerId: id, providerName: id, serverVersion: 'x', currentDatabase: session.database }
      },
      async close(session: DbSession): Promise<void> {
        closedSessions.push(Number((session as unknown as { _seq?: number })._seq ?? 0))
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
      async listSynonyms() {
        return []
      },
      async listUsers() {
        return []
      },
      async listRoles() {
        return []
      },
      async getTableMetadata() {
        return { columns: [], primaryKey: [], foreignKeys: [], indexes: [], constraints: [], triggers: [], dependencies: [] }
      },
      async getObjectDefinition() {
        return 'CREATE TABLE t (id int);'
      },
      async *executeQuery(
        _session: DbSession,
        sql: string,
        _opts: QueryOptions
      ): AsyncIterable<QueryChunk> {
        executed.push(sql)
        yield { kind: 'done', rowCount: 0, durationMs: 1 }
      },
      async cancel() {},
      async getExecutionStats() {
        return { rowCount: 0, durationMs: 0 }
      }
    }
  }

  beforeAll(async () => {
    registry.register(makeContextProvider('fake-sqlserver51'))
    sessionManager.configProvider = () => ({ config: cfg, secret: undefined })
    await sessionManager.open(cfg)
  })

  afterAll(async () => {
    await sessionManager.closeAll()
    sessionManager.configProvider = null
  })

  beforeEach(() => {
    executed.length = 0
    connectedDbs.length = 0
    closedSessions.length = 0
    setEnvironment('DEV')
  })

  it('voert CREATE TABLE op de doeldatabase uit via een tijdelijke sessie (niet master)', async () => {
    const r = await createTable(
      'adm-ctx',
      'Factuur',
      'dbo',
      'klanten',
      [
        { name: 'id', dataType: 'int', primaryKey: true },
        { name: 'naam', dataType: 'nvarchar(255)' }
      ],
      true
    )
    expect(r.ok).toBe(true)
    // De DDL draaide op een sessie die direct op 'Factuur' was verbonden.
    expect(connectedDbs).toEqual(['Factuur'])
    expect(executed.some((sql) => sql.startsWith('CREATE TABLE [dbo].[klanten]'))).toBe(true)
    // De tijdelijke sessie is netjes gesloten.
    expect(closedSessions.length).toBe(1)
  })

  it('draait zonder extra sessie wanneer database leeg is of gelijk aan de sessie-database', async () => {
    await createTable('adm-ctx', '', undefined, 'klanten2', [{ name: 'id', dataType: 'int', primaryKey: true }], true)
    expect(connectedDbs).toEqual([])

    await dropTable('adm-ctx', 'master', 'dbo', 'klanten2', true)
    expect(connectedDbs).toEqual([])
    expect(executed.some((sql) => sql.startsWith('DROP TABLE [dbo].[klanten2]'))).toBe(true)
  })

  it('voert DROP TABLE op de doeldatabase uit (bug: geen "geen rechten" door master-sessie)', async () => {
    const r = await dropTable('adm-ctx', 'Factuur', 'dbo', 'klanten', true)
    expect(r.ok).toBe(true)
    expect(connectedDbs).toEqual(['Factuur'])
    expect(executed).toEqual(['DROP TABLE [dbo].[klanten];'])
  })

  it('voert user/role-DROP op de doeldatabase uit (database-principals)', async () => {
    const user = await dropUser('adm-ctx', 'Factuur', 'app_ro', true)
    expect(user.ok).toBe(true)
    const role = await dropRole('adm-ctx', 'Factuur', 'db_reader', true)
    expect(role.ok).toBe(true)
    expect(connectedDbs).toEqual(['Factuur', 'Factuur'])
    expect(executed).toEqual(['DROP USER [app_ro];', 'DROP ROLE [db_reader];'])
  })

  it('voert procedure/schema/constraint-DROP op de doeldatabase uit', async () => {
    await dropProcedure('adm-ctx', 'Factuur', 'dbo', 'sp_x', true)
    await dropSchema('adm-ctx', 'Factuur', 'audit', true)
    await dropConstraint('adm-ctx', 'Factuur', 'dbo', 'klanten', 'CK_leeftijd', true)
    expect(connectedDbs).toEqual(['Factuur', 'Factuur', 'Factuur'])
    expect(executed.some((sql) => sql.startsWith('DROP PROCEDURE [dbo].[sp_x]'))).toBe(true)
    expect(executed.some((sql) => sql.startsWith('DROP SCHEMA [audit]'))).toBe(true)
    expect(executed.some((sql) => sql.startsWith('ALTER TABLE [dbo].[klanten] DROP CONSTRAINT [CK_leeftijd]'))).toBe(true)
  })
})
