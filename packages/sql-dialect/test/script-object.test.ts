import { describe, expect, it } from 'vitest'
import type { TableMetadata } from '@nvag/contracts'
import {
  buildCreateTable,
  scriptDelete,
  scriptInsert,
  scriptObject,
  scriptSelect,
  scriptUpdate
} from '../src/index'

/** Realistische metadata zoals de SQLite-provider die levert. */
function sampleMeta(): TableMetadata {
  return {
    columns: [
      { name: 'id', dataType: 'INTEGER', nullable: false, defaultValue: null, isIdentity: true, isComputed: false, isPrimaryKey: true, ordinalPosition: 1 },
      { name: 'naam', dataType: 'TEXT', nullable: false, defaultValue: null, isIdentity: false, isComputed: false, isPrimaryKey: false, ordinalPosition: 2 },
      { name: 'email', dataType: 'TEXT', nullable: true, defaultValue: null, isIdentity: false, isComputed: false, isPrimaryKey: false, ordinalPosition: 3 },
      { name: 'actief', dataType: 'INTEGER', nullable: true, defaultValue: '1', isIdentity: false, isComputed: false, isPrimaryKey: false, ordinalPosition: 4 }
    ],
    primaryKey: ['id'],
    foreignKeys: [
      {
        name: 'fk_orders_user_id',
        columns: ['user_id'],
        referencedTable: 'users',
        referencedSchema: 'main',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION'
      }
    ],
    indexes: [
      { name: 'sqlite_autoindex_klanten_1', columns: ['id'], isUnique: true, isPrimaryKey: true },
      { name: 'idx_klanten_email', columns: ['email'], isUnique: true },
      { name: 'idx_klanten_naam', columns: ['naam'], isUnique: false }
    ],
    constraints: [
      { name: 'pk', type: 'PRIMARY KEY', definition: 'id' },
      { name: 'default_actief', type: 'DEFAULT', definition: '1' }
    ],
    triggers: [],
    dependencies: [],
    rowCount: 2
  }
}

describe('buildCreateTable', () => {
  it('genereert CREATE TABLE met identity PK, UNIQUE en DEFAULT (sqlite)', () => {
    const sql = buildCreateTable('sqlite', 'klanten', null, sampleMeta())
    expect(sql).toContain('CREATE TABLE "klanten" (')
    expect(sql).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL')
    expect(sql).toContain('"naam" TEXT NOT NULL')
    expect(sql).toContain('"actief" INTEGER DEFAULT 1')
    // unieke index → UNIQUE-constraint; niet-unieke index → losse CREATE INDEX
    expect(sql).toContain('UNIQUE ("email")')
    expect(sql).toContain('CREATE INDEX "idx_klanten_naam" ON "klanten" ("naam");')
    expect(sql).not.toContain('sqlite_autoindex_')
    expect(sql).not.toContain('PRIMARY KEY (')
  })

  it('gebruikt schema-qualified naam', () => {
    const sql = buildCreateTable('postgres', 'klanten', 'public', sampleMeta())
    expect(sql).toContain('CREATE TABLE "public"."klanten" (')
  })

  it('dialect-quoting per type (tsql, mysql, postgres)', () => {
    const tsql = buildCreateTable('tsql', 'klanten', 'dbo', sampleMeta())
    expect(tsql).toContain('CREATE TABLE [dbo].[klanten] (')
    expect(tsql).toContain('[id] INTEGER IDENTITY(1,1) NOT NULL')
    expect(tsql).toContain('CREATE INDEX [idx_klanten_naam] ON [dbo].[klanten] ([naam]);')

    const mysql = buildCreateTable('mysql', 'klanten', 'app', sampleMeta())
    expect(mysql).toContain('CREATE TABLE `app`.`klanten` (')
    expect(mysql).toContain('`id` INTEGER AUTO_INCREMENT NOT NULL')

    const pg = buildCreateTable('postgres', 'klanten', 'public', sampleMeta())
    expect(pg).toContain('"id" INTEGER GENERATED ALWAYS AS IDENTITY NOT NULL')
  })

  it('bevat FOREIGN KEY met acties en referenced-quoting', () => {
    const meta = sampleMeta()
    meta.columns.push({
      name: 'user_id',
      dataType: 'INTEGER',
      nullable: true,
      defaultValue: null,
      isIdentity: false,
      isComputed: false,
      isPrimaryKey: false,
      ordinalPosition: 5
    })
    meta.foreignKeys[0]!.columns = ['user_id']
    const sql = buildCreateTable('sqlite', 'orders', 'main', meta)
    expect(sql).toContain(
      'FOREIGN KEY ("user_id") REFERENCES "main"."users" ("id") ON DELETE CASCADE'
    )
    // NO ACTION acties worden weggelaten
    expect(sql).not.toContain('ON UPDATE')
  })

  it('geeft tabel-level PRIMARY KEY bij samengestelde of niet-identity PK', () => {
    const meta = sampleMeta()
    meta.columns[0] = { ...meta.columns[0]!, isIdentity: false, isPrimaryKey: true }
    meta.columns.push({
      name: 'versie',
      dataType: 'INTEGER',
      nullable: false,
      defaultValue: null,
      isIdentity: false,
      isComputed: false,
      isPrimaryKey: true,
      ordinalPosition: 5
    })
    meta.primaryKey = ['id', 'versie']
    const sql = buildCreateTable('sqlite', 'klanten', null, meta)
    expect(sql).toContain('PRIMARY KEY ("id", "versie")')
    expect(sql).not.toContain('AUTOINCREMENT')
  })
})

