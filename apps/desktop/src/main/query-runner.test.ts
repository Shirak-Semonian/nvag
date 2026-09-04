import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DatabaseProvider,
  DbSession,
  ProviderCapabilities,
  QueryChunk
} from '@nvag/contracts'
import { QueryRunner } from './query-runner'
import { sessionManager } from './session-manager'
import { registry } from './registry'

/**
 * QueryRunner (main process, SAL-17): streamt provider-chunks naar de renderer
 * over IPC, dwingt maxRows af, stuurt warning bij truncation en beëindigt op
 * cancel met done(cancelled).
 */

interface SentEvent {
  executionId: string
  chunk: QueryChunk
}

function fakeSender(): { sender: { send: (channel: string, evt: SentEvent) => void; isDestroyed: () => boolean }; sent: SentEvent[] } {
  const sent: SentEvent[] = []
  const sender = {
    send: (channel: string, evt: SentEvent): void => {
      if (channel === 'query:chunk') sent.push(evt)
    },
    isDestroyed: () => false
  }
  return { sender, sent }
}

const FAKE_SESSION: DbSession = {
  handle: {},
  connectionId: 'conn-1',
  providerId: 'sqlite',
  database: 'test.db'
}

function baseCapabilities(maxResultRowsDefault: number): ProviderCapabilities {
  return {
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
    supportsBackupRestore: false,
    maxResultRowsDefault,
    dialect: 'sqlite'
  }
}

function fakeProvider(
  iter: AsyncIterable<QueryChunk>,
  opts: {
    maxResultRowsDefault?: number
    onCancel?: () => void
    onExecuteQuery?: (opts: unknown) => void
    cancelError?: Error
  } = {}
): DatabaseProvider {
  return {
    id: 'sqlite',
    displayName: 'SQLite',
    defaultPort: 0,
    capabilities: baseCapabilities(opts.maxResultRowsDefault ?? 1000),
    connect: async () => FAKE_SESSION,
    testConnection: async () => ({ ok: true }),
    getServerInfo: async () => ({
      providerId: 'sqlite',
      providerName: 'SQLite',
      serverVersion: '3.53.1'
    }),
    close: async () => {},
    listDatabases: async () => [],
    listSchemas: async () => [],
    listTables: async () => [],
    listViews: async () => [],
    listProcedures: async () => [],
    listFunctions: async () => [],
    listTriggers: async () => [],
    listSequences: async () => [],
    listSynonyms: async () => [],
    listUsers: async () => [],
    listRoles: async () => [],
    getTableMetadata: async () => ({
      columns: [],
      primaryKey: [],
      foreignKeys: [],
      indexes: [],
      constraints: [],
      triggers: [],
      dependencies: []
    }),
    getObjectDefinition: async () => 'SELECT 1;',
    executeQuery: (_session, _sql, qopts) => {
      opts.onExecuteQuery?.(qopts)
      return iter
    },
    cancel: opts.cancelError
      ? async () => {
          throw opts.cancelError
        }
      : opts.onCancel
        ? async () => opts.onCancel?.()
        : async () => {},
    getExecutionStats: async () => ({ rowCount: 0, durationMs: 0 })
  }
}

async function* simpleStream(): AsyncIterable<QueryChunk> {
  yield { kind: 'columns', columns: [{ name: 'id' }] }
  yield { kind: 'rows', rows: [{ values: [1] }, { values: [2] }] }
  yield { kind: 'done', rowCount: 2, durationMs: 3 }
}

