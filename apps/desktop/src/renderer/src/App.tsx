import { useEffect, useState } from 'react'
import type { DatabaseInfo } from '@nvag/contracts'
import { ObjectExplorer } from './components/ObjectExplorer'
import { QueryEditor } from './components/QueryEditor'
import { ResultsGrid, MessagesPanel } from './components/ResultsGrid'
import { HistoryPanel } from './components/HistoryPanel'
import { ConnectionDialog } from './components/ConnectionDialog'
import { QueryGuardDialog } from './components/QueryGuardDialog'
import { TableEditConfirmDialog } from './components/TableEditConfirmDialog'
import { TableDataPanel } from './components/TableDataPanel'
import { SearchPanel, SnippetsPanel, ImportPanel, AuditPanel, DashboardPanel, PerformancePanel, MonitoringPanel } from './components/F2Panels'
import { ComparePanel, DependenciesPanel, ErdPanel, AiPanel, PluginsPanel } from './components/F3Panels'
import { AdminDialog } from './components/AdminDialog'
import { EnvBadge, StatusBar } from './components/StatusBar'
import { MenuBar, type MenuDef } from './components/MenuBar'
import { useAppStore, getDialectForProvider } from './state/store'

type BottomTab = 'results' | 'messages' | 'history' | 'search' | 'snippets' | 'import' | 'audit' | 'dashboard' | 'performance' | 'monitoring' | 'compare' | 'dependencies' | 'erd' | 'ai' | 'plugins'

/** Kort een SQL-tekst af voor de recente-query's-dropdown. */
function shortSql(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine
}

/** Execution timer-weergave: ms → "1,2 s" → "m:ss". */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

