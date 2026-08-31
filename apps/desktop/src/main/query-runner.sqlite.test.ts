import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteProvider } from '@nvag/provider-sqlite'
import type { ConnectionConfig, DbSession, QueryChunk } from '@nvag/contracts'
import { QueryRunner } from './query-runner'
import { sessionManager } from './session-manager'
import { registry } from './registry'

/**
 * Integratie (SAL-17): echte SQLite-provider + echte QueryRunner.
 * Bewijst de hele keten provider → runner → IPC-chunks: streaming,
 * maxRows-cap (standaard 1.000) en error-position.
 */

interface SentEvent {
  executionId: string
  chunk: QueryChunk
}

const sent: SentEvent[] = []
const sender = {
  send: (channel: string, evt: SentEvent): void => {
    if (channel === 'query:chunk') sent.push(evt)
  },
  isDestroyed: () => false
}

let dir: string
let dbPath: string
let provider: ReturnType<typeof createSqliteProvider>
let session: DbSession

function config(host: string): ConnectionConfig {
  return {
    id: 'conn-sqlite',
    name: 'SQLite-test',
    providerId: 'sqlite',
    environment: 'DEV',
    host,
    auth: 'username-password',
    ssl: { mode: 'disable' },
    connectionTimeoutMs: 5000,
    createIfMissing: true,
    group: 'Test'
  }
}

async function collect(runner: QueryRunner, sql: string): Promise<SentEvent[]> {
  sent.length = 0
  const { executionId } = runner.run({ connectionId: 'conn-sqlite', sql }, sender)
  await runner.start(executionId)
  return [...sent]
}

beforeEach(async () => {
  vi.restoreAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'nvag-sqlite-'))
  dbPath = join(dir, 'test.db')
  provider = createSqliteProvider()
  session = await provider.connect(config(dbPath))
  vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(session)
  vi.spyOn(registry, 'get').mockReturnValue(provider)

  const { db } = session.handle as { db: import('node:sqlite').DatabaseSync }
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, naam TEXT)')
  db.exec(`INSERT INTO users (naam) VALUES ('Jan'), ('Piet')`)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('QueryRunner + SQLite-provider integratie (SAL-17)', () => {
  it('streamt echte SELECT-resultaten met kolommen en rijen', async () => {
    const runner = new QueryRunner()
    const events = await collect(runner, 'SELECT id, naam FROM users ORDER BY id')

    const kinds = events.map((e) => e.chunk.kind)
    expect(kinds).toEqual(['columns', 'rows', 'done'])
    const columns = events[0]?.chunk
    expect(columns).toMatchObject({
      kind: 'columns',
      columns: [
        { name: 'id' },
        { name: 'naam' }
      ]
    })
    const rows = events[1]?.chunk
    expect(rows).toMatchObject({
      kind: 'rows',
      rows: [{ values: [1, 'Jan'] }, { values: [2, 'Piet'] }]
    })
    expect(events[2]?.chunk).toMatchObject({ kind: 'done', rowCount: 2 })
  })

  it('past de standaard maxRows-cap van 1.000 toe', async () => {
    const { db } = session.handle as { db: import('node:sqlite').DatabaseSync }
    const stmt = db.prepare('INSERT INTO users (naam) VALUES (?)')
    for (let i = 0; i < 1500; i++) stmt.run(`rij-${i}`)

    const runner = new QueryRunner()
    const events = await collect(runner, 'SELECT id FROM users')

    const totalRows = events.reduce(
      (n, e) => n + (e.chunk.kind === 'rows' ? e.chunk.rows.length : 0),
      0
    )
    expect(totalRows).toBe(1000)
    const done = events[events.length - 1]?.chunk
    expect(done).toMatchObject({ kind: 'done', rowCount: 1000 })
  })

  it('levert error-position bij ongeldige SQL (dialect-parsing)', async () => {
    const runner = new QueryRunner()
    const events = await collect(runner, 'SELECT bestaatiniet FROM users')

    const error = events.find((e) => e.chunk.kind === 'error')?.chunk
    expect(error).toBeDefined()
    if (error?.kind === 'error') {
      expect(error.message).toMatch(/no such column/i)
      expect(error.position).toBeDefined()
    }
  })

  it('geeft DML-rowcount door zonder kolommen', async () => {
    const runner = new QueryRunner()
    const events = await collect(runner, "UPDATE users SET naam = 'X' WHERE id = 1")

    expect(events.map((e) => e.chunk.kind)).toEqual(['done'])
    expect(events[0]?.chunk).toMatchObject({ kind: 'done', rowCount: 1 })
  })
})
