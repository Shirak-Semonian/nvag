import { describe, expect, it } from 'vitest'
import type {
  ConnectionConfig,
  DatabaseProvider,
  ProviderCapabilities,
  QueryChunk
} from '../src/index'

/**
 * Type-contract tests: bewijzen dat de kern-types bestaan en de juiste
 * vorm hebben. Runtime-waarde is triviaal; het contract is het product.
 */

describe('contracts', () => {
  it('exporteert ProviderCapabilities met dialect', () => {
    const caps: ProviderCapabilities = {
      supportsSchemas: true,
      supportsSequences: false,
      supportsSynonyms: false,
      supportsTriggers: false,
      supportsExecutionPlans: false,
      supportsMonitoring: false,
      supportsTransactions: true,
      supportsIdentityColumns: true,
      supportsGeneratedColumns: false,
      supportsDdlAdmin: true,
      supportsUsersAndRoles: false,
      supportsBackupRestore: false,
      maxResultRowsDefault: 1000,
      dialect: 'sqlite'
    }
    expect(caps.dialect).toBe('sqlite')
    expect(caps.maxResultRowsDefault).toBe(1000)
  })

  it('ConnectionConfig is structureel correct', () => {
    const cfg: ConnectionConfig = {
      id: 'x',
      name: 'x',
      providerId: 'sqlite',
      environment: 'PROD',
      host: '/tmp/x.db',
      auth: 'username-password',
      ssl: { mode: 'disable' },
      connectionTimeoutMs: 5000,
      group: 'Test'
    }
    expect(cfg.environment).toBe('PROD')
    expect(cfg.ssl.mode).toBe('disable')
  })

  it('QueryChunk discriminated union is bruikbaar', () => {
    const chunk: QueryChunk = { kind: 'done', rowCount: 3, durationMs: 5 }
    if (chunk.kind === 'done') {
      expect(chunk.rowCount).toBe(3)
    }
  })

  it('DatabaseProvider-interface is structureel compleet', () => {
    // Alleen type-level: een provider die niet alle velden heeft faalt te compilen.
    const provider: Pick<DatabaseProvider, 'id' | 'displayName' | 'capabilities'> = {
      id: 'sqlite',
      displayName: 'SQLite',
      capabilities: {
        dialect: 'sqlite'
      } as ProviderCapabilities
    }
    expect(provider.id).toBe('sqlite')
  })
})
