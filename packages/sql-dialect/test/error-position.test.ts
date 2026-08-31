import { describe, expect, it } from 'vitest'
import { wrapErrorPosition } from '../src/index'

describe('wrapErrorPosition (SQL-gebaseerd) — near "TOKEN"', () => {
  it('vindt token in eenregelige SQL', () => {
    const pos = wrapErrorPosition('sqlite', 'near "FRM": syntax error', 'SELECT * FRM users')
    expect(pos).toEqual({ line: 1, column: 10 })
  })

  it('vindt keyword-token (FROM)', () => {
    const pos = wrapErrorPosition('sqlite', 'near "FROM": syntax error', 'SELECT FROM t')
    expect(pos).toEqual({ line: 1, column: 8 })
  })

  it('vindt token in meerregelige SQL (regel 2)', () => {
    const pos = wrapErrorPosition(
      'sqlite',
      'no such table: missing_table',
      'SELECT *\nFROM missing_table'
    )
    expect(pos).toEqual({ line: 2, column: 6 })
  })

  it('slaat occurrence in een string-literal over', () => {
    const pos = wrapErrorPosition('sqlite', 'near "FRM": syntax error', "SELECT 'FRM' FROM t")
    expect(pos).toBeNull()
  })

  it('respecteert woordgrenzen (geen match in user_frm)', () => {
    const pos = wrapErrorPosition('sqlite', 'near "FRM": syntax error', 'SELECT user_frm FROM t')
    expect(pos).toBeNull()
  })

  it('valt terug op case-insensitive zoeken', () => {
    const pos = wrapErrorPosition('sqlite', 'near "frm": syntax error', 'SELECT FRM x')
    expect(pos).toEqual({ line: 1, column: 8 })
  })
})

describe('wrapErrorPosition — unrecognized token', () => {
  it('token begint met quote → letterlijk zoeken', () => {
    const pos = wrapErrorPosition('sqlite', 'unrecognized token: "\'abc"', "SELECT 'abc")
    expect(pos).toEqual({ line: 1, column: 8 })
  })

  it('embedded quote in token wordt rauw meegenomen', () => {
    const pos = wrapErrorPosition(
      'sqlite',
      'unrecognized token: ""unterminated"',
      'SELECT "unterminated'
    )
    expect(pos).toEqual({ line: 1, column: 8 })
  })
})

describe('wrapErrorPosition — semantische fouten', () => {
  it('no such column', () => {
    const pos = wrapErrorPosition('sqlite', 'no such column: nope', 'SELECT nope FROM sqlite_master')
    expect(pos).toEqual({ line: 1, column: 8 })
  })

  it('no such column binnen string wordt overgeslagen', () => {
    const pos = wrapErrorPosition('sqlite', 'no such column: nope', "SELECT 'nope' FROM sqlite_master")
    expect(pos).toBeNull()
  })

  it('no such column met hint (dubbele quotes als identifier)', () => {
    const pos = wrapErrorPosition(
      'sqlite',
      'no such column: "a" - should this be a string literal in single-quotes?',
      'SELECT "a"b'
    )
    expect(pos).toEqual({ line: 1, column: 8 })
  })

  it('duplicate column name → laatste occurrence', () => {
    const pos = wrapErrorPosition(
      'sqlite',
      'duplicate column name: id',
      'CREATE TABLE t (id INT, id INT)'
    )
    expect(pos).toEqual({ line: 1, column: 25 })
  })

  it('table has no column named', () => {
    const pos = wrapErrorPosition('sqlite', 'table t has no column named nope', 'SELECT nope FROM t')
    expect(pos).toEqual({ line: 1, column: 8 })
  })
})

describe('wrapErrorPosition — incomplete input & fallback', () => {
  it('incomplete input → einde van invoer', () => {
    const pos = wrapErrorPosition('sqlite', 'incomplete input', 'SELECT')
    expect(pos).toEqual({ line: 1, column: 7 })
  })

  it('onbekende melding → null', () => {
    expect(wrapErrorPosition('sqlite', 'database table is locked', 'SELECT 1')).toBeNull()
    expect(wrapErrorPosition('sqlite', 'near "x": syntax error', '')).toBeNull()
  })
})

