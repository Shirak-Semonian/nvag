/**
 * Db2-catalogusqueries (SYSCAT.*) en mapping naar de contract-types (F1-9).
 *
 * DB2 LUW kent geen cross-database-catalogus: `listDatabases` retourneert de
 * huidige database (CURRENT SERVER). Naamvergelijkingen gebruiken
 * `UPPER(x) = UPPER(?)` zodat zowel gequotede (case-preserving) als
 * unquotede (naar boven gevouwen) objecten gevonden worden. Aliasnamen zijn
 * dubbelgequoted om botsingen met DB2-keywords (LENGTH, SCALE, DEFAULT, ...)
 * te vermijden.
 */

import { quoteLiteral } from '@nvag/sql-dialect'
import type {
  ColumnInfo,
  ConstraintInfo,
  DatabaseInfo,
  DependencyInfo,
  ForeignKeyInfo,
  IndexInfo,
  TableMetadata
} from '@nvag/contracts'

// ---------------------------------------------------------------------------
// Querybouwers
// ---------------------------------------------------------------------------

/** DB2: geen catalogus over databases heen — de huidige database is het enige zichtbare. */
export function listDatabasesSql(): string {
  return 'SELECT CURRENT SERVER AS "NAME" FROM SYSIBM.SYSDUMMY1'
}

export function listSchemasSql(): string {
  return (
    'SELECT SCHEMANAME AS "NAME" FROM SYSCAT.SCHEMATA ' +
    "WHERE SCHEMANAME NOT LIKE 'SYS%' AND SCHEMANAME NOT IN ('NULLID','SQLJ','SYSTOOLS') " +
    'ORDER BY SCHEMANAME'
  )
}

export function listTablesSql(schema?: string): string {
  const filter = schema ? ` AND UPPER(TABSCHEMA) = UPPER(${quoteLiteral('db2', schema)})` : ''
  return (
    `SELECT TABSCHEMA AS "SCHEMA", TABNAME AS "NAME" FROM SYSCAT.TABLES WHERE TYPE = 'T'${filter} ` +
    'ORDER BY TABSCHEMA, TABNAME'
  )
}

export function listViewsSql(schema?: string): string {
  const filter = schema ? ` AND UPPER(TABSCHEMA) = UPPER(${quoteLiteral('db2', schema)})` : ''
  return (
    `SELECT TABSCHEMA AS "SCHEMA", TABNAME AS "NAME" FROM SYSCAT.VIEWS WHERE 1 = 1${filter} ` +
    'ORDER BY TABSCHEMA, TABNAME'
  )
}

export function listProceduresSql(schema?: string): string {
  const filter = schema ? ` AND UPPER(PROCSCHEMA) = UPPER(${quoteLiteral('db2', schema)})` : ''
  return (
    `SELECT PROCSCHEMA AS "SCHEMA", PROCNAME AS "NAME" FROM SYSCAT.PROCEDURES WHERE 1 = 1${filter} ` +
    'ORDER BY PROCSCHEMA, PROCNAME'
  )
}

export function listFunctionsSql(schema?: string): string {
  const filter = schema ? ` AND UPPER(FUNCSCHEMA) = UPPER(${quoteLiteral('db2', schema)})` : ''
  return (
    `SELECT FUNCSCHEMA AS "SCHEMA", FUNCNAME AS "NAME" FROM SYSCAT.FUNCTIONS WHERE ORIGIN = 'U'${filter} ` +
    'ORDER BY FUNCSCHEMA, FUNCNAME'
  )
}

export function listTriggersSql(schema?: string): string {
  const filter = schema ? ` AND UPPER(TRIGSCHEMA) = UPPER(${quoteLiteral('db2', schema)})` : ''
  return (
    `SELECT TRIGSCHEMA AS "SCHEMA", TRIGNAME AS "NAME", TABNAME AS "TABLE" FROM SYSCAT.TRIGGERS WHERE 1 = 1${filter} ` +
    'ORDER BY TRIGSCHEMA, TRIGNAME'
  )
}

export function listSequencesSql(schema?: string): string {
  const filter = schema ? ` AND UPPER(SEQSCHEMA) = UPPER(${quoteLiteral('db2', schema)})` : ''
  return (
    `SELECT SEQSCHEMA AS "SCHEMA", SEQNAME AS "NAME" FROM SYSCAT.SEQUENCES WHERE 1 = 1${filter} ` +
    'ORDER BY SEQSCHEMA, SEQNAME'
  )
}

