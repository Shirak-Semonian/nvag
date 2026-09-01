import { describe, expect, it } from 'vitest'
import { runProviderContractTests } from '@nvag/contract-tests'
import { createPostgresProvider } from '../src/index'
import { createPgHarness, ensurePgTestDb, getPgTestConfig } from './postgres-harness'

/**
 * Contracttests PostgreSQL (SAL-15).
 * Draaien alleen wanneer NVAG_TEST_PG_URL (of NVAG_TEST_PG_*) is gezet én de
 * server bereikbaar is (testdatabase wordt zelf aangemaakt); anders worden ze
 * overgeslagen. Zie docker-compose.dev.yml → service `postgres`.
 */
const cfg = getPgTestConfig()
const enabled = cfg !== null ? await ensurePgTestDb(cfg) : false

runProviderContractTests(createPgHarness(cfg!), { enabled })

describe('postgresql provider — specifiek', () => {
  it('testConnection faalt zonder server (config zonder verbinding)', async () => {
    const provider = createPostgresProvider()
    const r = await provider.testConnection({
      id: 'x',
      name: 'x',
      providerId: 'postgresql',
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

  it('exposeert postgres-dialect en capabilities', () => {
    const provider = createPostgresProvider()
    expect(provider.id).toBe('postgresql')
    expect(provider.capabilities.dialect).toBe('postgres')
    expect(provider.capabilities.supportsSchemas).toBe(true)
    expect(provider.capabilities.supportsSequences).toBe(true)
  })
})
