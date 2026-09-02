import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Packaging-fix (SAL-41): de @nvag/*-workspace-packages zijn TypeScript-bron
 * (package.json "main" → src/index.ts). Electron-vite externaliseert standaard
 * alle "dependencies" van apps/desktop; in de gebundelde app laadt Node die TS
 * dan vanuit node_modules/…/src/index.ts, wat Node's type-stripping weigert
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING → app start niet).
 *
 * Oplossing: alleen third-party/node-dependencies externaliseren; de
 * @nvag/*-pakketten (en relatieve imports) worden door Vite/Rollup in de
 * main-/preload-bundel meegebundeld. Externe drivers (mssql, pg, mysql2,
 * oracledb, snowflake-sdk, …) blijven require()'s die electron-builder uit
 * node_modules in de asar meepakt.
 */
const externalizeNonNvag = (id: string): boolean =>
  !id.startsWith('@nvag/') && !id.startsWith('.') && !id.startsWith('/') && !id.startsWith('\0')

export default defineConfig({
  main: {
    // Electron nooit in de main-bundel opnemen (anders: "Electron failed to install correctly").
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: externalizeNonNvag
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        external: externalizeNonNvag
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
