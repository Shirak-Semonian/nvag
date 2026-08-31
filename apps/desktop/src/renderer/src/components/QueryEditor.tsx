import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { useAppStore } from '../state/store'

interface QueryEditorProps {
  tabId: string
  sql: string
  /** Wordt aangeroepen bij Ctrl+Enter (of Cmd+Enter op macOS). */
  onRun?: () => void
}

export function QueryEditor({ tabId, sql, onRun }: QueryEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
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

    // Ctrl+Enter / Cmd+Enter: query uitvoeren (SAL-11)
    const runAction = editor.addAction({
      id: `nvag.run.${tabId}`,
      label: 'Query uitvoeren',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => onRunRef.current?.()
    })

    return () => {
      sub.dispose()
      runAction.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  return <div ref={containerRef} className="query-editor" />
}
