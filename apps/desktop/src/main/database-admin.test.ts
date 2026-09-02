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
  ServerInfo
} from '@nvag/contracts'
import {
  createTable,
  dropTable,
  dropProcedure,
  dropFunction,
  dropTrigger,
  dropSequence,
  dropSynonym,
  dropRole,
  dropConstraint,
  dropUser,
  backupDatabase,
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
    expect(r.message).toMatch(/BACKUP-statement/)
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

function makeFakeTsqlProvider(id: string, executed: string[]): DatabaseProvider {
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
    await sessionManager.open(cfg)
  })

  afterAll(async () => {
    await sessionManager.closeAll()
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
    const blockedUser = await dropUser('adm-tsql', 'app_ro')
    expect(blockedUser.ok).toBe(false)
    expect(executed).toEqual([])

    await dropUser('adm-tsql', 'app_ro', true)
    expect(executed).toEqual(['DROP USER [app_ro];'])
    executed.length = 0
    const blockedRole = await dropRole('adm-tsql', 'db_reader')
    expect(blockedRole.ok).toBe(false)
    await dropRole('adm-tsql', 'db_reader', true)
    expect(executed).toEqual(['DROP ROLE [db_reader];'])
  })

  it('dropt een constraint via ALTER TABLE … DROP CONSTRAINT', async () => {
    const r = await dropConstraint('adm-tsql', 'db', 'dbo', 'klanten', 'CK_leeftijd', true)
    expect(r.ok).toBe(true)
    expect(executed).toEqual(['ALTER TABLE [dbo].[klanten] DROP CONSTRAINT [CK_leeftijd];'])
  })

  it('weigert dropRole op providers zonder supportsUsersAndRoles', async () => {
    // de sqlite-provider uit de eerste suite ondersteunt geen users/roles.
    await expect(dropRole('adm-1', 'x', true)).rejects.toThrow(/geen users\/roles/)
  })
})
