/**
 * F2-7: Import — parsers (CSV/JSON/XLSX/XML) + SQL-generatie.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { previewImport, generateImport, dedupeColumns } from './importer'

function tempFile(ext: string, content: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'nvag-import-'))
  const path = join(dir, `data.${ext}`)
  writeFileSync(path, content)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('F2-7 importer', () => {
  it('parseert CSV met header en genormaliseerde waarden', async () => {
    const t = tempFile('csv', 'naam,leeftijd\nJan,30\nPiet,40\n')
    const preview = await previewImport({ filePath: t.path, format: 'csv' })
    expect(preview.columns.map((c) => c.name)).toEqual(['naam', 'leeftijd'])
    expect(preview.totalRows).toBe(2)
    expect(preview.rows[0]).toEqual(['Jan', 30])
    t.cleanup()
  })

  it('parseert JSON-array van objecten', async () => {
    const t = tempFile('json', '[{"naam":"Jan","leeftijd":30},{"naam":"Piet","leeftijd":40}]')
    const preview = await previewImport({ filePath: t.path, format: 'json' })
    expect(preview.columns.map((c) => c.name)).toEqual(['naam', 'leeftijd'])
    expect(preview.rows[1]).toEqual(['Piet', 40])
    t.cleanup()
  })

  it('parseert XML met rij-elementen', async () => {
    const xml = `<?xml version="1.0"?>
<table>
  <row><naam>Jan</naam><leeftijd>30</leeftijd></row>
  <row><naam>Piet</naam><leeftijd>40</leeftijd></row>
</table>`
    const t = tempFile('xml', xml)
    const preview = await previewImport({ filePath: t.path, format: 'xml' })
    expect(preview.columns.map((c) => c.name)).toEqual(['naam', 'leeftijd'])
    expect(preview.totalRows).toBe(2)
    expect(preview.rows[0]).toEqual(['Jan', 30])
    t.cleanup()
  })

  it('genereert INSERT-SQL met dialect-quoting en mapping', async () => {
    const t = tempFile('csv', 'bron_a,bron_b\n1,twee\n3,vier\n')
    const result = await generateImport({
      filePath: t.path,
      format: 'csv',
      table: 'doel',
      schema: 'main',
      mapping: { 0: 'id', 1: 'label' },
      dialect: 'sqlite'
    })
    expect(result.rowCount).toBe(2)
    expect(result.sql).toContain('INSERT INTO "main"."doel" ("id", "label")')
    expect(result.sql).toContain("'twee'")
    expect(result.sql).toContain('VALUES (1,')
  })

  it('respecteert rowLimit bij genereren', async () => {
    const t = tempFile('csv', 'a,b\n1,2\n3,4\n5,6\n')
    const result = await generateImport({
      filePath: t.path,
      format: 'csv',
      table: 't',
      mapping: { 0: 'a', 1: 'b' },
      rowLimit: 2,
      dialect: 'sqlite'
    })
    expect(result.rowCount).toBe(2)
    expect(result.sql.split('INSERT').length - 1).toBe(2)
    t.cleanup()
  })

  it('maakt kolomnamen uniek bij duplicaten', () => {
    expect(dedupeColumns(['naam', 'naam', 'id'])).toEqual(['naam', 'naam_2', 'id'])
  })

  it('gooit bij ongeldige JSON', async () => {
    const t = tempFile('json', '{geen geldige json')
    await expect(previewImport({ filePath: t.path, format: 'json' })).rejects.toThrow()
    t.cleanup()
  })
})
