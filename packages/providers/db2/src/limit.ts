/**
 * maxRows-cap voor Db2 (F1-9).
 *
 * DB2 kent geen `TOP`/`LIMIT`; de cap wordt toegepast met
 * `FETCH FIRST n ROWS ONLY` (dialect `db2` in @nvag/sql-dialect). De les uit
 * SAL-8 geldt ook hier: nooit een tweede limiet-clausule toevoegen wanneer het
 * statement er al een heeft (`FETCH FIRST` / `OFFSET` — ook in een subquery,
 * dan is toevoegen onveilig).
 */

import { containsKeyword } from '@nvag/sql-dialect'

/**
 * Voeg `FETCH FIRST n ROWS ONLY` toe aan een SELECT zonder eigen
 * limiet-clausule. Leading whitespace/commentaar wordt overgeslagen;
 * non-SELECT-statements (DML/DDL) worden onaangetast gelaten.
 */
export function applyFetchFirstLimit(sql: string, maxRows: number): string {
  const leading = /^(\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*)/.exec(sql)
  const prefix = leading?.[1] ?? ''
  const rest = sql.slice(prefix.length)
  if (!/^\s*SELECT\b/i.test(rest)) return sql
  if (containsKeyword(rest, 'FETCH') || containsKeyword(rest, 'OFFSET')) return sql
  return `${prefix}${rest.trimEnd()} FETCH FIRST ${maxRows} ROWS ONLY`
}
