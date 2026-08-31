/**
 * Schema Compare + Data Compare (F3-3, eis 15 + 16).
 *
 * Vergelijkt twee verbindingen (bron → doel) op schema- en dataniveau en
 * genereert een deployment-script (CREATE TABLE / ALTER TABLE ADD COLUMN)
 * voor ontbrekende objecten/kolommen. Werkt via de provider-metadata,
 * dus provider-agnostisch.
 */

import type { ColumnInfo, DbSession, TableInfo } from '@nvag/contracts'
import { buildCreateTableFromColumns, quoteIdentifier } from '@nvag/sql-dialect'
import { registry } from './registry'
import { sessionManager } from './session-manager'

export interface SchemaDiff {
  /** Tabellen die alleen in de bron bestaan. */
  tablesOnlyInSource: string[]
  /** Tabellen die alleen in het doel bestaan. */
  tablesOnlyInTarget: string[]
  /** Gemeenschappelijke tabellen met kolomverschillen. */
  columnDiffs: {
    table: string
    sourceColumns: ColumnInfo[]
    targetColumns: ColumnInfo[]
    /** Kolomnamen die in de bron ontbreken in het doel. */
    missingInTarget: string[]
    /** Kolomnamen die in het doel ontbreken in de bron. */
    missingInSource: string[]
  }[]
  /** Totaal aantal ontbrekende tabellen in het doel. */
  missingTables: number
  /** Totaal aantal ontbrekende kolommen in het doel. */
  missingColumns: number
}

export interface DataDiff {
  table: string
  sourceRowCount: number
  targetRowCount: number
  /** true wanneer de aantallen verschillen. */
  differs: boolean
}

function requireSession(connectionId: string) {
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error(`Geen actieve sessie voor verbinding ${connectionId}. Open eerst de verbinding.`)
  }
  return { session, provider: registry.get(session.providerId) }
}

async function listTables(session: DbSession, schema?: string): Promise<TableInfo[]> {
  const provider = registry.get(session.providerId)
  return provider.listTables(session, session.database, schema)
}

/** Vergelijkt schema's tussen bron en doel (F3-3, eis 15). */
export async function compareSchemas(
  sourceConnectionId: string,
  sourceSchema: string | undefined,
  targetConnectionId: string,
  targetSchema: string | undefined
): Promise<SchemaDiff> {
  const source = requireSession(sourceConnectionId)
  const target = requireSession(targetConnectionId)

  const [sourceTables, targetTables] = await Promise.all([
    listTables(source.session, sourceSchema),
    listTables(target.session, targetSchema)
  ])
  const sourceNames = new Set(sourceTables.map((t) => t.name))
  const targetNames = new Set(targetTables.map((t) => t.name))

  const tablesOnlyInSource = sourceTables.map((t) => t.name).filter((n) => !targetNames.has(n))
  const tablesOnlyInTarget = targetTables.map((t) => t.name).filter((n) => !sourceNames.has(n))
  const common = sourceTables.map((t) => t.name).filter((n) => targetNames.has(n))

  const columnDiffs: SchemaDiff['columnDiffs'] = []
  for (const table of common) {
    const [sourceMeta, targetMeta] = await Promise.all([
      source.provider.getTableMetadata(source.session, source.session.database, sourceSchema ?? 'main', table),
      target.provider.getTableMetadata(target.session, target.session.database, targetSchema ?? 'main', table)
    ])
    const sourceCols = new Map(sourceMeta.columns.map((c) => [c.name, c]))
    const targetCols = new Map(targetMeta.columns.map((c) => [c.name, c]))
    const missingInTarget = sourceMeta.columns.map((c) => c.name).filter((n) => !targetCols.has(n))
    const missingInSource = targetMeta.columns.map((c) => c.name).filter((n) => !sourceCols.has(n))
    if (missingInTarget.length > 0 || missingInSource.length > 0) {
      columnDiffs.push({
        table,
        sourceColumns: sourceMeta.columns,
        targetColumns: targetMeta.columns,
        missingInTarget,
        missingInSource
      })
    }
  }

  const missingColumns = columnDiffs.reduce((n, d) => n + d.missingInTarget.length, 0)
  return {
    tablesOnlyInSource,
    tablesOnlyInTarget,
    columnDiffs,
    missingTables: tablesOnlyInSource.length,
    missingColumns
  }
}

/** Vergelijkt het aantal rijen van een tabel tussen bron en doel (eis 16). */
export async function compareData(
  sourceConnectionId: string,
  sourceSchema: string | undefined,
  targetConnectionId: string,
  targetSchema: string | undefined,
  table: string
): Promise<DataDiff> {
  const source = requireSession(sourceConnectionId)
  const target = requireSession(targetConnectionId)
  const sourceCount = await countRows(source.session, sourceSchema, table)
  const targetCount = await countRows(target.session, targetSchema, table)
  return { table, sourceRowCount: sourceCount, targetRowCount: targetCount, differs: sourceCount !== targetCount }
}

async function countRows(session: DbSession, _schema: string | undefined, table: string): Promise<number> {
  const provider = registry.get(session.providerId)
  const dialect = provider.capabilities.dialect
  const name = quoteIdentifier(dialect as never, table)
  let count = -1
  for await (const chunk of provider.executeQuery(session, `SELECT COUNT(*) AS n FROM ${name}`, {})) {
    if (chunk.kind === 'rows' && chunk.rows.length > 0) {
      count = Number(chunk.rows[0]?.values[0] ?? -1)
    }
    if (chunk.kind === 'error') throw new Error(chunk.message)
  }
  return count
}

/** Genereert een deployment-script (bron → doel) op basis van het verschil. */
export async function buildDeployScript(
  sourceConnectionId: string,
  sourceSchema: string | undefined,
  targetConnectionId: string,
  targetSchema: string | undefined,
  diff: SchemaDiff
): Promise<string> {
  const source = requireSession(sourceConnectionId)
  const target = requireSession(targetConnectionId)
  const dialect = target.provider.capabilities.dialect
  const stmts: string[] = []

  for (const table of diff.tablesOnlyInSource) {
    const meta = await source.provider.getTableMetadata(source.session, source.session.database, sourceSchema ?? 'main', table)
    const cols = meta.columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      length: c.length,
      precision: c.precision,
      scale: c.scale,
      nullable: c.nullable,
      primaryKey: c.isPrimaryKey,
      defaultValue: c.defaultValue ?? undefined
    }))
    stmts.push(buildCreateTableFromColumns(dialect, table, targetSchema ?? null, cols))
  }

  for (const d of diff.columnDiffs) {
    for (const colName of d.missingInTarget) {
      const col = d.sourceColumns.find((c) => c.name === colName)
      if (!col) continue
      let type = col.dataType.toUpperCase()
      if (col.length !== undefined && col.length !== null) type = `${type}(${col.length})`
      else if (col.precision !== undefined && col.precision !== null) {
        type = col.scale != null ? `${type}(${col.precision},${col.scale})` : `${type}(${col.precision})`
      }
      const qName = quoteIdentifier(dialect as never, d.table)
      const qCol = quoteIdentifier(dialect as never, col.name)
      stmts.push(`ALTER TABLE ${qName} ADD ${qCol} ${type}${col.nullable ? '' : ' NOT NULL'};`)
    }
  }

  return stmts.length > 0 ? stmts.join('\n\n') : '-- Geen wijzigingen gevonden.'
}