function totalRowsSent(sent: SentEvent[]): number {
  return sent.reduce((n, e) => n + (e.chunk.kind === 'rows' ? e.chunk.rows.length : 0), 0)
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('QueryRunner (main, SAL-17)', () => {
  it('registreert een uitvoering en streamt chunks naar de window', async () => {
    const { sender, sent } = fakeSender()
    vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(FAKE_SESSION)
    vi.spyOn(registry, 'get').mockReturnValue(fakeProvider(simpleStream()))

    const runner = new QueryRunner()
    const { executionId } = runner.run({ connectionId: 'conn-1', sql: 'SELECT 1' }, sender)
    expect(executionId).toBeTruthy()
    expect(runner.activeCount).toBe(1)

    await runner.start(executionId)
    expect(sent.map((e) => e.chunk.kind)).toEqual(['columns', 'rows', 'done'])
    expect(runner.activeCount).toBe(0)
    const done = sent[sent.length - 1]?.chunk
    expect(done).toMatchObject({ kind: 'done', rowCount: 2, truncated: false, cancelled: false })
  })

  it('gooit zonder actieve sessie', () => {
    const { sender } = fakeSender()
    vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(undefined)
    const runner = new QueryRunner()
    expect(() => runner.run({ connectionId: 'conn-1', sql: 'SELECT 1' }, sender)).toThrow(
      /No active session/
    )
  })

  it('kapt af op maxRows en stuurt een warning-chunk', async () => {
    const { sender, sent } = fakeSender()
    vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(FAKE_SESSION)
    const provider = fakeProvider(
      (async function* (): AsyncIterable<QueryChunk> {
        yield { kind: 'columns', columns: [{ name: 'id' }] }
        yield { kind: 'rows', rows: [{ values: [1] }, { values: [2] }] }
        yield { kind: 'rows', rows: [{ values: [3] }, { values: [4] }, { values: [5] }] }
        yield { kind: 'done', rowCount: 5, durationMs: 1 }
      })(),
      { maxResultRowsDefault: 3 }
    )
    vi.spyOn(registry, 'get').mockReturnValue(provider)

    const runner = new QueryRunner()
    const { executionId } = runner.run({ connectionId: 'conn-1', sql: 'SELECT 1' }, sender)
    await runner.start(executionId)

    expect(totalRowsSent(sent)).toBe(3)
    expect(sent.filter((e) => e.chunk.kind === 'warning').length).toBeGreaterThanOrEqual(1)
    const done = sent[sent.length - 1]?.chunk
    expect(done).toMatchObject({ kind: 'done', truncated: true })
  })

  it('annuleert een draaiende uitvoering en stuurt done(cancelled)', async () => {
    const { sender, sent } = fakeSender()
    vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(FAKE_SESSION)
    const onCancel = vi.fn()
    const provider = fakeProvider(
      (async function* (): AsyncIterable<QueryChunk> {
        yield { kind: 'columns', columns: [{ name: 'id' }] }
        yield { kind: 'rows', rows: [{ values: [1] }] }
        await new Promise((r) => setTimeout(r, 20))
        yield { kind: 'rows', rows: [{ values: [2] }] }
        yield { kind: 'done', rowCount: 2, durationMs: 1 }
      })(),
      { onCancel }
    )
    vi.spyOn(registry, 'get').mockReturnValue(provider)

    const runner = new QueryRunner()
    const { executionId } = runner.run({ connectionId: 'conn-1', sql: 'SELECT 1' }, sender)
    const startPromise = runner.start(executionId)

    // Laat de eerste rows binnenkomen, annuleer dan middenin de stream.
    await new Promise((r) => setTimeout(r, 5))
    expect(sent.filter((e) => e.chunk.kind === 'rows').length).toBe(1)

    await runner.cancel(executionId)
    expect(onCancel).toHaveBeenCalled()
    await startPromise

    const kinds = sent.map((e) => e.chunk.kind)
    expect(kinds).toContain('done')
    const done = sent[sent.length - 1]?.chunk
    expect(done).toMatchObject({ kind: 'done', cancelled: true })
    // De tweede rows-chunk wordt niet meer verstuurd.
    expect(totalRowsSent(sent)).toBe(1)
  })

  it('geeft error-chunks door en stopt de uitvoering', async () => {
    const { sender, sent } = fakeSender()
    vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(FAKE_SESSION)
    const provider = fakeProvider(
      (async function* (): AsyncIterable<QueryChunk> {
        yield { kind: 'columns', columns: [{ name: 'id' }] }
        yield { kind: 'error', message: 'near "FOUT": syntax error', position: { line: 1, column: 8 } }
        yield { kind: 'done', rowCount: 0, durationMs: 1 }
      })()
    )
    vi.spyOn(registry, 'get').mockReturnValue(provider)

    const runner = new QueryRunner()
    const { executionId } = runner.run({ connectionId: 'conn-1', sql: 'SELECT FOUT' }, sender)
    await runner.start(executionId)

    expect(sent.map((e) => e.chunk.kind)).toEqual(['columns', 'error'])
    const error = sent[1]?.chunk
    expect(error).toMatchObject({ kind: 'error', position: { line: 1, column: 8 } })
  })

  // ------------------------------------------------------------------ SAL-33
  // Echte cancel: executionId + signal naar de provider, provider.cancel()
  // wordt aangeroepen, de stream breekt af en de status is done(cancelled).
  // ------------------------------------------------------------------

  it('geeft executionId en signal door aan executeQuery (SAL-33)', async () => {
    const { sender } = fakeSender()
    vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(FAKE_SESSION)
    let captured: { executionId?: string; signal?: AbortSignal } = {}
    const provider = fakeProvider(simpleStream(), {
      onExecuteQuery: (qopts) => {
        captured = qopts as { executionId?: string; signal?: AbortSignal }
      }
    })
    vi.spyOn(registry, 'get').mockReturnValue(provider)

    const runner = new QueryRunner()
    const { executionId } = runner.run({ connectionId: 'conn-1', sql: 'SELECT 1' }, sender)
    await runner.start(executionId)

    expect(captured.executionId).toBe(executionId)
    expect(captured.signal).toBeInstanceOf(AbortSignal)
  })

  it('annuleren breekt de provider-iterable af via het abort-signaal (geen hang)', async () => {
    const { sender, sent } = fakeSender()
    vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(FAKE_SESSION)
    const onCancel = vi.fn()
    // Generator die (net als de echte providers) wacht op het abort-signaal:
    // zodra abort afgaat, eindigt de wacht en stopt de stream.
    let signalRef: AbortSignal | undefined
    const iter: AsyncIterable<QueryChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { kind: 'columns', columns: [{ name: 'id' }] }
        yield { kind: 'rows', rows: [{ values: [1] }] }
        await new Promise<void>((resolve) => {
          if (signalRef?.aborted) return resolve()
          signalRef?.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { kind: 'rows', rows: [{ values: [2] }] }
        yield { kind: 'done', rowCount: 2, durationMs: 1 }
      }
    }
    const provider = fakeProvider(iter, {
      onCancel,
      onExecuteQuery: (qopts) => {
        signalRef = (qopts as { signal?: AbortSignal }).signal
      }
    })
    vi.spyOn(registry, 'get').mockReturnValue(provider)

    const runner = new QueryRunner()
    const { executionId } = runner.run({ connectionId: 'conn-1', sql: 'SELECT 1' }, sender)
    const startPromise = runner.start(executionId)

    await new Promise((r) => setTimeout(r, 5))
    expect(sent.filter((e) => e.chunk.kind === 'rows').length).toBe(1)

    await runner.cancel(executionId)
    expect(onCancel).toHaveBeenCalled()
    await startPromise

    expect(runner.activeCount).toBe(0)
    const done = sent[sent.length - 1]?.chunk
    expect(done).toMatchObject({ kind: 'done', cancelled: true })
    // De tweede rows-chunk wordt niet meer verstuurd.
    expect(totalRowsSent(sent)).toBe(1)
  })

  it('annuleert vóór start: done(cancelled) zonder de provider-query te starten', async () => {
    const { sender, sent } = fakeSender()
    vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(FAKE_SESSION)
    const onExecuteQuery = vi.fn()
    const provider = fakeProvider(simpleStream(), { onExecuteQuery })
    vi.spyOn(registry, 'get').mockReturnValue(provider)

    const runner = new QueryRunner()
    const { executionId } = runner.run({ connectionId: 'conn-1', sql: 'SELECT 1' }, sender)
    await runner.cancel(executionId)
    await runner.start(executionId)

    expect(onExecuteQuery).not.toHaveBeenCalled()
    const done = sent[sent.length - 1]?.chunk
    expect(done).toMatchObject({ kind: 'done', cancelled: true })
    expect(runner.activeCount).toBe(0)
  })

  it('stuurt een warning-chunk wanneer de provider-cancel faalt (geen stille no-op)', async () => {
    const { sender, sent } = fakeSender()
    vi.spyOn(sessionManager, 'getByConnectionId').mockReturnValue(FAKE_SESSION)
    let signalRef: AbortSignal | undefined
    const iter: AsyncIterable<QueryChunk> = {
      async *[Symbol.asyncIterator]() {
        yield { kind: 'columns', columns: [{ name: 'id' }] }
        await new Promise<void>((resolve) => {
          if (signalRef?.aborted) return resolve()
          signalRef?.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { kind: 'done', rowCount: 0, durationMs: 1 }
      }
    }
    const provider = fakeProvider(iter, {
      cancelError: new Error('cancellation not supported by provider X'),
      onExecuteQuery: (qopts) => {
        signalRef = (qopts as { signal?: AbortSignal }).signal
      }
    })
    vi.spyOn(registry, 'get').mockReturnValue(provider)

    const runner = new QueryRunner()
    const { executionId } = runner.run({ connectionId: 'conn-1', sql: 'SELECT 1' }, sender)
    const startPromise = runner.start(executionId)

    await new Promise((r) => setTimeout(r, 5))
    await runner.cancel(executionId)
    await startPromise

    const warnings = sent.filter((e) => e.chunk.kind === 'warning')
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    const warning = warnings[0]!.chunk
    expect(warning).toMatchObject({ kind: 'warning' })
    if (warning.kind === 'warning') {
      expect(warning.message).toMatch(/not fully supported/)
      expect(warning.message).toMatch(/provider X/)
    }
    // De uitvoering eindigt lokaal als geannuleerd (met de duidelijke melding).
    const done = sent[sent.length - 1]?.chunk
    expect(done).toMatchObject({ kind: 'done', cancelled: true })
    expect(runner.activeCount).toBe(0)
  })
})
