import { useAppStore } from '../state/store'

const ENV_COLOR: Record<string, string> = {
  DEV: '#2e7d32',
  TEST: '#f9a825',
  ACC: '#ef6c00',
  PROD: '#c62828'
}

export function EnvBadge({ environment }: { environment: string }): React.JSX.Element {
  return (
    <span className="env-badge" style={{ backgroundColor: ENV_COLOR[environment] ?? '#555' }}>
      {environment}
    </span>
  )
}

/**
 * Statusbalk onderaan (SSMS-stijl): verbindingsstatus, actieve query-status
 * en omgeving. Leest direct uit de store; geen Node-afhankelijkheden.
 */
export function StatusBar(): React.JSX.Element {
  const tabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const connections = useAppStore((s) => s.connections)
  const openSessions = useAppStore((s) => s.openSessions)

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null
  const conn = activeTab?.connectionId
    ? connections.find((c) => c.id === activeTab.connectionId)
    : undefined
  const session = activeTab?.connectionId ? openSessions[activeTab.connectionId] : undefined

  let statusText: string
  let statusClass = ''
  if (!activeTab) {
    statusText = 'Klaar'
  } else if (activeTab.running) {
    statusText = 'Query loopt…'
    statusClass = 'status-running'
  } else if (activeTab.result?.error) {
    statusText = `Fout: ${activeTab.result.error}`
    statusClass = 'status-error'
  } else if (activeTab.result) {
    statusText = `Query voltooid — ${activeTab.result.rowCount} rij(en) in ${activeTab.result.durationMs} ms`
    statusClass = 'status-ok'
  } else {
    statusText = 'Klaar'
  }

  return (
    <footer className="status-bar">
      <span className={`status-dot ${session ? 'connected' : ''}`} title={session ? 'Verbonden' : 'Geen verbinding'} />
      <span className="status-connection">
        {conn ? `Verbonden: ${conn.name}` : 'Geen verbinding'}
        {session && (
          <span className="muted">
            {' '}
            · {session.serverInfo.providerName} {session.serverInfo.serverVersion}
          </span>
        )}
      </span>
      <span className={`status-query ${statusClass}`}>{statusText}</span>
      <span className="status-spacer" />
      {conn && <EnvBadge environment={conn.environment} />}
      <span className="muted status-hint">Ctrl+Enter: query uitvoeren</span>
    </footer>
  )
}
