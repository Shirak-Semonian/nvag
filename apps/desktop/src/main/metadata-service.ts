/**
 * Metadata Service — ontsluit provider-metadata via actieve sessies
 * voor de Object Explorer (lazy per niveau).
 */

import type {
  DatabaseInfo,
  FuncInfo,
  ProcInfo,
  SchemaInfo,
  SeqInfo,
  TableInfo,
  TableMetadata,
  TriggerInfo,
  ViewInfo
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

export async function getTableMetadata(
  connectionId: string,
  db: string,
  schema: string,
  table: string
): Promise<TableMetadata> {
  const { session, provider } = requireSession(connectionId)
  return provider.getTableMetadata(session, db, schema, table)
}
