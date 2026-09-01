/**
 * Metadata Service — ontsluit provider-metadata via actieve sessies
 * voor de Object Explorer (lazy per niveau).
 */

import type {
  DatabaseInfo,
  DbObjectRef,
  DbRoleInfo,
  DbUserInfo,
  FuncInfo,
  ProcInfo,
  SchemaInfo,
  ScriptKind,
  ScriptObjectResult,
  SeqInfo,
  SynonymInfo,
  TableInfo,
  TableMetadata,
  TriggerInfo,
  ViewInfo
} from '@nvag/contracts'
import { buildCreateTable, scriptObject as dialectScriptObject } from '@nvag/sql-dialect'
import { registry } from './registry'
import { sessionManager } from './session-manager'

function requireSession(connectionId: string) {
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
  }
  return { session, provider: registry.get(session.providerId) }
}

export async function listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listDatabases(session)
}

export async function listSchemas(connectionId: string, db: string): Promise<SchemaInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listSchemas(session, db)
}

export async function listTables(
  connectionId: string,
  db: string,
  schema?: string
): Promise<TableInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listTables(session, db, schema)
}

export async function listViews(
  connectionId: string,
  db: string,
  schema?: string
): Promise<ViewInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listViews(session, db, schema)
}

export async function listProcedures(
  connectionId: string,
  db: string,
  schema?: string
): Promise<ProcInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listProcedures(session, db, schema)
}

export async function listFunctions(
  connectionId: string,
  db: string,
  schema?: string
): Promise<FuncInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listFunctions(session, db, schema)
}

export async function listTriggers(
  connectionId: string,
  db: string,
  schema?: string
): Promise<TriggerInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listTriggers(session, db, schema)
}

export async function listSequences(
  connectionId: string,
  db: string,
  schema?: string
): Promise<SeqInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listSequences(session, db, schema)
}

export async function listSynonyms(
  connectionId: string,
  db: string,
  schema?: string
): Promise<SynonymInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listSynonyms(session, db, schema)
}

export async function listUsers(
  connectionId: string,
  db: string
): Promise<DbUserInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listUsers(session, db)
}

export async function listRoles(
  connectionId: string,
  db: string
): Promise<DbRoleInfo[]> {
  const { session, provider } = requireSession(connectionId)
  return provider.listRoles(session, db)
}

export async function getTableMetadata(
  connectionId: string,
  db: string,
  schema: string,
  table: string
): Promise<TableMetadata> {
  const { session, provider } = requireSession(connectionId)
  return provider.getTableMetadata(session, db, schema, table)
}

export async function getObjectDefinition(
  connectionId: string,
  obj: DbObjectRef
): Promise<string> {
  const { session, provider } = requireSession(connectionId)
  return provider.getObjectDefinition(session, obj)
}

/**
 * Script Object (F1-5): genereer dialect-correcte SQL voor een object via
 * @nvag/sql-dialect.
 * - CREATE op tabel: CREATE TABLE uit metadata (dialect-correct reconstructie).
 * - CREATE op andere objecten (view/trigger/...): exacte definitie van de provider.
 * - SELECT/INSERT/UPDATE/DELETE: uit metadata, met correcte quoting,
 *   `?`-placeholders en PK-bewuste WHERE (dialect-specifiek per provider).
 */
export async function scriptObject(
  connectionId: string,
  obj: DbObjectRef,
  kind: ScriptKind
): Promise<ScriptObjectResult> {
  const { session, provider } = requireSession(connectionId)
  const dialect = provider.capabilities.dialect

  if (kind === 'CREATE' && obj.type !== 'table') {
    const sql = await provider.getObjectDefinition(session, obj)
    return { sql, title: `${obj.name} — CREATE` }
  }

  const meta = await provider.getTableMetadata(session, obj.database, obj.schema ?? 'main', obj.name)
  const sql =
    kind === 'CREATE'
      ? buildCreateTable(dialect, obj.name, obj.schema ?? null, meta)
      : dialectScriptObject(kind, dialect, obj.name, obj.schema ?? null, meta)
  return { sql, title: `${obj.name} — ${kind}` }
}
