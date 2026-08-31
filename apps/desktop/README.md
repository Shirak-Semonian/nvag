# Nvag Desktop

Electron-app (main + preload + React renderer) van **Nvag**, de
database-onafhankelijke Database Management Studio.

## Vereisten

- Node 26 (of 24+) en pnpm
- Omarchy/Linux: gnome-keyring + libsecret (voor safeStorage-vault)

## Development

```bash
pnpm install          # vanuit repo-root (pnpm workspaces)
pnpm dev              # electron-vite met HMR
```

- DevTools: Ctrl+Shift+I
- Debug main process: `ELECTRON_ENABLE_LOGGING=1 pnpm dev`

## Build

```bash
pnpm build            # typecheck + electron-vite build
pnpm build:linux      # + electron-builder AppImage (output: release/)
```

## Fase 0 functionaliteit

- Connection Manager: SQLite-verbindingen aanmaken, testen, groepen,
  environment (DEV/TEST/ACC/PROD) met kleurbadges
- Credentials versleuteld via safeStorage → `~/.config/nvag/vault.bin`
- Object Explorer: lazy boom (server → databases → schemas → tabellen/views)
- Query Editor (Monaco) met SQL-syntax
- Resultaten-grid + messages-paneel, rij-cap (1000 standaard)
- Query-guard: DDL/DELETE/UPDATE zonder WHERE vraagt bevestiging
  (op PROD standaard altijd)

## Structuur

```
src/main/        main process (Node): vault, connections, registry,
                 session-manager, query-runner, metadata-service, IPC
src/preload/     contextBridge → window.nvag.* (typed via @nvag/contracts)
src/renderer/    React UI: ObjectExplorer, QueryEditor, ResultsGrid,
                 ConnectionDialog, zustand store
```

## Tests

```bash
pnpm --filter desktop typecheck   # node + web typecheck
cd ../.. && pnpm -r test          # contracttests (packages)
```
