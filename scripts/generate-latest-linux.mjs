#!/usr/bin/env node
/**
 * Genereert latest-linux.yml voor het AppImageUpdate-kanaal van Nvag.
 *
 * electron-builder schrijft dit bestand alleen wanneer er een publish-provider
 * geconfigureerd is, en bij meerdere Linux-targets kan de inhoud naar het
 * verkeerde artefact wijzen. Dit script maakt het bestand deterministisch aan
 * op basis van de AppImage die in apps/desktop/release staat — exact het
 * formaat dat electron-updater (AppImageUpdater) verwacht.
 *
 * Gebruik (na een geslaagde `pnpm --filter desktop build:linux` of in CI):
 *   node scripts/generate-latest-linux.mjs
 *
 * Output: apps/desktop/release/latest-linux.yml
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const desktopPkg = JSON.parse(
  readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')
)
const releaseDir = join(root, 'apps/desktop/release')
const version = desktopPkg.version
const appImageName = `Nvag-${version}.AppImage`
const appImagePath = join(releaseDir, appImageName)

const bytes = readFileSync(appImagePath)
const sha512 = createHash('sha512').update(bytes).digest('base64')

const yml = [
  `version: ${version}`,
  'files:',
  `  - url: ${appImageName}`,
  `    sha512: ${sha512}`,
  `    size: ${bytes.length}`,
  `path: ${appImageName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  ''
].join('\n')

writeFileSync(join(releaseDir, 'latest-linux.yml'), yml)
console.log(
  `latest-linux.yml geschreven voor ${appImageName} (${bytes.length} bytes)`
)
