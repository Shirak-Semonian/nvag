import { beforeEach, describe, expect, it } from 'vitest'
import { createSqlCompletionProvider, resolveTableAlias } from './sqlCompletion'
import { metadataCache } from './metadataCache'
import { createMockNvag, sampleTableMetadata } from '../test/mockNvag'
import type { NvagIpcApi } from '@nvag/contracts'

/**
 * Test de completion-provider zonder Monaco zelf: `provideCompletionItems`
 * wordt direct aangeroepen met een fake model (zelfde vorm als de
 * Monaco-editor-API).
 */

interface FakeModel {
  getLineContent(lineNumber: number): string
  getWordUntilPosition(position: { lineNumber: number; column: number }): {
    word: string
    startColumn: number
    endColumn: number
  }
  getValue(): string
}

function makeModel(lines: string[], cursorLine: number, cursorColumn: number): FakeModel {
  const lineText = lines[cursorLine - 1] ?? ''
  return {
    getLineContent: (ln: number) => lines[ln - 1] ?? '',
    getWordUntilPosition: () => {
      const before = lineText.slice(0, cursorColumn - 1)
      const m = /[A-Za-z0-9_$]*$/.exec(before)
      const word = m?.[0] ?? ''
      return { word, startColumn: cursorColumn - word.length, endColumn: cursorColumn }
    },
    getValue: () => lines.join('\n')
  }
}

function position(line: number, column: number): { lineNumber: number; column: number } {
  return { lineNumber: line, column }
}

let mock: NvagIpcApi & { queriedSql: string[] }

async function getSuggestions(
  provider: ReturnType<typeof createSqlCompletionProvider>,
  model: FakeModel,
  pos: { lineNumber: number; column: number }
): Promise<Array<{ label: string; insertText?: string; detail?: string; kind?: number }>> {
  const result = await provider.provideCompletionItems?.(
    model as never,
    pos as never,
    { triggerKind: 0, triggerCharacter: undefined } as never,
    { isCancellationRequested: false } as never
  )
  return (result?.suggestions ?? []) as Array<{ label: string; insertText?: string; detail?: string; kind?: number }>
}

beforeEach(() => {
  metadataCache.reset()
  mock = createMockNvag({
    tables: ['klanten'],
    views: ['v_klanten'],
    procedures: ['sp_rapport'],
    functions: ['fn_aantal'],
    tableMetadata: { klanten: sampleTableMetadata('klanten') }
  })
  window.nvag = mock
})

describe('sqlCompletion provider', () => {
  it('suggereert objecten met dialect-quoting (sqlite → "x")', async () => {
    const provider = createSqlCompletionProvider({
      connectionId: 'conn-1',
      dialect: 'sqlite',
      database: 'main',
      schema: 'main'
    })
    const model = makeModel(['SEL'], 1, 4)
    const suggestions = await getSuggestions(provider, model, position(1, 4))

    const labels = suggestions.map((s) => s.label)
    expect(labels).toContain('klanten')
    expect(labels).toContain('v_klanten')
    expect(labels).toContain('sp_rapport')
    expect(labels).toContain('fn_aantal')

    const table = suggestions.find((s) => s.label === 'klanten')
    expect(table?.insertText).toBe('"klanten"')
    const view = suggestions.find((s) => s.label === 'v_klanten')
    expect(view?.insertText).toBe('"v_klanten"')
  })

  it('quoot dialect-correct voor tsql ([x]) en mysql (`x`)', async () => {
    const providerTsql = createSqlCompletionProvider({
      connectionId: 'conn-1',
      dialect: 'tsql',
      database: 'db',
      schema: 'dbo'
    })
    const model = makeModel(['SEL'], 1, 4)
    const tsqlSuggestions = await getSuggestions(providerTsql, model, position(1, 4))
    expect(tsqlSuggestions.find((s) => s.label === 'klanten')?.insertText).toBe('[klanten]')

    const providerMysql = createSqlCompletionProvider({
      connectionId: 'conn-1',
      dialect: 'mysql',
      database: 'db'
    })
    const mysqlSuggestions = await getSuggestions(providerMysql, model, position(1, 4))
    expect(mysqlSuggestions.find((s) => s.label === 'klanten')?.insertText).toBe('`klanten`')
  })

  it('suggereert kolommen bij tabel. (F1-3)', async () => {
    const provider = createSqlCompletionProvider({
      connectionId: 'conn-1',
      dialect: 'sqlite',
      database: 'main',
      schema: 'main'
    })
    const model = makeModel(['SELECT klanten.'], 1, 15)
    const suggestions = await getSuggestions(provider, model, position(1, 15))

    const labels = suggestions.map((s) => s.label)
    expect(labels).toContain('id')
    expect(labels).toContain('naam')
    expect(suggestions.find((s) => s.label === 'naam')?.detail).toBe('TEXT')
  })

  it('resolutie van aliassen: `FROM klanten k` → `k.` toont kolommen', async () => {
    const provider = createSqlCompletionProvider({
      connectionId: 'conn-1',
      dialect: 'sqlite',
      database: 'main',
      schema: 'main'
    })
    const model = makeModel(['SELECT k.', 'FROM klanten k'], 1, 9)
    const suggestions = await getSuggestions(provider, model, position(1, 9))

    const labels = suggestions.map((s) => s.label)
    expect(labels).toContain('naam')
  })

  it('voegt dialect-specifieke keywords toe (tsql: TOP, sqlite: niet)', async () => {
    const providerTsql = createSqlCompletionProvider({
      connectionId: 'conn-1',
      dialect: 'tsql',
      database: 'db'
    })
    const model = makeModel(['SEL'], 1, 4)
    const tsqlSuggestions = await getSuggestions(providerTsql, model, position(1, 4))
    expect(tsqlSuggestions.some((s) => s.label === 'TOP')).toBe(true)

    const providerSqlite = createSqlCompletionProvider({
      connectionId: 'conn-1',
      dialect: 'sqlite',
      database: 'main'
    })
    const sqliteSuggestions = await getSuggestions(providerSqlite, model, position(1, 4))
    expect(sqliteSuggestions.some((s) => s.label === 'TOP')).toBe(false)
    expect(sqliteSuggestions.some((s) => s.label === 'SELECT')).toBe(true)
  })

  it('geeft geen suggesties zonder verbinding', async () => {
    const provider = createSqlCompletionProvider({ connectionId: null, dialect: 'sqlite', database: 'main' })
    const model = makeModel(['SEL'], 1, 4)
    const suggestions = await getSuggestions(provider, model, position(1, 4))
    expect(suggestions).toHaveLength(0)
  })
})

describe('resolveTableAlias', () => {
  it('vindt een alias in FROM', () => {
    expect(resolveTableAlias('SELECT * FROM klanten k', 'k')).toBe('klanten')
    expect(resolveTableAlias('SELECT * FROM klanten AS k', 'k')).toBe('klanten')
  })

  it('vindt de tabel zelf zonder alias', () => {
    expect(resolveTableAlias('SELECT * FROM klanten', 'klanten')).toBe('klanten')
  })

  it('geeft null voor onbekende referenties', () => {
    expect(resolveTableAlias('SELECT * FROM klanten k', 'onbekend')).toBeNull()
  })
})
