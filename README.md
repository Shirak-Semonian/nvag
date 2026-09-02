# Nvag

> Eén centrale Database Management Studio voor meerdere databaseplatformen —
> geïnspireerd op SSMS, maar database-onafhankelijk.
> Eén applicatie → meerdere databaseplatformen → meerdere servers → meerdere omgevingen → meerdere databases.

## Status

✅ **Fase 0–4 afgerond (SAL-26, 2026-09-01)** — zie
[docs/03-roadmap.md](docs/03-roadmap.md) voor de done-criteria per fase.

- **Fase 0 (Fundament)**: draaiende Electron-app met SQLite-provider
  (node:sqlite), provider-abstractie (`@nvag/contracts`), versleutelde
  credentials (safeStorage-vault), Connection Manager, Object Explorer
  (lazy), Query Editor (Monaco), resultaten + messages,
  environment-safety (query-guard).
- **Fase 1 (Core v1)**: SQL Server, PostgreSQL, MySQL en Db2-providers;
  streaming query-runner (chunks → progressieve grid, cancel + timer);
  results op AG Grid v36 (sorteren/filteren/kopiëren/NULL, multi-set tabs,
  Results to Text/File); object viewer/scripting; query-editor-uitbreiding
  (autocomplete, tabs, shortcuts, statusregel); SQL history; CSV/Excel-
  export; env-safety met bevestigingsflow; multiple connections per tab.
- **Fase 2 (Beheer & productiviteit)**: tabeldata-editor, transacties,
  admin (DDL), prestaties, zoeken, snippets, import, audit, dashboard en
  meer providers (Oracle, Snowflake, Azure SQL/Synapse, Databricks).
- **Fase 3 (Geavanceerd)**: execution plans, monitoring/activity,
  schema+data compare met deployment-script, dependencies, ER-diagram,
  AI-assistant (eigen API-key, vault) en extern plugin-systeem.
- **Fase 4 (Backup & Restore)**: backup/restore voor SQL Server, Db2 en
  SQLite met dialect-correcte SQL, environment-safety (RESTORE altijd
  bevestigen), auditlogging en een capability-gated Backup-tab; daarnaast
  packaging (AppImage/tar.gz/deb/rpm) met CI-workflow.

**Release 1.0.1 (2026-09-02, SAL-44)**: verse Linux-distributie in
`apps/desktop/release/` (`Nvag-1.0.1.AppImage`, `.tar.gz`, `.deb`, `.rpm`)
met de SAL-42/SAL-43-fixes: Tabelgegevens-paneel toont fout/timeout i.p.v.
eeuwige "Laden…" (incl. tsql `TOP (n)`-fix zodat tabeldata op SQL Server
weer laadt) en "Verbinding verbreken" sluit de sessie zichtbaar (boom klapt
in, geen stille no-op). Daarnaast: AG Grid v36-modules geregistreerd
(`AllCommunityModule` + legacy-theme) — de grid-panelen (tabelgegevens en
query-resultaten) crashten/leegden anders in de gebundelde app. Rooktest
van de gebouwde AppImage geslaagd: app start, SQLite-connectie, Object
Explorer, tabeldata laden + verbinding verbreken werken.

**Release 1.0.0 (2026-09-02, SAL-41)**: verse Linux-distributie in
`apps/desktop/release/` (`Nvag-1.0.0.AppImage`, `.tar.gz`, `.deb`, `.rpm`)
met alle fixes/features van SAL-29 t/m SAL-40: query-cancel, SSMS-niveau
Object Explorer + contextmenu's, provider-fixes Oracle/Db2/Databricks en de
statement-splitter. Rooktest van de gebouwde AppImage geslaagd: app start,
lokale SQLite-connectie + Object Explorer werken (tabellen zichtbaar).

**Doorlopende kwaliteit**: `pnpm dev` start de app; `pnpm -r typecheck` en
`pnpm -r test` blijven groen (desktop-suite 223 tests).

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

1. `pnpm install` (Node 26 + pnpm zijn geïnstalleerd)
2. `pnpm dev` in `apps/desktop` — start de Electron-app
3. Nieuwe SQLite-verbinding aanmaken (➕ in Object Explorer),
   query draaien en resultaten bekijken
4. Fase 1 doorlopen volgens [docs/03-roadmap.md](docs/03-roadmap.md)

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
