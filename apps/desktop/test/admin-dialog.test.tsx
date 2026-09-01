/**
 * F2-3: AdminDialog — environment-safety guard-flow in de UI
 * (warn-doorloop voor CREATE, confirm-blokkade + bevestiging voor DROP).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AdminDialog } from '../src/renderer/src/components/AdminDialog'
import { useAppStore } from '../src/renderer/src/state/store'
import { createMockNvag, sampleConnection } from '../src/renderer/src/test/mockNvag'
import type { AdminActionResult, ProviderCapabilities } from '@nvag/contracts'

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

describe('F4 AdminDialog backup/restore', () => {
  function renderWithCapabilities(caps: Partial<ProviderCapabilities>): ReturnType<typeof createMockNvag> {
    const api = createMockNvag({ connections: [conn] })
    ;(window as unknown as { nvag: unknown }).nvag = api
    const full: ProviderCapabilities = {
      supportsSchemas: true,
      supportsSequences: false,
      supportsSynonyms: false,
      supportsTriggers: true,
      supportsExecutionPlans: false,
      supportsMonitoring: false,
      supportsTransactions: true,
      supportsIdentityColumns: true,
      supportsGeneratedColumns: true,
      supportsDdlAdmin: true,
      supportsUsersAndRoles: false,
      supportsBackupRestore: true,
      maxResultRowsDefault: 1000,
      dialect: 'sqlite',
      ...caps
    }
    api.admin.capabilities = vi.fn(async () => full)
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

  it('toont het Backup-tabblad wanneer de provider backup/restore ondersteunt', async () => {
    renderWithCapabilities({})
    const tab = await screen.findByRole('tab', { name: 'Backup' })
    expect(tab.getAttribute('disabled')).toBeNull()
    fireEvent.click(tab)
    expect(await screen.findByText('Backup maken')).toBeTruthy()
    expect(screen.getByText('Herstellen')).toBeTruthy()
  })

  it('verbergt/disablet het Backup-tabblad wanneer niet ondersteund', async () => {
    renderWithCapabilities({ supportsBackupRestore: false })
    const tab = await screen.findByRole('tab', { name: 'Backup' })
    expect(tab.getAttribute('disabled')).not.toBeNull()
  })

  it('voert een backup uit en toont het pad', async () => {
    const api = renderWithCapabilities({})
    const backup = vi.fn(async (_connId: string, _db: string, _path: string): Promise<{ ok: boolean; targetPath: string; durationMs: number }> => ({
      ok: true,
      targetPath: '/tmp/backup.db',
      durationMs: 12
    }))
    api.admin.backupDatabase = backup

    fireEvent.click(await screen.findByRole('tab', { name: 'Backup' }))
    fireEvent.change(screen.getByPlaceholderText('bijv. main / SalesDB'), { target: { value: 'main' } })
    fireEvent.change(screen.getByPlaceholderText('/pad/naar/backup.db'), { target: { value: '/tmp/backup.db' } })
    fireEvent.click(screen.getByRole('button', { name: 'Backup maken' }))

    await waitFor(() => expect(backup).toHaveBeenCalledWith('conn-1', 'main', '/tmp/backup.db', undefined))
    expect(await screen.findByText(/✅ BACKUP main → \/tmp\/backup\.db/)).toBeTruthy()
    expect(screen.getByText(/12 ms/)).toBeTruthy()
  })

  it('toont bij een restore-confirm-blokkade de bevestigingsdialoog en voert na bevestiging uit', async () => {
    const api = renderWithCapabilities({})
    const restore = vi.fn(async (_connId: string, _db: string, _path: string, confirmed?: boolean): Promise<{
      ok: boolean
      sourcePath: string
      durationMs: number
      blocked?: string[]
      guardSeverity?: 'confirm'
    }> => {
      if (confirmed) return { ok: true, sourcePath: '/tmp/backup.db', durationMs: 5 }
      return { ok: false, sourcePath: '/tmp/backup.db', durationMs: 0, blocked: ['RESTORE-statement'], guardSeverity: 'confirm' }
    })
    api.admin.restoreDatabase = restore

    fireEvent.click(await screen.findByRole('tab', { name: 'Backup' }))
    fireEvent.change(screen.getByPlaceholderText('bijv. main / SalesDB'), { target: { value: 'main' } })
    fireEvent.change(screen.getByPlaceholderText('/pad/naar/bron-backup.db'), { target: { value: '/tmp/backup.db' } })
    fireEvent.click(screen.getByRole('button', { name: 'Herstellen' }))

    await waitFor(() => expect(screen.getByText(/RESTORE-statement/)).toBeTruthy())
    expect(restore).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Toch uitvoeren' }))
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
    expect(restore).toHaveBeenLastCalledWith('conn-1', 'main', '/tmp/backup.db', true)
    expect(await screen.findByText(/✅ RESTORE main ← \/tmp\/backup\.db/)).toBeTruthy()
  })
})
