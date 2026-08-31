import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ExportRequest, ExportResult } from '@nvag/contracts'
import { ExportMenu } from '../src/renderer/src/components/ExportMenu'

const columns = [
  { name: 'id', dataType: 'INTEGER' },
  { name: 'naam', dataType: 'TEXT' }
]
const resultRows: unknown[][] = [
  [1, 'Alice'],
  [2, null]
]
const gridRows: unknown[][] = [
  [3, 'Bob'],
  [4, 'Eve']
]

function mockExport() {
  const exportResults = vi.fn(async (_req: ExportRequest): Promise<ExportResult> => ({ ok: true, rowCount: 2 }))
  ;(window as unknown as { nvag: unknown }).nvag = {
    query: { exportResults }
  } as never
  return exportResults
}

function renderMenu() {
  return render(
    <ExportMenu columns={columns} resultRows={resultRows} getGridRows={() => gridRows} />
  )
}

describe('ExportMenu (F1-7)', () => {
  beforeEach(() => {
    cleanup()
  })

  it('toont de trigger en opent het menu met beide bronnen', () => {
    renderMenu()
    fireEvent.click(screen.getByTitle('Resultaten exporteren (CSV / XLSX)'))
    expect(screen.getByText('Vanuit grid')).toBeTruthy()
    expect(screen.getByText('Volledig resultaat (2 rij(en))')).toBeTruthy()
    expect(screen.getAllByRole('menuitem')).toHaveLength(6)
  })

  it('exporteert grid-rijen (selectie/weergave) naar CSV-klembord', async () => {
    const exportResults = mockExport()
    renderMenu()
    fireEvent.click(screen.getByTitle('Resultaten exporteren (CSV / XLSX)'))
    fireEvent.click(screen.getAllByRole('menuitem')[0]!) // grid: CSV → klembord

    await waitFor(() => expect(exportResults).toHaveBeenCalledTimes(1))
    const req = exportResults.mock.calls[0]![0] as ExportRequest
    expect(req.format).toBe('csv')
    expect(req.target).toBe('clipboard')
    expect(req.rows).toEqual(gridRows)
    expect(req.delimiter).toBe(';')
    expect(req.fileName).toMatch(/^resultaat-\d{8}-\d{6}$/)
  })

  it('exporteert het volledige resultaat naar XLSX-bestand (originele waarden)', async () => {
    const exportResults = mockExport()
    renderMenu()
    fireEvent.click(screen.getByTitle('Resultaten exporteren (CSV / XLSX)'))
    fireEvent.click(screen.getAllByRole('menuitem')[5]!) // resultaat: XLSX → bestand

    await waitFor(() => expect(exportResults).toHaveBeenCalledTimes(1))
    const req = exportResults.mock.calls[0]![0] as ExportRequest
    expect(req.format).toBe('xlsx')
    expect(req.target).toBe('file')
    expect(req.rows).toEqual(resultRows)
  })

  it('toont feedback na klembord-export', async () => {
    mockExport()
    renderMenu()
    fireEvent.click(screen.getByTitle('Resultaten exporteren (CSV / XLSX)'))
    fireEvent.click(screen.getAllByRole('menuitem')[0]!)
    await waitFor(() => expect(screen.getByText(/2 rij\(en\) naar klembord gekopieerd/)).toBeTruthy())
  })

  it('toont een fout wanneer main een error teruggeeft', async () => {
    const exportResults = vi.fn(async (_req: ExportRequest): Promise<ExportResult> => ({ error: 'schijf vol' }))
    ;(window as unknown as { nvag: unknown }).nvag = { query: { exportResults } } as never
    renderMenu()
    fireEvent.click(screen.getByTitle('Resultaten exporteren (CSV / XLSX)'))
    fireEvent.click(screen.getAllByRole('menuitem')[0]!)
    await waitFor(() => expect(screen.getByText('schijf vol')).toBeTruthy())
  })

  it('weigert te exporteren zonder rijen', async () => {
    const exportResults = mockExport()
    render(<ExportMenu columns={columns} resultRows={[]} getGridRows={() => []} />)
    fireEvent.click(screen.getByTitle('Resultaten exporteren (CSV / XLSX)'))
    fireEvent.click(screen.getAllByRole('menuitem')[0]!)
    await waitFor(() => expect(screen.getByText('Geen rijen om te exporteren.')).toBeTruthy())
    expect(exportResults).not.toHaveBeenCalled()
  })
})
