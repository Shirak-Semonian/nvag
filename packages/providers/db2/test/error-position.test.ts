import { describe, expect, it } from 'vitest'
import { parseDb2ErrorPosition } from '../src/error-position'

describe('parseDb2ErrorPosition (db2)', () => {
  it('vindt het SQLERRMC-token in de SQL', () => {
    const msg =
      'DB2 SQL Error: SQLCODE=-104, SQLSTATE=42601, SQLERRMC=SELEC;...;...'
    const pos = parseDb2ErrorPosition('SELEC x FROM t', msg)
    expect(pos).toEqual({ line: 1, column: 1 })
  })

  it('rekent regel/kolom correct over newlines', () => {
    const sql = 'SELECT a\nFROM t\nWHERE x SELEC'
    const pos = parseDb2ErrorPosition(sql, 'SQLERRMC=SELEC')
    expect(pos).toEqual({ line: 3, column: 9 })
  })

  it('vindt het geciteerde token in de meldingstekst', () => {
    const msg = 'An unexpected token "FOO" was found following "". Expected tokens may include: "SELECT".'
    expect(parseDb2ErrorPosition('SELECT FOO FROM t', msg)).toEqual({ line: 1, column: 8 })
  })

  it('is hoofdletterongevoelig (DB2 vouwt naar boven)', () => {
    expect(parseDb2ErrorPosition('select x from t', 'SQLERRMC=X;')).toEqual({ line: 1, column: 8 })
  })

  it('retourneert null wanneer het token niet gevonden wordt', () => {
    expect(parseDb2ErrorPosition('SELECT * FROM t', 'SQLERRMC=FOO;')).toBeNull()
  })

  it('retourneert null zonder token-informatie', () => {
    expect(parseDb2ErrorPosition('SELECT * FROM t', 'connection refused')).toBeNull()
  })

  it('retourneert null bij ongeldige input', () => {
    expect(parseDb2ErrorPosition('', '')).toBeNull()
    expect(parseDb2ErrorPosition('SELECT 1', 'SQLERRMC=')).toBeNull()
  })
})
