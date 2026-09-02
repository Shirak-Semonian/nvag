/**
 * F2-1/F2-3: waarde-quoting, DML met echte waarden en admin-DDL.
 */

import { describe, expect, it } from 'vitest'
import {
  buildAlterDatabaseStatements,
  buildCreateDatabase,
  buildCreateIndex,
  buildCreateSchema,
  buildCreateTableFromColumns,
  buildCreateView,
  buildDeleteByPk,
  buildDrop,
  buildDropConstraint,
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

  it('bouwt DROP voor procedure/function/trigger/sequence/synonym (SAL-45)', () => {
    expect(buildDrop('tsql', 'PROCEDURE', 'sp_rapport', { schema: 'dbo' })).toBe('DROP PROCEDURE [dbo].[sp_rapport];')
    expect(buildDrop('tsql', 'FUNCTION', 'fn_bereken', { schema: 'dbo' })).toBe('DROP FUNCTION [dbo].[fn_bereken];')
    expect(buildDrop('tsql', 'TRIGGER', 'trg_ins', { schema: 'dbo' })).toBe('DROP TRIGGER [dbo].[trg_ins];')
    expect(buildDrop('postgres', 'PROCEDURE', 'sp_rapport', { schema: 'public' })).toBe('DROP PROCEDURE "public"."sp_rapport";')
    expect(buildDrop('tsql', 'SEQUENCE', 'seq_nr', { schema: 'dbo' })).toBe('DROP SEQUENCE [dbo].[seq_nr];')
    expect(buildDrop('tsql', 'SYNONYM', 'syn_oud', { schema: 'dbo' })).toBe('DROP SYNONYM [dbo].[syn_oud];')
  })

  it('bouwt DROP USER / ROLE zonder schema (database-scoped principals, SAL-45)', () => {
    expect(buildDrop('tsql', 'USER', 'app_ro')).toBe('DROP USER [app_ro];')
    expect(buildDrop('postgres', 'USER', 'app_ro')).toBe('DROP USER "app_ro";')
    expect(buildDrop('tsql', 'ROLE', 'db_reader')).toBe('DROP ROLE [db_reader];')
    expect(buildDrop('postgres', 'ROLE', 'db_reader')).toBe('DROP ROLE "db_reader";')
  })

  it('bouwt DROP INDEX dialect-correct: tsql/mysql ON-tabel, overig zonder ON (SAL-45)', () => {
    expect(buildDrop('tsql', 'INDEX', 'idx_naam', { schema: 'dbo', table: 'klanten' })).toBe('DROP INDEX [idx_naam] ON [dbo].[klanten];')
    expect(buildDrop('mysql', 'INDEX', 'idx_naam', { schema: 'app', table: 'klanten' })).toBe('DROP INDEX `idx_naam` ON `app`.`klanten`;')
    expect(buildDrop('postgres', 'INDEX', 'idx_naam', { schema: 'public', table: 'klanten' })).toBe('DROP INDEX "public"."idx_naam";')
    expect(buildDrop('sqlite', 'INDEX', 'idx_naam', { schema: 'main', table: 'klanten' })).toBe('DROP INDEX "main"."idx_naam";')
  })

  it('vereist een ON-tabel voor DROP INDEX op tsql/mysql (SAL-45)', () => {
    expect(() => buildDrop('tsql', 'INDEX', 'idx_naam')).toThrow(/tabelnaam/)
  })

  it('bouwt postgres DROP TRIGGER met ON-tabel; vereist tabelnaam (SAL-45)', () => {
    expect(buildDrop('postgres', 'TRIGGER', 'trg_ins', { schema: 'public', table: 'klanten' })).toBe('DROP TRIGGER "trg_ins" ON "public"."klanten";')
    expect(() => buildDrop('postgres', 'TRIGGER', 'trg_ins', { schema: 'public' })).toThrow(/tabel/)
  })

  it('bouwt ALTER TABLE … DROP CONSTRAINT op tsql/postgres (SAL-45)', () => {
    expect(buildDropConstraint('tsql', 'dbo', 'klanten', 'CK_leeftijd')).toBe('ALTER TABLE [dbo].[klanten] DROP CONSTRAINT [CK_leeftijd];')
    expect(buildDropConstraint('postgres', 'public', 'klanten', 'klanten_pkey')).toBe('ALTER TABLE "public"."klanten" DROP CONSTRAINT "klanten_pkey";')
    expect(() => buildDropConstraint('mysql', 'app', 'klanten', 'CK_x')).toThrow(/niet ondersteund/)
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

describe('buildAlterDatabaseStatements (SAL-50)', () => {
  it('bouwt per eigenschap een ALTER DATABASE-statement voor tsql', () => {
    expect(
      buildAlterDatabaseStatements('tsql', 'Klanten', {
        recovery: 'SIMPLE',
        compatibility_level: '150',
        read_only: 'READ_ONLY'
      })
    ).toEqual([
      'ALTER DATABASE [Klanten] SET RECOVERY SIMPLE;',
      'ALTER DATABASE [Klanten] SET COMPATIBILITY_LEVEL = 150;',
      'ALTER DATABASE [Klanten] SET READ_ONLY;'
    ])
  })

  it('bouwt een MODIFY NAME met gebrackete identifier-quoting', () => {
    expect(buildAlterDatabaseStatements('tsql', 'Klanten', { name: 'Klanten2' })).toEqual([
      'ALTER DATABASE [Klanten] MODIFY NAME = [Klanten2];'
    ])
    // Rechte haakjes in de nieuwe naam worden geëscaped.
    expect(buildAlterDatabaseStatements('tsql', 'Klanten', { name: 'Klanten]2' })).toEqual([
      'ALTER DATABASE [Klanten] MODIFY NAME = [Klanten]]2];'
    ])
  })

  it('bouwt containment alleen met geldige waarden', () => {
    expect(buildAlterDatabaseStatements('tsql', 'Klanten', { containment: 'NONE' })).toEqual([
      'ALTER DATABASE [Klanten] SET CONTAINMENT = NONE;'
    ])
    expect(() => buildAlterDatabaseStatements('tsql', 'Klanten', { containment: 'PARTIAL_X' })).toThrow(
      /containment/i
    )
  })

  it('weigert ongeldige waarden en onbekende eigenschappen', () => {
    expect(() => buildAlterDatabaseStatements('tsql', 'Klanten', { recovery: 'WEIRD' })).toThrow(/recovery/i)
    expect(() =>
      buildAlterDatabaseStatements('tsql', 'Klanten', { compatibility_level: '999' })
    ).toThrow(/compatibility/i)
    expect(() => buildAlterDatabaseStatements('tsql', 'Klanten', { owner: 'sa' })).toThrow(/kan voor dit dialect/)
  })

  it('weigert niet-tsql-dialecten (ALTER DATABASE niet ondersteund)', () => {
    expect(() => buildAlterDatabaseStatements('postgres', 'Klanten', { recovery: 'SIMPLE' })).toThrow(
      /niet ondersteund/
    )
  })
})
