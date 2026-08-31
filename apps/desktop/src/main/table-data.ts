/**
 * Table Data Viewer/Editor (F2-1, eis 8).
 *
 * - getRows: SELECT Top N met de provider (rechtstreeks, zonder history).
 * - edit: genereert dialect-correcte UPDATE/INSERT/DELETE op basis van de
 *   primary key (via @nvag/sql-dialect) en voert die uit met een
 *   environment-safety-check. De uitgevoerde SQL wordt teruggegeven zodat
 *   de UI altijd zichtbaar maakt welke SQL draait.
 */

import type {
  QueryCellValue,
  TableDataResult,
  TableEditRequest,
  TableEditResult
} from '@nvag/contracts'
import {
  buildDeleteByPk,
  buildInsertValues,
  buildUpdateByPk,
  buildSelectStar
} from '@nvag/sql-dialect'
import { registry } from './registry'
import { sessionManager } from './session-manager'

function requireSession(connectionId: string) {
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
  }
  return { session, provider: registry.get(session.providerId) }
}

/** SELECT Top N voor een tabel (F2-1). */
export async function getTableRows(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
  maxRows = 100
): Promise<TableDataResult> {
  const { session, provider } = requireSession(connectionId)
  const dialect = provider.capabilities.dialect
  const sql = buildSelectStar(dialect, table, schema || undefined, maxRows)

  // Metadata voor PK + bewerkbare kolommen.
  const meta = await provider.getTableMetadata(session, database, schema || 'main', table)
  const editableColumns = meta.columns
    .filter((c) => !c.isIdentity && !c.isComputed)
    .map((c) => c.name)

  const columns: { name: string; dataType?: string }[] = []
  const rows: { values: QueryCellValue[] }[] = []
  let rowCount = 0
  let truncated = false
  for await (const chunk of provider.executeQuery(session, sql, { maxRows })) {
    if (chunk.kind === 'columns') columns.push(...chunk.columns)
    else if (chunk.kind === 'rows') {
      rows.push(...chunk.rows)
      rowCount += chunk.rows.length
    } else if (chunk.kind === 'done') {
      if (chunk.truncated) truncated = true
    } else if (chunk.kind === 'error') {
      throw new Error(chunk.message)
    }
  }

  return {
    columns,
    rows,
    truncated,
    rowCount,
    primaryKey: meta.primaryKey,
    editableColumns
  }
}

/** Voert een gegenereerde tabelbewerking uit (F2-1). */
export async function editTableRow(req: TableEditRequest): Promise<
  TableEditResult & { blocked?: string[]; guardSeverity?: 'warn' | 'confirm' }
> {
  const { session, provider } = requireSession(req.connectionId)
  const dialect = provider.capabilities.dialect
  const schema = req.schema || null

  let sql: string
  switch (req.kind) {
    case 'update':
      sql = buildUpdateByPk(dialect, req.table, schema, Object.keys(req.pkValues), req.pkValues, req.values)
      break
    case 'insert':
      sql = buildInsertValues(dialect, req.table, schema, req.values)
      break
    case 'delete':
      sql = buildDeleteByPk(dialect, req.table, schema, Object.keys(req.pkValues), req.pkValues)
      break
    default: {
      const exhaustive: never = req.kind
      throw new Error(`Onbekende bewerkingssoort: ${String(exhaustive)}`)
    }
  }

  // Environment-safety (F2-1): de guard-check gebeurt in de IPC-laag
  // (ipc.ts heeft toegang tot connectionStore); hier alleen genereren +
  // uitvoeren. De geretourneerde SQL is altijd zichtbaar voor de gebruiker.

  let rowCount = 0
  for await (const chunk of provider.executeQuery(session, sql, {})) {
    if (chunk.kind === 'done') rowCount = chunk.rowCount
    if (chunk.kind === 'error') throw new Error(chunk.message)
  }
  return { rowCount, sql }
}
