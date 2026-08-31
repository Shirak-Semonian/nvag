/**
 * Query Guard — environment safety (ADR-009, eis 22, F1-8).
 *
 * Patroon-detectie vóór uitvoering in main process (niet in renderer):
 * - DELETE/UPDATE zonder WHERE
 * - DROP / TRUNCATE / ALTER
 * - grote operaties (batch van schrijvende statements, bulk INSERT ... SELECT)
 * - op PROD strenger: daar wordt áls de guard aanslaat standaard altijd
 *   om bevestiging gevraagd (`confirm`); op andere omgevingen zijn lichtere
 *   categorieën (`CREATE`, grote operaties) een `warn` die zonder dialoog
 *   uitvoert (de renderer toont dan een waarschuwing in het berichtenpaneel).
 */

import type { Environment, GuardSeverity } from '@nvag/contracts'

export interface GuardResult {
  allowed: boolean
  severity: GuardSeverity
  reasons: string[]
}

interface GuardPattern {
  pattern: RegExp
  reason: string
  /** Severity buiten PROD; op PROD wordt alles 'confirm'. */
  severity: GuardSeverity
}

const DANGEROUS_PATTERNS: GuardPattern[] = [
  // Destructief DDL — overal bevestiging.
  { pattern: /\bDROP\s+(TABLE|VIEW|DATABASE|SCHEMA|INDEX|TRIGGER|PROCEDURE|FUNCTION|SEQUENCE)\b/i, reason: 'DROP-statement', severity: 'confirm' },
  { pattern: /\bTRUNCATE\b/i, reason: 'TRUNCATE-statement', severity: 'confirm' },
  { pattern: /\bALTER\s+(TABLE|DATABASE|SCHEMA|VIEW)\b/i, reason: 'ALTER-statement', severity: 'confirm' },
  // Data-destructief zonder begrenzing — overal bevestiging.
  { pattern: /\bDELETE\s+FROM\b/i, reason: 'DELETE-statement', severity: 'confirm' },
  { pattern: /\bUPDATE\s+[\w"[\].]+\s+SET\b/i, reason: 'UPDATE-statement', severity: 'confirm' },
  // CREATE is niet destructief: buiten PROD een waarschuwing, op PROD bevestigen.
  { pattern: /\bCREATE\s+(DATABASE|TABLE|VIEW|INDEX|TRIGGER)\b/i, reason: 'CREATE-statement', severity: 'warn' }
]

/** Schrijvende statement-typen voor de grote-operatie-detectie. */
const WRITE_STATEMENT = /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE)\b/i

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

/**
 * Grote operaties (F1-8):
 * - een batch met meerdere schrijvende statements in één uitvoering;
 * - een bulk `INSERT ... SELECT` (kopieert in één keer veel rijen).
 */
function detectLargeOperations(sql: string): string[] {
  const reasons: string[] = []
  const stripped = stripComments(sql)

  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const writeCount = statements.filter((s) => WRITE_STATEMENT.test(s)).length
  if (writeCount >= 2) {
    reasons.push(`grote operatie: ${writeCount} schrijvende statements in één uitvoering`)
  }

  if (/\bINSERT\s+INTO\b[\s\S]*\bSELECT\b/i.test(stripped) && !/\b(LIMIT|TOP\s+\d+)\b/i.test(stripped)) {
    reasons.push('grote operatie: bulk INSERT … SELECT zonder begrenzing')
  }

  return reasons
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
  reasons.push(...detectLargeOperations(sql))

  if (reasons.length === 0) {
    return { allowed: true, severity: 'warn', reasons: [] }
  }

  // PROD: altijd bevestiging (standaard streng, ADR-009).
  if (environment === 'PROD') {
    return { allowed: false, severity: 'confirm', reasons }
  }

  // Overige omgevingen: destructieve patronen bevestigen, lichtere waarschuwen.
  const hasConfirm = DANGEROUS_PATTERNS.some(
    ({ pattern, severity }) => severity === 'confirm' && pattern.test(stripped)
  ) || hasUnsafeUpdateDelete(sql)
  return { allowed: false, severity: hasConfirm ? 'confirm' : 'warn', reasons }
}
