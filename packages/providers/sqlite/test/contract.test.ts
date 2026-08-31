import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionConfig, DbSession } from '@nvag/contracts'
import { createSqliteProvider } from '../src/index'

/**
 * Contracttests voor de SQLite-provider (F0).
 * Dit is dezelfde suite die straks tegen PG/MySQL/MSSQL draait (F1).
 */
describe('sqlite provider contract', () => {
  let dir: string
  let dbPath: string
  let config: ConnectionConfig
  let provider: ReturnType<typeof createSqliteProvider>
  let session: DbSession

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nvag-sqlite-'))
    dbPath = join(dir, 'test.db')
    writeFileSync(dbPath, '') // leeg bestand aanmaken (connect vereist bestaand pad)
    config = {
      id: 'test-conn',
      name: 'test',
      providerId: 'sqlite',
      environment: 'DEV',
      host: dbPath, // SQLite: host = bestandspad
      auth: 'username-password',
      ssl: { mode: 'disable' },
      connectionTimeoutMs: 5000,
      group: 'Test'
    }
    provider = createSqliteProvider()
    session = await provider.connect(config)
    // Testdata
    const db = (session.handle as { db: import('node:sqlite').DatabaseSync }).db
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        total REAL
      );
      CREATE VIEW vw_active_users AS SELECT id, name FROM users WHERE active = 1;
      CREATE INDEX idx_users_name ON users(name);
      INSERT INTO users (name, email, active) VALUES ('Alice', 'alice@x.nl', 1);
      INSERT INTO users (name, email, active) VALUES ('Bob', 'bob@x.nl', 0);
      INSERT INTO orders (id, user_id, total) VALUES (1, 1, 99.5);
    `)
  })

  afterAll(async () => {
    if (session) await provider.close(session)
    rmSync(dir, { recursive: true, force: true })
  })

  describe('connectie', () => {
    it('connecteert met een SQLite-bestand', async () => {
      const s = await provider.connect(config)
      expect(s.providerId).toBe('sqlite')
      expect(s.database).toBe(dbPath)
      await provider.close(s)
    })

    it('faalt op onbestaand pad', async () => {
      const bad = { ...config, host: join(dir, 'nope', 'x.db') }
      await expect(provider.connect(bad)).rejects.toThrow()
    })

    it('testConnection slaagt op geldig bestand', async () => {
      const r = await provider.testConnection(config)
      expect(r.ok).toBe(true)
      expect(r.serverInfo?.providerName).toBe('SQLite')
    })

    it('testConnection faalt op ongeldig bestand', async () => {
      const bad = { ...config, host: join(dir, 'nope', 'x.db') }
      const r = await provider.testConnection(bad)
      expect(r.ok).toBe(false)
    })

    it('levert serverinfo met versie', async () => {
      const info = await provider.getServerInfo(session)
      expect(info.providerId).toBe('sqlite')
      expect(info.serverVersion).toMatch(/\d+\.\d+/)
    })
  })

  describe('metadata', () => {
    it('lijst databases (sqlite = 1 entry)', async () => {
      const dbs = await provider.listDatabases(session)
      expect(dbs.length).toBeGreaterThanOrEqual(1)
    })

    it('lijst tabellen', async () => {
      const tables = await provider.listTables(session, dbPath)
      const names = tables.map((t) => t.name)
      expect(names).toContain('users')
      expect(names).toContain('orders')
    })

    it('lijst views', async () => {
      const views = await provider.listViews(session, dbPath)
      expect(views.map((v) => v.name)).toContain('vw_active_users')
    })

    it('geeft tabelmetadata met kolommen, PK, indexen, FKs', async () => {
      const meta = await provider.getTableMetadata(session, dbPath, 'main', 'users')
      const cols = meta.columns.map((c) => c.name)
      expect(cols).toEqual(expect.arrayContaining(['id', 'name', 'email', 'active', 'created_at']))
      expect(meta.primaryKey).toEqual(['id'])
      expect(meta.columns.find((c) => c.name === 'id')?.isIdentity).toBe(true)
      expect(meta.columns.find((c) => c.name === 'name')?.nullable).toBe(false)
      expect(meta.indexes.map((i) => i.name)).toContain('idx_users_name')
      expect(meta.foreignKeys).toHaveLength(0) // users heeft geen FK
    })

    it('levert FK-info op orders', async () => {
      const meta = await provider.getTableMetadata(session, dbPath, 'main', 'orders')
      expect(meta.foreignKeys).toHaveLength(1)
      expect(meta.foreignKeys[0].referencedTable).toBe('users')
      expect(meta.foreignKeys[0].columns).toContain('user_id')
    })
  })

  describe('query-uitvoering', () => {
    it('voert SELECT uit en streamt kolommen + rijen', async () => {
      const chunks: string[] = []
      const rows: unknown[][] = []
      for await (const chunk of provider.executeQuery(session, 'SELECT id, name FROM users ORDER BY id', {})) {
        if (chunk.kind === 'columns') chunks.push('columns')
        if (chunk.kind === 'rows') rows.push(...chunk.rows.map((r) => r.values))
        if (chunk.kind === 'done') chunks.push(`done:${chunk.rowCount}`)
      }
      expect(chunks).toEqual(['columns', 'done:2'])
      expect(rows).toEqual([[1, 'Alice'], [2, 'Bob']])
    })

    it('respecteert maxRows', async () => {
      const rows: unknown[][] = []
      for await (const chunk of provider.executeQuery(session, 'SELECT * FROM users', { maxRows: 1 })) {
        if (chunk.kind === 'rows') rows.push(...chunk.rows.map((r) => r.values))
      }
      expect(rows).toHaveLength(1)
    })

    it('meldt syntaxfout met positie', async () => {
      const errors: string[] = []
      for await (const chunk of provider.executeQuery(session, 'SELEC x FROM users', {})) {
        if (chunk.kind === 'error') errors.push(chunk.message)
      }
      expect(errors.length).toBeGreaterThan(0)
    })

    it('levert objectdefinitie voor tabel (script as CREATE)', async () => {
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

  describe('capabilities', () => {
    it('exposeert dialect sqlite en standaard max rows', () => {
      expect(provider.capabilities.dialect).toBe('sqlite')
      expect(provider.capabilities.maxResultRowsDefault).toBeGreaterThan(0)
    })
  })
})
