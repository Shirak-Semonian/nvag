import { beforeEach, describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { QueryEditor } from '../src/renderer/src/components/QueryEditor'
import { captured as monacoCaptured, MarkerSeverity } from './mocks/monaco-editor'

/**
 * SAL-17: error-position → regelmarkering in Monaco. De monaco-mock vangt
 * `editor.setModelMarkers` op in `captured.markers`.
 */
describe('QueryEditor — error-position markers (SAL-17)', () => {
  beforeEach(() => {
    monacoCaptured.createCount = 0
    monacoCaptured.markers = undefined
    monacoCaptured.markerOwner = undefined
  })

  it('zet een error-marker op de foutpositie', () => {
    render(
      <QueryEditor
        tabId="tab-1"
        sql="SELECT FOUT;"
        dialect="sqlite"
        database="main"
        errorPosition={{ line: 1, column: 8 }}
        errorMessage='near "FOUT": syntax error'
      />
    )

    expect(monacoCaptured.markerOwner).toBe('nvag')
    expect(monacoCaptured.markers).toHaveLength(1)
    const marker = monacoCaptured.markers?.[0] as {
      severity?: number
      message?: string
      startLineNumber?: number
      startColumn?: number
    }
    expect(marker?.severity).toBe(MarkerSeverity.Error)
    expect(marker?.message).toBe('near "FOUT": syntax error')
    expect(marker?.startLineNumber).toBe(1)
    expect(marker?.startColumn).toBe(8)
  })

  it('wist markers wanneer er geen foutpositie is (nieuwe run)', () => {
    const { rerender } = render(
      <QueryEditor
        tabId="tab-1"
        sql="SELECT FOUT;"
        dialect="sqlite"
        database="main"
        errorPosition={{ line: 1, column: 8 }}
      />
    )
    expect(monacoCaptured.markers).toHaveLength(1)

    rerender(
      <QueryEditor tabId="tab-1" sql="SELECT 1;" dialect="sqlite" database="main" errorPosition={null} />
    )
    expect(monacoCaptured.markers).toEqual([])
  })
})
