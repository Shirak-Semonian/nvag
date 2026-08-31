import { spawnSync } from 'node:child_process'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { runProviderContractTests } from '@nvag/contract-tests'
import { createDb2Provider } from '../src/index'
import { javaBinary, resolveJccJar } from '../src/jcc'
import { createDb2Harness, getDb2TestConfig, type Db2TestConfig } from './db2-harness'

/**
 * Contracttests Db2 (SAL-22).
 * Draaien alleen wanneer NVAG_TEST_DB2_URL (of NVAG_TEST_DB2_*) is gezet,
 * de JDBC-bridge kan starten (java + jcc.jar) én de server bereikbaar is;
 * anders worden ze overgeslagen. Zie docker-compose.dev.yml → service `db2`
 * en src/bridge/README.md.
 */
function portOpen(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: timeoutMs })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => {
      sock.destroy()
      resolve(false)
    })
  })
}

async function db2TestAvailable(cfg: Db2TestConfig): Promise<boolean> {
  if (!process.env.NVAG_DB2_BRIDGE_CMD && !resolveJccJar()) return false
  const java = spawnSync(javaBinary(), ['-version'], { timeout: 5000 })
  if (java.error || java.status !== 0) return false
  return portOpen(cfg.host, cfg.port)
}

const cfg = getDb2TestConfig()
const enabled = cfg !== null ? await db2TestAvailable(cfg) : false

runProviderContractTests(createDb2Harness(cfg!), { enabled })

describe('db2 provider — specifiek', () => {
  it('testConnection faalt zonder server (config zonder verbinding)', async () => {
    const provider = createDb2Provider()
    const r = await provider.testConnection({
      id: 'x',
      name: 'x',
      providerId: 'db2',
      environment: 'TEST',
      host: '127.0.0.1',
      port: 1,
      database: 'nope',
      username: 'nope',
      auth: 'username-password',
      ssl: { mode: 'disable' },
      connectionTimeoutMs: 500,
      group: 'Test'
    })
    expect(r.ok).toBe(false)
  })

  it('exposeert db2-dialect en capabilities', () => {
    const provider = createDb2Provider()
    expect(provider.id).toBe('db2')
    expect(provider.capabilities.dialect).toBe('db2')
    expect(provider.capabilities.supportsSchemas).toBe(true)
    expect(provider.capabilities.supportsSequences).toBe(true)
    expect(provider.capabilities.supportsTriggers).toBe(true)
    expect(provider.defaultPort).toBe(50000)
  })

  it('weigert connect zonder database', async () => {
    const provider = createDb2Provider()
    await expect(
      provider.connect({
        id: 'x',
        name: 'x',
        providerId: 'db2',
        environment: 'TEST',
        host: '127.0.0.1',
        username: 'nope',
        auth: 'username-password',
        ssl: { mode: 'disable' },
        connectionTimeoutMs: 500,
        group: 'Test'
      })
    ).rejects.toThrow(/database/i)
  })
})
