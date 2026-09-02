/**
 * Databricks-contracttests (env-gated op NVAG_TEST_DATABRICKS_URL).
 */

import { describe, expect, it } from 'vitest'
import { runProviderContractTests } from '@nvag/contract-tests'
import type { ConnectionConfig } from '@nvag/contracts'
import { createDatabricksProvider } from '../src/index'

function getConfig(): ConnectionConfig | null {
  const url = process.env.NVAG_TEST_DATABRICKS_URL
  if (!url) return null
  try {
    const u = new URL(url)
    const pathSegment = u.pathname.replace(/^\//, '').replace(/\/+$/, '')
    const httpPath = u.searchParams.get('httpPath') ?? undefined
    return {
      id: 'contract-databricks',
      name: 'contract',
      providerId: 'databricks',
      environment: 'TEST',
      host: u.hostname,
      port: Number(u.port || 443),
      username: '',
      auth: 'token',
      ssl: { mode: 'require' },
      connectionTimeoutMs: 15000,
      // SAL-39 (bevindingen 17–18): httpPath is verplicht voor de live-
      // verbinding en komt uit de query-parameter van de test-URL. Het
      // URL-pad is een *catalogus* (bv. /workspace op Unity Catalog);
      // '/default' is géén catalogus maar een schema binnen de catalogus →
      // database leeg laten, dan geldt de warehouse-defaultcatalogus.
      extraParams: httpPath ? { httpPath } : undefined,
      database: pathSegment && pathSegment !== 'default' ? pathSegment : '',
      group: 'Contract'
    }
  } catch {
    return null
  }
}

describe('databricks provider', () => {
  it('exposeert dialect databricks en capabilities', () => {
    const p = createDatabricksProvider()
    expect(p.id).toBe('databricks')
    expect(p.capabilities.dialect).toBe('databricks')
    expect(p.capabilities.supportsTransactions).toBe(false)
  })

  const cfg = getConfig()
  if (cfg) {
    runProviderContractTests(
      {
        name: 'databricks',
        dialect: 'databricks',
        createProvider: () => createDatabricksProvider(),
        createConfig: () => cfg,
        createSecret: () => {
          // Formaat: databricks://token@host:443/default — de token staat op
          // de gebruikerspositie in de URL (zie provider-docstring).
          const url = process.env.NVAG_TEST_DATABRICKS_URL
          const u = url ? new URL(url) : null
          return { token: u ? decodeURIComponent(u.username || '') : undefined }
        },
        fixtureSql: `
          CREATE TABLE IF NOT EXISTS contract_dml (id BIGINT, name STRING NOT NULL);
          INSERT INTO contract_dml VALUES (1, 'a'), (2, 'b'), (3, 'c');
          CREATE TABLE IF NOT EXISTS contract_meta (id BIGINT, name STRING NOT NULL, email STRING, active BOOLEAN);
          INSERT INTO contract_meta VALUES (1, 'Alice', 'alice@x.nl', TRUE), (2, 'Bob', 'bob@x.nl', FALSE);
        `,
        quoteIdentifier: (name) => `\`${name.replace(/`/g, '``')}\``,
        dmlTable: 'contract_dml',
        metadataTable: 'contract_meta',
        metadataTableColumns: ['id', 'name', 'email', 'active'],
        makeLimitQuery: (table, n) => `SELECT * FROM ${table} LIMIT ${n}`,
        schema: 'default',
        multipleStatements: 'reject',
        // SAL-39 (bevinding 20): objectdefinitie (SHOW CREATE TABLE) werkt
        // live — geen skip meer. Error-positie blijft niet-ondersteund.
        skips: { errorPosition: true }
      },
      { enabled: true }
    )
  }
})
