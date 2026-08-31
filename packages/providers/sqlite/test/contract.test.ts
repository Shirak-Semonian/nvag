import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, afterAll } from 'vitest'
import type { ConnectionConfig, DbSession } from '@nvag/contracts'
import { runProviderContractTests } from '@nvag/contract-tests'
import { createSqliteProvider } from '../src/index'
import { cleanupSqliteHarness, sqliteHarness } from './sqlite-harness'

/**
 * Generieke contracttests (SAL-13) — dezelfde suite draait straks tegen
 * PG/MySQL/MSSQL/DB2 met een eigen harness.
 */
runProviderContractTests(sqliteHarness)

afterAll(() => {
  cleanupSqliteHarness()
})

// ---------------------------------------------------------------------------
// SQLite-specifieke tests (blijven naast de generieke suite bestaan)
// ---------------------------------------------------------------------------

describe('sqlite provider — specifiek', () => {
  let dir: string
  let dbPath: string
  let config: ConnectionConfig
  let provider: ReturnType<typeof createSqliteProvider>
  let session: DbSession

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nvag-sqlite-spec-'))
    dbPath = join(dir, 'test.db')
    writeFileSync(dbPath, '')
    config = {
      id: 'spec-conn',
      name: 'spec',
      providerId: 'sqlite',
      environment: 'DEV',
      host: dbPath,
      auth: 'username-password',
      ssl: { mode: 'disable' },
      connectionTimeoutMs: 5000,
      group: 'Spec'
    }
    provider = createSqliteProvider()
    session = await provider.connect(config)
    const db = (session.handle as { db: import('node:sqlite').DatabaseSync }).db
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        active INTEGER DEFAULT 1
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        total REAL
      );
      INSERT INTO users (name, email, active) VALUES ('Alice', 'alice@x.nl', 1);
      INSERT INTO users (name, email, active) VALUES ('Bob', 'bob@x.nl', 0);
      INSERT INTO orders (id, user_id, total) VALUES (1, 1, 99.5);
    `)
  })

  afterAll(async () => {
    if (session) await provider.close(session)
    rmSync(dir, { recursive: true, force: true })
  })

  it('connecteert en rapporteert identity-kolom in metadata', async () => {
    const meta = await provider.getTableMetadata(session, dbPath, 'main', 'users')
    expect(meta.columns.find((c) => c.name === 'id')?.isIdentity).toBe(true)
    expect(meta.columns.find((c) => c.name === 'name')?.nullable).toBe(false)
    expect(meta.indexes.map((i) => i.name)).toContain('sqlite_autoindex_users_1')
  })

  it('levert FK-info op orders', async () => {
    const meta = await provider.getTableMetadata(session, dbPath, 'main', 'orders')
    expect(meta.foreignKeys).toHaveLength(1)
    expect(meta.foreignKeys[0].referencedTable).toBe('users')
    expect(meta.foreignKeys[0].columns).toContain('user_id')
  })

  it('levert afhankelijkheden op users (used-by: orders via FK)', async () => {
    const meta = await provider.getTableMetadata(session, dbPath, 'main', 'users')
    const usedBy = meta.dependencies.filter((d) => d.direction === 'used-by')
    const dependsOn = meta.dependencies.filter((d) => d.direction === 'depends-on')
    expect(usedBy.map((d) => d.objectName)).toEqual(['orders'])
    expect(usedBy.map((d) => d.objectType)).toEqual(['table'])
    expect(dependsOn).toHaveLength(0)
  })

  it('levert afhankelijkheden op orders (depends-on: users)', async () => {
    const meta = await provider.getTableMetadata(session, dbPath, 'main', 'orders')
    const dependsOn = meta.dependencies.filter((d) => d.direction === 'depends-on')
    expect(dependsOn.map((d) => d.objectName)).toContain('users')
    expect(dependsOn.find((d) => d.objectName === 'users')?.objectType).toBe('table')
  })

  it('detecteert views die de tabel gebruiken als used-by', async () => {
    const db = (session.handle as { db: import('node:sqlite').DatabaseSync }).db
    db.exec(`CREATE VIEW vw_test_dep AS SELECT id, name FROM users WHERE active = 1`)
    try {
      const meta = await provider.getTableMetadata(session, dbPath, 'main', 'users')
      const usedBy = meta.dependencies.filter((d) => d.direction === 'used-by')
      expect(usedBy.map((d) => d.objectName)).toContain('vw_test_dep')
      expect(usedBy.find((d) => d.objectName === 'vw_test_dep')?.objectType).toBe('view')
    } finally {
      db.exec(`DROP VIEW vw_test_dep`)
    }
  })

  it('faalt op onbestaand pad', async () => {
    const bad = { ...config, host: join(dir, 'nope', 'x.db') }
    await expect(provider.connect(bad)).rejects.toThrow()
  })

  it('testConnection faalt op ongeldig bestand', async () => {
    const bad = { ...config, host: join(dir, 'nope', 'x.db') }
    const r = await provider.testConnection(bad)
    expect(r.ok).toBe(false)
  })

  it('levert objectdefinitie met CREATE TABLE', async () => {
    const def = await provider.getObjectDefinition(session, {
      type: 'table',
      database: dbPath,
      schema: 'main',
      name: 'users'
    })
    expect(def).toMatch(/CREATE TABLE/)
    expect(def).toMatch(/users/)
  })
})
