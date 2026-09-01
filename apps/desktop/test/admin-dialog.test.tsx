/**
 * F2-3: AdminDialog — environment-safety guard-flow in de UI
 * (warn-doorloop voor CREATE, confirm-blokkade + bevestiging voor DROP).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AdminDialog } from '../src/renderer/src/components/AdminDialog'
import { useAppStore } from '../src/renderer/src/state/store'
import { createMockNvag, sampleConnection } from '../src/renderer/src/test/mockNvag'
import type { AdminActionResult } from '@nvag/contracts'

const conn = sampleConnection({ id: 'conn-1', name: 'Admin Test' })

function renderDialog(): ReturnType<typeof createMockNvag> {
  const api = createMockNvag({ connections: [conn] })
  ;(window as unknown as { nvag: unknown }).nvag = api
  useAppStore.setState({
    connections: [conn],
    openSessions: {
      'conn-1': {
        config: conn,
        sessionId: 's1',
        serverInfo: { providerId: 'sqlite', providerName: 'SQLite', serverVersion: '3', currentDatabase: 'test.db' }
      }
    },
    showAdminDialog: true
  })
  render(<AdminDialog connectionId="conn-1" />)
  return api
}

beforeEach(() => {
  cleanup()
  useAppStore.setState({
    connections: [],
    openSessions: {},
    tabs: [],
    activeTabId: null,
    showAdminDialog: false,
    adminCapabilities: null,
    adminUsers: []
  })
})

describe('F2-3 AdminDialog guard-flow', () => {
  it('toont bij een confirm-blokkade (DROP) de bevestigingsdialoog en voert na bevestiging uit', async () => {
    const api = renderDialog()
    const drop = vi.fn(async (_connId: string, _db: string, _schema: string, table: string, confirmed?: boolean): Promise<AdminActionResult> => {
      if (confirmed) return { ok: true, sql: `DROP TABLE "${table}";` }
      return { ok: false, sql: `DROP TABLE "${table}";`, blocked: ['DROP-statement'], guardSeverity: 'confirm' }
    })
    api.admin.dropTable = drop

    // Naar het Tabellen-tabblad
    fireEvent.click(await screen.findByRole('tab', { name: 'Tabellen' }))
    const nameInput = screen.getByPlaceholderText('naam')
    fireEvent.change(nameInput, { target: { value: 'klanten' } })

    fireEvent.click(screen.getByRole('button', { name: 'Tabel verwijderen' }))

    // Zonder bevestiging: actie wordt NIET opnieuw uitgevoerd, dialoog toont SQL + reden.
    await waitFor(() => expect(screen.getByText(/DROP-statement/)).toBeTruthy())
    expect(screen.getByText('De volgende SQL wordt uitgevoerd:')).toBeTruthy()
    expect(screen.getByText('DROP TABLE "klanten";')).toBeTruthy()
    expect(drop).toHaveBeenCalledTimes(1)
    expect(drop).toHaveBeenLastCalledWith('conn-1', '', 'main', 'klanten', undefined)

    // Bevestigen → opnieuw met confirmed:true → succesmelding.
    fireEvent.click(screen.getByRole('button', { name: 'Toch uitvoeren' }))
    await waitFor(() => expect(drop).toHaveBeenCalledTimes(2))
    expect(drop).toHaveBeenLastCalledWith('conn-1', '', 'main', 'klanten', true)
    expect(await screen.findByText(/✅ DROP TABLE klanten/)).toBeTruthy()
  })

  it('toont bij een warn-niveau (CREATE) een waarschuwing zonder bevestiging', async () => {
    const api = renderDialog()
    api.admin.createTable = vi.fn(
      async (): Promise<AdminActionResult> => ({
        ok: true,
        sql: 'CREATE TABLE "klanten" (id INTEGER PRIMARY KEY);',
        warning: ['CREATE-statement']
      })
    )

    fireEvent.click(await screen.findByRole('tab', { name: 'Tabellen' }))
    fireEvent.change(screen.getByPlaceholderText('naam'), { target: { value: 'klanten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Creëren' }))

    // Geen bevestigingsdialoog, wél een waarschuwing in het resultaat.
    await waitFor(() => expect(screen.getByText(/✅ CREATE TABLE klanten/)).toBeTruthy())
    expect(screen.getByText(/⚠ CREATE-statement/)).toBeTruthy()
    expect(screen.queryByText('De volgende SQL wordt uitgevoerd:')).toBeNull()
  })

  it('toont een fout wanneer de admin-actie faalt', async () => {
    const api = renderDialog()
    api.admin.createTable = vi.fn(async () => {
      throw new Error('SQLite: tabel bestaat al')
    })

    fireEvent.click(await screen.findByRole('tab', { name: 'Tabellen' }))
    fireEvent.change(screen.getByPlaceholderText('naam'), { target: { value: 'klanten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Creëren' }))

    await waitFor(() => expect(screen.getByText(/❌ SQLite: tabel bestaat al/)).toBeTruthy())
  })
})
