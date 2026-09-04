/**
 * Results-export (F1-7, SAL-20) — CSV via papaparse (streaming schrijven)
 * en XLSX via exceljs, vanuit de grid of vanuit het queryresultaat, naar
 * bestand (save-dialoog) of klembord.
 *
 * De puur-functionele helpers (normalizeCell, rowsToCsvString,
 * writeCsvStream, buildXlsxBuffer) zijn los gehouden van Electron zodat ze
 * eenvoudig unit-testbaar zijn; `exportResults` doet de Electron-integratie
 * (dialoog, clipboard, fs).
 */

import { BrowserWindow, clipboard, dialog } from 'electron'
import type { WebContents } from 'electron'
import { createWriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import Papa from 'papaparse'
import ExcelJS from 'exceljs'
import type { ExportColumn, ExportRequest, ExportResult } from '@nvag/contracts'

export type NormalizedCell = string | number | boolean | null

/** Aantal rijen per chunk bij streaming CSV-schrijven (geheugenbegrensd). */
export const CSV_STREAM_CHUNK = 10_000

// ---------------------------------------------------------------------------
// Normalisatie
// ---------------------------------------------------------------------------

/**
 * Maakt een ruwe celwaarde export-veilig: bigint → string, Uint8Array →
 * leesbare BLOB-aanduiding, undefined → null. Andere primitieven (string,
 * number, boolean) blijven zoals ze zijn zodat XLSX het type behoudt.
 */
export function normalizeCell(v: unknown): NormalizedCell {
  if (v === null || v === undefined) return null
  if (typeof v === 'bigint') return v.toString()
  if (v instanceof Uint8Array) return `[BLOB ${v.length} bytes]`
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  return String(v)
}

export function normalizeRows(rows: unknown[][]): NormalizedCell[][] {
  return rows.map((r) => r.map(normalizeCell))
}

/** Standaard CSV-scheidingsteken: ';' (Excel NL-locale). */
export const DEFAULT_DELIMITER = ';' as const

// ---------------------------------------------------------------------------
// CSV (papaparse)
// ---------------------------------------------------------------------------

/**
 * Volledige CSV-tekst (zonder BOM) via papaparse — RFC-4180-quoting,
 * rij-array in kolomvolgorde. Gebruikt voor klembord-export en in tests.
 */
export function rowsToCsvString(
  columns: ExportColumn[],
  rows: unknown[][],
  delimiter: ';' | ',' | '\t' = DEFAULT_DELIMITER
): string {
  const data: NormalizedCell[][] = [columns.map((c) => c.name || ''), ...normalizeRows(rows)]
  return Papa.unparse(data, { delimiter, newline: '\r\n' })
}

/**
 * Schrijft CSV streaming naar een bestand: eerst BOM + header, daarna de
 * rijen in chunks van `CSV_STREAM_CHUNK`. Zo blijft het geheugengebruik
 * begrensd, ook bij grote resultatensets (de volledige CSV-tekst wordt nooit
 * in één keer opgebouwd).
 */
export async function writeCsvStream(
  filePath: string,
  columns: ExportColumn[],
  rows: unknown[][],
  delimiter: ';' | ',' | '\t' = DEFAULT_DELIMITER
): Promise<void> {
  const out = createWriteStream(filePath)
  const header = columns.map((c) => c.name || '')
  const config: Papa.UnparseConfig = { delimiter, newline: '\r\n' }

  // UTF-8 BOM zodat Excel (NL-locale) de CSV correct als UTF-8 opent.
  out.write('\uFEFF')
  // papaparse voegt geen afsluitende newline toe; die schrijven we expliciet
  // zodat chunk-grenzen en het bestandseinde netjes afgesloten worden.
  out.write(Papa.unparse([header], config) + config.newline)

  const normalized = normalizeRows(rows)
  for (let i = 0; i < normalized.length; i += CSV_STREAM_CHUNK) {
    const chunk = normalized.slice(i, i + CSV_STREAM_CHUNK)
    out.write(Papa.unparse(chunk, config) + config.newline)
  }

  await new Promise<void>((resolve, reject) => {
    out.on('error', reject)
    out.end(() => resolve())
  })
}

// ---------------------------------------------------------------------------
// XLSX (exceljs)
// ---------------------------------------------------------------------------

/**
 * Bouwt een XLSX-buffer (workbook met één worksheet). Waardes blijven getypt:
 * numbers → numerieke cellen, booleans → boolean-cellen, null → lege cel.
 */
export async function buildXlsxBuffer(
  columns: ExportColumn[],
  rows: unknown[][]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Result', { views: [{ state: 'frozen', ySplit: 1 }] })

  ws.columns = columns.map((c, i) => ({
    header: c.name || `column ${i + 1}`,
    key: `c${i}`,
    width: Math.min(40, Math.max(10, (c.name || `column ${i + 1}`).length + 2))
  }))

  // Header vet (zichtbaar onderscheid t.o.v. data).
  const headerRow = ws.getRow(1)
  headerRow.font = { bold: true }

  for (const row of normalizeRows(rows)) {
    ws.addRow(row)
  }

  const lastColumn = ws.getColumn(columns.length)
  if (columns.length > 0 && rows.length > 0) {
    ws.autoFilter = { from: 'A1', to: `${lastColumn.letter}${rows.length + 1}` }
  }

  const buf = await wb.xlsx.writeBuffer()
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer)
}

