/**
 * SQL-autocomplete voor Monaco (F1-3).
 *
 * Custom CompletionItemProvider die objecten (tabellen, views, procedures,
 * functies) uit de metadata-cache suggereert, kolommen bij `tabel.`/`alias.`
 * en dialect-specifieke keywords. Identifiers worden met het actieve dialect
 * gequoot (@nvag/sql-dialect), zodat T-SQL `[x]`, MySQL `` `x` `` en
 * ANSI/PG/SQLite `"x"` correct invoegen.
 */

import * as monaco from 'monaco-editor'
import type { SqlDialectId } from '@nvag/contracts'
import { quoteIdentifier } from '@nvag/sql-dialect'
import { metadataCache } from './metadataCache'

export interface CompletionContext {
  connectionId: string | null
  dialect: SqlDialectId
  database: string
  schema?: string
}

// ---------------------------------------------------------------------------
// Keywords (dialect-bewust: gedeelde kern + dialect-specifieke aanvullingen)
// ---------------------------------------------------------------------------

const COMMON_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'RIGHT JOIN',
  'ON', 'AS', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS NULL',
  'GROUP BY', 'ORDER BY', 'HAVING', 'DISTINCT', 'UNION', 'UNION ALL',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM',
  'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'INDEX', 'PRIMARY KEY',
  'FOREIGN KEY', 'REFERENCES', 'NOT NULL', 'DEFAULT', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'COALESCE', 'CAST', 'CURRENT_TIMESTAMP'
]

const DIALECT_KEYWORDS: Record<SqlDialectId, string[]> = {
  sqlite: ['LIMIT', 'OFFSET', 'AUTOINCREMENT', 'IF NOT EXISTS', 'REPLACE', 'WITH', 'RECURSIVE'],
  tsql: [
    'TOP', 'OUTPUT', 'IDENTITY', 'GO', 'PRINT', 'DECLARE', 'EXEC', 'MERGE',
    'NVARCHAR', 'VARCHAR', 'INT', 'BIGINT', 'DECIMAL', 'DATETIME2',
    'GETDATE()', 'ISNULL', 'TRY_CAST', 'CONVERT', 'ROW_NUMBER()', 'OVER',
    'PARTITION BY', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'WITH', 'RECURSIVE'
  ],
  postgres: [
    'LIMIT', 'OFFSET', 'ILIKE', 'SERIAL', 'BIGSERIAL', 'UUID', 'JSONB', 'TEXT',
    'RETURNING', 'DO', 'LANGUAGE', 'plpgsql', 'CREATE OR REPLACE', 'EXPLAIN',
    'ANALYZE', 'CASCADE', 'RESTRICT', 'WITH', 'RECURSIVE'
  ],
  mysql: [
    'LIMIT', 'OFFSET', 'AUTO_INCREMENT', 'ENGINE', 'CHARSET', 'COLLATE',
    'TINYINT', 'SMALLINT', 'DATETIME', 'TIMESTAMP', 'NOW()', 'CURDATE()',
    'REPLACE INTO', 'ON DUPLICATE KEY', 'WITH', 'RECURSIVE'
  ],
  db2: [
    'FETCH', 'FIRST', 'ROWS', 'ONLY', 'WITH', 'UR', 'ISOLATION', 'LEVEL',
    'VALUES', 'MERGE', 'GENERATED', 'ALWAYS', 'AS IDENTITY', 'FOR', 'SYSCAT'
  ],
  oracle: [
    'FETCH', 'FIRST', 'ROWS', 'ONLY', 'ROWNUM', 'NVL', 'TO_DATE', 'SYSDATE',
    'SEQUENCE', 'NEXTVAL', 'CURRVAL', 'DUAL', 'MINUS', 'CONNECT BY', 'START WITH'
  ],
  snowflake: [
    'LIMIT', 'OFFSET', 'QUALIFY', 'LATERAL', 'FLATTEN', 'VARIANT', 'OBJECT',
    'ARRAY', 'COPY INTO', 'STAGE', 'WAREHOUSE', 'CURRENT_DATE()', 'RANDOM()'
  ]
}

const KEYWORD_KIND = monaco.languages.CompletionItemKind.Keyword