function App(): React.JSX.Element {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const connections = useAppStore((s) => s.connections)
  const openSessions = useAppStore((s) => s.openSessions)
  const recentQueries = useAppStore((s) => s.recentQueries)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const addTab = useAppStore((s) => s.addTab)
  const duplicateTab = useAppStore((s) => s.duplicateTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const switchTabConnection = useAppStore((s) => s.switchTabConnection)
  const setTabDatabase = useAppStore((s) => s.setTabDatabase)
  const runQuery = useAppStore((s) => s.runQuery)
  const cancelQuery = useAppStore((s) => s.cancelQuery)
  const openQueryFile = useAppStore((s) => s.openQueryFile)
  const saveQueryFile = useAppStore((s) => s.saveQueryFile)
  const saveQueryFileAs = useAppStore((s) => s.saveQueryFileAs)
  const openConnectionDialog = useAppStore((s) => s.openConnectionDialog)
  const closeSession = useAppStore((s) => s.closeSession)
  const transactionState = useAppStore((s) => s.transactionState)
  const beginTransaction = useAppStore((s) => s.beginTransaction)
  const commitTransaction = useAppStore((s) => s.commitTransaction)
  const rollbackTransaction = useAppStore((s) => s.rollbackTransaction)
  const refreshTransactionState = useAppStore((s) => s.refreshTransactionState)
  const openAdminDialog = useAppStore((s) => s.openAdminDialog)
  const showAdminDialog = useAppStore((s) => s.showAdminDialog)
  // SAL-34: Object Explorer kan de admin-dialoog voor een specifieke verbinding
  // openen (contextmenu); anders de verbinding van de actieve tab gebruiken.
  const adminDialogConnectionId = useAppStore((s) => s.adminDialogConnectionId)
  // SAL-31: na CREATE/DROP DATABASE via AdminDialog ook de database-dropdown
  // van de actieve tab opnieuw laden.
  const dbListRevision = useAppStore((s) => s.dbListRevision)

  const [bottomTab, setBottomTab] = useState<BottomTab>('results')
  const [now, setNow] = useState(() => Date.now())
  /** Beschikbare databases van de actieve verbinding (database-dropdown, eis 24). */
  const [databases, setDatabases] = useState<DatabaseInfo[]>([])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  // Database-dropdown (eis 24): laadt de databases van de actieve verbinding.
  useEffect(() => {
    let cancelled = false
    const connId = activeTab?.connectionId
    if (connId && openSessions[connId]) {
      window.nvag.metadata
        .listDatabases(connId)
        .then((list) => {
          if (!cancelled) setDatabases(list)
        })
        .catch(() => {
          if (!cancelled) setDatabases([])
        })
    } else {
      setDatabases([])
    }
    return () => {
      cancelled = true
    }
  }, [activeTab?.connectionId, openSessions, activeTabId, dbListRevision])

  // Execution timer: tikt alleen zolang een query draait (SAL-17).
  useEffect(() => {
    if (!activeTab?.running) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(t)
  }, [activeTab?.running, activeTabId])

  // Transactiestatus (F2-2): ververs bij actieve verbinding.
  useEffect(() => {
    const connId = activeTab?.connectionId
    if (connId && openSessions[connId]) {
      void refreshTransactionState(connId)
    }
  }, [activeTab?.connectionId, openSessions, refreshTransactionState])

  const activeConn = activeTab?.connectionId
    ? connections.find((c) => c.id === activeTab.connectionId)
    : undefined
  const activeSession = activeTab?.connectionId ? openSessions[activeTab.connectionId] : undefined
  // Eigen database per tab (eis 24); fallback naar verbindingsdefault.
  const database =
    activeTab?.database ?? activeConn?.database ?? activeSession?.serverInfo.currentDatabase ?? 'main'
  const schema = activeConn?.providerId === 'sqlite' ? 'main' : undefined
  const elapsedMs =
    activeTab?.running && activeTab.startedAt != null
      ? now - activeTab.startedAt
      : (activeTab?.result?.durationMs ?? 0)

  // App-breede shortcuts (F5, Ctrl+O/S/Shift+S); de editor zelf vangt ze ook
  // af wanneer hij focus heeft (via Monaco-actions) — hier guarden we daarop.
  useEffect(() => {
    const isInsideEditor = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest('.monaco-editor') !== null

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!activeTab || isInsideEditor(e.target)) return
      const mod = e.ctrlKey || e.metaKey
      if (e.key === 'F5') {
        e.preventDefault()
        void runQuery(activeTab.id)
      } else if (mod && e.key.toLowerCase() === 's' && e.shiftKey) {
        e.preventDefault()
        void saveQueryFileAs(activeTab.id)
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveQueryFile(activeTab.id)
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openQueryFile()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeTab, runQuery, saveQueryFile, saveQueryFileAs, openQueryFile])

  const statusTitle = (tabId: string): string => {
    const conn = connections.find((c) => c.id === tabId)
    return conn ? `${conn.name} · ${conn.database ?? '—'} · user: ${conn.username ?? '—'}` : 'No connection'
  }

  // SAL-52: menubalk — Bestand-menu vervangt de bestandsknoppen in de
  // query-toolbar. Bewust Nederlands ("Bestand" i.p.v. "File"): de rest van
  // de UI is Nederlandstalig. De structuur is generiek/uitbreidbaar; later
  // Bewerken/Beeld/Help = extra MenuDef in de array hieronder.
  const fileMenu: MenuDef = {
    id: 'file',
    label: 'File',
    items: [
      { type: 'action', label: 'New query', onSelect: () => addTab() },
      { type: 'separator' },
      { type: 'action', label: 'Open…', shortcut: 'Ctrl+O', onSelect: () => void openQueryFile() },
      {
        type: 'action',
        label: 'Save',
        shortcut: 'Ctrl+S',
        disabled: activeTab?.filePath === undefined,
        onSelect: () => {
          if (activeTab) void saveQueryFile(activeTab.id)
        }
      },
      {
        type: 'action',
        label: 'Save As…',
        shortcut: 'Ctrl+Shift+S',
        disabled: !activeTab,
        onSelect: () => {
          if (activeTab) void saveQueryFileAs(activeTab.id)
        }
      },
      { type: 'separator' },
      recentQueries.length > 0
        ? {
            type: 'submenu',
            label: "Recent queries",
            items: recentQueries.slice(0, 10).map((entry) => ({
              type: 'action',
              label: `${shortSql(entry.sql)} — ${
                connections.find((c) => c.id === entry.connectionId)?.name ?? 'standalone query'
              }`,
              onSelect: () => addTab({ sql: entry.sql, connectionId: entry.connectionId })
            }))
          }
        : { type: 'action', label: "Recent queries", disabled: true, onSelect: () => {} },
      { type: 'separator' },
      {
        type: 'action',
        label: 'Manage connections…',
        onSelect: () => openConnectionDialog('create')
      },
      { type: 'action', label: 'Quit', onSelect: () => void window.nvag.app.quit() }
    ]
  }

  return (
    <div className="app-shell">
      <MenuBar menus={[fileMenu]} />
      <div className="app-main-row">
        <div className="sidebar">
          <ObjectExplorer />
        </div>
        <div className="main-area">
          <div className="tab-bar">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`tab ${tab.id === activeTabId ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                title={statusTitle(tab.connectionId ?? '')}
              >
                <span>{tab.title}</span>
                {tab.filePath && tab.dirty && <span className="tab-dirty">●</span>}
                {tab.connectionId && (
                  <EnvBadge
                    environment={connections.find((c) => c.id === tab.connectionId)?.environment ?? 'DEV'}
                  />
                )}
                <button
                  className="tab-action"
                  title="Duplicate tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    duplicateTab(tab.id)
                  }}
                >
                  ⧉
                </button>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="tab-add" onClick={() => addTab()} title="New query tab">
              +
            </button>
          </div>

          {activeTab && (
            <>
              {/* Statusindicatie per tab: server · database · schema · gebruiker + env-kleurbadge */}
              <div className="tab-context">
                <span className="tab-context-item">
                  {activeConn ? activeConn.name : 'no server'}
                </span>
                <span className="tab-context-sep">·</span>
                <span className="tab-context-item">
                  db: {activeTab.database ?? activeConn?.database ?? activeSession?.serverInfo.currentDatabase ?? '—'}
                </span>
                <span className="tab-context-sep">·</span>
                <span className="tab-context-item">schema: {schema ?? '—'}</span>
                <span className="tab-context-sep">·</span>
                <span className="tab-context-item">
                  user: {activeSession?.serverInfo.currentUser ?? activeConn?.username ?? '—'}
                </span>
                {activeConn && <EnvBadge environment={activeConn.environment} />}
                {activeTab.dbSwitchError && (
                  <span className="tab-context-error" title={activeTab.dbSwitchError}>
                    ⚠ {activeTab.dbSwitchError}
                  </span>
                )}
                {activeTab.filePath && (
                  <span className="tab-context-file">
                    📄 {activeTab.filePath}
                    {activeTab.dirty ? ' ●' : ''}
                  </span>
                )}
              </div>

              <div className="editor-toolbar">
                <select
                  value={activeTab.connectionId ?? ''}
                  onChange={(e) => void switchTabConnection(activeTab.id, e.target.value || null)}
                  title="Connected server of this tab (selecting opens the session)"
                >
                  <option value="">— no connection —</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  className="database-select"
                  value={activeTab.database ?? ''}
                  onChange={(e) => void setTabDatabase(activeTab.id, e.target.value)}
                  disabled={!activeTab.connectionId || !openSessions[activeTab.connectionId]}
                  title="Database of this tab"
                >
                  <option value="">— database —</option>
                  {databases.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>
                {activeTab.running ? (
                  <>
                    <span
                      className={`exec-status ${activeTab.cancelling ? 'cancelling' : 'running'}`}
                      title={activeTab.cancelling ? 'Cancelling…' : 'Query is running'}
                    >
                      ◉ {activeTab.cancelling ? 'Cancelling…' : 'Running…'}
                    </span>
                    <button
                      className="danger"
                      onClick={() => cancelQuery(activeTab.id)}
                      disabled={activeTab.cancelling}
                      title={activeTab.cancelling ? 'Cancelling…' : 'Cancel query'}
                    >
                      ■ {activeTab.cancelling ? 'Cancelling…' : 'Cancel'}
                    </button>
                    <span className="exec-timer" title="Elapsed time">
                      ⏱ {formatElapsed(elapsedMs)}
                    </span>
                  </>
                ) : (
                  <>
                    {activeTab.result?.cancelled && (
                      <span className="exec-status cancelled" title="Query cancelled by user">
                        ✕ Cancelled
                      </span>
                    )}
                    <button
                      className="primary"
                      onClick={() => runQuery(activeTab.id)}
                      disabled={!activeTab.connectionId || !openSessions[activeTab.connectionId]}
                      title="Run (F5 / Ctrl+Enter)"
                    >
                      ▶ Run
                    </button>
                  </>
                )}
                <select
                  className="recent-queries"
                  defaultValue=""
                  onChange={(e) => {
                    const idx = Number(e.target.value)
                    const entry = recentQueries[idx]
                    if (!Number.isNaN(idx) && entry) {
                      addTab({ sql: entry.sql, connectionId: entry.connectionId })
                    }
                    e.target.value = ''
                  }}
                  title="Recent queries"
                >
                  <option value="">🕘 Recent queries</option>
                  {recentQueries.slice(0, 10).map((entry, i) => (
                    <option key={`${entry.at}-${i}`} value={i}>
                      {shortSql(entry.sql)} —{' '}
                      {connections.find((c) => c.id === entry.connectionId)?.name ?? 'standalone query'}
                    </option>
                  ))}
                </select>
                <button onClick={() => openConnectionDialog('create')}>＋ Connection</button>
                {activeTab.connectionId && openSessions[activeTab.connectionId] && (
                  <>
                    <button
                      onClick={() => openAdminDialog()}
                      title="Database Administration (F2-3)"
                    >
                      🛠 Admin
                    </button>
                    {transactionState[activeTab.connectionId] === 'active' ? (
                      <>
                        <span className="tx-indicator active" title="Active transaction">
                          ⟳ TX active
                        </span>
                        <button onClick={() => void commitTransaction(activeTab.connectionId!)} title="COMMIT">
                          ✔ Commit
                        </button>
                        <button
                          className="danger"
                          onClick={() => void rollbackTransaction(activeTab.connectionId!)}
                          title="ROLLBACK"
                        >
                          ↶ Rollback
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => void beginTransaction(activeTab.connectionId!)}
                        title="Start transaction (F2-2, req 23)"
                      >
                        ⟳ Start TX
                      </button>
                    )}
                    <button onClick={() => closeSession(activeTab.connectionId!)}>Close connection</button>
                  </>
                )}
              </div>
              <div className="editor-pane">
                {activeTab.kind === 'table-data' ? (
                  <TableDataPanel tabId={activeTab.id} />
                ) : (
                  <QueryEditor
                    key={activeTab.id}
                    tabId={activeTab.id}
                    sql={activeTab.sql}
                    connectionId={activeTab.connectionId}
                    dialect={getDialectForProvider(activeConn?.providerId ?? 'sqlite')}
                    database={database}
                    schema={schema}
                    onRun={() => runQuery(activeTab.id)}
                    onRunSelection={(selectionSql) => runQuery(activeTab.id, selectionSql)}
                    onOpenFile={() => openQueryFile()}
                    onSaveFile={() => saveQueryFile(activeTab.id)}
                    onSaveFileAs={() => saveQueryFileAs(activeTab.id)}
                    errorPosition={activeTab.result?.errorPosition ?? null}
                    errorMessage={activeTab.result?.error ?? null}
                  />
                )}
              </div>
              <div className="results-pane">
                <div className="results-tabs" role="tablist" aria-label="Results pane">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'results'}
                    className={`results-tab ${bottomTab === 'results' ? 'active' : ''}`}
                    onClick={() => setBottomTab('results')}
                  >
                    Results
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'messages'}
                    className={`results-tab ${bottomTab === 'messages' ? 'active' : ''}`}
                    onClick={() => setBottomTab('messages')}
                  >
                    Messages
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'history'}
                    className={`results-tab ${bottomTab === 'history' ? 'active' : ''}`}
                    onClick={() => setBottomTab('history')}
                  >
                    History
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'search'}
                    className={`results-tab ${bottomTab === 'search' ? 'active' : ''}`}
                    onClick={() => setBottomTab('search')}
                  >
                    Search
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'snippets'}
                    className={`results-tab ${bottomTab === 'snippets' ? 'active' : ''}`}
                    onClick={() => setBottomTab('snippets')}
                  >
                    Snippets
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'import'}
                    className={`results-tab ${bottomTab === 'import' ? 'active' : ''}`}
                    onClick={() => setBottomTab('import')}
                  >
                    Import
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'audit'}
                    className={`results-tab ${bottomTab === 'audit' ? 'active' : ''}`}
                    onClick={() => setBottomTab('audit')}
                  >
                    Audit
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'dashboard'}
                    className={`results-tab ${bottomTab === 'dashboard' ? 'active' : ''}`}
                    onClick={() => setBottomTab('dashboard')}
                  >
                    Dashboard
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'performance'}
                    className={`results-tab ${bottomTab === 'performance' ? 'active' : ''}`}
                    onClick={() => setBottomTab('performance')}
                  >
                    Performance
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'monitoring'}
                    className={`results-tab ${bottomTab === 'monitoring' ? 'active' : ''}`}
                    onClick={() => setBottomTab('monitoring')}
                  >
                    Monitoring
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'compare'}
                    className={`results-tab ${bottomTab === 'compare' ? 'active' : ''}`}
                    onClick={() => setBottomTab('compare')}
                  >
                    Compare
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'dependencies'}
                    className={`results-tab ${bottomTab === 'dependencies' ? 'active' : ''}`}
                    onClick={() => setBottomTab('dependencies')}
                  >
                    Dependencies
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'erd'}
                    className={`results-tab ${bottomTab === 'erd' ? 'active' : ''}`}
                    onClick={() => setBottomTab('erd')}
                  >
                    ER diagram
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'ai'}
                    className={`results-tab ${bottomTab === 'ai' ? 'active' : ''}`}
                    onClick={() => setBottomTab('ai')}
                  >
                    AI
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'plugins'}
                    className={`results-tab ${bottomTab === 'plugins' ? 'active' : ''}`}
                    onClick={() => setBottomTab('plugins')}
                  >
                    Plugins
                  </button>
                </div>
                <div className="results-content">
                  {bottomTab === 'results' ? (
                    <ResultsGrid result={activeTab.result} running={activeTab.running} />
                  ) : bottomTab === 'messages' ? (
                    <MessagesPanel
                      result={activeTab.result}
                      running={activeTab.running}
                      elapsedMs={elapsedMs}
                    />
                  ) : bottomTab === 'history' ? (
                    <HistoryPanel />
                  ) : bottomTab === 'search' ? (
                    <SearchPanel connectionId={activeTab.connectionId} />
                  ) : bottomTab === 'snippets' ? (
                    <SnippetsPanel activeTabId={activeTab.id} />
                  ) : bottomTab === 'import' ? (
                    <ImportPanel connectionId={activeTab.connectionId} />
                  ) : bottomTab === 'audit' ? (
                    <AuditPanel />
                  ) : bottomTab === 'performance' ? (
                    <PerformancePanel connectionId={activeTab.connectionId} sql={activeTab.sql} />
                  ) : bottomTab === 'monitoring' ? (
                    <MonitoringPanel connectionId={activeTab.connectionId} />
                  ) : bottomTab === 'compare' ? (
                    <ComparePanel activeConnectionId={activeTab.connectionId} />
                  ) : bottomTab === 'dependencies' ? (
                    <DependenciesPanel connectionId={activeTab.connectionId} />
                  ) : bottomTab === 'erd' ? (
                    <ErdPanel connectionId={activeTab.connectionId} />
                  ) : bottomTab === 'ai' ? (
                    <AiPanel connectionId={activeTab.connectionId} activeTabId={activeTab.id} activeSql={activeTab.sql} />
                  ) : bottomTab === 'plugins' ? (
                    <PluginsPanel />
                  ) : (
                    <DashboardPanel connectionId={activeTab.connectionId} />
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <StatusBar />
      <ConnectionDialog />
      <QueryGuardDialog />
      <TableEditConfirmDialog />
      {showAdminDialog && (adminDialogConnectionId ?? activeTab?.connectionId) && (
        <AdminDialog connectionId={adminDialogConnectionId ?? activeTab!.connectionId!} />
      )}
    </div>
  )
}

export default App
