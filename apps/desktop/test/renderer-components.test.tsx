import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResultsGrid, MessagesPanel } from '../src/renderer/src/components/ResultsGrid'

describe('ResultsGrid', () => {
  it('toont lege staat zonder resultaat', () => {
    const html = renderToStaticMarkup(<ResultsGrid result={null} />)
    expect(html).toContain('Voer een query uit om resultaten te zien.')
  })

  it('toont een foutmelding bij result.error', () => {
    const html = renderToStaticMarkup(
      <ResultsGrid result={{ executionId: 'e', columns: [], rows: [], truncated: false, rowCount: 0, durationMs: 0, error: 'near "LIMIT": syntax error' }} />
    )
    expect(html).toContain('near &quot;LIMIT&quot;: syntax error')
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
    expect(html).toContain('afgekapt')
  })
})

describe('MessagesPanel', () => {
  it('toont voltooid-melding', () => {
    const html = renderToStaticMarkup(
      <MessagesPanel result={{ executionId: 'e', columns: [], rows: [], truncated: false, rowCount: 2, durationMs: 4 }} />
    )
    expect(html).toContain('Query voltooid')
    expect(html).toContain('2 rij(en) in 4 ms')
  })

  it('toont fout in berichtenpaneel', () => {
    const html = renderToStaticMarkup(
      <MessagesPanel result={{ executionId: 'e', columns: [], rows: [], truncated: false, rowCount: 0, durationMs: 0, error: 'kapot' }} />
    )
    expect(html).toContain('Fout: kapot')
  })
})
