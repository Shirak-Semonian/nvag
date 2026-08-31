/**
 * Azure-provider: hergebruikt de contract-tests van de mssql-provider via
 * de sqlserver-harness (env-gated op NVAG_TEST_MSSQL_URL).
 */

import { describe, it, expect } from 'vitest'
import { runProviderContractTests } from '@nvag/contract-tests'
import { createAzureProvider } from '../src/index'
import { createSqlServerHarness, getSqlServerTestConfig } from '../../sqlserver/test/sqlserver-harness'

const cfg = getSqlServerTestConfig()

describe('azure provider', () => {
  it('exposeert id azure en displayName Azure SQL / Synapse', () => {
    const p = createAzureProvider()
    expect(p.id).toBe('azure')
    expect(p.displayName).toBe('Azure SQL / Synapse')
    expect(p.capabilities.dialect).toBe('tsql')
  })

  if (cfg) {
    runProviderContractTests(createSqlServerHarness(cfg), { enabled: true })
  }
})
