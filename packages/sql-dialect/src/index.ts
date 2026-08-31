/**
 * @nvag/sql-dialect — dialect-afhankelijke SQL-generatie.
 *
 * F0: basis voor SQLite (quoting, LIMIT, error-positie).
 * F1: uitbreiden met tsql/postgres/mysql/db2 + scripting.
 */

import type { ErrorPosition, SqlDialectId } from '@nvag/contracts'

export interface SqlDialect {
  id: SqlDialectId
  /** Identifier-quoting, bijv. "name" (ANSI) */
  quoteIdentifier(identifier: string): string
  /** LIMIT/TOP/FETCH clausule, leeg wanneer geen max. */
  buildLimit(maxRows?: number): string
  /** Parse provider-foutmelding naar regel/kolom, null wanneer onbekend. */
  parseErrorPosition(message: string): ErrorPosition | null
}

const DIALECTS: Record<SqlDialectId, SqlDialect> = {
  sqlite: {
    id: 'sqlite',
    quoteIdentifier: (id) => `"${id.replace(/"/g, '""')}"`,
    buildLimit: (maxRows) => (maxRows ? `LIMIT ${maxRows}` : ''),
    parseErrorPosition: (msg) => {
      // SQLite: near "SELEC": syntax error → kolom = index van het token + 1
      const m = /near "([^"]*)"/.exec(msg)
      if (m) {
        const idx = msg.indexOf(m[1])
        return idx >= 0 ? { line: 1, column: idx + 1 } : null
      }
      return null
    }
  },
  tsql: {
    id: 'tsql',
    quoteIdentifier: (id) => `[${id.replace(/]/g, ']]')}]`,
    buildLimit: (maxRows) => (maxRows ? `TOP ${maxRows}` : ''),
    parseErrorPosition: () => null // F1
  },
  postgres: {
    id: 'postgres',
    quoteIdentifier: (id) => `"${id.replace(/"/g, '""')}"`,
    buildLimit: (maxRows) => (maxRows ? `LIMIT ${maxRows}` : ''),
    parseErrorPosition: () => null // F1
  },
  mysql: {
    id: 'mysql',
    quoteIdentifier: (id) => `\`${id.replace(/`/g, '``')}\``,
    buildLimit: (maxRows) => (maxRows ? `LIMIT ${maxRows}` : ''),
    parseErrorPosition: () => null // F1
  },
  db2: {
    id: 'db2',
    quoteIdentifier: (id) => `"${id.replace(/"/g, '""')}"`,
    buildLimit: (maxRows) => (maxRows ? `FETCH FIRST ${maxRows} ROWS ONLY` : ''),
    parseErrorPosition: () => null // F1
  },
  oracle: {
    id: 'oracle',
    quoteIdentifier: (id) => `"${id.replace(/"/g, '""')}"`,
    buildLimit: (maxRows) => (maxRows ? `FETCH FIRST ${maxRows} ROWS ONLY` : ''),
    parseErrorPosition: () => null // F2
  },
  snowflake: {
    id: 'snowflake',
    quoteIdentifier: (id) => `"${id.replace(/"/g, '""')}"`,
    buildLimit: (maxRows) => (maxRows ? `LIMIT ${maxRows}` : ''),
    parseErrorPosition: () => null // F2
  }
}

export function getDialect(id: SqlDialectId): SqlDialect {
  return DIALECTS[id]
}

export function quoteIdentifier(dialect: SqlDialectId, identifier: string): string {
  return DIALECTS[dialect].quoteIdentifier(identifier)
}

export function buildLimit(dialect: SqlDialectId, maxRows?: number): string {
  return DIALECTS[dialect].buildLimit(maxRows)
}

export function wrapErrorPosition(
  dialect: SqlDialectId,
  message: string
): ErrorPosition | null {
  return DIALECTS[dialect].parseErrorPosition(message)
}

/** Genereer "SELECT * FROM <table>" met correcte quoting en optionele LIMIT. */
export function buildSelectStar(
  dialect: SqlDialectId,
  table: string,
  schema?: string,
  maxRows?: number
): string {
  const d = DIALECTS[dialect]
  const name = schema ? `${d.quoteIdentifier(schema)}.${d.quoteIdentifier(table)}` : d.quoteIdentifier(table)
  const limit = d.buildLimit(maxRows)
  return `SELECT * FROM ${name}${limit ? ` ${limit}` : ''}`
}
