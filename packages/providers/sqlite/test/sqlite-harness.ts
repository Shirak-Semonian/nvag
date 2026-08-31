/**
 * SQLite-harness voor @nvag/contract-tests (SAL-13).
 * Draait dezelfde generieke suite die straks ook PG/MySQL/MSSQL/DB2 gebruiken.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionConfig } from '@nvag/contracts'
import type { ProviderContractHarness } from '@nvag/contract-tests'
import { createSqliteProvider } from '../src/index'

let dir: string
let dbPath: string

export const sqliteHarness: ProviderContractHarness = {
  name: 'sqlite',
  dialect: 'sqlite',
  createProvider: () => createSqliteProvider(),
  createConfig: (): ConnectionConfig => {
    dir = mkdtempSync(join(tmpdir(), 'nvag-contract-sqlite-'))
    dbPath = join(dir, 'contract.db')
    writeFileSync(dbPath, '')
    return {
      id: 'contract-conn',
      name: 'contract',
      providerId: 'sqlite',
      environment: 'DEV',
      host: dbPath,
      auth: 'username-password',
      ssl: { mode: 'disable' },
      connectionTimeoutMs: 5000,
      group: 'Contract'
    }
  },
  fixtureSql: `
    CREATE TABLE contract_dml (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    INSERT INTO contract_dml (name) VALUES ('a'), ('b'), ('c');
    CREATE TABLE contract_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      active INTEGER DEFAULT 1
    );
    CREATE INDEX idx_contract_meta_name ON contract_meta(name);
    CREATE VIEW vw_contract_active AS SELECT id, name FROM contract_meta WHERE active = 1;
    INSERT INTO contract_meta (name, email, active) VALUES ('Alice', 'alice@x.nl', 1);
    INSERT INTO contract_meta (name, email, active) VALUES ('Bob', 'bob@x.nl', 0);
  `,
  quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
  dmlTable: 'contract_dml',
  metadataTable: 'contract_meta',
  metadataTableColumns: ['id', 'name', 'email', 'active'],
  makeLimitQuery: (table, n) => `SELECT * FROM "${table}" LIMIT ${n}`,
  multipleStatements: 'reject'
}

export function cleanupSqliteHarness(): void {
  if (dir) rmSync(dir, { recursive: true, force: true })
}
