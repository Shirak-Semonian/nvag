/**
 * Table Data Viewer/Editor (F2-1, eis 8).
 *
 * - Select Top N weergave (via tableData:getRows)
 * - Inline bewerken (AG Grid editable): cel wijzigen → UPDATE
 * - Nieuwe rij → INSERT (formulier); rij verwijderen → DELETE
 * - Altijd zichtbaar welke SQL draait (`lastSql`); guard-blokkades vragen
 *   bevestiging via de TableEditConfirmDialog.
 */

import { useEffect, useMemo, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { ColDef, GridApi, GridReadyEvent, CellValueChangedEvent } from 'ag-grid-community'
import 'ag-grid-community/styles/ag-grid.css'
import 'ag-grid-community/styles/ag-theme-quartz.css'
import type { QueryCellValue } from '@nvag/contracts'
import { useAppStore } from '../state/store'
import { toDisplayValue } from './ResultsGrid'

function fieldFor(index: number): string {
  return `col_${index}`
}

export function TableDataPanel({ tabId }: { tabId: string }): React.JSX.Element {
  const tab = useAppStore((s) => s.tabs.find((t) => t.id === tabId))
  const loadTableRows = useAppStore((s) => s.loadTableRows)
  const saveTableEdit = useAppStore((s) => s.saveTableEdit)
  const openSessions = useAppStore((s) => s.openSessions)
  const [gridApi, setGridApi] = useState<GridApi | null>(null)

  const td = tab?.tableData
  const resultData = td?.data ?? null
  const hasSession = Boolean(tab?.connectionId && openSessions[tab.connectionId])

  // SAL-42: een table-data tab die zonder (nog) actieve sessie is geopend
  // toont geen stille "Laden…", maar laadt automatisch zodra de sessie er is.
  useEffect(() => {
    if (!tab?.connectionId || !td || resultData !== null || td.loading || td.error || !hasSession) return
    void loadTableRows(tabId)
  }, [tabId, tab, td, resultData, hasSession, loadTableRows])

  const columnDefs = useMemo<ColDef[]>(() => {
    if (!resultData) return []
    return resultData.columns.map((c, i) => ({
      field: fieldFor(i),
      headerName: c.name,
      sortable: true,
      filter: true,
      resizable: true,
      editable: resultData.editableColumns.includes(c.name),
      cellRenderer: (p: { value: unknown }) => (
        <span className={p.value === null ? 'cell-null' : ''}>
          {p.value === null ? 'NULL' : String(toDisplayValue(p.value))}
        </span>
      )
    }))
  }, [resultData])

  const rowData = useMemo(() => {
    if (!resultData) return []
    return resultData.rows.map((r) => {
      const obj: Record<string, unknown> = {}
      resultData.columns.forEach((_, i) => {
        obj[fieldFor(i)] = toDisplayValue(r.values[i])
      })
      return obj
    })
  }, [resultData])

  if (!tab?.connectionId || !td) return <div className="results-empty">No table selected.</div>
  if (!resultData) {
    // SAL-42: expliciete toestanden i.p.v. een eeuwige "Laden…":
    // bezig → spinner; mislukt → fout + opnieuw laden; geen sessie → melding.
    if (td.loading) {
      return <div className="results-empty">Loading…</div>
    }
    if (td.error) {
      return (
        <div className="results-error table-data-load-error">
          <span>Failed to load table data: {td.error}</span>
          <button onClick={() => void loadTableRows(tabId)}>Reload</button>
        </div>
      )
    }
    if (!hasSession) {
      return (
        <div className="results-empty">
          No active connection for this table. Open the connection first to load the data.
        </div>
      )
    }
    // Sessie staat open maar er is nog geen data: de load wordt door het
    // effect hierboven gestart (of is net bezig); toon een korte laadtekst.
    return <div className="results-empty">Loading…</div>
  }
  const data = resultData

  const pkColumns = data.primaryKey

  const pkValuesForRow = (row: Record<string, unknown>): Record<string, QueryCellValue> => {
    const out: Record<string, QueryCellValue> = {}
    for (const pk of pkColumns) {
      const idx = data.columns.findIndex((c) => c.name === pk)
      if (idx >= 0) out[pk] = (row[fieldFor(idx)] ?? null) as QueryCellValue
    }
    return out
  }

  const onCellValueChanged = (e: CellValueChangedEvent): void => {
    const colName = data.columns[Number((e.colDef.field ?? '0').replace('col_', ''))]?.name
    if (!colName || e.oldValue === e.newValue) return
    const pkValues = pkValuesForRow(e.data as Record<string, unknown>)
    void saveTableEdit(tabId, 'update', { [colName]: e.newValue as QueryCellValue }, pkValues)
  }

  const deleteRow = (row: Record<string, unknown>): void => {
    void saveTableEdit(tabId, 'delete', {}, pkValuesForRow(row))
  }

  const onGridReady = (e: GridReadyEvent): void => {
    setGridApi(e.api)
  }

  return (
    <div className="table-data-panel">
      <div className="result-toolbar">
        <span className="result-meta">
          {data.columns.length} column(s) · {data.rowCount} row(s)
          {data.truncated ? ' (truncated at 100)' : ''}
        </span>
        <span className="result-toolbar-spacer" />
        <button type="button" onClick={() => void loadTableRows(tabId)} title="Refresh">
          ⟳ Refresh
        </button>
        <button
          type="button"
          onClick={() => {
            if (gridApi) gridApi.deselectAll()
            // Nieuwe rij-modus: formulier onder de grid.
            useAppStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId && t.tableData
                  ? { ...t, tableData: { ...t.tableData, inserting: !t.tableData.inserting } }
                  : t
              )
            }))
          }}
          title="Insert new row"
        >
          ＋ New row
        </button>
        {gridApi && (
          <button
            type="button"
            className="danger"
            onClick={() => {
              const sel = gridApi.getSelectedRows() as Record<string, unknown>[]
              if (sel.length === 0) return
              for (const row of sel) deleteRow(row)
            }}
            disabled={gridApi.getSelectedRows().length === 0}
            title="Delete selected rows"
          >
            🗑 Delete
          </button>
        )}
      </div>

      {td.error && (
        <div className="results-error table-data-refresh-error">
          <span>Refresh failed: {td.error}</span>
          <button onClick={() => void loadTableRows(tabId)}>Reload</button>
        </div>
      )}

      <div className="ag-theme-quartz-dark result-ag-grid">
        <AgGridReact
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={{ resizable: true, sortable: true, filter: true }}
          rowSelection={{ mode: 'multiRow', headerCheckbox: false, enableClickSelection: true }}
          onGridReady={onGridReady}
          onCellValueChanged={onCellValueChanged}
          enableCellTextSelection
          ensureDomOrder
          rowHeight={26}
          headerHeight={30}
          suppressCellFocus
        />
      </div>

      {td.inserting && <InsertRowForm tabId={tabId} />}

      {td.lastSql && (
        <details className="table-data-sql" open>
          <summary>Executed SQL (visible)</summary>
          <pre>{td.lastSql}</pre>
        </details>
      )}
      {td.lastEditMessage && <div className="table-data-message">{td.lastEditMessage}</div>}
    </div>
  )
}

