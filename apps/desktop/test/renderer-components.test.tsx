import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResultsGrid, MessagesPanel, rowsToTsv, rowsToCsv, toDisplayValue } from '../src/renderer/src/components/ResultsGrid'

describe('ResultsGrid', () => {
  it('toont lege staat zonder resultaat', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={null} />)
    expect(html).toContain('Run a query to see results.')
  })

  it('toont lege staat bij een foutresultaat zonder kolommen (fout zit in Messages)', () => {
    const html = renderToStaticMarkup(
      <ResultsGrid result={{ executionId: 'e', columns: [], rows: [], truncated: false, rowCount: 0, durationMs: 0, error: 'near "LIMIT": syntax error' }} />
    )
    expect(html).toContain('Query executed. 0 row(s) affected.')
  })

  it('toont kolommen en rijen inclusief NULL', () => {
    const html = renderToStaticMarkup(
      <ResultsGrid
        result={{
          executionId: 'e',
          columns: [{ name: 'id' }, { name: 'naam' }],
          rows: [{ values: [1, 'Alice'] }, { values: [2, null] }],
          truncated: false,
          rowCount: 2,
          durationMs: 3
        }}
      />
    )
    expect(html).toContain('id')
    expect(html).toContain('naam')
    expect(html).toContain('Alice')
    expect(html).toContain('NULL')
  })

  it('toont afkapping-melding wanneer getrunceerd', () => {
    const html = renderToStaticMarkup(
      <ResultsGrid
        result={{
          executionId: 'e',
          columns: [{ name: 'id' }],
          rows: [{ values: [1] }],
          truncated: true,
          rowCount: 1,
          durationMs: 3
        }}
      />
    )
    expect(html).toContain('truncated')
  })
})

describe('MessagesPanel', () => {
  it('toont voltooid-melding', () => {
    const html = renderToStaticMarkup(
      <MessagesPanel result={{ executionId: 'e', columns: [], rows: [], truncated: false, rowCount: 2, durationMs: 4 }} />
    )
    expect(html).toContain('Query completed')
    expect(html).toContain('2 row(s) in 4 ms')
  })

  it('toont fout in berichtenpaneel', () => {
    const html = renderToStaticMarkup(
      <MessagesPanel result={{ executionId: 'e', columns: [], rows: [], truncated: false, rowCount: 0, durationMs: 0, error: 'kapot' }} />
    )
    expect(html).toContain('msg-error')
    expect(html).toContain('Error:')
    expect(html).toContain('kapot')
  })

  it('toont waarschuwingen uit result.messages (SAL-17)', () => {
    const html = renderToStaticMarkup(
      <MessagesPanel
        result={{
          executionId: 'e',
          columns: [{ name: 'id' }],
          rows: [],
          truncated: true,
          rowCount: 1000,
          durationMs: 3,
          messages: [
            { severity: 'warning', text: 'Result truncated at the maximum row cap.' },
            { severity: 'info', text: 'Guide: NULL is empty.' }
          ]
        }}
      />
    )
    expect(html).toContain('Warning:')
    expect(html).toContain('Result truncated at the maximum row cap.')
    expect(html).toContain('Info:')
    expect(html).toContain('Guide: NULL is empty.')
    expect(html).toContain('1000 row(s) in 3 ms')
  })

  it('toont een geannuleerde query (SAL-17)', () => {
    const html = renderToStaticMarkup(
      <MessagesPanel
        result={{
          executionId: 'e',
          columns: [],
          rows: [],
          truncated: false,
          rowCount: 0,
          durationMs: 42,
          cancelled: true
        }}
      />
    )
    expect(html).toContain('Cancelled:')
    expect(html).toContain('Query cancelled by user.')
  })

  it('toont de positie van een fout in het berichtenpaneel (SAL-17)', () => {
    const html = renderToStaticMarkup(
      <MessagesPanel
        result={{
          executionId: 'e',
          columns: [],
          rows: [],
          truncated: false,
          rowCount: 0,
          durationMs: 0,
          error: 'near "FOUT": syntax error',
          errorPosition: { line: 3, column: 7 },
          messages: [{ severity: 'error', text: 'near "FOUT": syntax error', position: { line: 3, column: 7 } }]
        }}
      />
    )
    expect(html).toContain('line 3, column 7')
  })
})

describe('ResultsGrid — meerdere resultsets (SAL-17)', () => {
  it('toont tabs per resultatenset', () => {
    const html = renderToStaticMarkup(
      <ResultsGrid
        result={{
          executionId: 'e',
          columns: [{ name: 'a' }],
          rows: [{ values: [1] }],
          truncated: false,
          rowCount: 1,
          durationMs: 2,
          results: [
            { columns: [{ name: 'a' }], rows: [{ values: [1] }], truncated: false, rowCount: 1 },
            { columns: [{ name: 'b' }], rows: [{ values: [2] }], truncated: false, rowCount: 1 }
          ]
        }}
      />
    )
    expect(html).toContain('Result 1')
    expect(html).toContain('Result 2')
    // Alleen de actieve set wordt gerenderd; set 2 zit in de tab-knop.
    expect(html).toContain('>a<')
    expect(html).not.toContain('>b<')
  })

  it('toont een melding bij DML zonder kolommen', () => {
    const html = renderToStaticMarkup(
      <ResultsGrid
        result={{ executionId: 'e', columns: [], rows: [], truncated: false, rowCount: 3, durationMs: 4 }}
      />
    )
    expect(html).toContain('3 row(s) affected in 4 ms.')
  })
})

describe('export-helpers (SAL-17)', () => {
  const columns = [{ name: 'id' }, { name: 'naam' }]
  const rows = [
    { col_0: 1, col_1: 'Jan' },
    { col_0: 2, col_1: null },
    { col_0: 3, col_1: 'met "quote" en ; komma' }
  ]

  it('rowsToTsv: NULL leeg, tabs/nieuwe regels/quotes gequote', () => {
    const tsv = rowsToTsv(columns, rows)
    const lines = tsv.split('\n')
    expect(lines[0]).toBe('id\tnaam')
    expect(lines[1]).toBe('1\tJan')
    expect(lines[2]).toBe('2\t')
    expect(lines[3]).toContain('"met ""quote"" en ; komma"')
  })

  it('rowsToCsv: ;-gescheiden met quotering en NULL leeg', () => {
    const csv = rowsToCsv(columns, rows)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('id;naam')
    expect(lines[1]).toBe('1;Jan')
    expect(lines[2]).toBe('2;')
    expect(lines[3]).toContain('"met ""quote"" en ; komma"')
  })

  it('toDisplayValue: blob en bigint leesbaar maken', () => {
    expect(toDisplayValue(null)).toBeNull()
    expect(toDisplayValue(123n)).toBe('123')
    expect(toDisplayValue(new Uint8Array([1, 2, 3]))).toBe('[BLOB 3 bytes]')
  })
})
