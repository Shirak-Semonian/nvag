/**
 * Test-mock voor monaco-editor (package heeft geen main/exports → vite/vitest
 * kan de entry niet resolven in jsdom; via resolve.alias in vitest.config.ts).
 *
 * Houdt dezelfde vorm als de echte API die QueryEditor gebruikt: editor.create,
 * addAction (F5/Ctrl+Enter/Ctrl+Shift+E/open/save), getSelection/getModel en
 * languages.registerCompletionItemProvider. `captured` laat tests de
 * geregistreerde acties uitoefenen en de completion-provider inspecteren.
 */

interface CapturedAction {
  run: () => void
  keybindings: number[]
}

export const captured: {
  run?: () => void
  createCount: number
  actions: Record<string, CapturedAction>
  provider?: unknown
  providerLanguage?: string
  providerDisposed: boolean
  /** Door tests in te stellen voor getSelection/getModel. */
  selection?: unknown
  modelValue?: string
  rangeValue?: string
  /** Laatste setModelMarkers-aanroep (SAL-17, error-position). */
  markers?: unknown[]
  markerOwner?: string
} = {
  createCount: 0,
  actions: {},
  providerDisposed: false
}

export const editor = {
  create: () => {
    captured.createCount += 1
    return {
      onDidChangeModelContent: () => ({ dispose: () => undefined }),
      addAction: (desc: { id: string; run: () => void; keybindings: number[] }) => {
        captured.actions[desc.id] = { run: desc.run, keybindings: desc.keybindings }
        // Backward-compat met SAL-11-tests: `.run.` is de Ctrl+Enter-actie.
        if (desc.id.includes('.run.')) captured.run = desc.run
        return { dispose: () => undefined }
      },
      addCommand: () => 'mock-command-id',
      getSelection: () => captured.selection ?? null,
      getModel: () => ({
        getValue: () => captured.modelValue ?? '',
        getValueInRange: () => captured.rangeValue ?? ''
      }),
      dispose: () => undefined
    }
  },
  // QueryEditor gebruikt dit voor regelmarkering (SAL-17); de mock vangt de
  // markers op zodat tests ze kunnen controleren.
  setModelMarkers: (model: unknown, owner: string, markers: unknown[]): undefined => {
    captured.markers = markers
    captured.markerOwner = owner
    void model
    return undefined
  }
}

export const languages = {
  CompletionItemKind: {
    Method: 0,
    Function: 1,
    Field: 3,
    Class: 5,
    Interface: 7,
    Keyword: 14
  },
  registerCompletionItemProvider: (lang: string, provider: unknown) => {
    captured.provider = provider
    captured.providerLanguage = lang
    return {
      dispose: () => {
        captured.providerDisposed = true
      }
    }
  }
}

export const MarkerSeverity = { Hint: 1, Info: 2, Warning: 4, Error: 8 }

// Waarden hoeven niet gelijk te zijn aan de echte enum; tests vergelijken
// alleen tegen dezelfde mock-constanten.
export const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, Ctrl: 2048, WinCtrl: 256 }
export const KeyCode = { Enter: 3, Escape: 9, Tab: 2, F5: 63, KeyE: 25, KeyO: 35, KeyS: 39 }
