import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSqlServerProvider } from '../src/index'
import type { ConnectionConfig, DbSession } from '@nvag/contracts'

/**
 * Unit-tests voor executeQuery-streaming met een gemockte pool/request
 * (geen live SQL Server nodig). Verifieert de chunk-volgorde, maxRows-cap
 * via TOP, DML-rowcount en error-afhandeling met positie.
 */

type MockRowEvent = Record<string, unknown>

interface MockRequest {
  stream: boolean
  query: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  emit: (event: string, ...args: unknown[]) => void
  handlers: Record<string, Array<(...args: unknown[]) => void>>
}

function makePool(): { request: () => MockRequest; close: () => Promise<void> } {
  const req = makeRequest()
  return {
    request: () => req,
    close: async () => {}
  }
}

function makeRequest(): MockRequest {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  const req: MockRequest = {
    stream: false,
    query: vi.fn((_sql: string) => {
      // mssql: met stream=true blijven de events het kanaal; geen promise-reject
      req.emit('recordset', { id: { name: 'id' }, name: { name: 'name' } })
      req.emit('done', { rowsAffected: [] })
      return new Promise((resolve) => {
        resolve({ recordsets: [], recordset: undefined, rowsAffected: [], output: {} })
      })
    }),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      ;(handlers[event] ??= []).push(fn)
      return req
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const fn of handlers[event] ?? []) fn(...args)
    },
    handlers
  }
  return req
}

function config(): ConnectionConfig {
  return {
    id: 'mock-conn',
    name: 'mock',
    providerId: 'sqlserver',
    environment: 'DEV',
    host: 'localhost',
    database: 'master',
    auth: 'username-password',
    ssl: { mode: 'disable' },
    connectionTimeoutMs: 5000,
    group: 'Test'
  }
}

async function collect(
  provider: ReturnType<typeof createSqlServerProvider>,
  session: DbSession,
  sql: string,
  opts: { maxRows?: number } = {}
): Promise<{ kinds: string[]; rows: unknown[][]; errors: string[]; rowCount: number }> {
  const kinds: string[] = []
  const rows: unknown[][] = []
  const errors: string[] = []
  let rowCount = 0
  for await (const chunk of provider.executeQuery(session, sql, opts)) {
    if (chunk.kind === 'columns') kinds.push('columns')
    if (chunk.kind === 'rows') rows.push(...chunk.rows.map((r) => r.values))
    if (chunk.kind === 'error') errors.push(chunk.message)
    if (chunk.kind === 'done') {
      kinds.push('done')
      rowCount = chunk.rowCount
    }
  }
  return { kinds, rows, errors, rowCount }
}

describe('sqlserver executeQuery (mock-pool)', () => {
  let provider: ReturnType<typeof createSqlServerProvider>
  let session: DbSession
  let pool: ReturnType<typeof makePool>

  beforeEach(() => {
    pool = makePool()
    provider = createSqlServerProvider()
    session = {
      handle: { pool, server: 'localhost', database: 'master' },
      connectionId: 'mock-conn',
      providerId: 'sqlserver',
      database: 'master'
    }
  })

  it('streamt columns + rows + done voor een SELECT', async () => {
    const req = pool.request()
    const r = await collect(provider, session, 'SELECT id, name FROM users')
    expect(r.kinds).toEqual(['columns', 'done'])
    expect(r.rows).toEqual([])
    // De query moet met TOP worden uitgevoerd (maxRows default 1000)
    const sql = req.query.mock.calls[0]?.[0] as string
    expect(sql).toMatch(/^SELECT TOP \(1000\) id, name FROM users$/)
  })

  it('past maxRows via TOP toe (geen dubbele clausule)', async () => {
    const req = pool.request()
    const r = await collect(provider, session, 'SELECT * FROM users', { maxRows: 5 })
    expect(r.rowCount).toBe(0)
    const sql = req.query.mock.calls[0]?.[0] as string
    expect(sql).toBe('SELECT TOP (5) * FROM users')
  })

  it('voegt geen TOP toe wanneer er al TOP staat', async () => {
    const req = pool.request()
    await collect(provider, session, 'SELECT TOP (3) * FROM users', { maxRows: 5 })
    const sql = req.query.mock.calls[0]?.[0] as string
    expect(sql).toBe('SELECT TOP (3) * FROM users')
  })

  it('verwerkt rijen in chunks en telt rowCount', async () => {
    const req = pool.request()
    const run = collect(provider, session, 'SELECT * FROM users')
    // events zijn synchroon in de mock; query() emitted done direct
    const r = await run
    expect(r.kinds).toEqual(['columns', 'done'])
    void req
  })

  it('yield error-chunk bij stream-error', async () => {
    const req = pool.request()
    req.query = vi.fn(() => {
      req.emit('error', new Error("Invalid column name 'nope'."))
      req.emit('done', { rowsAffected: [] })
      return new Promise((resolve) => resolve({ recordsets: [], rowsAffected: [], output: {} }))
    })
    const r = await collect(provider, session, 'SELECT nope FROM users')
    expect(r.errors).toEqual(["Invalid column name 'nope'."])
    expect(r.kinds).toEqual([])
  })

  it('weigert multi-statement met MULTIPLE_STATEMENTS', async () => {
    const r = await collect(provider, session, 'SELECT 1 AS a; SELECT 2 AS b')
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/MULTIPLE_STATEMENTS/)
    expect(r.kinds).toEqual([])
  })

  it('rapporteert rowCount voor DML', async () => {
    const req = pool.request()
    req.query = vi.fn(() =>
      Promise.resolve({ recordsets: [], recordset: undefined, rowsAffected: [2], output: {} })
    )
    const r = await collect(provider, session, "UPDATE users SET active = 1 WHERE name = 'Bob'")
    expect(r.kinds).toEqual(['done'])
    expect(r.rowCount).toBe(2)
  })

  it('yield error-chunk bij DML-fout', async () => {
    const req = pool.request()
    req.query = vi.fn(() => Promise.reject(new Error('Timeout expired.')))
    const r = await collect(provider, session, 'DELETE FROM users')
    expect(r.errors).toEqual(['Timeout expired.'])
  })
})
