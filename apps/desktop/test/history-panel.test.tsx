import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { HistoryEntry } from '@nvag/contracts'
import { HistoryPanel } from '../src/renderer/src/components/HistoryPanel'
import { useAppStore } from '../src/renderer/src/state/store'

function mockHistoryNvag(entries: HistoryEntry[]) {
  const list = vi.fn(async (query?: string, _limit?: number) => {
    if (!query) return [...entries]
    const q = query.toLowerCase()
    return entries.filter(
      (e) =>
        e.sql.toLowerCase().includes(q) ||
        e.server.toLowerCase().includes(q) ||
        e.database.toLowerCase().includes(q)
    )
  })
  const clear = vi.fn(async () => {})
  ;(window as unknown as { nvag: unknown }).nvag = {
    history: { list, clear }
  } as never
  return { list, clear }
}

const entries: HistoryEntry[] = [
  {
    id: 1,
    executedAt: '2026-08-31T20:00:00.000Z',
    connectionId: 'conn-1',
    server: 'SQL-DEV',
    database: 'klanten',
    sql: 'SELECT * FROM users',
    durationMs: 12,
    success: true,
    rowCount: 3
  },
  {
    id: 2,
    executedAt: '2026-08-31T19:00:00.000Z',
    connectionId: 'conn-1',
    server: 'SQL-DEV',
    database: 'klanten',
    sql: 'UPDATE logs SET seen=1',
    durationMs: 45,
    success: false,
    error: 'near "SET": syntax error',
    rowCount: 0
  }
]

describe('HistoryPanel (eis 19)', () => {
  beforeEach(() => {
    cleanup()
    useAppStore.setState({
      connections: [],
      openSessions: {},
      tabs: [],
      activeTabId: null,
      historyEntries: [],
      recentQueries: []
    })
  })

  it('toont geladen uitvoeringen met tijd, server, status, duur en rowcount', async () => {
    mockHistoryNvag(entries)
    render(<HistoryPanel />)
    await waitFor(() => expect(screen.getByText('SELECT * FROM users')).toBeTruthy())
    expect(screen.getAllByText('SQL-DEV').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/12 ms · 3 row\(s\)/)).toBeTruthy()
    expect(screen.getByText('UPDATE logs SET seen=1')).toBeTruthy()
    expect(screen.getByText(/45 ms · 0 row\(s\)/)).toBeTruthy()
  })

  it('toont de foutmelding van een mislukte uitvoering', async () => {
    mockHistoryNvag(entries)
    render(<HistoryPanel />)
    await waitFor(() => expect(screen.getByText(/syntax error/)).toBeTruthy())
  })

  it('toont lege staat wanneer er geen uitvoeringen zijn', async () => {
    mockHistoryNvag([])
    render(<HistoryPanel />)
    await waitFor(() => expect(screen.getByText(/No SQL executions yet/)).toBeTruthy())
  })

  it('zoekt op zoektekst via Enter', async () => {
    const { list } = mockHistoryNvag(entries)
    render(<HistoryPanel />)
    await waitFor(() => expect(screen.getByText('SELECT * FROM users')).toBeTruthy())

    fireEvent.change(screen.getByLabelText('Search history'), {
      target: { value: 'users' }
    })
    fireEvent.keyDown(screen.getByLabelText('Search history'), { key: 'Enter' })
    await waitFor(() => expect(list).toHaveBeenCalledWith('users', 100))
  })

  it('toont geen resultaten bij een zoekopdracht zonder treffers', async () => {
    mockHistoryNvag(entries)
    render(<HistoryPanel />)
    await waitFor(() => expect(screen.getByText('SELECT * FROM users')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Search history'), {
      target: { value: 'bestaat-niet' }
    })
    fireEvent.keyDown(screen.getByLabelText('Search history'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByText(/No executions found/)).toBeTruthy())
  })

  it('wist de geschiedenis via de wissen-knop', async () => {
    const { clear } = mockHistoryNvag(entries)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<HistoryPanel />)
    await waitFor(() => expect(screen.getByText('SELECT * FROM users')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Clear history'))
    await waitFor(() => expect(clear).toHaveBeenCalled())
  })
})