/** Formulier voor een nieuwe rij (INSERT). */
function InsertRowForm({ tabId }: { tabId: string }): React.JSX.Element {
  const tab = useAppStore((s) => s.tabs.find((t) => t.id === tabId))
  const saveTableEdit = useAppStore((s) => s.saveTableEdit)
  const [values, setValues] = useState<Record<string, string>>({})
  const td = tab?.tableData
  const resultData = td?.data
  if (!resultData) return <></>

  const editable = resultData.columns.filter((c) => resultData.editableColumns.includes(c.name))

  const submit = (): void => {
    const insertValues: Record<string, QueryCellValue> = {}
    for (const col of editable) {
      const raw = values[col.name]
      if (raw === undefined || raw === '') continue
      // Heuristisch type: leeg laten → null; numeriek → number; rest string.
      if (/^-?\d+(\.\d+)?$/.test(raw)) insertValues[col.name] = Number(raw)
      else insertValues[col.name] = raw
    }
    void saveTableEdit(tabId, 'insert', insertValues, {})
    useAppStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId && t.tableData ? { ...t, tableData: { ...t.tableData, inserting: false } } : t
      )
    }))
  }

  return (
    <div className="insert-row-form">
      <strong>New row</strong>
      <div className="insert-row-grid">
        {editable.map((col) => (
          <label key={col.name}>
            <span>{col.name}</span>
            <input
              value={values[col.name] ?? ''}
              placeholder="value"
              onChange={(e) => setValues((v) => ({ ...v, [col.name]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <div className="insert-row-actions">
        <button type="button" className="primary" onClick={submit}>
          Run INSERT
        </button>
        <button
          type="button"
          onClick={() =>
            useAppStore.setState((s) => ({
              tabs: s.tabs.map((t) =>
                t.id === tabId && t.tableData
                  ? { ...t, tableData: { ...t.tableData, inserting: false } }
                  : t
              )
            }))
          }
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
