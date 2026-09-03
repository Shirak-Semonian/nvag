import { describe, expect, it } from 'vitest'
import {
  buildCreateTableFromColumns,
  dataTypeOptionsFor,
  defaultColumnDataTypes
} from '../src/index'

/**
 * SAL-51: datatype-dropdown per provider/dialect — de Admin-dialoog toont
 * per actief dialect een lijst met geldige datatypes (eigen type typen blijft
 * mogelijk). Deze tests bewaken de statische lijsten + dialect-passende
 * standaardtypes voor de kolomdefinitie.
 */
describe('dataTypeOptionsFor (SAL-51)', () => {
  it('levert per dialect een lijst met dialect-correcte types', () => {
    const tsql = dataTypeOptionsFor('tsql')
    expect(tsql).toContain('int')
    expect(tsql).toContain('nvarchar')
    expect(tsql).toContain('datetime2')
    expect(tsql).toContain('uniqueidentifier')

    const pg = dataTypeOptionsFor('postgres')
    expect(pg).toContain('integer')
    expect(pg).toContain('text')
    expect(pg).toContain('timestamp')
    expect(pg).toContain('uuid')
    expect(pg).toContain('jsonb')
    expect(pg).toContain('bytea')

    const my = dataTypeOptionsFor('mysql')
    expect(my).toContain('int')
    expect(my).toContain('varchar')
    expect(my).toContain('datetime')
    expect(my).toContain('json')

    const sq = dataTypeOptionsFor('sqlite')
    expect(sq).toContain('INTEGER')
    expect(sq).toContain('TEXT')

    // Geen dialect-lek: een tsql-lijst bevat geen postgres-only types.
    expect(tsql).not.toContain('jsonb')
    expect(pg).not.toContain('nvarchar')
  })

  it('valt terug op sqlite voor onbekende dialecten', () => {
    expect(dataTypeOptionsFor('unknown' as never)).toEqual(dataTypeOptionsFor('sqlite'))
  })

  it('standaardtypes zijn dialect-passend (PK + extra kolom)', () => {
    expect(defaultColumnDataTypes('tsql')[0]).toBe('int')
    expect(defaultColumnDataTypes('postgres')[0]).toBe('integer')
    expect(defaultColumnDataTypes('mysql')[0]).toBe('int')
    expect(defaultColumnDataTypes('sqlite')).toEqual(['INTEGER', 'TEXT'])
    // Standaardtype is bruikbaar in de CREATE TABLE-builder (hoofdlettergevoeligheid).
    const sql = buildCreateTableFromColumns(
      'tsql',
      'klanten',
      null,
      [{ name: 'id', dataType: defaultColumnDataTypes('tsql')[0], primaryKey: true }]
    )
    expect(sql).toContain('CREATE TABLE [klanten]')
  })
})
