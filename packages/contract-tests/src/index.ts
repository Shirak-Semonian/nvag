/**
 * @nvag/contract-tests — generieke, provider-agnostische contracttests.
 *
 * Elke DatabaseProvider (SAL-6-contract, ADR-002) kan dezelfde suite draaien
 * via `runProviderContractTests(harness)`. De suite dekt de lessen uit SAL-8:
 * DML, eigen LIMIT (geen dubbele clausule), multi-statement-beleid.
 *
 * Niet-ondersteunde capabilities worden overgeslagen (`skips`), zodat dezelfde
 * suite straks ook op MSSQL/DB2 groen draait.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import type {
  ConnectionConfig,
  DatabaseProvider,
  DbSession,
  ProviderCapabilities,
  QueryChunk,
  QueryRow,
  SqlDialectId
} from '@nvag/contracts'
import { splitStatements } from '@nvag/sql-dialect'

export interface ProviderContractHarness {
  /** Naam voor testrapportage, bijv. 'sqlite'. */
  name: string
  dialect: SqlDialectId
  /** Provider-instantie (nieuw per suite-run). */
  createProvider(): DatabaseProvider
  /** Config die naar een lege testdatabase wijst. */
  createConfig(): ConnectionConfig
  /**
   * Dialect-specifiek fixturescript (CREATE TABLE + rijen). Meerdere
   * statements zijn toegestaan; de suite splitst en voert ze één voor één uit.
   */
  fixtureSql: string
  quoteIdentifier(name: string): string
  /** Tabel die DML-tests gebruiken; moet door fixtureSql bestaan met >= 3 rijen. */
  dmlTable: string
  /** Tabel die metadata-tests gebruiken; moet door fixtureSql bestaan. */
  metadataTable: string
  /** Verwachte kolommen van metadataTable. */
  metadataTableColumns: string[]
  /** Dialect-correcte query met eigen limiet (bijv. `SELECT TOP (2) * FROM t`). */
  makeLimitQuery(table: string, n: number): string
  /** Standaard maxRows-cap van de provider (default 1000). */
  maxRows?: number
  /** Multi-statement-beleid: weigeren (MULTIPLE_STATEMENTS) of toestaan. */
  multipleStatements?: 'reject' | 'allow'
  /** Tests die voor deze provider niet gelden. */
  skips?: {
    /** Error-positie in foutmelding wordt niet geleverd. */
    errorPosition?: boolean
    /** getObjectDefinition wordt niet ondersteund. */
    objectDefinition?: boolean
  }
}

