import { describe, expect, it } from 'vitest'
import { runProviderContractTests } from '@nvag/contract-tests'
import { createMySqlProvider } from '../src/index'
import { createMySqlHarness, ensureMySqlTestDb, getMySqlTestConfig } from './mysql-harness'

/**
 * Contracttests MySQL/MariaDB (SAL-15).
 * Draaien alleen wanneer NVAG_TEST_MYSQL_URL (of NVAG_TEST_MYSQL_*) is gezet
 * én de server bereikbaar is (testdatabase wordt zelf aangemaakt); anders
 * worden ze overgeslagen. Zie docker-compose.dev.yml → service `mysql`.
 */
const cfg = getMySqlTestConfig()
const enabled = cfg !== null ? await ensureMySqlTestDb(cfg) : false

runProviderContractTests(createMySqlHarness(cfg!), { enabled })

describe('mysql provider — specifiek', () => {
  it('testConnection faalt zonder server (config zonder verbinding)', async () => {
    const provider = createMySqlProvider()
    const r = await provider.testConnection({
      id: 'x',
      name: 'x',
      providerId: 'mysql',
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

  it('exposeert mysql-dialect en capabilities', () => {
    const provider = createMySqlProvider()
    expect(provider.id).toBe('mysql')
    expect(provider.capabilities.dialect).toBe('mysql')
    expect(provider.capabilities.supportsSchemas).toBe(false)
    expect(provider.capabilities.supportsIdentityColumns).toBe(true)
  })
})
