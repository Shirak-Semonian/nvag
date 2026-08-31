/**
 * @nvag/sql-dialect — dialect-afhankelijke SQL-generatie.
 *
 * F0: SQLite volledig (quoting, LIMIT/OFFSET, error-positie in de SQL).
 * F1: tsql/postgres/mysql/db2/oracle/snowflake — LIMIT/OFFSET-idioms en
 *     quoting zijn aanwezig; parseErrorPosition per dialect volgt.
 * F2: scripting (meerstatement-scripts splitsen/uitvoeren).
 */

import type { ErrorPosition, SqlDialectId } from '@nvag/contracts'

export interface SqlDialect {
  id: SqlDialectId
  /** Identifier-quoting, bijv. "name" (ANSI) of [name] (T-SQL). */
  quoteIdentifier(identifier: string): string
  /** Schema + object beiden gequoted; zonder schema alleen object. */
  quoteQualifiedName(schema: string | null | undefined, object: string): string
  /** String-literal quoten (embedded quote wordt verdubbeld). */
  quoteLiteral(value: string): string
  /**
   * LIMIT/TOP/FETCH-clausule, leeg wanneer geen max.
   * `offset` is optioneel; per dialect worden de juiste idioms gebruikt
   * (bv. SQLite `LIMIT -1 OFFSET m` bij offset-only).
   */
  buildLimit(maxRows?: number, offset?: number): string
  /**
   * Parse provider-foutmelding naar regel/kolom.
   * Zonder `sql` wordt de positie binnen de melding bepaald (legacy);
   * met `sql` wordt het token teruggezocht in de uitgevoerde SQL.
   */
  parseErrorPosition(message: string, sql?: string): ErrorPosition | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertValidIdentifier(identifier: string): void {
  if (identifier.length === 0) {
    throw new Error('Identifier mag niet leeg zijn.')
  }
  if (/[\u0000-\u001f]/.test(identifier)) {
    throw new Error('Identifier bevat controle-tekens.')
  }
}

function quoteIdent(open: string, close: string, identifier: string): string {
  assertValidIdentifier(identifier)
  // Escape de quote die de identifier *beëindigt*: voor tsql is dat `]`,
  // voor de rest is open === close.
  const escaped = identifier.split(close).join(close + close)
  return open + escaped + close
}

function quoteLit(q: string, value: string): string {
  return q + value.split(q).join(q + q) + q
}

function normalizeLimit(
  maxRows?: number,
  offset?: number
): { maxRows: number | null; offset: number | null } {
  const m = maxRows === undefined || maxRows === null ? null : maxRows
  const o = offset === undefined || offset === null ? null : offset
  if (m !== null && (!Number.isInteger(m) || m < 0)) {
    throw new Error(`maxRows moet een niet-negatief geheel getal zijn, kreeg: ${m}`)
  }
  if (o !== null && (!Number.isInteger(o) || o < 0)) {
    throw new Error(`offset moet een niet-negatief geheel getal zijn, kreeg: ${o}`)
  }
  return { maxRows: m, offset: o }
}

// ---------------------------------------------------------------------------
// Error-positie (SQLite)
// ---------------------------------------------------------------------------

function isQuoteChar(ch: string): boolean {
  return ch === "'" || ch === '"' || ch === '`'
}

function stripSurroundingQuotes(name: string): string {
  if (name.length >= 2 && isQuoteChar(name[0] ?? '') && name[name.length - 1] === name[0]) {
    return name.slice(1, -1)
  }
  return name
}

function offsetToLineColumn(sql: string, offset: number): { line: number; column: number } {
  const safe = Math.max(0, Math.min(offset, sql.length))
  let line = 1
  let lineStart = 0
  for (let i = 0; i < safe; i++) {
    if (sql.charCodeAt(i) === 10 /* \n */) {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: safe - lineStart + 1 }
}

interface LocateOptions {
  quoted: boolean
  last?: boolean
}

function locateToken(
  sql: string,
  token: string,
  options: LocateOptions
): { line: number; column: number } | null {
  if (token.length === 0 || sql.length === 0) return null

  const indices = options.quoted ? findLiteral(sql, token) : findIdentifierAll(sql, token)
  if (indices.length === 0) return null

  const rawIndex = options.last ? indices[indices.length - 1]! : indices[0]!
  return offsetToLineColumn(sql, rawIndex)
}

function findLiteral(sql: string, literal: string): number[] {
  const out: number[] = []
  let from = 0
  for (;;) {
    const idx = sql.indexOf(literal, from)
    if (idx < 0) break
    out.push(idx)
    from = idx + literal.length
  }
  return out
}

function findIdentifierAll(sql: string, name: string): number[] {
  const sensitive = findIdentifierCase(sql, name, false)
  if (sensitive.length > 0) return sensitive
  return findIdentifierCase(sql, name, true)
}

function findIdentifierCase(sql: string, name: string, insensitive: boolean): number[] {
  const hay = insensitive ? sql.toUpperCase() : sql
  const needle = insensitive ? name.toUpperCase() : name
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${escapeRegExp(needle)}(?=$|[^A-Za-z0-9_$])`, 'g')
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(hay)) !== null) {
    const prefix = m[1] ?? ''
    const idx = m.index + prefix.length
    if (!insideStringOrComment(sql, idx)) out.push(idx)
  }
  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Heuristiek: ligt `index` binnen een string-literal of commentaar? */
function insideStringOrComment(sql: string, index: number): boolean {
  let i = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false
  while (i < index) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      i++
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inSingle) {
      if (ch === "'") {
        if (next === "'") {
          i += 2
        } else {
          inSingle = false
          i++
        }
      } else {
        i++
      }
      continue
    }
    if (inDouble) {
      if (ch === '"') {
        if (next === '"') {
          i += 2
        } else {
          inDouble = false
          i++
        }
      } else {
        i++
      }
      continue
    }
    if (inBacktick) {
      if (ch === '`') {
        if (next === '`') {
          i += 2
        } else {
          inBacktick = false
          i++
        }
      } else {
        i++
      }
      continue
    }
    if (ch === '-' && next === '-') {
      inLineComment = true
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i += 2
      continue
    }
    if (ch === "'") {
      inSingle = true
      i++
      continue
    }
    if (ch === '"') {
      inDouble = true
      i++
      continue
    }
    if (ch === '`') {
      inBacktick = true
      i++
      continue
    }
    i++
  }
  return inSingle || inDouble || inBacktick || inLineComment || inBlockComment
}

