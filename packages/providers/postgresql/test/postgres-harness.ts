/**
 * PostgreSQL-harness voor @nvag/contract-tests.
 *
 * De suite draait alleen wanneer er een testserver beschikbaar is:
 *   NVAG_TEST_PG_URL=postgres://user:pass@host:5432/db  (of losse NVAG_TEST_PG_* vars)
 * Zonder server worden de contracttests overgeslagen.
 */

import { Client } from 'pg'
import type { ConnectionConfig } from '@nvag/contracts'
import type { ProviderContractHarness } from '@nvag/contract-tests'
import { createPostgresProvider } from '../src/index'

export interface PgTestConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
}

export function getPgTestConfig(): PgTestConfig | null {
  const url = process.env.NVAG_TEST_PG_URL
  if (url) {
    try {
      const u = new URL(url)
      return {
        host: u.hostname,
        port: Number(u.port || 5432),
        database: u.pathname.replace(/^\//, '') || 'postgres',
        user: decodeURIComponent(u.username || 'postgres'),
        password: decodeURIComponent(u.password || '')
      }
    } catch {
      return null
    }
  }
  if (!process.env.NVAG_TEST_PG_HOST) return null
  return {
    host: process.env.NVAG_TEST_PG_HOST,
    port: Number(process.env.NVAG_TEST_PG_PORT || 5432),
    database: process.env.NVAG_TEST_PG_DB || 'nvag_test',
    user: process.env.NVAG_TEST_PG_USER || 'postgres',
    password: process.env.NVAG_TEST_PG_PASSWORD || ''
  }
}

/**
 * Maakt de testdatabase aan wanneer die nog niet bestaat en geeft terug of de
 * server bereikbaar was. Wordt vóór de suite aangeroepen; zonder bereikbare
 * server retourneert het false (suite wordt geskipt). Spiegelt de aanpak van
 * de SQL Server-harness (SAL-35: live-runs tegen docker-compose.dev.yml).
 */
export async function ensurePgTestDb(cfg: PgTestConfig): Promise<boolean> {
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    database: 'postgres',
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: 5000
  })
  try {
    await client.connect()
    const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [cfg.database])
    if ((r.rowCount ?? 0) === 0) {
      await client.query(`CREATE DATABASE "${cfg.database.replace(/"/g, '""')}"`)
    }
    await client.end()
    return true
  } catch {
    try {
      await client.end()
    } catch {
      // negeren
    }
    return false
  }
}

export function createPgHarness(cfg: PgTestConfig): ProviderContractHarness {
  return {
    name: 'postgresql',
    dialect: 'postgres',
    createProvider: () => createPostgresProvider(),
    createConfig: (): ConnectionConfig => ({
      id: 'contract-pg',
      name: 'contract',
      providerId: 'postgresql',
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
      DROP VIEW IF EXISTS vw_contract_active;
      DROP TABLE IF EXISTS contract_meta;
      DROP TABLE IF EXISTS contract_dml;
      CREATE TABLE contract_dml (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO contract_dml (name) VALUES ('a'), ('b'), ('c');
      CREATE TABLE contract_meta (
        id SERIAL PRIMARY KEY,
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
    schema: 'public',
    multipleStatements: 'reject',
    skips: { errorPosition: false }
  }
}
