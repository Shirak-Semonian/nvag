/**
 * Export-menu (F1-7, SAL-20): CSV (papaparse) of XLSX (exceljs), vanuit de
 * grid (geselecteerde rijen, anders de gefilterde/gesorteerde weergave) of
 * vanuit het volledige queryresultaat (originele waarden), naar bestand of
 * klembord.
 *
 * De generatie gebeurt in main process (`query.exportResults`); dit component
 * verzamelt alleen de rijwaarden en toont statusfeedback.
 */

import { useEffect, useRef, useState } from 'react'
import type { ExportColumn, ExportFormat, ExportTarget, QueryColumn } from '@nvag/contracts'

interface ExportMenuProps {
  columns: QueryColumn[]
  /** Rijen uit het volledige queryresultaat (originele waarden, kolomvolgorde). */
  resultRows: unknown[][]
  /**
   * Rijen uit de grid: geselecteerde rijen indien aanwezig, anders alle
   * gefilterde/gesorteerde rijen (display-waarden). Lui opgevraagd zodat de
   * menu-labels niet van de grid-API afhangen tijdens render.
   */
  getGridRows: () => unknown[][]
}

type Source = 'grid' | 'result'

interface ExportAction {
  source: Source
  format: ExportFormat
  target: ExportTarget
  label: string
}

const ACTIONS: ExportAction[] = [
  { source: 'grid', format: 'csv', target: 'clipboard', label: 'CSV → clipboard' },
  { source: 'grid', format: 'csv', target: 'file', label: 'CSV → file…' },
  { source: 'grid', format: 'xlsx', target: 'file', label: 'XLSX → file…' },
  { source: 'result', format: 'csv', target: 'clipboard', label: 'CSV → clipboard' },
  { source: 'result', format: 'csv', target: 'file', label: 'CSV → file…' },
  { source: 'result', format: 'xlsx', target: 'file', label: 'XLSX → file…' }
]

/** Bestandsnaam met tijdstempel: resultaat-20260831-221500 (zonder extensie). */
function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

type Feedback = { kind: 'ok' | 'error'; text: string } | null

export function ExportMenu({ columns, resultRows, getGridRows }: ExportMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])

  const showFeedback = (fb: Feedback): void => {
    setFeedback(fb)
    if (timer.current !== null) window.clearTimeout(timer.current)
    if (fb) {
      timer.current = window.setTimeout(() => setFeedback(null), 5000)
    }
  }

  const run = async (action: ExportAction): Promise<void> => {
    setOpen(false)
    const rows = action.source === 'grid' ? getGridRows() : resultRows
    if (rows.length === 0) {
      showFeedback({ kind: 'error', text: 'No rows to export.' })
      return
    }
    setBusy(true)
    try {
      const exportColumns: ExportColumn[] = columns.map((c) => ({ name: c.name, dataType: c.dataType }))
      const res = await window.nvag.query.exportResults({
        format: action.format,
        target: action.target,
        fileName: `result-${stamp()}`,
        columns: exportColumns,
        rows,
        delimiter: ';'
      })
      if (res.error) {
        showFeedback({ kind: 'error', text: res.error })
      } else if (res.canceled) {
        // Gebruiker annuleerde de save-dialoog; geen feedback nodig.
      } else if (action.target === 'clipboard') {
        showFeedback({ kind: 'ok', text: `${res.rowCount ?? rows.length} row(s) copied to clipboard.` })
      } else {
        showFeedback({ kind: 'ok', text: `Exported to ${res.filePath}` })
      }
    } catch (err) {
      showFeedback({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const gridActions = ACTIONS.filter((a) => a.source === 'grid')
  const resultActions = ACTIONS.filter((a) => a.source === 'result')

  return (
    <div className="export-menu">
      <button
        type="button"
        className={open ? 'export-trigger active' : 'export-trigger'}
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title="Export results (CSV / XLSX)"
      >
        {busy ? '⏳ Working…' : '⬇ Export'}
      </button>
      {feedback && (
        <span className={`export-feedback export-${feedback.kind}`} role="status">
          {feedback.text}
        </span>
      )}
      {open && (
        <>
          <div className="export-backdrop" onClick={() => setOpen(false)} />
          <div className="export-dropdown" role="menu">
            <div className="export-group-label">From grid</div>
            {gridActions.map((a) => (
              <button key={`grid-${a.format}-${a.target}`} type="button" role="menuitem" onClick={() => void run(a)}>
                {a.label}
              </button>
            ))}
            <div className="export-group-label">Full result ({resultRows.length} row(s))</div>
            {resultActions.map((a) => (
              <button key={`result-${a.format}-${a.target}`} type="button" role="menuitem" onClick={() => void run(a)}>
                {a.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
