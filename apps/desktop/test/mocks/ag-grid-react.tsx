/**
 * Test-mock voor ag-grid-react: jsdom kan AG Grid niet volledig opstarten
 * (ResizeObserver/DOM-layout) en renderToStaticMarkup toont alleen een lege
 * container. Deze mock rendert headers + cellen zodat component-tests de
 * daadwerkelijke weergave (kolommen, rijen, NULL) kunnen controleren.
 *
 * De echte AG Grid-functionaliteit (sorteren/filteren/kopiëren) is AG Grid's
 * eigen verantwoordelijkheid; wij testen hier de Nvag-wiring.
 */

import React from 'react'

interface MockColumnDef {
  field?: string
  headerName?: string
}

interface MockRowData {
  [field: string]: unknown
}

export function AgGridReact(props: {
  columnDefs?: MockColumnDef[]
  rowData?: MockRowData[]
  className?: string
  [key: string]: unknown
}): React.JSX.Element {
  const columnDefs = props.columnDefs ?? []
  const rowData = props.rowData ?? []
  return (
    <div className={props.className ?? 'ag-theme-quartz-dark'} data-testid="ag-grid-mock">
      <table>
        <thead>
          <tr>
            {columnDefs.map((c, i) => (
              <th key={i}>{c.headerName ?? c.field ?? ''}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowData.map((row, i) => (
            <tr key={i}>
              {columnDefs.map((c, j) => {
                const value = c.field ? row[c.field] : undefined
                return (
                  <td key={j} className={value === null || value === undefined ? 'cell-null' : ''}>
                    {value === null || value === undefined ? 'NULL' : String(value)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
