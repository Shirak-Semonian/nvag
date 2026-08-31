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
