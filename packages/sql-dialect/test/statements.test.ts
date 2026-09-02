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

describe('splitStatements — PostgreSQL dollar-quoting', () => {
  it('herkent $$...$$ als één statement (interne ; splitten niet)', () => {
    const sql =
      'CREATE FUNCTION add(a int, b int) RETURNS int AS $$ BEGIN RETURN a + b; END; $$ LANGUAGE plpgsql;'
    expect(splitStatements(sql)).toEqual([sql.slice(0, -1)])
  })

  it('herkent $tag$...$tag$ en splitst het statement erna wél', () => {
    const fn = `CREATE FUNCTION f() RETURNS text AS $body$ BEGIN RETURN 'x;y'; END; $body$ LANGUAGE plpgsql`
    expect(splitStatements(`${fn}; SELECT f();`)).toEqual([fn, 'SELECT f()'])
  })

  it('sluit een geneste dollar-quote met andere tag niet onterecht', () => {
    // De $inner$-paren zitten bínnen $$...$$ en sluiten die niet.
    expect(splitStatements('SELECT $$ x $inner$ y $inner$ z $$::text; SELECT 2')).toEqual([
      'SELECT $$ x $inner$ y $inner$ z $$::text',
      'SELECT 2'
    ])
  })

  it('behandelt $1-parameters niet als dollar-quote', () => {
    expect(splitStatements('SELECT $1; SELECT 2')).toEqual(['SELECT $1', 'SELECT 2'])
  })

  it('splitst niet binnen dollar-quote met interne ; en quotes', () => {
    expect(splitStatements("SELECT $$a;'b$$ AS x; SELECT 2")).toEqual([
      "SELECT $$a;'b$$ AS x",
      'SELECT 2'
    ])
  })
})

describe('splitStatements — MySQL/MariaDB BEGIN...END routine-bodies', () => {
  it('herkent CREATE PROCEDURE ... BEGIN...END als één statement', () => {
    const sql =
      'CREATE PROCEDURE p() BEGIN DECLARE x INT DEFAULT 1; IF x > 0 THEN SELECT 1; ELSE SELECT 2; END IF; END;'
    expect(splitStatements(sql)).toEqual([sql.slice(0, -1)])
  })

  it('herkent geneste blokken (WHILE/IF/END IF) binnen de body', () => {
    const sql =
      'CREATE PROCEDURE p(IN n INT) BEGIN DECLARE i INT DEFAULT 0; WHILE i < n DO SET i = i + 1; IF i = 2 THEN SELECT \'two\'; END IF; END WHILE; END;'
    expect(splitStatements(sql)).toEqual([sql.slice(0, -1)])
  })

  it('herkent CREATE TRIGGER ... BEGIN...END als één statement', () => {
    const sql =
      'CREATE TRIGGER trg AFTER INSERT ON t FOR EACH ROW BEGIN UPDATE t2 SET x = 1; SET @y = 2; END'
    expect(splitStatements(`${sql};`)).toEqual([sql])
  })

  it('herkent een gelabeld BEGIN...END-blok', () => {
    const sql = 'CREATE PROCEDURE p() lbl: BEGIN SELECT 1; END lbl'
    expect(splitStatements(`${sql};`)).toEqual([sql])
  })

  it('splitst een routine met single-statement-body normaal', () => {
    const sql = 'CREATE PROCEDURE p() SELECT 1; SELECT 2'
    expect(splitStatements(sql)).toEqual(['CREATE PROCEDURE p() SELECT 1', 'SELECT 2'])
  })

  it('splitst transactie-BEGIN niet als routine-body (regressie)', () => {
    expect(splitStatements('BEGIN; SELECT 1; COMMIT;')).toEqual(['BEGIN', 'SELECT 1', 'COMMIT'])
  })
})

describe('splitStatements — T-SQL BEGIN...END en GO-batches', () => {
  it('herkent CREATE PROCEDURE ... AS BEGIN...END als één statement', () => {
    const sql =
      'CREATE PROCEDURE dbo.p AS BEGIN SET NOCOUNT ON; SELECT 1; END;'
    expect(splitStatements(sql, 'tsql')).toEqual([sql.slice(0, -1)])
  })

  it('herkent CREATE TRIGGER ... AS BEGIN...END als één statement', () => {
    const sql =
      'CREATE TRIGGER trg ON dbo.t AFTER INSERT AS BEGIN SET NOCOUNT ON; INSERT INTO dbo.log(x) VALUES (1); END'
    expect(splitStatements(`${sql};`, 'tsql')).toEqual([sql])
  })

  it('splitst op een GO-regel (batchscheiding) met dialect tsql', () => {
    const create =
      'CREATE PROCEDURE dbo.p AS BEGIN SET NOCOUNT ON; SELECT 1; END'
    expect(splitStatements(`${create}\nGO\nSELECT 2`, 'tsql')).toEqual([create, 'SELECT 2'])
    expect(splitStatements(`${create}\ngo\nSELECT 2`, 'tsql')).toEqual([create, 'SELECT 2'])
  })

  it('splitst niet op GO zonder dialect (backward-compatibel)', () => {
    const sql = 'SELECT 1\nGO\nSELECT 2'
    expect(splitStatements(sql)).toEqual([sql])
  })

  it('splitst niet op GO midden op een regel', () => {
    expect(splitStatements('SELECT 1 GO', 'tsql')).toEqual(['SELECT 1 GO'])
    expect(splitStatements("SELECT 'GO'; SELECT 1", 'tsql')).toEqual(["SELECT 'GO'", 'SELECT 1'])
  })

  it('splitst BEGIN TRANSACTION niet als routine-body (regressie)', () => {
    expect(splitStatements('BEGIN TRANSACTION; SELECT 1; COMMIT;', 'tsql')).toEqual([
      'BEGIN TRANSACTION',
      'SELECT 1',
      'COMMIT'
    ])
  })
})

describe('splitStatements — backward-compatibele multi-statement-splitsing', () => {
  it('splitst gewone statements nog steeds correct na routine-herkenning', () => {
    expect(splitStatements('SELECT 1; SELECT 2; SELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
  })

  it('een routine gevolgd door gewone statements splitst daarna wél', () => {
    const sql = 'CREATE PROCEDURE p() BEGIN SELECT 1; END; SELECT 2;'
    expect(splitStatements(sql)).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; END', 'SELECT 2'])
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

  it('negeert LIMIT binnen dollar-quoted strings (SAL-40)', () => {
    expect(containsKeyword('SELECT $$LIMIT 5$$::text AS x', 'LIMIT')).toBe(false)
    expect(containsKeyword('SELECT $tag$ LIMIT 5 $tag$::text', 'LIMIT')).toBe(false)
  })

  it('detecteert LIMIT ná een dollar-quoted string wél', () => {
    expect(containsKeyword('SELECT $$a;b$$::text AS x LIMIT 5', 'LIMIT')).toBe(true)
  })
})
