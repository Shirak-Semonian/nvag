/**
 * IPC-bootstrap — initialiseert Vault + ConnectionStore en registreert IPC.
 */

import { app } from 'electron'
import { join } from 'node:path'
import { Vault } from './security/vault'
import { ConnectionStore } from './connections'
import { HistoryStore } from './history-store'
import { registerIpcHandlers } from './ipc'
import { queryRunner } from './query-runner'
import { sessionManager } from './session-manager'

export const vault = new Vault()
export const connectionStore = new ConnectionStore(vault)
export const historyStore = new HistoryStore(join(app.getPath('userData'), 'history.db'))

export function bootstrapApp(): void {
  vault.init()
  connectionStore.init()
  historyStore.init()
  // De runner schrijft na elke uitvoering naar de geschiedenis.
  queryRunner.historyStore = historyStore
  // F1-10 (eis 24): config + vault-secret voor openSaved / database-switch.
  sessionManager.configProvider = (connectionId) => {
    const config = connectionStore.get(connectionId)
    if (!config) return undefined
    return { config, secret: connectionStore.getSecret(connectionId) }
  }
  registerIpcHandlers()
}