const bySchemaTable = (schema: string, table: string): string =>
  `UPPER(TABSCHEMA) = UPPER(${quoteLiteral('db2', schema)}) AND UPPER(TABNAME) = UPPER(${quoteLiteral('db2', table)})`

export function columnsSql(schema: string, table: string): string {
  return (
    `SELECT c.COLNAME AS "NAME", c.TYPENAME AS "DATA_TYPE", c.LENGTH AS "LENGTH", ` +
    `c.PRECISION AS "PRECISION", c.SCALE AS "SCALE", ` +
    `CASE WHEN c.NULLS = 'Y' THEN 1 ELSE 0 END AS "NULLABLE", ` +
    `c.DEFAULT AS "DEFAULT_VALUE", ` +
    `CASE WHEN c.IDENTITY = 'Y' THEN 1 ELSE 0 END AS "IS_IDENTITY", ` +
    `CASE WHEN c.GENERATED = 'A' AND c.IDENTITY <> 'Y' THEN 1 ELSE 0 END AS "IS_COMPUTED", ` +
    `c.COLNO AS "ORDINAL" ` +
    `FROM SYSCAT.COLUMNS c WHERE ${bySchemaTable(schema, table)} ORDER BY c.COLNO`
  )
}

export function primaryKeySql(schema: string, table: string): string {
  return (
    `SELECT k.COLNAME AS "NAME" FROM SYSCAT.KEYCOLUSE k ` +
    `JOIN SYSCAT.INDEXES i ON i.INDSCHEMA = k.INDSCHEMA AND i.INDNAME = k.INDNAME ` +
    `WHERE ${bySchemaTable(schema, table)} AND i.UNIQUERULE = 'P' ORDER BY k.COLSEQ`
  )
}

export function foreignKeysSql(schema: string, table: string): string {
  return (
    `SELECT fk.CONSTNAME AS "NAME", fk.COLNAME AS "COL", fk.REFTABSCHEMA AS "REF_SCHEMA", ` +
    `fk.REFTABNAME AS "REF_TABLE", fk.REFCOLNAME AS "REF_COL", fk.COLSEQ AS "ORD", ` +
    `c.DELETERULE AS "ON_DELETE", c.UPDATERULE AS "ON_UPDATE" ` +
    `FROM SYSCAT.REFERENCES fk ` +
    `JOIN SYSCAT.TABCONST c ON c.CONSTNAME = fk.CONSTNAME AND c.TABSCHEMA = fk.TABSCHEMA AND c.TABNAME = fk.TABNAME ` +
    `WHERE ${bySchemaTable(schema, table)} AND c.TYPE = 'F' ` +
    `ORDER BY fk.CONSTNAME, fk.COLSEQ`
  )
}

export function indexesSql(schema: string, table: string): string {
  return (
    `SELECT i.INDNAME AS "NAME", i.UNIQUERULE AS "UNIQUERULE", k.COLNAME AS "COL", k.COLSEQ AS "ORD" ` +
    `FROM SYSCAT.INDEXES i ` +
    `JOIN SYSCAT.INDEXCOLUSE k ON k.INDSCHEMA = i.INDSCHEMA AND k.INDNAME = i.INDNAME ` +
    `WHERE ${bySchemaTable(schema, table)} AND i.UNIQUERULE <> 'P' ` +
    `ORDER BY i.INDNAME, k.COLSEQ`
  )
}

export function checksSql(schema: string, table: string): string {
  return (
    `SELECT CONSTNAME AS "NAME", TEXT AS "DEFINITION" FROM SYSCAT.CHECKS ` +
    `WHERE ${bySchemaTable(schema, table)} ORDER BY CONSTNAME`
  )
}

export function uniqueIndexesSql(schema: string, table: string): string {
  return (
    `SELECT INDNAME AS "NAME" FROM SYSCAT.INDEXES ` +
    `WHERE ${bySchemaTable(schema, table)} AND UNIQUERULE = 'U' ORDER BY INDNAME`
  )
}

export function triggersSql(schema: string, table: string): string {
  return (
    `SELECT TRIGNAME AS "NAME" FROM SYSCAT.TRIGGERS ` +
    `WHERE ${bySchemaTable(schema, table)} ORDER BY TRIGNAME`
  )
}

