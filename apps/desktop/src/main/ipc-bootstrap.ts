/**
 * IPC-bootstrap — initialiseert Vault + ConnectionStore en registreert IPC.
 */

import { Vault } from './security/vault'
import { ConnectionStore } from './connections'
import { registerIpcHandlers } from './ipc'

export const vault = new Vault()
export const connectionStore = new ConnectionStore(vault)

export function bootstrapApp(): void {
  vault.init()
  connectionStore.init()
  registerIpcHandlers()
}
