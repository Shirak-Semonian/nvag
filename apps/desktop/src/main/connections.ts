/**
 * Connection Store — opgeslagen verbindingsconfiguraties.
 *
 * - connections.json: config ZONDER secrets
 * - Vault: versleutelde password/token per connectionId
 * (ADR-003, eis 1)
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectionConfig, ConnectionSecret } from '@nvag/contracts'
import { Vault } from './security/vault'

const CONNECTIONS_FILE = 'connections.json'

export class ConnectionStore {
  private filePath: string
  private connections: ConnectionConfig[] = []

  constructor(private vault: Vault) {
    this.filePath = join(app.getPath('userData'), CONNECTIONS_FILE)
  }

  init(): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    this.load()
  }

  list(): ConnectionConfig[] {
    return [...this.connections].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
  }

  get(id: string): ConnectionConfig | undefined {
    return this.connections.find((c) => c.id === id)
  }

  /** Opslaan: config zonder secret; secret gaat naar de vault. */
  save(config: ConnectionConfig, secret?: ConnectionSecret): ConnectionConfig {
    const existing = this.get(config.id)
    const stored: ConnectionConfig = {
      ...config,
      // Secrets nooit in de config
      ...(existing ?? {})
    }
    // expliciete velden overschrijven, maar password/token nooit opslaan
    delete (stored as unknown as Record<string, unknown>).password
    delete (stored as unknown as Record<string, unknown>).token

    if (!this.get(config.id)) {
      this.connections.push(stored)
    } else {
      this.connections = this.connections.map((c) => (c.id === config.id ? stored : c))
    }
    this.saveFile()

    if (secret?.password) this.vault.setSecret(config.id, 'password', secret.password)
    if (secret?.token) this.vault.setSecret(config.id, 'token', secret.token)

    return stored
  }

  remove(id: string): void {
    this.connections = this.connections.filter((c) => c.id !== id)
    this.saveFile()
    this.vault.remove(id)
  }

  /** Haal secret uit de vault (alleen main process). */
  getSecret(id: string): ConnectionSecret {
    return {
      password: this.vault.getSecret(id, 'password') ?? undefined,
      token: this.vault.getSecret(id, 'token') ?? undefined
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.connections = []
      return
    }
    try {
      this.connections = JSON.parse(readFileSync(this.filePath, 'utf8')) as ConnectionConfig[]
    } catch {
      this.connections = []
    }
  }

  private saveFile(): void {
    writeFileSync(this.filePath, JSON.stringify(this.connections, null, 2), { mode: 0o600 })
  }
}

export function newConnectionId(): string {
  return randomUUID()
}
