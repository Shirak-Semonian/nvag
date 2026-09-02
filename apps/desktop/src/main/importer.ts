/**
 * Import (F2-7, eis 17).
 *
 * Parseert CSV (papaparse), Excel (exceljs), JSON (array van objecten) en
 * XML (rij-gebaseerd) met kolom-mapping naar een doeltabel, en genereert
 * INSERT-SQL (dialect-correct via @nvag/sql-dialect). De renderer kiest het
 * bestand via een dialoog in main process, ziet een preview en een mapping,
 * en kan de gegenereerde INSERTs (na guard-check) direct uitvoeren.
 */

import { readFileSync } from 'node:fs'
import Papa from 'papaparse'
import type {
  ImportFileFormat,
  ImportGenerateResult,
  ImportPreview
} from '@nvag/contracts'
import { quoteIdentifier, quoteValue } from '@nvag/sql-dialect'

const PREVIEW_ROWS = 20

// ---------------------------------------------------------------------------
// Parsers per formaat
// ---------------------------------------------------------------------------

interface ParsedTable {
  columns: string[]
  rows: unknown[][]
}

function parseCsv(content: string): ParsedTable {
  const result = Papa.parse<unknown[]>(content, { skipEmptyLines: true })
  if (result.errors.length > 0) {
    throw new Error(`CSV-fout: ${result.errors[0]?.message ?? 'onbekend'}`)
  }
  const data = result.data as unknown[][]
  if (data.length === 0) return { columns: [], rows: [] }
  const columns = (data[0] ?? []).map((c, i) => String(c ?? `kolom${i + 1}`))
  const rows = data.slice(1).map((r) => r.map(normalizeCell))
  return { columns, rows }
}

function parseJson(content: string): ParsedTable {
  const data = JSON.parse(content) as unknown
  const arr = Array.isArray(data) ? data : (data as { rows?: unknown[] })?.rows
  if (!Array.isArray(arr)) {
    throw new Error('JSON moet een array van objecten zijn (of {rows: [...]}).')
  }
  if (arr.length === 0) return { columns: [], rows: [] }
  const first = arr[0]
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    throw new Error('JSON-rijen moeten objecten zijn (kolom → waarde).')
  }
  const columns = Object.keys(first as Record<string, unknown>)
  const rows = arr.map((r) =>
    columns.map((c) => normalizeCell((r as Record<string, unknown>)[c]))
  )
  return { columns, rows }
}

async function parseXlsx(filePath: string): Promise<ParsedTable> {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const ws = wb.worksheets[0]
  if (!ws) return { columns: [], rows: [] }
  const matrix: unknown[][] = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as unknown[]).slice(1) // index 0 is row number
    matrix.push(values)
  })
  if (matrix.length === 0) return { columns: [], rows: [] }
  const columns = (matrix[0] ?? []).map((c, i) => String(c ?? `kolom${i + 1}`))
  const rows = matrix.slice(1).map((r) => r.map(normalizeCell))
  return { columns, rows }
}

/**
 * Minimalistische XML-parser voor rij-gebaseerde tabellen:
 * - `<table><row><naam>waarde</naam>…</row>…</table>` → kolommen = tagnamen
 * - `<table><row><col>w1</col><col>w2</col></row>…</table>` → kolommen = kolom1..n
 */
function parseXml(content: string): ParsedTable {
  const rows: Record<string, unknown>[] = []
  const rowRe = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g
  // Verwijder XML-declaratie en opmerkingen eerst.
  const cleaned = content.replace(/<\?xml[\s\S]*?\?>/i, '').replace(/<!--[\s\S]*?-->/g, '')
  // Zoek rij-elementen (row/record) die zelf child-elementen bevatten.
  const rowTagRe = /<(row|record|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = rowTagRe.exec(cleaned)) !== null) {
    const inner = m[2] ?? ''
    const record: Record<string, unknown> = {}
    let cm: RegExpExecArray | null
    while ((cm = rowRe.exec(inner)) !== null) {
      record[cm[1] ?? ''] = normalizeCell(unwrapXml(cm[2] ?? ''))
    }
    if (Object.keys(record).length > 0) rows.push(record)
  }
  if (rows.length === 0) return { columns: [], rows: [] }
  // Kolomvolgorde: eerst de keys van de eerste rij; daarna eventuele extra keys.
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))]
  return {
    columns,
    rows: rows.map((r) => columns.map((c) => r[c] ?? null))
  }
}

function unwrapXml(text: string): string {
  return text.trim().replace(/<[^>]+>/g, '').trim()
}

function normalizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '') return null
    if (/^-?\d+$/.test(t)) return Number(t)
    if (/^-?\d*\.\d+$/.test(t)) return Number(t)
    if (t === 'true') return true
    if (t === 'false') return false
    return v
  }
  return v
}

