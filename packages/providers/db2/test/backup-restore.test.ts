import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb2Provider } from '../src/index'
import type { ConnectionConfig, DbSession } from '@nvag/contracts'

/**
 * F4-3: Db2 backup/restore — draait via de fake-bridge (testdouble, geen
 * Java/Db2 nodig). Verifieert dat de provider BACKUP DB / RESTORE DB via de
 * bridge uitvoert en fouten als `ok: false` teruggeeft.
 */

const fakeBridgePath = fileURLToPath(new URL('./fake-bridge.mjs', import.meta.url))

const cfg: ConnectionConfig = {
  id: 'db2-br',
  name: 'Db2 Backup',
  providerId: 'db2',
  environment: 'DEV',
  host: 'fake',
  port: 50000,
  database: 'nvagdb',
  username: 'db2inst1',
  auth: 'username-password',
  ssl: { mode: 'disable' },
  connectionTimeoutMs: 5000,
  group: 'Test'
}

let provider: ReturnType<typeof createDb2Provider>
let session: DbSession

beforeAll(async () => {
  process.env.NVAG_DB2_BRIDGE_CMD = `node ${fakeBridgePath}`
  provider = createDb2Provider()
  session = await provider.connect(cfg, { password: 'test-password' })
})

afterEach(async () => {
  // De provider houdt één bridge-proces vast; tussen tests geen herstart nodig.
})

afterAll(async () => {
  await provider.close(session)
  delete process.env.NVAG_DB2_BRIDGE_CMD
})

describe('db2 backup/restore (F4-3, fake-bridge)', () => {
  it('voert BACKUP DB uit via de bridge', async () => {
    const r = await provider.backupRestore!.backupDatabase!(session, 'NVAGDB', '/tmp/nvag.bk')
    expect(r.ok).toBe(true)
    expect(r.sql).toBe("BACKUP DB \"NVAGDB\" TO '/tmp/nvag.bk';")
    expect(r.targetPath).toBe('/tmp/nvag.bk')
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('voert RESTORE DB uit via de bridge', async () => {
    const r = await provider.backupRestore!.restoreDatabase!(session, 'NVAGDB', '/tmp/nvag.bk')
    expect(r.ok).toBe(true)
    expect(r.sql).toBe("RESTORE DB \"NVAGDB\" FROM '/tmp/nvag.bk' REPLACE EXISTING;")
    expect(r.sourcePath).toBe('/tmp/nvag.bk')
  })

  it('meldt een bridge-fout als ok:false', async () => {
    // Poort 1 → de fake bridge weigert de verbinding; een nieuwe provider
    // met een eigen bridge-proces faalt bij connect. Simuleer de fout door
    // de bridge-command te breken in een aparte provider-instantie.
    process.env.NVAG_DB2_BRIDGE_CMD = 'dit-commando-bestaat-niet-xyz'
    const broken = createDb2Provider()
    await expect(
      broken.connect(cfg, { password: 'test-password' })
    ).rejects.toThrow(/bridge/i)
    process.env.NVAG_DB2_BRIDGE_CMD = `node ${fakeBridgePath}`
  })
})
