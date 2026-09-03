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
  RestoreResult,
  SqlDialectId
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

// ---------------------------------------------------------------------------
// SAL-51: database-context voor admin-DDL.
//
// De DDL-admin-API's krijgen een `database` mee (Object Explorer-folder van
// database X, of de database-dropdown in de Admin-dialoog). Vroeger werd die
// parameter genegeerd en draaide de DDL op de sessie-database (meestal
// master): een via "Nieuwe tabel…" aangemaakte tabel belandde in master en
// een DROP op een object van een andere database faalde met "geen rechten".
//
// Oplossing per provider (keuze, zie SAL-51):
// - tsql / mysql / postgres: de DDL wordt uitgevoerd op een korte, aparte
//   sessie die direct op de doeldatabase is verbonden
//   (`connect({ ...config, database: target })`). Dit is deterministisch:
//   een in-place `USE [db]` op de gedeelde sessie is niet betrouwbaar omdat
//   executeQuery requests over de pool verdeelt (concurrente requests kunnen
//   op een andere pool-verbinding met de oude database terechtkomen). Een
//   aparte sessie laat bovendien de sessie-database van query-tabs ongemoeid.
// - sqlite/overig: de "database" is de verbinding zelf (bestand/instantie);
//   daar blijft de bestaande sessie in gebruik (database leeg of gelijk aan
//   de sessie-database → geen extra sessie).
// ---------------------------------------------------------------------------
const DATABASE_CONTEXT_DIALECTS: ReadonlySet<SqlDialectId> = new Set(['tsql', 'mysql', 'postgres'])

interface ResolvedSession {
  session: DbSession
  provider: DatabaseProvider
  /** Sluit een tijdelijke (database-context)sessie; no-op op de hoofdsessie. */
  done: () => Promise<void>
}

async function resolveSession(connectionId: string, database?: string | null): Promise<ResolvedSession> {
  const { session, provider } = requireSession(connectionId)
  const target = (database ?? '').trim()
  if (!target || target === session.database || !DATABASE_CONTEXT_DIALECTS.has(provider.capabilities.dialect)) {
    return { session, provider, done: async () => undefined }
  }
  const source = sessionManager.configProvider?.(connectionId)
  if (!source) {
    throw new Error('Verbinding niet gevonden. Bewaar de verbinding eerst in de Connection Manager.')
  }
  // Eigen connectionId (… #dbctx) zodat de provider-sessie-administratie die
  // op connectionId keyed (sqlserver e.d.) de oorspronkelijke sessie niet
  // overschrijft bij het opruimen van de tijdelijke sessie.
  const temp = await provider.connect({ ...source.config, id: `${connectionId}#dbctx`, database: target }, source.secret)
  return {
    session: temp,
    provider,
    done: async () => {
      try {
        await provider.close(temp)
      } catch {
        // opruimen is best-effort; de DDL is dan al uitgevoerd
      }
    }
  }
}

/**
 * Voert een DDL-statement uit met guard-check (warn/confirm-semantiek).
 * Retourneert bij een `confirm`-blokkade `{ ok: false, blocked, guardSeverity }`
 * zodat de UI een bevestiging kan tonen; de actie zelf wordt dan niet uitgevoerd.
 * Wanneer `database` is meegegeven en afwijkt van de sessie-database wordt de
 * DDL op een tijdelijke sessie op die database uitgevoerd (SAL-51).
 */
