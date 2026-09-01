import { describe, expect, it } from 'vitest'
import { checkQuery } from './query-guard'

describe('query-guard (ADR-009, F1-8)', () => {
  it('laat SELECT en veilig DML door', () => {
    expect(checkQuery('SELECT * FROM klanten;', 'DEV').allowed).toBe(true)
    expect(checkQuery('DELETE FROM klanten WHERE id = 1;', 'DEV').allowed).toBe(true)
    expect(checkQuery('UPDATE klanten SET naam = \'x\' WHERE id = 2;', 'PROD').allowed).toBe(true)
  })

  it('blokkeert DELETE zonder WHERE met confirm op elke omgeving', () => {
    const r = checkQuery('DELETE FROM klanten;', 'DEV')
    expect(r.allowed).toBe(false)
    expect(r.severity).toBe('confirm')
    expect(r.reasons).toContain('DELETE/UPDATE zonder WHERE')
  })

  it('blokkeert UPDATE zonder WHERE met confirm', () => {
    const r = checkQuery('UPDATE klanten SET naam = \'x\';', 'TEST')
    expect(r.allowed).toBe(false)
    expect(r.severity).toBe('confirm')
    expect(r.reasons).toContain('DELETE/UPDATE zonder WHERE')
  })

  it('blokkeert DROP, TRUNCATE en ALTER met confirm', () => {
    for (const sql of ['DROP TABLE klanten;', 'DROP DATABASE prod;', 'TRUNCATE TABLE log;', 'ALTER TABLE klanten ADD kolom TEXT;']) {
      const r = checkQuery(sql, 'DEV')
      expect(r.allowed).toBe(false)
      expect(r.severity).toBe('confirm')
    }
  })

  it('stript commentaar vóór detectie', () => {
    const r = checkQuery('-- veilige query?\nDELETE FROM klanten;', 'DEV')
    expect(r.allowed).toBe(false)
    expect(r.reasons).toContain('DELETE/UPDATE zonder WHERE')
  })

  it('UPDATE met WHERE in een later statement telt als veilig', () => {
    const r = checkQuery('UPDATE klanten SET naam = \'x\' WHERE id = 1;', 'PROD')
    expect(r.allowed).toBe(true)
  })

  it('CREATE is buiten PROD een warn en op PROD confirm (strenger)', () => {
    const dev = checkQuery('CREATE TABLE nieuw (id INTEGER);', 'DEV')
    expect(dev.allowed).toBe(false)
    expect(dev.severity).toBe('warn')
    expect(dev.reasons).toContain('CREATE-statement')

    const prod = checkQuery('CREATE TABLE nieuw (id INTEGER);', 'PROD')
    expect(prod.allowed).toBe(false)
    expect(prod.severity).toBe('confirm')
  })

  it('F4: RESTORE is destructief → confirm op elke omgeving', () => {
    for (const env of ['DEV', 'TEST', 'ACC', 'PROD'] as const) {
      const r = checkQuery('RESTORE DATABASE prod FROM DISK = N\'/tmp/x.bak\' WITH REPLACE;', env)
      expect(r.allowed).toBe(false)
      expect(r.severity).toBe('confirm')
      expect(r.reasons).toContain('RESTORE-statement')
    }
  })

  it('F4: BACKUP is buiten PROD een warn en op PROD confirm', () => {
    const dev = checkQuery('BACKUP DATABASE [Sales] TO DISK = N\'/tmp/s.bak\';', 'DEV')
    expect(dev.allowed).toBe(false)
    expect(dev.severity).toBe('warn')
    expect(dev.reasons).toContain('BACKUP-statement')

    const prod = checkQuery('BACKUP DATABASE [Sales] TO DISK = N\'/tmp/s.bak\';', 'PROD')
    expect(prod.allowed).toBe(false)
    expect(prod.severity).toBe('confirm')
  })

  it('detecteert een batch met meerdere schrijvende statements als grote operatie', () => {
    // Beide statements zijn begrensd (WHERE) — de batch zelf is de grote operatie.
    const sql = 'UPDATE a SET x = 1 WHERE id = 1; UPDATE b SET y = 2 WHERE id = 2;'
    const dev = checkQuery(sql, 'DEV')
    expect(dev.allowed).toBe(false)
    expect(dev.severity).toBe('warn')
    expect(dev.reasons.some((r) => r.startsWith('grote operatie'))).toBe(true)

    const prod = checkQuery(sql, 'PROD')
    expect(prod.severity).toBe('confirm')
  })

  it('detecteert bulk INSERT … SELECT zonder begrenzing als grote operatie', () => {
    const sql = 'INSERT INTO archief SELECT * FROM klanten;'
    const dev = checkQuery(sql, 'DEV')
    expect(dev.allowed).toBe(false)
    expect(dev.severity).toBe('warn')
    expect(dev.reasons.some((r) => r.startsWith('grote operatie'))).toBe(true)

    // Met begrenzing (TOP/LIMIT) geen grote operatie.
    const bounded = checkQuery('INSERT INTO archief SELECT TOP 100 * FROM klanten;', 'DEV')
    expect(bounded.reasons.some((r) => r.startsWith('grote operatie'))).toBe(false)
  })

  it('meerdere SELECTs in één batch zijn geen grote operatie', () => {
    const r = checkQuery('SELECT * FROM a; SELECT * FROM b;', 'DEV')
    expect(r.allowed).toBe(true)
  })
})
