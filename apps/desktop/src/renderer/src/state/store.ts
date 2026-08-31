import { create } from 'zustand'
import type {
  ConnectionConfig,
  ConnectionSecret,
  DbObjectRef,
  ErrorPosition,
  HistoryEntry,
  QueryChunk,
  QueryMessage,
  QueryResultSet,
  QueryRunResponse,
  ScriptKind,
  ServerInfo,
  SqlDialectId
} from '@nvag/contracts'
import { buildSelectStar } from '@nvag/sql-dialect'
import { loadRecentQueries, persistRecentQueries, type RecentQueryEntry } from './recentQueries'

export interface QueryTabState {
  id: string
  title: string
  sql: string
  connectionId: string | null
  result: QueryRunResponse | null
  running: boolean
  /** Actieve uitvoering (voor cancel); null wanneer niet bezig. */
  executionId: string | null
  /** Starttijd van de actieve uitvoering (execution timer). */
  startedAt: number | null
  /** Pad van een geopend/opgeslagen querybestand (optioneel). */
  filePath?: string
  /** Bewerkingsvlag: true zodra SQL afwijkt van het bestand op schijf. */
  dirty?: boolean
}

export interface ConnectionWithSession {
  config: ConnectionConfig
  sessionId: string
  serverInfo: ServerInfo
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

  loadConnections: () => Promise<void>
  saveConnection: (config: ConnectionConfig, secret?: ConnectionSecret) => Promise<ConnectionConfig>
  removeConnection: (id: string) => Promise<void>
  openSession: (config: ConnectionConfig, secret?: ConnectionSecret) => Promise<ServerInfo>
  closeSession: (connectionId: string) => Promise<void>

  /** Nieuwe lege query-tab; met `opts` direct met sql/verbinding/titel gevuld. */
  addTab: (opts?: { sql?: string; connectionId?: string | null; title?: string }) => void
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
  /** Voer query uit; met `sql` wordt die selectie uitgevoerd i.p.v. de hele tab. */
  runQuery: (tabId: string, sql?: string) => Promise<void>
  /** Annuleer de actieve uitvoering van een tab. */
  cancelQuery: (tabId: string) => Promise<void>

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
}

let tabCounter = 1
/** Zorgt voor unieke tab-ids, ook binnen dezelfde milliseconde. */
let tabSeq = 0
function nextTabId(): string {
  tabSeq += 1
  return `tab-${Date.now()}-${tabSeq}`
}

const MAX_RECENT = 20

/** providerId → dialect (F1: sqlserver/postgresql/mysql; uitbreiden per provider). */
const PROVIDER_DIALECT: Record<string, SqlDialectId> = {
  sqlite: 'sqlite',
  sqlserver: 'tsql',
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mysql',
  db2: 'db2'
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
    startedAt: null
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
    return serverInfo
  },

  async closeSession(connectionId) {
    const session = get().openSessions[connectionId]
    if (session) {
      await window.nvag.sessions.close(session.sessionId)
      set((s) => {
        const next = { ...s.openSessions }
        delete next[connectionId]
        return { openSessions: next }
      })
    }
  },

  addTab(opts) {
    const id = nextTabId()
    const tab: QueryTabState = {
      id,
      title:
        opts?.title ??
        (opts?.connectionId
          ? (get().connections.find((c) => c.id === opts.connectionId)?.name ?? 'Query')
          : `Query ${tabCounter++}`),
      sql: opts?.sql ?? '',
      connectionId: opts?.connectionId ?? null,
      result: null,
      running: false,
      executionId: null,
      startedAt: null
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
  },

  async openScriptTab(connectionId, obj, kind) {
    const { sql, title } = await window.nvag.metadata.scriptObject(connectionId, obj, kind)
    get().addTab({ sql, connectionId, title })
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
      result: null,
      running: false,
      executionId: null,
      startedAt: null
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
      result: null,
      running: false,
      executionId: null,
      startedAt: null
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
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, connectionId } : t)) }))
  },

  /**
   * Voert een query uit met streaming: `run` geeft executionId, chunks komen
   * binnen via `onChunk`, `start` laat de runner consumeren. De grid vult
   * zich progressief; bij `done`/`error` stopt de tab.
   */
  async runQuery(tabId, sql) {
    const tab = get().tabs.find((t) => t.id === tabId)
    const querySql = (sql ?? tab?.sql ?? '').trim()
    if (!tab || !tab.connectionId || tab.running) return
    const session = get().openSessions[tab.connectionId]
    if (!session) return

    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, running: true, result: null, executionId: null, startedAt: Date.now() }
          : t
      )
    }))

    const acc = createAccumulator()
    let unsubscribe: (() => void) | null = null

    const patchTab = (patch: Partial<QueryTabState>): void => {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...patch } : t))
      }))
    }

    const applyChunk = (chunk: QueryChunk, executionId: string): void => {
      if (chunk.kind === 'columns') {
        acc.results.push({ columns: chunk.columns, rows: [], truncated: false, rowCount: 0 })
      } else if (chunk.kind === 'rows') {
        const rs = acc.results[acc.results.length - 1]
        if (rs) {
          rs.rows.push(...chunk.rows)
          rs.rowCount += chunk.rows.length
        }
      } else if (chunk.kind === 'warning') {
        acc.messages.push({ severity: 'warning', text: chunk.message, position: chunk.position })
      } else if (chunk.kind === 'error') {
        acc.error = chunk.message
        acc.errorPosition = chunk.position
        acc.messages.push({ severity: 'error', text: chunk.message, position: chunk.position })
        patchTab({ result: buildResult(acc, executionId), running: false, executionId: null, startedAt: null })
        unsubscribe?.()
        return
      } else {
        // done
        acc.durationMs = chunk.durationMs
        acc.doneRowCount = chunk.rowCount
        acc.cancelled = chunk.cancelled ?? false
        if (chunk.truncated) {
          const rs = acc.results[acc.results.length - 1]
          if (rs) rs.truncated = true
          if (!acc.messages.some((m) => m.severity === 'warning' && /afgekapt/i.test(m.text))) {
            acc.messages.push({ severity: 'warning', text: 'Resultaat afgekapt op de max-rij-cap.' })
          }
        }
        patchTab({ result: buildResult(acc, executionId), running: false, executionId: null, startedAt: null })
        unsubscribe?.()
        return
      }
      // Tussentijdse (streaming) update: grid vult zich progressief.
      patchTab({ result: buildResult(acc, executionId) })
    }

    try {
      const start = await window.nvag.query.run({
        connectionId: tab.connectionId,
        sql: querySql
      })

      if (start.blocked && start.blocked.length > 0) {
        const text = `Query geblokkeerd door environment safety (${start.blocked.join(', ')}). Bevestiging vereist.`
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
    } finally {
      unsubscribe?.()
      get().useRecentQuery(querySql, tab.connectionId)
    }
  },

  async cancelQuery(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab?.running || !tab.executionId) return
    await window.nvag.query.cancel(tab.executionId)
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
  }
  }
})
