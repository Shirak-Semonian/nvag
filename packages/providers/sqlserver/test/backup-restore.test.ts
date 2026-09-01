import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createSqlServerProvider } from '../src/index'
import type { DbSession } from '@nvag/contracts'

/**
 * F4-2: SQL Server backup/restore — unit-tests met een gemockte pool/request
 * (geen live SQL Server nodig). Verifieert dat de juiste BACKUP/RESTORE-SQL
 * naar de pool gaat en dat fouten als `ok: false` terugkomen.
 */

interface MockRequest {
  query: ReturnType<typeof vi.fn>
}

function makePool(queryImpl?: (sql: string) => Promise<unknown>): {
  request: () => MockRequest
  close: () => Promise<void>
} {
  const req: MockRequest = {
    query: vi.fn(
      queryImpl ??
        (async () => ({ recordsets: [], recordset: undefined, rowsAffected: [], output: {} }))
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

describe('sqlserver backup/restore (F4-2, mock-pool)', () => {
  let provider: ReturnType<typeof createSqlServerProvider>

  beforeEach(() => {
    provider = createSqlServerProvider()
  })

  it('voert BACKUP DATABASE uit met DISK-path', async () => {
    const pool = makePool()
    const r = await provider.backupRestore!.backupDatabase!(
      sessionWithPool(pool),
      'SalesDB',
      '/tmp/sales.bak'
    )
    expect(r.ok).toBe(true)
    expect(r.sql).toBe("BACKUP DATABASE [SalesDB] TO DISK = '/tmp/sales.bak';")
    const sql = pool.request().query.mock.calls[0]?.[0] as string
    expect(sql).toBe("BACKUP DATABASE [SalesDB] TO DISK = '/tmp/sales.bak';")
  })

  it('voert RESTORE DATABASE uit met WITH REPLACE', async () => {
    const pool = makePool()
    const r = await provider.backupRestore!.restoreDatabase!(
      sessionWithPool(pool),
      'SalesDB',
      '/tmp/sales.bak'
    )
    expect(r.ok).toBe(true)
    expect(r.sql).toBe("RESTORE DATABASE [SalesDB] FROM DISK = '/tmp/sales.bak' WITH REPLACE;")
  })

  it('rapporteert een backup-fout als ok:false met melding', async () => {
    const pool = makePool(async () => {
      throw new Error('Cannot open backup device')
    })
    const r = await provider.backupRestore!.backupDatabase!(
      sessionWithPool(pool),
      'SalesDB',
      '/tmp/x.bak'
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Cannot open backup device')
    expect(r.targetPath).toBe('/tmp/x.bak')
  })

  it('rapporteert een restore-fout als ok:false met melding', async () => {
    const pool = makePool(async () => {
      throw new Error('Database is in use')
    })
    const r = await provider.backupRestore!.restoreDatabase!(
      sessionWithPool(pool),
      'SalesDB',
      '/tmp/x.bak'
    )
    expect(r.ok).toBe(false)
    expect(r.message).toContain('Database is in use')
    expect(r.sourcePath).toBe('/tmp/x.bak')
  })
})
