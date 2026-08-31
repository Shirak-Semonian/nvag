/**
 * IPC-bootstrap — initialiseert Vault + ConnectionStore + lokale stores en
 * registreert IPC.
 */

import { app } from 'electron'
import { join } from 'node:path'
import { Vault } from './security/vault'
import { ConnectionStore } from './connections'
import { HistoryStore } from './history-store'
import { SnippetStore } from './snippet-store'
import { AuditStore } from './audit-store'
import { registerIpcHandlers } from './ipc'
import { queryRunner } from './query-runner'
import { sessionManager } from './session-manager'

export const vault = new Vault()
export const connectionStore = new ConnectionStore(vault)
export const historyStore = new HistoryStore(join(app.getPath('userData'), 'history.db'))
export const snippetStore = new SnippetStore(join(app.getPath('userData'), 'snippets.db'))
export const auditStore = new AuditStore(join(app.getPath('userData'), 'audit.db'))

export function bootstrapApp(): void {
  vault.init()
  connectionStore.init()
  historyStore.init()
  snippetStore.init()
  auditStore.init()
  // De runner schrijft na elke uitvoering naar de geschiedenis (F1-6) en
  // naar de auditlog (F2-8).
  queryRunner.historyStore = historyStore
  queryRunner.auditStore = auditStore
  // F1-10 (eis 24): config + vault-secret voor openSaved / database-switch.
  sessionManager.configProvider = (connectionId) => {
    const config = connectionStore.get(connectionId)
    if (!config) return undefined
    return { config, secret: connectionStore.getSecret(connectionId) }
  }
  registerIpcHandlers()
  // F3-7 (eis 29): externe providers uit de plugin-map laden.
  void import('./plugin-loader').then(async ({ loadPlugins }) => {
    const { registry } = await import('./registry')
    const plugins = await loadPlugins(registry)
    for (const plugin of plugins) {
      if (plugin.ok) {
        console.log(`[nvag] Plugin geladen: ${plugin.name} (provider ${plugin.providerId})`)
      } else {
        console.warn(`[nvag] Plugin overgeslagen: ${plugin.name} — ${plugin.error ?? 'onbekende fout'}`)
      }
    }
  })
}
