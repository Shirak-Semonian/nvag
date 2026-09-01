/**
 * F2-3: Database Administration — environment-safety guard-flow
 * (warn-doorloop buiten PROD, confirm-blokkade + bevestiging).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteProvider } from '@nvag/provider-sqlite'
import type { ConnectionConfig, Environment } from '@nvag/contracts'
import { createTable, dropTable } from './database-admin'
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
