/**
 * Snowflake-contracttests (env-gated op NVAG_TEST_SNOWFLAKE_URL,
 * bijv. snowflake://user:pass@account/database?schema=PUBLIC).
 */

import { describe, expect, it } from 'vitest'
import { runProviderContractTests } from '@nvag/contract-tests'
import type { ConnectionConfig } from '@nvag/contracts'
import { createSnowflakeProvider } from '../src/index'

function getConfig(): ConnectionConfig | null {
  const url = process.env.NVAG_TEST_SNOWFLAKE_URL
  if (!url) return null
  try {
    const u = new URL(url)
    return {
      id: 'contract-snowflake',
      name: 'contract',
      providerId: 'snowflake',
      environment: 'TEST',
      host: u.hostname,
      username: decodeURIComponent(u.username || ''),
      auth: 'username-password',
      ssl: { mode: 'require' },
      connectionTimeoutMs: 15000,
      database: u.pathname.replace(/^\//, '') || undefined,
      group: 'Contract'
    }
  } catch {
    return null
  }
}

describe('snowflake provider', () => {
  it('exposeert dialect snowflake en capabilities', () => {
    const p = createSnowflakeProvider()
    expect(p.id).toBe('snowflake')
    expect(p.capabilities.dialect).toBe('snowflake')
  })

  const cfg = getConfig()
  if (cfg) {
    runProviderContractTests(
      {
        name: 'snowflake',
        dialect: 'snowflake',
        createProvider: () => createSnowflakeProvider(),
        createConfig: () => cfg,
        createSecret: () => {
          const url = process.env.NVAG_TEST_SNOWFLAKE_URL
          const u = url ? new URL(url) : null
          return { password: u ? decodeURIComponent(u.password || '') : undefined }
        },
        fixtureSql: `
          CREATE OR REPLACE TABLE contract_dml (id NUMBER AUTOINCREMENT, name VARCHAR(100) NOT NULL);
          INSERT INTO contract_dml (name) VALUES ('a'), ('b'), ('c');
          CREATE OR REPLACE TABLE contract_meta (id NUMBER AUTOINCREMENT, name VARCHAR(100) NOT NULL, email VARCHAR(255), active BOOLEAN DEFAULT TRUE);
          INSERT INTO contract_meta (name, email, active) VALUES ('Alice', 'alice@x.nl', TRUE), ('Bob', 'bob@x.nl', FALSE);
        `,
        quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
        dmlTable: 'contract_dml',
        metadataTable: 'contract_meta',
        metadataTableColumns: ['ID', 'NAME', 'EMAIL', 'ACTIVE'],
        makeLimitQuery: (table, n) => `SELECT * FROM ${table} LIMIT ${n}`,
        schema: 'PUBLIC',
        multipleStatements: 'reject',
        skips: { errorPosition: true, objectDefinition: true }
      },
      { enabled: true }
    )
  }
})
