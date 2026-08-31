/**
 * F3-panelen: Vergelijk (schema+data, eis 15/16), ER-diagram (eis 18),
 * Dependencies (eis 14), AI Assistant (eis 27) en Plugins (eis 29).
 */

import { useEffect, useMemo, useState } from 'react'
import type { SchemaDiff, TableMetadata } from '@nvag/contracts'
import { useAppStore } from '../state/store'

// ---------------------------------------------------------------------------
// F3-3: Schema Compare + Data Compare
// ---------------------------------------------------------------------------

export function ComparePanel({ activeConnectionId }: { activeConnectionId: string | null }): React.JSX.Element {
  const connections = useAppStore((s) => s.connections)
  const [source, setSource] = useState<string>(activeConnectionId ?? '')
  const [target, setTarget] = useState<string>('')
  const [diff, setDiff] = useState<SchemaDiff | null>(null)
  const [script, setScript] = useState<string | null>(null)
  const [dataResults, setDataResults] = useState<{ table: string; source: number; target: number; differs: boolean }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (activeConnectionId) setSource(activeConnectionId)
  }, [activeConnectionId])

  const runCompare = async (): Promise<void> => {
    if (!source || !target) return
    setBusy(true)
    setError(null)
    try {
      const d = await window.nvag.compare.schemas(source, undefined, target, undefined)
      setDiff(d)
      setScript(null)
      // Data-vergelijking voor gemeenschappelijke tabellen.
      const commonTables = [...new Set(
        d.columnDiffs.map((c) => c.table)
      )]
      const results: { table: string; source: number; target: number; differs: boolean }[] = []
      for (const table of commonTables.slice(0, 10)) {
        try {
          const r = await window.nvag.compare.data(source, undefined, target, undefined, table)
          results.push({ table: r.table, source: r.sourceRowCount, target: r.targetRowCount, differs: r.differs })
        } catch {
          // tabel niet vergelijkbaar
        }
      }
      setDataResults(results)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const makeScript = async (): Promise<void> => {
    if (!source || !target || !diff) return
    setBusy(true)
    try {
      const s = await window.nvag.compare.deployScript(source, undefined, target, undefined, diff)
      setScript(s)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const connOptions = connections.map((c) => (
    <option key={c.id} value={c.id}>
      {c.name}
    </option>
  ))

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <label>
          Bron{' '}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">— kies —</option>
            {connOptions}
          </select>
        </label>
        <label>
          Doel{' '}
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">— kies —</option>
            {connOptions}
          </select>
        </label>
        <button className="primary" onClick={() => void runCompare()} disabled={!source || !target || busy}>
          {busy ? 'Bezig…' : 'Vergelijk'}
        </button>
      </div>
      {error && <div className="msg-error">{error}</div>}
      {diff && (
        <>
          <div className="compare-summary">
            <span className="result-meta">
              {diff.missingTables} ontbrekende tabel(len) · {diff.missingColumns} ontbrekende kolom(men) in doel
            </span>
            <button onClick={() => void makeScript()} disabled={busy}>
              Deployment-script genereren
            </button>
          </div>
          {diff.tablesOnlyInSource.length > 0 && (
            <details className="table-data-sql" open>
              <summary>Alleen in bron ({diff.tablesOnlyInSource.length})</summary>
              <pre>{diff.tablesOnlyInSource.join('\n')}</pre>
            </details>
          )}
          {diff.columnDiffs.length > 0 && (
            <details className="table-data-sql" open>
              <summary>Kolomverschillen ({diff.columnDiffs.length})</summary>
              <div className="audit-list">
                {diff.columnDiffs.map((d) => (
                  <div key={d.table} className="audit-row">
                    <span className="audit-action">{d.table}</span>
                    <span className="audit-detail">
                      {d.missingInTarget.length > 0 && (
                        <>→ doel mist: {d.missingInTarget.join(', ')} </>
                      )}
                      {d.missingInSource.length > 0 && (
                        <>→ bron mist: {d.missingInSource.join(', ')}</>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {dataResults.length > 0 && (
            <details className="table-data-sql" open>
              <summary>Data-vergelijking (rijtellingen)</summary>
              <div className="audit-list">
                {dataResults.map((r) => (
                  <div key={r.table} className="audit-row">
                    <span className="audit-action">{r.table}</span>
                    <span className="audit-detail">
                      bron: {r.source} · doel: {r.target} {r.differs ? '⚠ verschilt' : '✓ gelijk'}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          )}
          {script !== null && (
            <details className="table-data-sql" open>
              <summary>Deployment-script</summary>
              <pre>{script}</pre>
            </details>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// F3-4: Dependencies (depends-on / used-by)
// ---------------------------------------------------------------------------

export function DependenciesPanel({ connectionId }: { connectionId: string | null }): React.JSX.Element {
  const [table, setTable] = useState('')
  const [meta, setMeta] = useState<TableMetadata | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    if (!connectionId || !table.trim()) return
    setBusy(true)
    try {
      const m = await window.nvag.metadata.getTableMetadata(connectionId, '', 'main', table)
      setMeta(m)
    } catch (err) {
      setMeta(null)
      void err
    } finally {
      setBusy(false)
    }
  }

  const dependsOn = meta?.dependencies.filter((d) => d.direction === 'depends-on') ?? []
  const usedBy = meta?.dependencies.filter((d) => d.direction === 'used-by') ?? []

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <input
          placeholder="Tabelnaam (bijv. users)"
          value={table}
          onChange={(e) => setTable(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load()}
        />
        <button className="primary" onClick={() => void load()} disabled={busy || !connectionId || !table.trim()}>
          Afhankelijkheden laden
        </button>
      </div>
      {meta && (
        <div className="dashboard-grid">
          <div className="dashboard-card">
            <h4>Depends-on ({dependsOn.length})</h4>
            <div className="audit-list">
              {dependsOn.map((d, i) => (
                <div key={i} className="audit-row">
                  <span className="audit-action">{d.objectType}</span>
                  <span className="audit-detail">
                    {d.objectSchema ? `${d.objectSchema}.` : ''}
                    {d.objectName}
                  </span>
                </div>
              ))}
              {dependsOn.length === 0 && <div className="results-empty">Geen.</div>}
            </div>
          </div>
          <div className="dashboard-card">
            <h4>Used-by ({usedBy.length})</h4>
            <div className="audit-list">
              {usedBy.map((d, i) => (
                <div key={i} className="audit-row">
                  <span className="audit-action">{d.objectType}</span>
                  <span className="audit-detail">
                    {d.objectSchema ? `${d.objectSchema}.` : ''}
                    {d.objectName}
                  </span>
                </div>
              ))}
              {usedBy.length === 0 && <div className="results-empty">Geen.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// F3-5: ER-diagram (SVG-canvas)
// ---------------------------------------------------------------------------

interface ErdTable {
  name: string
  columns: { name: string; pk: boolean; type: string }[]
}

export function ErdPanel({ connectionId }: { connectionId: string | null }): React.JSX.Element {
  const [tables, setTables] = useState<ErdTable[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    if (!connectionId) return
    setBusy(true)
    setError(null)
    try {
      const list = await window.nvag.metadata.listTables(connectionId, '', 'main')
      const result: ErdTable[] = []
      for (const t of list.slice(0, 12)) {
        try {
          const m = await window.nvag.metadata.getTableMetadata(connectionId, '', 'main', t.name)
          result.push({
            name: t.name,
            columns: m.columns.map((c) => ({ name: c.name, pk: c.isPrimaryKey, type: c.dataType }))
          })
        } catch {
          // overslaan
        }
      }
      setTables(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

  const boxW = 180
  const rowH = 18
  const headerH = 26
  const gapX = 40
  const gapY = 30

  const layout = useMemo(() => {
    const cols = Math.ceil(Math.sqrt(tables.length)) || 1
    const positions: { x: number; y: number; h: number }[] = []
    tables.forEach((t, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const h = headerH + t.columns.length * rowH + 6
      positions.push({ x: col * (boxW + gapX), y: row * (gapY + maxHeight(tables, cols, row)), h })
    })
    return positions
  }, [tables])

  function maxHeight(list: ErdTable[], cols: number, row: number): number {
    let m = 0
    for (let i = row * cols; i < Math.min((row + 1) * cols, list.length); i++) {
      const h = headerH + (list[i]?.columns.length ?? 0) * rowH + 6
      m = Math.max(m, h)
    }
    return m
  }

  const totalW = Math.max(1, Math.ceil(tables.length / (Math.ceil(Math.sqrt(tables.length)) || 1))) * (boxW + gapX)
  const totalH = Math.ceil(tables.length / (Math.ceil(Math.sqrt(tables.length)) || 1)) * (gapY + 200)

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <span className="result-meta">ER-diagram — {tables.length} tabel(len)</span>
        <span className="f2-panel-spacer" />
        <button onClick={() => void load()} disabled={busy || !connectionId}>
          ⟳ Laden
        </button>
      </div>
      {error && <div className="msg-error">{error}</div>}
      <div className="erd-scroll">
        <svg width={totalW} height={totalH} className="erd-svg">
          {tables.map((t, i) => {
            const pos = layout[i] ?? { x: 0, y: 0, h: 100 }
            return (
              <g key={t.name} transform={`translate(${pos.x}, ${pos.y})`}>
                <rect width={boxW} height={pos.h} rx={6} className="erd-box" />
                <rect width={boxW} height={headerH} rx={6} className="erd-header" />
                <text x={8} y={headerH - 8} className="erd-title">
                  {t.name}
                </text>
                {t.columns.map((c, ci) => (
                  <text key={c.name} x={8} y={headerH + 14 + ci * rowH} className="erd-col">
                    {c.pk ? '🔑 ' : ''}
                    {c.name} · {c.type}
                  </text>
                ))}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// F3-6: AI Assistant
// ---------------------------------------------------------------------------

export function AiPanel({ connectionId, activeTabId, activeSql }: { connectionId: string | null; activeTabId: string | null; activeSql: string }): React.JSX.Element {
  const insertSnippet = useAppStore((s) => s.insertSnippetIntoEditor)
  const [mode, setMode] = useState<'generate' | 'explain' | 'optimize' | 'convert' | 'free'>('generate')
  const [input, setInput] = useState('')
  const [targetDialect, setTargetDialect] = useState('postgres')
  const [output, setOutput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showConfig, setShowConfig] = useState(false)
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [model, setModel] = useState('gpt-4o-mini')
  const [apiKey, setApiKey] = useState('')

  const run = async (): Promise<void> => {
    const text = input.trim() || (mode !== 'generate' ? activeSql.trim() : '')
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.nvag.ai.chat({
        connectionId: connectionId ?? undefined,
        mode,
        input: text,
        ...(mode === 'convert' ? { targetDialect } : {})
      })
      setOutput(result.text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const saveConfig = async (): Promise<void> => {
    await window.nvag.ai.saveConfig({ baseUrl, model, apiKey: apiKey || undefined })
    setApiKey('')
    setShowConfig(false)
  }

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <span className="result-meta">AI Assistant (eis 27) — eigen API-key, nooit directe writes</span>
        <span className="f2-panel-spacer" />
        <button onClick={() => setShowConfig((v) => !v)}>⚙ Instellingen</button>
      </div>
      {showConfig && (
        <div className="snippet-form">
          <label>
            Base URL <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          </label>
          <label>
            Model <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" />
          </label>
          <label>
            API-key <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="wordt versleuteld opgeslagen" />
          </label>
          <button className="primary" onClick={() => void saveConfig()}>Opslaan</button>
        </div>
      )}
      <div className="f2-panel-row">
        {(['generate', 'explain', 'optimize', 'convert', 'free'] as const).map((m) => (
          <button
            key={m}
            className={mode === m ? 'admin-tab active' : 'admin-tab'}
            onClick={() => setMode(m)}
          >
            {m === 'generate' ? 'Genereer' : m === 'explain' ? 'Verklaar' : m === 'optimize' ? 'Optimaliseer' : m === 'convert' ? 'Converteer' : 'Vrij'}
          </button>
        ))}
        {mode === 'convert' && (
          <select value={targetDialect} onChange={(e) => setTargetDialect(e.target.value)}>
            {['postgres', 'tsql', 'mysql', 'sqlite', 'db2', 'oracle', 'snowflake', 'databricks'].map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
        )}
      </div>
      <textarea
        className="ai-input"
        placeholder={
          mode === 'generate'
            ? 'Beschrijf wat je wilt (bijv. "alle klanten met meer dan 3 bestellingen")…'
            : mode === 'convert'
              ? 'SQL die geconverteerd moet worden (leeg = SQL van actieve tab)…'
              : 'SQL (leeg = SQL van actieve tab)…'
        }
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={3}
      />
      <div className="f2-panel-row">
        <button className="primary" onClick={() => void run()} disabled={busy}>
          {busy ? 'Bezig…' : '▶ Uitvoeren'}
        </button>
        {output && (
          <button onClick={() => activeTabId && insertSnippet(activeTabId, output)}>
            Invoegen in editor
          </button>
        )}
      </div>
      {error && <div className="msg-error">{error}</div>}
      {output && (
        <pre className="ai-output">{output}</pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// F3-7: Plugins
// ---------------------------------------------------------------------------

export function PluginsPanel(): React.JSX.Element {
  const [plugins, setPlugins] = useState<{ name: string; providerName?: string; ok: boolean; error?: string }[]>([])
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    setBusy(true)
    try {
      const list = await window.nvag.plugins.list()
      setPlugins(list)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="f2-panel">
      <div className="f2-panel-row">
        <span className="result-meta">Plugins ({plugins.length}) — map: plugins/ onder de gebruikersmap</span>
        <span className="f2-panel-spacer" />
        <button onClick={() => void load()} disabled={busy}>⟳ Herladen</button>
      </div>
      <div className="audit-list">
        {plugins.length === 0 && <div className="results-empty">Geen plugins gevonden. Zie docs/06-plugins.md voor de template.</div>}
        {plugins.map((p, i) => (
          <div key={i} className={`audit-row ${p.ok ? '' : 'audit-error'}`}>
            <span className="audit-action">{p.name}</span>
            {p.providerName && <span className="audit-server">{p.providerName}</span>}
            <span className="audit-detail">{p.ok ? '✓ geladen' : `✗ ${p.error ?? ''}`}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
