/**
 * F2-2: Transactions (eis 23) — TransactionManager met echte SQLite-sessie.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteProvider } from '@nvag/provider-sqlite'
import type { ConnectionConfig, DbSession } from '@nvag/contracts'
import { TransactionManager } from './transactions'
import { sessionManager } from './session-manager'
import { registry } from './registry'

let dir: string
let config: ConnectionConfig
let session: DbSession
let manager: TransactionManager
let sessionId: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nvag-tx-'))
  const dbPath = join(dir, 'tx.db')
  const provider = createSqliteProvider()
  registry.register(provider)
  config = {
    id: 'conn-tx',
    name: 'Tx Test',
    providerId: 'sqlite',
    environment: 'DEV',
    host: dbPath,
    auth: 'username-password',
    ssl: { mode: 'disable' },
    connectionTimeoutMs: 5000,
    createIfMissing: true,
    group: 'Test'
  }
  session = await provider.connect(config)
  const opened = await sessionManager.open(config)
  sessionId = opened.sessionId
  for await (const chunk of provider.executeQuery(session, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)', {})) {
    if (chunk.kind === 'error') throw new Error(chunk.message)
  }
  manager = new TransactionManager()
})

afterAll(async () => {
  await sessionManager.close(sessionId)
  await sessionManager.closeAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('F2-2 TransactionManager', () => {
  it('start met status none', () => {
    expect(manager.status('conn-tx').state).toBe('none')
  })

  it('BEGIN zet de status op active', async () => {
    const s = await manager.begin('conn-tx')
    expect(s.state).toBe('active')
  })

  it('commit voert COMMIT uit en zet status terug op none', async () => {
    await manager.begin('conn-tx')
    // Schrijf binnen de transactie (zelfde sessie als de manager).
    const sessionForTx = sessionManager.getByConnectionId('conn-tx')
    if (!sessionForTx) throw new Error('no session')
    const { registry: reg } = await import('./registry')
    const provider = reg.get('sqlite')
    for await (const chunk of provider.executeQuery(sessionForTx, "INSERT INTO t (v) VALUES ('x')", {})) {
      if (chunk.kind === 'error') throw new Error(chunk.message)
    }
    const s = await manager.commit('conn-tx')
    expect(s.state).toBe('none')
  })

  it('rollback maakt de wijziging ongedaan', async () => {
    await manager.begin('conn-tx')
    const sessionForTx = sessionManager.getByConnectionId('conn-tx')
    if (!sessionForTx) throw new Error('no session')
    const { registry: reg } = await import('./registry')
    const provider = reg.get('sqlite')
    for await (const chunk of provider.executeQuery(sessionForTx, "INSERT INTO t (v) VALUES ('y')", {})) {
      if (chunk.kind === 'error') throw new Error(chunk.message)
    }
    await manager.rollback('conn-tx')
    // Na rollback is de rij weg.
    let count = -1
    for await (const chunk of provider.executeQuery(sessionForTx, 'SELECT COUNT(*) AS n FROM t', {})) {
      if (chunk.kind === 'rows') count = Number(chunk.rows[0]?.values[0] ?? -1)
    }
    expect(count).toBe(1) // alleen 'x' van de commit-test
  })

  it('begin op een actieve transactie is idempotent', async () => {
    await manager.begin('conn-tx')
    const s = await manager.begin('conn-tx')
    expect(s.state).toBe('active')
    await manager.rollback('conn-tx')
  })

  it('gooit bij commit zonder sessie', async () => {
    await expect(manager.commit('conn-bestaat-niet')).rejects.toThrow('No active session')
  })

  it('clear zet de status terug', async () => {
    await manager.begin('conn-tx')
    manager.clear('conn-tx')
    expect(manager.status('conn-tx').state).toBe('none')
    await manager.rollback('conn-tx').catch(() => undefined)
  })
})
