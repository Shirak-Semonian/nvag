/**
 * Resultaten + Messages (SAL-17, F1-4).
 *
 * - AG Grid v36 (ag-grid-community + ag-grid-react): sorteren, filteren,
 *   kolombreedte, selectie/kopiëren (cel/rij/dataset), NULL-weergave (grijs).
 * - Meerdere resultatensets in tabs (Resultaat 1..N).
 * - Results to Text (TSV-modal + kopiëren) / Results to File (CSV via dialoog).
 * - Messages-paneel: errors, warnings, rowcount, execution time.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { ColDef, GridApi } from 'ag-grid-community'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-quartz.css'
import type {
  QueryColumn,
  QueryMessage,
  QueryResultSet,
  QueryRunResponse
} from '@nvag/contracts'
import { ExportMenu } from './ExportMenu'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Veldnaam per kolompositie; uniek ook bij dubbele kolomnamen. */
function fieldFor(index: number): string {
  return `col_${index}`
}

/** Waarde zoals die in de grid staat (blob → leesbare aanduiding). */
export function toDisplayValue(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Uint8Array) return `[BLOB ${v.length} bytes]`
  return v
}

/** Cel-tekst voor export/kopieren; NULL wordt leeg (Excel-conventie). */
export function exportCellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Uint8Array) return `[BLOB ${v.length} bytes]`
  return String(v)
}

