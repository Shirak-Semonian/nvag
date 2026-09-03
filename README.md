# Nvag

One central database tool for multiple database platforms — a single application for many servers, environments and databases.

Supported platforms: **SQL Server, Azure SQL, PostgreSQL, MySQL, MariaDB, Db2, Oracle, Databricks, Snowflake, SQLite**.

## Features

- **Object Explorer** — databases, tables, views, procedures, functions, users, roles, schemas and more; full-featured context menus
- **Query Editor** — SQL with autocomplete, multiple tabs, run/cancel, results in a grid (sort, filter, copy, export to CSV/Excel)
- **Database administration** — create, alter, view properties and drop databases and objects; backup/restore
- **Table data** — view and edit rows
- **Secure** — credentials are stored encrypted; environment guard (DEV/TEST/ACC/PROD) against unintended changes

## Installation

Download the latest release from the [releases page](https://github.com/Shirak-Semonian/nvag/releases) and pick your format:

- **AppImage** (any distro):
  ```bash
  chmod +x Nvag-*.AppImage
  ./Nvag-*.AppImage
  ```
  Requires `fuse2` (on Arch/Omarchy: `sudo pacman -S fuse2`); without FUSE2: `./Nvag-*.AppImage --appimage-extract-and-run`
- **Debian/Ubuntu**: `sudo apt install ./Nvag-*.deb`
- **Fedora/RHEL**: `sudo dnf install ./Nvag-*.rpm`
- **Other**: extract `Nvag-*.tar.gz` and run Nvag from `linux-unpacked/`

**Omarchy users**: also install the [Nvag shell plugin](https://github.com/Shirak-Semonian/nvag-omarchy-plugin) for a launcher widget in your bar.

## System requirements

- Linux x86_64
- The Electron runtime is bundled in the package — no separate Node installation needed

## License

[MIT](LICENSE)
