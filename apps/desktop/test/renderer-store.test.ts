import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionConfig, HistoryEntry, QueryChunk, QueryChunkEvent } from '@nvag/contracts'
import { useAppStore } from '../src/renderer/src/state/store'

/**
 * Minimale window.nvag mock volgens het F1-4 streaming-protocol:
 * `run` → executionId, `onChunk`-subscriptie, `start` emitteert chunks.
 */
function mockNvag(opts: { stream?: (emit: (chunk: QueryChunk) => void) => void; history?: HistoryEntry[] } = {}) {
  const queried: { connectionId: string; sql: string }[] = []
  const listeners = new Set<(evt: QueryChunkEvent) => void>()
  const cancelled: string[] = []
  const historyEntries: HistoryEntry[] = [...(opts.history ?? [])]
  let execSeq = 0

  const emitTo = (executionId: string, chunk: QueryChunk): void => {
    for (const listener of listeners) listener({ executionId, chunk })
  }

  const api = {
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
      close: vi.fn(async () => undefined),
      openSaved: vi.fn(async () => ({
        sessionId: 's1',
        serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1', currentDatabase: 'test.db' }
      })),
      useDatabase: vi.fn(async (_connectionId: string, database: string) => ({
        sessionId: 's1',
        serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1', currentDatabase: database }
      }))
    },
    query: {
      run: async (req: { connectionId: string; sql: string }) => {
        queried.push(req)
        execSeq += 1
        return { executionId: `exec-${execSeq}` }
      },
      start: async (executionId: string) => {
        if (opts.stream) {
          await opts.stream((chunk) => emitTo(executionId, chunk))
        }
      },
      cancel: async (executionId: string) => {
        cancelled.push(executionId)
      },
      onChunk: (cb: (evt: QueryChunkEvent) => void) => {
        listeners.add(cb)
        return () => {
          listeners.delete(cb)
        }
      },
      exportCsv: async () => ({ canceled: true })
    },
    history: {
      list: vi.fn(async (query?: string) => {
        if (!query) return [...historyEntries]
        const q = query.toLowerCase()
        return historyEntries.filter(
          (e) => e.sql.toLowerCase().includes(q) || e.server.toLowerCase().includes(q) || e.database.toLowerCase().includes(q)
        )
      }),
      clear: vi.fn(async () => {
        historyEntries.length = 0
      })
    },
    metadata: {},
    app: { getVersion: vi.fn(async () => '1.0.0') }
  }
  ;(window as unknown as { nvag: unknown }).nvag = api as never
  return { queried, cancelled }
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

