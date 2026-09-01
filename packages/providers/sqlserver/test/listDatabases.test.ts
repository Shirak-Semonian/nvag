import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSqlServerProvider } from '../src/index'
import type { DbSession } from '@nvag/contracts'

/**
 * SAL-31: unit-test voor listDatabases met een gemockte pool/request
 * (geen live SQL Server nodig). Verifieert dat de query de grootte uit
 * sys.master_files haalt (sys.databases heeft geen `size`-kolom — de
 * oorsprong van "Invalid column name 'size'") en dat het contract
 * (name, sizeBytes, status) correct wordt gevuld.
 */

interface MockRequest {
  query: ReturnType<typeof vi.fn>
}

function makePool(queryImpl?: (sql: string) => Promise<{ recordset: unknown[] }>): {
  request: () => MockRequest
  close: () => Promise<void>
} {
  const req: MockRequest = {
    query: vi.fn(
      queryImpl ??
        (async () => ({ recordsets: [], recordset: [], rowsAffected: [], output: {} }))
    )
  }
  return {
    request: () => req,
    close: async () => {}
  }
}

function sessionWithPool(pool: ReturnType<typeof makePool>): DbSession {
  return {
    handle: { pool, server: 'localhost', database: 'master' },
    connectionId: 'mock-conn',
    providerId: 'sqlserver',
    database: 'master'
  }
}

describe('sqlserver listDatabases (SAL-31, mock-pool)', () => {
  let provider: ReturnType<typeof createSqlServerProvider>

  beforeEach(() => {
    provider = createSqlServerProvider()
  })

  it('haalt de grootte uit sys.master_files (LEFT JOIN) i.p.v. sys.databases.size', async () => {
    const pool = makePool()
    await provider.listDatabases(sessionWithPool(pool))
    const sql = pool.request().query.mock.calls[0]?.[0] as string

    // de oude bug: `SELECT ... SUM(size) ... FROM sys.databases`
    expect(sql).not.toMatch(/FROM\s+sys\.databases\s+GROUP/)
    expect(sql).not.toMatch(/sys\.databases[^)]*\.size/)
    // de fix: join met sys.master_files + som over alle bestanden
    expect(sql).toMatch(/sys\.master_files/)
    expect(sql).toMatch(/LEFT\s+JOIN\s+sys\.master_files\s+mf\s+ON\s+mf\.database_id\s*=\s*d\.database_id/)
    expect(sql).toMatch(/SUM\(mf\.size\)/)
    expect(sql).toMatch(/GROUP\s+BY\s+d\.name,\s*d\.state_desc/)
  })

  it('mappt rijen naar DatabaseInfo met name, sizeBytes (number) en status', async () => {
    const pool = makePool(async () => ({
      recordset: [
        // tedious geeft bigint terug als JS-bigint; de map moet dat coërceren
        { name: 'master', size: 4194304n, status: 'ONLINE' },
        { name: 'model', size: 8388608n, status: 'ONLINE' },
        // een database zonder bestandsrijen (LEFT JOIN → NULL) → sizeBytes 0
        { name: 'offline_db', size: null, status: 'OFFLINE' }
      ]
    }))
    const dbs = await provider.listDatabases(sessionWithPool(pool))

    expect(dbs).toEqual([
      { name: 'master', sizeBytes: 4194304, status: 'ONLINE' },
      { name: 'model', sizeBytes: 8388608, status: 'ONLINE' },
      { name: 'offline_db', sizeBytes: 0, status: 'OFFLINE' }
    ])
    expect(typeof dbs[0]!.sizeBytes).toBe('number')
  })
})