function quoteDelimited(s: string): string {
  if (/[\t\n\r"]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** TSV-weergave van rijen (results-to-text / kopieren). */
export function rowsToTsv(columns: QueryColumn[], rows: Record<string, unknown>[]): string {
  const header = columns.map((c) => quoteDelimited(c.name || '')).join('\t')
  const lines = rows.map((r) =>
    columns.map((_, i) => quoteDelimited(exportCellText(r[fieldFor(i)]))).join('\t')
  )
  return [header, ...lines].join('\n')
}

/** CSV (;-gescheiden, RFC-4180-achtig) van rijen — voor Results to File. */
export function rowsToCsv(columns: QueryColumn[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown): string => {
    const s = exportCellText(v)
    return /[;\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = columns.map((c) => cell(c.name || '')).join(';')
  const lines = rows.map((r) => columns.map((_, i) => cell(r[fieldFor(i)])).join(';'))
  return [header, ...lines].join('\n')
}

/** Rijen uit de grid als platte objecten (via AG Grid API). */
function collectRows(columns: QueryColumn[], rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    columns.forEach((_, i) => {
      out[fieldFor(i)] = r[fieldFor(i)] ?? null
    })
    return out
  })
}

// ---------------------------------------------------------------------------
// NULL-weergave
// ---------------------------------------------------------------------------

function NullCellRenderer({ value }: { value: unknown }): React.JSX.Element {
  if (value === null || value === undefined) {
    return <span className="cell-null">NULL</span>
  }
  return <span>{exportCellText(value)}</span>
}

function buildColumnDefs(columns: QueryColumn[]): ColDef[] {
  return columns.map((c, i) => ({
    field: fieldFor(i),
    headerName: c.name || `column ${i + 1}`,
    sortable: true,
    filter: true,
    resizable: true,
    minWidth: 80,
    cellRenderer: NullCellRenderer
  }))
}

// ---------------------------------------------------------------------------
// Resultatenset-grid (AG Grid)
// ---------------------------------------------------------------------------

function ResultSetGrid({ resultSet }: { resultSet: QueryResultSet }): React.JSX.Element {
  const gridRef = useRef<AgGridReact | null>(null)
  const [selectedCount, setSelectedCount] = useState(0)
  const [textViewOpen, setTextViewOpen] = useState(false)

  const columnDefs = useMemo(() => buildColumnDefs(resultSet.columns), [resultSet.columns])
  const rowData = useMemo(
    () =>
      resultSet.rows.map((r) => {
        const obj: Record<string, unknown> = {}
        resultSet.columns.forEach((_, i) => {
          obj[fieldFor(i)] = toDisplayValue(r.values[i])
        })
        return obj
      }),
    [resultSet.columns, resultSet.rows]
  )

  // DML/DDL zonder kolommen: alleen de bevestiging tonen.
  if (resultSet.columns.length === 0) {
    return (
      <div className="results-empty">
        Query executed. {resultSet.rowCount} row(s) affected.
      </div>
    )
  }

  const gridApi = (): GridApi | null => gridRef.current?.api ?? null

  const copySelected = (): void => {
    const api = gridApi()
    if (!api) return
    const rows = api.getSelectedRows() as Record<string, unknown>[]
    if (rows.length === 0) return
    const tsv = rowsToTsv(resultSet.columns, collectRows(resultSet.columns, rows))
    void navigator.clipboard.writeText(tsv)
  }

  const copyDataset = (): void => {
    const api = gridApi()
    if (!api) return
    const tsv = api.getDataAsCsv({
      columnSeparator: '\t',
      processCellCallback: (p) => exportCellText(p.value)
    })
    if (tsv) void navigator.clipboard.writeText(tsv)
  }

  /**
   * Export-rijen uit de grid (F1-7): geselecteerde rijen indien aanwezig,
   * anders alle gefilterde/gesorteerde rijen. Display-waarden in
   * kolomvolgorde; `null` voor lege cellen.
   */
  const collectGridRows = (): unknown[][] => {
    const api = gridApi()
    if (!api) return []
    const selected = api.getSelectedRows() as Record<string, unknown>[]
    const nodes: Record<string, unknown>[] = selected.length > 0 ? selected : []
    if (nodes.length === 0) {
      api.forEachNodeAfterFilterAndSort((node) => {
        if (node.data) nodes.push(node.data as Record<string, unknown>)
      })
    }
    return nodes.map((r) => resultSet.columns.map((_, i) => r[fieldFor(i)] ?? null))
  }

  /** Rijen uit het volledige queryresultaat (originele waarden). */
  const resultRows = useMemo(
    () => resultSet.rows.map((r): unknown[] => r.values),
    [resultSet.rows]
  )

  const allRows = useMemo(
    () => collectRows(resultSet.columns, rowData),
    [resultSet.columns, rowData]
  )

  return (
    <div className="result-set">
      <div className="result-toolbar">
        <span className="result-meta">
          {resultSet.columns.length} column(s) · {resultSet.rowCount} row(s)
        </span>
        <span className="result-toolbar-spacer" />
        <button
          type="button"
          onClick={copySelected}
          disabled={selectedCount === 0}
          title={selectedCount === 0 ? 'Select rows first' : 'Copy selected rows as TSV'}
        >
          📋 Rows ({selectedCount})
        </button>
        <button type="button" onClick={copyDataset} title="Copy full dataset as TSV">
          📋 Dataset
        </button>
        <button type="button" onClick={() => setTextViewOpen(true)} title="View results as text">
          📄 To text
        </button>
        <ExportMenu columns={resultSet.columns} resultRows={resultRows} getGridRows={collectGridRows} />
      </div>
      <div className="ag-theme-quartz-dark result-ag-grid">
        <AgGridReact
          ref={gridRef}
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
          rowSelection={{ mode: 'multiRow', headerCheckbox: false, enableClickSelection: true }}
          onSelectionChanged={() => {
            const api = gridApi()
            setSelectedCount(api ? api.getSelectedRows().length : 0)
          }}
          enableCellTextSelection
          ensureDomOrder
          rowHeight={26}
          headerHeight={30}
          suppressCellFocus
        />
      </div>
      {resultSet.truncated && (
        <div className="results-truncated">
          ⚠️ Result truncated at {resultSet.rowCount} rows (max-row cap). Refine your query or increase the cap.
        </div>
      )}
      {textViewOpen && (
        <ResultsTextView
          title="Results as text"
          text={rowsToTsv(resultSet.columns, allRows)}
          onClose={() => setTextViewOpen(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ResultsGrid (meerdere resultsets in tabs)
// ---------------------------------------------------------------------------

export function ResultsGrid({
  result,
  running
}: {
  result: QueryRunResponse | null
  running?: boolean
}): React.JSX.Element {
  const [activeSet, setActiveSet] = useState(0)

  useEffect(() => {
    setActiveSet(0)
  }, [result])

  if (!result) {
    return (
      <div className="results-empty">
        {running ? 'Running…' : 'Run a query to see results.'}
      </div>
    )
  }

  const sets: QueryResultSet[] =
    result.results && result.results.length > 0
      ? result.results
      : [
          {
            columns: result.columns,
            rows: result.rows,
            truncated: result.truncated,
            rowCount: result.rowCount
          }
        ]

  if (sets.length === 1 && sets[0]?.columns.length === 0 && !result.error) {
    if (result.cancelled) {
      return (
        <div className="results-empty">
          Query cancelled by user. {sets[0]?.rowCount ?? 0} row(s) processed in {result.durationMs} ms.
        </div>
      )
    }
    return (
      <div className="results-empty">
        Query executed. {sets[0]?.rowCount ?? 0} row(s) affected in {result.durationMs} ms.
      </div>
    )
  }

  if (result.cancelled && sets.length === 1 && sets[0]?.rows.length === 0) {
    return (
      <div className="results-empty">
        Query cancelled by user.
      </div>
    )
  }

  const activeIndex = Math.min(activeSet, sets.length - 1)
  const active = sets[activeIndex] ?? sets[0]

  return (
    <div className="results-grid-wrap">
      {sets.length > 1 && (
        <div className="result-set-tabs" role="tablist" aria-label="Result sets">
          {sets.map((s, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === activeIndex}
              className={`result-set-tab ${i === activeIndex ? 'active' : ''}`}
              onClick={() => setActiveSet(i)}
            >
              Result {i + 1} ({s.columns.length === 0 ? s.rowCount : s.rowCount} rows)
            </button>
          ))}
        </div>
      )}
      <ResultSetGrid key={activeIndex} resultSet={active} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Results to Text (modal)
// ---------------------------------------------------------------------------

export function ResultsTextView({
  title,
  text,
  onClose
}: {
  title: string
  text: string
  onClose: () => void
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
          <div>
            <button type="button" onClick={() => void copy()}>
              {copied ? '✓ Copied' : 'Copy'}
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </div>
        <pre className="results-text-view">{text}</pre>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Messages-paneel
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function MessageLine({ msg }: { msg: QueryMessage }): React.JSX.Element {
  const label =
    msg.severity === 'error' ? 'Error' : msg.severity === 'warning' ? 'Warning' : 'Info'
  return (
    <div className={`msg-${msg.severity}`}>
      <span className="msg-label">{label}:</span> {msg.text}
      {msg.position && (
        <span className="msg-position">
          {' '}
          (line {msg.position.line}, column {msg.position.column})
        </span>
      )}
    </div>
  )
}

export function MessagesPanel({
  result,
  running,
  elapsedMs
}: {
  result: QueryRunResponse | null
  running?: boolean
  elapsedMs?: number
}): React.JSX.Element {
  if (running && !result) {
    return (
      <div className="messages-panel">
        <div className="msg-info">Running… {formatMs(elapsedMs ?? 0)}</div>
      </div>
    )
  }
  if (!result) {
    return <div className="messages-empty">Done.</div>
  }

  const messages = result.messages ?? []
  const hasErrorMessage = messages.some((m) => m.severity === 'error')

  return (
    <div className="messages-panel">
      {running && <div className="msg-info">Running… {formatMs(elapsedMs ?? 0)}</div>}
      {result.error && !hasErrorMessage && (
        <div className="msg-error">
          <span className="msg-label">Error:</span> {result.error}
        </div>
      )}
      {messages.map((m, i) => (
        <MessageLine key={i} msg={m} />
      ))}
      {!running && (
        <>
          {result.cancelled ? (
            <div className="msg-warning">
              <span className="msg-label">Cancelled:</span> Query cancelled by user.
            </div>
          ) : (
            !result.error && (
              <div className="msg-ok">
                Query completed — {result.rowCount} row(s) in {formatMs(result.durationMs)}
                {result.columns.length > 0 ? `, ${result.columns.length} column(s)` : ''}.
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}
