/**
 * F2-6/F2-8: SnippetStore + AuditStore + redactie — lokale SQLite-stores.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SnippetStore } from './snippet-store'
import { AuditStore, redactSecrets } from './audit-store'

function tempDb(prefix: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { path: join(dir, 'store.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('F2-6 SnippetStore', () => {
  let store: SnippetStore
  let cleanup: () => void

  beforeEach(() => {
    const t = tempDb('nvag-snippets-')
    store = new SnippetStore(t.path)
    store.init()
    cleanup = t.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('slaat een snippet op met folder en haalt hem op', () => {
    const saved = store.save({ folder: 'Selects', title: 'Top 10', sql: 'SELECT * FROM t LIMIT 10' })
    expect(saved.id).toBeGreaterThan(0)
    const list = store.list('Selects')
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('Top 10')
  })

  it('weigert een lege titel of lege SQL', () => {
    expect(() => store.save({ folder: 'x', title: '', sql: 'SELECT 1' })).toThrow('titel')
    expect(() => store.save({ folder: 'x', title: 'y', sql: '  ' })).toThrow('leeg')
  })

  it('geeft folders terug met default-folder', () => {
    store.save({ folder: 'Selects', title: 'A', sql: 'SELECT 1' })
    const folders = store.listFolders()
    expect(folders).toContain('Algemeen')
    expect(folders).toContain('Selects')
  })

  it('verwijdert een snippet', () => {
    const saved = store.save({ folder: 'x', title: 'A', sql: 'SELECT 1' })
    store.remove(saved.id)
    expect(store.list()).toHaveLength(0)
  })
})

describe('F2-8 AuditStore + redactie', () => {
  let store: AuditStore
  let cleanup: () => void

  beforeEach(() => {
    const t = tempDb('nvag-audit-')
    store = new AuditStore(t.path)
    store.init()
    cleanup = t.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  it('logt een actie en geeft de entry terug', () => {
    const entry = store.add({
      action: 'connection.created',
      server: 'PROD-DB',
      detail: 'Verbinding aangemaakt: PROD-DB',
      success: true
    })
    expect(entry.id).toBeGreaterThan(0)
    expect(entry.action).toBe('connection.created')
    expect(store.list()).toHaveLength(1)
  })

  it('redigeert wachtwoorden en tokens uit detail en error', () => {
    const entry = store.add({
      action: 'connection.created',
      server: 'TEST',
      detail: 'password=supersecret en token=abc123',
      success: false,
      error: 'Login mislukt voor user=dba password=geheim'
    })
    expect(entry.detail).toContain('[REDACTED]')
    expect(entry.detail).not.toContain('supersecret')
    expect(entry.error).not.toContain('geheim')
  })

  it('redigeert connection-strings met credentials', () => {
    const clean = redactSecrets('Server=host;User ID=admin;Password=hunter2;Database=x')
    expect(clean).not.toContain('hunter2')
    expect(clean).not.toContain('admin')
    expect(clean).toContain('[REDACTED]')
  })

  it('lijst nieuwste eerst en respecteert limit', () => {
    store.add({ action: 'session.opened', detail: 'a', success: true })
    store.add({ action: 'session.opened', detail: 'b', success: true })
    store.add({ action: 'session.opened', detail: 'c', success: true })
    const list = store.list(2)
    expect(list).toHaveLength(2)
    expect(list[0]?.detail).toBe('c')
  })

  it('wist de auditlog', () => {
    store.add({ action: 'session.opened', detail: 'a', success: true })
    store.clear()
    expect(store.list()).toHaveLength(0)
  })
})
