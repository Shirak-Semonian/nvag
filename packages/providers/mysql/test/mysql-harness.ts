/**
 * MySQL/MariaDB-harness voor @nvag/contract-tests.
 *
 * Draait alleen wanneer NVAG_TEST_MYSQL_URL (of NVAG_TEST_MYSQL_*) is gezet;
 * zonder server worden de contracttests overgeslagen.
 */

import type { ConnectionConfig } from '@nvag/contracts'
import type { ProviderContractHarness } from '@nvag/contract-tests'
import { createMySqlProvider } from '../src/index'

export interface MySqlTestConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
}

export function getMySqlTestConfig(): MySqlTestConfig | null {
  const url = process.env.NVAG_TEST_MYSQL_URL
  if (url) {
    try {
      const u = new URL(url)
      return {
        host: u.hostname,
        port: Number(u.port || 3306),
        database: u.pathname.replace(/^\//, '') || 'nvag_test',
        user: decodeURIComponent(u.username || 'root'),
        password: decodeURIComponent(u.password || '')
      }
    } catch {
      return null
    }
  }
  if (!process.env.NVAG_TEST_MYSQL_HOST) return null
  return {
    host: process.env.NVAG_TEST_MYSQL_HOST,
    port: Number(process.env.NVAG_TEST_MYSQL_PORT || 3306),
    database: process.env.NVAG_TEST_MYSQL_DB || 'nvag_test',
    user: process.env.NVAG_TEST_MYSQL_USER || 'root',
    password: process.env.NVAG_TEST_MYSQL_PASSWORD || ''
  }
}

export function createMySqlHarness(cfg: MySqlTestConfig): ProviderContractHarness {
  return {
    name: 'mysql',
    dialect: 'mysql',
    createProvider: () => createMySqlProvider(),
    createConfig: (): ConnectionConfig => ({
      id: 'contract-mysql',
      name: 'contract',
      providerId: 'mysql',
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
    fixtureSql: `
      CREATE TABLE contract_dml (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL
      );
      INSERT INTO contract_dml (name) VALUES ('a'), ('b'), ('c');
      CREATE TABLE contract_meta (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        email VARCHAR(200) UNIQUE,
        active INT DEFAULT 1
      );
      CREATE INDEX idx_contract_meta_name ON contract_meta(name);
      CREATE VIEW vw_contract_active AS SELECT id, name FROM contract_meta WHERE active = 1;
      INSERT INTO contract_meta (name, email, active) VALUES ('Alice', 'alice@x.nl', 1);
      INSERT INTO contract_meta (name, email, active) VALUES ('Bob', 'bob@x.nl', 0);
    `,
    quoteIdentifier: (name) => `\`${name.replace(/`/g, '``')}\``,
    dmlTable: 'contract_dml',
    metadataTable: 'contract_meta',
    metadataTableColumns: ['id', 'name', 'email', 'active'],
    makeLimitQuery: (table, n) => `SELECT * FROM \`${table}\` LIMIT ${n}`,
    multipleStatements: 'reject',
    skips: { errorPosition: true }
  }
}
