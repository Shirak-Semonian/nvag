/**
 * Database Search (F2-5, eis 13).
 *
 * Doorzoekt objecten (tabellen/views/procedures/functies) én tekst in
 * definities via de metadata-cache (provider-interface). Resultaat is een
 * lijst van SearchMatch-objecten; kolommatches worden via tabelmetadata
 * gevonden, definitie-matches via getObjectDefinition.
 */

import type { SearchMatch } from '@nvag/contracts'
import { registry } from './registry'
import { sessionManager } from './session-manager'

function requireSession(connectionId: string) {
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
  }
  return { session, provider: registry.get(session.providerId) }
}

function snippetAround(text: string, needle: string, radius = 40): string {
  const lower = text.toLowerCase()
  const idx = lower.indexOf(needle.toLowerCase())
  if (idx < 0) return text.length > 2 * radius ? `${text.slice(0, 2 * radius)}…` : text
  const from = Math.max(0, idx - radius)
  const to = Math.min(text.length, idx + needle.length + radius)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

/** Doorzoekt databases/objecten/definities (F2-5). */
export async function searchDatabase(
  connectionId: string,
  query: string,
  options: { database?: string; limit?: number } = {}
): Promise<SearchMatch[]> {
  const { session, provider } = requireSession(connectionId)
  const needle = query.trim()
  if (needle.length === 0) return []
  const limit = Math.min(Math.max(1, options.limit ?? 200), 500)
  const matches: SearchMatch[] = []
  const db = options.database ?? session.database
  const schema = provider.capabilities.supportsSchemas ? undefined : 'main'

  const push = (m: SearchMatch): void => {
    if (matches.length >= limit) return
    matches.push(m)
  }

  const matchName = (name: string): boolean => name.toLowerCase().includes(needle.toLowerCase())

  // Tabellen + views
  for (const [type, listFn] of [
    ['table', provider.listTables.bind(provider)],
    ['view', provider.listViews.bind(provider)]
  ] as const) {
    let objects: { name: string; schema?: string }[] = []
    try {
      objects = await listFn(session, db, schema)
    } catch {
      objects = []
    }
    for (const obj of objects) {
      if (matchName(obj.name)) {
        push({
          objectType: type,
          database: db,
          schema: obj.schema ?? schema ?? 'main',
          object: obj.name,
          field: 'name'
        })
      }
      // Kolommatches via tabelmetadata (beperkt tot objecten die passen).
      if (matches.length < limit && type === 'table') {
        try {
          const meta = await provider.getTableMetadata(session, db, obj.schema ?? schema ?? 'main', obj.name)
          const hit = meta.columns.find((c) => matchName(c.name))
          if (hit) {
            push({
              objectType: 'column',
              database: db,
              schema: obj.schema ?? schema ?? 'main',
              object: obj.name,
              field: 'column',
              snippet: `${hit.name} (${hit.dataType})`
            })
          }
        } catch {
          // metadata-fout overslaan
        }
      }
    }
  }

  // Procedures + functies
  for (const [type, listFn] of [
    ['procedure', provider.listProcedures.bind(provider)],
    ['function', provider.listFunctions.bind(provider)]
  ] as const) {
    let objects: { name: string; schema?: string }[] = []
    try {
      objects = await listFn(session, db, schema)
    } catch {
      objects = []
    }
    for (const obj of objects) {
      if (matchName(obj.name)) {
        push({
          objectType: type,
          database: db,
          schema: obj.schema ?? schema ?? 'main',
          object: obj.name,
          field: 'name'
        })
      }
    }
  }

  // Definities doorzoeken (alle objecten; cap op objecten per type).
  if (matches.length < limit) {
    const defTargets: { type: SearchMatch['objectType']; name: string; schema?: string }[] = []
    for (const [type, listFn] of [
      ['view', provider.listViews.bind(provider)],
      ['procedure', provider.listProcedures.bind(provider)],
      ['function', provider.listFunctions.bind(provider)],
      ['table', provider.listTables.bind(provider)]
    ] as const) {
      try {
        const objects = (await listFn(session, db, schema)) as { name: string; schema?: string }[]
        for (const obj of objects.slice(0, 60)) {
          defTargets.push({ type, name: obj.name, schema: obj.schema ?? schema ?? 'main' })
        }
      } catch {
        // overslaan
      }
    }
    for (const target of defTargets) {
      if (matches.length >= limit) break
      try {
        const def = await provider.getObjectDefinition(session, {
          type: target.type === 'table' ? 'table' : target.type === 'view' ? 'view' : target.type === 'procedure' ? 'procedure' : 'function',
          database: db,
          schema: target.schema,
          name: target.name
        })
        if (def.toLowerCase().includes(needle.toLowerCase())) {
          push({
            objectType: 'definition',
            database: db,
            schema: target.schema,
            object: target.name,
            field: 'definition',
            snippet: snippetAround(def, needle)
          })
        }
      } catch {
        // definitie niet beschikbaar
      }
    }
  }

  return matches
}
