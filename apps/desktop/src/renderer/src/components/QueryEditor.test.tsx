import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryEditor } from './QueryEditor'
import { captured as monacoCaptured } from '../../../../test/mocks/monaco-editor'

/**
 * monaco-editor wordt via resolve.alias in vitest.config.ts vervangen door
 * test/mocks/monaco-editor.ts (package heeft geen main/exports → resolutie
 * faalt in jsdom). De mock vangt addAction (Ctrl+Enter) op in `captured`.
 */
describe('QueryEditor', () => {
  beforeEach(() => {
    monacoCaptured.run = undefined
    monacoCaptured.createCount = 0
  })

  it('registreert Ctrl+Enter en roept onRun aan (SAL-11)', () => {
    const onRun = vi.fn()
    render(<QueryEditor tabId="tab-1" sql="SELECT 1;" onRun={onRun} />)

    expect(monacoCaptured.createCount).toBe(1)
    expect(monacoCaptured.run).toBeTypeOf('function')

    act(() => {
      monacoCaptured.run?.()
    })
    expect(onRun).toHaveBeenCalledTimes(1)
  })

  it('is veilig zonder onRun (keybinding doet niets)', () => {
    render(<QueryEditor tabId="tab-1" sql="SELECT 1;" />)
    expect(() => {
      act(() => {
        monacoCaptured.run?.()
      })
    }).not.toThrow()
  })
})