describe('renderer store — query-uitvoering (streaming)', () => {
  beforeEach(() => {
    useAppStore.setState({
      connections: [sqliteConn],
      openSessions: {},
      tabs: [],
      activeTabId: null
    })
  })

  it('draait een query via run → onChunk → start en slaat het resultaat op', async () => {
    const { queried } = mockNvag({
      stream: (emit) => {
        emit({ kind: 'columns', columns: [{ name: 'id' }] })
        emit({ kind: 'rows', rows: [{ values: [1] }] })
        emit({ kind: 'done', rowCount: 1, durationMs: 5 })
      }
    })
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().setTabConnection(id, 'conn-1')
    useAppStore.getState().updateTabSql(id, 'SELECT id FROM t')
    await useAppStore.getState().openSession(sqliteConn)
    await useAppStore.getState().runQuery(id)

    expect(queried).toEqual([{ connectionId: 'conn-1', sql: 'SELECT id FROM t' }])
    const tab = useAppStore.getState().tabs[0]
    expect(tab.running).toBe(false)
    expect(tab.executionId).toBeNull()
    expect(tab.result?.rowCount).toBe(1)
    expect(tab.result?.columns).toEqual([{ name: 'id' }])
    expect(tab.result?.durationMs).toBe(5)
  })

  it('vangt een query-fout via een error-chunk op in het resultaat', async () => {
    mockNvag({
      stream: (emit) => {
        emit({ kind: 'error', message: 'syntax error', position: { line: 2, column: 4 } })
      }
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
    expect(tab.result?.errorPosition).toEqual({ line: 2, column: 4 })
  })

  it('doet niets zonder verbinding of sessie', async () => {
    const { queried } = mockNvag()
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    await useAppStore.getState().runQuery(id)
    expect(queried).toHaveLength(0)
  })

  it('vult resultaten progressief tijdens streaming (SAL-17)', async () => {
    let midRows = -1
    mockNvag({
      stream: (emit) => {
        emit({ kind: 'columns', columns: [{ name: 'id' }] })
        emit({ kind: 'rows', rows: [{ values: [1] }] })
        // Vóór het done-chunk is de tussentijdse staat al in de store.
        midRows = useAppStore.getState().tabs[0]?.result?.rows.length ?? -1
        emit({ kind: 'done', rowCount: 1, durationMs: 2 })
      }
    })
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().setTabConnection(id, 'conn-1')
    await useAppStore.getState().openSession(sqliteConn)
    await useAppStore.getState().runQuery(id)

    expect(midRows).toBe(1)
    const tab = useAppStore.getState().tabs[0]
    expect(tab.result?.rows).toHaveLength(1)
  })

  it('verzamelt meerdere resultatensets in tabs (SAL-17)', async () => {
    mockNvag({
      stream: (emit) => {
        emit({ kind: 'columns', columns: [{ name: 'a' }] })
        emit({ kind: 'rows', rows: [{ values: [1] }] })
        emit({ kind: 'columns', columns: [{ name: 'b' }] })
        emit({ kind: 'rows', rows: [{ values: [2] }] })
        emit({ kind: 'done', rowCount: 2, durationMs: 3 })
      }
    })
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().setTabConnection(id, 'conn-1')
    await useAppStore.getState().openSession(sqliteConn)
    await useAppStore.getState().runQuery(id)

    const tab = useAppStore.getState().tabs[0]
    expect(tab.result?.results).toHaveLength(2)
    expect(tab.result?.results?.[0]?.columns).toEqual([{ name: 'a' }])
    expect(tab.result?.results?.[1]?.columns).toEqual([{ name: 'b' }])
    // Backward-compat: eerste set in columns/rows.
    expect(tab.result?.columns).toEqual([{ name: 'a' }])
    expect(tab.result?.rowCount).toBe(2)
  })

  it('zet truncation-waarschuwing in messages bij truncated done (SAL-17)', async () => {
    mockNvag({
      stream: (emit) => {
        emit({ kind: 'columns', columns: [{ name: 'id' }] })
        emit({ kind: 'rows', rows: [{ values: [1] }] })
        emit({ kind: 'done', rowCount: 1, durationMs: 2, truncated: true })
      }
    })
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().setTabConnection(id, 'conn-1')
    await useAppStore.getState().openSession(sqliteConn)
    await useAppStore.getState().runQuery(id)

    const tab = useAppStore.getState().tabs[0]
    expect(tab.result?.truncated).toBe(true)
    expect(tab.result?.results?.[0]?.truncated).toBe(true)
    expect(tab.result?.messages?.some((m) => m.severity === 'warning' && /truncated/i.test(m.text))).toBe(true)
  })

  it('slaat DML-rowcount op via het done-chunk (SAL-17)', async () => {
    mockNvag({
      stream: (emit) => {
        emit({ kind: 'done', rowCount: 3, durationMs: 5 })
      }
    })
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().setTabConnection(id, 'conn-1')
    await useAppStore.getState().openSession(sqliteConn)
    await useAppStore.getState().runQuery(id)

    const tab = useAppStore.getState().tabs[0]
    expect(tab.result?.rowCount).toBe(3)
    expect(tab.result?.results ?? []).toHaveLength(0)
  })

  it('annuleert een actieve query via cancelQuery (SAL-17)', async () => {
    // Ref-achtige houder: closures mogen de narrowing van een let niet breken.
    const emitChunkRef: { current: ((chunk: QueryChunk) => void) | null } = { current: null }
    mockNvag({
      stream: (emit) =>
        new Promise<void>((resolve) => {
          emitChunkRef.current = (chunk) => {
            emit(chunk)
            // De runner beëindigt de stream na done/error.
            if (chunk.kind === 'done' || chunk.kind === 'error') resolve()
          }
        })
    })

    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().setTabConnection(id, 'conn-1')
    await useAppStore.getState().openSession(sqliteConn)

    const runPromise = useAppStore.getState().runQuery(id)
    // Zolang de stream niet eindigt, blijft de tab running met executionId.
    await new Promise((r) => setTimeout(r, 10))
    const mid = useAppStore.getState().tabs[0]
    expect(mid.running).toBe(true)
    expect(mid.executionId).toMatch(/^exec-/)
    expect(mid.startedAt).not.toBeNull()

    // Cancel → runner stuurt done(cancelled) → tab stopt.
    emitChunkRef.current?.({ kind: 'done', rowCount: 0, durationMs: 12, cancelled: true })
    await runPromise
    const tab = useAppStore.getState().tabs[0]
    expect(tab.running).toBe(false)
    expect(tab.result?.cancelled).toBe(true)
    expect(tab.executionId).toBeNull()
  })

  it('annuleert via de cancel-knop stuurt query.cancel met de executionId', async () => {
    const { cancelled } = mockNvag({
      stream: () => new Promise<void>(() => undefined) // oneindig
    })
    const s = useAppStore.getState()
    s.addTab()
    const id = useAppStore.getState().tabs[0].id
    useAppStore.getState().setTabConnection(id, 'conn-1')
    await useAppStore.getState().openSession(sqliteConn)

    const runPromise = useAppStore.getState().runQuery(id)
    await new Promise((r) => setTimeout(r, 10))
    const executionId = useAppStore.getState().tabs[0].executionId
    expect(executionId).toMatch(/^exec-/)

    await useAppStore.getState().cancelQuery(id)
    expect(cancelled).toEqual([executionId])
    // De stream blijft in de mock hangen; de tab meldt geen done — dat is hier ok.
    void runPromise
  })
})

describe('renderer store — SQL history (eis 19)', () => {
  const historyEntry: HistoryEntry = {
    id: 1,
    executedAt: '2026-08-31T20:00:00.000Z',
    connectionId: 'conn-1',
    server: 'Test DB',
    database: 'test.db',
    sql: 'SELECT * FROM users',
    durationMs: 12,
    success: true,
    rowCount: 3
  }

  beforeEach(() => {
    useAppStore.setState({
      connections: [sqliteConn],
      openSessions: {},
      tabs: [],
      activeTabId: null,
      historyEntries: []
    })
  })

  it('laadt de geschiedenis via window.nvag.history.list', async () => {
    mockNvag({ history: [historyEntry] })
    await useAppStore.getState().loadHistory()
    expect(useAppStore.getState().historyEntries).toHaveLength(1)
    expect(useAppStore.getState().historyEntries[0]?.server).toBe('Test DB')
  })

  it('doorzoekt de geschiedenis op zoektekst', async () => {
    mockNvag({
      history: [
        historyEntry,
        { ...historyEntry, id: 2, sql: 'UPDATE logs SET seen=1', server: 'Andere server' }
      ]
    })
    await useAppStore.getState().loadHistory('users')
    const entries = useAppStore.getState().historyEntries
    expect(entries).toHaveLength(1)
    expect(entries[0]?.sql).toContain('users')
  })

  it('wist de geschiedenis via clearHistory', async () => {
    mockNvag({ history: [historyEntry] })
    await useAppStore.getState().loadHistory()
    expect(useAppStore.getState().historyEntries).toHaveLength(1)
    await useAppStore.getState().clearHistory()
    expect(useAppStore.getState().historyEntries).toHaveLength(0)
  })

  it('heruitvoert een entry: nieuwe tab met SQL + verbinding, draait met open sessie', async () => {
    const { queried } = mockNvag({ history: [historyEntry] })
    // Sessie open zodat rerun direct draait.
    useAppStore.setState({ openSessions: { 'conn-1': { config: sqliteConn, sessionId: 's1', serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' } } } })
    await useAppStore.getState().rerunHistoryEntry(historyEntry)

    const state = useAppStore.getState()
    const tab = state.tabs[0]
    expect(tab.sql).toBe('SELECT * FROM users')
    expect(tab.connectionId).toBe('conn-1')
    expect(state.activeTabId).toBe(tab.id)
    expect(queried).toEqual([{ connectionId: 'conn-1', sql: 'SELECT * FROM users' }])
  })

  it('heruitvoert een entry zonder open sessie: opent alleen de tab', async () => {
    const { queried } = mockNvag({ history: [historyEntry] })
    await useAppStore.getState().rerunHistoryEntry(historyEntry)
    expect(useAppStore.getState().tabs[0].sql).toBe('SELECT * FROM users')
    expect(queried).toHaveLength(0)
  })
})
