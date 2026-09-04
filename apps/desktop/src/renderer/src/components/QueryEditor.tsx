import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import type { ErrorPosition, SqlDialectId } from '@nvag/contracts'
import { useAppStore } from '../state/store'
import { createSqlCompletionProvider } from '../editor/sqlCompletion'

export interface QueryEditorProps {
  tabId: string
  sql: string
  connectionId?: string | null
  /** Dialect van de verbinding (bepaalt autocomplete-quoting + keywords). */
  dialect: SqlDialectId
  database: string
  schema?: string
  /** Foutpositie uit het laatste resultaat → regelmarkering (SAL-17). */
  errorPosition?: ErrorPosition | null
  /** Foutmelding horend bij `errorPosition` (marker-tooltip). */
  errorMessage?: string | null
  /** Wordt aangeroepen bij F5 / Ctrl+Enter (hele query). */
  onRun?: () => void
  /** Wordt aangeroepen bij Ctrl+Shift+E met de geselecteerde SQL. */
  onRunSelection?: (sql: string) => void
  onOpenFile?: () => void
  onSaveFile?: () => void
  onSaveFileAs?: () => void
}

export function QueryEditor({
  tabId,
  sql,
  connectionId,
  dialect,
  database,
  schema,
  errorPosition,
  errorMessage,
  onRun,
  onRunSelection,
  onOpenFile,
  onSaveFile,
  onSaveFileAs
}: QueryEditorProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const onRunRef = useRef(onRun)
  onRunRef.current = onRun
  const onRunSelectionRef = useRef(onRunSelection)
  onRunSelectionRef.current = onRunSelection
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile
  const onSaveFileRef = useRef(onSaveFile)
  onSaveFileRef.current = onSaveFile
  const onSaveFileAsRef = useRef(onSaveFileAs)
  onSaveFileAsRef.current = onSaveFileAs
  const updateTabSql = useAppStore((s) => s.updateTabSql)

  useEffect(() => {
    if (!containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      value: sql,
      language: 'sql',
      theme: 'vs-dark',
      automaticLayout: true,
      // F1-3: regelnummers, bracket-matching, find/replace, comment/uncomment
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      renderLineHighlight: 'all',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      autoClosingBrackets: 'always',
      autoClosingQuotes: 'always',
      find: { addExtraSpaceOnTop: false, autoFindInSelection: 'multiline' },
      occurrencesHighlight: 'singleFile',
      tabCompletion: 'on',
      minimap: { enabled: false },
      fontSize: 13,
      scrollBeyondLastLine: false,
      tabSize: 2,
      suggest: { showMethods: true }
    })
    editorRef.current = editor

    const sub = editor.onDidChangeModelContent(() => {
      updateTabSql(tabId, editor.getValue())
    })

    const runAll = (): void => onRunRef.current?.()
    const runSelection = (): void => {
      const selection = editor.getSelection()
      const model = editor.getModel()
      const selected = selection && model ? model.getValueInRange(selection).trim() : ''
      if (selected.length > 0) {
        onRunSelectionRef.current?.(selected)
      } else {
        // Zonder selectie: hele query uitvoeren (SSMS-gedrag)
        runAll()
      }
    }

    const actions = [
      // F5: query uitvoeren (hele tab)
      editor.addAction({
        id: `nvag.runAll.${tabId}`,
        label: 'Run query (F5)',
        keybindings: [monaco.KeyCode.F5],
        run: runAll
      }),
      // Ctrl+Enter: query uitvoeren (SAL-11)
      editor.addAction({
        id: `nvag.run.${tabId}`,
        label: 'Run query (Ctrl+Enter)',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        run: runAll
      }),
      // Ctrl+Shift+E: selectie uitvoeren
      editor.addAction({
        id: `nvag.runSelection.${tabId}`,
        label: 'Run selection',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
        run: runSelection
      }),
      // Ctrl+O: bestand openen · Ctrl+S / Ctrl+Shift+S: opslaan
      editor.addAction({
        id: `nvag.openFile.${tabId}`,
        label: 'Open query file…',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO],
        run: () => onOpenFileRef.current?.()
      }),
      editor.addAction({
        id: `nvag.saveFile.${tabId}`,
        label: 'Save query file',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
        run: () => onSaveFileRef.current?.()
      }),
      editor.addAction({
        id: `nvag.saveFileAs.${tabId}`,
        label: 'Save query file as…',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS],
        run: () => onSaveFileAsRef.current?.()
      })
    ]

    // Autocomplete (F1-3): objecten + kolommen + keywords uit metadata-cache
    let providerDisposable: monaco.IDisposable | undefined
    if (connectionId) {
      const provider = createSqlCompletionProvider({ connectionId, dialect, database, schema })
      providerDisposable = monaco.languages.registerCompletionItemProvider('sql', provider)
    }

    return () => {
      sub.dispose()
      actions.forEach((a) => a.dispose())
      providerDisposable?.dispose()
      editor.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, connectionId, dialect, database, schema])

  // SAL-17: foutpositie uit het resultaat → regelmarkering in Monaco.
  // Een nieuwe uitvoering (errorPosition === null) wist oude markers.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!model) return
    if (!errorPosition) {
      monaco.editor.setModelMarkers(model, 'nvag', [])
      return
    }
    const { line, column } = errorPosition
    monaco.editor.setModelMarkers(model, 'nvag', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: errorMessage ?? 'SQL error',
        startLineNumber: line,
        startColumn: column,
        endLineNumber: line,
        endColumn: column + 1
      }
    ])
  }, [errorPosition, errorMessage])

  return <div ref={containerRef} className="query-editor" />
}
