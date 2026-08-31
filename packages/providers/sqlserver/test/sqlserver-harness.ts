/**
 * SQL Server-harness voor @nvag/contract-tests.
 *
 * Draait alleen wanneer NVAG_TEST_MSSQL_HOST (of NVAG_TEST_MSSQL_URL) is gezet;
 * zonder server worden de contracttests overgeslagen.
 * De testdatabase wordt aangemaakt wanneer die nog niet bestaat (idempotent).
 */

import sql from 'mssql'
import type { ConnectionConfig } from '@nvag/contracts'
import type { ProviderContractHarness } from '@nvag/contract-tests'
import { createSqlServerProvider } from '../src/index'

export interface SqlServerTestConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
}

export function getSqlServerTestConfig(): SqlServerTestConfig | null {
  const url = process.env.NVAG_TEST_MSSQL_URL
  if (url) {
    try {
      const u = new URL(url)
      return {
        host: u.hostname,
        port: Number(u.port || 1433),
        database: u.pathname.replace(/^\//, '') || 'nvag_test',
        user: decodeURIComponent(u.username || 'sa'),
        password: decodeURIComponent(u.password || '')
      }
    } catch {
      return null
    }
  }
  if (!process.env.NVAG_TEST_MSSQL_HOST) return null
  return {
    host: process.env.NVAG_TEST_MSSQL_HOST,
    port: Number(process.env.NVAG_TEST_MSSQL_PORT || 1433),
    database: process.env.NVAG_TEST_MSSQL_DB || 'nvag_test',
    user: process.env.NVAG_TEST_MSSQL_USER || 'sa',
    password: process.env.NVAG_TEST_MSSQL_PASSWORD || 'test-password'
  }
}

/**
 * Maakt de testdatabase aan wanneer die niet bestaat en geeft terug of de
 * server bereikbaar was. Wordt aangeroepen vóór de suite; zonder bereikbare
 * server retourneert het false (suite wordt geskipt).
 */
export async function ensureSqlServerTestDb(cfg: SqlServerTestConfig): Promise<boolean> {
  const pool = new sql.ConnectionPool({
    server: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: 'master',
    connectionTimeout: 5000,
    requestTimeout: 30000,
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
  })
  try {
    await pool.connect()
    const dbName = cfg.database.replace(/'/g, "''")
    await pool
      .request()
      .batch(`IF DB_ID(N'${dbName}') IS NULL EXEC('CREATE DATABASE [' + N'${dbName}' + ']')`)
    await pool.close()
    return true
  } catch {
    try {
      await pool.close()
    } catch {
      // negeren
    }
    return false
  }
}

export function createSqlServerHarness(cfg: SqlServerTestConfig): ProviderContractHarness {
  return {
    name: 'sqlserver',
    dialect: 'tsql',
    createProvider: () => createSqlServerProvider(),
    createConfig: (): ConnectionConfig => ({
      id: 'contract-mssql',
      name: 'contract',
      providerId: 'sqlserver',
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
        id INT IDENTITY(1,1) NOT NULL,
        name NVARCHAR(100) NOT NULL,
        CONSTRAINT PK_contract_dml PRIMARY KEY (id)
      );
      INSERT INTO contract_dml (name) VALUES (N'a'), (N'b'), (N'c');
      CREATE TABLE contract_meta (
        id INT IDENTITY(1,1) NOT NULL,
        name NVARCHAR(100) NOT NULL,
        email NVARCHAR(255) NULL,
        active BIT NOT NULL CONSTRAINT DF_contract_meta_active DEFAULT (1),
        CONSTRAINT PK_contract_meta PRIMARY KEY (id)
      );
      CREATE INDEX IX_contract_meta_name ON contract_meta(name);
      CREATE VIEW vw_contract_active AS SELECT id, name FROM contract_meta WHERE active = 1;
      INSERT INTO contract_meta (name, email, active) VALUES (N'Alice', N'alice@x.nl', 1);
      INSERT INTO contract_meta (name, email, active) VALUES (N'Bob', N'bob@x.nl', 0);
    `,
    quoteIdentifier: (name) => `[${name.replace(/\]/g, ']]')}]`,
    dmlTable: 'contract_dml',
    metadataTable: 'contract_meta',
    metadataTableColumns: ['id', 'name', 'email', 'active'],
    makeLimitQuery: (table, n) => `SELECT TOP (${n}) * FROM [${table}]`,
    schema: 'dbo',
    multipleStatements: 'reject',
    skips: { errorPosition: false }
  }
}
