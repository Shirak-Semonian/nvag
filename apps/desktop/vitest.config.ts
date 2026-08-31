import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      // monaco-editor heeft geen main/exports → resolutie faalt in vitest/jsdom.
      'monaco-editor': resolve(__dirname, 'test/mocks/monaco-editor.ts')
    }
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}', 'src/renderer/src/**/*.test.{ts,tsx}']
  }
})
