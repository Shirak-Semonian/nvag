import { describe, expect, it } from 'vitest'
import { getDialect, quoteIdentifier, buildLimit, wrapErrorPosition } from '../src/index'

describe('sql-dialect: sqlite', () => {
  const d = getDialect('sqlite')

  it('quotes identifiers with double quotes', () => {
    expect(quoteIdentifier('sqlite', 'users')).toBe('"users"')
  })

  it('escapes embedded quotes in identifiers', () => {
    expect(quoteIdentifier('sqlite', 'weird"name')).toBe('"weird""name"')
  })

  it('builds LIMIT clause', () => {
    expect(buildLimit('sqlite', 100)).toBe('LIMIT 100')
  })

  it('returns empty limit when no max', () => {
    expect(buildLimit('sqlite', undefined)).toBe('')
  })

  it('wraps error position for sqlite (line/column based)', () => {
    const pos = wrapErrorPosition('sqlite', 'near "SELEC": syntax error')
    expect(pos).toEqual({ line: 1, column: 7 })
  })

  it('returns null when no position parseable', () => {
    expect(wrapErrorPosition('sqlite', 'database is locked')).toBeNull()
  })

  it('exposes dialect id', () => {
    expect(d.id).toBe('sqlite')
  })
})