export async function runDdl(
  connectionId: string,
  sql: string,
  action: 'admin.ddl',
  confirmed?: boolean,
  database?: string | null
): Promise<AdminActionResult> {
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
          const ctx = await resolveSession(connectionId, database)
          try {
            for await (const chunk of ctx.provider.executeQuery(ctx.session, sql, {})) {
              if (chunk.kind === 'error') throw new Error(chunk.message)
            }
          } finally {
            await ctx.done()
          }
        } catch (err) {
          throw err
        }
        void action
        return { ok: true, sql, warning: guard.reasons }
      }
    }
  }
  const ctx = await resolveSession(connectionId, database)
  try {
    for await (const chunk of ctx.provider.executeQuery(ctx.session, sql, {})) {
      if (chunk.kind === 'error') {
        throw new Error(chunk.message)
      }
    }
  } finally {
    await ctx.done()
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

export async function createSchema(connectionId: string, database: string, name: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsSchemas && provider.capabilities.dialect !== 'mysql') {
    throw new Error('Deze provider ondersteunt geen aparte schemas.')
  }
  const sql = buildCreateSchema(provider.capabilities.dialect, name)
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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
  return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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

export async function dropUser(connectionId: string, database: string, name: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsUsersAndRoles) {
    throw new Error('Deze provider ondersteunt geen users/roles.')
  }
  const dialect = provider.capabilities.dialect
  if (dialect === 'postgres' || dialect === 'tsql') {
    const sql = buildDrop(dialect, 'USER', name)
    // tsql: gebruikers zijn database-principals → DDL op de doeldatabase;
    // postgres: gebruikers zijn clusterbreed (database-parameter maakt dan
    // niets uit, maar een gelijke doeldatabase is een no-op).
    return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
  }
  throw new Error(`Users verwijderen is niet geïmplementeerd voor dialect ${dialect}.`)
}

