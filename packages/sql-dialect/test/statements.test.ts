import { describe, expect, it } from 'vitest'
import { containsKeyword, splitStatements } from '../src/index'

describe('splitStatements', () => {
  it('splitst meerdere statements', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('negeert trailing puntkomma en lege statements', () => {
    expect(splitStatements('SELECT 1;')).toEqual(['SELECT 1'])
    expect(splitStatements('SELECT 1;;')).toEqual(['SELECT 1'])
    expect(splitStatements('   ')).toEqual([])
  })

  it('splitst niet binnen string-literals', () => {
    expect(splitStatements("SELECT 'a;b' AS x; SELECT 2")).toEqual(["SELECT 'a;b' AS x", 'SELECT 2'])
    expect(splitStatements("SELECT 'a'';b' AS x")).toEqual(["SELECT 'a'';b' AS x"])
  })

  it('splitst niet binnen gequotede identifiers', () => {
    expect(splitStatements('SELECT "a;b" FROM t; SELECT 2')).toEqual(['SELECT "a;b" FROM t', 'SELECT 2'])
    expect(splitStatements('SELECT `a;b` FROM t')).toEqual(['SELECT `a;b` FROM t'])
  })

  it('splitst niet binnen commentaar', () => {
    expect(splitStatements('SELECT 1 -- ; nog commentaar\n; SELECT 2')).toEqual([
      'SELECT 1 -- ; nog commentaar',
      'SELECT 2'
    ])
    expect(splitStatements('SELECT 1 /* ; */ ; SELECT 2')).toEqual(['SELECT 1 /* ; */', 'SELECT 2'])
  })
})

describe('containsKeyword', () => {
  it('detecteert LIMIT in gewone query', () => {
    expect(containsKeyword('SELECT * FROM t LIMIT 5', 'LIMIT')).toBe(true)
    expect(containsKeyword('select * from t limit 5', 'LIMIT')).toBe(true)
    expect(containsKeyword('SELECT * FROM t', 'LIMIT')).toBe(false)
  })

  it('negeert LIMIT binnen string-literal', () => {
    expect(containsKeyword("SELECT 'LIMIT 5' AS txt", 'LIMIT')).toBe(false)
  })

  it('negeert LIMIT binnen commentaar', () => {
    expect(containsKeyword('SELECT * FROM t -- LIMIT 5', 'LIMIT')).toBe(false)
    expect(containsKeyword('SELECT * FROM t /* LIMIT 5 */', 'LIMIT')).toBe(false)
  })

  it('detecteert LIMIT binnen subquery (veilige conservatieve keuze)', () => {
    expect(containsKeyword('SELECT * FROM (SELECT * FROM t LIMIT 5) sub', 'LIMIT')).toBe(true)
  })
})
