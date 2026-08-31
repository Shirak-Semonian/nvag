/**
 * Query Runner — voert queries uit via de provider en bouwt een
 * compleet QueryRunResponse voor de renderer.
 *
 * F0: buffert rijen (maxRows-cap, ADR-007); streaming in F1.
 */

import { randomUUID } from 'node:crypto'
import type {
  QueryColumn,
  QueryRow,
  QueryRunResponse,
  QueryStats
} from '@nvag/contracts'
import { registry } from './registry'
import { sessionManager } from './session-manager'

export interface RunRequest {
  connectionId: string
  sql: string
  maxRows?: number
}

export class QueryRunner {
  private running = new Map<string, { cancel: () => Promise<void> }>()

  async run(req: RunRequest): Promise<QueryRunResponse> {
    const session = sessionManager.getByConnectionId(req.connectionId)
    if (!session) {
      throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
    }
    const provider = registry.get(session.providerId)
    const executionId = randomUUID()

    const columns: QueryColumn[] = []
    const rows: QueryRow[] = []
    let rowCount = 0
    let error: string | undefined
    let errorPosition: QueryRunResponse['errorPosition']
    let truncated = false
    let durationMs = 0

    const maxRows = req.maxRows ?? provider.capabilities.maxResultRowsDefault

    try {
      const iter = provider.executeQuery(session, req.sql, { maxRows })
      for await (const chunk of iter) {
        if (chunk.kind === 'columns') {
          columns.push(...chunk.columns)
        } else if (chunk.kind === 'rows') {
          for (const row of chunk.rows) {
            if (rows.length >= maxRows) {
              truncated = true
              break
            }
            rows.push(row)
            rowCount++
          }
        } else if (chunk.kind === 'done') {
          durationMs = chunk.durationMs
          if (rowCount === 0 && chunk.rowCount > 0) rowCount = chunk.rowCount
        } else if (chunk.kind === 'error') {
          error = chunk.message
          errorPosition = chunk.position
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }

    return {
      executionId,
      columns,
      rows,
      truncated,
      rowCount,
      durationMs,
      error,
      errorPosition
    }
  }

  async cancel(executionId: string): Promise<void> {
    const entry = this.running.get(executionId)
    if (entry) await entry.cancel()
  }

  getStats(_executionId: string): Promise<QueryStats> {
    return Promise.resolve({ rowCount: 0, durationMs: 0 })
  }
}

export const queryRunner = new QueryRunner()
