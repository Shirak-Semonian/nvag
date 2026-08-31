import { describe, expect, it } from 'vitest'
import { applyFetchFirstLimit } from '../src/limit'

describe('applyFetchFirstLimit (db2)', () => {
  it('voegt FETCH FIRST toe aan een SELECT zonder limiet', () => {
    expect(applyFetchFirstLimit('SELECT * FROM t', 10)).toBe('SELECT * FROM t FETCH FIRST 10 ROWS ONLY')
  })

  it('voegt niets toe wanneer FETCH FIRST al aanwezig is', () => {
    expect(applyFetchFirstLimit('SELECT * FROM t FETCH FIRST 2 ROWS ONLY', 10)).toBe(
      'SELECT * FROM t FETCH FIRST 2 ROWS ONLY'
    )
  })

  it('voegt niets toe wanneer OFFSET al aanwezig is', () => {
    expect(applyFetchFirstLimit('SELECT * FROM t OFFSET 5 ROWS', 10)).toBe('SELECT * FROM t OFFSET 5 ROWS')
  })

  it('voegt niets toe bij een FETCH in een subquery (conservatief)', () => {
    const sql = 'SELECT * FROM (SELECT x FROM t FETCH FIRST 3 ROWS ONLY) s'
    expect(applyFetchFirstLimit(sql, 10)).toBe(sql)
  })

  it('laat DML/DDL onaangetast', () => {
    expect(applyFetchFirstLimit('INSERT INTO t (a) VALUES (1)', 10)).toBe('INSERT INTO t (a) VALUES (1)')
    expect(applyFetchFirstLimit('UPDATE t SET a = 1', 10)).toBe('UPDATE t SET a = 1')
    expect(applyFetchFirstLimit('DELETE FROM t', 10)).toBe('DELETE FROM t')
  })

  it('behoudt leading commentaar en werkt na blok-commentaar', () => {
    const sql = '-- opmerking\nSELECT * FROM t'
    expect(applyFetchFirstLimit(sql, 5)).toBe('-- opmerking\nSELECT * FROM t FETCH FIRST 5 ROWS ONLY')
    expect(applyFetchFirstLimit('/* x */ SELECT * FROM t', 5)).toBe(
      '/* x */ SELECT * FROM t FETCH FIRST 5 ROWS ONLY'
    )
  })

  it('werkt met SELECT DISTINCT', () => {
    expect(applyFetchFirstLimit('SELECT DISTINCT a FROM t', 3)).toBe(
      'SELECT DISTINCT a FROM t FETCH FIRST 3 ROWS ONLY'
    )
  })

  it('trimt trailing whitespace vóór de clausule', () => {
    expect(applyFetchFirstLimit('SELECT * FROM t   ', 2)).toBe('SELECT * FROM t FETCH FIRST 2 ROWS ONLY')
  })
})
