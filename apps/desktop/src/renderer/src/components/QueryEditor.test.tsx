import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryEditor } from './QueryEditor'
import { captured as monacoCaptured, KeyCode, KeyMod } from '../../../../test/mocks/monaco-editor'

/**
 * monaco-editor wordt via resolve.alias in vitest.config.ts vervangen door
 * test/mocks/monaco-editor.ts (package heeft geen main/exports → resolutie
 * faalt in jsdom). De mock vangt addAction/keybindings en de
 * completion-provider op in `captured`.
 */
describe('QueryEditor', () => {
  beforeEach(() => {
    monacoCaptured.run = undefined
    monacoCaptured.createCount = 0
    monacoCaptured.actions = {}
    monacoCaptured.provider = undefined
    monacoCaptured.providerLanguage = undefined
    monacoCaptured.providerDisposed = false
    monacoCaptured.selection = undefined
    monacoCaptured.modelValue = undefined
    monacoCaptured.rangeValue = undefined
  })

  it('registreert Ctrl+Enter en roept onRun aan (SAL-11)', () => {
    const onRun = vi.fn()
    render(<QueryEditor tabId="tab-1" sql="SELECT 1;" dialect="sqlite" database="main" onRun={onRun} />)

    expect(monacoCaptured.createCount).toBe(1)
    expect(monacoCaptured.run).toBeTypeOf('function')

    act(() => {
      monacoCaptured.run?.()
    })
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('is veilig zonder onRun (keybinding doet niets)', () => {
    render(<QueryEditor tabId="tab-1" sql="SELECT 1;" dialect="sqlite" database="main" />)
    expect(() => {
      act(() => {
        monacoCaptured.run?.()
      })
    }).not.toThrow()
  })

  it('registreert F5 als run-all-actie (F1-3)', () => {
    const onRun = vi.fn()
    render(<QueryEditor tabId="tab-1" sql="SELECT 1;" dialect="sqlite" database="main" onRun={onRun} />)

    const f5 = monacoCaptured.actions['nvag.runAll.tab-1']
    expect(f5).toBeDefined()
    expect(f5?.keybindings).toContain(KeyCode.F5)

    act(() => f5?.run())
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('voert de selectie uit bij Ctrl+Shift+E (F1-3)', () => {
    const onRunSelection = vi.fn()
    const onRun = vi.fn()
    render(
      <QueryEditor
        tabId="tab-1"
        sql="SELECT 1;\nSELECT 2;"
        dialect="sqlite"
        database="main"
        onRun={onRun}
        onRunSelection={onRunSelection}
      />
    )

    const runSelection = monacoCaptured.actions['nvag.runSelection.tab-1']
    expect(runSelection).toBeDefined()
    expect(runSelection?.keybindings).toContain(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyE)

    monacoCaptured.selection = { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 9 }
    monacoCaptured.rangeValue = 'SELECT 2;'
    act(() => runSelection?.run())

    expect(onRunSelection).toHaveBeenCalledWith('SELECT 2;')
    expect(onRun).not.toHaveBeenCalled()
  })

  it('valt terug op de hele query bij Ctrl+Shift+E zonder selectie (F1-3)', () => {
    const onRun = vi.fn()
    const onRunSelection = vi.fn()
    render(
      <QueryEditor tabId="tab-1" sql="SELECT 1;" dialect="sqlite" database="main" onRun={onRun} onRunSelection={onRunSelection} />
    )

    monacoCaptured.selection = null
    monacoCaptured.rangeValue = ''
    act(() => monacoCaptured.actions['nvag.runSelection.tab-1']?.run())

    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRunSelection).not.toHaveBeenCalled()
  })

  it('registreert open/save/opslaan-als acties (F1-3)', () => {
    const onOpenFile = vi.fn()
    const onSaveFile = vi.fn()
    const onSaveFileAs = vi.fn()
    render(
      <QueryEditor
        tabId="tab-1"
        sql="SELECT 1;"
        dialect="sqlite"
        database="main"
        onOpenFile={onOpenFile}
        onSaveFile={onSaveFile}
        onSaveFileAs={onSaveFileAs}
      />
    )

    act(() => monacoCaptured.actions['nvag.openFile.tab-1']?.run())
    act(() => monacoCaptured.actions['nvag.saveFile.tab-1']?.run())
    act(() => monacoCaptured.actions['nvag.saveFileAs.tab-1']?.run())

    expect(onOpenFile).toHaveBeenCalledTimes(1)
    expect(onSaveFile).toHaveBeenCalledTimes(1)
    expect(onSaveFileAs).toHaveBeenCalledTimes(1)
  })

  it('registreert de autocomplete-provider bij een verbinding en disposed hem (F1-3)', () => {
    const { unmount } = render(
      <QueryEditor tabId="tab-1" sql="SELECT " connectionId="conn-1" dialect="sqlite" database="main" schema="main" />
    )

    expect(monacoCaptured.providerLanguage).toBe('sql')
    expect(monacoCaptured.provider).toBeTypeOf('object')

    unmount()
    expect(monacoCaptured.providerDisposed).toBe(true)
  })

  it('registreert geen provider zonder verbinding', () => {
    render(<QueryEditor tabId="tab-1" sql="SELECT 1;" dialect="sqlite" database="main" />)
    expect(monacoCaptured.provider).toBeUndefined()
  })
})
