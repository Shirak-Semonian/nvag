/**
 * Dashboard (F2-10, eis 25).
 *
 * Verzamelt serverinfo, versie, databases (met groottes waar beschikbaar)
 * en actieve queries (via de optionele monitoring-API van de provider).
 */

import type { DashboardData, DatabaseSizeInfo } from '@nvag/contracts'
import { registry } from './registry'
import { sessionManager } from './session-manager'

function requireSession(connectionId: string) {
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
  }
  return { session, provider: registry.get(session.providerId) }
}

export async function getDashboard(connectionId: string): Promise<DashboardData> {
  const { session, provider } = requireSession(connectionId)
  const serverInfo = await provider.getServerInfo(session)

  const databases: DatabaseSizeInfo[] = []
  try {
    const dbs = await provider.listDatabases(session)
    for (const db of dbs) {
      const info: DatabaseSizeInfo = { name: db.name }
      try {
        // Groottes: probeer per dialect een maat op te halen.
        const size = await queryDatabaseSize(connectionId, db.name, provider.capabilities.dialect)
        if (size !== undefined) info.sizeBytes = size
      } catch {
        // geen maat beschikbaar
      }
      databases.push(info)
    }
  } catch {
    // databases niet beschikbaar
  }

  // Actieve queries via monitoring-API (waar ondersteund).
  let activeQueries: unknown[] = []
  if (provider.capabilities.supportsMonitoring && provider.monitoring?.getActiveQueries) {
    try {
      activeQueries = await provider.monitoring.getActiveQueries(session)
    } catch {
      activeQueries = []
    }
  }

  return { serverInfo, databases, activeQueries }
}

/** Haalt de grootte van een database op (dialect-specifiek; best-effort). */
async function queryDatabaseSize(
  connectionId: string,
  database: string,
  dialect: string
): Promise<number | undefined> {
  const { session, provider } = requireSession(connectionId)
  let sql = ''
  switch (dialect) {
    case 'postgres':
      sql = `SELECT pg_database_size('${database.replace(/'/g, "''")}') AS size`
      break
    case 'mysql':
      sql = `SELECT SUM(data_length + index_length) AS size FROM information_schema.tables WHERE table_schema = '${database.replace(/'/g, "''")}'`
      break
    case 'tsql': {
      // SQL Server: som van pagina's in sys.database_files.
      // Vereist USE; we doen een best-effort via de sessie van de provider.
      return undefined
    }
    case 'sqlite': {
      const fs = await import('node:fs')
      const stat = fs.statSync(session.database)
      return stat.size
    }
    default:
      return undefined
  }
  if (!sql) return undefined
  for await (const chunk of provider.executeQuery(session, sql, {})) {
    if (chunk.kind === 'rows' && chunk.rows.length > 0) {
      const v = chunk.rows[0]?.values[0]
      if (typeof v === 'number') return v
      if (typeof v === 'bigint') return Number(v)
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
      return undefined
    }
    if (chunk.kind === 'error') return undefined
  }
  return undefined
}
