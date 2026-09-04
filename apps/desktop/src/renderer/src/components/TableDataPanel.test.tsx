/**
 * F2-1/SAL-42: Tabelgegevens-paneel — error-state, timeout-gerelateerde
 * statussen en auto-load wanneer de sessie opengaat (geen eeuwige "Laden…").
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ConnectionConfig, TableDataResult } from '@nvag/contracts'
import { TableDataPanel } from './TableDataPanel'
import { useAppStore } from '../state/store'
import { createMockNvag } from '../test/mockNvag'

const conn: ConnectionConfig = {
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

const sampleResult: TableDataResult = {
  columns: [{ name: 'id' }],
  rows: [{ values: [1] }],
  truncated: false,
  rowCount: 1,
  primaryKey: ['id'],
  editableColumns: ['id']
}

interface SeedOptions {
  openSession?: boolean
  data?: TableDataResult | null
  loading?: boolean
  error?: string | null
}

function seedStore(opts: SeedOptions = {}): void {
  const open = opts.openSession ?? true
  useAppStore.setState({
    connections: [conn],
    openSessions: open
      ? { 'conn-1': { config: conn, sessionId: 's1', serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1', currentDatabase: '/tmp/test.db' } } }
      : {},
    tabs: [
      {
        id: 'td1',
        title: 'users — data',
        sql: '',
        connectionId: 'conn-1',
        database: '/tmp/test.db',
        result: null,
        running: false,
        executionId: null,
        startedAt: null,
        kind: 'table-data',
        tableData: {
          database: '/tmp/test.db',
          schema: 'main',
          table: 'users',
          data: opts.data ?? null,
          loading: opts.loading ?? false,
          error: opts.error ?? null,
          inserting: false,
          pendingEdit: null,
          lastEditMessage: null,
          lastSql: null
        }
      }
    ],
    activeTabId: 'td1'
  })
}

function installMock(getRows: () => Promise<TableDataResult>): void {
  const api = createMockNvag({ connections: [conn] })
  api.tableData.getRows = getRows
  ;(window as unknown as { nvag: unknown }).nvag = api
}

describe('TableDataPanel (SAL-42)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    seedStore()
  })

  it('toont "Laden…" zolang de load bezig is', () => {
    seedStore({ loading: true })
    render(<TableDataPanel tabId="td1" />)
    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('toont de fout met "Opnieuw laden" i.p.v. een eeuwige "Laden…"', async () => {
    seedStore({ error: 'netwerkfout' })
    render(<TableDataPanel tabId="td1" />)
    expect(screen.getByText(/netwerkfout/)).toBeTruthy()
    expect(screen.getByText('Failed to load table data: netwerkfout')).toBeTruthy()

    // Fout hersteld + opnieuw laden → rijen verschijnen en de fout is weg.
    installMock(async () => sampleResult)
    fireEvent.click(screen.getByText('Reload'))
    await waitFor(() => expect(screen.getByText('id')).toBeTruthy())
    expect(screen.queryByText(/netwerkfout/)).toBeNull()
  })

  it('toont een duidelijke melding wanneer er geen sessie is (geen stille spinner)', () => {
    seedStore({ openSession: false })
    render(<TableDataPanel tabId="td1" />)
    expect(screen.getByText(/No active connection for this table/)).toBeTruthy()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('laadt automatisch zodra de sessie opengaat', async () => {
    seedStore({ openSession: false })
    installMock(async () => sampleResult)
    render(<TableDataPanel tabId="td1" />)
    expect(screen.getByText(/No active connection for this table/)).toBeTruthy()

    // De verbinding wordt geopend → het paneel laadt de rijen vanzelf.
    await act(async () => {
      await useAppStore.getState().openSession(conn)
    })
    await waitFor(() => expect(screen.getByText('id')).toBeTruthy())
    expect(screen.queryByText(/No active connection for this table/)).toBeNull()
  })

  it('toont een refresh-fout boven het grid maar houdt de geladen rijen zichtbaar', async () => {
    seedStore({ data: sampleResult })
    render(<TableDataPanel tabId="td1" />)
    expect(screen.getByText('id')).toBeTruthy()

    installMock(async () => {
      throw new Error('refresh kapot')
    })
    await act(async () => {
      await useAppStore.getState().loadTableRows('td1')
    })
    // Grid blijft staan; de fout is als banner zichtbaar.
    expect(screen.getByText('id')).toBeTruthy()
    expect(screen.getByText(/Refresh failed: refresh kapot/)).toBeTruthy()
  })
})
