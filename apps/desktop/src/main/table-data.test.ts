/**
 * F2-1: Table Data Viewer/Editor — service-tests tegen een echte SQLite-db.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteProvider } from '@nvag/provider-sqlite'
import type { ConnectionConfig, DatabaseProvider, DbSession } from '@nvag/contracts'
import { getTableRows, editTableRow } from './table-data'
import { sessionManager } from './session-manager'
import { registry } from './registry'

let dir: string
let config: ConnectionConfig
let provider: DatabaseProvider
let session: DbSession

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nvag-table-data-'))
  const dbPath = join(dir, 'test.db')
  provider = createSqliteProvider()
  registry.register(provider)
  config = {
    id: 'conn-table-data',
    name: 'TableData Test',
    providerId: 'sqlite',
    environment: 'DEV',
    host: dbPath,
    auth: 'username-password',
    ssl: { mode: 'disable' },
    connectionTimeoutMs: 5000,
    createIfMissing: true,
    group: 'Test'
  }
  session = await provider.connect(config)
  for (const stmt of [
    'CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, naam TEXT NOT NULL, leeftijd INTEGER, actief INTEGER DEFAULT 1)',
    "INSERT INTO users (naam, leeftijd) VALUES ('Jan', 30), ('Piet', 40), ('Marie', 25)"
  ]) {
    for await (const chunk of provider.executeQuery(session, stmt, {})) {
      if (chunk.kind === 'error') throw new Error(chunk.message)
    }
  }
  await sessionManager.open(config)
})

afterAll(async () => {
  await provider.close(session)
  rmSync(dir, { recursive: true, force: true })
})

describe('F2-1 tableData service', () => {
  it('haalt rijen op met SELECT Top N en metadata (PK + bewerkbare kolommen)', async () => {
    const result = await getTableRows('conn-table-data', config.host, 'main', 'users', 10)
    expect(result.columns.map((c) => c.name)).toEqual(['id', 'naam', 'leeftijd', 'actief'])
    expect(result.rowCount).toBe(3)
    expect(result.primaryKey).toEqual(['id'])
    // identity-kolom is niet bewerkbaar.
    expect(result.editableColumns).not.toContain('id')
    expect(result.editableColumns).toContain('naam')
  })

  it('respecteert maxRows bij getRows', async () => {
    const result = await getTableRows('conn-table-data', config.host, 'main', 'users', 2)
    expect(result.rows).toHaveLength(2)
    expect(result.truncated).toBe(false)
  })

  it('voert een UPDATE uit op basis van de PK en retourneert de SQL', async () => {
    const result = await editTableRow({
      connectionId: 'conn-table-data',
      database: config.host,
      schema: 'main',
      table: 'users',
      kind: 'update',
      values: { leeftijd: 31 },
      pkValues: { id: 1 }
    })
    expect(result.rowCount).toBe(1)
    expect(result.sql).toContain('UPDATE')
    expect(result.sql).toContain('"leeftijd" = 31')
    expect(result.sql).toContain('"id" = 1')

    const check = await getTableRows('conn-table-data', config.host, 'main', 'users', 10)
    expect(check.rows.find((r) => r.values[0] === 1)?.values[2]).toBe(31)
  })

  it('voert een INSERT uit met correct gequotede waarden', async () => {
    const result = await editTableRow({
      connectionId: 'conn-table-data',
      database: config.host,
      schema: 'main',
      table: 'users',
      kind: 'insert',
      values: { naam: "D'Artagnan", leeftijd: 28 },
      pkValues: {}
    })
    expect(result.rowCount).toBe(1)
    expect(result.sql).toContain("'D''Artagnan'")

    const check = await getTableRows('conn-table-data', config.host, 'main', 'users', 10)
    expect(check.rowCount).toBe(4)
  })

  it('voert een DELETE uit op basis van de PK', async () => {
    const result = await editTableRow({
      connectionId: 'conn-table-data',
      database: config.host,
      schema: 'main',
      table: 'users',
      kind: 'delete',
      values: {},
      pkValues: { id: 4 }
    })
    expect(result.rowCount).toBe(1)
    expect(result.sql).toContain('DELETE')
    const check = await getTableRows('conn-table-data', config.host, 'main', 'users', 10)
    expect(check.rowCount).toBe(3)
  })

  it('blokkeert DELETE zonder PK-conditie niet onterecht (PK is de WHERE)', async () => {
    // DELETE met PK-where is veilig; de guard mag niet blokkeren.
    const result = await editTableRow({
      connectionId: 'conn-table-data',
      database: config.host,
      schema: 'main',
      table: 'users',
      kind: 'delete',
      values: {},
      pkValues: { id: 3 }
    })
    expect(result.blocked).toBeUndefined()
    expect(result.rowCount).toBe(1)
  })
})
