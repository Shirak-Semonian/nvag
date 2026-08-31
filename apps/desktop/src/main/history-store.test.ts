import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HistoryStore } from './history-store'

describe('HistoryStore (eis 19)', () => {
  let dir: string
  let store: HistoryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nvag-history-'))
    store = new HistoryStore(join(dir, 'history.db'))
    store.init()
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const base = {
    connectionId: 'conn-1',
    server: 'SQL-DEV',
    database: 'klanten',
    sql: 'SELECT * FROM users',
    durationMs: 12,
    success: true,
    rowCount: 3
  }

  it('slaat een uitvoering op met alle vereiste velden', () => {
    const entry = store.add(base)
    expect(entry.id).toBeGreaterThan(0)
    expect(entry.executedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(entry.server).toBe('SQL-DEV')
    expect(entry.database).toBe('klanten')
    expect(entry.sql).toBe('SELECT * FROM users')
    expect(entry.durationMs).toBe(12)
    expect(entry.success).toBe(true)
    expect(entry.rowCount).toBe(3)

    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      server: 'SQL-DEV',
      database: 'klanten',
      sql: 'SELECT * FROM users',
      durationMs: 12,
      success: true,
      rowCount: 3
    })
  })

  it('registreert een foutuitvoering met succes=false en error-tekst', () => {
    const entry = store.add({ ...base, sql: 'SELECT kapot;', success: false, error: 'near "kapot": syntax error' })
    expect(entry.success).toBe(false)
    expect(entry.error).toContain('syntax error')
    expect(store.list()[0]!.success).toBe(false)
    expect(store.list()[0]!.error).toContain('syntax error')
  })

  it('geeft nieuwste uitvoeringen eerst terug', () => {
    store.add({ ...base, sql: 'SELECT 1' })
    store.add({ ...base, sql: 'SELECT 2' })
    store.add({ ...base, sql: 'SELECT 3' })
    const sqls = store.list().map((e) => e.sql)
    expect(sqls).toEqual(['SELECT 3', 'SELECT 2', 'SELECT 1'])
  })

  it('is doorzoekbaar op SQL, server en database (substring, case-insensitive)', () => {
    store.add({ ...base, sql: 'SELECT * FROM users WHERE naam LIKE "jan%"' })
    store.add({ ...base, sql: 'UPDATE klanten SET actief=1' })
    store.add({ ...base, server: 'PG-TEST', sql: 'SELECT 42' })

    expect(store.list('users').map((e) => e.sql)).toEqual(['SELECT * FROM users WHERE naam LIKE "jan%"'])
    expect(store.list('UPDATE').map((e) => e.sql)).toEqual(['UPDATE klanten SET actief=1'])
    expect(store.list('pg-test').map((e) => e.server)).toEqual(['PG-TEST'])
    // 'klanten' komt voor in database (alle 3) én in de UPDATE-SQL.
    expect(store.list('klanten').length).toBe(3)
  })

  it('behandelt LIKE-wildcards in de zoektekst letterlijk', () => {
    store.add({ ...base, sql: 'SELECT * FROM a' })
    store.add({ ...base, sql: 'SELECT 100%' })
    // '%' in de zoektekst is een letterlijke '%', geen wildcard.
    expect(store.list('100%').length).toBe(1)
    expect(store.list('100%')[0]!.sql).toBe('SELECT 100%')
  })

  it('respecteert de limit', () => {
    for (let i = 0; i < 10; i++) store.add({ ...base, sql: `SELECT ${i}` })
    expect(store.list(undefined, 3)).toHaveLength(3)
  })

  it('wist de geschiedenis via clear', () => {
    store.add(base)
    store.clear()
    expect(store.list()).toHaveLength(0)
  })

  it('overleeft een herstart (persistentie op schijf)', () => {
    store.add(base)
    store.close()
    const reopened = new HistoryStore(join(dir, 'history.db'))
    reopened.init()
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.list()[0]!.sql).toBe('SELECT * FROM users')
    reopened.close()
  })
})
