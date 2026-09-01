/**
 * Database Administration (F2-3, eis 9).
 *
 * Genereert dialect-correcte DDL (via @nvag/sql-dialect) en voert die uit
 * op de actieve sessie. Alle operaties passeren de environment-safety-guard
 * met dezelfde semantiek als de query-runner (F1-8):
 * - `warn`-niveau (CREATE buiten PROD): uitvoeren mét waarschuwing.
 * - `confirm`-niveau (DROP/ALTER, of alles op PROD): blokkeren tot de
 *   gebruiker bevestigt (via de AdminDialog; `confirmed: true`).
 *
 * Users/roles: alleen waar de provider-capability `supportsUsersAndRoles`
 * dat aangeeft (PostgreSQL implementeert het; SQLite niet).
 */

import type {
  AdminActionResult,
  AdminColumnDef,
  AdminIndexDef,
  AdminUserInfo,
  BackupResult,
  ProviderCapabilities,
  RestoreResult
} from '@nvag/contracts'
import {
  buildCreateDatabase,
  buildCreateIndex,
  buildCreateSchema,
  buildCreateTableFromColumns,
  buildCreateView,
  buildDrop,
  quoteIdentifier
} from '@nvag/sql-dialect'
import { registry } from './registry'
import { sessionManager } from './session-manager'
import { checkQuery } from './security/query-guard'
import { connectionStore } from './ipc-bootstrap'

function requireSession(connectionId: string) {
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
  }
  return { session, provider: registry.get(session.providerId) }
}

export function capabilities(connectionId: string): ProviderCapabilities {
  const { provider } = requireSession(connectionId)
  return provider.capabilities
}

/**
 * Voert een DDL-statement uit met guard-check (warn/confirm-semantiek).
 * Retourneert bij een `confirm`-blokkade `{ ok: false, blocked, guardSeverity }`
 * zodat de UI een bevestiging kan tonen; de actie zelf wordt dan niet uitgevoerd.
 */
export async function runDdl(
  connectionId: string,
  sql: string,
  action: 'admin.ddl',
  confirmed?: boolean
): Promise<AdminActionResult> {
  const { session, provider } = requireSession(connectionId)
  const conn = connectionStore.get(connectionId)
  if (conn) {
    const guard = checkQuery(sql, conn.environment)
    if (!guard.allowed) {
      if (guard.severity === 'confirm' && !confirmed) {
        return { ok: false, sql, blocked: guard.reasons, guardSeverity: 'confirm' }
      }
      // warn-niveau (of bevestigde confirm): doorlopen met waarschuwing.
      if (guard.severity === 'warn') {
        try {
          for await (const chunk of provider.executeQuery(session, sql, {})) {
            if (chunk.kind === 'error') throw new Error(chunk.message)
          }
        } catch (err) {
          throw err
        }
        void action
        return { ok: true, sql, warning: guard.reasons }
      }
    }
  }
  for await (const chunk of provider.executeQuery(session, sql, {})) {
    if (chunk.kind === 'error') {
      throw new Error(chunk.message)
    }
  }
  void action
  return { ok: true, sql }
}