export async function dropRole(connectionId: string, database: string, name: string, confirmed?: boolean) {
  const { provider } = requireSession(connectionId)
  if (!provider.capabilities.supportsUsersAndRoles) {
    throw new Error('Deze provider ondersteunt geen users/roles.')
  }
  const dialect = provider.capabilities.dialect
  if (dialect === 'postgres' || dialect === 'tsql') {
    const sql = buildDrop(dialect, 'ROLE', name)
    return runDdl(connectionId, sql, 'admin.ddl', confirmed, database)
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

/** Bool-waarde → Nederlands 'Ja'/'Nee' (— voor null/onbekend). */
function boolJa(value: unknown): string {
  if (value === true) return 'Ja'
  if (value === false) return 'Nee'
  return '—'
}

/** Bytes → MB (1 decimaal); null/onbekend → 0. */
function toMb(bytes: unknown): number {
  if (bytes === null || bytes === undefined) return 0
  return Math.round((Number(bytes) / (1024 * 1024)) * 10) / 10
}

/** SQL Server: eigenschappen uit sys.databases (live) + serverconfiguratie. */
async function getTsqlDatabaseProperties(
  provider: DatabaseProvider,
  session: DbSession,
  database: string
): Promise<DatabasePropertiesResult> {
  const dbLit = quoteLiteral('tsql', database)
  // Rijvolgorde: name, collation_name, recovery_model, containment,
  // compatibility_level, owner, create_date, state, size_bytes, user_access,
  // is_auto_close, is_auto_shrink, is_read_only, page_verify, is_encrypted,
  // is_trustworthy.
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
            CAST(ISNULL(SUM(CAST(mf.size AS bigint)), 0) * 8 * 1024 AS bigint) AS size_bytes,
            d.user_access_desc AS user_access,
            d.is_auto_close_on AS is_auto_close,
            d.is_auto_shrink_on AS is_auto_shrink,
            d.is_read_only AS is_read_only,
            d.page_verify_option_desc AS page_verify,
            d.is_encrypted AS is_encrypted,
            d.is_trustworthy_on AS is_trustworthy
     FROM sys.databases d
     LEFT JOIN sys.master_files mf ON mf.database_id = d.database_id
     WHERE d.name = ${dbLit}
     GROUP BY d.name, d.collation_name, d.recovery_model_desc, d.containment_desc,
              d.compatibility_level, SUSER_SNAME(d.owner_sid), d.create_date,
              d.state_desc, d.user_access_desc, d.is_auto_close_on, d.is_auto_shrink_on,
              d.is_read_only, d.page_verify_option_desc, d.is_encrypted, d.is_trustworthy_on`
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
    { key: 'state', label: 'Status', kind: 'info', value: cellStr(row[7]), editable: false, section: 'algemeen' },
    { key: 'owner', label: 'Eigenaar', kind: 'info', value: cellStr(row[5]), editable: false, section: 'algemeen' },
    { key: 'collation', label: 'Collation', kind: 'info', value: cellStr(row[1]), editable: false, section: 'algemeen' },
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
    { key: 'create_date', label: 'Aangemaakt op', kind: 'info', value: cellStr(row[6]), editable: false, section: 'algemeen' },
    {
      key: 'size',
      label: 'Grootte',
      kind: 'info',
      value: row[8] == null ? '—' : formatBytes(Number(row[8])),
      editable: false,
      section: 'algemeen'
    },
    // Opties (read-only; SSMS-achtig overzicht van database-opties).
    { key: 'user_access', label: 'Gebruikerstoegang', kind: 'info', value: cellStr(row[9]), editable: false, section: 'opties' },
    { key: 'auto_close', label: 'Auto close', kind: 'info', value: boolJa(row[10]), editable: false, section: 'opties' },
    { key: 'auto_shrink', label: 'Auto shrink', kind: 'info', value: boolJa(row[11]), editable: false, section: 'opties' },
    { key: 'page_verify', label: 'Paginaverificatie', kind: 'info', value: cellStr(row[13]), editable: false, section: 'opties' },
    { key: 'encrypted', label: 'Versleuteld', kind: 'info', value: boolJa(row[14]), editable: false, section: 'opties' },
    { key: 'trustworthy', label: 'Trustworthy', kind: 'info', value: boolJa(row[15]), editable: false, section: 'opties' }
  ]

  // Bestanden (sys.master_files). Bij een fout (bv. offline database) blijft
  // het overzicht bruikbaar: de bestandslijst is optioneel.
  let files: DatabasePropertiesResult['files'] = []
  try {
    const fileRows = await collectRows(
      provider,
      session,
      `SELECT f.name AS name,
              f.type_desc AS [type],
              f.physical_name AS [path],
              CAST(CAST(f.size AS bigint) * 8 * 1024 AS bigint) AS size_bytes,
              CAST(CASE WHEN f.max_size = -1 THEN -1 ELSE CAST(f.max_size AS bigint) * 8 * 1024 END AS bigint) AS max_size_bytes,
              f.is_percent_growth AS is_percent_growth,
              CAST(CAST(f.growth AS bigint) * 8 * 1024 AS bigint) AS growth_bytes
       FROM sys.master_files f
       JOIN sys.databases d ON d.database_id = f.database_id
       WHERE d.name = ${dbLit}
       ORDER BY f.type, f.file_id`
    )
    files = fileRows.map((r) => {
      const v = r.values
      const isPercent = v[5] === true
      const maxBytes = Number(v[4] ?? 0)
      const growthBytes = v[6] == null ? 0 : Number(v[6])
      return {
        name: cellStr(v[0]),
        type: cellStr(v[1]),
        physicalName: cellStr(v[2]),
        sizeMb: toMb(v[3]),
        maxSizeMb: maxBytes < 0 ? null : toMb(v[4]),
        growthMb: isPercent || growthBytes <= 0 ? null : toMb(v[6])
      }
    })
  } catch {
    files = []
  }

  return { database, dialect: 'tsql', supportsAlter: true, properties, files }
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
 *
 * SAL-51: een naamswijziging (MODIFY NAME) kan niet draaien terwijl de eigen
 * sessie op de te hernoemen database staat — de open verbinding blokkeert de
 * rename. In dat geval wordt de sessie eerst weggezet (master) en pas daarna
 * uitgevoerd (SQL Server: master is altijd bereikbaar; query-tabs zetten hun
 * database zelf terug vóór een uitvoering).
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
        await runAlterStatements(connectionId, session, provider, database, changes)
        return {
          ok: true,
          sql,
          warning: guard.reasons,
          ...(changes.name ? { renamedTo: changes.name.trim() } : {})
        }
      }
    }
  }
  await runAlterStatements(connectionId, session, provider, database, changes)
  const result: AlterDatabaseResult = { ok: true, sql }
  if (changes.name) result.renamedTo = changes.name.trim()
  return result
}

/** Voert ALTER DATABASE-statements uit; zet de sessie eerst weg van de
 * doeldatabase wanneer die zelf hernoemd wordt (anders blokkeert de eigen
 * verbinding de MODIFY NAME). */
async function runAlterStatements(
  connectionId: string,
  session: DbSession,
  provider: DatabaseProvider,
  database: string,
  changes: Record<string, string>
): Promise<void> {
  const statements = buildAlterDatabaseStatements(provider.capabilities.dialect, database, changes)
  if (changes.name && session.database === database) {
    await sessionManager.switchDatabase(connectionId, 'master')
  }
  for (const stmt of statements) {
    await executeStatement(provider, session, stmt)
  }
}