/** Objecten die van deze tabel afhangen (views, triggers, MQTs). */
export function dependenciesSql(schema: string, table: string): string {
  return (
    `SELECT BSCHEMA AS "OBJECT_SCHEMA", BNAME AS "OBJECT_NAME", BTYPE AS "OBJECT_TYPE" ` +
    `FROM SYSCAT.TABDEP WHERE ${bySchemaTable(schema, table)} ORDER BY BSCHEMA, BNAME`
  )
}

/** Rijtelling via de optimizer-schatting (NUMROWS) — goedkoop, geen COUNT over de tabel. */
export function rowCountSql(schema: string, table: string): string {
  return (
    `SELECT NUMROWS AS "ROW_COUNT" FROM SYSCAT.TABLES ` +
    `WHERE ${bySchemaTable(schema, table)}`
  )
}

export function viewDefinitionSql(schema: string, view: string): string {
  return (
    `SELECT TEXT AS "DEFINITION" FROM SYSCAT.VIEWS ` +
    `WHERE UPPER(VIEWSCHEMA) = UPPER(${quoteLiteral('db2', schema)}) ` +
    `AND UPPER(VIEWNAME) = UPPER(${quoteLiteral('db2', view)})`
  )
}

export function routineDefinitionSql(schema: string, name: string, type: 'P' | 'F'): string {
  return (
    `SELECT TEXT AS "DEFINITION" FROM SYSCAT.ROUTINES ` +
    `WHERE UPPER(ROUTINESCHEMA) = UPPER(${quoteLiteral('db2', schema)}) ` +
    `AND UPPER(ROUTINENAME) = UPPER(${quoteLiteral('db2', name)}) ` +
    `AND ROUTINETYPE = '${type}'`
  )
}

// ---------------------------------------------------------------------------
// Rij-mapping (rows komen als waarden-array + kolomnamen uit de bridge)
// ---------------------------------------------------------------------------

export interface QueryRows {
  columns: string[]
  rows: unknown[][]
}

/** Rijen naar objecten (kolomnaam → waarde). */
export function rowsToObjects(q: QueryRows): Array<Record<string, unknown>> {
  return q.rows.map((row) => {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < q.columns.length; i++) {
      obj[q.columns[i]!] = row[i]
    }
    return obj
  })
}

function str(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v)
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function bool(v: unknown): boolean {
  return v === 1 || v === true
}

const FK_ACTION: Record<string, string> = {
  A: 'NO ACTION',
  C: 'CASCADE',
  R: 'RESTRICT',
  N: 'SET NULL'
}

export function mapDatabases(q: QueryRows): DatabaseInfo[] {
  return rowsToObjects(q).map((r) => ({ name: str(r.NAME) ?? '' }))
}

export function mapSchemas(q: QueryRows): Array<{ name: string }> {
  return rowsToObjects(q).map((r) => ({ name: str(r.NAME) ?? '' }))
}

export function mapTables(q: QueryRows): Array<{ name: string; schema: string; type: 'table' }> {
  return rowsToObjects(q).map((r) => ({
    name: str(r.NAME) ?? '',
    schema: str(r['SCHEMA']) ?? '',
    type: 'table'
  }))
}

export function mapViews(q: QueryRows): Array<{ name: string; schema: string }> {
  return rowsToObjects(q).map((r) => ({ name: str(r.NAME) ?? '', schema: str(r['SCHEMA']) ?? '' }))
}

export function mapProcedures(
  q: QueryRows
): Array<{ name: string; schema: string; type: 'procedure' }> {
  return rowsToObjects(q).map((r) => ({
    name: str(r.NAME) ?? '',
    schema: str(r['SCHEMA']) ?? '',
    type: 'procedure'
  }))
}

export function mapFunctions(q: QueryRows): Array<{ name: string; schema: string }> {
  return rowsToObjects(q).map((r) => ({ name: str(r.NAME) ?? '', schema: str(r['SCHEMA']) ?? '' }))
}

export function mapTriggers(
  q: QueryRows
): Array<{ name: string; schema: string; table?: string }> {
  return rowsToObjects(q).map((r) => ({
    name: str(r.NAME) ?? '',
    schema: str(r['SCHEMA']) ?? '',
    table: str(r['TABLE'])
  }))
}

export function mapSequences(q: QueryRows): Array<{ name: string; schema: string }> {
  return rowsToObjects(q).map((r) => ({ name: str(r.NAME) ?? '', schema: str(r['SCHEMA']) ?? '' }))
}

