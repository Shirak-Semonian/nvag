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
  // SQL Server zegt bij gereserveerde woorden: "Incorrect syntax near the keyword 'FROM'".
  const quotedToken =
    /(?:Incorrect syntax near the keyword|Incorrect syntax near|Invalid column name|Invalid object name|Invalid schema name|Ambiguous column name|Unclosed quotation mark after the character string)\s+'([^']+)'/i.exec(
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
  }),
  databricks: makeDialect({
    id: 'databricks',
    openQuote: '`',
    closeQuote: '`',
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

/** Keywords die een routine-body introduceren (CREATE PROCEDURE/FUNCTION/...). */
const ROUTINE_BODY_KEYWORDS = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'])

/** T-SQL BEGIN-varianten die géén compound-blok openen (`BEGIN TRAN` e.d.). */
const BEGIN_NO_BLOCK_TAIL = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION'])

/** MySQL END-varianten die géén frame sluiten (END IF/LOOP/WHILE/REPEAT
 * sluiten statement-constructies zonder eigen frame; die worden alleen
 * beschermd door het omringende blok). */
const END_NO_FRAME_TAIL = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT'])

function isSqlIdentStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_]/.test(ch)
}

function isSqlIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
}

/** Leest een SQL-woord (identifier-tekens) vanaf i; '' wanneer i geen start is. */
function readSqlWord(sql: string, i: number): string {
  let j = i
  while (j < sql.length && isSqlIdentChar(sql[j])) j++
  return sql.slice(i, j)
}

/** Eerste identifier ná witruimte vanaf i (hoofdletters), of null. */
function nextSqlWordUpper(sql: string, i: number): string | null {
  let j = i
  while (j < sql.length && /\s/.test(sql[j]!)) j++
  if (j >= sql.length || !isSqlIdentStart(sql[j])) return null
  return readSqlWord(sql, j).toUpperCase()
}

/**
 * Wanneer sql[i] een PostgreSQL-dollar-quote opent (`$$` of `$tag$`),
 * retourneert de delimiter; anders null. `$1`-parameters openen géén quote.
 */
function dollarQuoteDelimiterAt(sql: string, i: number): string | null {
  if (sql[i] !== '$') return null
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 128))
  return m ? m[0] : null
}

/**
 * Splits SQL op ';' in losse statements, zonder te splitsen binnen
 * string-literals, gequotede identifiers, commentaar of dollar-quoted
 * strings — en zonder routine-bodies (`CREATE ... BEGIN ... END`) te knippen.
 *
 * - Trailing ';' en lege statements worden genegeerd.
 * - `SELECT 1; SELECT 2` → ['SELECT 1', 'SELECT 2'] (2 statements)
 * - `SELECT ';'`        → ["SELECT ';'"]             (1 statement)
 * - `/* x; y *​/ SELECT 1;` → ['/* x; y *​/ SELECT 1']   (1 statement)
 * - `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql`
 *   → 1 statement (PostgreSQL dollar-quoted body; de ';' zitten in de body)
 * - `CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END;`
 *   → 1 statement (MySQL/T-SQL BEGIN...END-blok; interne ';' splitten niet)
 *
 * @param sql de te splitsen SQL-tekst
 * @param dialect optioneel dialect. Voor 'tsql' wordt een GO-regel op een
 *   eigen regel als batchscheiding behandeld (mssql verstuurt per batch).
 *   Zonder dialect worden dollar-quotes en BEGIN...END-routine-bodies via
 *   generieke heuristiek herkend, zodat bestaande aanroepen blijven werken.
 */
