/**
 * Databricks-provider unit-tests (geen live-server nodig): fake-sessie die
 * alleen executeStatement/fetchAll simuleert. Deekt SAL-39-bevindingen 16
 * (listTables-kolom) en 19 (geen LIMIT achter SHOW/DESCRIBE) deterministisch.
 */

import { describe, expect, it } from 'vitest'
import type { DbSession, QueryChunk } from '@nvag/contracts'
import { createDatabricksProvider } from '../src/index'

interface FakeResult {
  columns?: string[]
  rows: Record<string, unknown>[]
}

function makeSession(handler: (sql: string) => Promise<FakeResult>): DbSession {
  const session = {
    executeStatement: async (sql: string) => {
      const res = await handler(sql)
      return {
        getSchema: async () => ({
          columns: (res.columns ?? []).map((columnName) => ({ columnName }))
        }),
        fetchAll: async () => res.rows,
        close: async () => {}
      }
    },
    close: async () => {}
  }
  return {
    handle: { client: {}, session },
    connectionId: 'unit-databricks',
    providerId: 'databricks',
    database: 'workspace'
  } as unknown as DbSession
}

async function collect(iter: AsyncIterable<QueryChunk>): Promise<QueryChunk[]> {
  const chunks: QueryChunk[] = []
  for await (const c of iter) chunks.push(c)
  return chunks
}

describe('databricks listTables', () => {
  it('leest de tabelnaam uit de tableName-kolom (niet isTemporary)', async () => {
    const provider = createDatabricksProvider()
    const session = makeSession(async () => ({
      rows: [
        { database: 'workspace', tableName: 'contract_dml', isTemporary: false },
        { database: 'workspace', tableName: 'contract_meta', isTemporary: false }
      ]
    }))
    const tables = await provider.listTables(session, 'workspace', 'default')
    expect(tables.map((t) => t.name)).toEqual(['contract_dml', 'contract_meta'])
  })

  it('valt terug op kolom-index 1 wanneer tableName ontbreekt', async () => {
    const provider = createDatabricksProvider()
    const session = makeSession(async () => ({
      rows: [{ a: 'workspace', b: 'contract_meta', c: false }]
    }))
    const tables = await provider.listTables(session, 'workspace', 'default')
    expect(tables.map((t) => t.name)).toEqual(['contract_meta'])
  })
})

describe('databricks executeQuery LIMIT-beleid (SAL-39)', () => {
  it('plakt LIMIT achter SELECT wanneer maxRows actief is', async () => {
    let executed = ''
    const provider = createDatabricksProvider()
    const session = makeSession(async (sql) => {
      executed = sql
      return { columns: ['id'], rows: [{ id: 1 }, { id: 2 }] }
    })
    const chunks = await collect(
      provider.executeQuery(session, 'SELECT id FROM contract_dml', { maxRows: 1 })
    )
    expect(executed).toBe('SELECT id FROM contract_dml LIMIT 1')
    expect(chunks.some((c) => c.kind === 'error')).toBe(false)
  })

  it('respecteert een eigen LIMIT (geen dubbele clausule)', async () => {
    let executed = ''
    const provider = createDatabricksProvider()
    const session = makeSession(async (sql) => {
      executed = sql
      return { columns: ['id'], rows: [{ id: 1 }, { id: 2 }] }
    })
    const chunks = await collect(
      provider.executeQuery(session, 'SELECT id FROM contract_dml LIMIT 2', {})
    )
    expect(executed).toBe('SELECT id FROM contract_dml LIMIT 2')
    expect(chunks.some((c) => c.kind === 'error')).toBe(false)
  })

  it.each([
    'SHOW CATALOGS',
    'SHOW SCHEMAS',
    'SHOW DATABASES',
    'SHOW TABLES IN `default`',
    'DESCRIBE contract_meta',
    'DESC contract_meta'
  ])('plakt geen LIMIT achter %s en streamt het resultaat', async (sql) => {
    let executed = ''
    const provider = createDatabricksProvider()
    const session = makeSession(async (q) => {
      executed = q
      return { columns: ['col'], rows: [{ col: 'x' }] }
    })
    const chunks = await collect(provider.executeQuery(session, sql, { maxRows: 1000 }))
    expect(executed).toBe(sql)
    expect(chunks.some((c) => c.kind === 'columns')).toBe(true)
    expect(chunks.some((c) => c.kind === 'rows')).toBe(true)
    expect(chunks.some((c) => c.kind === 'error')).toBe(false)
  })
})
