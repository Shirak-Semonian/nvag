import { create } from 'zustand'
import type {
  ConnectionConfig,
  ConnectionSecret,
  QueryRunResponse,
  ServerInfo,
  SqlDialectId
} from '@nvag/contracts'
import { buildSelectStar } from '@nvag/sql-dialect'

export interface QueryTabState {
  id: string
  title: string
  sql: string
  connectionId: string | null
  result: QueryRunResponse | null
  running: boolean
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
  showConnectionDialog: boolean
  connectionDialogMode: 'create' | 'edit'
  editingConnectionId: string | null

  loadConnections: () => Promise<void>
  saveConnection: (config: ConnectionConfig, secret?: ConnectionSecret) => Promise<ConnectionConfig>
  removeConnection: (id: string) => Promise<void>
  openSession: (config: ConnectionConfig, secret?: ConnectionSecret) => Promise<ServerInfo>
  closeSession: (connectionId: string) => Promise<void>

  /** Nieuwe lege query-tab; met `opts` direct met sql/verbinding gevuld. */
  addTab: (opts?: { sql?: string; connectionId?: string }) => void
  /** Nieuwe tab met een SELECT * FROM <tabel> (dubbelklik in Object Explorer). */
  openTableQuery: (connectionId: string, tableName: string, schema?: string) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTabSql: (id: string, sql: string) => void
  setTabConnection: (id: string, connectionId: string | null) => void
  runQuery: (tabId: string) => Promise<void>

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

/** F0: alle geregistreerde providers spreken SQLite-dialect (uitbreiden per provider). */
const PROVIDER_DIALECT: Record<string, SqlDialectId> = {
  sqlite: 'sqlite'
}

function initialTab(): QueryTabState {
  const id = nextTabId()
  return {
    id,
    title: `Query ${tabCounter++}`,
    sql: '',
    connectionId: null,
    result: null,
    running: false
  }
}

export const useAppStore = create<AppState>((set, get) => {
  const first = initialTab()
  return {
    connections: [],
    openSessions: {},
    tabs: [first],
    activeTabId: first.id,
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
      title: opts?.connectionId
        ? (get().connections.find((c) => c.id === opts.connectionId)?.name ?? 'Query')
        : `Query ${tabCounter++}`,
      sql: opts?.sql ?? '',
      connectionId: opts?.connectionId ?? null,
      result: null,
      running: false
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
  },

  openTableQuery(connectionId, tableName, schema) {
    const conn = get().connections.find((c) => c.id === connectionId)
    const dialect = conn ? (PROVIDER_DIALECT[conn.providerId] ?? 'sqlite') : 'sqlite'
    const sql = buildSelectStar(dialect, tableName, schema, 100)
    const id = nextTabId()
    const tab: QueryTabState = {
      id,
      title: tableName,
      sql,
      connectionId,
      result: null,
      running: false
    }
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
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
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sql } : t)) }))
  },

  setTabConnection(id, connectionId) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, connectionId } : t)) }))
  },

  async runQuery(tabId) {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab || !tab.connectionId || tab.running) return
    const session = get().openSessions[tab.connectionId]
    if (!session) return

    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, running: true } : t))
    }))

    try {
      const result = await window.nvag.query.run({
        connectionId: tab.connectionId,
        sql: tab.sql
      })
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, result, running: false } : t))
      }))
    } catch (err) {
      const result: QueryRunResponse = {
        executionId: '',
        columns: [],
        rows: [],
        truncated: false,
        rowCount: 0,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err)
      }
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, result, running: false } : t))
      }))
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
