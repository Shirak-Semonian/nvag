import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { buildJdbcUrl, resolveJccJar } from '../src/jcc'
import type { ConnectionConfig } from '@nvag/contracts'

// Isolatie (SAL-37): de jcc-zoekpaden mogen niet afhangen van een toevallig
// aanwezige jcc.jar op de machine (~/.nvag/db2jcc/jcc.jar). homedir() wijst
// naar een niet-bestaande map zodat "geen jar gevonden" deterministisch is.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => join(tmpdir(), 'nvag-db2jcc-home-doet-niet-bestaan')
  }
})

const tmp = mkdtempSync(join(tmpdir(), 'nvag-db2-jcc-'))
const fakeJar = join(tmp, 'jcc.jar')
writeFileSync(fakeJar, '')
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const baseConfig = (over: Partial<ConnectionConfig>): ConnectionConfig => ({
  id: 'x',
  name: 'x',
  providerId: 'db2',
  environment: 'TEST',
  host: 'localhost',
  username: 'db2inst1',
  auth: 'username-password',
  ssl: { mode: 'disable' },
  connectionTimeoutMs: 5000,
  group: 'Test',
  ...over
})

describe('buildJdbcUrl (db2)', () => {
  it('bouwt een jdbc:db2 URL met standaardpoort en loginTimeout', () => {
    expect(buildJdbcUrl(baseConfig({ database: 'nvagdb' }))).toBe(
      'jdbc:db2://localhost:50000/nvagdb:loginTimeout=5;'
    )
  })

  it('gebruikt de opgegeven poort', () => {
    expect(buildJdbcUrl(baseConfig({ database: 'nvagdb', port: 60000 }))).toBe(
      'jdbc:db2://localhost:60000/nvagdb:loginTimeout=5;'
    )
  })

  it('weigert zonder database (Db2 kent geen server-level verbinding)', () => {
    expect(() => buildJdbcUrl(baseConfig({}))).toThrow(/database/i)
  })
})

describe('resolveJccJar (db2)', () => {
  it('vindt de jar via NVAG_DB2_JCC_JAR', () => {
    process.env.NVAG_DB2_JCC_JAR = fakeJar
    try {
      expect(resolveJccJar()).toBe(fakeJar)
    } finally {
      delete process.env.NVAG_DB2_JCC_JAR
    }
  })

  it('retourneert null wanneer de jar nergens gevonden wordt', () => {
    process.env.NVAG_DB2_JCC_JAR = join(tmp, 'bestaat-niet.jar')
    try {
      expect(resolveJccJar()).toBeNull()
    } finally {
      delete process.env.NVAG_DB2_JCC_JAR
    }
  })
})
