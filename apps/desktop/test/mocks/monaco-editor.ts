/**
 * Test-mock voor monaco-editor (package heeft geen main/exports → vite/vitest
 * kan de entry niet resolven in jsdom; via resolve.alias in vitest.config.ts).
 *
 * Houdt dezelfde vorm als de echte API die QueryEditor gebruikt: editor.create,
 * addAction (Ctrl+Enter) en dispose. `captured` laat tests de geregistreerde
 * keybinding-aanroep uitoefenen.
 */
export const captured: { run?: () => void; createCount: number } = { createCount: 0 }

export const editor = {
  create: () => {
    captured.createCount += 1
    return {
      onDidChangeModelContent: () => ({ dispose: () => undefined }),
      addAction: (desc: { run: () => void }) => {
        captured.run = desc.run
        return { dispose: () => undefined }
      },
      addCommand: () => 'mock-command-id',
      dispose: () => undefined
    }
  }
}

export const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, Ctrl: 2048, WinCtrl: 256 }
export const KeyCode = { Enter: 3, Escape: 9, Tab: 2 }
