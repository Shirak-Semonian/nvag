/**
 * Extern plugin-systeem (F3-7, eis 29).
 *
 * Laadt DatabaseProviders uit een plugin-map (bijv. <userData>/plugins):
 * - een `.mjs`/`.js`-bestand dat `createProvider()` (of default) exporteert,
 * - of een submap met `index.mjs`/`index.js` en optioneel een manifest
 *   (`nvag-plugin.json` met `name` en `description`).
 *
 * Plugins worden dynamisch geïmporteerd (dynamic import) — een fout in één
 * plugin breekt de app-start niet; de plugin wordt overgeslagen met een
 * waarschuwing. Zie docs/06-plugins.md voor de template.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import type { DatabaseProvider, ProviderRegistry } from '@nvag/contracts'

export interface LoadedPlugin {
  name: string
  source: string
  providerId?: string
  providerName?: string
  ok: boolean
  error?: string
}

function pluginDir(): string {
  // Plugin-map naast de lokale stores (connections.json etc.).
  return join(app.getPath('userData'), 'plugins')
}

async function importPluginFile(filePath: string): Promise<DatabaseProvider> {
  const mod = (await import(pathToFileURL(filePath).href)) as {
    default?: unknown
    createProvider?: () => DatabaseProvider
  }
  const factory = mod.createProvider ?? (mod.default as (() => DatabaseProvider) | undefined)
  if (typeof factory !== 'function') {
    throw new Error('Plugin exporteert geen createProvider() of default-factory.')
  }
  const provider = factory()
  if (!provider || typeof provider.id !== 'string') {
    throw new Error('Plugin-factory retourneert geen geldige DatabaseProvider.')
  }
  return provider
}

export async function loadPlugins(registry: ProviderRegistry): Promise<LoadedPlugin[]> {
  const dir = pluginDir()
  const loaded: LoadedPlugin[] = []
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return loaded
    }
    return loaded
  }

  const entries = readdirSync(dir).sort()
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(full)
    } catch {
      continue
    }

    // Enkel bestand: probeer te importeren.
    if (stat.isFile() && /\.(mjs|js)$/.test(entry)) {
      try {
        const provider = await importPluginFile(full)
        registry.register(provider)
        loaded.push({ name: provider.displayName || provider.id, source: full, providerId: provider.id, providerName: provider.displayName, ok: true })
      } catch (err) {
        loaded.push({ name: entry, source: full, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      continue
    }

    // Submap met index-bestand + optioneel manifest.
    if (stat.isDirectory()) {
      const indexCandidates = ['index.mjs', 'index.js']
      const indexFile = indexCandidates.map((f) => join(full, f)).find((f) => existsSync(f))
      if (!indexFile) continue
      let name = entry
      try {
        const manifestPath = join(full, 'nvag-plugin.json')
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string; description?: string }
          if (manifest.name) name = manifest.name
        }
        const provider = await importPluginFile(indexFile)
        registry.register(provider)
        loaded.push({ name, source: indexFile, providerId: provider.id, providerName: provider.displayName, ok: true })
      } catch (err) {
        loaded.push({ name, source: indexFile, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  return loaded
}
