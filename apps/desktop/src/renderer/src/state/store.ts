import { create } from 'zustand'
import type {
  AdminUserInfo,
  AuditEntry,
  ConnectionConfig,
  ConnectionSecret,
  DashboardData,
  DbObjectRef,
  Environment,
  ErrorPosition,
  HistoryEntry,
  ImportPreview,
  ProviderCapabilities,
  QueryCellValue,
  QueryChunk,
  QueryMessage,
  QueryResultSet,
  QueryRunResponse,
  ScriptKind,
  SearchMatch,
  ServerInfo,
  SnippetEntry,
  SqlDialectId,
  TableDataResult,
  TransactionState
} from '@nvag/contracts'
import { buildSelectStar } from '@nvag/sql-dialect'
import { loadRecentQueries, persistRecentQueries, type RecentQueryEntry } from './recentQueries'

export interface QueryTabState {
  id: string
  title: string
  sql: string
  connectionId: string | null
  /**
   * Database van deze tab (eis 24). `null`/undefined = verbindingsdefault
   * (config.database of de database van de geopende sessie).
   */
  database?: string | null
  /** Fout bij het wisselen van verbinding/database (dropdown); toont in tab-context. */
  dbSwitchError?: string | null
  result: QueryRunResponse | null
  running: boolean
  /** Actieve uitvoering (voor cancel); null wanneer niet bezig. */
  executionId: string | null
  /** Starttijd van de actieve uitvoering (execution timer). */
  startedAt: number | null
  /** SAL-33: annulering wordt verwerkt (cancel-IPC verstuurd, wachten op done). */
  cancelling?: boolean
  /** Pad van een geopend/opgeslagen querybestand (optioneel). */
  filePath?: string
  /** Bewerkingsvlag: true zodra SQL afwijkt van het bestand op schijf. */
  dirty?: boolean

  // F2-1: Table Data Viewer/Editor (eis 8)
  kind?: 'query' | 'table-data'
  /** Tabelcontext voor een table-data tab. */
  tableData?: {
    database: string
    schema: string
    table: string
    data: TableDataResult | null
    /** SAL-42: true terwijl getRows loopt (geen dubbele/eeuwige "Laden…"). */
    loading: boolean
    /** SAL-42: fout van de laatste laadpoging; null zolang die niet faalde. */
    error: string | null
    /** Nieuwe-rij-modus (insert-ready). */
    inserting: boolean
    /** Wachtende bewerking die op bevestiging wacht (guard). */
    pendingEdit: { kind: 'update' | 'insert' | 'delete'; sql: string; reason: string[] } | null
    /** Laatste bewerkingsresultaat (voor feedback). */
    lastEditMessage: string | null
    /** Laatst uitgevoerde/gegenereerde SQL (zichtbaar voor de gebruiker). */
    lastSql: string | null
  }
}

/** Bewerkingsverzoek dat op bevestiging wacht (F2-1 guard). */
export interface TableEditPending {
  tabId: string
  kind: 'update' | 'insert' | 'delete'
  sql: string
  reasons: string[]
  environment: Environment
  /** Oorspronkelijke bewerkingswaarden (voor de bevestigde heruitvoering). */
  values: Record<string, QueryCellValue>
  pkValues: Record<string, QueryCellValue>
}

export interface ConnectionWithSession {
  config: ConnectionConfig
  sessionId: string
  serverInfo: ServerInfo
}

/**
 * SAL-43: resultaat van closeSession.
 * - `{ closed: true }`: er was een sessie en die is (poging tot) gesloten en
 *   uit openSessions verwijderd. `error` is gevuld wanneer de backend-close
 *   faalde (de backend heeft de sessie dan wél al opgeruimd — zie de
 *   try/finally in SessionManager.close — dus de UI mag niet verbonden blijven).
 * - `{ closed: false }`: er was geen sessie open (stille no-op voorkomen).
 */
export type CloseSessionResult = { closed: true; error?: string } | { closed: false }

/** Tabs van de AdminDialog (SAL-34: Object Explorer kan een specifieke tab openen). */
export type AdminDialogTab = 'database' | 'schema' | 'table' | 'view' | 'index' | 'users' | 'backup'

/** Environment-safety (F1-8): query die op bevestiging wacht (ADR-009). */
export interface GuardPending {
  tabId: string
  sql: string
  reasons: string[]
  environment: Environment
}

interface AppState {
  connections: ConnectionConfig[]
  /** Verbindingen met geopende sessie */
  openSessions: Record<string, ConnectionWithSession>
  tabs: QueryTabState[]
  activeTabId: string | null
  recentQueries: RecentQueryEntry[]
  /** SQL-history (eis 19): geladen uitvoeringen (nieuwste eerst). */
  historyEntries: HistoryEntry[]
  showConnectionDialog: boolean
  connectionDialogMode: 'create' | 'edit'
  editingConnectionId: string | null
  /** Environment-safety (F1-8): query die op bevestiging wacht; null = geen dialoog. */
  pendingGuard: GuardPending | null
  /** F2-1: tabelbewerking die op bevestiging wacht (guard). */
  pendingTableEdit: TableEditPending | null
  /** F2-2: transactiestatus per verbinding (eis 23). */
  transactionState: Record<string, TransactionState>
  /** F2-6: snippets + folders (eis 20). */
  snippets: SnippetEntry[]
  snippetFolders: string[]
  snippetFilterFolder: string
  /** F2-5: zoekresultaten (eis 13). */
  searchResults: SearchMatch[]
  searching: boolean
  /** F2-7: import (eis 17). */
  importPreview: ImportPreview | null
  importFilePath: string | null
  importGeneratedSql: string
  importBusy: boolean
  /** F2-8: auditlog (eis 26). */
  auditEntries: AuditEntry[]
  /** F2-10: dashboard (eis 25). */
  dashboard: DashboardData | null
  /** F2-3: admin-dialoog (eis 9). */
  showAdminDialog: boolean
  /** SAL-34: verbinding waarvoor de admin-dialoog is geopend (Object Explorer);
   *  null = actieve tab-verbinding gebruiken. */
  adminDialogConnectionId: string | null
  /** SAL-34: tab waarin de admin-dialoog opent (Object Explorer; null = default). */
  adminDialogTab: AdminDialogTab | null
  /** SAL-51: database-context van de admin-dialoog (Object Explorer-folder van
   *  database X → DDL op X). null = sessie-database (verbindingsdefault). */
  adminDialogDatabase: string | null
  adminCapabilities: ProviderCapabilities | null
  adminUsers: AdminUserInfo[]
  /** SAL-31: signaal na CREATE/DROP DATABASE via AdminDialog; ObjectExplorer herlaadt de databaselijst. */
  dbListRevision: number
  /** SAL-32: signaal na DDL op database-objecten (CREATE/DROP TABLE/VIEW/INDEX/SCHEMA/USER);
   *  ObjectExplorer herlaadt de geopende objectfolders zodat nieuwe objecten zonder app-herstart zichtbaar zijn. */
  dbObjectsRevision: number

