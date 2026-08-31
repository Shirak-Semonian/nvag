import { useEffect, useState } from 'react'
import { ObjectExplorer } from './components/ObjectExplorer'
import { QueryEditor } from './components/QueryEditor'
import { ResultsGrid, MessagesPanel } from './components/ResultsGrid'
import { HistoryPanel } from './components/HistoryPanel'
import { ConnectionDialog } from './components/ConnectionDialog'
import { EnvBadge, StatusBar } from './components/StatusBar'
import { useAppStore, getDialectForProvider } from './state/store'

type BottomTab = 'results' | 'messages' | 'history'

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
  const setTabConnection = useAppStore((s) => s.setTabConnection)
  const runQuery = useAppStore((s) => s.runQuery)
  const cancelQuery = useAppStore((s) => s.cancelQuery)
  const openQueryFile = useAppStore((s) => s.openQueryFile)
  const saveQueryFile = useAppStore((s) => s.saveQueryFile)
  const saveQueryFileAs = useAppStore((s) => s.saveQueryFileAs)
  const openConnectionDialog = useAppStore((s) => s.openConnectionDialog)
  const closeSession = useAppStore((s) => s.closeSession)

  const [bottomTab, setBottomTab] = useState<BottomTab>('results')
  const [now, setNow] = useState(() => Date.now())

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  // Execution timer: tikt alleen zolang een query draait (SAL-17).
  useEffect(() => {
    if (!activeTab?.running) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(t)
  }, [activeTab?.running, activeTabId])

  const activeConn = activeTab?.connectionId
    ? connections.find((c) => c.id === activeTab.connectionId)
    : undefined
  const activeSession = activeTab?.connectionId ? openSessions[activeTab.connectionId] : undefined
  const database = activeConn?.database ?? activeSession?.serverInfo.currentDatabase ?? 'main'
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
    return conn ? `${conn.name} · ${conn.database ?? '—'} · gebruiker: ${conn.username ?? '—'}` : 'Geen verbinding'
  }

  return (
    <div className="app-shell">
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
                  title="Tab dupliceren"
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
            <button className="tab-add" onClick={() => addTab()} title="Nieuwe query-tab">
              +
            </button>
          </div>

          {activeTab && (
            <>
              {/* Statusindicatie per tab: server · database · schema · gebruiker + env-kleurbadge */}
              <div className="tab-context">
                <span className="tab-context-item">
                  {activeConn ? activeConn.name : 'geen server'}
                </span>
                <span className="tab-context-sep">·</span>
                <span className="tab-context-item">
                  db: {activeConn?.database ?? activeSession?.serverInfo.currentDatabase ?? '—'}
                </span>
                <span className="tab-context-sep">·</span>
                <span className="tab-context-item">schema: {schema ?? '—'}</span>
                <span className="tab-context-sep">·</span>
                <span className="tab-context-item">
                  gebruiker: {activeSession?.serverInfo.currentUser ?? activeConn?.username ?? '—'}
                </span>
                {activeConn && <EnvBadge environment={activeConn.environment} />}
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
                  onChange={(e) => setTabConnection(activeTab.id, e.target.value || null)}
                >
                  <option value="">— geen verbinding —</option>
                  {connections.map((c) => (
                    <option key={c.id} value={c.id} disabled={!openSessions[c.id]}>
                      {c.name} {openSessions[c.id] ? '' : '(niet verbonden)'}
                    </option>
                  ))}
                </select>
                {activeTab.running ? (
                  <>
                    <button
                      className="danger"
                      onClick={() => cancelQuery(activeTab.id)}
                      title="Query annuleren"
                    >
                      ■ Annuleren
                    </button>
                    <span className="exec-timer" title="Verstreken tijd">
                      ⏱ {formatElapsed(elapsedMs)}
                    </span>
                  </>
                ) : (
                  <button
                    className="primary"
                    onClick={() => runQuery(activeTab.id)}
                    disabled={!activeTab.connectionId || !openSessions[activeTab.connectionId]}
                    title="Uitvoeren (F5 / Ctrl+Enter)"
                  >
                    ▶ Uitvoeren
                  </button>
                )}
                <button
                  onClick={() => openQueryFile()}
                  title="Querybestand openen (Ctrl+O)"
                >
                  📂 Openen
                </button>
                <button
                  onClick={() => saveQueryFile(activeTab.id)}
                  disabled={activeTab.filePath === undefined}
                  title="Querybestand opslaan (Ctrl+S)"
                >
                  💾 Opslaan
                </button>
                <button
                  onClick={() => saveQueryFileAs(activeTab.id)}
                  title="Querybestand opslaan als (Ctrl+Shift+S)"
                >
                  Opslaan als…
                </button>
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
                  title="Recente query's"
                >
                  <option value="">🕘 Recente query's</option>
                  {recentQueries.slice(0, 10).map((entry, i) => (
                    <option key={`${entry.at}-${i}`} value={i}>
                      {shortSql(entry.sql)} —{' '}
                      {connections.find((c) => c.id === entry.connectionId)?.name ?? 'losse query'}
                    </option>
                  ))}
                </select>
                <button onClick={() => openConnectionDialog('create')}>＋ Verbinding</button>
                {activeTab.connectionId && openSessions[activeTab.connectionId] && (
                  <button onClick={() => closeSession(activeTab.connectionId!)}>Verbinding sluiten</button>
                )}
              </div>
              <div className="editor-pane">
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
              </div>
              <div className="results-pane">
                <div className="results-tabs" role="tablist" aria-label="Resultaatpaneel">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'results'}
                    className={`results-tab ${bottomTab === 'results' ? 'active' : ''}`}
                    onClick={() => setBottomTab('results')}
                  >
                    Resultaten
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'messages'}
                    className={`results-tab ${bottomTab === 'messages' ? 'active' : ''}`}
                    onClick={() => setBottomTab('messages')}
                  >
                    Berichten
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={bottomTab === 'history'}
                    className={`results-tab ${bottomTab === 'history' ? 'active' : ''}`}
                    onClick={() => setBottomTab('history')}
                  >
                    Geschiedenis
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
                  ) : (
                    <HistoryPanel />
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      <StatusBar />
      <ConnectionDialog />
    </div>
  )
}

export default App