describe('wrapErrorPosition — legacy zonder SQL', () => {
  it('near-patroon: positie binnen de melding', () => {
    expect(wrapErrorPosition('sqlite', 'near "SELEC": syntax error')).toEqual({ line: 1, column: 7 })
  })

  it('niet-parseerbare melding → null', () => {
    expect(wrapErrorPosition('sqlite', 'database is locked')).toBeNull()
  })
})

describe('wrapErrorPosition — overige dialecten', () => {
  it('retourneren null (F1)', () => {
    for (const d of ['tsql', 'postgres', 'mysql', 'db2', 'oracle', 'snowflake'] as const) {
      expect(wrapErrorPosition(d, 'near "x": syntax error', 'SELECT x')).toBeNull()
    }
  })
})

// --- Integratietests tegen de echte SQLite-engine (node:sqlite) ---
// node:sqlite zit niet in vite 5's ingebouwde module-lijst; via createRequire
// laden we de builtin direct uit Node (geen vite-transform nodig).
import { createRequire } from 'node:module'

const nodeRequire = createRequire(import.meta.url)
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite')

function sqliteError(sql: string): string {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(sql)
    throw new Error('verwachtte een fout, maar de SQL slaagde')
  } catch (err) {
    return (err as Error).message
  }
}

describe('wrapErrorPosition — echte SQLite-meldingen (node:sqlite)', () => {
  it('near "FRM"', () => {
    const sql = 'SELECT * FRM users'
    const msg = sqliteError(sql)
    expect(msg).toContain('near "FRM"')
    expect(wrapErrorPosition('sqlite', msg, sql)).toEqual({ line: 1, column: 10 })
  })

  it('near "FROM"', () => {
    const sql = 'SELECT FROM t'
    const msg = sqliteError(sql)
    expect(msg).toContain('near "FROM"')
    expect(wrapErrorPosition('sqlite', msg, sql)).toEqual({ line: 1, column: 8 })
  })

  it('no such column', () => {
    const sql = 'SELECT nope FROM sqlite_master'
    const msg = sqliteError(sql)
    expect(msg).toContain('no such column: nope')
    expect(wrapErrorPosition('sqlite', msg, sql)).toEqual({ line: 1, column: 8 })
  })

  it('no such table (meerregelig)', () => {
    const sql = 'SELECT *\nFROM missing_table'
    const msg = sqliteError(sql)
    expect(msg).toContain('no such table: missing_table')
    expect(wrapErrorPosition('sqlite', msg, sql)).toEqual({ line: 2, column: 6 })
  })

  it('unterminated string literal', () => {
    const sql = "SELECT 'abc"
    const msg = sqliteError(sql)
    expect(msg).toContain('unrecognized token')
    expect(wrapErrorPosition('sqlite', msg, sql)).toEqual({ line: 1, column: 8 })
  })

  it('unterminated quoted identifier', () => {
    const sql = 'SELECT "abc'
    const msg = sqliteError(sql)
    expect(msg).toContain('unrecognized token')
    expect(wrapErrorPosition('sqlite', msg, sql)).toEqual({ line: 1, column: 8 })
  })

  it('incomplete input', () => {
    const sql = 'SELECT'
    const msg = sqliteError(sql)
    expect(msg).toContain('incomplete input')
    expect(wrapErrorPosition('sqlite', msg, sql)).toEqual({ line: 1, column: 7 })
  })

  it('near ")" bij trailing komma', () => {
    const sql = 'CREATE TABLE t (a INT, )'
    const msg = sqliteError(sql)
    expect(msg).toContain('near ")"')
    expect(wrapErrorPosition('sqlite', msg, sql)).toEqual({ line: 1, column: 24 })
  })

  it('no such column met hint (dubbele quotes als identifier)', () => {
    const sql = 'SELECT "a"b'
    const msg = sqliteError(sql)
    expect(msg).toContain('no such column')
    expect(wrapErrorPosition('sqlite', msg, sql)).toEqual({ line: 1, column: 8 })
  })
})