export function splitStatements(sql: string, dialect?: SqlDialectId): string[] {
  const out: string[] = []
  let current = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  let inBacktick = false
  let inLineComment = false
  let inBlockComment = false
  let dollarDelim: string | null = null

  // Routine-body-herkenning (MySQL/T-SQL stored programs en triggers):
  // zodra het huidige statement een routine-keyword bevat en daarna met
  // BEGIN...END opent, tellen ';' binnen het blok niet als statement-einde.
  // Frames in plaats van een enkele diepte: een blote END kan óók een
  // CASE-expressie sluiten (`SET @x = CASE WHEN ... END;`), die geen
  // BEGIN-blok sluit. Door frames LIFO te stacken sluit een END altijd de
  // binnenste constructie (CASE-expressie, CASE-statement of BEGIN-blok).
  let routineBody = false
  const frames: Array<'begin' | 'case'> = []

  const flush = (): void => {
    const trimmed = current.trim()
    if (trimmed.length > 0) out.push(trimmed)
    current = ''
    routineBody = false
    frames.length = 0
  }

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
    if (dollarDelim !== null) {
      // PostgreSQL dollar-quoted string: overslaan tot dezelfde delimiter.
      if (sql.startsWith(dollarDelim, i)) {
        current += dollarDelim
        i += dollarDelim.length
        dollarDelim = null
      } else {
        current += ch
        i++
      }
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
    if (ch === '$') {
      const delim = dollarQuoteDelimiterAt(sql, i)
      if (delim !== null) {
        dollarDelim = delim
        current += delim
        i += delim.length
        continue
      }
      // Géén dollar-quote (bijv. PG `$1`-parameter): gewoon karakter
      current += ch
      i++
      continue
    }
    if (ch === ';') {
      if (frames.length > 0) {
        // Binnen een routine-body: ';' is een statement-scheiding in de body,
        // géén einde van het CREATE-statement.
        current += ch
        i++
        continue
      }
      flush()
      i++
      continue
    }

    // Identifiers op top-niveau: routine-keywords, BEGIN...END en GO herkennen
    // zonder elke letter afzonderlijk te hoeven testen.
    if (isSqlIdentStart(ch) && !isSqlIdentChar(sql[i - 1])) {
      const word = readSqlWord(sql, i)
      const upper = word.toUpperCase()
      const boundaryAfter = !isSqlIdentChar(sql[i + word.length])

      // T-SQL: GO op een eigen regel is een batchscheiding. De provider
      // verstuurt per batch; een ';' binnen BEGIN...END mag niet splitten,
      // maar GO scheidt wél batches.
      if (
        dialect === 'tsql' &&
        upper === 'GO' &&
        boundaryAfter &&
        frames.length === 0
      ) {
        const sinceLine = sql.lastIndexOf('\n', i - 1) + 1
        if (/^\s*$/.test(sql.slice(sinceLine, i))) {
          flush()
          // Rest van de GO-regel (optionele count) overslaan
          i += word.length
          while (i < sql.length && sql[i] !== '\n') i++
          if (i < sql.length && sql[i] === '\n') i++
          continue
        }
      }

      if (ROUTINE_BODY_KEYWORDS.has(upper) && !routineBody) {
        routineBody = true
      } else if (upper === 'CASE' && routineBody) {
        // CASE-expressie (`CASE WHEN ... END`) of MySQL CASE-statement
        // (`CASE ... END CASE`): eigen frame. Een CASE-expressie komt veel
        // voor in routine-bodies (`SET @x = CASE ... END;`) en mag een
        // eventueel open BEGIN-blok niet voortijdig sluiten.
        frames.push('case')
      } else if (upper === 'BEGIN' && routineBody) {
        // `BEGIN TRAN` e.d. opent geen compound-blok; een routine-body begint
        // met een losse BEGIN.
        const tail = nextSqlWordUpper(sql, i + word.length)
        if (tail === null || !BEGIN_NO_BLOCK_TAIL.has(tail)) frames.push('begin')
      } else if (upper === 'END' && routineBody && frames.length > 0) {
        // END-varianten: END IF/LOOP/WHILE/REPEAT sluiten statement-
        // constructies zonder eigen frame (beschermd door het omringende
        // blok). Al het andere sluit de binnenste frame:
        // - blote END → CASE-expressie (`SET @x = CASE ... END;`) of
        //   BEGIN-blok; een CASE-expressie mag een BEGIN-blok niet
        //   voortijdig sluiten, dus de stack bepaalt welke.
        // - END CASE → MySQL CASE-statement (alleen met open case-frame)
        // - END TRY/CATCH of END + label → blok-frame (T-SQL)
        let tailStart = i + word.length
        while (tailStart < sql.length && /\s/.test(sql[tailStart]!)) tailStart++
        const rawTail =
          tailStart < sql.length && isSqlIdentStart(sql[tailStart])
            ? readSqlWord(sql, tailStart)
            : null
        const tail = rawTail ? rawTail.toUpperCase() : null
        const noFrame = tail !== null && END_NO_FRAME_TAIL.has(tail)
        const caseStmtWithoutCaseFrame =
          tail === 'CASE' && frames[frames.length - 1] !== 'case'
        if (!noFrame && !caseStmtWithoutCaseFrame) frames.pop()
        if (tail === 'CASE') {
          // De CASE van `END CASE` is de tail van het END-woord: volledig
          // in current houden én overslaan, zodat hij niet opnieuw als
          // CASE-opener wordt geteld.
          current += sql.slice(i, tailStart + rawTail!.length)
          i = tailStart + rawTail!.length
          continue
        }
      }

      current += word
      i += word.length
      continue
    }

    current += ch
    i++
  }

  flush()
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
  let inDollar = false
  let dollarDelim: string | null = null

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
    if (inDollar) {
      // PostgreSQL dollar-quoted body: de keyword-zoektocht slaat de hele
      // body over (anders telt een clausule in de body ten onrechte mee).
      const delim = dollarDelim
      if (delim !== null && upper.startsWith(delim, i)) {
        inDollar = false
        dollarDelim = null
        i += delim.length
      } else {
        i++
      }
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
    if (ch === '$') {
      const delim = dollarQuoteDelimiterAt(upper, i)
      if (delim !== null) {
        inDollar = true
        dollarDelim = delim
        i += delim.length
        continue
      }
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
    case 'databricks':
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

// ---------------------------------------------------------------------------
// F2-1: Table Data Viewer/Editor — waarde-quoting en DML met echte waarden
// ---------------------------------------------------------------------------

/** Quote een runtime-waarde als SQL-literal (dialect-correct). */
export function quoteValue(dialect: SqlDialectId, value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') {
    // SQLite/TSQL/MySQL kennen geen TRUE/FALSE-literal in alle contexten.
    return dialect === 'postgres' || dialect === 'db2' || dialect === 'oracle' || dialect === 'snowflake' || dialect === 'databricks'
      ? value ? 'TRUE' : 'FALSE'
      : value ? '1' : '0'
  }
  if (value instanceof Date) return quoteLiteral(dialect, value.toISOString())
  if (value instanceof Uint8Array) {
    // Binair: SQLite X'hex', T-SQL 0x..., overige als string-hex.
    const hex = Buffer.from(value).toString('hex')
    if (dialect === 'sqlite') return `X'${hex}'`
    if (dialect === 'tsql') return `0x${hex}`
    return quoteLiteral(dialect, hex)
  }
  return quoteLiteral(dialect, String(value))
}

/** UPDATE met echte waarden: SET kolom = waarde ... WHERE pk = waarde. */
export function buildUpdateByPk(
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  pkColumns: string[],
  pkValues: Record<string, unknown>,
  changes: Record<string, unknown>
): string {
  const d = DIALECTS[dialect]
  const name = d.quoteQualifiedName(schema, table)
  const settable = Object.keys(changes).filter((c) => !pkColumns.includes(c))
  const setClause = (settable.length > 0 ? settable : Object.keys(changes))
    .map((c) => `${d.quoteIdentifier(c)} = ${quoteValue(dialect, changes[c])}`)
    .join(', ')
  const where =
    pkColumns.length > 0
      ? pkColumns.map((c) => `${d.quoteIdentifier(c)} = ${quoteValue(dialect, pkValues[c])}`).join(' AND ')
      : '<voorwaarde>'
  return `UPDATE ${name}\nSET ${setClause}\nWHERE ${where};`
}

/** INSERT met echte waarden: INSERT INTO t (kolommen) VALUES (waarde, ...). */
export function buildInsertValues(
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  values: Record<string, unknown>
): string {
  const d = DIALECTS[dialect]
  const name = d.quoteQualifiedName(schema, table)
  const entries = Object.entries(values)
  if (entries.length === 0) {
    return `INSERT INTO ${name}\nDEFAULT VALUES;`
  }
  const cols = entries.map(([c]) => d.quoteIdentifier(c)).join(', ')
  const vals = entries.map(([, v]) => quoteValue(dialect, v)).join(', ')
  return `INSERT INTO ${name} (${cols})\nVALUES (${vals});`
}

/** DELETE met echte PK-waarden. */
export function buildDeleteByPk(
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  pkColumns: string[],
  pkValues: Record<string, unknown>
): string {
  const d = DIALECTS[dialect]
  const name = d.quoteQualifiedName(schema, table)
  const where =
    pkColumns.length > 0
      ? pkColumns.map((c) => `${d.quoteIdentifier(c)} = ${quoteValue(dialect, pkValues[c])}`).join(' AND ')
      : '<voorwaarde>'
  return `DELETE FROM ${name}\nWHERE ${where};`
}

// ---------------------------------------------------------------------------
// F2-3: Database Administration — DDL-generatie
// ---------------------------------------------------------------------------

/** CREATE TABLE met expliciete kolomdefinities (admin, F2-3). */
export function buildCreateTableFromColumns(
  dialect: SqlDialectId,
  table: string,
  schema: string | null | undefined,
  columns: { name: string; dataType: string; length?: number; precision?: number; scale?: number; nullable?: boolean; primaryKey?: boolean; defaultValue?: string }[]
): string {
  const d = DIALECTS[dialect]
  const name = d.quoteQualifiedName(schema, table)
  const pkCols = columns.filter((c) => c.primaryKey).map((c) => c.name)
  const lines: string[] = []
  for (const col of columns) {
    let type = col.dataType.toUpperCase() || 'TEXT'
    if (col.length !== undefined && col.length !== null) type = `${type}(${col.length})`
    else if (col.precision !== undefined && col.precision !== null) {
      type = col.scale !== undefined && col.scale !== null ? `${type}(${col.precision},${col.scale})` : `${type}(${col.precision})`
    }
    let def = `${d.quoteIdentifier(col.name)} ${type}`
    if (col.primaryKey && pkCols.length === 1) def += ' PRIMARY KEY'
    if (col.defaultValue !== undefined && col.defaultValue !== null && col.defaultValue !== '') {
      def += ` DEFAULT ${col.defaultValue}`
    }
    if (col.nullable === false && !(col.primaryKey && pkCols.length === 1)) def += ' NOT NULL'
    lines.push(def)
  }
  if (pkCols.length > 1) {
    lines.push(`PRIMARY KEY (${pkCols.map((c) => d.quoteIdentifier(c)).join(', ')})`)
  }
  return `CREATE TABLE ${name} (\n  ${lines.join(',\n  ')}\n);`
}

/** DROP-object DDL (tabel/view/schema/database/index/...). */
export function buildDrop(
  dialect: SqlDialectId,
  objectType: 'TABLE' | 'VIEW' | 'SCHEMA' | 'DATABASE' | 'INDEX' | 'TRIGGER' | 'SEQUENCE' | 'PROCEDURE' | 'FUNCTION',
  name: string,
  options?: { schema?: string | null; table?: string }
): string {
  const d = DIALECTS[dialect]
  if (objectType === 'INDEX' && options?.table) {
    const tableName = d.quoteQualifiedName(options.schema, options.table)
    if (dialect === 'tsql' || dialect === 'mysql') {
      return `DROP INDEX ${d.quoteIdentifier(name)} ON ${tableName};`
    }
    return `DROP INDEX ${d.quoteIdentifier(name)} ON ${tableName};`
  }
  const qualified = d.quoteQualifiedName(options?.schema ?? null, name)
  return `DROP ${objectType} ${qualified};`
}

/** CREATE INDEX DDL (admin, F2-3). */
export function buildCreateIndex(
  dialect: SqlDialectId,
  schema: string | null | undefined,
  table: string,
  indexName: string,
  columns: string[],
  unique?: boolean
): string {
  const d = DIALECTS[dialect]
  const tableName = d.quoteQualifiedName(schema, table)
  const uniq = unique ? 'UNIQUE ' : ''
  return `CREATE ${uniq}INDEX ${d.quoteIdentifier(indexName)} ON ${tableName} (${columns
    .map((c) => d.quoteIdentifier(c))
    .join(', ')});`
}

/** CREATE VIEW DDL (admin, F2-3). */
export function buildCreateView(
  dialect: SqlDialectId,
  schema: string | null | undefined,
  name: string,
  selectSql: string
): string {
  const d = DIALECTS[dialect]
  const qualified = d.quoteQualifiedName(schema, name)
  return `CREATE VIEW ${qualified} AS\n${selectSql};`
}

/** CREATE SCHEMA DDL (admin, F2-3; SQLite/MySQL hebben geen schemas). */
export function buildCreateSchema(dialect: SqlDialectId, name: string): string {
  const d = DIALECTS[dialect]
  if (dialect === 'mysql') return `CREATE DATABASE ${d.quoteIdentifier(name)};`
  return `CREATE SCHEMA ${d.quoteIdentifier(name)};`
}

/** CREATE DATABASE DDL (admin, F2-3; dialect-idiomen). */
export function buildCreateDatabase(dialect: SqlDialectId, name: string): string {
  const d = DIALECTS[dialect]
  return `CREATE DATABASE ${d.quoteIdentifier(name)};`
}

/** BACKUP DATABASE (F4-1, DBA) — dialect-idiomen.
 * SQL Server: `BACKUP DATABASE [db] TO DISK = N'path'`
 * Db2: `BACKUP DB db TO 'path'`
 * SQLite: geen SQL (bestandskopie via de provider) → lege string.
 */
export function buildBackupDatabase(
  dialect: SqlDialectId,
  database: string,
  targetPath: string
): string {
  const d = DIALECTS[dialect]
  switch (dialect) {
    case 'tsql':
      return `BACKUP DATABASE ${d.quoteIdentifier(database)} TO DISK = ${d.quoteLiteral(targetPath)};`
    case 'db2':
      return `BACKUP DB ${d.quoteIdentifier(database)} TO ${d.quoteLiteral(targetPath)};`
    default:
      return ''
  }
}

/** RESTORE DATABASE (F4-1, DBA) — dialect-idiomen.
 * SQL Server: `RESTORE DATABASE [db] FROM DISK = N'path' WITH REPLACE`
 * Db2: `RESTORE DB db FROM 'path' REPLACE EXISTING`
 * SQLite: geen SQL (bestandskopie via de provider) → lege string.
 */
export function buildRestoreDatabase(
  dialect: SqlDialectId,
  database: string,
  sourcePath: string
): string {
  const d = DIALECTS[dialect]
  switch (dialect) {
    case 'tsql':
      return `RESTORE DATABASE ${d.quoteIdentifier(database)} FROM DISK = ${d.quoteLiteral(sourcePath)} WITH REPLACE;`
    case 'db2':
      return `RESTORE DB ${d.quoteIdentifier(database)} FROM ${d.quoteLiteral(sourcePath)} REPLACE EXISTING;`
    default:
      return ''
  }
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