function keywordSuggestions(
  dialect: SqlDialectId,
  position: monaco.Position,
  word: monaco.editor.IWordAtPosition
): monaco.languages.CompletionItem[] {
  const range = wordRange(position, word)
  const seen = new Set<string>()
  const out: monaco.languages.CompletionItem[] = []
  for (const kw of [...COMMON_KEYWORDS, ...DIALECT_KEYWORDS[dialect]]) {
    if (seen.has(kw)) continue
    seen.add(kw)
    out.push({
      label: kw,
      kind: KEYWORD_KIND,
      insertText: kw,
      range,
      sortText: `z-${kw}`
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wordRange(
  position: monaco.Position,
  word: monaco.editor.IWordAtPosition
): monaco.IRange {
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn
  }
}

/**
 * Los een naam voor de punt op: alias → tabel via `FROM <tabel> [AS] <alias>`,
 * anders wordt de naam zelf als tabelnaam gebruikt.
 */
export function resolveTableAlias(sql: string, ref: string): string | null {
  const re = /\bFROM\s+([A-Za-z_$][\w$]*)(?:\s+(?:AS\s+)?([A-Za-z_$][\w$]*))?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const table = m[1]!
    const alias = m[2]
    if (alias && alias.toUpperCase() === ref.toUpperCase()) return table
    if (!alias && table.toUpperCase() === ref.toUpperCase()) return table
  }
  return null
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function createSqlCompletionProvider(
  ctx: CompletionContext
): monaco.languages.CompletionItemProvider {
  return {
    triggerCharacters: ['.', ' '],

    provideCompletionItems: async (model, position) => {
      if (!ctx.connectionId) return { suggestions: [] }

      const word = model.getWordUntilPosition(position)
      const line = model.getLineContent(position.lineNumber)
      // Tot aan de cursor (inclusief een net getypte punt) voor de dot-detectie;
      // `word.startColumn` staat ná de punt en zou die wegsnijden. Column is
      // 1-based: slice(0, column) bevat het teken waar de cursor achter staat.
      const before = line.slice(0, position.column)

      // `tabel.` / `alias.` → kolommen van die tabel
      const dotMatch = /(?:^|\s)([A-Za-z_$][\w$]*)\.\s*$/.exec(before)
      if (dotMatch) {
        const ref = dotMatch[1]!
        const table = resolveTableAlias(model.getValue(), ref) ?? ref
        return { suggestions: await columnSuggestions(ctx, table, position, word) }
      }

      const suggestions: monaco.languages.CompletionItem[] = [
        ...(await objectSuggestions(ctx, position, word)),
        ...keywordSuggestions(ctx.dialect, position, word)
      ]
      return { suggestions }
    }
  }
}

async function objectSuggestions(
  ctx: CompletionContext,
  position: monaco.Position,
  word: monaco.editor.IWordAtPosition
): Promise<monaco.languages.CompletionItem[]> {
  try {
    const catalog = await metadataCache.getCatalog(ctx.connectionId!, ctx.database, ctx.schema)
    const range = wordRange(position, word)
    const items: monaco.languages.CompletionItem[] = []

    for (const t of catalog.tables) {
      items.push({
        label: t.name,
        kind: monaco.languages.CompletionItemKind.Class,
        detail: 'tabel',
        insertText: quoteIdentifier(ctx.dialect, t.name),
        range
      })
    }
    for (const v of catalog.views) {
      items.push({
        label: v.name,
        kind: monaco.languages.CompletionItemKind.Interface,
        detail: 'view',
        insertText: quoteIdentifier(ctx.dialect, v.name),
        range
      })
    }
    for (const p of catalog.procedures) {
      items.push({
        label: p.name,
        kind: monaco.languages.CompletionItemKind.Method,
        detail: 'procedure',
        insertText: quoteIdentifier(ctx.dialect, p.name),
        range
      })
    }
    for (const f of catalog.functions) {
      items.push({
        label: f.name,
        kind: monaco.languages.CompletionItemKind.Function,
        detail: 'functie',
        insertText: quoteIdentifier(ctx.dialect, f.name),
        range
      })
    }
    return items
  } catch {
    return []
  }
}

async function columnSuggestions(
  ctx: CompletionContext,
  table: string,
  position: monaco.Position,
  word: monaco.editor.IWordAtPosition
): Promise<monaco.languages.CompletionItem[]> {
  try {
    const meta = await metadataCache.getTableMetadata(
      ctx.connectionId!,
      ctx.database,
      ctx.schema ?? 'main',
      table
    )
    if (!meta) return []
    const range = wordRange(position, word)
    return meta.columns.map((c) => ({
      label: c.name,
      kind: monaco.languages.CompletionItemKind.Field,
      detail: c.dataType,
      insertText: c.name,
      range
    }))
  } catch {
    return []
  }
}
