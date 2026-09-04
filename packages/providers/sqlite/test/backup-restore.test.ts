import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteProvider } from '../src/index'
import type { ConnectionConfig, DbSession } from '@nvag/contracts'

/**
 * F4-4: SQLite backup/restore — echte bestandsoperaties (VACUUM INTO /
 * bestandskopie + heropenen). Verifieert dat een backup een consistente
 * snapshot is en dat restore de database terugzet.
 */

let dir: string
let dbPath: string
let backupPath: string

const cfg: ConnectionConfig = {
  id: 'br-1',
  name: 'Backup Test',
  providerId: 'sqlite',
  environment: 'DEV',
  host: '',
  auth: 'username-password',
  ssl: { mode: 'disable' },
  connectionTimeoutMs: 5000,
  createIfMissing: true,
  group: 'Test'
}

let provider: ReturnType<typeof createSqliteProvider>
let session: DbSession

async function countRows(): Promise<number> {
  let n = -1
  for await (const chunk of provider.executeQuery(session, 'SELECT COUNT(*) AS n FROM items', {})) {
    if (chunk.kind === 'rows' && chunk.rows.length > 0) n = Number(chunk.rows[0]?.values[0] ?? -1)
  }
  return n
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nvag-br-'))
  dbPath = join(dir, 'br.db')
  backupPath = join(dir, 'br-backup.db')
  cfg.host = dbPath
  provider = createSqliteProvider()
  session = await provider.connect(cfg)
  // Fixture: tabel + 2 rijen.
  for await (const _c of provider.executeQuery(session, 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)', {})) { /* drain */ }
  for await (const _c of provider.executeQuery(session, "INSERT INTO items (name) VALUES ('a'), ('b')", {})) { /* drain */ }
})

afterAll(async () => {
  await provider.close(session)
  rmSync(dir, { recursive: true, force: true })
})

describe('sqlite backup/restore (F4-4)', () => {
  it('adverteert supportsBackupRestore', () => {
    expect(provider.capabilities.supportsBackupRestore).toBe(true)
  })

  it('maakt een backup via VACUUM INTO', async () => {
    const r = await provider.backupRestore!.backupDatabase!(session, 'main', backupPath)
    expect(r.ok).toBe(true)
    expect(existsSync(backupPath)).toBe(true)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('weigert een backup over een bestaand bestand zonder overwrite', async () => {
    const r = await provider.backupRestore!.backupDatabase!(session, 'main', backupPath)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/already exists/)
  })

  it('overschrijft een bestaand bestand met overwrite', async () => {
    const r = await provider.backupRestore!.backupDatabase!(session, 'main', backupPath, { overwrite: true })
    expect(r.ok).toBe(true)
  })

  it('restore zet de database terug naar de snapshot', async () => {
    // Mutatie na de backup: rij verwijderen.
    for await (const _c of provider.executeQuery(session, "DELETE FROM items WHERE name = 'b'", {})) { /* drain */ }
    expect(await countRows()).toBe(1)

    // Restore → beide rijen terug.
    const r = await provider.backupRestore!.restoreDatabase!(session, 'main', backupPath)
    expect(r.ok).toBe(true)
    expect(await countRows()).toBe(2)

    // De sessie is na restore nog bruikbaar (heropend).
    for await (const _c of provider.executeQuery(session, "INSERT INTO items (name) VALUES ('c')", {})) { /* drain */ }
    expect(await countRows()).toBe(3)
  })

  it('meldt een ontbrekend backupbestand bij restore', async () => {
    const r = await provider.backupRestore!.restoreDatabase!(session, 'main', join(dir, 'nope.db'))
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not found/)
  })
})
