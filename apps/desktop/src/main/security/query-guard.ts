/**
 * Query Guard — environment safety (ADR-009, eis 22).
 *
 * Patroon-detectie vóór uitvoering in main process (niet in renderer):
 * - DELETE/UPDATE zonder WHERE
 * - DROP / TRUNCATE / ALTER
 * - op PROD standaard altijd bevestiging
 */

import type { Environment } from '@nvag/contracts'

export type GuardSeverity = 'warn' | 'confirm'

export interface GuardResult {
  allowed: boolean
  severity: GuardSeverity
  reasons: string[]
}

const DANGEROUS_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bDROP\s+(TABLE|VIEW|DATABASE|SCHEMA|INDEX|TRIGGER|PROCEDURE|FUNCTION)\b/i, reason: 'DROP-statement' },
  { pattern: /\bTRUNCATE\b/i, reason: 'TRUNCATE-statement' },
  { pattern: /\bALTER\s+(TABLE|DATABASE|SCHEMA|VIEW)\b/i, reason: 'ALTER-statement' },
  { pattern: /\bDELETE\s+FROM\b/i, reason: 'DELETE-statement' },
  { pattern: /\bUPDATE\s+[\w"[\].]+\s+SET\b/i, reason: 'UPDATE-statement' },
  { pattern: /\bCREATE\s+(DATABASE|TABLE|VIEW|INDEX|TRIGGER)\b/i, reason: 'CREATE-statement' }
]

/** Detecteer DELETE/UPDATE zonder WHERE (na commentaar-strippen). */
function hasUnsafeUpdateDelete(sql: string): boolean {
  const stripped = stripComments(sql)
  const lines = stripped.split(';')
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (/\b(DELETE\s+FROM|UPDATE\s+[\w"[\].]+)\b/i.test(t) && !/\bWHERE\b/i.test(t)) {
      return true
    }
  }
  return false
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\/\/[^\n]*/g, '')
}

export function checkQuery(sql: string, environment: Environment): GuardResult {
  const reasons: string[] = []
  const stripped = stripComments(sql)

  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(stripped)) {
      reasons.push(reason)
    }
  }
  if (hasUnsafeUpdateDelete(sql)) {
    reasons.push('DELETE/UPDATE zonder WHERE')
  }

  if (reasons.length === 0) {
    return { allowed: true, severity: 'warn', reasons: [] }
  }

  // PROD: altijd bevestiging (default streng, ADR-009)
  if (environment === 'PROD') {
    return { allowed: false, severity: 'confirm', reasons }
  }
  // Overige omgevingen: waarschuwing (configurabel in F1)
  return { allowed: false, severity: 'confirm', reasons }
}
