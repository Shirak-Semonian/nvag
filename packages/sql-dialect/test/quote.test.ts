import { describe, expect, it } from 'vitest'
import { quoteIdentifier, quoteQualifiedName, quoteLiteral, getDialect } from '../src/index'

describe('quoteIdentifier', () => {
  it('sqlite: dubbel aanhalingsteken, embedded quote verdubbeld', () => {
    expect(quoteIdentifier('sqlite', 'users')).toBe('"users"')
    expect(quoteIdentifier('sqlite', 'order')).toBe('"order"')
    expect(quoteIdentifier('sqlite', 'a"b')).toBe('"a""b"')
    expect(quoteIdentifier('sqlite', 'weird name')).toBe('"weird name"')
  })

  it('postgres/oracle/db2/snowflake: ANSI double quotes', () => {
    for (const d of ['postgres', 'oracle', 'db2', 'snowflake'] as const) {
      expect(quoteIdentifier(d, 'users')).toBe('"users"')
      expect(quoteIdentifier(d, 'a"b')).toBe('"a""b"')
    }
  })

  it('mysql: backticks, embedded backtick verdubbeld', () => {
    expect(quoteIdentifier('mysql', 'users')).toBe('`users`')
    expect(quoteIdentifier('mysql', 'a`b')).toBe('`a``b`')
  })

  it('tsql: vierkante haken, embedded ] verdubbeld', () => {
    expect(quoteIdentifier('tsql', 'users')).toBe('[users]')
    expect(quoteIdentifier('tsql', 'a]b')).toBe('[a]]b]')
    expect(quoteIdentifier('tsql', 'a[b')).toBe('[a[b]')
  })

  it('gooit bij lege identifier of controle-tekens', () => {
    expect(() => quoteIdentifier('sqlite', '')).toThrow()
    expect(() => quoteIdentifier('tsql', '')).toThrow()
    expect(() => quoteIdentifier('sqlite', 'a\u0001b')).toThrow()
  })
})

describe('quoteQualifiedName', () => {
  it('zonder schema alleen object', () => {
    expect(quoteQualifiedName('sqlite', null, 'users')).toBe('"users"')
    expect(quoteQualifiedName('sqlite', '', 'users')).toBe('"users"')
    expect(quoteQualifiedName('sqlite', undefined, 'users')).toBe('"users"')
  })

  it('met schema beide gequoted', () => {
    expect(quoteQualifiedName('sqlite', 'main', 'users')).toBe('"main"."users"')
    expect(quoteQualifiedName('mysql', 'app', 'order items')).toBe('`app`.`order items`')
    expect(quoteQualifiedName('tsql', 'dbo', 'order')).toBe('[dbo].[order]')
    expect(quoteQualifiedName('tsql', 'dbo', 'a]b')).toBe('[dbo].[a]]b]')
  })
})

describe('quoteLiteral', () => {
  it('single quotes, embedded quote verdubbeld', () => {
    expect(quoteLiteral('sqlite', "it's")).toBe("'it''s'")
    expect(quoteLiteral('sqlite', 'plain')).toBe("'plain'")
    expect(quoteLiteral('tsql', "it's")).toBe("'it''s'")
    expect(quoteLiteral('mysql', "it's")).toBe("'it''s'")
  })
})

describe('dialect-interface via getDialect', () => {
  it('elk dialect exposeert de volledige interface', () => {
    for (const id of ['sqlite', 'tsql', 'postgres', 'mysql', 'db2', 'oracle', 'snowflake'] as const) {
      const d = getDialect(id)
      expect(typeof d.quoteIdentifier).toBe('function')
      expect(typeof d.quoteQualifiedName).toBe('function')
      expect(typeof d.quoteLiteral).toBe('function')
      expect(typeof d.buildLimit).toBe('function')
      expect(typeof d.parseErrorPosition).toBe('function')
      expect(d.id).toBe(id)
    }
  })
})