// ---------------------------------------------------------------------------
// Electron-integratie
// ---------------------------------------------------------------------------

function showSaveDialog(
  sender: WebContents,
  req: { defaultFileName: string; filterName: string; extension: string }
): Promise<{ canceled: boolean; filePath?: string }> {
  const win = BrowserWindow.fromWebContents(sender)
  const options = {
    title: 'Export results',
    defaultPath: req.defaultFileName,
    filters: [{ name: req.filterName, extensions: [req.extension] }]
  }
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

/**
 * Voert een export uit op basis van format/target:
 * - csv + file      → save-dialoog + streaming schrijven (papaparse)
 * - csv + clipboard → papaparse → Electron clipboard
 * - xlsx + file     → save-dialoog + exceljs-buffer schrijven
 * - xlsx + clipboard→ niet ondersteund (Excel plakt geen ruwe xlsx-bytes)
 */
export async function exportResults(req: ExportRequest, sender: WebContents): Promise<ExportResult> {
  const fileName = req.fileName || 'result'
  const rowCount = req.rows.length

  if (req.format === 'xlsx' && req.target === 'clipboard') {
    return { error: 'XLSX to clipboard is not supported; export to a file or use CSV.' }
  }

  try {
    if (req.target === 'clipboard') {
      const csv = rowsToCsvString(req.columns, req.rows, req.delimiter ?? DEFAULT_DELIMITER)
      clipboard.writeText(csv)
      return { ok: true, rowCount }
    }

    // target === 'file'
    const isCsv = req.format === 'csv'
    const extension = isCsv ? 'csv' : 'xlsx'
    const result = await showSaveDialog(sender, {
      defaultFileName: `${fileName}.${extension}`,
      filterName: isCsv ? 'CSV file' : 'Excel workbook',
      extension
    })
    if (result.canceled || !result.filePath) return { canceled: true }

    if (isCsv) {
      await writeCsvStream(result.filePath, req.columns, req.rows, req.delimiter ?? DEFAULT_DELIMITER)
    } else {
      const buf = await buildXlsxBuffer(req.columns, req.rows)
      await writeFile(result.filePath, buf)
    }
    return { canceled: false, filePath: result.filePath, rowCount }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Backward-compat (SAL-17): 'query:exportCsv' met kant-en-klare CSV-tekst
// ---------------------------------------------------------------------------

export interface SaveCsvRequest {
  defaultFileName: string
  csv: string
}

export async function saveCsv(
  req: SaveCsvRequest,
  sender: WebContents
): Promise<{ canceled: boolean; filePath?: string }> {
  const win = BrowserWindow.fromWebContents(sender)
  const options = {
    title: 'Save results as CSV',
    defaultPath: req.defaultFileName,
    filters: [{ name: 'CSV file', extensions: ['csv'] }]
  }
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { canceled: true }

  // UTF-8 BOM zodat Excel (NL-locale, ;-scheiding) de CSV correct opent.
  await writeFile(result.filePath, '\uFEFF' + req.csv, 'utf8')
  return { canceled: false, filePath: result.filePath }
}
