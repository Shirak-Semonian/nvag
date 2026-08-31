/**
 * Oracle-contracttests (env-gated op NVAG_TEST_ORACLE_URL).
 */

import { describe, expect, it } from 'vitest'
import { runProviderContractTests } from '@nvag/contract-tests'
import { createOracleProvider } from '../src/index'
import { createOracleHarness, getOracleTestConfig } from './oracle-harness'

describe('oracle provider', () => {
  it('exposeert dialect oracle en capabilities', () => {
    const p = createOracleProvider()
    expect(p.id).toBe('oracle')
    expect(p.capabilities.dialect).toBe('oracle')
    expect(p.defaultPort).toBe(1521)
  })

  const cfg = getOracleTestConfig()
  if (cfg) {
    runProviderContractTests(createOracleHarness(cfg), { enabled: true })
  }
})
