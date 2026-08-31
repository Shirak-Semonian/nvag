import { describe, expect, it } from 'vitest'
import { runProviderContractTests } from '@nvag/contract-tests'
import { createSqlServerProvider } from '../src/index'
import { createSqlServerHarness, ensureSqlServerTestDb, getSqlServerTestConfig } from './sqlserver-harness'

/**
 * Contracttests SQL Server (SAL-14).
 * Draaien alleen wanneer NVAG_TEST_MSSQL_URL (of NVAG_TEST_MSSQL_*) is gezet
 * en de server bereikbaar is; anders worden ze overgeslagen.
 * Zie docker-compose.dev.yml → service `mssql`.
 */
const cfg = getSqlServerTestConfig()
const enabled = cfg !== null ? await ensureSqlServerTestDb(cfg) : false

runProviderContractTests(createSqlServerHarness(cfg!), { enabled })

describe('sqlserver provider — specifiek', () => {
  it('testConnection faalt zonder server (config zonder verbinding)', async () => {
    const provider = createSqlServerProvider()
    const r = await provider.testConnection({
      id: 'x',
      name: 'x',
      providerId: 'sqlserver',
      environment: 'TEST',
      host: '127.0.0.1',
      port: 1,
      database: 'nope',
      username: 'nope',
      auth: 'username-password',
      ssl: { mode: 'disable' },
      connectionTimeoutMs: 500,
      group: 'Test'
    })
    expect(r.ok).toBe(false)
  })

  it('exposeert tsql-dialect en capabilities', () => {
    const provider = createSqlServerProvider()
    expect(provider.id).toBe('sqlserver')
    expect(provider.capabilities.dialect).toBe('tsql')
    expect(provider.capabilities.supportsSchemas).toBe(true)
    expect(provider.capabilities.supportsSequences).toBe(true)
    expect(provider.capabilities.supportsIdentityColumns).toBe(true)
    expect(provider.defaultPort).toBe(1433)
  })
})
