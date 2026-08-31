/**
 * Metadata-cache voor autocomplete (F1-3).
 *
 * Object-explorer-laadt metadata lazy per niveau; voor de editor is een
 * snelle in-memory cache nodig die de metadata-IPC hergebruikt. Per
 * verbinding/database/schema worden tabellen, views, procedures en functies
 * één keer geladen; kolommen per tabel op aanvraag (getTableMetadata).
 */

import type { FuncInfo, ProcInfo, TableInfo, TableMetadata, ViewInfo } from '@nvag/contracts'

export interface ObjectCatalog {
  tables: TableInfo[]
  views: ViewInfo[]
  procedures: ProcInfo[]
  functions: FuncInfo[]
  loaded: boolean
  loading: Promise<ObjectCatalog> | null
}

function catalogKey(connectionId: string, database: string, schema?: string): string {
  return `${connectionId}|${database}|${schema ?? ''}`
}

function columnKey(connectionId: string, database: string, schema: string, table: string): string {
  return `${connectionId}|${database}|${schema}|${table}`
}

class MetadataCache {
  private catalogs = new Map<string, ObjectCatalog>()
  private columns = new Map<string, TableMetadata>()

  async getCatalog(
    connectionId: string,
    database: string,
    schema?: string
  ): Promise<ObjectCatalog> {
    const key = catalogKey(connectionId, database, schema)
    const existing = this.catalogs.get(key)
    if (existing?.loaded) return existing
    if (existing?.loading) return existing.loading

    const loading = this.loadCatalog(connectionId, database, schema).then((catalog) => {
      this.catalogs.set(key, catalog)
      return catalog
    })
    this.catalogs.set(key, {
      tables: [],
      views: [],
      procedures: [],
      functions: [],
      loaded: false,
      loading
    })
    return loading
  }

  private async loadCatalog(
    connectionId: string,
    database: string,
    schema?: string
  ): Promise<ObjectCatalog> {
    const [tables, views, procedures, functions] = await Promise.all([
      window.nvag.metadata.listTables(connectionId, database, schema),
      window.nvag.metadata.listViews(connectionId, database, schema),
      window.nvag.metadata.listProcedures(connectionId, database, schema),
      window.nvag.metadata.listFunctions(connectionId, database, schema)
    ])
    return { tables, views, procedures, functions, loaded: true, loading: null }
  }

  async getTableMetadata(
    connectionId: string,
    database: string,
    schema: string,
    table: string
  ): Promise<TableMetadata | null> {
    const key = columnKey(connectionId, database, schema, table)
    const hit = this.columns.get(key)
    if (hit) return hit
    try {
      const meta = await window.nvag.metadata.getTableMetadata(connectionId, database, schema, table)
      this.columns.set(key, meta)
      return meta
    } catch {
      return null
    }
  }

  /** Test-only: cache leeggooien. */
  reset(): void {
    this.catalogs.clear()
    this.columns.clear()
  }
}

export const metadataCache = new MetadataCache()
