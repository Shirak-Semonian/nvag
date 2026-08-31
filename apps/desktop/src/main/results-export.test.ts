/**
 * Unit-tests voor results-export (F1-7, SAL-20): papaparse-CSV (streaming
 * schrijven) en exceljs-XLSX, naar bestand of klembord. Electron wordt
 * gemockt; de puur-functionele helpers draaien echt (temp-bestanden).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'

vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
  clipboard: { writeText: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(() => null) }
}))

import { BrowserWindow, clipboard, dialog } from 'electron'
import type { ExportRequest } from '@nvag/contracts'
import {
  buildXlsxBuffer,
  CSV_STREAM_CHUNK,
  exportResults,
  normalizeCell,
  rowsToCsvString,
  writeCsvStream
} from './results-export'

const sender = { isDestroyed: () => false } as never

const columns = [
  { name: 'id', dataType: 'INTEGER' },
  { name: 'naam', dataType: 'TEXT' }
]

function baseReq(over: Partial<ExportRequest> = {}): ExportRequest {
  return {
    format: 'csv',
    target: 'file',
    fileName: 'resultaat-test',
    columns,
    rows: [
      [1, 'Jan'],
      [2, null],
      [3, 'met "quote" en ; komma'],
      [4n, new Uint8Array([1, 2, 3])]
    ],
    ...over
  }
}

describe('normalizeCell', () => {
  it('normaliseert bigint en Uint8Array; laat primitieven intact', () => {
    expect(normalizeCell(null)).toBeNull()
    expect(normalizeCell(undefined)).toBeNull()
    expect(normalizeCell(42)).toBe(42)
    expect(normalizeCell('x')).toBe('x')
    expect(normalizeCell(true)).toBe(true)
    expect(normalizeCell(123n)).toBe('123')
    expect(normalizeCell(new Uint8Array([1, 2, 3]))).toBe('[BLOB 3 bytes]')
  })
})

describe('rowsToCsvString (papaparse)', () => {
  it('maakt ;-gescheiden CSV met RFC-4180-quoting; NULL wordt leeg', () => {
    const csv = rowsToCsvString(columns, [
      [1, 'Jan'],
      [2, null],
      [3, 'met "quote" en ; komma']
    ])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('id;naam')
    expect(lines[1]).toBe('1;Jan')
    expect(lines[2]).toBe('2;')
    expect(lines[3]).toBe('3;"met ""quote"" en ; komma"')
  })

  it('respecteert een ander scheidingsteken (komma)', () => {
    const csv = rowsToCsvString(columns, [[1, 'Jan']], ',')
    expect(csv.split('\r\n')[0]).toBe('id,naam')
    expect(csv.split('\r\n')[1]).toBe('1,Jan')
  })

  it('normaliseert bigint/blob ook in de string-route', () => {
    const csv = rowsToCsvString(columns, [[4n, new Uint8Array([1, 2, 3])]])
    expect(csv).toContain('4;[BLOB 3 bytes]')
  })
})

describe('writeCsvStream (streaming, papaparse)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nvag-export-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('schrijft BOM + header + rijen in chunks naar het bestand', async () => {
    const file = join(dir, 'resultaat.csv')
    // Meer rijen dan één chunk om het chunk-pad te raken.
    const rows: unknown[][] = Array.from({ length: CSV_STREAM_CHUNK + 50 }, (_, i) => [i, `rij ${i}`])
    await writeCsvStream(file, columns, rows)

    const content = readFileSync(file, 'utf8')
    expect(content.startsWith('\uFEFFid;naam\r\n')).toBe(true)
    expect(content).toContain('\r\n0;rij 0\r\n')
    expect(content).toContain('\r\n9999;rij 9999\r\n')
    expect(content).toContain('\r\n10049;rij 10049\r\n')
    // Elke rij exact één keer (header + CSV_STREAM_CHUNK + 50 rijen).
    expect(content.match(/\r\n/g)?.length ?? 0).toBe(rows.length + 1)
  })

  it('schrijft een lege dataset met alleen header', async () => {
    const file = join(dir, 'leeg.csv')
    await writeCsvStream(file, columns, [])
    const content = readFileSync(file, 'utf8')
    expect(content.startsWith('\uFEFFid;naam\r\n')).toBe(true)
  })
})

describe('buildXlsxBuffer (exceljs)', () => {
  it('bouwt een werkmap met getypte celwaarden (number blijft number)', async () => {
    const buf = await buildXlsxBuffer(columns, [
      [1, 'Jan'],
      [2, null],
      [4n, 'big']
    ])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
    const ws = wb.getWorksheet('Resultaat')
    expect(ws).toBeDefined()
    expect(ws!.getRow(1).getCell(1).value).toBe('id')
    expect(ws!.getRow(1).getCell(2).value).toBe('naam')
    expect(ws!.getRow(2).getCell(1).value).toBe(1)
    expect(typeof ws!.getRow(2).getCell(1).value).toBe('number')
    expect(ws!.getRow(2).getCell(2).value).toBe('Jan')
    expect(ws!.getRow(3).getCell(2).value).toBeNull()
    // bigint → string (Excel kent geen bigint)
    expect(ws!.getRow(4).getCell(1).value).toBe('4')
  })
})

describe('exportResults (electron-integratie)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nvag-export-'))
    vi.mocked(dialog.showSaveDialog).mockReset()
    vi.mocked(clipboard.writeText).mockReset()
    vi.mocked(BrowserWindow.fromWebContents).mockReset()
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('csv → bestand: save-dialoog en BOM-CSV op schijf', async () => {
    const file = join(dir, 'out.csv')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: file })
    const res = await exportResults(baseReq(), sender)
    expect(res).toEqual({ canceled: false, filePath: file, rowCount: 4 })
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'resultaat-test.csv', filters: [{ name: 'CSV-bestand', extensions: ['csv'] }] })
    )
    expect(readFileSync(file, 'utf8').startsWith('\uFEFFid;naam\r\n')).toBe(true)
  })

  it('csv → bestand: annuleren levert canceled zonder bestand', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: '' })
    const res = await exportResults(baseReq(), sender)
    expect(res).toEqual({ canceled: true })
  })

  it('csv → klembord: clipboard.writeText met de CSV-tekst', async () => {
    const res = await exportResults(baseReq({ target: 'clipboard' }), sender)
    expect(res).toEqual({ ok: true, rowCount: 4 })
    expect(clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining('id;naam\r\n1;Jan\r\n')
    )
  })

  it('xlsx → bestand: schrijft een geldige werkmap', async () => {
    const file = join(dir, 'out.xlsx')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: file })
    const res = await exportResults(baseReq({ format: 'xlsx' }), sender)
    expect(res).toEqual({ canceled: false, filePath: file, rowCount: 4 })
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: 'resultaat-test.xlsx', filters: [{ name: 'Excel-werkmap', extensions: ['xlsx'] }] })
    )
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(readFileSync(file) as unknown as ArrayBuffer)
    expect(wb.getWorksheet('Resultaat')?.getRow(1).getCell(1).value).toBe('id')
  })

  it('xlsx → klembord: niet ondersteund, geeft een fout terug', async () => {
    const res = await exportResults(baseReq({ format: 'xlsx', target: 'clipboard' }), sender)
    expect(res.error).toContain('niet ondersteund')
  })
})
