# Nvag

Eén centrale Database Management Studio voor meerdere databaseplatformen — geïnspireerd op SSMS, maar database-onafhankelijk.

Ondersteunde platformen: **SQL Server, Azure SQL, PostgreSQL, MySQL, MariaDB, Db2, Oracle, Databricks, Snowflake, SQLite**.

## Features

- **Object Explorer** — databases, tabellen, views, procedures, functies, users, rollen, schema's en meer; contextmenu's op SSMS-niveau
- **Query Editor** — SQL met autocomplete, meerdere tabs, uitvoeren/annuleren, resultaten in een grid (sorteren, filteren, kopiëren, exporteren naar CSV/Excel)
- **Databasebeheer** — databases en objecten aanmaken, wijzigen, eigenschappen bekijken en verwijderen; backup/restore
- **Tabelgegevens** — rijen bekijken en bewerken
- **Veilig** — credentials worden versleuteld opgeslagen; omgevingsguard (DEV/TEST/ACC/PROD) tegen onbedoelde wijzigingen

## Installatie

Download de nieuwste release van de [releases-pagina](https://github.com/Shirak-Semonian/nvag/releases) en kies je formaat:

- **AppImage** (alle distro's):
  ```bash
  chmod +x Nvag-*.AppImage
  ./Nvag-*.AppImage
  ```
  Vereist `fuse2` (op Arch/Omarchy: `sudo pacman -S fuse2`); zonder FUSE2: `./Nvag-*.AppImage --appimage-extract-and-run`
- **Debian/Ubuntu**: `sudo apt install ./Nvag-*.deb`
- **Fedora/RHEL**: `sudo dnf install ./Nvag-*.rpm`
- **Overig**: pak `Nvag-*.tar.gz` uit en start Nvag vanuit `linux-unpacked/`

**Omarchy-gebruikers**: installeer ook de [Nvag shell-plugin](https://github.com/Shirak-Semonian/nvag-omarchy-plugin) voor een launcher-widget in de bar.

## Systeemvereisten

- Linux x86_64
- De Electron-runtime zit in het installatiepakket — aparte Node-installatie is niet nodig