/**
 * Extraheer de foutpositie uit een SQLite-foutmelding, teruggezocht in de
 * uitgevoerde SQL. Ondersteunde patronen: `near "TOKEN"`, `unrecognized
 * token`, `no such column/table/function/index`, `table X has no column
 * named Y`, `duplicate column name` (laatste occurrence), `ambiguous column
 * name`, `incomplete input`. Retourneert null wanneer de positie niet
 * bepaald kan worden.
 */
function parseSqliteErrorPosition(
  sql: string,
  message: string
): { line: number; column: number } | null {
  if (typeof sql !== 'string' || typeof message !== 'string') return null
  const trimmed = message.trim()

  const nearMatch = /^near\s+"(.*)":/i.exec(trimmed)
  if (nearMatch) {
    return locateToken(sql, nearMatch[1] ?? '', { quoted: false })
  }

  const tokenMatch = /^unrecognized\s+token:\s+"(.*)"$/i.exec(trimmed)
  if (tokenMatch) {
    const token = tokenMatch[1] ?? ''
    return locateToken(sql, token, { quoted: token.length > 0 && isQuoteChar(token[0] ?? '') })
  }

  const noSuchMatch = /^no\s+such\s+(?:column|table|function|index|collation):\s+(\S+)/i.exec(
    trimmed
  )
  if (noSuchMatch) {
    const name = stripSurroundingQuotes(noSuchMatch[1] ?? '')
    const bare = locateToken(sql, name, { quoted: false })
    if (bare) return bare
    return locateToken(sql, `"${name}"`, { quoted: true })
  }

  const hasNoColumn = /has\s+no\s+column\s+named\s+(\S+)/i.exec(trimmed)
  if (hasNoColumn) {
    return locateToken(sql, stripSurroundingQuotes(hasNoColumn[1] ?? ''), { quoted: false })
  }

  const duplicateMatch = /^duplicate\s+column\s+name:\s+(\S+)/i.exec(trimmed)
  if (duplicateMatch) {
    return locateToken(sql, stripSurroundingQuotes(duplicateMatch[1] ?? ''), {
      quoted: false,
      last: true
    })
  }

  const namedMatch = /^(?:ambiguous\s+column\s+name|misuse\s+of\s+aggregate):\s+(\S+)/i.exec(
    trimmed
  )
  if (namedMatch) {
    return locateToken(sql, stripSurroundingQuotes(namedMatch[1] ?? ''), { quoted: false })
  }

  if (/^incomplete\s+input/i.test(trimmed) && sql.length > 0) {
    return offsetToLineColumn(sql, sql.length)
  }

  return null
}

