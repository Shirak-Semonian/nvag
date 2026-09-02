/**
 * Db2-harness voor @nvag/contract-tests (F1-9, SAL-22).
 *
 * De suite draait alleen wanneer er een testserver beschikbaar is:
 *   NVAG_TEST_DB2_URL=jdbc:db2://user:***@host:50000/db  (of losse NVAG_TEST_DB2_* vars)
 * én de JDBC-bridge kan starten (java + jcc.jar). Zonder server wordt de
 * suite overgeslagen. Zie docker-compose.dev.yml → service `db2` en
 * src/bridge/README.md voor de jcc.jar.
 *
 * Fixture-namen zijn gequoted-lowercase (`"contract_dml"`) zodat de
 * `"x"`-quoting van het db2-dialect exact matcht; kolommen zijn unquoted en
 * worden door DB2 naar boven gevouwen (ID, NAME, ...).
 */

import type { ConnectionConfig } from '@nvag/contracts'
import type { ProviderContractHarness } from '@nvag/contract-tests'
import { createDb2Provider } from '../src/index'

export interface Db2TestConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
}

export function getDb2TestConfig(): Db2TestConfig | null {
  const url = process.env.NVAG_TEST_DB2_URL
  if (url) {
    try {
      const u = new URL(url.replace(/^jdbc:db2:\/\//i, 'postgres://'))
      return {
        host: u.hostname,
        port: Number(u.port || 50000),
        database: u.pathname.replace(/^\//, '').split(':')[0] || 'nvagdb',
        user: decodeURIComponent(u.username || 'db2inst1'),
        password: decodeURIComponent(u.password || '')
      }
    } catch {
      return null
    }
  }
  if (!process.env.NVAG_TEST_DB2_HOST) return null
  return {
    host: process.env.NVAG_TEST_DB2_HOST,
    port: Number(process.env.NVAG_TEST_DB2_PORT || 50000),
    database: process.env.NVAG_TEST_DB2_DB || 'nvagdb',
    user: process.env.NVAG_TEST_DB2_USER || 'db2inst1',
    password: process.env.NVAG_TEST_DB2_PASSWORD || 'test-password'
  }
}

export function createDb2Harness(cfg: Db2TestConfig, name = 'db2'): ProviderContractHarness {
  return {
    name,
    dialect: 'db2',
    createProvider: () => createDb2Provider(),
    createConfig: (): ConnectionConfig => ({
      id: 'contract-db2',
      name: 'contract',
      providerId: 'db2',
      environment: 'TEST',
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      username: cfg.user,
      auth: 'username-password',
      ssl: { mode: 'disable' },
      connectionTimeoutMs: 5000,
      group: 'Contract'
    }),
    createSecret: () => ({ password: cfg.password }),
    fixtureSql: `
      DROP TABLE IF EXISTS "contract_meta";
      DROP TABLE IF EXISTS "contract_dml";
      CREATE TABLE "contract_dml" (
        id INTEGER NOT NULL GENERATED ALWAYS AS IDENTITY,
        name VARCHAR(100) NOT NULL
      );
      INSERT INTO "contract_dml" (name) VALUES ('a'), ('b'), ('c');
      CREATE TABLE "contract_meta" (
        id INTEGER NOT NULL GENERATED ALWAYS AS IDENTITY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(255),
        amount DECIMAL(10,2),
        active INTEGER DEFAULT 1
      );
      CREATE INDEX ix_contract_meta_name ON "contract_meta" (name);
      CREATE OR REPLACE VIEW "vw_contract_active" AS SELECT id, name FROM "contract_meta" WHERE active = 1;
      INSERT INTO "contract_meta" (name, email, amount, active) VALUES ('Alice', 'alice@x.nl', 10.50, 1);
      INSERT INTO "contract_meta" (name, email, amount, active) VALUES ('Bob', 'bob@x.nl', 20.25, 0);
    `,
    quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
    dmlTable: 'contract_dml',
    metadataTable: 'contract_meta',
    metadataTableColumns: ['ID', 'NAME', 'EMAIL', 'AMOUNT', 'ACTIVE'],
    makeLimitQuery: (table, n) => `SELECT * FROM "${table}" FETCH FIRST ${n} ROWS ONLY`,
    // DB2-default-schema = verbindingsgebruiker (naar boven gevouwen).
    // cfg is null wanneer de suite overgeslagen wordt (dan wordt dit niet gebruikt).
    schema: (cfg?.user ?? '').toUpperCase(),
    multipleStatements: 'reject',
    // Error-positie is best-effort (SQLERRMC-token); pas na validatie tegen
    // een live server aanzetten — zie src/bridge/README.md.
    skips: { errorPosition: true, objectDefinition: false }
  }
}
