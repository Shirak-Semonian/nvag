import { describe, expect, it } from 'vitest'
import { runProviderContractTests } from '../src/index'
import type { ProviderContractHarness } from '../src/index'

describe('@nvag/contract-tests exports', () => {
  it('exporteert runProviderContractTests als functie', () => {
    expect(typeof runProviderContractTests).toBe('function')
  })

  it('accepteert een minimale harness-definitie (type-check)', () => {
    const harness: ProviderContractHarness = {
      name: 'dummy',
      dialect: 'sqlite',
      createProvider: () => ({}) as never,
      createConfig: () => ({}) as never,
      fixtureSql: '',
      quoteIdentifier: (n) => n,
      dmlTable: 't',
      metadataTable: 'm',
      metadataTableColumns: ['id'],
      makeLimitQuery: (t, n) => `SELECT * FROM ${t} LIMIT ${n}`
    }
    expect(harness.name).toBe('dummy')
    expect(harness.makeLimitQuery('x', 2)).toContain('LIMIT 2')
  })
})
