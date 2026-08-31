/**
 * Best-effort foutpositie voor Db2 (F1-9).
 *
 * De JDBC-driver levert fouten als `DB2 SQL Error: SQLCODE=-104,
 * SQLSTATE=42601, SQLERRMC=SELEC;...`. SQLERRMC (of het geciteerde token in
 * "An unexpected token \"X\" was found ...") bevat het aanstootgevende token;
 * dat zoeken we terug in de uitgevoerde SQL. Retourneert null wanneer de
 * positie niet bepaald kan worden — de app toont dan alleen de melding.
 */

/** Regel/kolom (1-based) van een byte-offset in de SQL-tekst. */
function offsetToLineColumn(sql: string, index: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < index && i < sql.length; i++) {
    if (sql[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  return { line, column: index - lineStart + 1 }
}

/** Haal het token uit SQLERRMC (DB2 escaped quotes met backslash). */
function unescapeSqlErrmc(token: string): string {
  return token.replace(/\\"/g, '"').trim()
}

/**
 * Zoek een token (hoofdletterongevoelig, op woordgrenzen) in de SQL.
 * DB2 folded unquoted identifiers naar boven; de zoektocht gebruikt daarom
 * de geüppercaste SQL (ASCII-upcase verandert byte-offsets niet).
 */
function findTokenIndex(sql: string, token: string): number {
  const upper = sql.toUpperCase()
  const needle = token.toUpperCase()
  let from = 0
  while (from <= upper.length - needle.length) {
    const idx = upper.indexOf(needle, from)
    if (idx < 0) return -1
    const before = idx === 0 ? '' : upper[idx - 1]!
    const after = upper[idx + needle.length] ?? ''
    const isWord = (c: string): boolean => /[A-Z0-9_$]/.test(c)
    if (!isWord(before) && !isWord(after)) return idx
    from = idx + 1
  }
  return -1
}

export function parseDb2ErrorPosition(
  sql: string,
  message: string
): { line: number; column: number } | null {
  if (typeof sql !== 'string' || typeof message !== 'string') return null
  const trimmed = message.trim()

  // 1. SQLERRMC=<token> (DB2 LUW, SQLCODE -104 e.d.)
  const ermc = /SQLERRMC=([^;\s]+)/i.exec(trimmed)
  let token = ermc ? unescapeSqlErrmc(ermc[1]!) : null

  // 2. Geciteerd token in de meldingstekst
  if (!token) {
    const quoted =
      /unexpected token\s+"([^"]+)"/i.exec(trimmed) ?? /token\s+"([^"]+)"/i.exec(trimmed)
    if (quoted) token = quoted[1]!
  }
  if (!token) return null

  const idx = findTokenIndex(sql, token)
  if (idx < 0) return null
  return offsetToLineColumn(sql, idx)
}