describe('scriptSelect / scriptInsert / scriptUpdate / scriptDelete', () => {
  it('SELECT met expliciete kolommen en dialect-quoting', () => {
    expect(scriptSelect('sqlite', 'klanten', null, ['id', 'naam'])).toBe(
      'SELECT "id", "naam"\nFROM "klanten";'
    )
    expect(scriptSelect('tsql', 'klanten', 'dbo', ['id'])).toBe('SELECT [id]\nFROM [dbo].[klanten];')
    expect(scriptSelect('mysql', 'klanten', 'app', ['id'])).toBe('SELECT `id`\nFROM `app`.`klanten`;')
  })

  it('SELECT valt terug op * zonder kolommen', () => {
    expect(scriptSelect('postgres', 'klanten', 'public', [])).toBe('SELECT *\nFROM "public"."klanten";')
  })

  it('INSERT met kolomlijst en placeholders', () => {
    expect(scriptInsert('sqlite', 'klanten', null, ['naam', 'email'])).toBe(
      'INSERT INTO "klanten" ("naam", "email")\nVALUES (?, ?);'
    )
  })

  it('UPDATE zet niet-PK-kolommen en gebruikt PK in WHERE', () => {
    expect(scriptUpdate('sqlite', 'klanten', null, ['id', 'naam', 'email'], ['id'])).toBe(
      'UPDATE "klanten"\nSET "naam" = ?, "email" = ?\nWHERE "id" = ?;'
    )
  })

  it('UPDATE zonder PK geeft invulbare WHERE met waarschuwing', () => {
    const sql = scriptUpdate('sqlite', 'klanten', null, ['naam'], [])
    expect(sql).toContain('WHERE <voorwaarde>;')
    expect(sql).toContain('geen primary key gevonden')
  })

  it('DELETE op PK-basis', () => {
    expect(scriptDelete('sqlite', 'klanten', null, ['id'])).toBe(
      'DELETE FROM "klanten"\nWHERE "id" = ?;'
    )
  })

  it('DELETE zonder PK geeft invulbare WHERE', () => {
    expect(scriptDelete('postgres', 'klanten', 'public', [])).toContain('WHERE <voorwaarde>;')
  })
})

describe('scriptObject (dispatch)', () => {
  it('SELECT genereert expliciete kolommen uit metadata', () => {
    expect(scriptObject('SELECT', 'sqlite', 'klanten', null, sampleMeta())).toBe(
      'SELECT "id", "naam", "email", "actief"\nFROM "klanten";'
    )
  })

  it('INSERT laat identity-kolommen buiten de kolomlijst', () => {
    expect(scriptObject('INSERT', 'sqlite', 'klanten', null, sampleMeta())).toBe(
      'INSERT INTO "klanten" ("naam", "email", "actief")\nVALUES (?, ?, ?);'
    )
  })

  it('UPDATE gebruikt primary key als WHERE-basis', () => {
    const sql = scriptObject('UPDATE', 'sqlite', 'klanten', null, sampleMeta())
    expect(sql).toBe(
      'UPDATE "klanten"\nSET "naam" = ?, "email" = ?, "actief" = ?\nWHERE "id" = ?;'
    )
  })

  it('DELETE op primary key', () => {
    expect(scriptObject('DELETE', 'sqlite', 'klanten', null, sampleMeta())).toBe(
      'DELETE FROM "klanten"\nWHERE "id" = ?;'
    )
  })

  it('CREATE routeert naar buildCreateTable', () => {
    expect(scriptObject('CREATE', 'sqlite', 'klanten', null, sampleMeta())).toContain(
      'CREATE TABLE "klanten" ('
    )
  })

  it('gooit bij onbekende kind', () => {
    expect(() =>
      scriptObject('DROP' as never, 'sqlite', 'klanten', null, sampleMeta())
    ).toThrow(/Onbekende ScriptKind/)
  })
})
