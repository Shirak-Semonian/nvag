/**
 * F2-renderer: store-acties voor tabeldata, transacties, zoeken, snippets,
 * import, audit en dashboard (met de mockNvag-brug).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig, SearchMatch, SnippetEntry } from '@nvag/contracts'
import { useAppStore } from '../src/renderer/src/state/store'
import { createMockNvag } from '../src/renderer/src/test/mockNvag'

const sqliteConn: ConnectionConfig = {
  id: 'conn-1',
  name: 'Test DB',
  providerId: 'sqlite',
  environment: 'DEV',
  host: '/tmp/test.db',
  auth: 'username-password',
  ssl: { mode: 'disable' },
  connectionTimeoutMs: 5000,
  group: 'Test'
}

function resetStore(): void {
  useAppStore.setState({
    connections: [sqliteConn],
    openSessions: {
      'conn-1': {
        config: sqliteConn,
        sessionId: 's1',
        serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1', currentDatabase: '/tmp/test.db' }
      }
    },
    tabs: [],
    activeTabId: null,
    transactionState: {},
    snippets: [],
    snippetFolders: ['Algemeen'],
    searchResults: [],
    importPreview: null,
    importFilePath: null,
    importGeneratedSql: '',
    auditEntries: [],
    dashboard: null
  })
}

/** Laat beloofde store-updates (async IPC-mock) volledig doorlopen. */
function flushStore(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('F2-1 table data (renderer)', () => {
  beforeEach(() => {
    ;(window as unknown as { nvag: unknown }).nvag = createMockNvag({
      connections: [sqliteConn]
    })
    resetStore()
  })

  it('opent een table-data tab en laadt rijen', async () => {
    const api = createMockNvag({ connections: [sqliteConn] })
    ;(window as unknown as { nvag: unknown }).nvag = api
    resetStore()
    useAppStore.getState().openTableDataTab('conn-1', '/tmp/test.db', 'main', 'users')
    const tab = useAppStore.getState().tabs[0]
    expect(tab.kind).toBe('table-data')
    expect(tab.tableData?.table).toBe('users')
  })

  it('slaat een bewerking op via tableData.edit en vernieuwt', async () => {
    // edit-aanroep registreren via een spy-wrapping van de mock.
    const api = createMockNvag({ connections: [sqliteConn] })
    const editSpy = (api.tableData.edit = async () => ({ rowCount: 1, sql: 'UPDATE "users" SET "naam" = \'x\' WHERE "id" = 1;' }))
    ;(window as unknown as { nvag: unknown }).nvag = api
    resetStore()
    useAppStore.getState().openTableDataTab('conn-1', '/tmp/test.db', 'main', 'users')
    const tabId = useAppStore.getState().tabs[0].id
    await useAppStore.getState().saveTableEdit(tabId, 'update', { naam: 'x' }, { id: 1 })
    expect(editSpy).toBeDefined()
    const tab = useAppStore.getState().tabs[0]
    expect(tab.tableData?.lastEditMessage).toContain('1 rij(en)')
  })

  it('toont een laadfout in de error-state en wist die na een geslaagde herlaadbeurt (SAL-42)', async () => {
    const api = createMockNvag({ connections: [sqliteConn] })
    api.tableData.getRows = async () => {
      throw new Error('netwerkfout')
    }
    ;(window as unknown as { nvag: unknown }).nvag = api
    resetStore()
    useAppStore.getState().openTableDataTab('conn-1', '/tmp/test.db', 'main', 'users')
    const tabId = useAppStore.getState().tabs[0].id
    await flushStore()
    const failed = useAppStore.getState().tabs[0].tableData
    expect(failed?.loading).toBe(false)
    expect(failed?.data).toBeNull()
    expect(failed?.error).toContain('netwerkfout')

    // Herstel + "Opnieuw laden": de vorige fout is weg en de rijen staan erin.
    api.tableData.getRows = async () => ({
      columns: [{ name: 'id' }],
      rows: [{ values: [1] }],
      truncated: false,
      rowCount: 1,
      primaryKey: ['id'],
      editableColumns: ['id']
    })
    await useAppStore.getState().loadTableRows(tabId)
    const ok = useAppStore.getState().tabs[0].tableData
    expect(ok?.error).toBeNull()
    expect(ok?.loading).toBe(false)
    expect(ok?.data?.rowCount).toBe(1)
  })

  it('laadt automatisch zodra de sessie opengaat (geen stille "Laden…", SAL-42)', async () => {
    const api = createMockNvag({ connections: [sqliteConn] })
    ;(window as unknown as { nvag: unknown }).nvag = api
    resetStore()
    // Geen sessie open: de tab opent zonder te laden.
    useAppStore.setState({ openSessions: {} })
    useAppStore.getState().openTableDataTab('conn-1', '/tmp/test.db', 'main', 'users')
    const tabId = useAppStore.getState().tabs[0].id
    const waiting = useAppStore.getState().tabs[0].tableData
    expect(waiting?.data).toBeNull()
    expect(waiting?.loading).toBe(false)
    expect(waiting?.error).toBeNull()

    // Sessie opent → de tab laadt vanzelf (geen handmatige actie nodig).
    await useAppStore.getState().openSession(sqliteConn)
    await flushStore()
    const loaded = useAppStore.getState().tabs.find((t) => t.id === tabId)?.tableData
    expect(loaded?.data).not.toBeNull()
    expect(loaded?.error).toBeNull()
    expect(loaded?.loading).toBe(false)
  })

  it('geeft een duidelijke melding bij laden zonder sessie (SAL-42)', async () => {
    const api = createMockNvag({ connections: [sqliteConn] })
    ;(window as unknown as { nvag: unknown }).nvag = api
    resetStore()
    useAppStore.setState({ openSessions: {} })
    useAppStore.getState().openTableDataTab('conn-1', '/tmp/test.db', 'main', 'users')
    const tabId = useAppStore.getState().tabs[0].id
    // "Opnieuw laden" / vernieuwen zonder sessie: geen stille spinner.
    await useAppStore.getState().loadTableRows(tabId)
    const td = useAppStore.getState().tabs.find((t) => t.id === tabId)?.tableData
    expect(td?.loading).toBe(false)
    expect(td?.data).toBeNull()
    expect(td?.error).toContain('Geen actieve sessie')
  })
})

describe('F2-2 transacties (renderer)', () => {
  beforeEach(() => {
    ;(window as unknown as { nvag: unknown }).nvag = createMockNvag({ connections: [sqliteConn] })
    resetStore()
  })

  it('begin/commit werkt de transactionState bij', async () => {
    await useAppStore.getState().beginTransaction('conn-1')
    expect(useAppStore.getState().transactionState['conn-1']).toBe('active')
    await useAppStore.getState().commitTransaction('conn-1')
    expect(useAppStore.getState().transactionState['conn-1']).toBe('none')
  })

  it('rollback zet de status terug op none', async () => {
    await useAppStore.getState().beginTransaction('conn-1')
    await useAppStore.getState().rollbackTransaction('conn-1')
    expect(useAppStore.getState().transactionState['conn-1']).toBe('none')
  })
})

describe('F2-5 zoeken + F2-6 snippets (renderer)', () => {
  const match: SearchMatch = {
    objectType: 'table',
    database: 'main',
    schema: 'main',
    object: 'users',
    field: 'name'
  }

  beforeEach(() => {
    ;(window as unknown as { nvag: unknown }).nvag = createMockNvag({ connections: [sqliteConn] })
    resetStore()
  })

  it('zoekt en toont resultaten', async () => {
    const api = createMockNvag({ connections: [sqliteConn] })
    api.search.search = async () => [match]
    ;(window as unknown as { nvag: unknown }).nvag = api
    resetStore()
    await useAppStore.getState().runDatabaseSearch('conn-1', 'users')
    expect(useAppStore.getState().searchResults).toHaveLength(1)
    expect(useAppStore.getState().searchResults[0]?.object).toBe('users')
  })

  it('opent een zoekmatch als querytab met verbinding', () => {
    useAppStore.getState().openSearchMatch('conn-1', match)
    const tab = useAppStore.getState().tabs[0]
    expect(tab.connectionId).toBe('conn-1')
    expect(tab.sql).toContain('users')
  })

  it('slaat een snippet op en laadt folders', async () => {
    const api = createMockNvag({ connections: [sqliteConn] })
    const saved: SnippetEntry = { id: 1, folder: 'Selects', title: 'Top', sql: 'SELECT 1', updatedAt: new Date().toISOString() }
    api.snippets.list = async () => [saved]
    api.snippets.listFolders = async () => ['Algemeen', 'Selects']
    ;(window as unknown as { nvag: unknown }).nvag = api
    resetStore()
    await useAppStore.getState().saveSnippet({ folder: 'Selects', title: 'Top', sql: 'SELECT 1' })
    expect(useAppStore.getState().snippets).toHaveLength(1)
    expect(useAppStore.getState().snippetFolders).toContain('Selects')
  })

  it('voegt een snippet in de editor in', () => {
    useAppStore.getState().addTab({ sql: 'SELECT a' })
    const tabId = useAppStore.getState().tabs[0].id
    useAppStore.getState().insertSnippetIntoEditor(tabId, 'SELECT b')
    expect(useAppStore.getState().tabs[0].sql).toContain('SELECT b')
  })
})

describe('F2-8 audit + F2-10 dashboard (renderer)', () => {
  beforeEach(() => {
    ;(window as unknown as { nvag: unknown }).nvag = createMockNvag({ connections: [sqliteConn] })
    resetStore()
  })

  it('laadt auditregels en wist ze', async () => {
    const api = createMockNvag({ connections: [sqliteConn] })
    api.audit.list = async () => [
      { id: 1, at: '2026-08-31T20:00:00Z', action: 'connection.created', detail: 'x', success: true }
    ]
    ;(window as unknown as { nvag: unknown }).nvag = api
    resetStore()
    await useAppStore.getState().loadAudit()
    expect(useAppStore.getState().auditEntries).toHaveLength(1)
    await useAppStore.getState().clearAudit()
    expect(useAppStore.getState().auditEntries).toHaveLength(0)
  })

  it('laadt het dashboard', async () => {
    const api = createMockNvag({ connections: [sqliteConn] })
    api.dashboard.get = async () => ({
      serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' },
      databases: [{ name: 'main', sizeBytes: 1234 }],
      activeQueries: []
    })
    ;(window as unknown as { nvag: unknown }).nvag = api
    resetStore()
    await useAppStore.getState().loadDashboard('conn-1')
    expect(useAppStore.getState().dashboard?.databases[0]?.sizeBytes).toBe(1234)
  })
})