export interface ContractTestOptions {
  /** Zet op false wanneer er geen testserver beschikbaar is (suite wordt geskipt). */
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Collected {
  columns: QueryChunk & { kind: 'columns' } | null
  rows: QueryRow[]
  done: (QueryChunk & { kind: 'done' }) | null
  errors: (QueryChunk & { kind: 'error' })[]
}

async function collect(
  iter: AsyncIterable<QueryChunk>
): Promise<Collected> {
  const out: Collected = { columns: null, rows: [], done: null, errors: [] }
  for await (const chunk of iter) {
    if (chunk.kind === 'columns') out.columns = chunk
    else if (chunk.kind === 'rows') out.rows.push(...chunk.rows)
    else if (chunk.kind === 'done') out.done = chunk
    else if (chunk.kind === 'error') out.errors.push(chunk)
  }
  return out
}

async function runFixture(
  provider: DatabaseProvider,
  session: DbSession,
  fixtureSql: string
): Promise<void> {
  for (const stmt of splitStatements(fixtureSql)) {
    const result = await collect(provider.executeQuery(session, stmt, {}))
    if (result.errors.length > 0) {
      throw new Error(
        `Fixture-statement mislukt: ${stmt}\n  ${result.errors.map((e) => e.message).join('; ')}`
      )
    }
  }
}

// ---------------------------------------------------------------------------
// De generieke suite
// ---------------------------------------------------------------------------

export function runProviderContractTests(
  harness: ProviderContractHarness,
  options: ContractTestOptions = {}
): void {
  const name = harness.name
  const skips = harness.skips ?? {}
  const enabled = options.enabled ?? true
  const describeFn = enabled ? describe : describe.skip

  describeFn(`contract — ${name} provider`, () => {
    let provider: DatabaseProvider
    let config: ConnectionConfig
    let session: DbSession

    beforeAll(async () => {
      provider = harness.createProvider()
      config = harness.createConfig()
      session = await provider.connect(config)
      await runFixture(provider, session, harness.fixtureSql)
    })

    afterAll(async () => {
      if (session) await provider.close(session)
    })

    describe('connectie', () => {
      it('connecteert en levert een sessie met providerId', async () => {
        const s = await provider.connect(config)
        expect(s.providerId).toBe(provider.id)
        expect(s.database).toBeTruthy()
        await provider.close(s)
      })

      it('testConnection slaagt op geldige config', async () => {
        const r = await provider.testConnection(config)
        expect(r.ok).toBe(true)
        expect(r.serverInfo?.providerName).toBeTruthy()
      })

      it('levert serverinfo met versie', async () => {
        const info = await provider.getServerInfo(session)
        expect(info.providerId).toBe(provider.id)
        expect(info.serverVersion).toMatch(/\S/)
      })
    })

    describe('metadata', () => {
      it('lijst databases (minimaal 1)', async () => {
        const dbs = await provider.listDatabases(session)
        expect(dbs.length).toBeGreaterThanOrEqual(1)
      })

      it('lijst tabellen inclusief dml/metadata-tabel', async () => {
        const tables = await provider.listTables(session, session.database)
        const names = tables.map((t) => t.name)
        expect(names).toContain(harness.dmlTable)
        expect(names).toContain(harness.metadataTable)
      })

      it('levert tabelmetadata met verwachte kolommen', async () => {
        const meta = await provider.getTableMetadata(
          session,
          session.database,
          'main',
          harness.metadataTable
        )
        const cols = meta.columns.map((c) => c.name)
        for (const expected of harness.metadataTableColumns) {
          expect(cols).toContain(expected)
        }
      })

      it('levert objectdefinitie voor tabel', async () => {
        if (skips.objectDefinition) return
        const def = await provider.getObjectDefinition(session, {
          type: 'table',
          database: session.database,
          schema: 'main',
          name: harness.metadataTable
        })
        expect(def.toLowerCase()).toContain('create')
      })
    })

    describe('query-uitvoering', () => {
      it('voert SELECT uit en streamt kolommen + rijen', async () => {
        const r = await collect(
          provider.executeQuery(session, `SELECT * FROM ${harness.quoteIdentifier(harness.dmlTable)}`, {})
        )
        expect(r.errors).toHaveLength(0)
        expect(r.columns?.columns.length).toBeGreaterThan(0)
        expect(r.rows.length).toBeGreaterThanOrEqual(3)
        expect(r.done?.rowCount).toBe(r.rows.length)
      })

      it('respecteert maxRows-cap', async () => {
        const r = await collect(
          provider.executeQuery(session, `SELECT * FROM ${harness.quoteIdentifier(harness.dmlTable)}`, { maxRows: 1 })
        )
        expect(r.errors).toHaveLength(0)
        expect(r.rows.length).toBe(1)
      })

      it('voert SELECT met eigen LIMIT uit zonder dubbele clausule', async () => {
        const r = await collect(provider.executeQuery(session, harness.makeLimitQuery(harness.dmlTable, 2), {}))
        expect(r.errors).toHaveLength(0)
        expect(r.rows.length).toBe(2)
      })

      it('meldt een syntaxfout als error-chunk', async () => {
        const r = await collect(
          provider.executeQuery(session, `SELEC x FROM ${harness.quoteIdentifier(harness.dmlTable)}`, {})
        )
        expect(r.errors.length).toBeGreaterThan(0)
        expect(r.errors[0]?.message.length).toBeGreaterThan(0)
      })

      it('levert error-positie (indien ondersteund)', async () => {
        if (skips.errorPosition) return
        const r = await collect(
          provider.executeQuery(session, `SELEC x FROM ${harness.quoteIdentifier(harness.dmlTable)}`, {})
        )
        expect(r.errors[0]?.position).toBeTruthy()
      })
    })

    describe('DML', () => {
      it('voert INSERT uit en rapporteert changes', async () => {
        const r = await collect(
          provider.executeQuery(
            session,
            `INSERT INTO ${harness.quoteIdentifier(harness.dmlTable)} (name) VALUES ('contract-x')`,
            {}
          )
        )
        expect(r.errors).toHaveLength(0)
        expect(r.done?.rowCount).toBe(1)
      })

      it('voert UPDATE uit en rapporteert changes', async () => {
        const r = await collect(
          provider.executeQuery(
            session,
            `UPDATE ${harness.quoteIdentifier(harness.dmlTable)} SET name = 'contract-y' WHERE id = 1`,
            {}
          )
        )
        expect(r.errors).toHaveLength(0)
        expect(r.done?.rowCount).toBe(1)
      })

      it('voert DELETE uit en rapporteert changes', async () => {
        const r = await collect(
          provider.executeQuery(
            session,
            `DELETE FROM ${harness.quoteIdentifier(harness.dmlTable)} WHERE id = 2`,
            {}
          )
        )
        expect(r.errors).toHaveLength(0)
        expect(r.done?.rowCount).toBe(1)
      })

      it('past maxRows niet toe op DML', async () => {
        const r = await collect(
          provider.executeQuery(
            session,
            `INSERT INTO ${harness.quoteIdentifier(harness.dmlTable)} (name) VALUES ('contract-z')`,
            { maxRows: 1 }
          )
        )
        expect(r.errors).toHaveLength(0)
        expect(r.done?.rowCount).toBe(1)
      })
    })

    describe('multi-statement', () => {
      it('weigert meerdere statements met MULTIPLE_STATEMENTS (policy reject)', async () => {
        if (harness.multipleStatements === 'allow') return
        const r = await collect(provider.executeQuery(session, 'SELECT 1 AS a; SELECT 2 AS b', {}))
        expect(r.errors).toHaveLength(1)
        expect(r.errors[0]?.message).toMatch(/MULTIPLE_STATEMENTS/i)
      })
    })

    describe('capabilities', () => {
      it('exposeert dialect en standaard max rows', () => {
        expect(provider.capabilities.dialect).toBe(harness.dialect)
        expect(provider.capabilities.maxResultRowsDefault).toBeGreaterThan(0)
      })
    })
  })
}

export type { ProviderCapabilities }
