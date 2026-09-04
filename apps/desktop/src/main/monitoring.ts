/**
 * Monitoring/Activity (F3-2, eis 12).
 *
 * Actieve sessies/queries, blocking, locks en CPU per provider via de
 * dialect-specifieke catalogus-views (pg_stat_activity, SHOW PROCESSLIST,
 * sys.dm_exec_requests). Genormaliseerd naar ActivityRow voor de UI.
 */

import type { DbSession } from '@nvag/contracts'
import { registry } from './registry'
import { sessionManager } from './session-manager'

export interface ActivityRow {
  id: string
  user?: string
  database?: string
  status?: string
  durationMs?: number
  /** SQL-tekst (indien beschikbaar; afgekapt). */
  query?: string
  /** Geblokkeerd door sessie-id (blocking; indien beschikbaar). */
  blockedBy?: string
  /** CPU-tijd in ms (indien beschikbaar). */
  cpuMs?: number
  /** Aantal locks (indien beschikbaar). */
  locks?: number
}

function requireSession(connectionId: string) {
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error('No active session for this connection. Open the connection first.')
  }
  return { session, provider: registry.get(session.providerId) }
}

async function collect(
  session: DbSession,
  sql: string
): Promise<{ columns: string[]; rows: unknown[][] }> {
  const provider = registry.get(session.providerId)
  const columns: string[] = []
  const rows: unknown[][] = []
  for await (const chunk of provider.executeQuery(session, sql, {})) {
    if (chunk.kind === 'columns') columns.push(...chunk.columns.map((c) => c.name))
    else if (chunk.kind === 'rows') rows.push(...chunk.rows.map((r) => r.values))
    else if (chunk.kind === 'error') throw new Error(chunk.message)
  }
  return { columns, rows }
}

function rowObject(columns: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  columns.forEach((c, i) => {
    out[c] = row[i] ?? null
  })
  return out
}

function normalizeQuery(q: unknown): string | undefined {
  if (q === null || q === undefined) return undefined
  const s = String(q).trim()
  return s.length > 500 ? `${s.slice(0, 497)}…` : s
}

function durationOf(start: unknown): number | undefined {
  if (start === null || start === undefined) return undefined
  // PG: interval-string; anders ms-getal of tijdstempel.
  const s = String(start)
  const m = /^(\d+):(\d+):(\d+)/.exec(s)
  if (m) return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000
  const n = Number(start)
  return Number.isFinite(n) ? n : undefined
}

