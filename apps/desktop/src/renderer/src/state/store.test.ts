import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore, type QueryTabState } from './store'
import { createMockNvag, sampleConnection, sampleTableMetadata } from '../test/mockNvag'
import type { ConnectionConfig, NvagIpcApi } from '@nvag/contracts'

function resetStore(): void {
  useAppStore.setState({
    connections: [],
    openSessions: {},
    tabs: [],
    activeTabId: null,
    recentQueries: [],
    showConnectionDialog: false,
    connectionDialogMode: 'create',
    editingConnectionId: null,
    pendingGuard: null
  })
}

function seedTab(overrides: Partial<QueryTabState> = {}): QueryTabState {
  return {
    id: 'tab-test',
    title: 'Query 1',
    sql: 'SELECT 1;',
    connectionId: 'conn-1',
    result: null,
    running: false,
    executionId: null,
    startedAt: null,
    ...overrides
  }
}

let mock: NvagIpcApi & {
  savedConfigs: ConnectionConfig[]
  openedSessions: string[]
  closedSessions: string[]
  queriedSql: string[]
}

beforeEach(() => {
  resetStore()
  mock = createMockNvag({ connections: [sampleConnection()] })
  window.nvag = mock
})

describe('app store', () => {
  it('laadt verbindingen', async () => {
    await useAppStore.getState().loadConnections()
    expect(useAppStore.getState().connections).toHaveLength(1)
    expect(useAppStore.getState().connections[0]?.name).toBe('Klantendatabase')
  })

  it('voegt tabbladen toe en activeert ze', () => {
    useAppStore.getState().addTab()
    const state = useAppStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(state.tabs[0]?.id)
    expect(state.tabs[0]?.title).toMatch(/^Query \d+$/)
  })

  it('opent een tabel-query via openTableQuery (dubbelklik)', () => {
    useAppStore.setState({ connections: [sampleConnection()] })
    useAppStore.getState().openTableQuery('conn-1', 'klanten')
    const state = useAppStore.getState()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    expect(tab?.title).toBe('klanten')
    expect(tab?.sql).toBe('SELECT * FROM "klanten" LIMIT 100')
    expect(tab?.connectionId).toBe('conn-1')
  })

  it('opent een scripttab met gegenereerde SQL via openScriptTab (F1-5)', async () => {
    const withMeta = createMockNvag({
      connections: [sampleConnection()],
      tableMetadata: { klanten: sampleTableMetadata('klanten') }
    })
    window.nvag = withMeta
    useAppStore.setState({ connections: [sampleConnection()] })

    await useAppStore.getState().openScriptTab(
      'conn-1',
      { type: 'table', database: 'main', schema: 'main', name: 'klanten' },
      'SELECT'
    )
    const state = useAppStore.getState()
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    expect(tab?.title).toBe('klanten — SELECT')
    expect(tab?.sql).toBe('SELECT "id", "naam"\nFROM "main"."klanten";')
    expect(tab?.connectionId).toBe('conn-1')

    // INSERT laat identity-kolom buiten de lijst
    await useAppStore.getState().openScriptTab(
      'conn-1',
      { type: 'table', database: 'main', schema: 'main', name: 'klanten' },
      'INSERT'
    )
    const tab2 = useAppStore.getState().tabs.find(
      (t) => t.id === useAppStore.getState().activeTabId
    )
    expect(tab2?.sql).toBe('INSERT INTO "main"."klanten" ("naam")\nVALUES (?);')
    expect(tab2?.title).toBe('klanten — INSERT')
  })

  it('draait een query en slaat het resultaat op', async () => {
    const result = {
      executionId: 'e1',
      columns: [{ name: 'id' }],
      rows: [{ values: [1] }],
      truncated: false,
      rowCount: 1,
      durationMs: 2
    }
    const withResults = createMockNvag({ connections: [sampleConnection()], queryResults: { 'SELECT 1;': result } })
    window.nvag = withResults

    useAppStore.setState({
      connections: [sampleConnection()],
      openSessions: {
        'conn-1': {
          config: sampleConnection(),
          sessionId: 's1',
          serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' }
        }
      },
      tabs: [seedTab()],
      activeTabId: 'tab-test'
    })

    await useAppStore.getState().runQuery('tab-test')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-test')
    expect(tab?.running).toBe(false)
    expect(tab?.result?.rowCount).toBe(1)
    expect(withResults.queriedSql).toEqual(['SELECT 1;'])
  })

  it('slaat een queryfout op in het resultaat', async () => {
    const errResult = {
      executionId: 'e2',
      columns: [],
      rows: [],
      truncated: false,
      rowCount: 0,
      durationMs: 0,
      error: 'near "FOUT": syntax error',
      errorPosition: { line: 1, column: 7 }
    }
    const withError = createMockNvag({ connections: [sampleConnection()], queryResults: { 'SELECT FOUT;': errResult } })
    window.nvag = withError

    useAppStore.setState({
      connections: [sampleConnection()],
      openSessions: {
        'conn-1': {
          config: sampleConnection(),
          sessionId: 's1',
          serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' }
        }
      },
      tabs: [seedTab({ sql: 'SELECT FOUT;' })],
      activeTabId: 'tab-test'
    })

    await useAppStore.getState().runQuery('tab-test')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-test')
    expect(tab?.running).toBe(false)
    expect(tab?.result?.error).toContain('syntax error')
  })

  it('doet niets zonder sessie of verbinding', async () => {
    useAppStore.setState({
      connections: [sampleConnection()],
      tabs: [seedTab({ connectionId: null })],
      activeTabId: 'tab-test'
    })
    await useAppStore.getState().runQuery('tab-test')
    expect(useAppStore.getState().tabs[0]?.running).toBe(false)
    expect(mock.queriedSql).toHaveLength(0)
  })

  it('opent en sluit sessies', async () => {
    const conn = sampleConnection()
    await useAppStore.getState().openSession(conn)
    expect(useAppStore.getState().openSessions['conn-1']?.sessionId).toBeTruthy()
    await useAppStore.getState().closeSession('conn-1')
    expect(useAppStore.getState().openSessions['conn-1']).toBeUndefined()
  })

  it('sluit een tab en valt terug op de vorige actieve tab', () => {
    useAppStore.setState({
      tabs: [seedTab({ id: 'a' }), seedTab({ id: 'b', title: 'Query 2' })],
      activeTabId: 'b'
    })
    useAppStore.getState().closeTab('b')
    const state = useAppStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe('a')
  })

  it('dupliceert een tab met sql + verbinding (F1-3)', () => {
    useAppStore.setState({
      tabs: [seedTab({ id: 'a', sql: 'SELECT 42;', connectionId: 'conn-1' })],
      activeTabId: 'a'
    })
    useAppStore.getState().duplicateTab('a')
    const state = useAppStore.getState()
    expect(state.tabs).toHaveLength(2)
    const copy = state.tabs[1]
    expect(copy?.sql).toBe('SELECT 42;')
    expect(copy?.connectionId).toBe('conn-1')
    expect(copy?.title).toBe('Query 1 (kopie)')
    expect(copy?.filePath).toBeUndefined()
    expect(state.activeTabId).toBe(copy?.id)
  })

  it('voert een selectie uit via runQuery(tabId, sql) (F1-3)', async () => {
    const withResults = createMockNvag({
      connections: [sampleConnection()],
      queryResults: { 'SELECT 2;': { executionId: 'e3', columns: [{ name: 'x' }], rows: [{ values: [2] }], truncated: false, rowCount: 1, durationMs: 1 } }
    })
    window.nvag = withResults
    useAppStore.setState({
      connections: [sampleConnection()],
      openSessions: {
        'conn-1': { config: sampleConnection(), sessionId: 's1', serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' } }
      },
      tabs: [seedTab({ sql: 'SELECT 1;' })],
      activeTabId: 'tab-test'
    })

    await useAppStore.getState().runQuery('tab-test', 'SELECT 2;')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-test')
    expect(withResults.queriedSql).toEqual(['SELECT 2;'])
    expect(tab?.result?.rowCount).toBe(1)
  })

  it('toont een bevestigingsdialoog voor een geblokkeerde query (F1-8)', async () => {
    const blocked = createMockNvag({
      connections: [sampleConnection()],
      blockedQueries: { 'DELETE FROM klanten': { reasons: ['DELETE/UPDATE zonder WHERE'], severity: 'confirm' } }
    })
    window.nvag = blocked
    useAppStore.setState({
      connections: [sampleConnection()],
      openSessions: {
        'conn-1': { config: sampleConnection(), sessionId: 's1', serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' } }
      },
      tabs: [seedTab({ sql: 'DELETE FROM klanten' })],
      activeTabId: 'tab-test'
    })

    await useAppStore.getState().runQuery('tab-test')
    const state = useAppStore.getState()
    expect(state.pendingGuard).not.toBeNull()
    expect(state.pendingGuard?.reasons).toEqual(['DELETE/UPDATE zonder WHERE'])
    expect(state.pendingGuard?.sql).toBe('DELETE FROM klanten')
    expect(state.pendingGuard?.environment).toBe('DEV')
    const tab = state.tabs.find((t) => t.id === 'tab-test')
    expect(tab?.running).toBe(false)
    expect(tab?.result).toBeNull()
    // Nog niet uitgevoerd: alleen de eerste (geblokkeerde) run-aanvraag.
    expect(blocked.queriedSql).toEqual(['DELETE FROM klanten'])
    expect(blocked.runRequests).toEqual([{ sql: 'DELETE FROM klanten', confirmed: undefined }])
  })

  it('voert een bevestigde query alsnog uit via confirmGuardQuery (F1-8)', async () => {
    const blocked = createMockNvag({
      connections: [sampleConnection()],
      blockedQueries: { 'DELETE FROM klanten': { reasons: ['DELETE/UPDATE zonder WHERE'], severity: 'confirm' } },
      queryResults: { 'DELETE FROM klanten': { executionId: 'e9', columns: [], rows: [], truncated: false, rowCount: 3, durationMs: 2 } }
    })
    window.nvag = blocked
    useAppStore.setState({
      connections: [sampleConnection()],
      openSessions: {
        'conn-1': { config: sampleConnection(), sessionId: 's1', serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' } }
      },
      tabs: [seedTab({ sql: 'DELETE FROM klanten' })],
      activeTabId: 'tab-test'
    })

    await useAppStore.getState().runQuery('tab-test')
    expect(useAppStore.getState().pendingGuard).not.toBeNull()

    await useAppStore.getState().confirmGuardQuery()
    const state = useAppStore.getState()
    expect(state.pendingGuard).toBeNull()
    const tab = state.tabs.find((t) => t.id === 'tab-test')
    expect(tab?.result?.rowCount).toBe(3)
    // Eerste run geblokkeerd, tweede met confirmed: true.
    expect(blocked.runRequests.map((r) => r.confirmed)).toEqual([undefined, true])
  })

  it('annuleert de geblokkeerde query via cancelGuardQuery (F1-8)', async () => {
    const blocked = createMockNvag({
      connections: [sampleConnection()],
      blockedQueries: { 'DROP TABLE klanten': { reasons: ['DROP-statement'], severity: 'confirm' } }
    })
    window.nvag = blocked
    useAppStore.setState({
      connections: [sampleConnection()],
      openSessions: {
        'conn-1': { config: sampleConnection(), sessionId: 's1', serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' } }
      },
      tabs: [seedTab({ sql: 'DROP TABLE klanten' })],
      activeTabId: 'tab-test'
    })

    await useAppStore.getState().runQuery('tab-test')
    expect(useAppStore.getState().pendingGuard).not.toBeNull()
    useAppStore.getState().cancelGuardQuery()
    expect(useAppStore.getState().pendingGuard).toBeNull()
    expect(blocked.runRequests).toHaveLength(1)
  })

  it('voert een warn-query uit met waarschuwing in het berichtenpaneel (F1-8)', async () => {
    const blocked = createMockNvag({
      connections: [sampleConnection()],
      blockedQueries: { 'UPDATE a SET x = 1; UPDATE b SET y = 2;': { reasons: ['grote operatie'], severity: 'warn' } },
      queryResults: {
        'UPDATE a SET x = 1; UPDATE b SET y = 2;': { executionId: 'e8', columns: [], rows: [], truncated: false, rowCount: 0, durationMs: 1 }
      }
    })
    window.nvag = blocked
    useAppStore.setState({
      connections: [sampleConnection()],
      openSessions: {
        'conn-1': { config: sampleConnection(), sessionId: 's1', serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' } }
      },
      tabs: [seedTab({ sql: 'UPDATE a SET x = 1; UPDATE b SET y = 2;' })],
      activeTabId: 'tab-test'
    })

    await useAppStore.getState().runQuery('tab-test')
    const state = useAppStore.getState()
    expect(state.pendingGuard).toBeNull()
    expect(blocked.runRequests.map((r) => r.confirmed)).toEqual([undefined, true])
    const tab = state.tabs.find((t) => t.id === 'tab-test')
    expect(tab?.result?.messages?.some((m) => m.severity === 'warning' && m.text.includes('grote operatie'))).toBe(true)
  })

  it('registreert recente query’s na uitvoering en kan ze wissen (F1-3)', async () => {
    const withResults = createMockNvag({
      connections: [sampleConnection()],
      queryResults: { 'SELECT 1;': { executionId: 'e1', columns: [], rows: [], truncated: false, rowCount: 0, durationMs: 0 } }
    })
    window.nvag = withResults
    useAppStore.setState({
      connections: [sampleConnection()],
      openSessions: {
        'conn-1': { config: sampleConnection(), sessionId: 's1', serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' } }
      },
      tabs: [seedTab()],
      activeTabId: 'tab-test'
    })

    await useAppStore.getState().runQuery('tab-test')
    const recent = useAppStore.getState().recentQueries
    expect(recent).toHaveLength(1)
    expect(recent[0]?.sql).toBe('SELECT 1;')
    expect(recent[0]?.connectionId).toBe('conn-1')

    // Onthouden op dezelfde sleutel ontdubbelt
    await useAppStore.getState().runQuery('tab-test')
    expect(useAppStore.getState().recentQueries).toHaveLength(1)

    useAppStore.getState().clearRecentQueries()
    expect(useAppStore.getState().recentQueries).toHaveLength(0)
  })

  it('opent een querybestand in een nieuwe tab (F1-3)', async () => {
    const withFile = createMockNvag({
      connections: [sampleConnection()],
      openFileResult: { canceled: false, path: '/tmp/rapport.sql', name: 'rapport.sql', content: 'SELECT * FROM rapport;' }
    })
    window.nvag = withFile

    const tabId = await useAppStore.getState().openQueryFile()
    const tab = useAppStore.getState().tabs.find((t) => t.id === tabId)
    expect(tab?.title).toBe('rapport.sql')
    expect(tab?.sql).toBe('SELECT * FROM rapport;')
    expect(tab?.filePath).toBe('/tmp/rapport.sql')
    expect(tab?.dirty).toBe(false)
  })

  it('slaat een tab op naar zijn bestandspad en wist de dirty-vlag (F1-3)', async () => {
    const withFile = createMockNvag({ connections: [sampleConnection()] })
    window.nvag = withFile
    useAppStore.setState({
      tabs: [seedTab({ id: 'a', sql: 'SELECT 1;', filePath: '/tmp/query.sql', dirty: true })],
      activeTabId: 'a'
    })

    await useAppStore.getState().saveQueryFile('a')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'a')
    expect(tab?.dirty).toBe(false)
    expect(withFile.savedFiles).toEqual([{ content: 'SELECT 1;', path: '/tmp/query.sql' }])
  })

  it('slaat een tab op als nieuw bestand via Save As (F1-3)', async () => {
    const withFile = createMockNvag({
      connections: [sampleConnection()],
      saveFileResult: { canceled: false, path: '/tmp/nieuw.sql' }
    })
    window.nvag = withFile
    useAppStore.setState({
      tabs: [seedTab({ id: 'a', sql: 'SELECT 2;' })],
      activeTabId: 'a'
    })

    await useAppStore.getState().saveQueryFileAs('a')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'a')
    expect(tab?.filePath).toBe('/tmp/nieuw.sql')
    expect(tab?.title).toBe('nieuw.sql')
    expect(withFile.savedFiles).toEqual([{ content: 'SELECT 2;', path: undefined }])
  })

  // ------------------------------------------------------------------ F1-10
  it('geeft een tab met verbinding de database uit de config als default (F1-10)', () => {
    const conn = sampleConnection({ database: 'klanten' })
    useAppStore.setState({ connections: [conn] })
    useAppStore.getState().addTab({ connectionId: 'conn-1' })
    const tab = useAppStore.getState().tabs[useAppStore.getState().tabs.length - 1]
    expect(tab?.connectionId).toBe('conn-1')
    expect(tab?.database).toBe('klanten')
  })

  it('dupliceert een tab inclusief database (F1-10)', () => {
    useAppStore.setState({
      tabs: [seedTab({ id: 'a', sql: 'SELECT 42;', connectionId: 'conn-1', database: 'analytics' })],
      activeTabId: 'a'
    })
    useAppStore.getState().duplicateTab('a')
    const copy = useAppStore.getState().tabs[1]
    expect(copy?.database).toBe('analytics')
    expect(copy?.connectionId).toBe('conn-1')
  })

  it('switcht snel van verbinding en opent de sessie via openSaved (F1-10)', async () => {
    const connA = sampleConnection({ id: 'conn-a', name: 'A', database: 'dbA' })
    const connB = sampleConnection({ id: 'conn-b', name: 'B', database: 'dbB' })
    const withTwo = createMockNvag({ connections: [connA, connB] })
    window.nvag = withTwo
    useAppStore.setState({
      connections: [connA, connB],
      openSessions: {
        'conn-a': {
          config: connA,
          sessionId: 's-a',
          serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3', currentDatabase: 'dbA' }
        }
      },
      tabs: [seedTab({ id: 'tab-1', connectionId: 'conn-a', database: 'dbA' })],
      activeTabId: 'tab-1'
    })

    await useAppStore.getState().switchTabConnection('tab-1', 'conn-b')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(withTwo.openSavedCalls).toEqual(['conn-b'])
    expect(tab?.connectionId).toBe('conn-b')
    expect(tab?.database).toBe('dbB')
    expect(useAppStore.getState().openSessions['conn-b']?.sessionId).toBeTruthy()
    expect(tab?.dbSwitchError).toBeFalsy()
  })

  it('switcht niet van verbinding wanneer openSaved faalt en toont de fout (F1-10)', async () => {
    const connA = sampleConnection({ id: 'conn-a', name: 'A', database: 'dbA' })
    const connB = sampleConnection({ id: 'conn-b', name: 'B', database: 'dbB' })
    const failing = createMockNvag({
      connections: [connA, connB],
      failOpenConnectionIds: ['conn-b']
    })
    window.nvag = failing
    useAppStore.setState({
      connections: [connA, connB],
      openSessions: {
        'conn-a': {
          config: connA,
          sessionId: 's-a',
          serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3', currentDatabase: 'dbA' }
        }
      },
      tabs: [seedTab({ id: 'tab-1', connectionId: 'conn-a', database: 'dbA' })],
      activeTabId: 'tab-1'
    })

    await useAppStore.getState().switchTabConnection('tab-1', 'conn-b')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(tab?.connectionId).toBe('conn-a')
    expect(tab?.dbSwitchError).toContain('bestand niet gevonden')
  })

  it('wisselt de database van een tab via useDatabase en werkt de sessie bij (F1-10)', async () => {
    const conn = sampleConnection({ database: 'main' })
    const withDb = createMockNvag({ connections: [conn] })
    window.nvag = withDb
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-1': {
          config: conn,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3', currentDatabase: 'main' }
        }
      },
      tabs: [seedTab({ id: 'tab-1', connectionId: 'conn-1', database: 'main' })],
      activeTabId: 'tab-1'
    })

    await useAppStore.getState().setTabDatabase('tab-1', 'archive')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(withDb.useDatabaseCalls).toEqual([{ connectionId: 'conn-1', database: 'archive' }])
    expect(tab?.database).toBe('archive')
    expect(useAppStore.getState().openSessions['conn-1']?.serverInfo.currentDatabase).toBe('archive')
    expect(tab?.dbSwitchError).toBeFalsy()
  })

  it('zet de database terug en toont een fout wanneer useDatabase faalt (F1-10)', async () => {
    const conn = sampleConnection({ database: 'main' })
    const failing = createMockNvag({ connections: [conn] })
    const original = failing.sessions.useDatabase
    failing.sessions.useDatabase = async () => {
      throw new Error('USE mislukt')
    }
    window.nvag = failing
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-1': {
          config: conn,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3', currentDatabase: 'main' }
        }
      },
      tabs: [seedTab({ id: 'tab-1', connectionId: 'conn-1', database: 'main' })],
      activeTabId: 'tab-1'
    })

    await useAppStore.getState().setTabDatabase('tab-1', 'archive')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(tab?.database).toBe('main')
    expect(tab?.dbSwitchError).toContain('USE mislukt')
    expect(original).toBeDefined()
  })

  it('schakelt vóór de uitvoering naar de database van de tab (F1-10)', async () => {
    const conn = sampleConnection({ id: 'conn-srv', providerId: 'sqlserver', database: 'main' })
    const withDb = createMockNvag({ connections: [conn] })
    window.nvag = withDb
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-srv': {
          config: conn,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlserver', providerName: 'SQL Server', serverVersion: '2022', currentDatabase: 'main' }
        }
      },
      tabs: [seedTab({ id: 'tab-1', sql: 'SELECT 1;', connectionId: 'conn-srv', database: 'archive' })],
      activeTabId: 'tab-1'
    })

    await useAppStore.getState().runQuery('tab-1')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(withDb.useDatabaseCalls).toEqual([{ connectionId: 'conn-srv', database: 'archive' }])
    expect(withDb.queriedSql).toEqual(['SELECT 1;'])
    expect(tab?.running).toBe(false)
  })

  it('blokkeert de query wanneer de database-switch vóór uitvoering faalt (F1-10)', async () => {
    const conn = sampleConnection({ id: 'conn-srv', providerId: 'sqlserver', database: 'main' })
    const failing = createMockNvag({ connections: [conn] })
    failing.sessions.useDatabase = async () => {
      throw new Error('USE mislukt')
    }
    window.nvag = failing
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-srv': {
          config: conn,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlserver', providerName: 'SQL Server', serverVersion: '2022', currentDatabase: 'main' }
        }
      },
      tabs: [seedTab({ id: 'tab-1', sql: 'SELECT 1;', connectionId: 'conn-srv', database: 'archive' })],
      activeTabId: 'tab-1'
    })

    await useAppStore.getState().runQuery('tab-1')
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(failing.queriedSql).toHaveLength(0)
    expect(tab?.result?.error).toContain('USE mislukt')
    expect(tab?.running).toBe(false)
  })
})
