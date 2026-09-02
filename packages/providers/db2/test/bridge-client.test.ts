import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BridgeClient } from '../src/bridge-client'

// Isolatie (SAL-37): de jcc-zoekpaden mogen niet afhangen van een toevallig
// aanwezige jcc.jar op de machine (~/.nvag/db2jcc/jcc.jar). homedir() wijst
// naar een niet-bestaande map zodat de "geen jcc.jar"-test deterministisch is
// (de NVAG_DB2_BRIDGE_CMD-tests raken dit niet: die overslaan jcc-discovery).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => join(tmpdir(), 'nvag-db2jcc-home-doet-niet-bestaan')
  }
})

const fakeBridgePath = fileURLToPath(new URL('./fake-bridge.mjs', import.meta.url))
const fakeCmd = `node ${fakeBridgePath}`

let current: BridgeClient | null = null
afterEach(async () => {
  if (current) {
    await current.stop()
    current = null
  }
})

describe('BridgeClient (db2, protocol)', () => {
  it('voert request uit en retourneert het resultaat', async () => {
    process.env.NVAG_DB2_BRIDGE_CMD = fakeCmd
    const client = new BridgeClient()
    current = client
    const r = await client.request<{ connId: string }>('connect', {
      url: 'jdbc:db2://fake:50000/nvagdb:loginTimeout=5;',
      user: 'db2inst1',
      password: 'test-password',
      connectionTimeoutMs: 5000
    })
    expect(typeof r.connId).toBe('string')
    expect(r.connId.length).toBeGreaterThan(0)

    const info = await client.request<{ dbmsName: string; dbmsVersion: string }>('serverInfo', {
      connId: r.connId
    })
    expect(info.dbmsName).toMatch(/DB2/i)
    expect(info.dbmsVersion).toMatch(/\S/)
    await client.request('close', { connId: r.connId })
  })

  it('streamt columns, rows en done voor een query', async () => {
    process.env.NVAG_DB2_BRIDGE_CMD = fakeCmd
    const client = new BridgeClient()
    current = client
    const { connId } = await client.request<{ connId: string }>('connect', {
      url: 'jdbc:db2://fake:50000/nvagdb:loginTimeout=5;',
      user: 'db2inst1',
      password: 'test-password',
      connectionTimeoutMs: 5000
    })
    const events: string[] = []
    let rows = 0
    for await (const evt of client.executeQuery(connId, 'SELECT * FROM "contract_dml"', 1000)) {
      events.push(evt.kind)
      if (evt.kind === 'rows') rows += evt.rows.length
    }
    expect(events).toEqual(['columns', 'rows', 'done'])
    expect(rows).toBe(3)
  })

  it('respecteert maxRows (provider stuurt FETCH FIRST mee)', async () => {
    process.env.NVAG_DB2_BRIDGE_CMD = fakeCmd
    const client = new BridgeClient()
    current = client
    const { connId } = await client.request<{ connId: string }>('connect', {
      url: 'jdbc:db2://fake:50000/nvagdb:loginTimeout=5;',
      user: 'db2inst1',
      password: 'test-password',
      connectionTimeoutMs: 5000
    })
    let rows = 0
    // De provider past de cap toe vóór de bridge; de bridge stuurt maxRows
    // als extra veiligheidsnet mee.
    for await (const evt of client.executeQuery(
      connId,
      'SELECT * FROM "contract_dml" FETCH FIRST 1 ROWS ONLY',
      1
    )) {
      if (evt.kind === 'rows') rows += evt.rows.length
    }
    expect(rows).toBe(1)
  })

  it('meldt een query-fout als error-event', async () => {
    process.env.NVAG_DB2_BRIDGE_CMD = fakeCmd
    const client = new BridgeClient()
    current = client
    const { connId } = await client.request<{ connId: string }>('connect', {
      url: 'jdbc:db2://fake:50000/nvagdb:loginTimeout=5;',
      user: 'db2inst1',
      password: 'test-password',
      connectionTimeoutMs: 5000
    })
    const errors: string[] = []
    for await (const evt of client.executeQuery(connId, 'SELEC x FROM "contract_dml"', 1000)) {
      if (evt.kind === 'error') errors.push(evt.message)
    }
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/SQLERRMC=SELEC/)
  })

  it('geeft een duidelijke fout wanneer de bridge niet te starten is', async () => {
    process.env.NVAG_DB2_BRIDGE_CMD = 'dit-commando-bestaat-niet-xyz'
    const client = new BridgeClient()
    current = client
    await expect(
      client.request('connect', {
        url: 'jdbc:db2://fake:50000/nvagdb:loginTimeout=5;',
        user: 'u',
        password: 'p',
        connectionTimeoutMs: 5000
      })
    ).rejects.toThrow(/bridge/i)
  })

  it('meldt een ontbrekende jcc.jar (zonder bridge-override)', async () => {
    delete process.env.NVAG_DB2_BRIDGE_CMD
    process.env.NVAG_DB2_JCC_JAR = '/pad/dat/niet/bestaat/jcc.jar'
    try {
      const client = new BridgeClient()
      current = client
      await expect(
        client.request('connect', {
          url: 'jdbc:db2://fake:50000/nvagdb:loginTimeout=5;',
          user: 'u',
          password: 'p',
          connectionTimeoutMs: 5000
        })
      ).rejects.toThrow(/jcc\.jar/i)
    } finally {
      delete process.env.NVAG_DB2_JCC_JAR
    }
  })
})
