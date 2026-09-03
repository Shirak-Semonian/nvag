# AUR: nvag-bin

Dit is de AUR-package `nvag-bin` voor **Nvag** — de database-onafhankelijke
Database Management Studio. Deze map bevat de package-definitie; **indienen bij
AUR gebeurt pas nadat de publieke GitHub-repo + eerste release bestaan** (zie
`docs/09-publicatie.md` in de repo-root).

## Waarom `nvag-bin` (en niet `nvag`)?

- Nvag is een Electron-app in een pnpm-monorepo. Een build-from-source-package
  (`nvag`) zou tijdens `makepkg` pnpm + Node 24 moeten installeren, alle
  workspace-packages moeten bouwen en via electron-builder een Electron-runtime
  moeten downloaden — traag, storingsgevoelig in de AUR-sandbox en tegen de
  AUR-richtlijnen (downloads in de build-fase).
- `nvag-bin` downloadt de officiële, geteste AppImage van GitHub Releases en
  installeert die in enkele seconden — dezelfde artefacten als de GitHub-
  Release. Geen compile, geen toolchain-rompslomp.
- Mocht er ooit behoefte zijn aan build-from-source, dan kan `nvag` als aparte
  package naast `nvag-bin` bestaan (deze package `conflicts`/`provides` dan
  correct af).

## Bestanden

| Bestand | Doel |
|---|---|
| `PKGBUILD` | Package-definitie; downloadt `Nvag-<versie>.AppImage` van GitHub Releases |
| `.SRCINFO` | AUR-metadata (regenereren met `makepkg --printsrcinfo > .SRCINFO`) |
| `nvag.desktop` | Desktop-launcher (`/usr/share/applications/nvag.desktop`) |
| `icon.png` | App-icoon (`/usr/share/pixmaps/nvag.png`), 512×512 uit de repo |

## Installatie (voor gebruikers, zodra gepubliceerd)

```bash
yay -S nvag-bin        # of: paru -S nvag-bin
```

Runtime: de AppImage heeft `fuse2` nodig (optionele dependency; zonder FUSE2
werkt `nvag --appimage-extract-and-run`).

## Checklist vóór indiening (doet Shirak zodra de repo + release bestaan)

1. **`_repo_owner` invullen** in `PKGBUILD` (GitHub-eigenaar van de publieke
   Nvag-repo) en het **maintainer-e-mailadres** vervangen door een publiek
   bereikbaar adres (`shirak@localhost` wordt door AUR afgewezen).
2. **Checksums verversen** — de CI-release kan andere bytes opleveren dan de
   lokale build:

   ```bash
   updpkgsums          # haalt de AppImage op en vult sha256sums in
   ```

3. **`.SRCINFO` regenereren**:

   ```bash
   makepkg --printsrcinfo > .SRCINFO
   ```

4. **Lokaal testen** (geen root):

   ```bash
   makepkg -f          # bouwt/installeert in een tijdelijke pkg/ map
   namcap PKGBUILD     # als namcap geïnstalleerd is
   namcap nvag-bin-*.pkg.tar.zst
   # rooktest: de gebouwde AppImage start
   ./src/Nvag-*.AppImage --appimage-extract-and-run   # of via geïnstalleerde pkg
   ```

5. **Indienen** (aurweb via SSH — vereist een AUR-account met SSH-key):

   ```bash
   git clone ssh://aur@aur.archlinux.org/nvag-bin.git /tmp/nvag-bin-aur
   cd /tmp/nvag-bin-aur
   cp /pad/naar/repo/packaging/aur/nvag-bin/{PKGBUILD,.SRCINFO,nvag.desktop,icon.png} .
   git add PKGBUILD .SRCINFO nvag.desktop icon.png
   git commit -m "nvag-bin 1.0.4"
   git push origin master
   ```

6. Daarna kan de badge in de repo-README gekoppeld worden
   (`https://aur.archlinux.org/packages/nvag-bin`).
