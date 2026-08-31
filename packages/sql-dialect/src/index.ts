/**
 * @nvag/sql-dialect — dialect-afhankelijke SQL-generatie.
 *
 * F0: SQLite volledig (quoting, LIMIT/OFFSET, error-positie in de SQL).
 * F1: tsql/postgres/mysql/db2/oracle/snowflake — LIMIT/OFFSET-idioms en
 *     quoting zijn aanwezig; parseErrorPosition per dialect volgt.
 * F2: scripting (meerstatement-scripts splitsen/uitvoeren).
 */

import type { ErrorPosition, ScriptKind, SqlDialectId, TableMetadata } from '@nvag/contracts'

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
// Error-positie (T-SQL)
// ---------------------------------------------------------------------------

/**
 * Extraheer de foutpositie uit een SQL Server-foutmelding, teruggezocht in de
 * uitgevoerde SQL. Ondersteunde patronen (message-only, zoals tedious die
 * levert): `Incorrect syntax near 'X'`, `Invalid column name/object name 'X'`,
 * `Cannot find the object "X" ...`, `Must declare the scalar variable "@X"`,
 * `The multi-part identifier "X" could not be bound`, `Unclosed quotation
 * mark ...`, `'X' is not a recognized built-in function name`.
 * Retourneert null wanneer de positie niet bepaald kan worden.
 */
function parseTsqlErrorPosition(
  sql: string,
  message: string
): { line: number; column: number } | null {
  if (typeof sql !== 'string' || typeof message !== 'string') return null
  const trimmed = message.trim()

  // Token tussen enkele quotes: near / invalid column / invalid object / variable / etc.
  const quotedToken =
    /(?:Incorrect syntax near|Invalid column name|Invalid object name|Invalid schema name|Ambiguous column name|Unclosed quotation mark after the character string)\s+'([^']+)'/i.exec(
      trimmed
    ) ??
    /'([^']+)' is not a recognized built-in function name/i.exec(trimmed)
  if (quotedToken) {
    return locateTsqlToken(sql, quotedToken[1] ?? '')
  }

  // Token tussen dubbele quotes: object-verwijzingen
  const doubleQuoted =
    /(?:Cannot find the object|The multi-part identifier)\s+"([^"]+)"/i.exec(trimmed)
  if (doubleQuoted) {
    return locateTsqlToken(sql, doubleQuoted[1] ?? '')
  }

  // Scalar variable: @naam (message gebruikt dubbele quotes)
  const scalarVar = /Must declare the scalar variable\s+"(@[^"]+)"/i.exec(trimmed)
  if (scalarVar) {
    return locateToken(sql, scalarVar[1] ?? '', { quoted: true })
  }

  return null
}

/** Zoek een T-SQL token in de SQL: eerst als identifier, daarna als gebrackete identifier. */
function locateTsqlToken(
  sql: string,
  rawToken: string
): { line: number; column: number } | null {
  const token = stripSurroundingQuotes(rawToken.trim())
  if (token.length === 0) return null
  if (token.startsWith('@')) {
    return locateVariable(sql, token)
  }
  const asIdent = locateToken(sql, token, { quoted: false })
  if (asIdent) return asIdent
  // T-SQL geciteerde identifier: [naam]
  return locateToken(sql, `[${token}]`, { quoted: true })
}

