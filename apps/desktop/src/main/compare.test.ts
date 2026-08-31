/**
 * F3-3: Schema Compare + Data Compare met twee echte SQLite-sessies.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteProvider } from '@nvag/provider-sqlite'
import type { ConnectionConfig } from '@nvag/contracts'
import { compareSchemas, compareData, buildDeployScript } from './compare'
import { sessionManager } from './session-manager'
import { registry } from './registry'

let dir: string
const sourceCfg: ConnectionConfig = {
  id: 'cmp-source',
  name: 'Source',
  providerId: 'sqlite',
  environment: 'DEV',
  host: '',
  auth: 'username-password',
  ssl: { mode: 'disable' },
  connectionTimeoutMs: 5000,
  createIfMissing: true,
  group: 'Test'
}
const targetCfg: ConnectionConfig = {
  id: 'cmp-target',
  name: 'Target',
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
  dir = mkdtempSync(join(tmpdir(), 'nvag-cmp-'))
  const provider = createSqliteProvider()
  registry.register(provider)
  sourceCfg.host = join(dir, 'source.db')
  targetCfg.host = join(dir, 'target.db')
  await sessionManager.open(sourceCfg)
  await sessionManager.open(targetCfg)
  const sourceSession = sessionManager.getByConnectionId('cmp-source')!
  const targetSession = sessionManager.getByConnectionId('cmp-target')!
  // Bron: users + orders; doel: users zonder extra kolom en zonder orders.
  for (const stmt of [
    'CREATE TABLE users (id INTEGER PRIMARY KEY, naam TEXT NOT NULL, email TEXT)',
    "INSERT INTO users (naam, email) VALUES ('Jan', 'jan@x.nl'), ('Piet', 'piet@x.nl')",
    'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER, totaal REAL)',
    "INSERT INTO orders (user_id, totaal) VALUES (1, 10.5)"
  ]) {
    for await (const chunk of provider.executeQuery(sourceSession, stmt, {})) {
      if (chunk.kind === 'error') throw new Error(chunk.message)
    }
  }
  for (const stmt of [
    'CREATE TABLE users (id INTEGER PRIMARY KEY, naam TEXT NOT NULL)',
    "INSERT INTO users (naam) VALUES ('Jan')"
  ]) {
    for await (const chunk of provider.executeQuery(targetSession, stmt, {})) {
      if (chunk.kind === 'error') throw new Error(chunk.message)
    }
  }
})

afterAll(async () => {
  await sessionManager.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('F3-3 compare', () => {
  it('vindt ontbrekende tabellen en kolommen', async () => {
    const diff = await compareSchemas('cmp-source', 'main', 'cmp-target', 'main')
    expect(diff.tablesOnlyInSource).toContain('orders')
    const usersDiff = diff.columnDiffs.find((d) => d.table === 'users')
    expect(usersDiff?.missingInTarget).toContain('email')
    expect(diff.missingTables).toBe(1)
    expect(diff.missingColumns).toBe(1)
  })

  it('vergelijkt data (rijtellingen)', async () => {
    const r = await compareData('cmp-source', 'main', 'cmp-target', 'main', 'users')
    expect(r.sourceRowCount).toBe(2)
    expect(r.targetRowCount).toBe(1)
    expect(r.differs).toBe(true)
  })

  it('genereert een deployment-script (CREATE TABLE + ALTER TABLE)', async () => {
    const diff = await compareSchemas('cmp-source', 'main', 'cmp-target', 'main')
    const script = await buildDeployScript('cmp-source', 'main', 'cmp-target', 'main', diff)
    expect(script).toContain('CREATE TABLE')
    expect(script).toContain('orders')
    expect(script).toContain('ALTER TABLE "users" ADD "email"')
  })
})
