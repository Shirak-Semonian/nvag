import { describe, expect, it } from 'vitest'
import { columnsSql, mapColumns, type QueryRows } from '../src/db2-metadata'

/**
 * Db2-metadata-mapping (SAL-37).
 *
 * SYSCAT.COLUMNS heeft géén PRECISION-kolom (SQLCODE=-206); precisie wordt
 * afgeleid uit LENGTH/SCALE voor DECIMAL/NUMERIC. Deze tests bewaken dat de
 * query geen niet-bestaande kolom selecteert en dat de mapping type-afhankelijk
 * is (lengte alleen voor string/binary-typen, precisie/schaal alleen voor
 * DECIMAL/NUMERIC — zodat gegenereerde DDL geldig blijft, bijv. INTEGER in
 * plaats van INTEGER(4)).
 */

describe('columnsSql (db2, SAL-37)', () => {
  it('selecteert geen niet-bestaande PRECISION-kolom', () => {
    expect(columnsSql('DB2INST1', 't')).not.toMatch(/PRECISION/i)
  })

  it('selecteert LENGTH en SCALE voor precisie-afleiding', () => {
    const sql = columnsSql('DB2INST1', 't')
    expect(sql).toMatch(/c\.LENGTH AS "LENGTH"/)
    expect(sql).toMatch(/c\.SCALE AS "SCALE"/)
  })
})

describe('mapColumns (db2, SAL-37)', () => {
  const q = (rows: unknown[][]): QueryRows => ({
    columns: [
      'NAME',
      'DATA_TYPE',
      'LENGTH',
      'SCALE',
      'NULLABLE',
      'DEFAULT_VALUE',
      'IS_IDENTITY',
      'IS_COMPUTED',
      'ORDINAL'
    ],
    rows
  })

  it('leidt precision/scale af uit LENGTH/SCALE voor DECIMAL', () => {
    const cols = mapColumns(
      q([['AMOUNT', 'DECIMAL', 10, 2, 1, null, 0, 0, 1]])
    )
    expect(cols[0]?.name).toBe('AMOUNT')
    expect(cols[0]?.dataType).toBe('DECIMAL')
    expect(cols[0]?.precision).toBe(10)
    expect(cols[0]?.scale).toBe(2)
    expect(cols[0]?.length).toBeUndefined()
  })

  it('zet length alleen voor string/binary-typen (VARCHAR, ...)', () => {
    const cols = mapColumns(
      q([
        ['NAME', 'VARCHAR', 100, 0, 0, null, 0, 0, 2],
        ['DATA', 'BLOB', 1024, 0, 1, null, 0, 0, 3]
      ])
    )
    expect(cols[0]?.length).toBe(100)
    expect(cols[0]?.precision).toBeUndefined()
    expect(cols[1]?.length).toBe(1024)
  })

  it('geeft numerieke typen (INTEGER) geen length/precision/scale', () => {
    const cols = mapColumns(
      q([['ID', 'INTEGER', 4, 0, 0, null, 1, 0, 1]])
    )
    expect(cols[0]?.length).toBeUndefined()
    expect(cols[0]?.precision).toBeUndefined()
    expect(cols[0]?.scale).toBeUndefined()
    expect(cols[0]?.isIdentity).toBe(true)
  })
})
