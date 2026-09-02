import { describe, expect, it } from 'vitest'
import {
  buildLimit,
  buildSelectStar,
  getDialect,
  quoteIdentifier,
  wrapErrorPosition
} from '../src/index'

describe('getDialect', () => {
  it('levert een dialect voor alle 7 ids', () => {
    for (const id of ['sqlite', 'tsql', 'postgres', 'mysql', 'db2', 'oracle', 'snowflake'] as const) {
      expect(getDialect(id).id).toBe(id)
    }
  })

  it('gooit bij onbekende id', () => {
    expect(() => getDialect('unknown' as never)).toThrow()
  })
})

describe('buildSelectStar', () => {
  it('sqlite: SELECT met quoting en optionele LIMIT', () => {
    expect(buildSelectStar('sqlite', 'users')).toBe('SELECT * FROM "users"')
    expect(buildSelectStar('sqlite', 'users', undefined, 100)).toBe(
      'SELECT * FROM "users" LIMIT 100'
    )
    expect(buildSelectStar('sqlite', 'order items', 'main')).toBe(
      'SELECT * FROM "main"."order items"'
    )
  })

  it('sqlite: met offset', () => {
    expect(buildSelectStar('sqlite', 'users', undefined, 10, 5)).toBe(
      'SELECT * FROM "users" LIMIT 10 OFFSET 5'
    )
    expect(buildSelectStar('sqlite', 'users', undefined, undefined, 5)).toBe(
      'SELECT * FROM "users" LIMIT -1 OFFSET 5'
    )
  })

  it('mysql: backticks', () => {
    expect(buildSelectStar('mysql', 'users')).toBe('SELECT * FROM `users`')
  })

  it('tsql: brackets', () => {
    expect(buildSelectStar('tsql', 'users')).toBe('SELECT * FROM [users]')
  })

  it('tsql: TOP (n) vóór de kolomlijst bij maxRows (SAL-42)', () => {
    // T-SQL staat geen "SELECT * FROM [t] TOP (n)" toe; TOP hoort na SELECT.
    expect(buildSelectStar('tsql', 'users', undefined, 100)).toBe(
      'SELECT TOP (100) * FROM [users]'
    )
    expect(buildSelectStar('tsql', 't', 'dbo', 100)).toBe(
      'SELECT TOP (100) * FROM [dbo].[t]'
    )
    expect(buildSelectStar('tsql', 't', 'dbo', 0)).toBe(
      'SELECT TOP (0) * FROM [dbo].[t]'
    )
  })
})

describe('compat free functions', () => {
  it('quoteIdentifier / buildLimit / wrapErrorPosition blijven werken', () => {
    expect(quoteIdentifier('sqlite', 'users')).toBe('"users"')
    expect(buildLimit('sqlite', 100)).toBe('LIMIT 100')
    expect(wrapErrorPosition('sqlite', 'near "SELEC": syntax error')).toEqual({
      line: 1,
      column: 7
    })
  })
})
