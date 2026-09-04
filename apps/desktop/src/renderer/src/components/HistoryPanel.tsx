import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '../state/store'

/** Formatteert een ISO-tijdstip naar lokale datum/tijd (dd-mm-jjjj uu:mm). */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const date = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  return `${date} ${time}`
}

/** Kort SQL af voor de lijstweergave. */
function shortSql(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine
}

/**
 * SQL History (eis 19) — doorzoekbare uitvoeringsgeschiedenis.
 *
 * Toont per uitvoering: datum/tijd, server, database, SQL, execution time,
 * succes/fout en rowcount. Vanuit een entry kan de query opnieuw worden
 * uitgevoerd (nieuwe tab met dezelfde verbinding).
 */
export function HistoryPanel(): React.JSX.Element {
  const entries = useAppStore((s) => s.historyEntries)
  const loadHistory = useAppStore((s) => s.loadHistory)
  const clearHistory = useAppStore((s) => s.clearHistory)
  const rerunHistoryEntry = useAppStore((s) => s.rerunHistoryEntry)
  const activeTabResult = useAppStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.result)

  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const queryRef = useRef(query)
  queryRef.current = query

  const refresh = useCallback(
    async (q?: string) => {
      setBusy(true)
      try {
        await loadHistory(q)
      } finally {
        setBusy(false)
      }
    },
    [loadHistory]
  )

  // Bij openen en na elke nieuwe query-uitvoering de lijst verversen.
  useEffect(() => {
    void refresh()
  }, [refresh, activeTabResult?.executionId, activeTabResult?.durationMs])

  const search = (): void => {
    void refresh(queryRef.current.trim() || undefined)
  }

  const handleClear = async (): Promise<void> => {
    if (!window.confirm('Clear entire SQL history?')) return
    await clearHistory()
  }

  return (
    <div className="history-panel">
      <div className="history-toolbar">
        <input
          className="history-search"
          type="search"
          placeholder="Search in SQL, server or database…"
          aria-label="Search history"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') search()
          }}
        />
        <button onClick={search} disabled={busy} title="Search">
          🔍 Search
        </button>
        <button onClick={() => void refresh()} disabled={busy} title="Refresh">
          ↻
        </button>
        <button onClick={() => void handleClear()} title="Clear history">
          🗑 Clear
        </button>
      </div>

      {busy && entries.length === 0 ? (
        <div className="history-empty">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="history-empty">
          {query.trim() ? 'No executions found for this search query.' : 'No SQL executions yet.'}
        </div>
      ) : (
        <div className="history-list">
          {entries.map((entry) => (
            <div key={entry.id} className={`history-entry ${entry.success ? 'ok' : 'err'}`}>
              <div className="history-entry-meta">
                <span className="history-time">{formatTime(entry.executedAt)}</span>
                <span className={`history-status ${entry.success ? 'ok' : 'err'}`}>
                  {entry.success ? '✔' : '✘'}
                </span>
                <span className="history-server">{entry.server}</span>
                {entry.database && <span className="history-db muted">· {entry.database}</span>}
                <span className="history-stats muted">
                  · {entry.durationMs} ms · {entry.rowCount} row(s)
                </span>
                <span className="history-spacer" />
                <button
                  className="history-rerun"
                  title="Run again in a new query tab"
                  onClick={() => void rerunHistoryEntry(entry)}
                >
                  ▶ Rerun
                </button>
              </div>
              <div className="history-sql" title={entry.sql}>
                {shortSql(entry.sql)}
              </div>
              {entry.error && <div className="history-error">⚠️ {entry.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
