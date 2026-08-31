/**
 * F2-productiviteitspanelen: Zoeken (F2-5), Snippets (F2-6),
 * Import (F2-7), Audit (F2-8) en Dashboard (F2-10).
 */

import { useEffect, useState } from 'react'
import type { ExplainPlanNode, ExplainResult, MonitoringRow, QueryPerformanceStats, SearchMatch } from '@nvag/contracts'
import { useAppStore } from '../state/store'

// ---------------------------------------------------------------------------
// F2-5: Database Search
// ---------------------------------------------------------------------------

export function SearchPanel({ connectionId }: { connectionId: string | null }): React.JSX.Element {
  const results = useAppStore((s) => s.searchResults)
  const searching = useAppStore((s) => s.searching)
  const runSearch = useAppStore((s) => s.runDatabaseSearch)
  const openMatch = useAppStore((s) => s.openSearchMatch)
  const [query, setQuery] = useState('')

  const typeLabel = (m: SearchMatch): string => {
    switch (m.objectType) {
      case 'table': return '📋 tabel'
      case 'view': return '👁️ view'
      case 'procedure': return '⚙️ procedure'
      case 'function': return 'ƒ functie'
      case 'column': return '▤ kolom'
      case 'definition': return '📄 definitie'
      default: return m.objectType
    }
  }

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <input
          className="f2-search-input"
          placeholder="Zoek objecten, kolommen en definities… (bijv. user of order)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && connectionId && query.trim()) {
              void runSearch(connectionId, query)
            }
          }}
        />
        <button
          className="primary"
          disabled={!connectionId || !query.trim() || searching}
          onClick={() => connectionId && void runSearch(connectionId, query)}
        >
          {searching ? 'Zoeken…' : 'Zoeken'}
        </button>
      </div>
      <div className="f2-panel-list">
        {results.length === 0 && <div className="results-empty">Geen resultaten. Voer een zoekopdracht in.</div>}
        {results.map((m, i) => (
          <div
            key={i}
            className="search-result"
            onClick={() => (m.objectType === 'table' || m.objectType === 'view') && openMatch(connectionId ?? '', m)}
            title={m.field === 'definition' ? m.snippet : undefined}
          >
            <span className="search-type">{typeLabel(m)}</span>
            <span className="search-name">
              {m.schema ? `${m.schema}.` : ''}
              {m.object}
              {m.field === 'column' && m.snippet ? ` — ${m.snippet}` : ''}
            </span>
            {m.field === 'definition' && m.snippet && <span className="search-snippet">{m.snippet}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// F2-6: Snippets/Favorites
// ---------------------------------------------------------------------------

export function SnippetsPanel({ activeTabId }: { activeTabId: string | null }): React.JSX.Element {
  const snippets = useAppStore((s) => s.snippets)
  const folders = useAppStore((s) => s.snippetFolders)
  const filterFolder = useAppStore((s) => s.snippetFilterFolder)
  const loadSnippets = useAppStore((s) => s.loadSnippets)
  const saveSnippet = useAppStore((s) => s.saveSnippet)
  const removeSnippet = useAppStore((s) => s.removeSnippet)
  const insertSnippet = useAppStore((s) => s.insertSnippetIntoEditor)
  const activeSql = useAppStore((s) => s.tabs.find((t) => t.id === activeTabId)?.sql ?? '')
  const [folder, setFolder] = useState('Algemeen')
  const [title, setTitle] = useState('')
  const [sql, setSql] = useState('')

  useEffect(() => {
    void loadSnippets()
  }, [loadSnippets])

  useEffect(() => {
    void loadSnippets(filterFolder)
  }, [filterFolder, loadSnippets])

  const save = async (): Promise<void> => {
    await saveSnippet({ folder, title, sql: sql || activeSql })
    setTitle('')
    setSql('')
  }

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <select value={filterFolder} onChange={(e) => void loadSnippets(e.target.value)}>
          {folders.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <span className="f2-panel-spacer" />
        <span className="result-meta">{snippets.length} snippet(s)</span>
      </div>
      <div className="f2-panel-list">
        {snippets.length === 0 && <div className="results-empty">Geen snippets in deze folder.</div>}
        {snippets.map((s) => (
          <div key={s.id} className="search-result snippet-row">
            <div
              className="snippet-main"
              title="Klik om in de editor in te voegen"
              onClick={() => activeTabId && insertSnippet(activeTabId, s.sql)}
            >
              <span className="search-name">{s.title}</span>
              <code className="snippet-sql">{s.sql.slice(0, 80)}{s.sql.length > 80 ? '…' : ''}</code>
            </div>
            <button
              className="icon-btn"
              title="Verwijderen"
              onClick={() => void removeSnippet(s.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="snippet-form">
        <div className="f2-panel-row">
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <input placeholder="Titel" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <textarea
          placeholder="SQL (leeg = SQL van de actieve tab)"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          rows={3}
        />
        <button className="primary" onClick={() => void save()} disabled={!title}>
          Snippet opslaan
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// F2-7: Import
// ---------------------------------------------------------------------------

export function ImportPanel({ connectionId }: { connectionId: string | null }): React.JSX.Element {
  const preview = useAppStore((s) => s.importPreview)
  const generatedSql = useAppStore((s) => s.importGeneratedSql)
  const busy = useAppStore((s) => s.importBusy)
  const pickFile = useAppStore((s) => s.pickImportFile)
  const generate = useAppStore((s) => s.generateImportSql)
  const execute = useAppStore((s) => s.executeImportSql)
  const [table, setTable] = useState('')
  const [mapping, setMapping] = useState<Record<number, string>>({})
  const [rowLimit, setRowLimit] = useState(0)

  const columns = preview?.columns ?? []
  const mappingFor = (i: number): string => mapping[i] ?? ''

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <button className="primary" onClick={() => void pickFile()} disabled={busy}>
          📂 Bestand kiezen (CSV/Excel/JSON/XML)
        </button>
        {preview && (
          <span className="result-meta">
            {preview.fileName} — {preview.format.toUpperCase()} — {preview.totalRows} rijen
          </span>
        )}
      </div>

      {preview && (
        <>
          <div className="import-mapping">
            <div className="f2-panel-row">
              <label>
                Doeltabel{' '}
                <input
                  placeholder="tabelnaam"
                  value={table}
                  onChange={(e) => setTable(e.target.value)}
                />
              </label>
              <label>
                Rijen (0 = alle){' '}
                <input
                  type="number"
                  min={0}
                  value={rowLimit}
                  onChange={(e) => setRowLimit(Number(e.target.value))}
                />
              </label>
            </div>
            <table className="import-map-table">
              <thead>
                <tr>
                  <th>Bronkolom</th>
                  <th>→ Doelkolom</th>
                </tr>
              </thead>
              <tbody>
                {columns.map((c, i) => (
                  <tr key={i}>
                    <td>{c.name}</td>
                    <td>
                      <input
                        value={mappingFor(i)}
                        placeholder="doelkolom"
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [i]: e.target.value }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="f2-panel-row">
              <button
                disabled={!table || !connectionId || busy}
                onClick={() =>
                  connectionId &&
                  void generate(connectionId, table, undefined, mapping, rowLimit)
                }
              >
                INSERT-SQL genereren
              </button>
              {generatedSql && (
                <button
                  className="primary"
                  disabled={!connectionId}
                  onClick={() => connectionId && void execute(connectionId)}
                >
                  Uitvoeren ({generatedSql.split('INSERT').length - 1} inserts)
                </button>
              )}
            </div>
          </div>

          <div className="import-preview-scroll">
            <table className="import-preview-table">
              <thead>
                <tr>
                  {columns.map((c, i) => (
                    <th key={i}>{c.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 8).map((r, ri) => (
                  <tr key={ri}>
                    {r.map((v, ci) => (
                      <td key={ci}>{v === null ? 'NULL' : String(v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {generatedSql && (
        <details className="table-data-sql" open>
          <summary>Gegenereerde INSERT-SQL ({generatedSql.split('INSERT').length - 1} inserts)</summary>
          <pre>{generatedSql.slice(0, 2000)}{generatedSql.length > 2000 ? '\n…' : ''}</pre>
        </details>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// F2-8: Audit
// ---------------------------------------------------------------------------

export function AuditPanel(): React.JSX.Element {
  const entries = useAppStore((s) => s.auditEntries)
  const loadAudit = useAppStore((s) => s.loadAudit)
  const clearAudit = useAppStore((s) => s.clearAudit)

  useEffect(() => {
    void loadAudit()
  }, [loadAudit])

  const actionLabel = (a: string): string =>
    a
      .replace('connection.created', 'Verbinding aangemaakt')
      .replace('connection.removed', 'Verbinding verwijderd')
      .replace('session.opened', 'Sessie geopend')
      .replace('query.executed', 'Query uitgevoerd')
      .replace('query.exported', 'Export')
      .replace('table.edit', 'Tabelbewerking')
      .replace('import.executed', 'Import')
      .replace('admin.ddl', 'Admin-DDL')
      .replace('transaction.commit', 'COMMIT')
      .replace('transaction.rollback', 'ROLLBACK')

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <span className="result-meta">{entries.length} auditregel(s)</span>
        <span className="f2-panel-spacer" />
        <button onClick={() => void loadAudit()}>⟳ Vernieuwen</button>
        <button className="danger" onClick={() => void clearAudit()}>
          Wissen
        </button>
      </div>
      <div className="audit-list">
        {entries.length === 0 && <div className="results-empty">Geen auditregels.</div>}
        {entries.map((e) => (
          <div key={e.id} className={`audit-row ${e.success ? '' : 'audit-error'}`}>
            <span className="audit-at">{new Date(e.at).toLocaleTimeString('nl-NL')}</span>
            <span className="audit-action">{actionLabel(e.action)}</span>
            {e.server && <span className="audit-server">{e.server}</span>}
            <span className="audit-detail">{e.detail}</span>
            {e.error && <span className="audit-detail audit-error"> — {e.error}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// F3-2: Monitoring/Activity
// ---------------------------------------------------------------------------

export function MonitoringPanel({ connectionId }: { connectionId: string | null }): React.JSX.Element {
  const [rows, setRows] = useState<MonitoringRow[]>([])
  const [locks, setLocks] = useState<unknown[]>([])
  const [busy, setBusy] = useState(false)
  const [includeIdle, setIncludeIdle] = useState(false)

  const load = async (): Promise<void> => {
    if (!connectionId) return
    setBusy(true)
    try {
      const [q, l] = await Promise.all([
        window.nvag.monitoring.activeQueries(connectionId, includeIdle),
        window.nvag.monitoring.locks(connectionId)
      ])
      setRows(q)
      setLocks(l)
    } catch {
      setRows([])
      setLocks([])
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, includeIdle])

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <span className="result-meta">Monitoring (F3-2) — {rows.length} actieve sessie(s)</span>
        <span className="f2-panel-spacer" />
        <label className="checkbox-row" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={includeIdle} onChange={(e) => setIncludeIdle(e.target.checked)} />
          Idle tonen
        </label>
        <button onClick={() => void load()} disabled={busy || !connectionId}>
          ⟳ Vernieuwen
        </button>
      </div>
      <div className="audit-list">
        {rows.length === 0 && <div className="results-empty">Geen actieve sessies.</div>}
        {rows.map((r) => (
          <div key={r.id} className="audit-row">
            <span className="audit-action">sessie {r.id}</span>
            {r.user && <span className="audit-server">{r.user}</span>}
            {r.database && <span className="audit-server">{r.database}</span>}
            <span className="audit-detail">
              {r.status ?? ''}
              {r.durationMs !== undefined ? ` · ${formatMs(r.durationMs)}` : ''}
              {r.cpuMs !== undefined ? ` · cpu ${formatMs(r.cpuMs)}` : ''}
              {r.blockedBy ? ` · ⛔ geblokkeerd door ${r.blockedBy}` : ''}
            </span>
            {r.query && <code className="snippet-sql">{r.query}</code>}
          </div>
        ))}
      </div>
      {locks.length > 0 && (
        <details className="table-data-sql">
          <summary>{locks.length} lock(s)</summary>
          <pre>{JSON.stringify(locks.slice(0, 20), null, 2)}</pre>
        </details>
      )}
    </div>
  )
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.floor(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

// ---------------------------------------------------------------------------
// F2-4: Query Performance
// ---------------------------------------------------------------------------

export function PerformancePanel({ connectionId, sql }: { connectionId: string | null; sql: string }): React.JSX.Element {
  const [stats, setStats] = useState<QueryPerformanceStats & { explain?: ExplainResult } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (withSql: boolean): Promise<void> => {
    if (!connectionId) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.nvag.performance.getStats(connectionId, withSql && sql.trim() ? sql : undefined)
      setStats(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (connectionId) void run(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <span className="result-meta">Query Performance (F2-4)</span>
        <span className="f2-panel-spacer" />
        <button onClick={() => void run(false)} disabled={busy || !connectionId}>
          Laatste query
        </button>
        <button
          className="primary"
          onClick={() => void run(true)}
          disabled={busy || !connectionId || !sql.trim()}
          title={sql.trim() ? 'EXPLAIN-analyse van de huidige SQL draaien' : 'Geen SQL in de editor'}
        >
          {busy ? 'Bezig…' : 'EXPLAIN (huidige SQL)'}
        </button>
      </div>
      {error && <div className="msg-error">Fout: {error}</div>}
      {stats && (
        <>
          <table className="dashboard-db-table">
            <tbody>
              <tr>
                <td>Verstreken tijd</td>
                <td>{stats.elapsedMs} ms</td>
              </tr>
              <tr>
                <td>Rijen geretourneerd</td>
                <td>{stats.rowsReturned}</td>
              </tr>
              {stats.rowsRead !== undefined && (
                <tr>
                  <td>Rijen gelezen</td>
                  <td>{stats.rowsRead}</td>
                </tr>
              )}
              {stats.cpuMs !== undefined && (
                <tr>
                  <td>CPU-tijd</td>
                  <td>{stats.cpuMs} ms</td>
                </tr>
              )}
            </tbody>
          </table>
          {stats.explain && (
            <details className="table-data-sql" open>
              <summary>
                Execution Plan ({stats.explain.dialect}
                {stats.explain.plan ? ` — ${stats.explain.plan.length} operator(s)` : ''})
              </summary>
              {stats.explain.plan && stats.explain.plan.length > 0 ? (
                <PlanTree nodes={stats.explain.plan} depth={0} />
              ) : (
                <pre>{stats.explain.raw}</pre>
              )}
            </details>
          )}
        </>
      )}
    </div>
  )
}

/** Eenvoudige boomweergave van een execution plan (F3-1 basis). */
export function PlanTree({ nodes, depth }: { nodes: ExplainPlanNode[]; depth: number }): React.JSX.Element {
  return (
    <div className="plan-tree">
      {nodes.map((n, i) => (
        <div key={i} className="plan-node" style={{ marginLeft: depth * 16 }}>
          <span className="plan-operator">
            {n.operator}
            {n.detail ? ` (${n.detail})` : ''}
          </span>
          <span className="plan-meta">
            {n.rows !== undefined ? ` ~${n.rows} rijen` : ''}
            {n.cost !== undefined ? ` · kost ${n.cost}` : ''}
          </span>
          {n.children.length > 0 && <PlanTree nodes={n.children} depth={depth + 1} />}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// F2-10: Dashboard
// ---------------------------------------------------------------------------

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function DashboardPanel({ connectionId }: { connectionId: string | null }): React.JSX.Element {
  const dashboard = useAppStore((s) => s.dashboard)
  const loadDashboard = useAppStore((s) => s.loadDashboard)

  useEffect(() => {
    if (connectionId) void loadDashboard(connectionId)
  }, [connectionId, loadDashboard])

  if (!connectionId) return <div className="results-empty">Open eerst een verbinding.</div>
  if (!dashboard) return <div className="results-empty">Dashboard laden…</div>

  const info = dashboard.serverInfo
  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <span className="result-meta">Dashboard</span>
        <span className="f2-panel-spacer" />
        <button onClick={() => connectionId && void loadDashboard(connectionId)}>⟳ Vernieuwen</button>
      </div>
      <div className="dashboard-grid">
        <div className="dashboard-card">
          <h4>Server</h4>
          <dl>
            <dt>Provider</dt>
            <dd>{info.providerName}</dd>
            <dt>Versie</dt>
            <dd>{info.serverVersion}</dd>
            <dt>Database</dt>
            <dd>{info.currentDatabase ?? '—'}</dd>
            <dt>Gebruiker</dt>
            <dd>{info.currentUser ?? '—'}</dd>
          </dl>
        </div>
        <div className="dashboard-card">
          <h4>Databases ({dashboard.databases.length})</h4>
          <table className="dashboard-db-table">
            <thead>
              <tr>
                <th>Naam</th>
                <th>Grootte</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.databases.map((d) => (
                <tr key={d.name}>
                  <td>{d.name}</td>
                  <td>{formatBytes(d.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="dashboard-card dashboard-card-wide">
          <h4>Actieve queries ({dashboard.activeQueries.length})</h4>
          {dashboard.activeQueries.length === 0 ? (
            <div className="results-empty">
              Geen actieve queries{info.providerName ? ` (${info.providerName} rapporteert ze niet of er draait niets)` : ''}.
            </div>
          ) : (
            <pre className="dashboard-queries">{JSON.stringify(dashboard.activeQueries, null, 2)}</pre>
          )}
        </div>
      </div>
    </div>
  )
}