// ---------------------------------------------------------------------------
// Dialecten
// ---------------------------------------------------------------------------

interface DialectShape {
  id: SqlDialectId
  openQuote: string
  closeQuote: string
  literalQuote: string
  buildLimit(maxRows?: number, offset?: number): string
}

function makeDialect(config: DialectShape): SqlDialect {
  return {
    id: config.id,
    quoteIdentifier: (id) => quoteIdent(config.openQuote, config.closeQuote, id),
    quoteQualifiedName: (schema, object) =>
      schema ? `${quoteIdent(config.openQuote, config.closeQuote, schema)}.${quoteIdent(config.openQuote, config.closeQuote, object)}` : quoteIdent(config.openQuote, config.closeQuote, object),
    quoteLiteral: (value) => quoteLit(config.literalQuote, value),
    buildLimit: (maxRows, offset) => config.buildLimit(maxRows, offset),
    parseErrorPosition: (message, sql) => {
      if (config.id !== 'sqlite') return null
      if (sql !== undefined) {
        const pos = parseSqliteErrorPosition(sql, message)
        return pos ? { line: pos.line, column: pos.column } : null
      }
      // Legacy (zonder SQL): positie binnen de melding zelf.
      const m = /near "([^"]*)"/.exec(message)
      if (m) {
        const idx = message.indexOf(m[1] ?? '')
        return idx >= 0 ? { line: 1, column: idx + 1 } : null
      }
      return null
    }
  }
}

