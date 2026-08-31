/**
 * SQL History (eis 19) — lokale uitvoeringsgeschiedenis in SQLite.
 *
 * Slaat per uitgevoerde query op: datum/tijd, server, database, SQL,
 * execution time, succes/fout en rowcount. Doorzoekbaar op SQL/server/database.
 *
 * Gebruikt node:sqlite (ingebouwd in Node 24+/Electron 40+) — geen native build.
 * Bestand: <userData>/history.db (naast connections.json).
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HistoryEntry } from '@nvag/contracts'

export interface NewHistoryEntry {
  connectionId: string
  server: string
  database: string
  sql: string
  durationMs: number
  success: boolean
  error?: string
  rowCount: number
}

const MAX_LIST = 500
const MAX_SEARCH = 200

export class HistoryStore {
  private db: DatabaseSync | null = null

  constructor(private filePath: string) {}

  /** Opent de database en zorgt dat de tabel bestaat. Idempotent. */
  init(): void {
    if (this.db) return
    const dir = dirname(this.filePath)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(this.filePath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        executed_at TEXT NOT NULL,
        connection_id TEXT NOT NULL,
        server TEXT NOT NULL,
        database TEXT NOT NULL DEFAULT '',
        sql TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        row_count INTEGER NOT NULL DEFAULT 0
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_history_executed_at ON history(executed_at DESC)')
    this.db = db
  }

  private requireDb(): DatabaseSync {
    if (!this.db) this.init()
    return this.db as DatabaseSync
  }

  /** Voegt een uitvoering toe en retourneert de opgeslagen entry. */
  add(entry: NewHistoryEntry): HistoryEntry {
    const db = this.requireDb()
    const executedAt = new Date().toISOString()
    const result = db
      .prepare(
        `INSERT INTO history
           (executed_at, connection_id, server, database, sql, duration_ms, success, error, row_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        executedAt,
        entry.connectionId,
        entry.server,
        entry.database,
        entry.sql,
        entry.durationMs,
        entry.success ? 1 : 0,
        entry.error ?? null,
        entry.rowCount
      )
    return {
      id: Number(result.lastInsertRowid),
      executedAt,
      connectionId: entry.connectionId,
      server: entry.server,
      database: entry.database,
      sql: entry.sql,
      durationMs: entry.durationMs,
      success: entry.success,
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      rowCount: entry.rowCount
    }
  }

  /**
   * Recente uitvoeringen, nieuwste eerst. Met `query` wordt er gefilterd op
   * SQL/server/database (substring, case-insensitive — doorzoekbaar, eis 19).
   */
  list(query?: string, limit = 100): HistoryEntry[] {
    const db = this.requireDb()
    const capped = Math.min(Math.max(1, Math.floor(limit)), MAX_LIST)
    const q = query?.trim()
    if (!q) {
      return db
        .prepare('SELECT * FROM history ORDER BY executed_at DESC, id DESC LIMIT ?')
        .all(capped)
        .map(toEntry)
    }
    const like = `%${escapeLike(q)}%`
    return db
      .prepare(
        `SELECT * FROM history
         WHERE sql LIKE ? ESCAPE '\\' OR server LIKE ? ESCAPE '\\' OR database LIKE ? ESCAPE '\\'
         ORDER BY executed_at DESC, id DESC LIMIT ?`
      )
      .all(like, like, like, Math.min(capped, MAX_SEARCH))
      .map(toEntry)
  }

  /** Verwijdert alle geschiedenis. */
  clear(): void {
    this.requireDb().exec('DELETE FROM history')
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

function toEntry(row: Record<string, unknown>): HistoryEntry {
  return {
    id: Number(row.id),
    executedAt: String(row.executed_at),
    connectionId: String(row.connection_id),
    server: String(row.server),
    database: String(row.database),
    sql: String(row.sql),
    durationMs: Number(row.duration_ms),
    success: Number(row.success) === 1,
    ...(row.error != null ? { error: String(row.error) } : {}),
    rowCount: Number(row.row_count)
  }
}

/** Ontsnapt LIKE-wildcards zodat de zoektekst letterlijk wordt behandeld. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`)
}
