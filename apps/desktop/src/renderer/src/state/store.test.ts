import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore, type QueryTabState } from './store'
import { createMockNvag, sampleConnection } from '../test/mockNvag'
import type { ConnectionConfig, NvagIpcApi } from '@nvag/contracts'

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

function seedTab(overrides: Partial<QueryTabState> = {}): QueryTabState {
  return {
    id: 'tab-test',
    title: 'Query 1',
    sql: 'SELECT 1;',
    connectionId: 'conn-1',
    result: null,
    running: false,
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
})
