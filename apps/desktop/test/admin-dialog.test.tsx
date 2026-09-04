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
    fireEvent.click(await screen.findByRole('tab', { name: 'Tables' }))
    const nameInput = screen.getByPlaceholderText('name')
    fireEvent.change(nameInput, { target: { value: 'klanten' } })

    fireEvent.click(screen.getByRole('button', { name: 'Drop table' }))

    // Zonder bevestiging: actie wordt NIET opnieuw uitgevoerd, dialoog toont SQL + reden.
    await waitFor(() => expect(screen.getByText(/DROP-statement/)).toBeTruthy())
    expect(screen.getByText('The following SQL will be executed:')).toBeTruthy()
    expect(screen.getByText('DROP TABLE "klanten";')).toBeTruthy()
    expect(drop).toHaveBeenCalledTimes(1)
    expect(drop).toHaveBeenLastCalledWith('conn-1', '', 'main', 'klanten', undefined)

    // Bevestigen → opnieuw met confirmed:true → succesmelding.
    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }))
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

    fireEvent.click(await screen.findByRole('tab', { name: 'Tables' }))
    fireEvent.change(screen.getByPlaceholderText('name'), { target: { value: 'klanten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    // Geen bevestigingsdialoog, wél een waarschuwing in het resultaat.
    await waitFor(() => expect(screen.getByText(/✅ CREATE TABLE klanten/)).toBeTruthy())
    expect(screen.getByText(/⚠ CREATE-statement/)).toBeTruthy()
    expect(screen.queryByText('The following SQL will be executed:')).toBeNull()
  })

  it('toont een fout wanneer de admin-actie faalt', async () => {
    const api = renderDialog()
    api.admin.createTable = vi.fn(async () => {
      throw new Error('SQLite: table already exists')
    })

    fireEvent.click(await screen.findByRole('tab', { name: 'Tables' }))
    fireEvent.change(screen.getByPlaceholderText('name'), { target: { value: 'klanten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(screen.getByText(/❌ SQLite: table already exists/)).toBeTruthy())
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
    expect(await screen.findByText('Create backup')).toBeTruthy()
    expect(screen.getByText('Restore')).toBeTruthy()
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
    fireEvent.change(screen.getByPlaceholderText('e.g. main / SalesDB'), { target: { value: 'main' } })
    fireEvent.change(screen.getByPlaceholderText('/path/to/backup.db'), { target: { value: '/tmp/backup.db' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create backup' }))

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
    fireEvent.change(screen.getByPlaceholderText('e.g. main / SalesDB'), { target: { value: 'main' } })
    fireEvent.change(screen.getByPlaceholderText('/path/to/source-backup.db'), { target: { value: '/tmp/backup.db' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(screen.getByText(/RESTORE-statement/)).toBeTruthy())
    expect(restore).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }))
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2))
    expect(restore).toHaveBeenLastCalledWith('conn-1', 'main', '/tmp/backup.db', true)
    expect(await screen.findByText(/✅ RESTORE main ← \/tmp\/backup\.db/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// SAL-51: database-context + datatype-dropdown in de Admin-dialoog
// (tabel aanmaken op de doeldatabase i.p.v. sessie-database/master; type-veld
// is een combobox met dialect-correcte types).
// ---------------------------------------------------------------------------

const TSQL_CAPS: ProviderCapabilities = {
  supportsSchemas: true,
  supportsSequences: true,
  supportsSynonyms: true,
  supportsTriggers: true,
  supportsExecutionPlans: false,
  supportsMonitoring: false,
  supportsTransactions: true,
  supportsIdentityColumns: true,
  supportsGeneratedColumns: true,
  supportsDdlAdmin: true,
  supportsUsersAndRoles: true,
  supportsBackupRestore: true,
  maxResultRowsDefault: 1000,
  dialect: 'tsql'
}

describe('SAL-51 AdminDialog database-context + datatype-dropdown', () => {
  function renderTsqlDialog(initialDatabase: string | null): ReturnType<typeof createMockNvag> {
    const api = createMockNvag({
      connections: [conn],
      databases: [{ name: 'master' }, { name: 'Klanten' }, { name: 'Factuur' }]
    })
    api.admin.capabilities = vi.fn(async () => TSQL_CAPS)
    ;(window as unknown as { nvag: unknown }).nvag = api
    useAppStore.setState({
      connections: [conn],
      openSessions: {
        'conn-1': {
          config: conn,
          sessionId: 's1',
          serverInfo: { providerId: 'sqlserver', providerName: 'SQL Server', serverVersion: '2022', currentDatabase: 'master' }
        }
      },
      showAdminDialog: true,
      adminDialogTab: 'table',
      adminDialogDatabase: initialDatabase
    })
    render(<AdminDialog connectionId="conn-1" />)
    return api
  }

  it('toont de doeldatabase-dropdown met de database van de open-actie en geeft die door aan CREATE TABLE', async () => {
    const api = renderTsqlDialog('Factuur')

    // Tabellen-tab (via store geopend): database-context zichtbaar.
    fireEvent.click(await screen.findByRole('tab', { name: 'Tables' }))
    await waitFor(() => {
      const select = screen.getByLabelText('Target database') as HTMLSelectElement
      expect(select.value).toBe('Factuur')
    })

    const createTable = vi.fn(
      async (_req: { connectionId: string; database: string }, _confirmed?: boolean): Promise<AdminActionResult> => ({
        ok: true,
        sql: 'CREATE TABLE [Factuur].[dbo].[facturen] (...);'
      })
    )
    api.admin.createTable = createTable
    fireEvent.change(screen.getByPlaceholderText('name'), { target: { value: 'facturen' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(createTable).toHaveBeenCalledTimes(1))
    const req = createTable.mock.calls[0]?.[0] as { database: string }
    expect(req.database).toBe('Factuur')

    // De database-dropdown kan wisselen naar een andere database.
    fireEvent.change(screen.getByLabelText('Target database'), { target: { value: 'Klanten' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(createTable).toHaveBeenCalledTimes(2))
    expect((createTable.mock.calls[1]?.[0] as { database: string }).database).toBe('Klanten')
  })

  it('toont geen database-dropdown voor sqlite (database = verbinding)', () => {
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
      showAdminDialog: true,
      adminDialogTab: 'table'
    })
    render(<AdminDialog connectionId="conn-1" />)
    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }))
    expect(screen.queryByLabelText('Target database')).toBeNull()
    expect(api.admin.createTable).toBeTruthy()
  })

  it('type-veld is een combobox met dialect-correcte types (tsql) en eigen invoer blijft mogelijk', async () => {
    renderTsqlDialog(null)

    fireEvent.click(await screen.findByRole('tab', { name: 'Tables' }))
    await waitFor(() => expect(screen.getByPlaceholderText('name')).toBeTruthy())

    // Standaardkolom heeft een tsql-passend type (int, niet INTEGER/TEXT).
    await waitFor(() => expect(screen.getByDisplayValue('int')).toBeTruthy())
    const typeInput = screen.getByDisplayValue('int') as HTMLInputElement
    expect(typeInput.getAttribute('list')).toBe('admin-datatypes-conn-1')

    // Datalist bevat dialect-correcte types (nvarchar/datetime2 …).
    const datalist = document.getElementById('admin-datatypes-conn-1')
    const options = datalist ? Array.from(datalist.querySelectorAll('option')).map((o) => o.getAttribute('value')) : []
    expect(options).toContain('nvarchar')
    expect(options).toContain('datetime2')
    expect(options).toContain('uniqueidentifier')
    // Geen postgres/mysql-lek in de tsql-lijst.
    expect(options).not.toContain('jsonb')

    // Eigen type typen blijft mogelijk (combobox, geen harde select).
    fireEvent.change(typeInput, { target: { value: 'geometry' } })
    expect((screen.getByDisplayValue('geometry') as HTMLInputElement).value).toBe('geometry')
  })

  it('toont per actief dialect de juiste types (postgres + mysql + sqlite)', async () => {
    const dialogs: { caps: ProviderCapabilities; expectIn: string[]; expectNotIn: string[] }[] = [
      {
        caps: { ...TSQL_CAPS, dialect: 'postgres' },
        expectIn: ['integer', 'text', 'jsonb', 'uuid'],
        expectNotIn: ['nvarchar', 'uniqueidentifier']
      },
      {
        caps: { ...TSQL_CAPS, dialect: 'mysql' },
        expectIn: ['int', 'varchar', 'json', 'blob'],
        expectNotIn: ['jsonb', 'uuid']
      },
      {
        caps: { ...TSQL_CAPS, dialect: 'sqlite' },
        expectIn: ['INTEGER', 'TEXT', 'BLOB'],
        expectNotIn: ['nvarchar', 'jsonb']
      }
    ]
    for (const { caps, expectIn, expectNotIn } of dialogs) {
      cleanup()
      useAppStore.setState({ showAdminDialog: false, adminCapabilities: null, adminUsers: [] })
      const api = createMockNvag({ connections: [conn] })
      api.admin.capabilities = vi.fn(async () => caps)
      ;(window as unknown as { nvag: unknown }).nvag = api
      useAppStore.setState({
        connections: [conn],
        openSessions: {
          'conn-1': {
            config: conn,
            sessionId: 's1',
            serverInfo: { providerId: caps.dialect === 'postgres' ? 'postgresql' : caps.dialect === 'mysql' ? 'mysql' : 'sqlite', providerName: caps.dialect, serverVersion: '1', currentDatabase: 'test.db' }
          }
        },
        showAdminDialog: true,
        adminDialogTab: 'table'
      })
      render(<AdminDialog connectionId="conn-1" />)
      fireEvent.click(await screen.findByRole('tab', { name: 'Tables' }))
      await waitFor(() => expect(screen.getByPlaceholderText('name')).toBeTruthy())

      const readOptions = (): (string | null)[] => {
        const datalist = document.getElementById('admin-datatypes-conn-1')
        return datalist ? Array.from(datalist.querySelectorAll('option')).map((o) => o.getAttribute('value')) : []
      }
      // Wacht tot de capabilities zijn geladen en de lijst het actieve dialect toont.
      await waitFor(() => expect(readOptions()).toContain(expectIn[0]))
      const options = readOptions()
      for (const t of expectIn) expect(options).toContain(t)
      for (const t of expectNotIn) expect(options).not.toContain(t)
    }
  })
})