/** Zoek een @-variabele als token, zonder matches in strings/comments. */
function locateVariable(
  sql: string,
  name: string
): { line: number; column: number } | null {
  const re = new RegExp(`(^|[^A-Za-z0-9_$@])${escapeRegExp(name)}(?=$|[^A-Za-z0-9_$@])`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const prefix = m[1] ?? ''
    const idx = m.index + prefix.length
    if (!insideStringOrComment(sql, idx)) {
      return offsetToLineColumn(sql, idx)
    }
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
  /** Optionele dialect-specifieke error-positie-parser (sql-gebruikend). */
  parseError?(sql: string, message: string): { line: number; column: number } | null
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
      if (config.parseError && sql !== undefined) {
        const pos = config.parseError(sql, message)
        return pos ? { line: pos.line, column: pos.column } : null
      }
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
    },
    parseError: (sql, message) => parseTsqlErrorPosition(sql, message)
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

// ---------------------------------------------------------------------------
// Statement-splitsing en top-level keyword-detectie (quote/comment-bewust)
// ---------------------------------------------------------------------------

/**
 * Splits SQL op ';' in losse statements, zonder te splitsen binnen
 * string-literals, gequotede identifiers of commentaar.
 *
 * - Trailing ';' en lege statements worden genegeerd.
 * - `SELECT 1; SELECT 2` → ['SELECT 1', 'SELECT 2'] (2 statements)
 * - `SELECT ';'`        → ["SELECT ';'"]             (1 statement)
 * - `/* x; y *​/ SELECT 1;` → ['/* x; y *​/ SELECT 1']   (1 statement)
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let current = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false

  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]

    if (inLineComment) {
      current += ch
      if (ch === '\n') inLineComment = false
      i++
      continue
    }
    if (inBlockComment) {
      current += ch
      if (ch === '*' && next === '/') {
        current += next!
        inBlockComment = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inSingle) {
      current += ch
      if (ch === "'") {
        if (next === "'") {
          current += next!
          i += 2
          continue
        }
        inSingle = false
      }
      i++
      continue
    }
    if (inDouble) {
      current += ch
      if (ch === '"') {
        if (next === '"') {
          current += next!
          i += 2
          continue
        }
        inDouble = false
      }
      i++
      continue
    }
    if (inBacktick) {
      current += ch
      if (ch === '`') {
        if (next === '`') {
          current += next!
          i += 2
          continue
        }
        inBacktick = false
      }
      i++
      continue
    }

    // Buiten quotes/comments
    if (ch === '-' && next === '-') {
      inLineComment = true
      current += ch + next!
      i += 2
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      current += ch + next!
      i += 2
      continue
    }
    if (ch === "'") {
      inSingle = true
      current += ch
      i++
      continue
    }
    if (ch === '"') {
      inDouble = true
      current += ch
      i++
      continue
    }
    if (ch === '`') {
      inBacktick = true
      current += ch
      i++
      continue
    }
    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed.length > 0) out.push(trimmed)
      current = ''
      i++
      continue
    }
    current += ch
    i++
  }

  const trimmed = current.trim()
  if (trimmed.length > 0) out.push(trimmed)
  return out
}

/**
 * Detecteert of een keyword (buiten string-literals, gequotede identifiers
 * en commentaar) in het eerste statement voorkomt. Hoofdletterongevoelig.
 *
 * Wordt gebruikt om te bepalen of een statement al een eigen clausule bevat
 * (bijv. `LIMIT`), zodat de provider geen dubbele clausule toevoegt.
 * Ook een clausule in een subquery telt mee: dan is toevoegen onveilig.
 */
export function containsKeyword(sql: string, keyword: string): boolean {
  const statements = splitStatements(sql)
  if (statements.length === 0) return false
  // Alleen naar het eerste statement kijken; multi-statement wordt elders geweigerd.
  const first = statements[0]!
  const needle = keyword.toUpperCase()
  const upper = first.toUpperCase()

  let i = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false

  while (i < upper.length) {
    const ch = upper[i]!
    const next = upper[i + 1]

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
        if (next === "'") i += 2
        else {
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
        if (next === '"') i += 2
        else {
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
        if (next === '`') i += 2
        else {
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

    // Buiten quotes/comments: match op woordgrens?
    if (upper.startsWith(needle, i)) {
      const before = i > 0 ? upper[i - 1]! : ''
      const after = upper[i + needle.length]
      const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)
      if (!isWordChar(before) && !isWordChar(after ?? '')) return true
      i += needle.length
      continue
    }
    i++
  }
  return false
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

// ---------------------------------------------------------------------------
// Script Object (F1-5) — dialect-correcte CREATE/DML-generatie uit metadata.
// Alle identifiers worden per dialect gequoted; waarden komen als `?`
// placeholders (de gebruiker vult ze in vóór uitvoering).
// ---------------------------------------------------------------------------

function renderColumnType(col: TableMetadata['columns'][number]): string {
  const base = col.dataType.toUpperCase() || 'TEXT'
  if (col.length !== undefined && col.length !== null) return `${base}(${col.length})`
  if (col.precision !== undefined && col.precision !== null) {
    if (col.scale !== undefined && col.scale !== null) return `${base}(${col.precision},${col.scale})`
    return `${base}(${col.precision})`
  }
  return base
}

function identityClause(dialect: SqlDialectId): string {
  switch (dialect) {
    case 'sqlite':
      return '' // SQLite: AUTOINCREMENT alleen inline op een INTEGER PRIMARY KEY
    case 'tsql':
      return ' IDENTITY(1,1)'
    case 'postgres':
    case 'db2':
    case 'oracle':
      return ' GENERATED ALWAYS AS IDENTITY'
    case 'mysql':
    case 'snowflake':
      return ' AUTO_INCREMENT'
  }
}

/**
 * Dialect-correcte CREATE TABLE op basis van tabelmetadata.
 * Bevat: kolommen (type/lengte, DEFAULT, NOT NULL, IDENTITY), primary key,
 * UNIQUE-constraints (uit unieke indexen), foreign keys en losse
 * CREATE INDEX-statements voor niet-unieke user-indexen.
 */
export function buildCreateTable(
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  meta: TableMetadata
): string {
  const d = DIALECTS[dialect]
  const name = d.quoteQualifiedName(schema, table)

  const pkCols =
    meta.primaryKey.length > 0
      ? meta.primaryKey
      : meta.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)
  const pkSet = new Set(pkCols)

  const lines: string[] = []
  let inlineIdentityPk: string | null = null

  for (const col of meta.columns) {
    if (col.isComputed) continue // geen definitie beschikbaar in metadata
    let def = `${d.quoteIdentifier(col.name)} ${renderColumnType(col)}`
    if (col.isIdentity) {
      def += identityClause(dialect)
      if (dialect === 'sqlite' && col.isPrimaryKey && pkSet.size === 1) {
        def += ' PRIMARY KEY AUTOINCREMENT'
        inlineIdentityPk = col.name
      }
    }
    if (col.defaultValue !== null && col.defaultValue !== undefined) {
      def += ` DEFAULT ${col.defaultValue}`
    }
    if (!col.nullable) {
      def += ' NOT NULL'
    }
    lines.push(def)
  }

  const tableConstraints: string[] = []
  if (pkSet.size > 0 && inlineIdentityPk === null) {
    tableConstraints.push(
      `PRIMARY KEY (${[...pkSet].map((c) => d.quoteIdentifier(c)).join(', ')})`
    )
  }
  for (const idx of meta.indexes) {
    if (idx.isUnique && !idx.isPrimaryKey && !idx.name.startsWith('sqlite_autoindex_')) {
      tableConstraints.push(
        `UNIQUE (${idx.columns.map((c) => d.quoteIdentifier(c)).join(', ')})`
      )
    }
  }
  for (const fk of meta.foreignKeys) {
    let s = `FOREIGN KEY (${fk.columns
      .map((c) => d.quoteIdentifier(c))
      .join(', ')}) REFERENCES ${d.quoteQualifiedName(fk.referencedSchema, fk.referencedTable)} (${fk.referencedColumns
      .map((c) => d.quoteIdentifier(c))
      .join(', ')})`
    if (fk.onDelete && !/NO ACTION/i.test(fk.onDelete)) s += ` ON DELETE ${fk.onDelete}`
    if (fk.onUpdate && !/NO ACTION/i.test(fk.onUpdate)) s += ` ON UPDATE ${fk.onUpdate}`
    tableConstraints.push(s)
  }

  const body = [...lines, ...tableConstraints]
  const createStmt =
    body.length === 0
      ? `CREATE TABLE ${name};`
      : `CREATE TABLE ${name} (\n  ${body.join(',\n  ')}\n);`

  // Niet-unieke user-indexen als losse statements (unieke indexen zijn al
  // als UNIQUE-constraint opgenomen; PK-autoindexen slaan we over).
  const indexStmts: string[] = []
  for (const idx of meta.indexes) {
    if (idx.isPrimaryKey || idx.isUnique || idx.name.startsWith('sqlite_autoindex_')) continue
    indexStmts.push(
      `CREATE INDEX ${d.quoteIdentifier(idx.name)} ON ${name} (${idx.columns
        .map((c) => d.quoteIdentifier(c))
        .join(', ')});`
    )
  }

  return indexStmts.length > 0 ? `${createStmt}\n${indexStmts.join('\n')}` : createStmt
}

/** SELECT met expliciete kolomlijst; zonder kolommen `SELECT *`. */
export function scriptSelect(
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  columns?: string[]
): string {
  const d = DIALECTS[dialect]
  const name = d.quoteQualifiedName(schema, table)
  if (!columns || columns.length === 0) {
    return `SELECT *\nFROM ${name};`
  }
  return `SELECT ${columns.map((c) => d.quoteIdentifier(c)).join(', ')}\nFROM ${name};`
}

/** INSERT met expliciete kolomlijst en `?`-placeholders als waarden. */
export function scriptInsert(
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  columns: string[]
): string {
  const d = DIALECTS[dialect]
  const name = d.quoteQualifiedName(schema, table)
  const cols = columns.map((c) => d.quoteIdentifier(c)).join(', ')
  const placeholders = columns.map(() => '?').join(', ')
  return `INSERT INTO ${name} (${cols})\nVALUES (${placeholders});`
}

/** UPDATE: niet-PK-kolommen in SET, PK-kolommen in WHERE (beide `?`). */
export function scriptUpdate(
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  columns: string[],
  pkColumns: string[]
): string {
  const d = DIALECTS[dialect]
  const name = d.quoteQualifiedName(schema, table)
  const settable = columns.filter((c) => !pkColumns.includes(c))
  const setClause = (settable.length > 0 ? settable : columns)
    .map((c) => `${d.quoteIdentifier(c)} = ?`)
    .join(', ')

  if (pkColumns.length > 0) {
    const where = pkColumns.map((c) => `${d.quoteIdentifier(c)} = ?`).join(' AND ')
    return `UPDATE ${name}\nSET ${setClause}\nWHERE ${where};`
  }
  return `UPDATE ${name}\nSET ${setClause}\n-- Let op: geen primary key gevonden; vul zelf een WHERE in\nWHERE <voorwaarde>;`
}

/** DELETE op basis van de primary key; zonder PK een invulbare WHERE. */
export function scriptDelete(
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  pkColumns: string[]
): string {
  const d = DIALECTS[dialect]
  const name = d.quoteQualifiedName(schema, table)
  if (pkColumns.length > 0) {
    const where = pkColumns.map((c) => `${d.quoteIdentifier(c)} = ?`).join(' AND ')
    return `DELETE FROM ${name}\nWHERE ${where};`
  }
  return `DELETE FROM ${name}\n-- Let op: geen primary key gevonden; vul zelf een WHERE in\nWHERE <voorwaarde>;`
}

/**
 * Script Object-dispatch (F1-5): genereer dialect-correcte SQL voor een tabel.
 * INSERT laat identity-kolommen buiten de kolomlijst; UPDATE/DELETE gebruiken
 * de primary key als WHERE-basis.
 */
export function scriptObject(
  kind: ScriptKind,
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  meta: TableMetadata
): string {
  switch (kind) {
    case 'CREATE':
      return buildCreateTable(dialect, table, schema, meta)
    case 'SELECT':
      return scriptSelect(dialect, table, schema, meta.columns.map((c) => c.name))
    case 'INSERT':
      return scriptInsert(
        dialect,
        table,
        schema,
        meta.columns.filter((c) => !c.isIdentity).map((c) => c.name)
      )
    case 'UPDATE':
      return scriptUpdate(
        dialect,
        table,
        schema,
        meta.columns.map((c) => c.name),
        meta.primaryKey
      )
    case 'DELETE':
      return scriptDelete(dialect, table, schema, meta.primaryKey)
    default: {
      const exhaustive: never = kind
      throw new Error(`Onbekende ScriptKind: ${String(exhaustive)}`)
    }
  }
}