export async function createDatabase(connectionId: string, name: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  const sql = buildCreateDatabase(provider.capabilities.dialect, name)
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function dropDatabase(connectionId: string, name: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  const sql = buildDrop(provider.capabilities.dialect, 'DATABASE', name)
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function createSchema(connectionId: string, _database: string, name: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsSchemas && provider.capabilities.dialect !== 'mysql') {
    throw new Error('Deze provider ondersteunt geen aparte schemas.')
  }
  const sql = buildCreateSchema(provider.capabilities.dialect, name)
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function dropSchema(connectionId: string, database: string, name: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsSchemas) {
    throw new Error('Deze provider ondersteunt geen aparte schemas.')
  }
  // MySQL: database = schema.
  const sql =
    provider.capabilities.dialect === 'mysql'
      ? buildDrop('mysql', 'DATABASE', name)
      : buildDrop(provider.capabilities.dialect, 'SCHEMA', name)
  void database
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function createTable(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string,
  columns: AdminColumnDef[],
  confirmed?: boolean
) {
  const { provider } = requireSession(connectionId)
  if (columns.length === 0) {
    throw new Error('Geef minimaal één kolom op.')
  }
  const sql = buildCreateTableFromColumns(
    provider.capabilities.dialect,
    table,
    schema || null,
    columns
  )
  void database
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function dropTable(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
  confirmed?: boolean
) {
  const { provider } = requireSession(connectionId)
  const sql = buildDrop(provider.capabilities.dialect, 'TABLE', table, { schema: schema || null })
  void database
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function createView(
  connectionId: string,
  database: string,
  schema: string,
  name: string,
  selectSql: string,
  confirmed?: boolean
) {
  const { provider } = requireSession(connectionId)
  const sql = buildCreateView(provider.capabilities.dialect, schema || null, name, selectSql)
  void database
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function dropView(
  connectionId: string,
  database: string,
  schema: string,
  name: string,
  confirmed?: boolean
) {
  const { provider } = requireSession(connectionId)
  const sql = buildDrop(provider.capabilities.dialect, 'VIEW', name, { schema: schema || null })
  void database
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function createIndex(connectionId: string, database: string, schema: string | undefined, index: AdminIndexDef, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  const sql = buildCreateIndex(
    provider.capabilities.dialect,
    schema || index.schema || null,
    index.table,
    index.name,
    index.columns,
    index.unique
  )
  void database
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function dropIndex(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
  index: string,
  confirmed?: boolean
) {
  const { provider } = requireSession(connectionId)
  const sql = buildDrop(provider.capabilities.dialect, 'INDEX', index, {
    schema: schema || null,
    table
  })
  void database
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

// ---------------------------------------------------------------------------
// Users & roles (gated via capabilities)
// ---------------------------------------------------------------------------

export async function listUsers(connectionId: string): Promise<AdminUserInfo[]> {
  const { session, provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsUsersAndRoles) return []
  const dialect = provider.capabilities.dialect
  if (dialect === 'postgres') {
    const users: AdminUserInfo[] = []
    for await (const chunk of provider.executeQuery(
      session,
      `SELECT rolname AS name, rolsuper AS super FROM pg_roles WHERE rolcanlogin ORDER BY rolname`,
      {}
    )) {
      if (chunk.kind === 'rows') {
        for (const row of chunk.rows) {
          users.push({
            name: String(row.values[0] ?? ''),
            role: String(row.values[1]) === 'true' ? 'superuser' : 'login',
            canLogin: true
          })
        }
      }
      if (chunk.kind === 'error') throw new Error(chunk.message)
    }
    return users
  }
  return []
}

export async function createUser(connectionId: string, name: string, password?: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsUsersAndRoles) {
    throw new Error('Deze provider ondersteunt geen users/roles.')
  }
  const dialect = provider.capabilities.dialect
  if (dialect === 'postgres') {
    const pwd = password ? ` PASSWORD ${quoteLiteralPg(password)}` : ''
    const sql = `CREATE USER ${quoteIdentifier('postgres', name)}${pwd};`
    return runDdl(connectionId, sql, 'admin.ddl', confirmed)
  }
  throw new Error(`Users aanmaken is niet geïmplementeerd voor dialect ${dialect}.`)
}

export async function dropUser(connectionId: string, name: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsUsersAndRoles) {
    throw new Error('Deze provider ondersteunt geen users/roles.')
  }
  const dialect = provider.capabilities.dialect
  if (dialect === 'postgres') {
    const sql = `DROP USER ${quoteIdentifier('postgres', name)};`
    return runDdl(connectionId, sql, 'admin.ddl', confirmed)
  }
  throw new Error(`Users verwijderen is niet geïmplementeerd voor dialect ${dialect}.`)
}

function quoteLiteralPg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// ---------------------------------------------------------------------------
// Fase 4: Backup & Restore (DBA) — gated via `supportsBackupRestore`.
//
// Semantiek (zelfde guard-aanpak als runDdl, F2-3):
// - BACKUP is niet destructief voor de database → `warn` buiten PROD
//   (uitvoeren mét waarschuwing), op PROD `confirm`.
// - RESTORE overschrijft een database → altijd `confirm` tot bevestiging.
// ---------------------------------------------------------------------------

export async function backupDatabase(
  connectionId: string,
  database: string,
  targetPath: string,
  confirmed?: boolean
): Promise<BackupResult> {
  const { session, provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsBackupRestore || !provider.backupRestore?.backupDatabase) {
    throw new Error('Deze provider ondersteunt geen backup/restore.')
  }
  const conn = connectionStore.get(connectionId)
  if (conn && !confirmed) {
    const guard = checkQuery(`BACKUP DATABASE ${database}`, conn.environment)
    if (!guard.allowed) {
      if (guard.severity === 'confirm') {
        return {
          ok: false,
          targetPath,
          durationMs: 0,
          blocked: guard.reasons,
          guardSeverity: 'confirm'
        }
      }
      // warn-niveau buiten PROD: uitvoeren, waarschuwing meegeven.
      const result = await provider.backupRestore.backupDatabase(session, database, targetPath)
      return { ...result, blocked: undefined, guardSeverity: undefined, message: result.message ?? guard.reasons.join(', ') }
    }
  }
  return provider.backupRestore.backupDatabase(session, database, targetPath)
}

export async function restoreDatabase(
  connectionId: string,
  database: string,
  sourcePath: string,
  confirmed?: boolean
): Promise<RestoreResult> {
  const { session, provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsBackupRestore || !provider.backupRestore?.restoreDatabase) {
    throw new Error('Deze provider ondersteunt geen backup/restore.')
  }
  const conn = connectionStore.get(connectionId)
  if (conn && !confirmed) {
    const guard = checkQuery(`RESTORE DATABASE ${database}`, conn.environment)
    if (!guard.allowed) {
      if (guard.severity === 'confirm') {
        return {
          ok: false,
          sourcePath,
          durationMs: 0,
          blocked: guard.reasons,
          guardSeverity: 'confirm'
        }
      }
      const result = await provider.backupRestore.restoreDatabase(session, database, sourcePath)
      return { ...result, blocked: undefined, guardSeverity: undefined, message: result.message ?? guard.reasons.join(', ') }
    }
  }
  return provider.backupRestore.restoreDatabase(session, database, sourcePath)
}
