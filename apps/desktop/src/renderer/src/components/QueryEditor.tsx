import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { useAppStore } from '../state/store'

interface QueryEditorProps {
  tabId: string
  sql: string
}

export function QueryEditor({ tabId, sql }: QueryEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const updateTabSql = useAppStore((s) => s.updateTabSql)

  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      value: sql,
      language: 'sql',
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'all',
      tabSize: 2,
      suggest: { showMethods: true }
    })
    editorRef.current = editor

    const sub = editor.onDidChangeModelContent(() => {
      updateTabSql(tabId, editor.getValue())
    })

    return () => {
      sub.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  return <div ref={containerRef} className="query-editor" />
}
