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
  AlterDatabaseResult,
  BackupResult,
  DatabasePropertiesResult,
  DatabaseProvider,
  DbSession,
  ProviderCapabilities,
  QueryRow,
  RestoreResult
} from '@nvag/contracts'
import {
  buildAlterDatabaseStatements,
  buildCreateDatabase,
  buildCreateIndex,
  buildCreateSchema,
  buildCreateTableFromColumns,
  buildCreateView,
  buildDrop,
  buildDropConstraint,
  quoteIdentifier,
  quoteLiteral
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
// SAL-45: DROP voor programmeerbare/schema-objecten (procedure/function/
// trigger/sequence/synonym) en constraint. Deze objecttypen zitten in de
// Object Explorer-folders (Programmability, Synonyms, Sequences,
// tabel-subobjecten); de SQL is dialect-correct via @nvag/sql-dialect en
// doorloopt dezelfde guard als de overige DROP-acties (SAL-34).
// ---------------------------------------------------------------------------

type SchemaDbObjectType = 'PROCEDURE' | 'FUNCTION' | 'TRIGGER' | 'SEQUENCE' | 'SYNONYM'

async function dropSchemaDbObject(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  objectType: SchemaDbObjectType,
  options?: { table?: string },
  confirmed?: boolean
) {
  const { provider } = requireSession(connectionId)
  const sql = buildDrop(provider.capabilities.dialect, objectType, name, {
    schema: schema || null,
    table: options?.table
  })
  void database
  return runDdl(connectionId, sql, 'admin.ddl', confirmed)
}

export async function dropProcedure(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  confirmed?: boolean
) {
  return dropSchemaDbObject(connectionId, database, schema, name, 'PROCEDURE', undefined, confirmed)
}

export async function dropFunction(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  confirmed?: boolean
) {
  return dropSchemaDbObject(connectionId, database, schema, name, 'FUNCTION', undefined, confirmed)
}

export async function dropTrigger(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  table?: string,
  confirmed?: boolean
) {
  // tsql DML-triggers zijn schema-gebonden en hebben geen ON-tabel nodig;
  // postgres vereist `DROP TRIGGER … ON <tabel>`.
  return dropSchemaDbObject(connectionId, database, schema, name, 'TRIGGER', { table }, confirmed)
}

export async function dropSequence(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  confirmed?: boolean
) {
  return dropSchemaDbObject(connectionId, database, schema, name, 'SEQUENCE', undefined, confirmed)
}

export async function dropSynonym(
  connectionId: string,
  database: string,
  schema: string | undefined,
  name: string,
  confirmed?: boolean
) {
  return dropSchemaDbObject(connectionId, database, schema, name, 'SYNONYM', undefined, confirmed)
}

export async function dropConstraint(
  connectionId: string,
  database: string,
  schema: string | undefined,
  table: string,
  name: string,
  confirmed?: boolean
) {
  const { provider } = requireSession(connectionId)
  const sql = buildDropConstraint(provider.capabilities.dialect, schema || null, table, name)
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
  if (dialect === 'postgres' || dialect === 'tsql') {
    const sql = buildDrop(dialect, 'USER', name)
    return runDdl(connectionId, sql, 'admin.ddl', confirmed)
  }
  throw new Error(`Users verwijderen is niet geïmplementeerd voor dialect ${dialect}.`)
}

export async function dropRole(connectionId: string, name: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsUsersAndRoles) {
    throw new Error('Deze provider ondersteunt geen users/roles.')
  }
  const dialect = provider.capabilities.dialect
  if (dialect === 'postgres' || dialect === 'tsql') {
    const sql = buildDrop(dialect, 'ROLE', name)
    return runDdl(connectionId, sql, 'admin.ddl', confirmed)
  }
  throw new Error(`Roles verwijderen is niet geïmplementeerd voor dialect ${dialect}.`)
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

// ---------------------------------------------------------------------------
// SAL-50: database-eigenschappen opvragen/wijzigen (bewerkbare
// eigenschappen-dialoog + ALTER DATABASE). SQL Server eerst; de overige
// providers retourneren `supportsAlter: false` (read-only-info in de UI).
// ---------------------------------------------------------------------------

/** Voert één statement uit via de provider; error-chunk → throw. */
async function executeStatement(
  provider: DatabaseProvider,
  session: DbSession,
  sql: string
): Promise<void> {
  for await (const chunk of provider.executeQuery(session, sql, {})) {
    if (chunk.kind === 'error') throw new Error(chunk.message)
  }
}

/** Verzamelt alle rows van een SELECT via de provider (error-chunk → throw). */
async function collectRows(
  provider: DatabaseProvider,
  session: DbSession,
  sql: string
): Promise<QueryRow[]> {
  const rows: QueryRow[] = []
  for await (const chunk of provider.executeQuery(session, sql, {})) {
    if (chunk.kind === 'error') throw new Error(chunk.message)
    if (chunk.kind === 'rows') rows.push(...chunk.rows)
  }
  return rows
}

function cellStr(value: unknown): string {
  return value === null || value === undefined ? '—' : String(value)
}

/** Compatibility-level-opties per SQL Server-versie (major). */
const COMPAT_OPTIONS: { level: number; label: string }[] = [
  { level: 100, label: 'SQL Server 2008 (100)' },
  { level: 110, label: 'SQL Server 2012 (110)' },
  { level: 120, label: 'SQL Server 2014 (120)' },
  { level: 130, label: 'SQL Server 2016 (130)' },
  { level: 140, label: 'SQL Server 2017 (140)' },
  { level: 150, label: 'SQL Server 2019 (150)' },
  { level: 160, label: 'SQL Server 2022 (160)' }
]

/** Hoogste compatibility-level dat de server accepteert (major → level). */
const MAX_COMPAT_BY_MAJOR: Record<number, number> = {
  11: 110, // SQL Server 2012
  12: 120, // 2014
  13: 130, // 2016
  14: 140, // 2017
  15: 150, // 2019
  16: 160 // 2022
}

function compatOptions(major: number, currentLevel: number): { value: string; label: string }[] {
  const maxLevel = MAX_COMPAT_BY_MAJOR[major] ?? 100
  const upper = Math.max(maxLevel, currentLevel)
  const list = COMPAT_OPTIONS.filter((o) => o.level <= upper)
  if (!list.some((o) => o.level === currentLevel)) {
    list.push({ level: currentLevel, label: `Onbekend (${currentLevel})` })
  }
  return list.map((o) => ({ value: String(o.level), label: o.label }))
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/** SQL Server: eigenschappen uit sys.databases (live) + serverconfiguratie. */
async function getTsqlDatabaseProperties(
  provider: DatabaseProvider,
  session: DbSession,
  database: string
): Promise<DatabasePropertiesResult> {
  const dbLit = quoteLiteral('tsql', database)
  const dbRows = await collectRows(
    provider,
    session,
    `SELECT d.name AS name,
            d.collation_name AS collation_name,
            d.recovery_model_desc AS recovery_model,
            d.containment_desc AS containment,
            d.compatibility_level AS compatibility_level,
            SUSER_SNAME(d.owner_sid) AS owner_name,
            d.create_date AS create_date,
            d.state_desc AS state,
            CAST(ISNULL(SUM(mf.size), 0) * 8 * 1024 AS bigint) AS size_bytes,
            d.user_access_desc AS user_access,
            d.is_auto_close_on AS is_auto_close,
            d.is_auto_shrink_on AS is_auto_shrink,
            d.is_read_only AS is_read_only
     FROM sys.databases d
     LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id
     WHERE d.name = ${dbLit}
     GROUP BY d.name, d.collation_name, d.recovery_model_desc, d.containment_desc,
              d.compatibility_level, SUSER_SNAME(d.owner_sid), d.create_date,
              d.state_desc, d.user_access_desc, d.is_auto_close_on, d.is_auto_shrink_on,
              d.is_read_only`
  )
  const row = dbRows[0]?.values
  if (!row) {
    throw new Error(`Database '${database}' bestaat niet of is niet bereikbaar.`)
  }

  const serverRows = await collectRows(
    provider,
    session,
    `SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS major,
            (SELECT CAST(value AS int) FROM sys.configurations
              WHERE name = 'contained database authentication') AS contained_auth`
  )
  const serverValues = serverRows[0]?.values ?? []
  const major = Number(serverValues[0] ?? 0) || 0
  const containedAuth = Number(serverValues[1] ?? 0) || 0

  const recoveryModel = cellStr(row[2])
  const containment = cellStr(row[3])
  const compatibilityLevel = Number(row[4] ?? 0)
  const isReadOnly = row[12] === true

  const properties: DatabasePropertiesResult['properties'] = [
    {
      key: 'name',
      label: 'Naam',
      kind: 'text',
      value: database,
      editable: true,
      renamesDatabase: true,
      note: 'Naamswijziging wordt doorgevoerd met ALTER DATABASE … MODIFY NAME.'
    },
    { key: 'state', label: 'Status', kind: 'info', value: cellStr(row[7]), editable: false },
    { key: 'owner', label: 'Eigenaar', kind: 'info', value: cellStr(row[5]), editable: false },
    { key: 'collation', label: 'Collation', kind: 'info', value: cellStr(row[1]), editable: false },
    {
      key: 'compatibility_level',
      label: 'Compatibility level',
      kind: 'select',
      value: String(compatibilityLevel),
      editable: true,
      options: compatOptions(major, compatibilityLevel)
    },
    {
      key: 'recovery',
      label: 'Recovery model',
      kind: 'select',
      value: recoveryModel,
      editable: true,
      options: [
        { value: 'FULL', label: 'Volledig (FULL)' },
        { value: 'SIMPLE', label: 'Eenvoudig (SIMPLE)' },
        { value: 'BULK_LOGGED', label: 'Bulk-logboek (BULK_LOGGED)' }
      ]
    },
    {
      key: 'containment',
      label: 'Containment',
      kind: 'select',
      value: containment,
      editable: containedAuth === 1,
      options: [
        { value: 'NONE', label: 'Geen (NONE)' },
        { value: 'PARTIAL', label: 'Gedeeltelijk (PARTIAL)' }
      ],
      ...(containedAuth !== 1
        ? { note: 'Contained database authentication is uitgeschakeld op de server.' }
        : {})
    },
    {
      key: 'read_only',
      label: 'Toegangsmodus',
      kind: 'select',
      value: isReadOnly ? 'READ_ONLY' : 'READ_WRITE',
      editable: true,
      options: [
        { value: 'READ_WRITE', label: 'Lezen/schrijven (READ_WRITE)' },
        { value: 'READ_ONLY', label: 'Alleen-lezen (READ_ONLY)' }
      ]
    },
    { key: 'user_access', label: 'Gebruikerstoegang', kind: 'info', value: cellStr(row[9]), editable: false },
    { key: 'create_date', label: 'Aangemaakt op', kind: 'info', value: cellStr(row[6]), editable: false },
    {
      key: 'size',
      label: 'Grootte',
      kind: 'info',
      value: row[8] == null ? '—' : formatBytes(Number(row[8])),
      editable: false
    }
  ]

  return { database, dialect: 'tsql', supportsAlter: true, properties }
}

/**
 * Leest de eigenschappen van een database (SAL-50). SQL Server (tsql) geeft
 * actuele waarden uit sys.databases; overige providers retourneren alleen de
 * context en markeren ALTER als niet-ondersteund (UI toont dat netjes).
 */
export async function getDatabaseProperties(
  connectionId: string,
  database: string
): Promise<DatabasePropertiesResult> {
  const { session, provider } = requireSession(connectionId)
  const dialect = provider.capabilities.dialect
  if (dialect === 'tsql') {
    return getTsqlDatabaseProperties(provider, session, database)
  }
  return {
    database,
    dialect,
    supportsAlter: false,
    message:
      dialect === 'sqlite'
        ? 'SQLite-databases zijn bestanden; ALTER DATABASE wordt niet ondersteund.'
        : `Het wijzigen van database-eigenschappen wordt voor ${provider.displayName} nog niet ondersteund.`,
    properties: []
  }
}

/**
 * Wijzigt eigenschappen van een bestaande database via dialect-correct
 * ALTER DATABASE (SAL-50). Doorloopt de environment-safety-guard met dezelfde
 * semantiek als de overige admin-DDL: een confirm-blokkade retourneert
 * `{ ok: false, blocked }` met de gegenereerde SQL; de UI vraagt bevestiging
 * en voert daarna dezelfde actie opnieuw uit met `confirmed: true`.
 */
export async function alterDatabase(
  connectionId: string,
  database: string,
  changes: Record<string, string>,
  confirmed?: boolean
): Promise<AlterDatabaseResult> {
  const { session, provider } = requireSession(connectionId)
  const statements = buildAlterDatabaseStatements(provider.capabilities.dialect, database, changes)
  if (statements.length === 0) {
    throw new Error('Geen eigenschappen gewijzigd.')
  }
  const sql = statements.join('\n')

  const conn = connectionStore.get(connectionId)
  if (conn) {
    const guard = checkQuery(sql, conn.environment)
    if (!guard.allowed) {
      if (guard.severity === 'confirm' && !confirmed) {
        return { ok: false, sql, blocked: guard.reasons, guardSeverity: 'confirm' }
      }
      if (guard.severity === 'warn') {
        // Defensief: ALTER is per guard-patroon confirm, maar mocht een
        // lichtere classificatie langskomen dan uitvoeren met waarschuwing.
        for (const stmt of statements) {
          await executeStatement(provider, session, stmt)
        }
        return {
          ok: true,
          sql,
          warning: guard.reasons,
          ...(changes.name ? { renamedTo: changes.name.trim() } : {})
        }
      }
    }
  }
  for (const stmt of statements) {
    await executeStatement(provider, session, stmt)
  }
  const result: AlterDatabaseResult = { ok: true, sql }
  if (changes.name) result.renamedTo = changes.name.trim()
  return result
}
