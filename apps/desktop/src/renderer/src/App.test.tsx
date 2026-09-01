import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { DatabaseInfo } from '@nvag/contracts'
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

  it('toont objecteigenschappen per objecttype in de Object Viewer (F1-5)', async () => {
    render(<App />)
    await expandToTables()
    fireEvent.click(screen.getByText('klanten'))
    await waitFor(() => expect(screen.getByText('Tabel: klanten')).toBeTruthy())
    // Algemeen: eigenschappen
    expect(await screen.findByText('Rijen')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Kolommen' })).toBeTruthy()
    // Kolommen-sectie
    fireEvent.click(screen.getByRole('tab', { name: 'Kolommen' }))
    expect(screen.getByText(/id 🔑/)).toBeTruthy()
    expect(screen.getByText('naam')).toBeTruthy()
    expect(screen.getAllByText('TEXT').length).toBeGreaterThan(0)
    // Definitie-sectie toont de CREATE
    fireEvent.click(screen.getByRole('tab', { name: 'Definitie' }))
    expect(await screen.findByText(/CREATE TABLE/)).toBeTruthy()
  })

  it('opent Script-as-tabbladen met dialect-correcte SQL (F1-5)', async () => {
    render(<App />)
    await expandToTables()
    fireEvent.click(screen.getByText('klanten'))
    await waitFor(() => expect(screen.getByText('Tabel: klanten')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'SELECT' }))
    await waitFor(() => {
      const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
      expect(editor.value).toBe('SELECT "id", "naam"\nFROM "main"."klanten";')
    })
    expect(screen.getByText('klanten — SELECT')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'CREATE' }))
    await waitFor(() => {
      const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
      expect(editor.value).toContain('CREATE TABLE "main"."klanten" (')
      expect(editor.value).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL')
    })

    fireEvent.click(screen.getByRole('button', { name: 'INSERT' }))
    await waitFor(() => {
      const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
      expect(editor.value).toBe('INSERT INTO "main"."klanten" ("naam")\nVALUES (?);')
    })
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

  // ------------------------------------------------------------------ F1-10
  it('toont per tab een database-dropdown en wisselt de database via useDatabase (F1-10)', async () => {
    const conn = sampleConnection()
    const withDb = createMockNvag({ connections: [conn] })
    window.nvag = withDb
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-1': {
          config: conn,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3', currentDatabase: 'test.db' }
        }
      }
    })
    useAppStore.getState().addTab({ connectionId: 'conn-1' })

    render(<App />)

    const dbSelect = (await screen.findByTitle('Database van deze tab')) as HTMLSelectElement
    expect(dbSelect).toBeTruthy()
    expect(screen.getByRole('option', { name: 'main' })).toBeTruthy()

    fireEvent.change(dbSelect, { target: { value: 'main' } })
    await waitFor(() => expect(withDb.useDatabaseCalls).toEqual([{ connectionId: 'conn-1', database: 'main' }]))
    // De tab-context toont de gekozen database
    await waitFor(() => expect(screen.getByText(/db: main/)).toBeTruthy())
  })

  it('switcht snel van verbinding via de dropdown en opent de sessie automatisch (F1-10)', async () => {
    const connA = sampleConnection({ id: 'conn-a', name: 'Server A', database: 'dbA' })
    const connB = sampleConnection({ id: 'conn-b', name: 'Server B', database: 'dbB' })
    const withTwo = createMockNvag({ connections: [connA, connB] })
    window.nvag = withTwo

    useAppStore.getState().addTab()
    render(<App />)
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Server B' }).length).toBeGreaterThan(0))

    const connSelect = screen.getByTitle(
      'Verbonden server van deze tab (kiezen opent de sessie)'
    ) as HTMLSelectElement
    fireEvent.change(connSelect, { target: { value: 'conn-b' } })

    await waitFor(() => expect(withTwo.openSavedCalls).toEqual(['conn-b']))
    const tab = useAppStore.getState().tabs[0]
    expect(tab?.connectionId).toBe('conn-b')
    expect(tab?.database).toBe('dbB')
    expect(useAppStore.getState().openSessions['conn-b']).toBeTruthy()
    // Tab-context toont server + gekozen database
    await waitFor(() => expect(screen.getByText(/db: dbB/)).toBeTruthy())
  })

  it('toont een fout in de tab-context wanneer de verbindingsswitch faalt (F1-10)', async () => {
    const connA = sampleConnection({ id: 'conn-a', name: 'Server A', database: 'dbA' })
    const connB = sampleConnection({ id: 'conn-b', name: 'Server B', database: 'dbB' })
    const failing = createMockNvag({
      connections: [connA, connB],
      failOpenConnectionIds: ['conn-b']
    })
    window.nvag = failing

    useAppStore.getState().addTab()
    render(<App />)
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Server B' }).length).toBeGreaterThan(0))

    const connSelect = screen.getByTitle(
      'Verbonden server van deze tab (kiezen opent de sessie)'
    ) as HTMLSelectElement
    fireEvent.change(connSelect, { target: { value: 'conn-b' } })

    await waitFor(() => expect(screen.getByText(/bestand niet gevonden/)).toBeTruthy())
    expect(useAppStore.getState().tabs[0]?.connectionId).toBeNull()
  })

  // ------------------------------------------------------------------ SAL-29
  it('toont een metadata-fout bij uitklappen van een database i.p.v. te crashen (SAL-29)', async () => {
    const conn = sampleConnection({ id: 'conn-sql', name: 'SQL Server', providerId: 'sqlserver', database: 'master' })
    window.nvag = createMockNvag({
      connections: [conn],
      databases: [{ name: 'Klanten' }],
      metadataErrors: {
        listSchemas: "The server principal 'sa' is not able to access the database 'Klanten'"
      }
    })
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-sql': {
          config: conn,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlserver', providerName: 'SQL Server', serverVersion: '17', currentDatabase: 'master' }
        }
      }
    })

    render(<App />)
    // Server uitklappen → Databases-folder
    fireEvent.click(screen.getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Databases')).toBeTruthy())
    // Databases-folder uitklappen → database 'Klanten'
    fireEvent.click(screen.getByText('Databases'))
    await waitFor(() => expect(screen.getByText('Klanten')).toBeTruthy())
    // Database uitklappen → listSchemas faalt → fout in de boom, geen crash
    fireEvent.click(screen.getByText('Klanten'))
    await waitFor(() =>
      expect(
        screen.getByText(/Kan schema's niet laden: The server principal 'sa' is not able to access the database 'Klanten'/)
      ).toBeTruthy()
    )
  })

  // ------------------------------------------------------------------ SAL-30
  it('toont een nieuw aangemaakte database bij heruitklappen van Databases (SAL-30)', async () => {
    const conn = sampleConnection({ id: 'conn-sql', name: 'SQL Server', providerId: 'sqlserver', database: 'master' })
    const databases: DatabaseInfo[] = [{ name: 'Klanten' }]
    window.nvag = createMockNvag({
      connections: [conn],
      databases
    })
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-sql': {
          config: conn,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlserver', providerName: 'SQL Server', serverVersion: '17', currentDatabase: 'master' }
        }
      }
    })

    render(<App />)
    // Server uitklappen → Databases-folder
    fireEvent.click(screen.getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Databases')).toBeTruthy())
    // Databases-folder uitklappen → bestaande database zichtbaar
    fireEvent.click(screen.getByText('Databases'))
    await waitFor(() => expect(screen.getByText('Klanten')).toBeTruthy())
    // Databases inklappen (kinderen verdwijnen uit de boom)
    fireEvent.click(screen.getByText('Databases'))
    await waitFor(() => expect(screen.queryByText('Klanten')).toBeNull())
    // Nieuwe database aangemaakt via de Admin-knop (CREATE DATABASE)
    databases.push({ name: 'NieuweTestDB' })
    // Heruitklappen → actuele lijst inclusief de nieuwe database
    fireEvent.click(screen.getByText('Databases'))
    await waitFor(() => expect(screen.getByText('NieuweTestDB')).toBeTruthy())
    expect(screen.getByText('Klanten')).toBeTruthy()
  })
})
