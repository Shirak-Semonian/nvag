import { useEffect } from 'react'
import { ObjectExplorer } from './components/ObjectExplorer'
import { QueryEditor } from './components/QueryEditor'
import { ResultsGrid, MessagesPanel } from './components/ResultsGrid'
import { ConnectionDialog } from './components/ConnectionDialog'
import { useAppStore } from './state/store'

const ENV_COLOR: Record<string, string> = {
  DEV: '#2e7d32',
  TEST: '#f9a825',
  ACC: '#ef6c00',
  PROD: '#c62828'
}

function ConnectionBadge({ connectionId }: { connectionId: string | null }): React.JSX.Element | null {
  const connections = useAppStore((s) => s.connections)
  const openSessions = useAppStore((s) => s.openSessions)
  if (!connectionId) return null
  const conn = connections.find((c) => c.id === connectionId)
  if (!conn) return null
  const session = openSessions[connectionId]
  return (
    <span
      className="env-badge"
      style={{ backgroundColor: ENV_COLOR[conn.environment] ?? '#555' }}
      title={`${conn.environment} · ${session?.serverInfo.providerName ?? ''}`}
    >
      {conn.environment}
    </span>
  )
}

function App(): React.JSX.Element {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const connections = useAppStore((s) => s.connections)
  const openSessions = useAppStore((s) => s.openSessions)
  const loadConnections = useAppStore((s) => s.loadConnections)
  const addTab = useAppStore((s) => s.addTab)
  const closeTab = useAppStore((s) => s.closeTab)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setTabConnection = useAppStore((s) => s.setTabConnection)
  const runQuery = useAppStore((s) => s.runQuery)
  const openConnectionDialog = useAppStore((s) => s.openConnectionDialog)
  const closeSession = useAppStore((s) => s.closeSession)

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  return (
    <div className="app-shell">
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
            >
              <span>{tab.title}</span>
              <ConnectionBadge connectionId={tab.connectionId} />
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
          <button className="tab-add" onClick={addTab} title="Nieuwe query-tab">
            +
          </button>
        </div>

        {activeTab && (
          <>
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
              <button
                className="primary"
                onClick={() => runQuery(activeTab.id)}
                disabled={!activeTab.connectionId || !openSessions[activeTab.connectionId] || activeTab.running}
              >
                {activeTab.running ? 'Bezig…' : '▶ Uitvoeren'}
              </button>
              <button onClick={() => openConnectionDialog('create')}>＋ Verbinding</button>
              {activeTab.connectionId && openSessions[activeTab.connectionId] && (
                <button onClick={() => closeSession(activeTab.connectionId!)}>Verbinding sluiten</button>
              )}
            </div>
            <div className="editor-pane">
              <QueryEditor key={activeTab.id} tabId={activeTab.id} sql={activeTab.sql} />
            </div>
            <div className="results-pane">
              <div className="results-tabs">
                <span className="results-tab active">Resultaten</span>
                <span className="results-tab">Messages</span>
              </div>
              <ResultsGrid result={activeTab.result} />
            </div>
            <div className="messages-pane">
              <MessagesPanel result={activeTab.result} />
            </div>
          </>
        )}
      </div>
      <ConnectionDialog />
    </div>
  )
}

export default App