  loadConnections: () => Promise<void>
  saveConnection: (config: ConnectionConfig, secret?: ConnectionSecret) => Promise<ConnectionConfig>
  removeConnection: (id: string) => Promise<void>
  openSession: (config: ConnectionConfig, secret?: ConnectionSecret) => Promise<ServerInfo>
  closeSession: (connectionId: string) => Promise<CloseSessionResult>
  /** SAL-43: opent een sessie voor een opgeslagen verbinding (vault-secret) zonder tab-switch (Object Explorer: dubbelklik / "Verbinding maken"). */
  openSavedConnection: (connectionId: string) => Promise<void>

  /** Nieuwe lege query-tab; met `opts` direct met sql/verbinding/database/titel gevuld. */
  addTab: (opts?: {
    sql?: string
    connectionId?: string | null
    database?: string | null
    title?: string
  }) => void
  /** Nieuwe tab met een SELECT * FROM <tabel> (dubbelklik in Object Explorer). */
  openTableQuery: (connectionId: string, tableName: string, schema?: string) => void
  /** Script Object (F1-5): gegenereerde SQL in een nieuwe querytab. */
  openScriptTab: (connectionId: string, obj: DbObjectRef, kind: ScriptKind) => Promise<void>
  /** Dupliceer een tab (sql + verbinding; geen bestandsbinding). */
  duplicateTab: (id: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTabSql: (id: string, sql: string) => void
  setTabConnection: (id: string, connectionId: string | null) => void
  /**
   * Snelle verbindingsswitch (eis 24): wisselt de verbinding van een tab en
   * opent de sessie automatisch via openSaved (vault-secret) wanneer die nog
   * niet open is. Bij een fout blijft de tab op de oude verbinding.
   */
  switchTabConnection: (tabId: string, connectionId: string | null) => Promise<void>
  /** Wisselt de database van een tab (USE op de sessie; eis 24). */
  setTabDatabase: (tabId: string, database: string) => Promise<void>
  /** Voer query uit; met `sql` wordt die selectie uitgevoerd i.p.v. de hele tab. */
  runQuery: (tabId: string, sql?: string, opts?: { confirmed?: boolean }) => Promise<void>
  /** Annuleer de actieve uitvoering van een tab. */
  cancelQuery: (tabId: string) => Promise<void>
  /** F1-8: bevestigde de door de guard geblokkeerde query alsnog uitvoeren. */
  confirmGuardQuery: () => Promise<void>
  /** F1-8: annuleer de door de guard geblokkeerde query. */
  cancelGuardQuery: () => void

  /** Open querybestand via dialoog → nieuwe tab; null bij annuleren. */
  openQueryFile: () => Promise<string | null>
  /** Bewaar tab naar bestand (pad uit tab, anders Save-dialoog). */
  saveQueryFile: (tabId: string) => Promise<void>
  /** Bewaar tab onder een nieuw pad (Save As). */
  saveQueryFileAs: (tabId: string) => Promise<void>

  /** Recente query's: bovenaan toevoegen, ontdubbelen, max 20, localStorage. */
  useRecentQuery: (sql: string, connectionId: string | null) => void
  clearRecentQueries: () => void

  /** SQL-history (eis 19): laadt uitvoeringen, optioneel gefilterd op zoektekst. */
  loadHistory: (query?: string) => Promise<void>
  /** SQL-history: wist alle uitvoeringen. */
  clearHistory: () => Promise<void>
  /** Vanuit history heruitvoeren: nieuwe tab met SQL + verbinding, direct draaien. */
  rerunHistoryEntry: (entry: HistoryEntry) => Promise<void>

  openConnectionDialog: (mode: 'create' | 'edit', connectionId?: string) => void
  closeConnectionDialog: () => void
  /** SAL-50: hernoemt de database-context van geopende tabs na MODIFY NAME. */
  renameDatabaseInTabs: (oldName: string, newName: string) => void

  // F2-1: Table Data Viewer/Editor (eis 8)
  openTableDataTab: (connectionId: string, database: string, schema: string, table: string) => void
  loadTableRows: (tabId: string) => Promise<void>
  /** Bewerking op een cel/rij; bij guard-blokkade naar pendingTableEdit. */
  saveTableEdit: (
    tabId: string,
    kind: 'update' | 'insert' | 'delete',
    values: Record<string, QueryCellValue>,
    pkValues: Record<string, QueryCellValue>
  ) => Promise<void>
  /** F2-1: bevestigde bewerking alsnog uitvoeren (guard-dialoog). */
  confirmTableEdit: () => Promise<void>
  cancelTableEdit: () => void

  // F2-2: Transactions (eis 23)
  beginTransaction: (connectionId: string) => Promise<void>
  commitTransaction: (connectionId: string) => Promise<void>
  rollbackTransaction: (connectionId: string) => Promise<void>
  refreshTransactionState: (connectionId: string) => Promise<void>

  // F2-5: Database Search (eis 13)
  runDatabaseSearch: (connectionId: string, query: string) => Promise<void>
  /** Vanuit zoekresultaat een object openen (nieuwe querytab). */
  openSearchMatch: (connectionId: string, match: SearchMatch) => void

  // F2-6: Snippets/Favorites (eis 20)
  loadSnippets: (folder?: string) => Promise<void>
  saveSnippet: (entry: { folder: string; title: string; sql: string }) => Promise<void>
  removeSnippet: (id: number) => Promise<void>
  /** Voegt een snippet in de actieve editor-tab in. */
  insertSnippetIntoEditor: (tabId: string, sql: string) => void

  // F2-7: Import (eis 17)
  pickImportFile: () => Promise<void>
  generateImportSql: (connectionId: string, table: string, schema: string | undefined, mapping: Record<number, string>, rowLimit: number) => Promise<void>
  executeImportSql: (connectionId: string, confirmed?: boolean) => Promise<void>

  // F2-8: Audit (eis 26)
  loadAudit: () => Promise<void>
  clearAudit: () => Promise<void>

  // F2-10: Dashboard (eis 25)
  loadDashboard: (connectionId: string) => Promise<void>

  // F2-3: Admin (eis 9)
  openAdminDialog: (connectionId?: string, tab?: AdminDialogTab, database?: string | null) => void
  closeAdminDialog: () => void
  loadAdminState: (connectionId: string) => Promise<void>
  /** SAL-31: verhoogt dbListRevision zodat ObjectExplorer de databaselijst herlaadt. */
  bumpDbListRevision: () => void
  /** SAL-32: verhoogt dbObjectsRevision zodat ObjectExplorer geopende objectfolders herlaadt. */
  bumpDbObjectsRevision: () => void
}

let tabCounter = 1
/** Zorgt voor unieke tab-ids, ook binnen dezelfde milliseconde. */
let tabSeq = 0
function nextTabId(): string {
  tabSeq += 1
  return `tab-${Date.now()}-${tabSeq}`
}

const MAX_RECENT = 20

/**
 * SAL-42: table-data tabs die nog nooit geladen zijn en wachten op een sessie
 * (data null, niet bezig, geen eerdere fout). Zodra de sessie van hun
 * verbinding opengaat worden deze tabs automatisch geladen.
 */
function pendingTableDataTabIds(tabs: QueryTabState[], connectionId: string): string[] {
  const ids: string[] = []
  for (const tab of tabs) {
    const td = tab.tableData
    if (tab.kind !== 'table-data' || tab.connectionId !== connectionId || !td) continue
    if (td.data !== null || td.loading || td.error) continue
    ids.push(tab.id)
  }
  return ids
}

/** providerId → dialect (F1: sqlserver/postgresql/mysql; uitbreiden per provider). */
const PROVIDER_DIALECT: Record<string, SqlDialectId> = {
  sqlite: 'sqlite',
  sqlserver: 'tsql',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  db2: 'db2',
  oracle: 'oracle',
  snowflake: 'snowflake',
  azure: 'tsql',
  databricks: 'databricks'
}

export function getDialectForProvider(providerId: string): SqlDialectId {
  return PROVIDER_DIALECT[providerId] ?? 'sqlite'
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

// ---------------------------------------------------------------------------
// Streaming-accumulator (SAL-17): bouwt QueryRunResponse op uit chunks.
// ---------------------------------------------------------------------------

interface ResultAccumulator {
  results: QueryResultSet[]
  messages: QueryMessage[]
  doneRowCount: number
  durationMs: number
  truncated: boolean
  cancelled: boolean
  error?: string
  errorPosition?: ErrorPosition
}

function createAccumulator(): ResultAccumulator {
  return {
    results: [],
    messages: [],
    doneRowCount: 0,
    durationMs: 0,
    truncated: false,
    cancelled: false
  }
}

function buildResult(acc: ResultAccumulator, executionId: string): QueryRunResponse {
  const first = acc.results[0]
  const deliveredRows = acc.results.reduce((n, rs) => n + rs.rowCount, 0)
  // DML/DDL zonder resultset: rowCount komt uit het done-chunk (affected rows).
  const rowCount = deliveredRows > 0 ? deliveredRows : acc.doneRowCount
  return {
    executionId,
    columns: first?.columns ?? [],
    rows: first?.rows ?? [],
    truncated: acc.truncated || (first?.truncated ?? false),
    rowCount,
    durationMs: acc.durationMs,
    error: acc.error,
    errorPosition: acc.errorPosition,
    cancelled: acc.cancelled,
    results: acc.results,
    messages: acc.messages
  }
}

function initialTab(): QueryTabState {
  const id = nextTabId()
  return {
    id,
    title: `Query ${tabCounter++}`,
    sql: '',
    connectionId: null,
    result: null,
    running: false,
    executionId: null,
    startedAt: null,
    cancelling: false
  }
}

export const useAppStore = create<AppState>((set, get) => {
  const first = initialTab()
  return {
    connections: [],
    openSessions: {},
    tabs: [first],
    activeTabId: first.id,
    recentQueries: loadRecentQueries(),
    historyEntries: [],
    showConnectionDialog: false,
    connectionDialogMode: 'create',
    editingConnectionId: null,
    pendingGuard: null,
    pendingTableEdit: null,
    transactionState: {},
    snippets: [],
    snippetFolders: ['Algemeen'],
    snippetFilterFolder: 'Algemeen',
    searchResults: [],
    searching: false,
    importPreview: null,
    importFilePath: null,
    importGeneratedSql: '',
    importBusy: false,
    auditEntries: [],
    dashboard: null,
    showAdminDialog: false,
    adminDialogConnectionId: null,
    adminDialogTab: null,
    adminDialogDatabase: null,
    adminCapabilities: null,
    adminUsers: [],
    dbListRevision: 0,
    dbObjectsRevision: 0,

  async loadConnections() {
    const list = await window.nvag.connections.list()
    set({ connections: list })
  },

  async saveConnection(config, secret) {
    const saved = await window.nvag.connections.save(config, secret)
    await get().loadConnections()
    return saved
  },

  async removeConnection(id) {
    await get().closeSession(id)
    await window.nvag.connections.remove(id)
    await get().loadConnections()
  },

  async openSession(config, secret) {
    const { sessionId, serverInfo } = await window.nvag.sessions.open(config, secret)
    set((s) => ({
      openSessions: { ...s.openSessions, [config.id]: { config, sessionId, serverInfo } }
    }))
    // SAL-42: table-data tabs die op deze sessie wachtten laden nu alsnog
    // (geen stille "Laden…" meer nadat de verbinding opengaat).
    for (const id of pendingTableDataTabIds(get().tabs, config.id)) {
      void get().loadTableRows(id)
    }
    return serverInfo
  },

  async closeSession(connectionId) {
    const session = get().openSessions[connectionId]
    if (!session) return { closed: false }
    let error: string | undefined
    try {
      await window.nvag.sessions.close(session.sessionId)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      // SAL-43: ook bij een falende close-IPC de openSessions-entry verwijderen.
      // SessionManager.close ruimt de backend-sessie in een finally op voordat
      // de fout terugkomt; een verbonden-ogende renderer zou anders een
      // bevroren boom + mislukkende queries opleveren (stille no-op).
      set((s) => {
        const next = { ...s.openSessions }
        delete next[connectionId]
        return { openSessions: next }
      })
    }
    return error ? { closed: true, error } : { closed: true }
  },

  async openSavedConnection(connectionId) {
    if (get().openSessions[connectionId]) return
    const sessionInfo = await window.nvag.sessions.openSaved(connectionId)
    const config = get().connections.find((c) => c.id === connectionId)
    if (!config) {
      throw new Error('Connection not found. Save the connection first in the Connection Manager.')
    }
    set((s) => ({
      openSessions: {
        ...s.openSessions,
        [connectionId]: { config, sessionId: sessionInfo.sessionId, serverInfo: sessionInfo.serverInfo }
      }
    }))
    // SAL-42: table-data tabs die op deze sessie wachtten laden nu alsnog.
    for (const id of pendingTableDataTabIds(get().tabs, connectionId)) {
      void get().loadTableRows(id)
    }
  },

  addTab(opts) {
    const id = nextTabId()
    const conn = opts?.connectionId
      ? get().connections.find((c) => c.id === opts.connectionId)
      : undefined
    const tab: QueryTabState = {
      id,
      title:
        opts?.title ??
        (conn ? conn.name : `Query ${tabCounter++}`),
      sql: opts?.sql ?? '',
      connectionId: opts?.connectionId ?? null,
      // Eigen database per tab (eis 24); default = database uit de verbindingsconfig.
      database: opts?.database ?? conn?.database ?? null,
      result: null,
      running: false,
      executionId: null,
      startedAt: null,
      cancelling: false
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
  },

  async openScriptTab(connectionId, obj, kind) {
    const { sql, title } = await window.nvag.metadata.scriptObject(connectionId, obj, kind)
    get().addTab({ sql, connectionId, title, database: obj.database })
  },

  openTableQuery(connectionId, tableName, schema) {
    const conn = get().connections.find((c) => c.id === connectionId)
    const dialect = conn ? getDialectForProvider(conn.providerId) : 'sqlite'
    const sql = buildSelectStar(dialect, tableName, schema, 100)
    const id = nextTabId()
    const tab: QueryTabState = {
      id,
      title: tableName,
      sql,
      connectionId,
      database: conn?.database ?? null,
      result: null,
      running: false,
      executionId: null,
      startedAt: null,
      cancelling: false
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
  },

  duplicateTab(id) {
    const src = get().tabs.find((t) => t.id === id)
    if (!src) return
    const copy: QueryTabState = {
      id: nextTabId(),
      title: `${src.title} (kopie)`,
      sql: src.sql,
      connectionId: src.connectionId,
      database: src.database,
      result: null,
      running: false,
      executionId: null,
      startedAt: null,
      cancelling: false
    }
    set((s) => ({ tabs: [...s.tabs, copy], activeTabId: copy.id }))
  },

  closeTab(id) {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId = s.activeTabId === id ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null) : s.activeTabId
      return { tabs, activeTabId }
    })
  },

  setActiveTab(id) {
    set({ activeTabId: id })
  },

  updateTabSql(id, sql) {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, sql, dirty: t.filePath ? true : t.dirty } : t
      )
    }))
  },

  setTabConnection(id, connectionId) {
    const conn = connectionId ? get().connections.find((c) => c.id === connectionId) : undefined
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, connectionId, database: conn?.database ?? null, dbSwitchError: null, result: null }
          : t
      )
    }))
  },

  async switchTabConnection(tabId, connectionId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tab.connectionId === connectionId) return

    // Snelle switch (eis 24): sessie automatisch openen wanneer die nog niet
    // open is — via openSaved met het vault-secret (geen dialoog nodig).
    let sessionInfo: { sessionId: string; serverInfo: ServerInfo } | null = null
    if (connectionId) {
      const existing = get().openSessions[connectionId]
      if (existing) {
        sessionInfo = { sessionId: existing.sessionId, serverInfo: existing.serverInfo }
      } else {
        try {
          sessionInfo = await window.nvag.sessions.openSaved(connectionId)
          const config = get().connections.find((c) => c.id === connectionId)
          if (config) {
            set((s) => ({
              openSessions: {
                ...s.openSessions,
                [connectionId]: { config, sessionId: sessionInfo!.sessionId, serverInfo: sessionInfo!.serverInfo }
              }
            }))
            // SAL-42: ook via openSaved geopende sessies laten wachtende
            // table-data tabs alsnog laden.
            for (const id of pendingTableDataTabIds(get().tabs, connectionId)) {
              void get().loadTableRows(id)
            }
          }
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err)
          set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, dbSwitchError: text } : t))
          }))
          return
        }
      }
    }

    const conn = connectionId ? get().connections.find((c) => c.id === connectionId) : undefined
    const database = sessionInfo?.serverInfo.currentDatabase ?? conn?.database ?? null
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, connectionId, database, dbSwitchError: null, result: null }
          : t
      )
    }))
  },

  async setTabDatabase(tabId, database) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || tab.database === database) return
    const previous = tab.database
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, database, dbSwitchError: null } : t))
    }))
    if (!tab.connectionId) return
    try {
      const res = await window.nvag.sessions.useDatabase(tab.connectionId, database)
      set((s) => {
        const session = s.openSessions[tab.connectionId!]
        if (!session) return {}
        return {
          openSessions: {
            ...s.openSessions,
            [tab.connectionId!]: { ...session, sessionId: res.sessionId, serverInfo: res.serverInfo }
          }
        }
      })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      // Terugzetten en de fout tonen in de tab-context (resultaat niet wissen).
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, database: previous, dbSwitchError: text } : t
        )
      }))
    }
  },

  /**
   * Voert een query uit met streaming: `run` geeft executionId, chunks komen
   * binnen via `onChunk`, `start` laat de runner consumeren. De grid vult
   * zich progressief; bij `done`/`error` stopt de tab.
   *
   * Environment-safety (F1-8): wanneer de guard blokkeert op `confirm`-niveau
   * (of op PROD) wordt de query in `pendingGuard` gezet en toont de renderer
   * een bevestigingsdialoog; op `warn`-niveau wordt de query met een
   * waarschuwing in het berichtenpaneel alsnog uitgevoerd.
   */
  async runQuery(tabId, sql, opts) {
    const tab = get().tabs.find((t) => t.id === tabId)
    const querySql = (sql ?? tab?.sql ?? '').trim()
    if (!tab || tab.running) return
    if (!tab.connectionId) return
    const session = get().openSessions[tab.connectionId]
    if (!session) {
      // SAL-43: geen stille no-op meer wanneer een tab op een gesloten
      // verbinding draait (Ctrl+Enter/F5 omzeilt de disabled Uitvoeren-knop).
      const text = 'No active connection for this query. Open the connection first (double-click the server in Object Explorer), then run the query again.'
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                result: {
                  executionId: '',
                  columns: [],
                  rows: [],
                  truncated: false,
                  rowCount: 0,
                  durationMs: 0,
                  error: text,
                  messages: [{ severity: 'error', text }]
                }
              }
            : t
        )
      }))
      return
    }

    const acc = createAccumulator()
    let unsubscribe: (() => void) | null = null

    const patchTab = (patch: Partial<QueryTabState>): void => {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
      }))
    }

    // F1-10: zorg dat de sessie op de database van deze tab staat. Wanneer een
    // tab met een andere database werd aangemaakt (Script Object, recente query)
    // moet de query op die database draaien, niet op de sessie-default.
    // SQLite slaan we over: het bestand ís de database (geen in-place switch).
    const dialect = getDialectForProvider(session.config.providerId)
    if (tab.database && dialect !== 'sqlite' && session.serverInfo.currentDatabase !== tab.database) {
      try {
        const res = await window.nvag.sessions.useDatabase(tab.connectionId, tab.database)
        set((s) => ({
          openSessions: {
            ...s.openSessions,
            [tab.connectionId!]: { ...session, sessionId: res.sessionId, serverInfo: res.serverInfo }
          }
        }))
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        patchTab({
          result: {
            executionId: '',
            columns: [],
            rows: [],
            truncated: false,
            rowCount: 0,
            durationMs: 0,
            error: text,
            messages: [{ severity: 'error', text }]
          }
        })
        return
      }
    }

    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, running: true, result: null, executionId: null, startedAt: Date.now(), cancelling: false }
          : t
      )
    }))

    const applyChunk = (chunk: QueryChunk, executionId: string): void => {
      if (chunk.kind === 'columns') {
        acc.results.push({ columns: chunk.columns, rows: [], truncated: false, rowCount: 0 })
      } else if (chunk.kind === 'rows') {
        // SAL-48 (grid-fix): de resultset NIET in-place muteren. ResultSetGrid
        // cached rowData via useMemo op `resultSet.rows`; bij een in-place
        // push blijft de rij-referentie gelijk en toont de grid eeuwig de
        // eerste (columns-only) frame met 0 rijen. Elke rows-chunk vervangt
        // de resultset door een nieuw object met een nieuwe rows-array, zodat
        // consumers de update zien.
        const idx = acc.results.length - 1
        const rs = acc.results[idx]
        if (rs) {
          const rows = [...rs.rows, ...chunk.rows]
          acc.results[idx] = { ...rs, rows, rowCount: rows.length }
        }
      } else if (chunk.kind === 'warning') {
        acc.messages.push({ severity: 'warning', text: chunk.message, position: chunk.position })
      } else if (chunk.kind === 'error') {
        acc.error = chunk.message
        acc.errorPosition = chunk.position
        acc.messages.push({ severity: 'error', text: chunk.message, position: chunk.position })
        patchTab({ result: buildResult(acc, executionId), running: false, executionId: null, startedAt: null, cancelling: false })
        unsubscribe?.()
        return
      } else {
        // done
        acc.durationMs = chunk.durationMs
        acc.doneRowCount = chunk.rowCount
        acc.cancelled = chunk.cancelled ?? false
        if (chunk.truncated) {
          // Ook hier niet in-place muteren (zelfde referentie-argument als rows).
          const idx = acc.results.length - 1
          const rs = acc.results[idx]
          if (rs) acc.results[idx] = { ...rs, truncated: true }
          if (!acc.messages.some((m) => m.severity === 'warning' && /afgekapt/i.test(m.text))) {
            acc.messages.push({ severity: 'warning', text: 'Result truncated at the maximum row cap.' })
          }
        }
        patchTab({ result: buildResult(acc, executionId), running: false, executionId: null, startedAt: null, cancelling: false })
        unsubscribe?.()
        return
      }
      // Tussentijdse (streaming) update: grid vult zich progressief.
      patchTab({ result: buildResult(acc, executionId) })
    }

    try {
      const environment = get().connections.find((c) => c.id === tab.connectionId)?.environment ?? 'DEV'
      let start = await window.nvag.query.run({
        connectionId: tab.connectionId,
        sql: querySql,
        confirmed: opts?.confirmed
      })

      if (start.blocked && start.blocked.length > 0 && !opts?.confirmed) {
        if (start.guardSeverity === 'warn') {
          // Lichte categorie (bijv. grote operatie buiten PROD): waarschuwen
          // en alsnog uitvoeren — de guard wordt met `confirmed` gepasseerd.
          acc.messages.push({
            severity: 'warning',
            text: `Environment safety: ${start.blocked.join(', ')} — executed with a warning.`
          })
          start = await window.nvag.query.run({
            connectionId: tab.connectionId,
            sql: querySql,
            confirmed: true
          })
        } else {
          // Confirm-niveau (destructief, of PROD): bevestigingsdialoog tonen.
          set({
            pendingGuard: {
              tabId,
              sql: querySql,
              reasons: start.blocked,
              environment
            }
          })
          patchTab({ running: false, executionId: null, startedAt: null })
          return
        }
      }

      if (start.blocked && start.blocked.length > 0) {
        const text = `Query blocked by environment safety (${start.blocked.join(', ')}).`
        patchTab({
          result: {
            executionId: '',
            columns: [],
            rows: [],
            truncated: false,
            rowCount: 0,
            durationMs: 0,
            error: text,
            blocked: start.blocked,
            messages: [{ severity: 'error', text }]
          },
          running: false,
          executionId: null,
          startedAt: null
        })
        return
      }

      patchTab({ executionId: start.executionId })

      unsubscribe = window.nvag.query.onChunk((evt) => {
        if (evt.executionId === start.executionId) applyChunk(evt.chunk, start.executionId)
      })

      // SAL-48: `start()` resolveert wanneer de main-kant klaar is met sturen,
      // maar de terminale chunk(s) (rows/done/error) kunnen dan nog onderweg
      // zijn naar deze listener: de IPC-volgorde tussen de asynchrone
      // `query:chunk`-events en de invoke-response van `start` is niet
      // gegarandeerd. De listener hier (of in `finally`) afmelden zou die
      // chunks weggooien → de tab bleef permanent `running:true` (alleen de
      // columns-chunk werd verwerkt). Daarom blijft de listener geregistreerd
      // en meldt `applyChunk` zich pas af wanneer de done/error-chunk van déze
      // executionId is verwerkt; alleen een falende `start()` (catch) ruimt de
      // listener hier direct op omdat er dan geen terminale chunk meer komt.
      await window.nvag.query.start(start.executionId)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      patchTab({
        result: {
          executionId: '',
          columns: [],
          rows: [],
          truncated: false,
          rowCount: 0,
          durationMs: 0,
          error: text,
          messages: [{ severity: 'error', text }]
        },
        running: false,
        executionId: null,
        startedAt: null
      })
      unsubscribe?.()
    } finally {
      get().useRecentQuery(querySql, tab.connectionId)
    }
  },

  async confirmGuardQuery() {
    const pending = get().pendingGuard
    if (!pending) return
    set({ pendingGuard: null })
    await get().runQuery(pending.tabId, pending.sql, { confirmed: true })
  },

  cancelGuardQuery() {
    set({ pendingGuard: null })
  },

  async cancelQuery(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.running || !tab.executionId) return
    // SAL-33: statusflow — tijdens de cancel-verwerking toont de toolbar
    // "Annuleren…" (knop disabled); het done-chunk zet de tab terug.
    const patchTab = (patch: Partial<QueryTabState>): void => {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
      }))
    }
    patchTab({ cancelling: true })
    try {
      await window.nvag.query.cancel(tab.executionId)
    } catch (err) {
      // Cancel zelf faalde: melding tonen en de knop weer actief maken.
      // De query kan daarna opnieuw geprobeerd worden te annuleren.
      const text = err instanceof Error ? err.message : String(err)
      const current = get().tabs.find((t) => t.id === tabId)
      patchTab({
        cancelling: false,
        result: {
          executionId: current?.executionId ?? '',
          columns: current?.result?.columns ?? [],
          rows: current?.result?.rows ?? [],
          truncated: current?.result?.truncated ?? false,
          rowCount: current?.result?.rowCount ?? 0,
          durationMs: current?.result?.durationMs ?? 0,
          error: `Cancel failed: ${text}`,
          messages: [
            ...(current?.result?.messages ?? []),
            { severity: 'error', text: `Cancel failed: ${text}` }
          ]
        }
      })
    }
    // De `cancelling`-vlag wordt door het done/error-chunk teruggezet.
  },

  async openQueryFile() {
    const res = await window.nvag.queryFiles.open()
    if (res.canceled || !res.path || res.content === undefined) return null
    const id = nextTabId()
    const tab: QueryTabState = {
      id,
      title: res.name ?? baseName(res.path),
      sql: res.content,
      connectionId: null,
      database: null,
      result: null,
      running: false,
      executionId: null,
      startedAt: null,
      filePath: res.path,
      dirty: false
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
    return id
  },

  async saveQueryFile(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    const res = await window.nvag.queryFiles.save(tab.sql, tab.filePath)
    if (res.canceled || !res.path) return
    const filePath: string = res.path
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, filePath, dirty: false, title: baseName(filePath) }
          : t
      )
    }))
  },

  async saveQueryFileAs(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    const res = await window.nvag.queryFiles.save(tab.sql)
    if (res.canceled || !res.path) return
    const filePath: string = res.path
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, filePath, dirty: false, title: baseName(filePath) }
          : t
      )
    }))
  },

  useRecentQuery(sql, connectionId) {
    const entry: RecentQueryEntry = { sql, connectionId, at: Date.now() }
    set((s) => {
      const next = [
        entry,
        ...s.recentQueries.filter((r) => !(r.sql === sql && r.connectionId === connectionId))
      ].slice(0, MAX_RECENT)
      persistRecentQueries(next)
      return { recentQueries: next }
    })
  },

  clearRecentQueries() {
    persistRecentQueries([])
    set({ recentQueries: [] })
  },

  async loadHistory(query) {
    const entries = await window.nvag.history.list(query, 100)
    set({ historyEntries: entries })
  },

  async clearHistory() {
    await window.nvag.history.clear()
    set({ historyEntries: [] })
  },

  async rerunHistoryEntry(entry) {
    // Nieuwe tab met de opgeslagen SQL + verbinding; direct draaien wanneer de
    // sessie nog open is (anders opent de tab en kan de gebruiker verbinden).
    const id = nextTabId()
    const tab: QueryTabState = {
      id,
      title: `History ${entry.id}`,
      sql: entry.sql,
      connectionId: entry.connectionId,
      database: entry.database || null,
      result: null,
      running: false,
      executionId: null,
      startedAt: null
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
    if (get().openSessions[entry.connectionId]) {
      await get().runQuery(id)
    }
  },

  openConnectionDialog(mode, connectionId) {
    set({
      showConnectionDialog: true,
      connectionDialogMode: mode,
      editingConnectionId: connectionId ?? null
    })
  },

  closeConnectionDialog() {
    set({ showConnectionDialog: false })
  },

  renameDatabaseInTabs(oldName, newName) {
    set((s) => ({
      tabs: s.tabs.map((tab) => {
        const next = { ...tab }
        if (next.database === oldName) next.database = newName
        if (next.tableData && next.tableData.database === oldName) {
          next.tableData = { ...next.tableData, database: newName }
        }
        return next
      })
    }))
  },

  // ------------------------------------------------------------------ F2-1
  openTableDataTab(connectionId, database, schema, table) {
    const id = nextTabId()
    const tab: QueryTabState = {
      id,
      title: `${table} — data`,
      sql: '',
      connectionId,
      database,
      result: null,
      running: false,
      executionId: null,
      startedAt: null,
      kind: 'table-data',
      tableData: {
        database,
        schema,
        table,
        data: null,
        loading: false,
        error: null,
        inserting: false,
        pendingEdit: null,
        lastEditMessage: null,
        lastSql: null
      }
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
    // SAL-42: meteen laden wanneer de sessie al open is; zonder sessie toont
    // het paneel een duidelijke melding en laadt zodra de sessie opengaat.
    if (get().openSessions[connectionId]) {
      void get().loadTableRows(id)
    }
  },

  async loadTableRows(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.connectionId || !tab.tableData) return
    // SAL-42: geen dubbele gelijktijdige loads (dubbelklik / auto-load-effect).
    if (tab.tableData.loading) return
    const patchTableData = (patch: Partial<QueryTabState['tableData']>): void => {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId && t.tableData
            ? { ...t, tableData: { ...t.tableData, ...patch } }
            : t
        )
      }))
    }
    if (!get().openSessions[tab.connectionId]) {
      // SAL-42: zonder sessie geen stille "Laden…" maar een duidelijke fout.
      patchTableData({ error: 'No active session for this connection. Open the connection first.' })
      return
    }
    // SAL-42: vorige fout wissen zodra een nieuwe poging begint.
    patchTableData({ loading: true, error: null })
    try {
      const data = await window.nvag.tableData.getRows(
        tab.connectionId,
        tab.tableData.database,
        tab.tableData.schema,
        tab.tableData.table,
        100
      )
      patchTableData({ data, inserting: false, loading: false, error: null })
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      // SAL-42: de fout gaat naar `error` (paneel toont een error-state i.p.v.
      // een eeuwige "Laden…"); `data` blijft staan bij een mislukte refresh.
      patchTableData({ loading: false, error: text })
    }
  },

  async saveTableEdit(tabId, kind, values, pkValues) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.connectionId || !tab.tableData) return
    const tableData = tab.tableData
    const req = {
      connectionId: tab.connectionId,
      database: tableData.database,
      schema: tableData.schema,
      table: tableData.table,
      kind,
      values,
      pkValues
    }
    try {
      const result = await window.nvag.tableData.edit(req)
      if (result.blocked && result.blocked.length > 0) {
        const environment = get().connections.find((c) => c.id === tab.connectionId)?.environment ?? 'DEV'
        set({
          pendingTableEdit: {
            tabId,
            kind,
            sql: result.sql,
            reasons: result.blocked,
            environment,
            values,
            pkValues
          }
        })
        return
      }
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId && t.tableData
            ? { ...t, tableData: { ...t.tableData, lastEditMessage: `✅ ${result.rowCount} row(s) ${kind === 'insert' ? 'added' : kind === 'delete' ? 'removed' : 'updated'}.`, lastSql: result.sql } }
            : t
        )
      }))
      await get().loadTableRows(tabId)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId && t.tableData
            ? { ...t, tableData: { ...t.tableData, lastEditMessage: `Error: ${text}` } }
            : t
        )
      }))
    }
  },

  async confirmTableEdit() {
    const pending = get().pendingTableEdit
    if (!pending) return
    set({ pendingTableEdit: null })
    const tab = get().tabs.find((t) => t.id === pending.tabId)
    if (!tab?.connectionId || !tab.tableData) return
    const tableData = tab.tableData
    try {
      const result = await window.nvag.tableData.edit({
        connectionId: tab.connectionId,
        database: tableData.database,
        schema: tableData.schema,
        table: tableData.table,
        kind: pending.kind,
        values: pending.values,
        pkValues: pending.pkValues,
        confirmed: true
      })
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === pending.tabId && t.tableData
            ? { ...t, tableData: { ...t.tableData, lastEditMessage: `✅ ${result.rowCount} row(s) ${pending.kind === 'insert' ? 'added' : pending.kind === 'delete' ? 'removed' : 'updated'}.`, lastSql: result.sql } }
            : t
        )
      }))
      await get().loadTableRows(pending.tabId)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === pending.tabId && t.tableData
            ? { ...t, tableData: { ...t.tableData, lastEditMessage: `Error: ${text}` } }
            : t
        )
      }))
    }
  },

  cancelTableEdit() {
    set((s) => ({
      pendingTableEdit: null,
      tabs: s.tabs.map((t) =>
        t.tableData ? { ...t, tableData: { ...t.tableData, pendingEdit: null } } : t
      )
    }))
  },

  // ------------------------------------------------------------------ F2-2
  async beginTransaction(connectionId) {
    const status = await window.nvag.transactions.begin(connectionId)
    set((s) => ({ transactionState: { ...s.transactionState, [connectionId]: status.state } }))
  },

  async commitTransaction(connectionId) {
    const status = await window.nvag.transactions.commit(connectionId)
    set((s) => ({ transactionState: { ...s.transactionState, [connectionId]: status.state } }))
  },

  async rollbackTransaction(connectionId) {
    const status = await window.nvag.transactions.rollback(connectionId)
    set((s) => ({ transactionState: { ...s.transactionState, [connectionId]: status.state } }))
  },

  async refreshTransactionState(connectionId) {
    try {
      const status = await window.nvag.transactions.status(connectionId)
      set((s) => ({ transactionState: { ...s.transactionState, [connectionId]: status.state } }))
    } catch {
      // geen sessie: status none
      set((s) => ({ transactionState: { ...s.transactionState, [connectionId]: 'none' } }))
    }
  },

  // ------------------------------------------------------------------ F2-5
  async runDatabaseSearch(connectionId, query) {
    set({ searching: true })
    try {
      const results = await window.nvag.search.search(connectionId, query, { limit: 200 })
      set({ searchResults: results, searching: false })
    } catch (err) {
      set({ searchResults: [], searching: false })
      void err
    }
  },

  openSearchMatch(connectionId, match) {
    // Open een querytab voor het object op de actieve verbinding.
    const sql =
      match.objectType === 'table' || match.objectType === 'view'
        ? `SELECT * FROM ${match.schema ? `"${match.schema}".` : ''}"${match.object}" LIMIT 100`
        : `-- ${match.objectType}: ${match.object}`
    get().addTab({ sql, connectionId, title: match.object })
  },

  // ------------------------------------------------------------------ F2-6
  async loadSnippets(folder) {
    const folders = await window.nvag.snippets.listFolders()
    const filter = folder ?? get().snippetFilterFolder
    const snippets = await window.nvag.snippets.list(filter)
    set({ snippets, snippetFolders: folders, snippetFilterFolder: filter })
  },

  async saveSnippet(entry) {
    await window.nvag.snippets.save(entry)
    await get().loadSnippets()
  },

  async removeSnippet(id) {
    await window.nvag.snippets.remove(id)
    await get().loadSnippets()
  },

  insertSnippetIntoEditor(tabId, sql) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return
    const current = tab.sql
    const next = current.length > 0 ? `${current}\n${sql}\n` : `${sql}\n`
    get().updateTabSql(tabId, next)
  },

  // ------------------------------------------------------------------ F2-7
  async pickImportFile() {
    const picked = await window.nvag.import.pickFile()
    if (picked.canceled || !picked.filePath || !picked.format) return
    set({ importBusy: true, importGeneratedSql: '' })
    try {
      const preview = await window.nvag.import.preview({ filePath: picked.filePath, format: picked.format })
      set({ importPreview: preview, importFilePath: picked.filePath, importBusy: false })
    } catch (err) {
      set({ importBusy: false })
      void err
    }
  },

  async generateImportSql(connectionId, table, schema, mapping, rowLimit) {
    const preview = get().importPreview
    const filePath = get().importFilePath
    if (!preview || !filePath) return
    set({ importBusy: true })
    try {
      const result = await window.nvag.import.generate({
        connectionId,
        filePath,
        format: preview.format,
        table,
        schema,
        mapping,
        rowLimit
      })
      set({ importGeneratedSql: result.sql, importBusy: false })
    } catch (err) {
      set({ importBusy: false })
      void err
    }
  },

  async executeImportSql(connectionId, confirmed) {
    const sql = get().importGeneratedSql
    if (!sql) return
    const result = await window.nvag.import.execute(connectionId, sql, confirmed)
    if (result.blocked && result.blocked.length > 0 && !confirmed) {
      // Toon guard-blokkade via hetzelfde dialoogmechanisme als query's.
      set({
        pendingGuard: {
          tabId: get().activeTabId ?? '',
          sql,
          reasons: result.blocked,
          environment: get().connections.find((c) => c.id === connectionId)?.environment ?? 'DEV'
        }
      })
      return
    }
    if (result.ok) {
      set({ importGeneratedSql: '' })
    }
  },

  // ------------------------------------------------------------------ F2-8
  async loadAudit() {
    const entries = await window.nvag.audit.list(200)
    set({ auditEntries: entries })
  },

  async clearAudit() {
    await window.nvag.audit.clear()
    set({ auditEntries: [] })
  },

  // ------------------------------------------------------------------ F2-10
  async loadDashboard(connectionId) {
    const dashboard = await window.nvag.dashboard.get(connectionId)
    set({ dashboard })
  },

  // ------------------------------------------------------------------ F2-3
  openAdminDialog(connectionId?: string, tab?: AdminDialogTab, database?: string | null) {
    set({
      showAdminDialog: true,
      adminDialogConnectionId: connectionId ?? null,
      adminDialogTab: tab ?? null,
      adminDialogDatabase: database ?? null
    })
  },

  closeAdminDialog() {
    set({ showAdminDialog: false, adminDialogConnectionId: null, adminDialogTab: null, adminDialogDatabase: null })
  },

  async loadAdminState(connectionId) {
    if (!connectionId) return
    try {
      const [caps, users] = await Promise.all([
        window.nvag.admin.capabilities(connectionId),
        window.nvag.admin.listUsers(connectionId)
      ])
      set({ adminCapabilities: caps, adminUsers: users })
    } catch {
      // zonder sessie geen admin-state
    }
  },

  bumpDbListRevision() {
    set((s) => ({ dbListRevision: s.dbListRevision + 1 }))
  },

  bumpDbObjectsRevision() {
    set((s) => ({ dbObjectsRevision: s.dbObjectsRevision + 1 }))
  }
  }
})
