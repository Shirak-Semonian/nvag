# Nvag

> Eén centrale Database Management Studio voor meerdere databaseplatformen —
> geïnspireerd op SSMS, maar database-onafhankelijk.
> Eén applicatie → meerdere databaseplatformen → meerdere servers → meerdere omgevingen → meerdere databases.

## Status

📋 **Fase: Planvorming** — architectuur en roadmap vastgelegd in `docs/`.
Nog geen code.

## Doel

Een moderne, uitbreidbare desktopapplicatie die de kernfunctionaliteit van
SSMS / DBeaver / DataGrip combineert, met volledige controle over architectuur
en functionaliteit. De applicatie draait op Omarchy (Arch Linux) en moet
later ook op Windows/macOS kunnen draaien.

## Kernfunctionaliteit eerste versie (scope v1)

- Connection Manager (SQL Server, PostgreSQL, MySQL, Db2) met versleutelde credentials
- Object Explorer met lazy-loaded metadata
- SQL Query Editor (Monaco) met autocomplete, tabs, run/cancel, timer
- Results grid (sorteren, filteren, kopiëren, NULL-weergave, meerdere resultsets)
- Messages & error handling met regelmarkering
- Metadata viewer (columns, keys, indexes, constraints, triggers)
- Script object as CREATE / SELECT / INSERT / UPDATE / DELETE
- SQL history (doorzoekbaar)
- Export naar CSV / Excel
- Veilige visuele herkenning DEV / TEST / ACC / PROD

## Documentatie

| Document | Inhoud |
|---|---|
| [docs/01-inventarisatie.md](docs/01-inventarisatie.md) | Inventarisatie van alle 29 eisen, MoSCoW-prioritering, afhankelijkheden |
| [docs/02-architectuur.md](docs/02-architectuur.md) | Technische keuze, modules, provider-interface, security, datastromen |
| [docs/03-roadmap.md](docs/03-roadmap.md) | Ontwikkelroadmap: fases 0–3 met concrete stappen en done-criteria |
| [docs/04-omarchy.md](docs/04-omarchy.md) | Omarchy-specifieke setup: toolchain, drivers, keyring, packaging |
| [docs/05-beslissingen-en-risicos.md](docs/05-beslissingen-en-risicos.md) | ADR's (architectuurbeslissingen) en risicoregister |

## Voorgestelde stack (kort)

- **Electron + TypeScript + React + Vite** (electron-vite) — desktop UI
- **Monaco Editor** — SQL-editor (syntax highlighting, autocomplete, tabs)
- **AG Grid (community, v36)** — results grid
- **Node.js database-drivers** per provider (`mssql`, `pg`, `mysql2`, later `ibm_db`/JDBC, `oracledb`)
- **Electron safeStorage** (gnome-keyring) — versleutelde credentials
- **node:sqlite** (ingebouwd in Node 24+, geen native build) — lokale metadata cache, SQL history, snippets

Zie [docs/02-architectuur.md](docs/02-architectuur.md) voor de volledige onderbouwing.

## Aanbevolen eerste stappen

1. `npm install -g pnpm` (Node 26 is al geïnstalleerd)
2. Repo initialiseren in deze map
3. Fase 0 doorlopen volgens [docs/03-roadmap.md](docs/03-roadmap.md)

## Projectstructuur (beoogd)

```
nvag/
├── apps/
│   └── desktop/            # Electron-app (main + renderer)
├── packages/
│   ├── contracts/          # @nvag/contracts — types, provider-interface, IPC-contract
│   ├── providers/          # @nvag/providers/* — databaseproviders (sqlserver, postgresql, mysql, db2, ...)
│   ├── metadata-cache/     # @nvag/metadata-cache — lokale SQLite-cache
│   ├── sql-dialect/        # @nvag/sql-dialect — dialect-afhankelijke SQL-generatie
│   └── ui/                 # @nvag/ui — React-componenten (ObjectExplorer, Editor, Grid, ...)
├── docs/
└── docker-compose.dev.yml  # lokale testdatabases (PostgreSQL, MySQL, MariaDB, SQL Server)
```
