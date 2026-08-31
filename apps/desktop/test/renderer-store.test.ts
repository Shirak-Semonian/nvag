import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig, QueryRunResponse } from '@nvag/contracts'
import { useAppStore } from '../src/renderer/src/state/store'

/** Minimale window.nvag mock (alleen de kanalen die de store gebruikt). */
function mockNvag(overrides: { queryRun?: (req: { connectionId: string; sql: string }) => Promise<QueryRunResponse> } = {}) {
  const queryRun =
    overrides.queryRun ??
    vi.fn(async () => ({
      executionId: 'e1',
      columns: [],
      rows: [],
      truncated: false,
      rowCount: 0,
      durationMs: 1
    }))
  ;(window as unknown as { nvag: unknown }).nvag = {
    connections: {
      list: vi.fn(async () => [] as ConnectionConfig[]),
      save: vi.fn(async (c: ConnectionConfig) => c),
      remove: vi.fn(async () => undefined),
      test: vi.fn(async () => ({ ok: true }))
    },
    sessions: {
      open: vi.fn(async () => ({
        sessionId: 's1',
        serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' }
      })),
      close: vi.fn(async () => undefined)
    },
    query: { run: queryRun, cancel: vi.fn(async () => undefined) },
    metadata: {},
    app: { getVersion: vi.fn(async () => '1.0.0') }
  } as never
  return { queryRun }
}

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

describe('renderer store — tabs', () => {
  beforeEach(() => {
    mockNvag()
    useAppStore.setState({
      connections: [sqliteConn],
      openSessions: {},
      tabs: [],
      activeTabId: null
    })
  })

  it('voegt een lege tab toe en maakt die actief', () => {
    const s = useAppStore.getState()
    s.addTab()
    const state = useAppStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].sql).toBe('')
    expect(state.tabs[0].connectionId).toBeNull()
    expect(state.activeTabId).toBe(state.tabs[0].id)
  })

  it('opent een tabel-query met SELECT * en LIMIT via openTableQuery', () => {
    const s = useAppStore.getState()
    s.openTableQuery('conn-1', 'users', 'main')
    const state = useAppStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].connectionId).toBe('conn-1')
    expect(state.tabs[0].sql).toContain('SELECT * FROM "main"."users"')
    expect(state.tabs[0].sql).toContain('LIMIT 100')
  })

  it('sluit een tab en kiest een andere actieve tab', () => {
    const s = useAppStore.getState()
    s.addTab()
    s.addTab()
    const ids = useAppStore.getState().tabs.map((t) => t.id)
    useAppStore.getState().closeTab(ids[1]!)
    const state = useAppStore.getState()
    expect(state.tabs.map((t) => t.id)).toEqual([ids[0]])
    expect(state.activeTabId).toBe(ids[0])
  })

  it('werkt updateTabSql en setTabConnection bij', () => {
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().updateTabSql(id, 'SELECT 1')
    useAppStore.getState().setTabConnection(id, 'conn-1')
    const tab = useAppStore.getState().tabs[0]
    expect(tab.sql).toBe('SELECT 1')
    expect(tab.connectionId).toBe('conn-1')
  })
})

describe('renderer store — query-uitvoering', () => {
  beforeEach(() => {
    useAppStore.setState({
      connections: [sqliteConn],
      openSessions: {},
      tabs: [],
      activeTabId: null
    })
  })

  it('draait een query via window.nvag.query.run en slaat het resultaat op', async () => {
    const { queryRun } = mockNvag({
      queryRun: vi.fn(async () => ({
        executionId: 'e1',
        columns: [{ name: 'id' }],
        rows: [{ values: [1] }],
        truncated: false,
        rowCount: 1,
        durationMs: 5
      }))
    })
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().setTabConnection(id, 'conn-1')
    useAppStore.getState().updateTabSql(id, 'SELECT id FROM t')
    await useAppStore.getState().openSession(sqliteConn)
    await useAppStore.getState().runQuery(id)

    expect(queryRun).toHaveBeenCalledWith({ connectionId: 'conn-1', sql: 'SELECT id FROM t' })
    const tab = useAppStore.getState().tabs[0]
    expect(tab.running).toBe(false)
    expect(tab.result?.rowCount).toBe(1)
    expect(tab.result?.columns).toEqual([{ name: 'id' }])
  })

  it('vangt een query-fout op in het resultaat', async () => {
    mockNvag({
      queryRun: vi.fn(async () => {
        throw new Error('syntax error')
      })
    })
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().setTabConnection(id, 'conn-1')
    await useAppStore.getState().openSession(sqliteConn)
    await useAppStore.getState().runQuery(id)

    const tab = useAppStore.getState().tabs[0]
    expect(tab.running).toBe(false)
    expect(tab.result?.error).toContain('syntax error')
  })

  it('doet niets zonder verbinding of sessie', async () => {
    const { queryRun } = mockNvag()
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    await useAppStore.getState().runQuery(id)
    expect(queryRun).not.toHaveBeenCalled()
  })
})
