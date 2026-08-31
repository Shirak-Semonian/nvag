import { useEffect, useState } from 'react'
import { ObjectExplorer } from './components/ObjectExplorer'
import { QueryEditor } from './components/QueryEditor'
import { ResultsGrid, MessagesPanel } from './components/ResultsGrid'
import { ConnectionDialog } from './components/ConnectionDialog'
import { EnvBadge, StatusBar } from './components/StatusBar'
import { useAppStore } from './state/store'

type BottomTab = 'results' | 'messages'

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

  const [bottomTab, setBottomTab] = useState<BottomTab>('results')

  useEffect(() => {
    loadConnections()
  }, [loadConnections])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

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
              >
                <span>{tab.title}</span>
                {tab.connectionId && (
                  <EnvBadge
                    environment={connections.find((c) => c.id === tab.connectionId)?.environment ?? 'DEV'}
                  />
                )}
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
                  title="Uitvoeren (Ctrl+Enter)"
                >
                  {activeTab.running ? 'Bezig…' : '▶ Uitvoeren'}
                </button>
                <button onClick={() => openConnectionDialog('create')}>＋ Verbinding</button>
                {activeTab.connectionId && openSessions[activeTab.connectionId] && (
                  <button onClick={() => closeSession(activeTab.connectionId!)}>Verbinding sluiten</button>
                )}
              </div>
              <div className="editor-pane">
                <QueryEditor key={activeTab.id} tabId={activeTab.id} sql={activeTab.sql} onRun={() => runQuery(activeTab.id)} />
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
                </div>
                <div className="results-content">
                  {bottomTab === 'results' ? (
                    <ResultsGrid result={activeTab.result} />
                  ) : (
                    <MessagesPanel result={activeTab.result} />
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