export async function getActiveQueries(
  connectionId: string,
  includeIdle = false
): Promise<ActivityRow[]> {
  try {
    const { session, provider } = requireSession(connectionId)
    const dialect = provider.capabilities.dialect
    if (!provider.capabilities.supportsMonitoring) return []

    switch (dialect) {
      case 'postgres': {
        const { columns, rows } = await collect(
          session,
          `SELECT pid AS id, usename AS user, datname AS database, state AS status,
                  (now() - query_start) AS duration, query,
                  COALESCE(blocking.pid::text, '') AS blocked_by,
                  extract(epoch from (now() - query_start)) * 1000 AS cpu_ms
           FROM pg_stat_activity a
           LEFT JOIN LATERAL (
             SELECT pid FROM pg_stat_activity b
             WHERE b.pid <> a.pid AND b.query_start < a.query_start
               AND b.datname = a.datname AND b.state = 'active'
             ORDER BY b.query_start LIMIT 1
           ) blocking ON true
           WHERE a.pid <> pg_backend_pid() ${includeIdle ? '' : "AND a.state <> 'idle'"}`
        )
        return rows.map((r) => {
          const o = rowObject(columns, r)
          return {
            id: String(o.id ?? ''),
            user: o.user != null ? String(o.user) : undefined,
            database: o.database != null ? String(o.database) : undefined,
            status: o.status != null ? String(o.status) : undefined,
            durationMs: durationOf(o.duration),
            query: normalizeQuery(o.query),
            blockedBy: o.blocked_by ? String(o.blocked_by) : undefined,
            cpuMs: o.cpu_ms != null ? Number(o.cpu_ms) : undefined
          }
        })
      }
      case 'mysql': {
        const { columns, rows } = await collect(session, 'SHOW PROCESSLIST')
        return rows.map((r) => {
          const o = rowObject(columns, r)
          const time = o.Time
          return {
            id: String(o.Id ?? ''),
            user: o.User != null ? String(o.User) : undefined,
            database: o.db != null && o.db !== '' ? String(o.db) : undefined,
            status: o.Command != null ? String(o.Command) : undefined,
            durationMs: time != null ? Number(time) * 1000 : undefined,
            query: normalizeQuery(o.Info)
          }
        })
      }
      case 'tsql': {
        const { columns, rows } = await collect(
          session,
          `SELECT r.session_id AS id, s.login_name AS [user], DB_NAME(r.database_id) AS [database],
                  r.status, r.total_elapsed_time AS elapsed_ms,
                  ISNULL(CAST(r.blocking_session_id AS varchar), '') AS blocked_by,
                  r.cpu_time AS cpu_ms, t.text AS query
           FROM sys.dm_exec_requests r
           JOIN sys.dm_exec_sessions s ON r.session_id = s.session_id
           CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
           WHERE r.session_id <> @@SPID ${includeIdle ? '' : "AND r.status <> 'sleeping'"}`
        )
        return rows.map((r) => {
          const o = rowObject(columns, r)
          return {
            id: String(o.id ?? ''),
            user: o.user != null ? String(o.user) : undefined,
            database: o.database != null ? String(o.database) : undefined,
            status: o.status != null ? String(o.status) : undefined,
            durationMs: o.elapsed_ms != null ? Number(o.elapsed_ms) : undefined,
            query: normalizeQuery(o.query),
            blockedBy: o.blocked_by ? String(o.blocked_by) : undefined,
            cpuMs: o.cpu_ms != null ? Number(o.cpu_ms) : undefined
          }
        })
      }
      case 'oracle': {
        const { columns, rows } = await collect(
          session,
          `SELECT s.sid AS id, s.username AS [user], s.status,
                  ROUND((SYSDATE - s.last_call_et / 86400) * 0, 0) AS elapsed,
                  q.sql_text AS query
           FROM v$session s
           LEFT JOIN v$sql q ON s.sql_id = q.sql_id
           WHERE s.type = 'USER' AND s.status = 'ACTIVE'`
        )
        return rows.map((r) => {
          const o = rowObject(columns, r)
          return {
            id: String(o.id ?? ''),
            user: o.user != null ? String(o.user) : undefined,
            status: o.status != null ? String(o.status) : undefined,
            query: normalizeQuery(o.query)
          }
        })
      }
      default:
        return []
    }
  } catch {
    return []
  }
}

/** Locks per provider (F3-2; waar beschikbaar). */
export async function getLocks(connectionId: string): Promise<unknown[]> {
  try {
    const { session, provider } = requireSession(connectionId)
    const dialect = provider.capabilities.dialect
    switch (dialect) {
      case 'postgres': {
        const { columns, rows } = await collect(
          session,
          `SELECT l.locktype, l.mode, l.granted, a.pid, COALESCE(a.usename, '') AS usename,
                  COALESCE(a.query, '') AS query
           FROM pg_locks l LEFT JOIN pg_stat_activity a ON l.pid = a.pid
           ORDER BY l.pid`
        )
        return rows.map((r) => rowObject(columns, r))
      }
      case 'mysql': {
        const { columns, rows } = await collect(
          session,
          `SELECT * FROM performance_schema.data_locks LIMIT 100`
        )
        return rows.map((r) => rowObject(columns, r))
      }
      case 'tsql': {
        const { columns, rows } = await collect(
          session,
          `SELECT request_session_id AS session_id, resource_type, request_mode, request_status,
                  resource_database_id
           FROM sys.dm_tran_locks WHERE resource_database_id = DB_ID()`
        )
        return rows.map((r) => rowObject(columns, r))
      }
      default:
        return []
    }
  } catch {
    return []
  }
}