export function mapColumns(q: QueryRows): ColumnInfo[] {
  return rowsToObjects(q).map((r) => ({
    name: str(r.NAME) ?? '',
    dataType: str(r.DATA_TYPE) ?? '',
    length: num(r.LENGTH),
    precision: num(r.PRECISION),
    scale: num(r.SCALE),
    nullable: bool(r.NULLABLE),
    defaultValue:
      r.DEFAULT_VALUE === null || r.DEFAULT_VALUE === undefined
        ? null
        : (str(r.DEFAULT_VALUE) ?? null),
    isIdentity: bool(r.IS_IDENTITY),
    isComputed: bool(r.IS_COMPUTED),
    isPrimaryKey: false, // apart via primaryKeySql
    ordinalPosition: num(r.ORDINAL) ?? 0
  }))
}

export function mapForeignKeys(q: QueryRows): ForeignKeyInfo[] {
  const map = new Map<string, ForeignKeyInfo>()
  for (const r of rowsToObjects(q)) {
    const name = str(r.NAME) ?? ''
    const existing = map.get(name)
    if (existing) {
      existing.columns.push(str(r.COL) ?? '')
      existing.referencedColumns.push(str(r.REF_COL) ?? '')
    } else {
      map.set(name, {
        name,
        columns: [str(r.COL) ?? ''],
        referencedTable: str(r.REF_TABLE) ?? '',
        referencedSchema: str(r.REF_SCHEMA),
        referencedColumns: [str(r.REF_COL) ?? ''],
        onDelete: FK_ACTION[str(r.ON_DELETE) ?? ''] ?? str(r.ON_DELETE),
        onUpdate: FK_ACTION[str(r.ON_UPDATE) ?? ''] ?? str(r.ON_UPDATE)
      })
    }
  }
  return [...map.values()]
}

export function mapIndexes(q: QueryRows): IndexInfo[] {
  const map = new Map<string, IndexInfo>()
  for (const r of rowsToObjects(q)) {
    const name = str(r.NAME) ?? ''
    const existing = map.get(name)
    if (existing) existing.columns.push(str(r.COL) ?? '')
    else
      map.set(name, {
        name,
        columns: [str(r.COL) ?? ''],
        isUnique: str(r.UNIQUERULE) === 'U',
        isPrimaryKey: false
      })
  }
  return [...map.values()]
}

export function mapConstraints(
  checks: QueryRows,
  uniqueIndexes: QueryRows,
  defaults: ColumnInfo[]
): ConstraintInfo[] {
  const out: ConstraintInfo[] = []
  for (const r of rowsToObjects(checks)) {
    out.push({
      name: str(r.NAME) ?? '',
      type: 'CHECK',
      definition: str(r.DEFINITION) ?? undefined
    })
  }
  for (const r of rowsToObjects(uniqueIndexes)) {
    out.push({ name: str(r.NAME) ?? '', type: 'UNIQUE' })
  }
  for (const c of defaults) {
    if (c.defaultValue !== null && c.defaultValue !== undefined) {
      out.push({ name: `${c.name}_DEFAULT`, type: 'DEFAULT', definition: c.defaultValue })
    }
  }
  return out
}

export function mapDependencies(q: QueryRows): DependencyInfo[] {
  return rowsToObjects(q).map((r) => ({
    objectName: str(r.OBJECT_NAME) ?? '',
    objectSchema: str(r.OBJECT_SCHEMA),
    objectType: str(r.OBJECT_TYPE) ?? '',
    direction: 'used-by'
  }))
}

/** Bouw TableMetadata uit de losse catalogusquery-resultaten. */
export function assembleTableMetadata(
  columns: ColumnInfo[],
  pkRows: QueryRows,
  fkRows: QueryRows,
  idxRows: QueryRows,
  checks: QueryRows,
  uniqueIdx: QueryRows,
  trigRows: QueryRows,
  depRows: QueryRows,
  rowCount: number | undefined
): TableMetadata {
  const pkNames = rowsToObjects(pkRows).map((r) => str(r.NAME) ?? '')
  const pkSet = new Set(pkNames)
  for (const c of columns) c.isPrimaryKey = pkSet.has(c.name)
  return {
    columns,
    primaryKey: pkNames,
    foreignKeys: mapForeignKeys(fkRows),
    indexes: mapIndexes(idxRows),
    constraints: mapConstraints(checks, uniqueIdx, columns),
    triggers: rowsToObjects(trigRows).map((r) => str(r.NAME) ?? ''),
    dependencies: mapDependencies(depRows),
    rowCount
  }
}
