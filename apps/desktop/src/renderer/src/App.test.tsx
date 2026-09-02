import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    showAdminDialog: false,
    adminDialogConnectionId: null,
    adminDialogTab: null,
    connectionDialogMode: 'create',
    editingConnectionId: null,
    dbListRevision: 0
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
      'SELECT * FROM "main"."klanten" LIMIT 100': sampleQueryResult(),
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
  // database-niveau 'main' uitklappen → objectfolders (SAL-32: SSMS-hiërarchie)
  fireEvent.click(screen.getAllByText('main')[0]!)
  await waitFor(() => expect(screen.getByText('Tables')).toBeTruthy())
  // Tables-folder uitklappen → tabellen
  fireEvent.click(screen.getByText('Tables'))
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

    // Nieuwe tab met gegenereerde SELECT + verbinding (schema-gekwalificeerd)
    await waitFor(() => {
      const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
      expect(editor.value).toBe('SELECT * FROM "main"."klanten" LIMIT 100')
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
  it('toont een metadata-fout bij uitklappen van een folder i.p.v. te crashen (SAL-29)', async () => {
    const conn = sampleConnection({ id: 'conn-sql', name: 'SQL Server', providerId: 'sqlserver', database: 'master' })
    window.nvag = createMockNvag({
      connections: [conn],
      databases: [{ name: 'Klanten' }],
      metadataErrors: {
        listTables: "The server principal 'sa' is not able to access the database 'Klanten'"
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
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    // Server uitklappen → Databases-folder
    fireEvent.click(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(within(tree()).getByText('Databases')).toBeTruthy())
    // Databases-folder uitklappen → database 'Klanten'
    fireEvent.click(within(tree()).getByText('Databases'))
    await waitFor(() => expect(within(tree()).getByText('Klanten')).toBeTruthy())
    // Database uitklappen → objectfolders
    fireEvent.click(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(within(tree()).getByText('Tables')).toBeTruthy())
    // Tables-folder uitklappen → listTables faalt → fout in de boom, geen crash
    fireEvent.click(within(tree()).getByText('Tables'))
    await waitFor(() =>
      expect(
        within(tree()).getByText(/Kan gegevens niet laden: The server principal 'sa' is not able to access the database 'Klanten'/)
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

  // ------------------------------------------------------------------ SAL-31
  function openSqlServerExplorer(): { databases: DatabaseInfo[] } {
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
    return { databases }
  }

  async function expandDatabasesFolder(): Promise<void> {
    // Met een actieve tab toont ook de toolbar (database-dropdown) dezelfde
    // namen; scope daarom op de boom zelf.
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    fireEvent.click(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(within(tree()).getByText('Databases')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Databases'))
    await waitFor(() => expect(within(tree()).getByText('Klanten')).toBeTruthy())
  }

  it('toont de refresh-knop disabled zolang er geen verbinding open is (SAL-31)', () => {
    render(<App />)
    const refresh = screen.getByRole('button', { name: 'Databases vernieuwen' }) as HTMLButtonElement
    expect(refresh.disabled).toBe(true)
  })

  it('refresh-knop herlaadt de databaselijst: nieuwe db verschijnt, verwijderde verdwijnt (SAL-31)', async () => {
    const { databases } = openSqlServerExplorer()
    render(<App />)
    await expandDatabasesFolder()

    // Server-side wijziging: nieuwe database aangemaakt buiten Nvag om
    databases.push({ name: 'NieuweTestDB' })
    fireEvent.click(screen.getByRole('button', { name: 'Databases vernieuwen' }))
    await waitFor(() => expect(screen.getByText('NieuweTestDB')).toBeTruthy())
    expect(screen.getByText('Klanten')).toBeTruthy()

    // Verwijderde database verdwijnt na een nieuwe refresh
    const idx = databases.findIndex((d) => d.name === 'Klanten')
    databases.splice(idx, 1)
    fireEvent.click(screen.getByRole('button', { name: 'Databases vernieuwen' }))
    await waitFor(() => expect(screen.queryByText('Klanten')).toBeNull())
    expect(screen.getByText('NieuweTestDB')).toBeTruthy()
  })

  it('toont een fout bij een mislukte refresh in de boom i.p.v. te crashen (SAL-31)', async () => {
    const mockOpts: { metadataErrors?: Record<string, string> } = {}
    const conn = sampleConnection({ id: 'conn-sql', name: 'SQL Server', providerId: 'sqlserver', database: 'master' })
    window.nvag = createMockNvag({
      connections: [conn],
      databases: [{ name: 'Klanten' }]
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
    // Na de eerste succesvolle load begint listDatabases te falen (simuleert
    // een serverfout tijdens het vernieuwen).
    const originalList = window.nvag.metadata.listDatabases
    window.nvag.metadata.listDatabases = async (connId: string) => {
      if (mockOpts.metadataErrors?.listDatabases) throw new Error(mockOpts.metadataErrors.listDatabases)
      return originalList(connId)
    }

    render(<App />)
    await expandDatabasesFolder()
    mockOpts.metadataErrors = { listDatabases: 'Kan databases niet bereiken' }
    fireEvent.click(screen.getByRole('button', { name: 'Databases vernieuwen' }))
    await waitFor(() =>
      expect(screen.getByText(/Kan gegevens niet laden: Kan databases niet bereiken/)).toBeTruthy()
    )
    // De boom blijft bruikbaar: header + folder bestaan nog
    expect(screen.getByText('Object Explorer')).toBeTruthy()
    expect(screen.getByText('Databases')).toBeTruthy()
  })

  it('ververst de databaselijst automatisch na CREATE DATABASE via de Admin-knop (SAL-31)', async () => {
    openSqlServerExplorer()
    useAppStore.getState().addTab({ connectionId: 'conn-sql' })
    render(<App />)
    await expandDatabasesFolder()

    // Admin-dialoog openen via de toolbar (actieve tab heeft een open sessie)
    fireEvent.click(screen.getByRole('button', { name: /🛠 Admin/ }))
    await waitFor(() => expect(screen.getByText(/Database Administration/)).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Naam'), { target: { value: 'NieuweTestDB' } })
    fireEvent.click(screen.getByRole('button', { name: 'Creëren' }))

    // Object Explorer herlaadt automatisch: nieuwe database verschijnt zonder handmatige refresh
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    await waitFor(() => expect(within(tree()).getByText('NieuweTestDB')).toBeTruthy())
    expect(within(tree()).getByText('Klanten')).toBeTruthy()
    expect(screen.getByText(/✅ CREATE DATABASE NieuweTestDB/)).toBeTruthy()
    // Ook de database-dropdown van de actieve tab is ververst
    expect(screen.getByRole('option', { name: 'NieuweTestDB' })).toBeTruthy()
  })

  it('ververst de databaselijst automatisch na DROP DATABASE via de Admin-knop (SAL-31)', async () => {
    openSqlServerExplorer()
    useAppStore.getState().addTab({ connectionId: 'conn-sql' })
    render(<App />)
    await expandDatabasesFolder()

    fireEvent.click(screen.getByRole('button', { name: /🛠 Admin/ }))
    await waitFor(() => expect(screen.getByText(/Database Administration/)).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Naam'), { target: { value: 'Klanten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }))

    await waitFor(() => expect(screen.queryByText('Klanten')).toBeNull())
    expect(screen.getByText(/✅ DROP DATABASE Klanten/)).toBeTruthy()
  })

  // ------------------------------------------------------------------ SAL-32
  interface SqlServerExplorerState {
    databases: DatabaseInfo[]
    tables: string[]
    views: string[]
    procedures: string[]
    functions: string[]
    synonyms: string[]
    users: string[]
    roles: string[]
    // SAL-45: triggers/sequences + tabelmetadata voor subobject-drop-tests.
    triggers: string[]
    sequences: string[]
  }

  function openSqlServerExplorerFull(adminDropBlocked = false): SqlServerExplorerState {
    const conn = sampleConnection({ id: 'conn-sql', name: 'SQL Server', providerId: 'sqlserver', database: 'master' })
    const state: SqlServerExplorerState = {
      databases: [{ name: 'Klanten' }],
      tables: ['klanten'],
      views: ['v_klanten'],
      procedures: ['sp_rapport'],
      functions: ['fn_bereken'],
      synonyms: ['syn_oud'],
      users: ['app_ro'],
      roles: ['db_datareader'],
      triggers: ['trg_klanten_ins'],
      sequences: ['seq_ordernr']
    }
    window.nvag = createMockNvag({
      connections: [conn],
      databases: state.databases,
      tables: state.tables,
      views: state.views,
      procedures: state.procedures,
      functions: state.functions,
      synonyms: state.synonyms,
      users: state.users,
      roles: state.roles,
      triggers: state.triggers,
      sequences: state.sequences,
      // SAL-45: tabel-subobjecten (index/constraint) voor drop-test.
      tableMetadata: {
        klanten: {
          ...sampleTableMetadata('klanten'),
          indexes: [{ name: 'idx_klanten_naam', columns: ['naam'], isUnique: false, isPrimaryKey: false }],
          constraints: [{ name: 'CK_leeftijd', type: 'CHECK', definition: '(leeftijd >= 0)' }],
          triggers: ['trg_klanten_ins']
        }
      },
      // SAL-34: guard-blokkade van admin-DROP simuleren (PROD-achtig).
      adminDropBlocked,
      capabilities: {
        supportsSchemas: true,
        supportsSequences: true,
        supportsSynonyms: true,
        supportsTriggers: true,
        supportsExecutionPlans: false,
        supportsMonitoring: false,
        supportsTransactions: true,
        supportsIdentityColumns: true,
        supportsGeneratedColumns: true,
        supportsDdlAdmin: true,
        supportsUsersAndRoles: true,
        supportsBackupRestore: true,
        maxResultRowsDefault: 1000,
        dialect: 'tsql'
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
    return state
  }

  async function expandSqlServerDb(): Promise<() => HTMLElement> {
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    fireEvent.click(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(within(tree()).getByText('Databases')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Databases'))
    await waitFor(() => expect(within(tree()).getByText('Klanten')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(within(tree()).getByText('Tables')).toBeTruthy())
    return tree
  }

  it('toont de SSMS-achtige hiërarchie met alle objectfolders (SAL-32)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    // Hoofdfolders onder de database
    expect(within(tree()).getByText('Tables')).toBeTruthy()
    expect(within(tree()).getByText('Views')).toBeTruthy()
    expect(within(tree()).getByText('Synonyms')).toBeTruthy()
    expect(within(tree()).getByText('Programmability')).toBeTruthy()
    expect(within(tree()).getByText('Security')).toBeTruthy()
    expect(within(tree()).getByText('Sequences')).toBeTruthy()

    // Programmability → Stored Procedures / Functions / Database Triggers
    fireEvent.click(within(tree()).getByText('Programmability'))
    await waitFor(() => expect(within(tree()).getByText('Stored Procedures')).toBeTruthy())
    expect(within(tree()).getByText('Functions')).toBeTruthy()
    expect(within(tree()).getByText('Database Triggers')).toBeTruthy()

    // Security → Users / Roles / Schemas
    fireEvent.click(within(tree()).getByText('Security'))
    await waitFor(() => expect(within(tree()).getByText('Users')).toBeTruthy())
    expect(within(tree()).getByText('Roles')).toBeTruthy()
    expect(within(tree()).getByText('Schemas')).toBeTruthy()
  })

  it('laadt objecten per folder: tabellen, views, synonyms, procedures, users, rollen (SAL-32)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.click(within(tree()).getByText('Tables'))
    await waitFor(() => expect(within(tree()).getByText('klanten')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Views'))
    await waitFor(() => expect(within(tree()).getByText('v_klanten')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Synonyms'))
    await waitFor(() => expect(within(tree()).getByText('syn_oud')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Programmability'))
    await waitFor(() => expect(within(tree()).getByText('Stored Procedures')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Stored Procedures'))
    await waitFor(() => expect(within(tree()).getByText('sp_rapport')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Functions'))
    await waitFor(() => expect(within(tree()).getByText('fn_bereken')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Security'))
    await waitFor(() => expect(within(tree()).getByText('Users')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Users'))
    await waitFor(() => expect(within(tree()).getByText('app_ro')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Roles'))
    await waitFor(() => expect(within(tree()).getByText('db_datareader')).toBeTruthy())
  })

  it('toont tabel-subobjecten (Columns/Keys/Constraints/Triggers/Indexes) bij uitklappen via chevron (SAL-32)', async () => {
    render(<App />)
    await expandToTables()

    // Chevron op de tabel klapt de subobjecten uit (rijklik blijft de viewer)
    fireEvent.click(screen.getByRole('button', { name: 'Tabel uitklappen' }))
    await waitFor(() => expect(screen.getByText('Columns')).toBeTruthy())
    expect(screen.getByText('Keys')).toBeTruthy()
    expect(screen.getByText('Constraints')).toBeTruthy()
    expect(screen.getByText('Triggers')).toBeTruthy()
    expect(screen.getByText('Indexes')).toBeTruthy()

    fireEvent.click(screen.getByText('Columns'))
    await waitFor(() => expect(screen.getByText('id')).toBeTruthy())
    expect(screen.getByText('naam')).toBeTruthy()

    fireEvent.click(screen.getByText('Keys'))
    await waitFor(() => expect(screen.getByText('PK_klanten')).toBeTruthy())

    // Inklappen via de chevron verwijdert de subobjecten weer
    fireEvent.click(screen.getByRole('button', { name: 'Tabel inklappen' }))
    await waitFor(() => expect(screen.queryByText('Columns')).toBeNull())
  })

  it('toont een nieuwe tabel na handmatige refresh van de Tables-folder (SAL-32)', async () => {
    const state = openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.click(within(tree()).getByText('Tables'))
    await waitFor(() => expect(within(tree()).getByText('klanten')).toBeTruthy())

    // Server-side wijziging: nieuwe tabel buiten Nvag om aangemaakt
    state.tables.push('nieuwe_tabel')
    fireEvent.click(within(tree()).getByRole('button', { name: 'Vernieuwen Tables' }))
    await waitFor(() => expect(within(tree()).getByText('nieuwe_tabel')).toBeTruthy())
    expect(within(tree()).getByText('klanten')).toBeTruthy()

    // Verwijderde tabel verdwijnt na een nieuwe refresh
    const idx = state.tables.indexOf('klanten')
    state.tables.splice(idx, 1)
    fireEvent.click(within(tree()).getByRole('button', { name: 'Vernieuwen Tables' }))
    await waitFor(() => expect(within(tree()).queryByText('klanten')).toBeNull())
    expect(within(tree()).getByText('nieuwe_tabel')).toBeTruthy()
  })

  it('ververst objectfolders automatisch na CREATE TABLE via de Admin-knop (SAL-32)', async () => {
    openSqlServerExplorerFull()
    useAppStore.getState().addTab({ connectionId: 'conn-sql' })
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.click(within(tree()).getByText('Tables'))
    await waitFor(() => expect(within(tree()).getByText('klanten')).toBeTruthy())

    // Admin-dialoog: nieuwe tabel aanmaken
    fireEvent.click(screen.getByRole('button', { name: /🛠 Admin/ }))
    await waitFor(() => expect(screen.getByText(/Database Administration/)).toBeTruthy())
    fireEvent.click(screen.getByRole('tab', { name: 'Tabellen' }))
    fireEvent.change(screen.getByPlaceholderText('naam'), { target: { value: 'nieuwe_tabel' } })
    fireEvent.click(screen.getByRole('button', { name: 'Creëren' }))

    // Object Explorer herlaadt de geopende Tables-folder automatisch
    await waitFor(() => expect(within(tree()).getByText('nieuwe_tabel')).toBeTruthy())
    expect(screen.getByText(/✅ CREATE TABLE nieuwe_tabel/)).toBeTruthy()
  })

  it('toont een contextmenu per objecttype met refresh en Script Object (SAL-32)', async () => {
    render(<App />)
    await expandToTables()

    fireEvent.contextMenu(screen.getByText('klanten'))
    await waitFor(() => expect(screen.getByText('Vernieuwen')).toBeTruthy())
    expect(screen.getByText('Tabelgegevens bekijken')).toBeTruthy()
    expect(screen.getByText('Eigenschappen')).toBeTruthy()
    expect(screen.getByText('Script Object als CREATE')).toBeTruthy()
    expect(screen.getByText('Script Object als SELECT')).toBeTruthy()

    // Script Object als CREATE opent een querytab met de gegenereerde CREATE TABLE
    fireEvent.click(screen.getByText('Script Object als CREATE'))
    await waitFor(() => {
      const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
      expect(editor.value).toContain('CREATE TABLE "main"."klanten" (')
    })
  })

  // ------------------------------------------------------------------ SAL-34

  it('toont een database-contextmenu met SSMS-opties en genereert CREATE DATABASE (SAL-34)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Nieuwe query')).toBeTruthy())
    expect(screen.getByText('Vernieuwen')).toBeTruthy()
    expect(screen.getByText('Eigenschappen')).toBeTruthy()
    expect(screen.getByText('Scripts genereren')).toBeTruthy()
    expect(screen.getByText('Nieuwe objecten aanmaken…')).toBeTruthy()
    expect(screen.getByText('Taken…')).toBeTruthy()
    expect(screen.getByText('Verbinding verbreken')).toBeTruthy()
    expect(screen.getByText('Database verwijderen…')).toBeTruthy()

    // Scripts genereren → dialect-correcte CREATE DATABASE in een nieuwe querytab.
    fireEvent.click(screen.getByText('Scripts genereren'))
    await waitFor(() => {
      const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
      expect(editor.value).toContain('CREATE DATABASE [Klanten]')
    })
  })

  it('opent de AdminDialog vanuit het database-contextmenu (nieuwe objecten + taken) (SAL-34)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    // "Nieuwe objecten aanmaken…" → AdminDialog op de Databases-tab.
    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Nieuwe objecten aanmaken…')).toBeTruthy())
    fireEvent.click(screen.getByText('Nieuwe objecten aanmaken…'))
    await waitFor(() => expect(screen.getByText(/Database Administration/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Sluiten' }))
    await waitFor(() => expect(screen.queryByText(/Database Administration/)).toBeNull())

    // "Taken…" → AdminDialog op de Backup-tab (capability-gated via supportsBackupRestore).
    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Taken…')).toBeTruthy())
    fireEvent.click(screen.getByText('Taken…'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Backup maken' })).toBeTruthy())
  })

  it('verwijdert een database alleen na expliciete bevestiging; annuleren doet niets (SAL-34)', async () => {
    const state = openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Database verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Database verwijderen…'))

    // Bevestigingsdialoog toont de destructieve SQL.
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/kan niet ongedaan worden gemaakt/)).toBeTruthy()
    expect(screen.getByText(/DROP DATABASE \[Klanten\]/)).toBeTruthy()

    // Annuleren: niets destructiefs, database blijft bestaan.
    fireEvent.click(screen.getByRole('button', { name: 'Annuleren' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(within(tree()).getByText('Klanten')).toBeTruthy()

    // Opnieuw openen en wél bevestigen → database verdwijnt na refresh.
    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Database verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Database verwijderen…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }))

    await waitFor(() => expect(within(tree()).queryByText('Klanten')).toBeNull())
    expect(state.databases.some((d) => d.name === 'Klanten')).toBe(false)
    expect(screen.getByText(/Database 'Klanten' verwijderd/)).toBeTruthy()
  })

  it('toont guard-redenen bij een geblokkeerde database-drop en voert pas na tweede bevestiging uit (SAL-34)', async () => {
    const state = openSqlServerExplorerFull(true)
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Database verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Database verwijderen…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }))

    // Guard-blokkade: redenen + tweede bevestiging.
    await waitFor(() => expect(screen.getByText(/PROD-omgeving vereist bevestiging/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Toch verwijderen' })).toBeTruthy()
    expect(within(tree()).getByText('Klanten')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Toch verwijderen' }))
    await waitFor(() => expect(within(tree()).queryByText('Klanten')).toBeNull())
    const drops = (window.nvag as ReturnType<typeof createMockNvag>).adminRequests.filter((r) => r.action === 'dropDatabase')
    expect(drops.length).toBe(2)
    expect(drops[0]?.confirmed).toBeFalsy()
    expect(drops[1]?.confirmed).toBe(true)
    expect(state.databases.some((d) => d.name === 'Klanten')).toBe(false)
  })

  it('verwijdert een tabel via het contextmenu met bevestiging en ververst de folder (SAL-34)', async () => {
    const state = openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.click(within(tree()).getByText('Tables'))
    await waitFor(() => expect(within(tree()).getByText('klanten')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('klanten'))
    await waitFor(() => expect(screen.getByText('Tabel verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Tabel verwijderen…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/DROP TABLE \[main\].\[klanten\]/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }))
    await waitFor(() => expect(within(tree()).queryByText('klanten')).toBeNull())
    expect(state.tables.includes('klanten')).toBe(false)
    expect(screen.getByText(/'klanten' verwijderd/)).toBeTruthy()
  })

  it('biedt folder-contextmenu\'s met "Nieuwe X aanmaken…" die de AdminDialog op de juiste tab openen (SAL-34)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    // Tables-folder → Nieuwe tabel… → AdminDialog op de Tabellen-tab.
    fireEvent.contextMenu(within(tree()).getByText('Tables'))
    await waitFor(() => expect(screen.getByText('Nieuwe tabel…')).toBeTruthy())
    fireEvent.click(screen.getByText('Nieuwe tabel…'))
    await waitFor(() => expect(screen.getByText(/Database Administration/)).toBeTruthy())
    expect(screen.getByRole('tab', { name: 'Tabellen' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByPlaceholderText('naam')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sluiten' }))
    await waitFor(() => expect(screen.queryByText(/Database Administration/)).toBeNull())

    // Views-folder → Nieuwe view… → AdminDialog op de Views-tab.
    fireEvent.contextMenu(within(tree()).getByText('Views'))
    await waitFor(() => expect(screen.getByText('Nieuwe view…')).toBeTruthy())
    fireEvent.click(screen.getByText('Nieuwe view…'))
    await waitFor(() => expect(screen.getByText(/Database Administration/)).toBeTruthy())
    expect(screen.getByRole('tab', { name: 'Views' }).getAttribute('aria-selected')).toBe('true')
  })

  it('gated contextmenu-opties per capability (geen DDL/backup → verborgen) (SAL-34)', async () => {
    const conn = sampleConnection({ id: 'conn-min', name: 'Minimaal', providerId: 'sqlserver', database: 'master' })
    window.nvag = createMockNvag({
      connections: [conn],
      databases: [{ name: 'Klanten' }],
      capabilities: {
        supportsSchemas: true,
        supportsSequences: false,
        supportsSynonyms: true,
        supportsTriggers: true,
        supportsExecutionPlans: false,
        supportsMonitoring: false,
        supportsTransactions: true,
        supportsIdentityColumns: true,
        supportsGeneratedColumns: true,
        supportsDdlAdmin: false,
        supportsUsersAndRoles: true,
        supportsBackupRestore: false,
        maxResultRowsDefault: 1000,
        dialect: 'tsql'
      }
    })
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-min': {
          config: conn,
          sessionId: 's-min',
          serverInfo: { providerId: 'sqlserver', providerName: 'SQL Server', serverVersion: '17', currentDatabase: 'master' }
        }
      }
    })
    render(<App />)
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    fireEvent.click(within(tree()).getByText('Minimaal'))
    await waitFor(() => expect(within(tree()).getByText('Databases')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Databases'))
    await waitFor(() => expect(within(tree()).getByText('Klanten')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Nieuwe query')).toBeTruthy())
    // Zonder supportsDdlAdmin geen destructieve opties; zonder backup geen Taken.
    expect(screen.queryByText('Database verwijderen…')).toBeNull()
    expect(screen.queryByText('Nieuwe objecten aanmaken…')).toBeNull()
    expect(screen.queryByText('Taken…')).toBeNull()
    // Verbinding verbreken blijft beschikbaar.
    expect(screen.getByText('Verbinding verbreken')).toBeTruthy()
  })

  it('biedt procedure-contextmenu met Uitvoeren en Eigenschappen (SAL-34)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.click(within(tree()).getByText('Programmability'))
    await waitFor(() => expect(within(tree()).getByText('Stored Procedures')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Stored Procedures'))
    await waitFor(() => expect(within(tree()).getByText('sp_rapport')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('sp_rapport'))
    await waitFor(() => expect(screen.getByText('Script Object als CREATE')).toBeTruthy())
    expect(screen.getByText('Uitvoeren…')).toBeTruthy()
    expect(screen.getByText('Eigenschappen')).toBeTruthy()

    // Uitvoeren → dialect-correcte EXEC in een nieuwe querytab.
    fireEvent.click(screen.getByText('Uitvoeren…'))
    await waitFor(() => {
      const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
      expect(editor.value).toBe('EXEC [main].[sp_rapport];')
    })
  })

  it('toont eigenschappen van een procedure via getObjectDefinition (SAL-34)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.click(within(tree()).getByText('Programmability'))
    await waitFor(() => expect(within(tree()).getByText('Stored Procedures')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Stored Procedures'))
    await waitFor(() => expect(within(tree()).getByText('sp_rapport')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('sp_rapport'))
    await waitFor(() => expect(screen.getByText('Eigenschappen')).toBeTruthy())
    fireEvent.click(screen.getByText('Eigenschappen'))
    await waitFor(() => expect(screen.getByText('Stored procedure: sp_rapport')).toBeTruthy())
    expect(screen.getByText(/CREATE TABLE/)).toBeTruthy()
  })

  it('toont database-eigenschappen in een dialoog (SAL-34)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Eigenschappen')).toBeTruthy())
    fireEvent.click(screen.getByText('Eigenschappen'))
    await waitFor(() => expect(screen.getByText('Database-eigenschappen')).toBeTruthy())
    expect(screen.getAllByText('Klanten').length).toBeGreaterThan(0)
    expect(screen.getAllByText('SQL Server').length).toBeGreaterThan(0)
  })

  it('verbreken verbinding via server-contextmenu sluit de sessie en klapt de boom in (SAL-34)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    // Verbonden server toont een groene statusindicator (🟢-equivalent).
    const serverRow = (): HTMLElement =>
      within(tree()).getByText('SQL Server').closest('.tree-node') as HTMLElement
    expect(serverRow().querySelector('.status-dot.connected')).toBeTruthy()

    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Verbinding verbreken')).toBeTruthy())
    fireEvent.click(screen.getByText('Verbinding verbreken'))

    await waitFor(() => expect((window.nvag as ReturnType<typeof createMockNvag>).closedSessions).toContain('s1'))
    expect(within(tree()).queryByText('Databases')).toBeNull()
    // SAL-43: gesloten server toont de grijze (niet-verbonden) indicator.
    expect(serverRow().querySelector('.status-dot:not(.connected)')).toBeTruthy()
  })

  it('toont een fout en klapt de boom in wanneer de backend-close faalt (SAL-43)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    // Close-IPC faalt nádat de backend de sessie al heeft opgeruimd
    // (SessionManager.close ruimt in een finally op). De UI moet niet
    // verbonden blijven staan maar de fout wél tonen.
    window.nvag.sessions.close = async () => {
      throw new Error('IPC kapot')
    }
    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Verbinding verbreken')).toBeTruthy())
    fireEvent.click(screen.getByText('Verbinding verbreken'))

    await waitFor(() => expect(within(tree()).queryByText('Databases')).toBeNull())
    expect(useAppStore.getState().openSessions['conn-sql']).toBeUndefined()
    expect(screen.getByText(/gesloten, maar het sluiten gaf een fout: IPC kapot/)).toBeTruthy()
  })

  it('toont een succesmelding bij verbreken via server-contextmenu (SAL-43)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Verbinding verbreken')).toBeTruthy())
    fireEvent.click(screen.getByText('Verbinding verbreken'))

    await waitFor(() => expect(useAppStore.getState().openSessions['conn-sql']).toBeUndefined())
    expect(within(tree()).queryByText('Databases')).toBeNull()
    expect(screen.getByText(/Verbinding \(SQL Server\) verbroken/)).toBeTruthy()
  })

  it('verbreken via database-contextmenu sluit de sessie en laat databases verdwijnen (SAL-43)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Verbinding verbreken')).toBeTruthy())
    fireEvent.click(screen.getByText('Verbinding verbreken'))

    await waitFor(() => expect((window.nvag as ReturnType<typeof createMockNvag>).closedSessions).toContain('s1'))
    expect(within(tree()).queryByText('Databases')).toBeNull()
    expect(within(tree()).queryByText('Klanten')).toBeNull()
    expect(useAppStore.getState().openSessions['conn-sql']).toBeUndefined()
    expect(screen.getByText(/Verbinding \(SQL Server\) verbroken/)).toBeTruthy()
  })

  it('biedt op een gesloten server Verbinding maken aan (geen Verbinding verbreken) en verbindt opnieuw (SAL-43)', async () => {
    const conn = sampleConnection({ id: 'conn-sql', name: 'SQL Server', providerId: 'sqlserver', database: 'master' })
    const state = { databases: [{ name: 'Klanten' }] as DatabaseInfo[] }
    const mock = createMockNvag({
      connections: [conn],
      databases: state.databases,
      capabilities: {
        supportsSchemas: true,
        supportsSequences: true,
        supportsSynonyms: true,
        supportsTriggers: true,
        supportsExecutionPlans: false,
        supportsMonitoring: false,
        supportsTransactions: true,
        supportsIdentityColumns: true,
        supportsGeneratedColumns: true,
        supportsDdlAdmin: true,
        supportsUsersAndRoles: true,
        supportsBackupRestore: true,
        maxResultRowsDefault: 1000,
        dialect: 'tsql'
      }
    })
    window.nvag = mock
    // OpenSessions is bewust leeg: opgeslagen verbinding zonder sessie.
    useAppStore.setState({ connections: [conn] })
    render(<App />)
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    await waitFor(() => expect(within(tree()).getByText('SQL Server')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Verbinding maken')).toBeTruthy())
    expect(screen.queryByText('Verbinding verbreken')).toBeNull()

    fireEvent.click(screen.getByText('Verbinding maken'))
    await waitFor(() => expect(mock.openSavedCalls).toEqual(['conn-sql']))
    await waitFor(() => expect(useAppStore.getState().openSessions['conn-sql']).toBeTruthy())

    // Server uitklappen → databases zijn weer zichtbaar.
    fireEvent.click(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(within(tree()).getByText('Databases')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Databases'))
    await waitFor(() => expect(within(tree()).getByText('Klanten')).toBeTruthy())
  })

  it('verbindt opnieuw via dubbelklik op de gesloten server-node (SAL-43)', async () => {
    openSqlServerExplorerFull()
    const mock = window.nvag as ReturnType<typeof createMockNvag>
    render(<App />)
    const tree = await expandSqlServerDb()

    // Verbreken via server-contextmenu.
    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Verbinding verbreken')).toBeTruthy())
    fireEvent.click(screen.getByText('Verbinding verbreken'))
    await waitFor(() => expect(within(tree()).queryByText('Databases')).toBeNull())

    // Dubbelklik op de gesloten server → sessie wordt opnieuw geopend.
    fireEvent.doubleClick(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(mock.openSavedCalls).toEqual(['conn-sql']))
    await waitFor(() => expect(useAppStore.getState().openSessions['conn-sql']).toBeTruthy())
    // De server stond nog uitgeklapt → Databases-folder is direct zichtbaar.
    await waitFor(() => expect(within(tree()).getByText('Databases')).toBeTruthy())
  })

  it('sluit het contextmenu bij buiten-klik en met Escape (SAL-34)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Database verwijderen…')).toBeTruthy())
    fireEvent.click(document.body)
    await waitFor(() => expect(screen.queryByText('Database verwijderen…')).toBeNull())

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Database verwijderen…')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Database verwijderen…')).toBeNull())
  })

  it('toont de statusflow Uitvoeren → Bezig… → Annuleren → Geannuleerd en laat daarna direct opnieuw uitvoeren (SAL-33)', async () => {
    window.nvag = createMockNvag({
      connections: [sampleConnection()],
      tables: ['klanten'],
      views: ['v_klanten'],
      tableMetadata: { klanten: sampleTableMetadata('klanten') },
      hangingQuerySql: ['SELECT * FROM "main"."klanten" LIMIT 100'],
      startHandler: (_executionId, emit) => {
        // Query blijft lopen (geen done) tot de gebruiker annuleert. Net als
        // de echte runner blokkeert `start` tot de uitvoering echt klaar is.
        emit({ kind: 'columns', columns: [{ name: 'id' }, { name: 'naam' }] })
        emit({ kind: 'rows', rows: [{ values: [1, 'Jan'] }] })
        return new Promise(() => {
          // nooit resolve
        })
      },
      onCancel: (_executionId, emit) => {
        // Net als de echte runner: na de provider-cancel komt done(cancelled).
        emit({ kind: 'done', rowCount: 1, durationMs: 5, cancelled: true })
      }
    })
    render(<App />)
    await expandToTables()
    fireEvent.doubleClick(screen.getByText('klanten'))
    await waitFor(() => {
      const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
      expect(editor.value).toBe('SELECT * FROM "main"."klanten" LIMIT 100')
    })

    // Uitvoeren → Bezig… met timer en actieve Annuleren-knop.
    fireEvent.click(screen.getByRole('button', { name: '▶ Uitvoeren' }))
    await waitFor(() => expect(screen.getByText(/Bezig…/)).toBeTruthy())
    const cancelButton = screen.getByRole('button', { name: /■ Annuleren/ })
    expect((cancelButton as HTMLButtonElement).disabled).toBe(false)

    // Annuleren → Geannuleerd (eindstatus) en de Uitvoeren-knop is terug.
    fireEvent.click(cancelButton)
    await waitFor(() => expect(screen.getByText(/Geannuleerd/)).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('button', { name: '▶ Uitvoeren' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /■ Annuleren/ })).toBeNull()
  })

  // ------------------------------------------------------------------ SAL-45

  it('toont "… verwijderen…" in het contextmenu van procedure/function/trigger/sequence/synonym/user/role en opent bevestiging (SAL-45)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    const expectItem = async (folder: string, object: string, item: string): Promise<void> => {
      fireEvent.click(within(tree()).getByText(folder))
      await waitFor(() => expect(within(tree()).getByText(object)).toBeTruthy())
      fireEvent.contextMenu(within(tree()).getByText(object))
      await waitFor(() => expect(screen.getByText(item)).toBeTruthy())
      // Menu sluiten (klik elders in de boom).
      fireEvent.click(within(tree()).getByText('Tables'))
      await waitFor(() => expect(screen.queryByText(item)).toBeNull())
    }

    // Programmability-folder openen voor routines/triggers.
    fireEvent.click(within(tree()).getByText('Programmability'))
    await waitFor(() => expect(within(tree()).getByText('Stored Procedures')).toBeTruthy())
    await expectItem('Stored Procedures', 'sp_rapport', 'Procedure verwijderen…')
    await expectItem('Functions', 'fn_bereken', 'Functie verwijderen…')
    await expectItem('Database Triggers', 'trg_klanten_ins', 'Trigger verwijderen…')

    // Security-folder openen voor users/roles.
    fireEvent.click(within(tree()).getByText('Security'))
    await waitFor(() => expect(within(tree()).getByText('Users')).toBeTruthy())
    await expectItem('Users', 'app_ro', 'Gebruiker verwijderen…')
    await expectItem('Roles', 'db_datareader', 'Rol verwijderen…')

    // Directe folders: synonyms + sequences.
    await expectItem('Synonyms', 'syn_oud', 'Synonym verwijderen…')
    await expectItem('Sequences', 'seq_ordernr', 'Sequence verwijderen…')

    // Bevestiging: contextmenu → verwijderen → dialoog met SQL; annuleren niets.
    // (Stored Procedures-folder is nog uitgeklapt van de item-checks.)
    fireEvent.contextMenu(within(tree()).getByText('sp_rapport'))
    await waitFor(() => expect(screen.getByText('Procedure verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Procedure verwijderen…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/DROP PROCEDURE \[main\]\.\[sp_rapport\]/)).toBeTruthy()
    expect(screen.getByText(/kan niet ongedaan worden gemaakt/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Annuleren' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(within(tree()).getByText('sp_rapport')).toBeTruthy()
    const mock = window.nvag as ReturnType<typeof createMockNvag>
    expect(mock.adminRequests.filter((r) => r.action === 'dropProcedure')).toHaveLength(0)
  })

  it('verwijdert een procedure via het contextmenu na bevestiging en ververst de folder (SAL-45)', async () => {
    const state = openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.click(within(tree()).getByText('Programmability'))
    await waitFor(() => expect(within(tree()).getByText('Stored Procedures')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Stored Procedures'))
    await waitFor(() => expect(within(tree()).getByText('sp_rapport')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('sp_rapport'))
    await waitFor(() => expect(screen.getByText('Procedure verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Procedure verwijderen…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }))

    await waitFor(() => expect(within(tree()).queryByText('sp_rapport')).toBeNull())
    expect(state.procedures.includes('sp_rapport')).toBe(false)
    expect(screen.getByText(/'sp_rapport' verwijderd/)).toBeTruthy()
    const mock = window.nvag as ReturnType<typeof createMockNvag>
    const drops = mock.adminRequests.filter((r) => r.action === 'dropProcedure')
    expect(drops.length).toBe(1)
  })

  it('toont guard-redenen bij een geblokkeerde functie-drop en voert pas na tweede bevestiging uit (SAL-45)', async () => {
    const state = openSqlServerExplorerFull(true)
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.click(within(tree()).getByText('Programmability'))
    await waitFor(() => expect(within(tree()).getByText('Functions')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Functions'))
    await waitFor(() => expect(within(tree()).getByText('fn_bereken')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('fn_bereken'))
    await waitFor(() => expect(screen.getByText('Functie verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Functie verwijderen…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }))

    await waitFor(() => expect(screen.getByText(/PROD-omgeving vereist bevestiging/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Toch verwijderen' })).toBeTruthy()
    expect(within(tree()).getByText('fn_bereken')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Toch verwijderen' }))
    await waitFor(() => expect(within(tree()).queryByText('fn_bereken')).toBeNull())
    expect(state.functions.includes('fn_bereken')).toBe(false)
    const drops = (window.nvag as ReturnType<typeof createMockNvag>).adminRequests.filter((r) => r.action === 'dropFunction')
    expect(drops.length).toBe(2)
    expect(drops[0]?.confirmed).toBeFalsy()
    expect(drops[1]?.confirmed).toBe(true)
  })

  it('biedt verwijder-items voor tabel-subobjecten (index/constraint) en ververst na bevestiging (SAL-45)', async () => {
    const state = openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    // Tabel-subfolders openen via de chevron (rijklik opent de viewer).
    fireEvent.click(within(tree()).getByText('Tables'))
    await waitFor(() => expect(within(tree()).getByText('klanten')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Tabel uitklappen' }))
    await waitFor(() => expect(within(tree()).getByText('Indexes')).toBeTruthy())
    expect(within(tree()).getByText('Constraints')).toBeTruthy()

    // Index: menu-item + bevestiging + verdwijnt uit de subfolder.
    fireEvent.click(within(tree()).getByText('Indexes'))
    await waitFor(() => expect(within(tree()).getByText('idx_klanten_naam')).toBeTruthy())
    fireEvent.contextMenu(within(tree()).getByText('idx_klanten_naam'))
    await waitFor(() => expect(screen.getByText('Index verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Index verwijderen…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/DROP INDEX \[idx_klanten_naam\] ON \[main\]\.\[klanten\]/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }))
    await waitFor(() => expect(within(tree()).queryByText('idx_klanten_naam')).toBeNull())
    expect(screen.getByText(/Index 'idx_klanten_naam' verwijderd/)).toBeTruthy()

    // Constraint: menu-item + bevestiging.
    fireEvent.click(within(tree()).getByText('Constraints'))
    await waitFor(() => expect(within(tree()).getByText('CK_leeftijd')).toBeTruthy())
    fireEvent.contextMenu(within(tree()).getByText('CK_leeftijd'))
    await waitFor(() => expect(screen.getByText('Constraint verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Constraint verwijderen…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/ALTER TABLE \[main\]\.\[klanten\] DROP CONSTRAINT \[CK_leeftijd\]/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }))
    await waitFor(() => expect(within(tree()).queryByText('CK_leeftijd')).toBeNull())
    expect(screen.getByText(/Constraint 'CK_leeftijd' verwijderd/)).toBeTruthy()

    const mock = window.nvag as ReturnType<typeof createMockNvag>
    expect(mock.adminRequests.some((r) => r.action === 'dropIndex')).toBe(true)
    expect(mock.adminRequests.some((r) => r.action === 'dropConstraint')).toBe(true)
    expect(state.tables).toEqual(['klanten'])
  })

  it('verwijdert een opgeslagen verbinding via het server-contextmenu na bevestiging (SAL-45)', async () => {
    const connSql = sampleConnection({ id: 'conn-sql', name: 'SQL Server', providerId: 'sqlserver', database: 'master' })
    const connOther = sampleConnection({ id: 'conn-other', name: 'Andere server', providerId: 'sqlserver', database: 'master' })
    const mock = createMockNvag({
      connections: [connSql, connOther],
      databases: [{ name: 'Klanten' }],
      capabilities: {
        supportsSchemas: true,
        supportsSequences: false,
        supportsSynonyms: false,
        supportsTriggers: true,
        supportsExecutionPlans: false,
        supportsMonitoring: false,
        supportsTransactions: true,
        supportsIdentityColumns: true,
        supportsGeneratedColumns: true,
        supportsDdlAdmin: true,
        supportsUsersAndRoles: true,
        supportsBackupRestore: true,
        maxResultRowsDefault: 1000,
        dialect: 'tsql'
      }
    })
    window.nvag = mock
    useAppStore.setState({
      connections: [connSql, connOther],
      openSessions: {
        'conn-sql': {
          config: connSql,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlserver', providerName: 'SQL Server', serverVersion: '17', currentDatabase: 'master' }
        }
      }
    })
    render(<App />)
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    await waitFor(() => expect(within(tree()).getByText('SQL Server')).toBeTruthy())
    expect(within(tree()).getByText('Andere server')).toBeTruthy()

    // Annuleren doet niets.
    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Verwijderen…'))
    await waitFor(() => expect(screen.getByText(/Opgeslagen verbinding 'SQL Server' verwijderen\?/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Annuleren' }))
    await waitFor(() => expect(screen.queryByText(/Opgeslagen verbinding 'SQL Server' verwijderen\?/)).toBeNull())
    expect(within(tree()).getByText('SQL Server')).toBeTruthy()
    expect(mock.savedConfigs.some((c) => c.id === 'conn-sql')).toBe(true)

    // Bevestigen verwijdert de opgeslagen verbinding + sluit de sessie;
    // de andere connectie blijft onaangetast.
    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Verwijderen…')).toBeTruthy())
    fireEvent.click(screen.getByText('Verwijderen…'))
    await waitFor(() => expect(screen.getByText(/Opgeslagen verbinding 'SQL Server' verwijderen\?/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Verwijderen' }))

    await waitFor(() => expect(within(tree()).queryByText('SQL Server')).toBeNull())
    expect(within(tree()).getByText('Andere server')).toBeTruthy()
    expect(mock.savedConfigs.some((c) => c.id === 'conn-sql')).toBe(false)
    expect(mock.savedConfigs.some((c) => c.id === 'conn-other')).toBe(true)
    expect(mock.closedSessions).toContain('s1')
    expect(useAppStore.getState().openSessions['conn-sql']).toBeUndefined()
    expect(useAppStore.getState().openSessions['conn-other']).toBeUndefined()
    expect(screen.getByText(/Opgeslagen verbinding 'SQL Server' verwijderd/)).toBeTruthy()
  })

  it('verbergt verwijder-items wanneer supportsDdlAdmin of de capability ontbreekt (SAL-45)', async () => {
    const conn = sampleConnection({ id: 'conn-min', name: 'Minimaal', providerId: 'sqlserver', database: 'master' })
    window.nvag = createMockNvag({
      connections: [conn],
      databases: [{ name: 'Klanten' }],
      procedures: ['sp_verborgen'],
      synonyms: ['syn_verborgen'],
      users: ['app_verborgen'],
      capabilities: {
        supportsSchemas: true,
        supportsSequences: false,
        supportsSynonyms: false,
        supportsTriggers: true,
        supportsExecutionPlans: false,
        supportsMonitoring: false,
        supportsTransactions: true,
        supportsIdentityColumns: true,
        supportsGeneratedColumns: true,
        supportsDdlAdmin: false,
        supportsUsersAndRoles: false,
        supportsBackupRestore: false,
        maxResultRowsDefault: 1000,
        dialect: 'tsql'
      }
    })
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-min': {
          config: conn,
          sessionId: 's-min',
          serverInfo: { providerId: 'sqlserver', providerName: 'SQL Server', serverVersion: '17', currentDatabase: 'master' }
        }
      }
    })
    render(<App />)
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    fireEvent.click(within(tree()).getByText('Minimaal'))
    await waitFor(() => expect(within(tree()).getByText('Databases')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Databases'))
    await waitFor(() => expect(within(tree()).getByText('Klanten')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(within(tree()).getByText('Programmability')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Programmability'))
    await waitFor(() => expect(within(tree()).getByText('Stored Procedures')).toBeTruthy())
    fireEvent.click(within(tree()).getByText('Stored Procedures'))
    await waitFor(() => expect(within(tree()).getByText('sp_verborgen')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('sp_verborgen'))
    await waitFor(() => expect(screen.getByText('Script Object als CREATE')).toBeTruthy())
    expect(screen.queryByText('Procedure verwijderen…')).toBeNull()
    // Zonder supportsSynonyms/UsersAndRoles geen folders/items.
    expect(within(tree()).queryByText('Synonyms')).toBeNull()
    expect(within(tree()).queryByText('Users')).toBeNull()
  })
})
