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
  fireEvent.click(await screen.findByTitle('New connection'))
  const nameInput = screen.getByLabelText('Name') as HTMLInputElement
  const pathInput = screen.getByLabelText('Database path (host)') as HTMLInputElement
  fireEvent.change(nameInput, { target: { value: 'Klantendatabase' } })
  fireEvent.change(pathInput, { target: { value: '/tmp/klanten.db' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save & Connect' }))

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
    fireEvent.click(await screen.findByTitle('New connection'))
    expect(screen.getByText('Create the file when it does not exist')).toBeTruthy()
  })

  it('toont objecteigenschappen per objecttype in de Object Viewer (F1-5)', async () => {
    render(<App />)
    await expandToTables()
    fireEvent.click(screen.getByText('klanten'))
    await waitFor(() => expect(screen.getByText('Table: klanten')).toBeTruthy())
    // Algemeen: eigenschappen
    expect(await screen.findByText('Rows')).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Columns' })).toBeTruthy()
    // Kolommen-sectie
    fireEvent.click(screen.getByRole('tab', { name: 'Columns' }))
    expect(screen.getByText(/id 🔑/)).toBeTruthy()
    expect(screen.getByText('naam')).toBeTruthy()
    expect(screen.getAllByText('TEXT').length).toBeGreaterThan(0)
    // Definitie-sectie toont de CREATE
    fireEvent.click(screen.getByRole('tab', { name: 'Definition' }))
    expect(await screen.findByText(/CREATE TABLE/)).toBeTruthy()
  })

  it('opent Script-as-tabbladen met dialect-correcte SQL (F1-5)', async () => {
    render(<App />)
    await expandToTables()
    fireEvent.click(screen.getByText('klanten'))
    await waitFor(() => expect(screen.getByText('Table: klanten')).toBeTruthy())

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

    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }))
    await waitFor(() => expect(screen.getByText('Jan')).toBeTruthy())
    expect(screen.getByText('NULL')).toBeTruthy()
    expect(screen.getByText(/2 row\(s\) in 3 ms/)).toBeTruthy()
  })

  it('wisselt tussen Resultaten- en Berichten-tabbladen (SAL-11)', async () => {
    render(<App />)
    await expandToTables()
    fireEvent.doubleClick(screen.getByText('klanten'))

    const editor = screen.getByTestId('query-editor') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'SELECT FOUT;' } })
    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }))

    // Resultaten-tab toont de fout (ook in de statusbalk)
    await waitFor(() =>
      expect(screen.getAllByText(/near "FOUT": syntax error/).length).toBeGreaterThanOrEqual(1)
    )
    // Berichten-tab toont het foutbericht
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }))
    expect(screen.getAllByText(/Error: near "FOUT": syntax error/).length).toBeGreaterThanOrEqual(1)
    // Terug naar Resultaten
    fireEvent.click(screen.getByRole('tab', { name: 'Results' }))
    expect(screen.getAllByText(/near "FOUT": syntax error/).length).toBeGreaterThanOrEqual(1)
  })

  it('toont de statusbalk met verbindings- en query-status (SAL-11)', async () => {
    render(<App />)
    await expandToTables()
    // Dubbelklik opent een tab mét verbinding → statusbalk toont de sessie
    fireEvent.doubleClick(screen.getByText('klanten'))
    await waitFor(() => expect(screen.getByText(/Connected: Klantendatabase/)).toBeTruthy())
    expect(screen.getByText(/SQLite 3\.53\.1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }))
    await waitFor(() => expect(screen.getByText(/Query completed — 2 row\(s\) in 3 ms/)).toBeTruthy())
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

    const dbSelect = (await screen.findByTitle('Database of this tab')) as HTMLSelectElement
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
      'Connected server of this tab (selecting opens the session)'
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
      'Connected server of this tab (selecting opens the session)'
    ) as HTMLSelectElement
    fireEvent.change(connSelect, { target: { value: 'conn-b' } })

    await waitFor(() => expect(screen.getByText(/file not found/)).toBeTruthy())
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
        within(tree()).getByText(/Failed to load data: The server principal 'sa' is not able to access the database 'Klanten'/)
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
    const refresh = screen.getByRole('button', { name: 'Refresh databases' }) as HTMLButtonElement
    expect(refresh.disabled).toBe(true)
  })

  it('refresh-knop herlaadt de databaselijst: nieuwe db verschijnt, verwijderde verdwijnt (SAL-31)', async () => {
    const { databases } = openSqlServerExplorer()
    render(<App />)
    await expandDatabasesFolder()

    // Server-side wijziging: nieuwe database aangemaakt buiten Nvag om
    databases.push({ name: 'NieuweTestDB' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh databases' }))
    await waitFor(() => expect(screen.getByText('NieuweTestDB')).toBeTruthy())
    expect(screen.getByText('Klanten')).toBeTruthy()

    // Verwijderde database verdwijnt na een nieuwe refresh
    const idx = databases.findIndex((d) => d.name === 'Klanten')
    databases.splice(idx, 1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh databases' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Refresh databases' }))
    await waitFor(() =>
      expect(screen.getByText(/Failed to load data: Kan databases niet bereiken/)).toBeTruthy()
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
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NieuweTestDB' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

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
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Klanten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

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
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Collapse table' }))
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
    fireEvent.click(within(tree()).getByRole('button', { name: 'Refresh Tables' }))
    await waitFor(() => expect(within(tree()).getByText('nieuwe_tabel')).toBeTruthy())
    expect(within(tree()).getByText('klanten')).toBeTruthy()

    // Verwijderde tabel verdwijnt na een nieuwe refresh
    const idx = state.tables.indexOf('klanten')
    state.tables.splice(idx, 1)
    fireEvent.click(within(tree()).getByRole('button', { name: 'Refresh Tables' }))
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
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }))
    fireEvent.change(screen.getByPlaceholderText('name'), { target: { value: 'nieuwe_tabel' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    // Object Explorer herlaadt de geopende Tables-folder automatisch
    await waitFor(() => expect(within(tree()).getByText('nieuwe_tabel')).toBeTruthy())
    expect(screen.getByText(/✅ CREATE TABLE nieuwe_tabel/)).toBeTruthy()
  })

  it('toont een contextmenu per objecttype met refresh en Script Object (SAL-32)', async () => {
    render(<App />)
    await expandToTables()

    fireEvent.contextMenu(screen.getByText('klanten'))
    await waitFor(() => expect(screen.getByText('Refresh')).toBeTruthy())
    expect(screen.getByText('View table data')).toBeTruthy()
    expect(screen.getByText('Properties')).toBeTruthy()
    expect(screen.getByText('Script Object as CREATE')).toBeTruthy()
    expect(screen.getByText('Script Object as SELECT')).toBeTruthy()

    // Script Object als CREATE opent een querytab met de gegenereerde CREATE TABLE
    fireEvent.click(screen.getByText('Script Object as CREATE'))
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
    await waitFor(() => expect(screen.getByText('New query')).toBeTruthy())
    expect(screen.getByText('Refresh')).toBeTruthy()
    expect(screen.getByText('Properties')).toBeTruthy()
    expect(screen.getByText('Generate scripts')).toBeTruthy()
    expect(screen.getByText('Create new objects…')).toBeTruthy()
    expect(screen.getByText('Tasks…')).toBeTruthy()
    expect(screen.getByText('Disconnect')).toBeTruthy()
    expect(screen.getByText('Drop database…')).toBeTruthy()

    // Scripts genereren → dialect-correcte CREATE DATABASE in een nieuwe querytab.
    fireEvent.click(screen.getByText('Generate scripts'))
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
    await waitFor(() => expect(screen.getByText('Create new objects…')).toBeTruthy())
    fireEvent.click(screen.getByText('Create new objects…'))
    await waitFor(() => expect(screen.getByText(/Database Administration/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByText(/Database Administration/)).toBeNull())

    // "Taken…" → AdminDialog op de Backup-tab (capability-gated via supportsBackupRestore).
    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Tasks…')).toBeTruthy())
    fireEvent.click(screen.getByText('Tasks…'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create backup' })).toBeTruthy())
  })

  it('verwijdert een database alleen na expliciete bevestiging; annuleren doet niets (SAL-34)', async () => {
    const state = openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Drop database…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop database…'))

    // Bevestigingsdialoog toont de destructieve SQL.
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/cannot be undone/)).toBeTruthy()
    expect(screen.getByText(/DROP DATABASE \[Klanten\]/)).toBeTruthy()

    // Annuleren: niets destructiefs, database blijft bestaan.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(within(tree()).getByText('Klanten')).toBeTruthy()

    // Opnieuw openen en wél bevestigen → database verdwijnt na refresh.
    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Drop database…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop database…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(within(tree()).queryByText('Klanten')).toBeNull())
    expect(state.databases.some((d) => d.name === 'Klanten')).toBe(false)
    expect(screen.getByText(/Database 'Klanten' removed/)).toBeTruthy()
  })

  it('toont guard-redenen bij een geblokkeerde database-drop en voert pas na tweede bevestiging uit (SAL-34)', async () => {
    const state = openSqlServerExplorerFull(true)
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Drop database…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop database…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    // Guard-blokkade: redenen + tweede bevestiging.
    await waitFor(() => expect(screen.getByText(/PROD environment requires confirmation/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Delete anyway' })).toBeTruthy()
    expect(within(tree()).getByText('Klanten')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))
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
    await waitFor(() => expect(screen.getByText('Drop table…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop table…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/DROP TABLE \[main\].\[klanten\]/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(within(tree()).queryByText('klanten')).toBeNull())
    expect(state.tables.includes('klanten')).toBe(false)
    expect(screen.getByText(/'klanten' removed/)).toBeTruthy()
  })

  it('geeft bij DROP uit het contextmenu de database van de node door (SAL-51)', async () => {
    openSqlServerExplorerFull()
    const api = window.nvag as ReturnType<typeof createMockNvag>
    const dropTable = vi.fn(
      async (_connId: string, _db: string, _schema: string, _table: string, _confirmed?: boolean) => ({
        ok: true,
        sql: 'DROP TABLE [dbo].[klanten];'
      })
    )
    api.admin.dropTable = dropTable

    render(<App />)
    const tree = await expandSqlServerDb()
    fireEvent.click(within(tree()).getByText('Tables'))
    await waitFor(() => expect(within(tree()).getByText('klanten')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('klanten'))
    await waitFor(() => expect(screen.getByText('Drop table…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop table…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(dropTable).toHaveBeenCalled())
    // De drop gaat naar de database van de node (Klanten), niet naar master.
    expect(dropTable.mock.calls[0]?.[1]).toBe('Klanten')
  })

  it('biedt folder-contextmenu\'s met "Nieuwe X aanmaken…" die de AdminDialog op de juiste tab openen (SAL-34)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    // Tables-folder → Nieuwe tabel… → AdminDialog op de Tabellen-tab.
    fireEvent.contextMenu(within(tree()).getByText('Tables'))
    await waitFor(() => expect(screen.getByText('New table…')).toBeTruthy())
    fireEvent.click(screen.getByText('New table…'))
    await waitFor(() => expect(screen.getByText(/Database Administration/)).toBeTruthy())
    expect(screen.getByRole('tab', { name: 'Tables' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByPlaceholderText('name')).toBeTruthy()
    // SAL-51: de database van de folder (Klanten) is de doeldatabase van de dialoog.
    expect((screen.getByLabelText('Target database') as HTMLSelectElement).value).toBe('Klanten')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByText(/Database Administration/)).toBeNull())

    // Views-folder → Nieuwe view… → AdminDialog op de Views-tab.
    fireEvent.contextMenu(within(tree()).getByText('Views'))
    await waitFor(() => expect(screen.getByText('New view…')).toBeTruthy())
    fireEvent.click(screen.getByText('New view…'))
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
    await waitFor(() => expect(screen.getByText('New query')).toBeTruthy())
    // Zonder supportsDdlAdmin geen destructieve opties; zonder backup geen Taken.
    expect(screen.queryByText('Drop database…')).toBeNull()
    expect(screen.queryByText('Create new objects…')).toBeNull()
    expect(screen.queryByText('Tasks…')).toBeNull()
    // Verbinding verbreken blijft beschikbaar.
    expect(screen.getByText('Disconnect')).toBeTruthy()
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
    await waitFor(() => expect(screen.getByText('Script Object as CREATE')).toBeTruthy())
    expect(screen.getByText('Run…')).toBeTruthy()
    expect(screen.getByText('Properties')).toBeTruthy()

    // Uitvoeren → dialect-correcte EXEC in een nieuwe querytab.
    fireEvent.click(screen.getByText('Run…'))
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
    await waitFor(() => expect(screen.getByText('Properties')).toBeTruthy())
    fireEvent.click(screen.getByText('Properties'))
    await waitFor(() => expect(screen.getByText('Stored procedure: sp_rapport')).toBeTruthy())
    expect(screen.getByText(/CREATE TABLE/)).toBeTruthy()
  })

  it('toont database-eigenschappen in een dialoog (SAL-34/SAL-50)', async () => {
    openSqlServerExplorerFull()
    // SAL-50: de eigenschappen komen live via admin.getDatabaseProperties.
    const mock = window.nvag as ReturnType<typeof createMockNvag>
    mock.admin.getDatabaseProperties = async (_connId: string, database: string) => ({
      database,
      dialect: 'tsql',
      supportsAlter: true,
      properties: [
        { key: 'name', label: 'Name', kind: 'text', value: database, editable: true, renamesDatabase: true },
        {
          key: 'recovery',
          label: 'Recovery model',
          kind: 'select',
          value: 'FULL',
          editable: true,
          options: [
            { value: 'FULL', label: 'Full (FULL)' },
            { value: 'SIMPLE', label: 'Simple (SIMPLE)' }
          ]
        },
        { key: 'collation', label: 'Collation', kind: 'info', value: 'SQL_Latin1_General_CP1_CI_AS', editable: false }
      ]
    })
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Properties')).toBeTruthy())
    fireEvent.click(screen.getByText('Properties'))
    await waitFor(() => expect(screen.getByText('Database properties: Klanten')).toBeTruthy())
    expect(screen.getAllByText('SQL Server').length).toBeGreaterThan(0)
    // Read-only-info (collation) + bewerkbare velden (recovery).
    expect(screen.getByText('SQL_Latin1_General_CP1_CI_AS')).toBeTruthy()
    expect((screen.getByLabelText('Recovery model') as HTMLSelectElement).value).toBe('FULL')
  })

  // ------------------------------------------------------------------ SAL-50

  it('biedt Bewerken… aan op een server-node en opent de dialoog met huidige waarden (SAL-50)', async () => {
    openSqlServerExplorerFull()
    const mock = window.nvag as ReturnType<typeof createMockNvag>
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Edit…')).toBeTruthy())
    fireEvent.click(screen.getByText('Edit…'))

    // De bestaande ConnectionDialog in edit-modus met de huidige config.
    await waitFor(() => expect(screen.getByText('Edit connection')).toBeTruthy())
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement
    expect(nameInput.value).toBe('SQL Server')
    expect(screen.getByLabelText('Host')).toBeTruthy()
    expect(screen.getByLabelText('Environment')).toBeTruthy()

    // Naam wijzigen + opslaan → opgeslagen config wordt bijgewerkt en de
    // open sessie wordt herbouwd met de nieuwe instellingen.
    fireEvent.change(nameInput, { target: { value: 'SQL Server (nieuw)' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mock.savedConfigs.find((c) => c.id === 'conn-sql')?.name).toBe('SQL Server (nieuw)'))
    await waitFor(() => expect(mock.closedSessions).toContain('s1'))
    await waitFor(() => expect(mock.openSavedCalls).toEqual(['conn-sql']))
    await waitFor(() => expect(useAppStore.getState().openSessions['conn-sql']).toBeTruthy())
    // De boom toont de nieuwe servernaam.
    await waitFor(() => expect(within(tree()).getByText('SQL Server (nieuw)')).toBeTruthy())
  })

  it('bewerkt een gesloten verbinding zonder sessie te openen (SAL-50)', async () => {
    const conn = sampleConnection({ id: 'conn-sql', name: 'SQL Server', providerId: 'sqlserver', database: 'master' })
    const mock = createMockNvag({
      connections: [conn],
      databases: [{ name: 'Klanten' }]
    })
    window.nvag = mock
    // Bewust géén open sessie: een opgeslagen maar gesloten verbinding.
    useAppStore.setState({ connections: [conn] })
    render(<App />)
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    await waitFor(() => expect(within(tree()).getByText('SQL Server')).toBeTruthy())

    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Edit…')).toBeTruthy())
    fireEvent.click(screen.getByText('Edit…'))
    await waitFor(() => expect(screen.getByText('Edit connection')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'SQL Server hernoemd' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(mock.savedConfigs.find((c) => c.id === 'conn-sql')?.name).toBe('SQL Server hernoemd'))
    // Geen sessie geopend (was niet verbonden); geen close/openSaved-calls.
    expect(useAppStore.getState().openSessions['conn-sql']).toBeUndefined()
    expect(mock.closedSessions).toEqual([])
    expect(mock.openSavedCalls).toEqual([])
    expect(within(tree()).getByText('SQL Server hernoemd')).toBeTruthy()
  })

  it('wijzigt database-eigenschappen via ALTER DATABASE met SQL-preview + guard-bevestiging (SAL-50)', async () => {
    openSqlServerExplorerFull(true)
    const mock = window.nvag as ReturnType<typeof createMockNvag>
    mock.admin.getDatabaseProperties = async (_connId: string, database: string) => ({
      database,
      dialect: 'tsql',
      supportsAlter: true,
      properties: [
        { key: 'name', label: 'Name', kind: 'text', value: database, editable: true, renamesDatabase: true },
        {
          key: 'recovery',
          label: 'Recovery model',
          kind: 'select',
          value: 'FULL',
          editable: true,
          options: [
            { value: 'FULL', label: 'Full (FULL)' },
            { value: 'SIMPLE', label: 'Simple (SIMPLE)' },
            { value: 'BULK_LOGGED', label: 'Bulk-logged (BULK_LOGGED)' }
          ]
        },
        { key: 'collation', label: 'Collation', kind: 'info', value: 'Dutch_CI_AS', editable: false }
      ]
    })
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Properties')).toBeTruthy())
    fireEvent.click(screen.getByText('Properties'))
    await waitFor(() => expect(screen.getByText('Database properties: Klanten')).toBeTruthy())

    // Recovery-model wijzigen naar SIMPLE.
    const recovery = (await screen.findByLabelText('Recovery model')) as HTMLSelectElement
    fireEvent.change(recovery, { target: { value: 'SIMPLE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    // Guard-blokkade: SQL-preview + redenen tonen (geen uitvoering zonder bevestiging).
    await waitFor(() => expect(screen.getByText(/ALTER DATABASE \[Klanten\] SET RECOVERY SIMPLE/)).toBeTruthy())
    expect(screen.getByText(/PROD environment requires confirmation/)).toBeTruthy()

    const altersBefore = mock.adminRequests.filter((r) => r.action === 'alterDatabase')
    expect(altersBefore.length).toBe(1)
    expect(altersBefore[0]?.confirmed).toBeFalsy()

    // Tweede, expliciete bevestiging → ALTER wordt uitgevoerd.
    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }))
    await waitFor(() => expect(screen.getByText(/Properties changed/)).toBeTruthy())

    const alters = mock.adminRequests.filter((r) => r.action === 'alterDatabase')
    expect(alters.length).toBe(2)
    expect(alters[0]?.confirmed).toBeFalsy()
    expect(alters[1]?.confirmed).toBe(true)
    expect(alters[1]?.args[1]).toBe('Klanten')
  })

  it('toont een SSMS-achtig overzicht: Algemeen/Opties-secties en bestandspaden náást bewerkbare velden (SAL-50)', async () => {
    openSqlServerExplorerFull()
    const mock = window.nvag as ReturnType<typeof createMockNvag>
    mock.admin.getDatabaseProperties = async (_connId: string, database: string) => ({
      database,
      dialect: 'tsql',
      supportsAlter: true,
      properties: [
        { key: 'name', label: 'Name', kind: 'text', value: database, editable: true, renamesDatabase: true },
        { key: 'state', label: 'Status', kind: 'info', value: 'ONLINE', editable: false, section: 'algemeen' },
        { key: 'collation', label: 'Collation', kind: 'info', value: 'Dutch_CI_AS', editable: false, section: 'algemeen' },
        { key: 'create_date', label: 'Created on', kind: 'info', value: '2024-01-15T08:30:00.000Z', editable: false, section: 'algemeen' },
        {
          key: 'recovery',
          label: 'Recovery model',
          kind: 'select',
          value: 'FULL',
          editable: true,
          options: [
            { value: 'FULL', label: 'Full (FULL)' },
            { value: 'SIMPLE', label: 'Simple (SIMPLE)' }
          ]
        },
        { key: 'auto_close', label: 'Auto close', kind: 'info', value: 'No', editable: false, section: 'opties' },
        { key: 'auto_shrink', label: 'Auto shrink', kind: 'info', value: 'No', editable: false, section: 'opties' },
        { key: 'page_verify', label: 'Page verification', kind: 'info', value: 'CHECKSUM', editable: false, section: 'opties' }
      ],
      files: [
        {
          name: 'Klanten',
          type: 'ROWS',
          physicalName: '/var/opt/mssql/data/Klanten.mdf',
          sizeMb: 5,
          maxSizeMb: null,
          growthMb: 1
        },
        {
          name: 'Klanten_log',
          type: 'LOG',
          physicalName: '/var/opt/mssql/data/Klanten_log.ldf',
          sizeMb: 2,
          maxSizeMb: 10,
          growthMb: null
        }
      ]
    })
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Properties')).toBeTruthy())
    fireEvent.click(screen.getByText('Properties'))
    await waitFor(() => expect(screen.getByText('Database properties: Klanten')).toBeTruthy())

    // Secties + read-only-waarden uit de server.
    expect(screen.getByText('General')).toBeTruthy()
    expect(screen.getByText('Dutch_CI_AS')).toBeTruthy()
    expect(screen.getByText('Options')).toBeTruthy()
    expect(screen.getAllByText('No').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('CHECKSUM')).toBeTruthy()

    // Bestanden-tabel met paden/groottes.
    expect(screen.getByText('Files')).toBeTruthy()
    expect(screen.getByText('/var/opt/mssql/data/Klanten.mdf')).toBeTruthy()
    expect(screen.getByText('/var/opt/mssql/data/Klanten_log.ldf')).toBeTruthy()
    expect(screen.getByText('ROWS')).toBeTruthy()
    expect(screen.getByText('Unlimited')).toBeTruthy()

    // Bewerkbare velden blijven beschikbaar (ALTER).
    expect((screen.getByLabelText('Recovery model') as HTMLSelectElement).value).toBe('FULL')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()
  })

  it('toont niet-ondersteunde providers netjes read-only in de eigenschappen-dialoog (SAL-50)', async () => {
    render(<App />)
    await connectViaDialog()
    // SQLite → database-node 'main' zonder ALTER-support.
    const tree = (): HTMLElement => document.querySelector('.tree') as HTMLElement
    fireEvent.click(within(tree()).getByText('Databases'))
    await waitFor(() => expect(within(tree()).getAllByText('main').length).toBeGreaterThan(0))

    fireEvent.contextMenu(within(tree()).getAllByText('main')[0]!)
    await waitFor(() => expect(screen.getByText('Properties')).toBeTruthy())
    fireEvent.click(screen.getByText('Properties'))
    await waitFor(() => expect(screen.getByText(/SQLite databases are files/)).toBeTruthy())
    // Geen bewerkbare velden / geen opslaan-knop voor niet-ondersteunde provider.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
  })

  it('werkt een MODIFY NAME door in de dialoog, boom en tab-context (SAL-50)', async () => {
    const state = openSqlServerExplorerFull()
    const mock = window.nvag as ReturnType<typeof createMockNvag>
    mock.admin.getDatabaseProperties = async (_connId: string, database: string) => ({
      database,
      dialect: 'tsql',
      supportsAlter: true,
      properties: [
        { key: 'name', label: 'Name', kind: 'text', value: database, editable: true, renamesDatabase: true }
      ]
    })
    // ALTER met naamswijziging werkt ook de databaselijst van de mock bij,
    // zodat de boom na de dbListRevision-refresh de nieuwe naam toont.
    mock.admin.alterDatabase = async (_connId: string, database: string, changes: Record<string, string>) => {
      if (changes.name) {
        const i = state.databases.findIndex((d) => d.name === database)
        if (i >= 0) state.databases[i] = { name: changes.name }
      }
      return {
        ok: true,
        sql: `ALTER DATABASE [${database}] MODIFY NAME = [${changes.name}];`,
        ...(changes.name ? { renamedTo: changes.name } : {})
      }
    }
    useAppStore.getState().addTab({ connectionId: 'conn-sql', database: 'Klanten' })
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Properties')).toBeTruthy())
    fireEvent.click(screen.getByText('Properties'))
    await waitFor(() => expect(screen.getByText('Database properties: Klanten')).toBeTruthy())

    const nameInput = (await screen.findByLabelText('Name')) as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'Klanten2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    // Dialoog toont de nieuwe naam na de refresh; boom + tab-context volgen.
    await waitFor(() => expect(screen.getByText('Database properties: Klanten2')).toBeTruthy())
    await waitFor(() => expect(within(tree()).getByText('Klanten2')).toBeTruthy())
    const tab = useAppStore.getState().tabs.find((t) => t.database === 'Klanten2')
    expect(tab).toBeTruthy()
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
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    fireEvent.click(screen.getByText('Disconnect'))

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
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    fireEvent.click(screen.getByText('Disconnect'))

    await waitFor(() => expect(within(tree()).queryByText('Databases')).toBeNull())
    expect(useAppStore.getState().openSessions['conn-sql']).toBeUndefined()
    expect(screen.getByText(/Connection \(SQL Server\) closed, but closing returned an error: IPC kapot/)).toBeTruthy()
  })

  it('toont een succesmelding bij verbreken via server-contextmenu (SAL-43)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    fireEvent.click(screen.getByText('Disconnect'))

    await waitFor(() => expect(useAppStore.getState().openSessions['conn-sql']).toBeUndefined())
    expect(within(tree()).queryByText('Databases')).toBeNull()
    expect(screen.getByText(/Connection \(SQL Server\) disconnected/)).toBeTruthy()
  })

  it('verbreken via database-contextmenu sluit de sessie en laat databases verdwijnen (SAL-43)', async () => {
    openSqlServerExplorerFull()
    render(<App />)
    const tree = await expandSqlServerDb()

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    fireEvent.click(screen.getByText('Disconnect'))

    await waitFor(() => expect((window.nvag as ReturnType<typeof createMockNvag>).closedSessions).toContain('s1'))
    expect(within(tree()).queryByText('Databases')).toBeNull()
    expect(within(tree()).queryByText('Klanten')).toBeNull()
    expect(useAppStore.getState().openSessions['conn-sql']).toBeUndefined()
    expect(screen.getByText(/Connection \(SQL Server\) disconnected/)).toBeTruthy()
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
    await waitFor(() => expect(screen.getByText('Connect')).toBeTruthy())
    expect(screen.queryByText('Disconnect')).toBeNull()

    fireEvent.click(screen.getByText('Connect'))
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
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())
    fireEvent.click(screen.getByText('Disconnect'))
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
    await waitFor(() => expect(screen.getByText('Drop database…')).toBeTruthy())
    fireEvent.click(document.body)
    await waitFor(() => expect(screen.queryByText('Drop database…')).toBeNull())

    fireEvent.contextMenu(within(tree()).getByText('Klanten'))
    await waitFor(() => expect(screen.getByText('Drop database…')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Drop database…')).toBeNull())
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
    fireEvent.click(screen.getByRole('button', { name: '▶ Run' }))
    await waitFor(() => expect(screen.getByText(/Running…/)).toBeTruthy())
    const cancelButton = screen.getByRole('button', { name: /■ Cancel/ })
    expect((cancelButton as HTMLButtonElement).disabled).toBe(false)

    // Annuleren → Geannuleerd (eindstatus) en de Uitvoeren-knop is terug.
    fireEvent.click(cancelButton)
    await waitFor(() => expect(screen.getByText(/Cancelled/)).toBeTruthy())
    await waitFor(() => expect(screen.getByRole('button', { name: '▶ Run' })).toBeTruthy())
    expect(screen.queryByRole('button', { name: /■ Cancel/ })).toBeNull()
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
    await expectItem('Stored Procedures', 'sp_rapport', 'Drop procedure…')
    await expectItem('Functions', 'fn_bereken', 'Drop function…')
    await expectItem('Database Triggers', 'trg_klanten_ins', 'Drop trigger…')

    // Security-folder openen voor users/roles.
    fireEvent.click(within(tree()).getByText('Security'))
    await waitFor(() => expect(within(tree()).getByText('Users')).toBeTruthy())
    await expectItem('Users', 'app_ro', 'Drop user…')
    await expectItem('Roles', 'db_datareader', 'Drop role…')

    // Directe folders: synonyms + sequences.
    await expectItem('Synonyms', 'syn_oud', 'Drop synonym…')
    await expectItem('Sequences', 'seq_ordernr', 'Drop sequence…')

    // Bevestiging: contextmenu → verwijderen → dialoog met SQL; annuleren niets.
    // (Stored Procedures-folder is nog uitgeklapt van de item-checks.)
    fireEvent.contextMenu(within(tree()).getByText('sp_rapport'))
    await waitFor(() => expect(screen.getByText('Drop procedure…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop procedure…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/DROP PROCEDURE \[main\]\.\[sp_rapport\]/)).toBeTruthy()
    expect(screen.getByText(/cannot be undone/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
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
    await waitFor(() => expect(screen.getByText('Drop procedure…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop procedure…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(within(tree()).queryByText('sp_rapport')).toBeNull())
    expect(state.procedures.includes('sp_rapport')).toBe(false)
    expect(screen.getByText(/'sp_rapport' removed/)).toBeTruthy()
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
    await waitFor(() => expect(screen.getByText('Drop function…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop function…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.getByText(/PROD environment requires confirmation/)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Delete anyway' })).toBeTruthy()
    expect(within(tree()).getByText('fn_bereken')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Expand table' }))
    await waitFor(() => expect(within(tree()).getByText('Indexes')).toBeTruthy())
    expect(within(tree()).getByText('Constraints')).toBeTruthy()

    // Index: menu-item + bevestiging + verdwijnt uit de subfolder.
    fireEvent.click(within(tree()).getByText('Indexes'))
    await waitFor(() => expect(within(tree()).getByText('idx_klanten_naam')).toBeTruthy())
    fireEvent.contextMenu(within(tree()).getByText('idx_klanten_naam'))
    await waitFor(() => expect(screen.getByText('Drop index…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop index…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/DROP INDEX \[idx_klanten_naam\] ON \[main\]\.\[klanten\]/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(within(tree()).queryByText('idx_klanten_naam')).toBeNull())
    expect(screen.getByText(/Index 'idx_klanten_naam' removed/)).toBeTruthy()

    // Constraint: menu-item + bevestiging.
    fireEvent.click(within(tree()).getByText('Constraints'))
    await waitFor(() => expect(within(tree()).getByText('CK_leeftijd')).toBeTruthy())
    fireEvent.contextMenu(within(tree()).getByText('CK_leeftijd'))
    await waitFor(() => expect(screen.getByText('Drop constraint…')).toBeTruthy())
    fireEvent.click(screen.getByText('Drop constraint…'))
    await waitFor(() => expect(screen.getByRole('alertdialog')).toBeTruthy())
    expect(screen.getByText(/ALTER TABLE \[main\]\.\[klanten\] DROP CONSTRAINT \[CK_leeftijd\]/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(within(tree()).queryByText('CK_leeftijd')).toBeNull())
    expect(screen.getByText(/Constraint 'CK_leeftijd' removed/)).toBeTruthy()

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
    await waitFor(() => expect(screen.getByText('Delete…')).toBeTruthy())
    fireEvent.click(screen.getByText('Delete…'))
    await waitFor(() => expect(screen.getByText(/Delete saved connection 'SQL Server'\?/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText(/Delete saved connection 'SQL Server'\?/)).toBeNull())
    expect(within(tree()).getByText('SQL Server')).toBeTruthy()
    expect(mock.savedConfigs.some((c) => c.id === 'conn-sql')).toBe(true)

    // Bevestigen verwijdert de opgeslagen verbinding + sluit de sessie;
    // de andere connectie blijft onaangetast.
    fireEvent.contextMenu(within(tree()).getByText('SQL Server'))
    await waitFor(() => expect(screen.getByText('Delete…')).toBeTruthy())
    fireEvent.click(screen.getByText('Delete…'))
    await waitFor(() => expect(screen.getByText(/Delete saved connection 'SQL Server'\?/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(within(tree()).queryByText('SQL Server')).toBeNull())
    expect(within(tree()).getByText('Andere server')).toBeTruthy()
    expect(mock.savedConfigs.some((c) => c.id === 'conn-sql')).toBe(false)
    expect(mock.savedConfigs.some((c) => c.id === 'conn-other')).toBe(true)
    expect(mock.closedSessions).toContain('s1')
    expect(useAppStore.getState().openSessions['conn-sql']).toBeUndefined()
    expect(useAppStore.getState().openSessions['conn-other']).toBeUndefined()
    expect(screen.getByText(/Saved connection 'SQL Server' removed/)).toBeTruthy()
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
    await waitFor(() => expect(screen.getByText('Script Object as CREATE')).toBeTruthy())
    expect(screen.queryByText('Drop procedure…')).toBeNull()
    // Zonder supportsSynonyms/UsersAndRoles geen folders/items.
    expect(within(tree()).queryByText('Synonyms')).toBeNull()
    expect(within(tree()).queryByText('Users')).toBeNull()
  })
})

describe('SAL-52: professionele menubalk met Bestand-menu', () => {
  async function openBestandMenu(): Promise<void> {
    fireEvent.click(screen.getByRole('menuitem', { name: 'File' }))
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Open…' })).toBeTruthy())
  }

  function closeMenuWithEscape(): void {
    const active = document.activeElement
    const target =
      active && active instanceof HTMLElement && active.closest('.menu-bar')
        ? active
        : screen.getByRole('menuitem', { name: 'New query' })
    fireEvent.keyDown(target, { key: 'Escape' })
  }

  it('toont een Bestand-menubalk en heeft geen bestandsknoppen meer in de query-toolbar', () => {
    useAppStore.getState().addTab()
    render(<App />)

    // Menubalk zichtbaar (boven de toolbars).
    expect(screen.getByRole('menuitem', { name: 'File' })).toBeTruthy()

    // De drie bestandsknoppen staan niet meer in de query-toolbar.
    const toolbar = document.querySelector('.editor-toolbar')
    expect(toolbar).not.toBeNull()
    expect(within(toolbar as HTMLElement).queryByText('📂 Open')).toBeNull()
    expect(within(toolbar as HTMLElement).queryByText('💾 Save')).toBeNull()
    expect(within(toolbar as HTMLElement).queryByText('Save As…')).toBeNull()

    // Menu is standaard gesloten: geen losse menu-items zichtbaar.
    expect(screen.queryByRole('menuitem', { name: 'Open…' })).toBeNull()
  })

  it('opent Bestand en roept Openen… → openQueryFile → queryFiles.open aan (menu sluit na actie)', async () => {
    const openSpy = vi.spyOn(window.nvag.queryFiles, 'open').mockResolvedValue({
      canceled: false,
      path: '/tmp/query.sql',
      name: 'query.sql',
      content: 'SELECT 1;'
    })
    useAppStore.getState().addTab()
    render(<App />)

    await openBestandMenu()
    // Shortcut-toetscombinaties worden in het menu getoond.
    expect(screen.getByText('Ctrl+O')).toBeTruthy()
    expect(screen.getByText('Ctrl+S')).toBeTruthy()
    expect(screen.getByText('Ctrl+Shift+S')).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', { name: 'Open…' }))
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const active = useAppStore.getState().tabs.find((t) => t.id === useAppStore.getState().activeTabId)
      expect(active?.filePath).toBe('/tmp/query.sql')
    })
    // Na een actie sluit het menu.
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Open…' })).toBeNull())
  })

  it('houdt de Ctrl+O-shortcut werkend (venster-niveau)', async () => {
    const openSpy = vi.spyOn(window.nvag.queryFiles, 'open').mockResolvedValue({ canceled: true })
    useAppStore.getState().addTab()
    render(<App />)

    fireEvent.keyDown(window, { key: 'o', ctrlKey: true })
    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1))
  })

  it('disabled Opslaan zonder bestandsbinding en enabled na het openen van een bestand', async () => {
    useAppStore.getState().addTab()
    render(<App />)

    await openBestandMenu()
    const saveItem = screen.getByRole('menuitem', { name: 'Save' }) as HTMLButtonElement
    expect(saveItem.disabled).toBe(true)
    closeMenuWithEscape()
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Save' })).toBeNull())

    // Een bestand aan de actieve tab koppelen (zelfde weg als Openen…).
    vi.spyOn(window.nvag.queryFiles, 'open').mockResolvedValue({
      canceled: false,
      path: '/tmp/query.sql',
      name: 'query.sql',
      content: 'SELECT 1;'
    })
    await useAppStore.getState().openQueryFile()

    await openBestandMenu()
    const saveItemEnabled = screen.getByRole('menuitem', { name: 'Save' }) as HTMLButtonElement
    expect(saveItemEnabled.disabled).toBe(false)
  })

  it('Nieuwe query / Verbindingen beheren… / Afsluiten roepen de juiste acties aan', async () => {
    const quitSpy = vi.spyOn(window.nvag.app, 'quit')
    useAppStore.getState().addTab()
    render(<App />)
    const tabCount = useAppStore.getState().tabs.length

    // Nieuwe query → extra tab.
    await openBestandMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'New query' }))
    await waitFor(() => expect(useAppStore.getState().tabs.length).toBe(tabCount + 1))

    // Verbindingen beheren… → Connection Manager-dialoog (ConnectionDialog).
    await openBestandMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage connections…' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'New connection' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'New connection' })).toBeNull())

    // Afsluiten → app.quit via IPC.
    await openBestandMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quit' }))
    await waitFor(() => expect(quitSpy).toHaveBeenCalledTimes(1))
  })

  it("toont 'Recente query's' als submenu en opent die in een nieuwe tab", async () => {
    useAppStore.getState().useRecentQuery('SELECT 42;', 'conn-1')
    useAppStore.getState().addTab()
    render(<App />)
    const tabCount = useAppStore.getState().tabs.length

    await openBestandMenu()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Recent queries' }))
    const recentItem = await screen.findByRole('menuitem', { name: /SELECT 42/ })
    fireEvent.click(recentItem)

    await waitFor(() => expect(useAppStore.getState().tabs.length).toBe(tabCount + 1))
    const tabs = useAppStore.getState().tabs
    expect(tabs[tabs.length - 1]?.sql).toBe('SELECT 42;')
  })

  it('sluit het menu bij Escape en bij een buiten-klik', async () => {
    useAppStore.getState().addTab()
    render(<App />)

    await openBestandMenu()
    closeMenuWithEscape()
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Open…' })).toBeNull())

    await openBestandMenu()
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Open…' })).toBeNull())
  })
})
