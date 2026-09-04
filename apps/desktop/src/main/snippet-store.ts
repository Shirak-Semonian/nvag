/**
 * Snippets/Favorites (F2-6, eis 20).
 *
 * Lokale SQLite-opslag (naast history.db) voor herbruikbare SQL-fragmenten:
 * folders, titel + SQL, bijwerken bij gebruik. De renderer kan een snippet
 * in de editor invoegen.
 *
 * Bestand: <userData>/snippets.db (node:sqlite — geen native build).
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NewSnippetEntry, SnippetEntry } from '@nvag/contracts'

const DEFAULT_FOLDER = 'Algemeen'

export class SnippetStore {
  private db: DatabaseSync | null = null

  constructor(private filePath: string) {}

  init(): void {
    if (this.db) return
    const dir = dirname(this.filePath)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(this.filePath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS snippets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder TEXT NOT NULL DEFAULT '${DEFAULT_FOLDER}',
        title TEXT NOT NULL,
        sql TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_snippets_folder ON snippets(folder)')
    this.db = db
  }

  private requireDb(): DatabaseSync {
    if (!this.db) this.init()
    return this.db as DatabaseSync
  }

  list(folder?: string): SnippetEntry[] {
    const db = this.requireDb()
    if (folder) {
      return db
        .prepare('SELECT * FROM snippets WHERE folder = ? ORDER BY title COLLATE NOCASE')
        .all(folder)
        .map(toEntry)
    }
    return db.prepare('SELECT * FROM snippets ORDER BY folder COLLATE NOCASE, title COLLATE NOCASE').all().map(toEntry)
  }

  listFolders(): string[] {
    const db = this.requireDb()
    const rows = db.prepare('SELECT DISTINCT folder FROM snippets ORDER BY folder COLLATE NOCASE').all() as { folder: string }[]
    const folders = rows.map((r) => r.folder)
    if (!folders.includes(DEFAULT_FOLDER)) folders.unshift(DEFAULT_FOLDER)
    return folders
  }

  save(entry: NewSnippetEntry): SnippetEntry {
    const db = this.requireDb()
    const folder = entry.folder.trim() || DEFAULT_FOLDER
    const title = entry.title.trim()
    if (!title) throw new Error('Provide a title for the snippet.')
    if (!entry.sql.trim()) throw new Error('The snippet is empty.')
    const updatedAt = new Date().toISOString()
    const result = db
      .prepare('INSERT INTO snippets (folder, title, sql, updated_at) VALUES (?, ?, ?, ?)')
      .run(folder, title, entry.sql, updatedAt)
    return { id: Number(result.lastInsertRowid), folder, title, sql: entry.sql, updatedAt }
  }

  remove(id: number): void {
    this.requireDb().prepare('DELETE FROM snippets WHERE id = ?').run(id)
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        // al gesloten
      }
      this.db = null
    }
  }
}

function toEntry(row: Record<string, unknown>): SnippetEntry {
  return {
    id: Number(row.id),
    folder: String(row.folder),
    title: String(row.title),
    sql: String(row.sql),
    updatedAt: String(row.updated_at)
  }
}
