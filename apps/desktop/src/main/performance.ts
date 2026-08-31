/**
 * Query Performance (F2-4, eis 11).
 *
 * - `getStats` retourneert de statistieken van de laatst uitgevoerde query
 *   op een verbinding (elapsed, rows) en draait, wanneer SQL is meegegeven,
 *   een EXPLAIN-analyse bij providers die dat ondersteunen
 *   (`supportsExecutionPlans`-capability; PG/MySQL JSON, overige raw).
 *
 * Providers die echte CPU/rows-read rapporteren, vullen die via hun
 * `getExecutionStats`; de runner plakt ze aan het done-chunk.
 */

import type {
  ExplainPlanNode,
  ExplainResult,
  QueryPerformanceStats
} from '@nvag/contracts'
import { registry } from './registry'
import { sessionManager } from './session-manager'

function requireSession(connectionId: string) {
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
  }
  return { session, provider: registry.get(session.providerId) }
}

/** EXPLAIN-voorvoegsel per dialect (JSON waar de provider dat kan). */
function explainPrefix(dialect: string): string {
  switch (dialect) {
    case 'postgres':
      return 'EXPLAIN (ANALYZE false, FORMAT JSON)'
    case 'mysql':
      return 'EXPLAIN FORMAT=JSON'
    case 'tsql':
      return 'SET SHOWPLAN_ALL ON;'
    case 'db2':
      return 'EXPLAIN PLAN FOR'
    default:
      return 'EXPLAIN'
  }
}

/**
 * Parse PostgreSQL/MySQL JSON-EXPLAIN naar een operatorenboom (F3-1 gebruikt
 * dit voor de visuele weergave).
 */
export function parseExplainJson(raw: string, dialect: string): ExplainPlanNode[] | undefined {
  try {
    const parsed = JSON.parse(raw)
    const nodes = Array.isArray(parsed) ? parsed : [parsed]
    const plan = nodes.find((n) => n && typeof n === 'object' && n.Plan)
    if (!plan?.Plan) return undefined
    return [convertPlanNode(plan.Plan, dialect)]
  } catch {
    return undefined
  }
}

function convertPlanNode(node: Record<string, unknown>, dialect: string): ExplainPlanNode {
  const children: ExplainPlanNode[] = []
  const rawChildren =
    dialect === 'postgres'
      ? (node['Plans'] as Record<string, unknown>[] | undefined)
      : node['children'] as unknown
  if (Array.isArray(rawChildren)) {
    for (const child of rawChildren) {
      if (child && typeof child === 'object') {
        children.push(convertPlanNode(child as Record<string, unknown>, dialect))
      }
    }
  }
  return {
    operator: String(node['Node Type'] ?? node['operation'] ?? '?'),
    detail: typeof node['Relation Name'] === 'string' ? String(node['Relation Name']) : undefined,
    cost: toNumber(node['Total Cost'] ?? node['cost']),
    rows: toNumber(node['Actual Rows'] ?? node['rows'] ?? node['cardinality']),
    width: toNumber(node['Plan Width'] ?? node['width']),
    children
  }
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

/** Haalt een EXPLAIN-resultaat op (F2-4 / F3-1). */
export async function getExplain(
  connectionId: string,
  sql: string
): Promise<ExplainResult | undefined> {
  const { session, provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsExecutionPlans) return undefined
  const dialect = provider.capabilities.dialect
  const prefix = explainPrefix(dialect)
  if (dialect === 'tsql') {
    // SHOWPLAN_ALL vereist een eigen sessie-instelling; we draaien de query
    // met het voorvoegsel en vangen de plan-rijen.
    try {
      const chunks: string[] = []
      for await (const chunk of provider.executeQuery(session, `${prefix} ${sql}`, {})) {
        if (chunk.kind === 'rows') {
          for (const row of chunk.rows) {
            chunks.push(row.values.map((v) => (v === null ? 'NULL' : String(v))).join('\t'))
          }
        }
        if (chunk.kind === 'error') throw new Error(chunk.message)
      }
      return { dialect, raw: chunks.join('\n') }
    } catch {
      return undefined
    }
  }
  try {
    const chunks: string[] = []
    for await (const chunk of provider.executeQuery(session, `${prefix} ${sql}`, {})) {
      if (chunk.kind === 'rows') {
        for (const row of chunk.rows) {
          chunks.push(row.values.map((v) => (v === null ? 'NULL' : String(v))).join('\t'))
        }
      }
      if (chunk.kind === 'error') throw new Error(chunk.message)
    }
    const raw = chunks.join('\n')
    const plan = parseExplainJson(raw, dialect)
    return { dialect, raw, plan }
  } catch {
    return undefined
  }
}

/** Statistische basisgegevens voor de laatst uitgevoerde query (of leeg). */
export async function getStats(
  connectionId: string,
  sql?: string
): Promise<QueryPerformanceStats & { explain?: ExplainResult }> {
  const { session, provider } = requireSession(connectionId)
  const start = performance.now()
  let rowsReturned = 0
  if (sql) {
    try {
      for await (const chunk of provider.executeQuery(session, sql, { maxRows: 1 })) {
        if (chunk.kind === 'rows') rowsReturned += chunk.rows.length
        if (chunk.kind === 'error') throw new Error(chunk.message)
      }
    } catch {
      rowsReturned = 0
    }
  }
  const elapsedMs = Math.round(performance.now() - start)
  const explain = sql ? await getExplain(connectionId, sql) : undefined
  return { elapsedMs, rowsReturned, ...(explain ? { explain } : {}) }
}