async function parseFile(filePath: string, format: ImportFileFormat): Promise<ParsedTable> {
  switch (format) {
    case 'csv':
      return parseCsv(readFileSync(filePath, 'utf8'))
    case 'json':
      return parseJson(readFileSync(filePath, 'utf8'))
    case 'xlsx':
      return parseXlsx(filePath)
    case 'xml':
      return parseXml(readFileSync(filePath, 'utf8'))
    default: {
      const exhaustive: never = format
      throw new Error(`Onbekend importformaat: ${String(exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Service-API
// ---------------------------------------------------------------------------

export async function previewImport(req: {
  filePath: string
  format: ImportFileFormat
}): Promise<ImportPreview> {
  const parsed = await parseFile(req.filePath, req.format)
  const unique = dedupeColumns(parsed.columns)
  return {
    fileName: req.filePath.split(/[\\/]/).pop() ?? req.filePath,
    format: req.format,
    columns: parsed.columns.map((name, i) => ({ name: unique[i] ?? name })),
    rows: parsed.rows.slice(0, PREVIEW_ROWS),
    totalRows: parsed.rows.length,
    uniqueColumns: unique
  }
}

export async function generateImport(req: {
  filePath: string
  format: ImportFileFormat
  table: string
  schema?: string
  mapping: Record<number, string>
  rowLimit?: number
  dialect: string
}): Promise<ImportGenerateResult> {
  const parsed = await parseFile(req.filePath, req.format)
  const limit = req.rowLimit && req.rowLimit > 0 ? Math.min(req.rowLimit, parsed.rows.length) : parsed.rows.length
  const rows = parsed.rows.slice(0, limit)
  const tableName = req.schema
    ? `${quoteIdentifier(req.dialect as never, req.schema)}.${quoteIdentifier(req.dialect as never, req.table)}`
    : quoteIdentifier(req.dialect as never, req.table)
  const colNames = Object.keys(req.mapping)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => req.mapping[i]!)
  const stmts: string[] = []
  for (const row of rows) {
    const values = colNames.map((name) => {
      // Mapping: bronindex → doelkolom. Zoek de bronindex bij deze kolom.
      const srcIndex = Object.entries(req.mapping).find(([, n]) => n === name)?.[0]
      const idx = srcIndex !== undefined ? Number(srcIndex) : -1
      return quoteValue(req.dialect as never, idx >= 0 ? (row[idx] ?? null) : null)
    })
    stmts.push(
      `INSERT INTO ${tableName} (${colNames.map((c) => quoteIdentifier(req.dialect as never, c)).join(', ')})\nVALUES (${values.join(', ')});`
    )
  }
  return { sql: stmts.join('\n'), rowCount: rows.length }
}

/**
 * Voert de gegenereerde INSERTs direct uit (met guard-check).
 * Leeft in de IPC-laag (ipc.ts) omdat hij connectionStore + sessie nodig
 * heeft; hier houden we de parser-module vrij van electron.
 */
export async function executeImport(
  connectionId: string,
  sql: string,
  confirmed?: boolean
): Promise<{ ok: boolean; rowCount: number; blocked?: string[]; guardSeverity?: 'warn' | 'confirm' }> {
  const { sessionManager } = await import('./session-manager')
  const { connectionStore } = await import('./ipc-bootstrap')
  const { checkQuery } = await import('./security/query-guard')
  const { registry } = await import('./registry')
  const { splitStatements } = await import('@nvag/sql-dialect')
  const session = sessionManager.getByConnectionId(connectionId)
  if (!session) {
    throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
  }
  const conn = connectionStore.get(connectionId)
  if (conn && !confirmed) {
    const guard = checkQuery(sql, conn.environment)
    if (!guard.allowed) {
      return { ok: false, rowCount: 0, blocked: guard.reasons, guardSeverity: guard.severity }
    }
  }
  const provider = registry.get(session.providerId)
  // Multi-statement import: de providers weigeren meerdere statements per
  // uitvoering (MULTIPLE_STATEMENTS) — splits en voer één voor één uit.
  // Dialect meegeven zodat T-SQL GO-batches per batch worden gesplitst.
  const statements = splitStatements(sql, provider.capabilities.dialect)
  let rowCount = 0
  for (const stmt of statements) {
    let stmtRows = 0
    for await (const chunk of provider.executeQuery(session, stmt, {})) {
      if (chunk.kind === 'done') stmtRows += chunk.rowCount
      if (chunk.kind === 'error') throw new Error(chunk.message)
    }
    rowCount += stmtRows
  }
  return { ok: true, rowCount }
}

/** Maakt kolomnamen uniek (duplicaten krijgen _2, _3, ...). */
export function dedupeColumns(columns: string[]): string[] {
  const seen = new Map<string, number>()
  return columns.map((c) => {
    const base = c || 'kolom'
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}_${n}`
  })
}
