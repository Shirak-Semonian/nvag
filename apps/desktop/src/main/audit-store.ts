/**
 * Logging & Audit (F2-8, eis 26).
 *
 * Auditlog in SQLite (naast history.db en snippets.db) met redactie van
 * secrets: wachtwoorden, tokens, API-keys en connection-strings worden
 * nooit in de log opgeslagen. Elke beheeractie (verbinding aanmaken/
 * verwijderen, sessies openen, queries, exports, imports, admin-DDL,
 * transacties) kan hier worden vastgelegd.
 *
 * Bestand: <userData>/audit.db
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuditAction, AuditEntry } from '@nvag/contracts'

export interface NewAuditEntry {
  action: AuditAction
  server?: string
  database?: string
  detail: string
  success: boolean
  error?: string
}

const MAX_LIST = 2000
const SECRET_PATTERNS: RegExp[] = [
  /\b(password|passwd|pwd)\s*[=:]\s*['"]?[^\s'",;]+/gi,
  /\b(token|api[_-]?key|secret|apikey)\s*[=:]\s*['"]?[^\s'",;]+/gi,
  /\b(user\s*id|uid|username|user)\s*[=:]\s*['"]?[^\s'",;]+/gi,
  /(?:Server|Data Source)=[^;]+;.*?(?:User ID|UID)=/gi,
  /(jdbc|mongodb|postgres(ql)?|mysql|mssql|sqlserver):\/\/[^\s'"]+/gi
]

/** Redigeert secrets uit een logregel (eis 26). */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const eq = match.indexOf('=')
      const colon = match.indexOf(':')
      const sep = eq > 0 && (colon < 0 || eq < colon) ? eq : colon
      if (sep > 0) {
        return `${match.slice(0, sep + 1)} [REDACTED]`
      }
      return '[REDACTED]'
    })
  }
  return out
}

export class AuditStore {
  private db: DatabaseSync | null = null

  constructor(private filePath: string) {}

  init(): void {
    if (this.db) return
    const dir = dirname(this.filePath)
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(this.filePath)
    db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        server TEXT NOT NULL DEFAULT '',
        database TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        error TEXT
      )
    `)
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at DESC)')
    this.db = db
  }

  private requireDb(): DatabaseSync {
    if (!this.db) this.init()
    return this.db as DatabaseSync
  }

  /** Logt een actie; detail en error worden automatisch geredigeerd. */
  add(entry: NewAuditEntry): AuditEntry {
    const db = this.requireDb()
    const at = new Date().toISOString()
    const detail = redactSecrets(entry.detail)
    const error = entry.error ? redactSecrets(entry.error) : undefined
    const result = db
      .prepare(
        `INSERT INTO audit (at, action, server, database, detail, success, error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        at,
        entry.action,
        entry.server ?? '',
        entry.database ?? '',
        detail,
        entry.success ? 1 : 0,
        error ?? null
      )
    return {
      id: Number(result.lastInsertRowid),
      at,
      action: entry.action,
      ...(entry.server ? { server: entry.server } : {}),
      ...(entry.database ? { database: entry.database } : {}),
      detail,
      success: entry.success,
      ...(error !== undefined ? { error } : {})
    }
  }

  list(limit = 200): AuditEntry[] {
    const db = this.requireDb()
    const capped = Math.min(Math.max(1, Math.floor(limit)), MAX_LIST)
    return db
      .prepare('SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT ?')
      .all(capped)
      .map(toEntry)
  }

  clear(): void {
    this.requireDb().exec('DELETE FROM audit')
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

function toEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: Number(row.id),
    at: String(row.at),
    action: String(row.action) as AuditAction,
    ...(String(row.server) ? { server: String(row.server) } : {}),
    ...(String(row.database) ? { database: String(row.database) } : {}),
    detail: String(row.detail),
    success: Number(row.success) === 1,
    ...(row.error != null ? { error: String(row.error) } : {})
  }
}
