import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import App from './App'
import { useAppStore } from './state/store'
import {
  createMockNvag,
  sampleConnection,
  sampleQueryResult,
  sampleTableMetadata
} from './test/mockNvag'

/**
 * Monaco kan niet in jsdom draaien; vervang de editor door een textarea
 * die de store bijwerkt (zelfde gedrag als de echte editor).
 */
vi.mock('./components/QueryEditor', () => ({
  QueryEditor: ({
    tabId,
    sql,
    onRun
  }: {
    tabId: string
    sql: string
    onRun?: () => void
  }) => (
    <textarea
      data-testid="query-editor"
      aria-label="SQL-query"
      value={sql}
      onChange={(e) => {
        useAppStore.getState().updateTabSql(tabId, e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.ctrlKey && e.key === 'Enter') onRun?.()
      }}
    />
  )
}))

function resetStore(): void {
  useAppStore.setState({
    connections: [],
    openSessions: {},
    tabs: [],
    activeTabId: null,
    showConnectionDialog: false,
    connectionDialogMode: 'create',
    editingConnectionId: null
  })
}

beforeEach(() => {
  cleanup()
  resetStore()
  window.nvag = createMockNvag({
    connections: [sampleConnection()],
    tables: ['klanten'],
    views: ['v_klanten'],
    tableMetadata: { klanten: sampleTableMetadata('klanten') },
    queryResults: {
      'SELECT * FROM "klanten" LIMIT 100': sampleQueryResult(),
      'SELECT FOUT;': {
        executionId: 'exec-err',
        columns: [],
        rows: [],
        truncated: false,
        rowCount: 0,
        durationMs: 0,
        error: 'near "FOUT": syntax error',
        errorPosition: { line: 1, column: 7 }
      }
    }
  })
})

async function connectViaDialog(): Promise<void> {
  fireEvent.click(await screen.findByTitle('Nieuwe verbinding'))
  const nameInput = screen.getByLabelText('Naam') as HTMLInputElement
  const pathInput = screen.getByLabelText('Databasepad (host)') as HTMLInputElement
  fireEvent.change(nameInput, { target: { value: 'Klantendatabase' } })
  fireEvent.change(pathInput, { target: { value: '/tmp/klanten.db' } })
  fireEvent.click(screen.getByRole('button', { name: 'Opslaan & verbinden' }))

  // Sessie open: de verbonden server (🟢) verschijnt naast de bestaande (⚪)
  await waitFor(() => expect(screen.getAllByText('Klantendatabase').length).toBeGreaterThanOrEqual(2))
  // Server-knooppunt uitklappen → 'Databases'-folder
  const servers = screen.getAllByText('Klantendatabase')
  fireEvent.click(servers[servers.length - 1]!)
  await waitFor(() => expect(screen.getByText('Databases')).toBeTruthy())
}

async function expandToTables(): Promise<void> {
  await connectViaDialog()
  fireEvent.click(screen.getByText('Databases'))
  await waitFor(() => expect(screen.getAllByText('main').length).toBeGreaterThan(0))
  // database-niveau 'main' uitklappen → schema-niveau 'main'
  fireEvent.click(screen.getAllByText('main')[0]!)
  await waitFor(() => expect(screen.getAllByText('main').length).toBeGreaterThanOrEqual(2))
  // schema-niveau 'main' uitklappen → tabellen/views
  fireEvent.click(screen.getAllByText('main')[1]!)
  await waitFor(() => expect(screen.getByText('klanten')).toBeTruthy())
}

describe('App (renderer-integratie)', () => {
  it('toont verbindingen in de objectverkenner', async () => {
    render(<App />)
    expect(await screen.findByText('Klantendatabase')).toBeTruthy()
    expect(screen.getByText('Object Explorer')).toBeTruthy()
  })

  it('biedt create-if-missing aan in de verbindingsdialoog (SAL-11)', async () => {
    render(<App />)
    fireEvent.click(await screen.findByTitle('Nieuwe verbinding'))
    expect(screen.getByText('Maak het bestand aan wanneer het niet bestaat')).toBeTruthy()
  })

  it('toont kolomdetails bij klik op een tabel (SAL-11)', async () => {
    render(<App />)
    await expandToTables()
    fireEvent.click(screen.getByText('klanten'))
    await waitFor(() => expect(screen.getByText('Tabel: klanten')).toBeTruthy())
    expect(await screen.findByText(/id 🔑/)).toBeTruthy()
    expect(screen.getByText('naam')).toBeTruthy()
    expect(await screen.findByText(/Rijen: 2/)).toBeTruthy()
  })

  it('opent een SELECT-tab bij dubbelklik op een tabel en draait de query (SAL-11)', async () => {
    render(<App />)
    await expandToTables()
    fireEvent.doubleClick(screen.getByText('klanten'))

    // Nieuwe tab met gegenereerde SELECT + verbinding
    await waitFor(() => {
      const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
      expect(editor.value).toBe('SELECT * FROM "klanten" LIMIT 100')
    })

    fireEvent.click(screen.getByRole('button', { name: '▶ Uitvoeren' }))
    await waitFor(() => expect(screen.getByText('Jan')).toBeTruthy())
    expect(screen.getByText('NULL')).toBeTruthy()
    expect(screen.getByText(/2 rij\(en\) in 3 ms/)).toBeTruthy()
  })

  it('wisselt tussen Resultaten- en Berichten-tabbladen (SAL-11)', async () => {
    render(<App />)
    await expandToTables()
    fireEvent.doubleClick(screen.getByText('klanten'))

    const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'SELECT FOUT;' } })
    fireEvent.click(screen.getByRole('button', { name: '▶ Uitvoeren' }))

    // Resultaten-tab toont de fout (ook in de statusbalk)
    await waitFor(() =>
      expect(screen.getAllByText(/near "FOUT": syntax error/).length).toBeGreaterThanOrEqual(1)
    )
    // Berichten-tab toont het foutbericht
    fireEvent.click(screen.getByRole('tab', { name: 'Berichten' }))
    expect(screen.getAllByText(/Fout: near "FOUT": syntax error/).length).toBeGreaterThanOrEqual(1)
    // Terug naar Resultaten
    fireEvent.click(screen.getByRole('tab', { name: 'Resultaten' }))
    expect(screen.getAllByText(/near "FOUT": syntax error/).length).toBeGreaterThanOrEqual(1)
  })

  it('toont de statusbalk met verbindings- en query-status (SAL-11)', async () => {
    render(<App />)
    await expandToTables()
    // Dubbelklik opent een tab mét verbinding → statusbalk toont de sessie
    fireEvent.doubleClick(screen.getByText('klanten'))
    await waitFor(() => expect(screen.getByText(/Verbonden: Klantendatabase/)).toBeTruthy())
    expect(screen.getByText(/SQLite 3\.53\.1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '▶ Uitvoeren' }))
    await waitFor(() => expect(screen.getByText(/Query voltooid — 2 rij\(en\) in 3 ms/)).toBeTruthy())
  })
})
