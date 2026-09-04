import { beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryGuardDialog } from '../src/renderer/src/components/QueryGuardDialog'
import { ObjectExplorer } from '../src/renderer/src/components/ObjectExplorer'
import { useAppStore } from '../src/renderer/src/state/store'
import { createMockNvag, sampleConnection } from '../src/renderer/src/test/mockNvag'

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

beforeEach(() => {
  cleanup()
  resetStore()
})

describe('QueryGuardDialog (F1-8)', () => {
  it('toont niets zonder wachtende query', () => {
    const { container } = render(<QueryGuardDialog />)
    expect(container.textContent).toBe('')
  })

  it('toont de omgeving, redenen en SQL van de geblokkeerde query', () => {
    useAppStore.setState({
      pendingGuard: {
        tabId: 'tab-1',
        sql: 'DELETE FROM klanten;',
        reasons: ['DELETE/UPDATE zonder WHERE'],
        environment: 'PROD'
      }
    })
    render(<QueryGuardDialog />)
    expect(screen.getByText('PROD')).toBeTruthy()
    expect(screen.getByText('Production: always confirm')).toBeTruthy()
    expect(screen.getByText('DELETE/UPDATE zonder WHERE')).toBeTruthy()
    expect(screen.getByText('DELETE FROM klanten;')).toBeTruthy()
    expect(screen.getByText('Run anyway')).toBeTruthy()
  })

  it('annuleert de geblokkeerde query via de Annuleren-knop', () => {
    useAppStore.setState({
      pendingGuard: {
        tabId: 'tab-1',
        sql: 'DROP TABLE klanten;',
        reasons: ['DROP-statement'],
        environment: 'DEV'
      }
    })
    render(<QueryGuardDialog />)
    fireEvent.click(screen.getByText('Cancel'))
    expect(useAppStore.getState().pendingGuard).toBeNull()
  })

  it('voert de query alsnog uit met confirmed: true via de bevestigingsknop', async () => {
    const mock = createMockNvag({
      connections: [sampleConnection()],
      queryResults: {
        'DELETE FROM klanten;': { executionId: 'e1', columns: [], rows: [], truncated: false, rowCount: 2, durationMs: 1 }
      }
    })
    window.nvag = mock
    useAppStore.setState({
      connections: [sampleConnection()],
      openSessions: {
        'conn-1': {
          config: sampleConnection(),
          sessionId: 's1',
          serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' }
        }
      },
      tabs: [
        {
          id: 'tab-1',
          title: 'Query 1',
          sql: 'DELETE FROM klanten;',
          connectionId: 'conn-1',
          result: null,
          running: false,
          executionId: null,
          startedAt: null
        }
      ],
      activeTabId: 'tab-1',
      pendingGuard: {
        tabId: 'tab-1',
        sql: 'DELETE FROM klanten;',
        reasons: ['DELETE/UPDATE zonder WHERE'],
        environment: 'PROD'
      }
    })
    render(<QueryGuardDialog />)
    fireEvent.click(screen.getByText('Run anyway'))
    // confirmGuardQuery is async; wacht op de run-aanvraag met confirmed: true.
    await waitFor(() => {
      expect(mock.runRequests.length).toBeGreaterThanOrEqual(1)
    })
    expect(mock.runRequests.map((r) => r.confirmed)).toEqual([true])
    expect(useAppStore.getState().pendingGuard).toBeNull()
    const tab = useAppStore.getState().tabs.find((t) => t.id === 'tab-1')
    expect(tab?.result?.rowCount).toBe(2)
  })
})

describe('ObjectExplorer env-badge (F1-8)', () => {
  it('toont een kleurbadge op de server-node', () => {
    const prod = sampleConnection({ id: 'conn-prod', name: 'PROD-DB', environment: 'PROD' })
    useAppStore.setState({
      connections: [prod],
      openSessions: {
        'conn-prod': {
          config: prod,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3.53.1' }
        }
      }
    })
    const { container } = render(<ObjectExplorer />)
    expect(container.textContent).toContain('PROD-DB')
    expect(container.textContent).toContain('PROD')
    expect(container.querySelector('.env-badge')?.textContent).toBe('PROD')
  })
})
