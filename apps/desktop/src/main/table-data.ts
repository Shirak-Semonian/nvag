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
  DatabaseProvider,
  DbSession,
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
import { randomUUID } from 'node:crypto'
import { registry } from './registry'
import { sessionManager } from './session-manager'

function requireSession(connectionId: string): { session: DbSession; provider: DatabaseProvider } {
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error('No active session for this connection. Open the connection first.')
  }
  return { session, provider: registry.get(session.providerId) }
}

/**
 * SAL-42: standaard timeout voor tabeldata-query's. Een niet-reagerende
 * database (netwerk-issue, geblokkeerde query op de server) mag het paneel
 * niet eeuwig op "Laden…" laten staan.
 */
export const DEFAULT_TABLE_QUERY_TIMEOUT_MS = 30_000

/** Fouttekst bij een tabeldata-timeout (SAL-42; ook in tests gebruikt). */
export function tableQueryTimeoutMessage(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  return `Table data query took longer than ${seconds} second${seconds === 1 ? '' : 's'} and was stopped. Check the connection and try again.`
}

/** SELECT Top N voor een tabel (F2-1). */
export async function getTableRows(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
  maxRows = 100,
  timeoutMs = DEFAULT_TABLE_QUERY_TIMEOUT_MS
): Promise<TableDataResult> {
  const { session, provider } = requireSession(connectionId)
  const dialect = provider.capabilities.dialect
  const sql = buildSelectStar(dialect, table, schema || undefined, maxRows)

  // SAL-42: hang-preventie via de bestaande cancel-infrastructuur (SAL-33):
  // executionId + AbortSignal + provider.cancel. Bij een timeout wordt eerst
  // de server-side query geannuleerd (waar de provider dat ondersteunt) en
  // daarna de stream afgebroken.
  const executionId = randomUUID()
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const abortForTimeout = (): void => {
    timedOut = true
    try {
      void provider.cancel(session, executionId).catch(() => {
        // Cancel kan falen (niet ondersteund / request al klaar); de abort
        // hieronder maakt de stream alsnog vrij.
      })
    } catch {
      // Cancel niet beschikbaar; abort volstaat voor de lokale stream.
    }
    controller.abort()
  }
  if (timeoutMs > 0) {
    timer = setTimeout(abortForTimeout, timeoutMs)
  }

  try {
    // Metadata voor PK + bewerkbare kolommen.
    const meta = await provider.getTableMetadata(session, database, schema || 'main', table)
    if (timedOut) {
      throw new Error(tableQueryTimeoutMessage(timeoutMs))
    }
    const editableColumns = meta.columns
      .filter((c) => !c.isIdentity && !c.isComputed)
      .map((c) => c.name)

    const columns: { name: string; dataType?: string }[] = []
    const rows: { values: QueryCellValue[] }[] = []
    let rowCount = 0
    let truncated = false
    for await (const chunk of provider.executeQuery(session, sql, { maxRows, executionId, signal: controller.signal })) {
      // Na een timeout geen chunks meer verwerken; de query is geannuleerd.
      if (timedOut) {
        throw new Error(tableQueryTimeoutMessage(timeoutMs))
      }
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
    if (timedOut) {
      throw new Error(tableQueryTimeoutMessage(timeoutMs))
    }

    return {
      columns,
      rows,
      truncated,
      rowCount,
      primaryKey: meta.primaryKey,
      editableColumns
    }
  } finally {
    if (timer) clearTimeout(timer)
    controller.abort()
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
      throw new Error(`Unknown edit type: ${String(exhaustive)}`)
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