const DIALECTS: Record<SqlDialectId, SqlDialect> = {
  sqlite: makeDialect({
    id: 'sqlite',
    openQuote: '"',
    closeQuote: '"',
    literalQuote: "'",
    buildLimit: (maxRows, offset) => {
      const { maxRows: m, offset: o } = normalizeLimit(maxRows, offset)
      if (m === null && o === null) return ''
      if (m !== null && o === null) return `LIMIT ${m}`
      if (m === null) return `LIMIT -1 OFFSET ${o}`
      return `LIMIT ${m} OFFSET ${o}`
    }
  }),
  tsql: makeDialect({
    id: 'tsql',
    openQuote: '[',
    closeQuote: ']',
    literalQuote: "'",
    buildLimit: (maxRows, offset) => {
      const { maxRows: m, offset: o } = normalizeLimit(maxRows, offset)
      if (m === null && o === null) return ''
      if (m !== null && o === null) return `TOP (${m})`
      if (m === null) return `OFFSET ${o} ROWS`
      return `OFFSET ${o} ROWS FETCH NEXT ${m} ROWS ONLY`
    }
  }),
  postgres: makeDialect({
    id: 'postgres',
    openQuote: '"',
    closeQuote: '"',
    literalQuote: "'",
    buildLimit: (maxRows, offset) => {
      const { maxRows: m, offset: o } = normalizeLimit(maxRows, offset)
      if (m === null && o === null) return ''
      if (m !== null && o === null) return `LIMIT ${m}`
      if (m === null) return `OFFSET ${o}`
      return `LIMIT ${m} OFFSET ${o}`
    }
  }),
  mysql: makeDialect({
    id: 'mysql',
    openQuote: '`',
    closeQuote: '`',
    literalQuote: "'",
    buildLimit: (maxRows, offset) => {
      const { maxRows: m, offset: o } = normalizeLimit(maxRows, offset)
      if (m === null && o === null) return ''
      if (m !== null && o === null) return `LIMIT ${m}`
      if (m === null) return `LIMIT 18446744073709551615 OFFSET ${o}`
      return `LIMIT ${m} OFFSET ${o}`
    }
  }),
  db2: makeDialect({
    id: 'db2',
    openQuote: '"',
    closeQuote: '"',
    literalQuote: "'",
    buildLimit: (maxRows, offset) => {
      const { maxRows: m, offset: o } = normalizeLimit(maxRows, offset)
      if (m === null && o === null) return ''
      if (m !== null && o === null) return `FETCH FIRST ${m} ROWS ONLY`
      if (m === null) return `OFFSET ${o} ROWS`
      return `OFFSET ${o} ROWS FETCH FIRST ${m} ROWS ONLY`
    }
  }),
  oracle: makeDialect({
    id: 'oracle',
    openQuote: '"',
    closeQuote: '"',
    literalQuote: "'",
    buildLimit: (maxRows, offset) => {
      const { maxRows: m, offset: o } = normalizeLimit(maxRows, offset)
      if (m === null && o === null) return ''
      if (m !== null && o === null) return `FETCH FIRST ${m} ROWS ONLY`
      if (m === null) return `OFFSET ${o} ROWS`
      return `OFFSET ${o} ROWS FETCH NEXT ${m} ROWS ONLY`
    }
  }),
  snowflake: makeDialect({
    id: 'snowflake',
    openQuote: '"',
    closeQuote: '"',
    literalQuote: "'",
    buildLimit: (maxRows, offset) => {
      const { maxRows: m, offset: o } = normalizeLimit(maxRows, offset)
      if (m === null && o === null) return ''
      if (m !== null && o === null) return `LIMIT ${m}`
      if (m === null) return `OFFSET ${o}`
      return `LIMIT ${m} OFFSET ${o}`
    }
  })
}

export function getDialect(id: SqlDialectId): SqlDialect {
  const d = DIALECTS[id]
  if (!d) throw new Error(`Onbekend dialect: ${String(id)}`)
  return d
}

export function quoteIdentifier(dialect: SqlDialectId, identifier: string): string {
  return DIALECTS[dialect].quoteIdentifier(identifier)
}

export function quoteQualifiedName(
  dialect: SqlDialectId,
  schema: string | null | undefined,
  object: string
): string {
  return DIALECTS[dialect].quoteQualifiedName(schema, object)
}

export function quoteLiteral(dialect: SqlDialectId, value: string): string {
  return DIALECTS[dialect].quoteLiteral(value)
}

export function buildLimit(dialect: SqlDialectId, maxRows?: number, offset?: number): string {
  return DIALECTS[dialect].buildLimit(maxRows, offset)
}

export function wrapErrorPosition(
  dialect: SqlDialectId,
  message: string,
  sql?: string
): ErrorPosition | null {
  return DIALECTS[dialect].parseErrorPosition(message, sql)
}

/** Genereer "SELECT * FROM <table>" met correcte quoting en optionele LIMIT/OFFSET. */
export function buildSelectStar(
  dialect: SqlDialectId,
  table: string,
  schema?: string,
  maxRows?: number,
  offset?: number
): string {
  const d = DIALECTS[dialect]
  const name = schema
    ? `${d.quoteIdentifier(schema)}.${d.quoteIdentifier(table)}`
    : d.quoteIdentifier(table)
  const limit = d.buildLimit(maxRows, offset)
  return `SELECT * FROM ${name}${limit ? ` ${limit}` : ''}`
}
