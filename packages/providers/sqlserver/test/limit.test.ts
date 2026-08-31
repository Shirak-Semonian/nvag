import { describe, expect, it } from 'vitest'
import { applyTopLimit } from '../src/index'

/**
 * Unit-tests voor de T-SQL maxRows-cap (TOP-injectie).
 * Loopt zonder live SQL Server; de contracttest-suite (contract.test.ts)
 * dekt de echte server.
 */
describe('applyTopLimit (T-SQL TOP-injectie)', () => {
  it('voegt TOP (n) toe na SELECT', () => {
    expect(applyTopLimit('SELECT * FROM users', 100)).toBe('SELECT TOP (100) * FROM users')
  })

  it('voegt TOP (n) toe na SELECT DISTINCT', () => {
    expect(applyTopLimit('SELECT DISTINCT name FROM users', 50)).toBe(
      'SELECT DISTINCT TOP (50) name FROM users'
    )
  })

  it('voegt TOP (n) toe na SELECT ALL', () => {
    expect(applyTopLimit('SELECT ALL id FROM users', 10)).toBe('SELECT ALL TOP (10) id FROM users')
  })

  it('voegt niets toe wanneer er al TOP staat (geen dubbele clausule, SAL-8-les)', () => {
    expect(applyTopLimit('SELECT TOP (5) * FROM users', 100)).toBe('SELECT TOP (5) * FROM users')
  })

  it('voegt niets toe aan DML', () => {
    expect(applyTopLimit("INSERT INTO users (name) VALUES ('x')", 100)).toBe(
      "INSERT INTO users (name) VALUES ('x')"
    )
    expect(applyTopLimit("UPDATE users SET name = 'x'", 100)).toBe("UPDATE users SET name = 'x'")
    expect(applyTopLimit('DELETE FROM users', 100)).toBe('DELETE FROM users')
  })

  it('voegt niets toe aan niet-SELECT statements (WITH/EXEC)', () => {
    expect(applyTopLimit('WITH c AS (SELECT 1 AS x) SELECT * FROM c', 100)).toBe(
      'WITH c AS (SELECT 1 AS x) SELECT * FROM c'
    )
    expect(applyTopLimit('EXEC sp_help', 100)).toBe('EXEC sp_help')
  })

  it('houdt leading whitespace/comments', () => {
    expect(applyTopLimit('  SELECT * FROM t', 5)).toBe('  SELECT TOP (5) * FROM t')
    expect(applyTopLimit('-- comment\nSELECT * FROM t', 5)).toBe('-- comment\nSELECT TOP (5) * FROM t')
  })
})
