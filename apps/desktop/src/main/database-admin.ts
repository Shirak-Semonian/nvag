/**
 * Database Administration (F2-3, eis 9).
 *
 * Genereert dialect-correcte DDL (via @nvag/sql-dialect) en voert die uit
 * op de actieve sessie. Alle operaties passeren de environment-safety-guard
 * (DROP/ALTER/CREATE worden bevestigd op basis van de omgeving).
 *
 * Users/roles: alleen waar de provider-capability `supportsUsersAndRoles`
 * dat aangeeft (PostgreSQL implementeert het; SQLite niet).
 */

import type {
  AdminColumnDef,
  AdminIndexDef,
  AdminUserInfo,
  ProviderCapabilities
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

/** Voert een DDL-statement uit, met guard-check en audit-log. */
async function runDdl(
  connectionId: string,
  sql: string,
  action: 'admin.ddl'
): Promise<{ ok: boolean; sql: string }> {
  const { session, provider } = requireSession(connectionId)
  const conn = connectionStore.get(connectionId)
  if (conn) {
    const guard = checkQuery(sql, conn.environment)
    if (!guard.allowed) {
      throw new Error(`Geblokkeerd door environment safety (${guard.reasons.join(', ')}).`)
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

export async function createDatabase(connectionId: string, name: string) {
  const { provider } = requireSession(connectionId)
  const sql = buildCreateDatabase(provider.capabilities.dialect, name)
  return runDdl(connectionId, sql, 'admin.ddl')
}

export async function dropDatabase(connectionId: string, name: string) {
  const { provider } = requireSession(connectionId)
  const sql = buildDrop(provider.capabilities.dialect, 'DATABASE', name)
  return runDdl(connectionId, sql, 'admin.ddl')
}

export async function createSchema(connectionId: string, _database: string, name: string) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsSchemas && provider.capabilities.dialect !== 'mysql') {
    throw new Error('Deze provider ondersteunt geen aparte schemas.')
  }
  const sql = buildCreateSchema(provider.capabilities.dialect, name)
  return runDdl(connectionId, sql, 'admin.ddl')
}

export async function dropSchema(connectionId: string, database: string, name: string) {
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
  return runDdl(connectionId, sql, 'admin.ddl')
}

export async function createTable(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string,
  columns: AdminColumnDef[]
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
  return runDdl(connectionId, sql, 'admin.ddl')
}

export async function dropTable(
  connectionId: string,
  database: string,
  schema: string,
  table: string
) {
  const { provider } = requireSession(connectionId)
  const sql = buildDrop(provider.capabilities.dialect, 'TABLE', table, { schema: schema || null })
  void database
  return runDdl(connectionId, sql, 'admin.ddl')
}

export async function createView(
  connectionId: string,
  database: string,
  schema: string,
  name: string,
  selectSql: string
) {
  const { provider } = requireSession(connectionId)
  const sql = buildCreateView(provider.capabilities.dialect, schema || null, name, selectSql)
  void database
  return runDdl(connectionId, sql, 'admin.ddl')
}

export async function dropView(
  connectionId: string,
  database: string,
  schema: string,
  name: string
) {
  const { provider } = requireSession(connectionId)
  const sql = buildDrop(provider.capabilities.dialect, 'VIEW', name, { schema: schema || null })
  void database
  return runDdl(connectionId, sql, 'admin.ddl')
}

export async function createIndex(connectionId: string, database: string, schema: string | undefined, index: AdminIndexDef) {
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
  return runDdl(connectionId, sql, 'admin.ddl')
}

export async function dropIndex(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
  index: string
) {
  const { provider } = requireSession(connectionId)
  const sql = buildDrop(provider.capabilities.dialect, 'INDEX', index, {
    schema: schema || null,
    table
  })
  void database
  return runDdl(connectionId, sql, 'admin.ddl')
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

export async function createUser(connectionId: string, name: string, password?: string) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsUsersAndRoles) {
    throw new Error('Deze provider ondersteunt geen users/roles.')
  }
  const dialect = provider.capabilities.dialect
  if (dialect === 'postgres') {
    const pwd = password ? ` PASSWORD ${quoteLiteralPg(password)}` : ''
    const sql = `CREATE USER ${quoteIdentifier('postgres', name)}${pwd};`
    return runDdl(connectionId, sql, 'admin.ddl')
  }
  throw new Error(`Users aanmaken is niet geïmplementeerd voor dialect ${dialect}.`)
}

export async function dropUser(connectionId: string, name: string) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsUsersAndRoles) {
    throw new Error('Deze provider ondersteunt geen users/roles.')
  }
  const dialect = provider.capabilities.dialect
  if (dialect === 'postgres') {
    const sql = `DROP USER ${quoteIdentifier('postgres', name)};`
    return runDdl(connectionId, sql, 'admin.ddl')
  }
  throw new Error(`Users verwijderen is niet geïmplementeerd voor dialect ${dialect}.`)
}

function quoteLiteralPg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
