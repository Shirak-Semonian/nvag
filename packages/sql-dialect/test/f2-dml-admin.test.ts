/**
 * F2-1/F2-3: waarde-quoting, DML met echte waarden en admin-DDL.
 */

import { describe, expect, it } from 'vitest'
import {
  buildCreateDatabase,
  buildCreateIndex,
  buildCreateSchema,
  buildCreateTableFromColumns,
  buildCreateView,
  buildDeleteByPk,
  buildDrop,
  buildInsertValues,
  buildUpdateByPk,
  quoteValue
} from '../src/index'

describe('quoteValue (F2-1)', () => {
  it('quotes NULL en getallen', () => {
    expect(quoteValue('sqlite', null)).toBe('NULL')
    expect(quoteValue('sqlite', undefined)).toBe('NULL')
    expect(quoteValue('sqlite', 42)).toBe('42')
    expect(quoteValue('sqlite', 3.14)).toBe('3.14')
  })

  it('quotes strings met verdubbelde quotes', () => {
    expect(quoteValue('sqlite', "O'Brien")).toBe("'O''Brien'")
  })

  it('quotes booleans per dialect', () => {
    expect(quoteValue('postgres', true)).toBe('TRUE')
    expect(quoteValue('sqlite', true)).toBe('1')
    expect(quoteValue('tsql', false)).toBe('0')
  })

  it('quotes binair als hex-literal per dialect', () => {
    expect(quoteValue('sqlite', new Uint8Array([0xde, 0xad]))).toBe("X'dead'")
    expect(quoteValue('tsql', new Uint8Array([0xde, 0xad]))).toBe('0xdead')
  })
})

describe('buildUpdateByPk / buildInsertValues / buildDeleteByPk (F2-1)', () => {
  it('bouwt UPDATE met SET + PK-WHERE en geciteerde identifiers', () => {
    const sql = buildUpdateByPk(
      'sqlite',
      'users',
      'main',
      ['id'],
      { id: 1 },
      { naam: 'Jan', leeftijd: 31 }
    )
    expect(sql).toContain('UPDATE "main"."users"')
    expect(sql).toContain('"naam" = \'Jan\'')
    expect(sql).toContain('"id" = 1')
  })

  it('laat PK-kolommen buiten SET bij UPDATE', () => {
    const sql = buildUpdateByPk('postgres', 'users', null, ['id'], { id: 5 }, { id: 6, naam: 'x' })
    expect(sql).toContain('"naam" = \'x\'')
    expect(sql).not.toContain('"id" = 6')
    expect(sql).toContain('"id" = 5')
  })

  it('bouwt INSERT met kolommen en waarden', () => {
    const sql = buildInsertValues('sqlite', 'users', null, { naam: 'Piet', actief: true })
    expect(sql).toContain('INSERT INTO "users" ("naam", "actief")')
    expect(sql).toContain('VALUES (\'Piet\', 1)')
  })

  it('bouwt INSERT DEFAULT VALUES zonder kolommen', () => {
    expect(buildInsertValues('sqlite', 't', null, {})).toContain('DEFAULT VALUES')
  })

  it('bouwt DELETE op basis van PK-waarden', () => {
    const sql = buildDeleteByPk('sqlite', 'users', 'main', ['id'], { id: 7 })
    expect(sql).toContain('DELETE FROM "main"."users"')
    expect(sql).toContain('"id" = 7')
  })
})

describe('Admin-DDL (F2-3)', () => {
  it('bouwt CREATE TABLE met kolomdefinities en PK', () => {
    const sql = buildCreateTableFromColumns('sqlite', 'klanten', 'main', [
      { name: 'id', dataType: 'INTEGER', primaryKey: true },
      { name: 'naam', dataType: 'TEXT', nullable: false },
      { name: 'score', dataType: 'REAL', defaultValue: '0' }
    ])
    expect(sql).toContain('CREATE TABLE "main"."klanten"')
    expect(sql).toContain('"id" INTEGER PRIMARY KEY')
    expect(sql).toContain('"naam" TEXT NOT NULL')
    expect(sql).toContain('DEFAULT 0')
  })

  it('bouwt samengestelde PRIMARY KEY bij meerdere PK-kolommen', () => {
    const sql = buildCreateTableFromColumns('sqlite', 'rel', null, [
      { name: 'a', dataType: 'INTEGER', primaryKey: true },
      { name: 'b', dataType: 'INTEGER', primaryKey: true }
    ])
    expect(sql).toContain('PRIMARY KEY ("a", "b")')
  })

  it('bouwt DROP TABLE / VIEW / DATABASE', () => {
    expect(buildDrop('sqlite', 'TABLE', 'users', { schema: 'main' })).toContain('DROP TABLE "main"."users"')
    expect(buildDrop('postgres', 'VIEW', 'v', { schema: 'public' })).toContain('DROP VIEW "public"."v"')
    expect(buildDrop('mysql', 'DATABASE', 'app')).toContain('DROP DATABASE `app`')
  })

  it('bouwt CREATE INDEX met UNIQUE-optie', () => {
    const sql = buildCreateIndex('postgres', 'public', 'users', 'idx_naam', ['naam'], true)
    expect(sql).toContain('CREATE UNIQUE INDEX "idx_naam" ON "public"."users" ("naam")')
  })

  it('bouwt CREATE VIEW met de SELECT-tekst', () => {
    const sql = buildCreateView('sqlite', 'main', 'actieve_users', 'SELECT * FROM users WHERE actief = 1')
    expect(sql).toContain('CREATE VIEW "main"."actieve_users" AS')
    expect(sql).toContain('SELECT * FROM users WHERE actief = 1')
  })

  it('bouwt CREATE SCHEMA / CREATE DATABASE per dialect', () => {
    expect(buildCreateSchema('postgres', 'audit')).toContain('CREATE SCHEMA "audit"')
    expect(buildCreateSchema('mysql', 'audit')).toContain('CREATE DATABASE `audit`')
    expect(buildCreateDatabase('tsql', 'app')).toContain('CREATE DATABASE [app]')
  })
})
