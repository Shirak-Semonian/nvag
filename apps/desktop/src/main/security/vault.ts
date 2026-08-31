/**
 * Vault — versleutelde opslag van credentials via Electron safeStorage.
 * (ADR-003)
 *
 * - safeStorage.encryptString() → versleutelde blob in vault.bin (chmod 600)
 * - Renderer ziet nooit secrets; alleen main process opent de vault.
 * - Fallback wanneer safeStorage niet beschikbaar is: eigen sleutelbestand
 *   met restrictieve permissies + duidelijke waarschuwing (R3).
 */

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const VAULT_FILE = 'vault.bin'
const KEY_FILE = 'fallback.key'
const VAULT_VERSION = 1

interface VaultEntry {
  /** connectionId */
  id: string
  /** field → versleutelde waarde (base64) */
  secrets: Record<string, string>
}

export class Vault {
  private filePath: string
  private fallbackKey: Buffer | null = null
  private entries = new Map<string, Record<string, string>>()

  constructor() {
    this.filePath = join(app.getPath('userData'), VAULT_FILE)
  }

  init(): void {
    mkdirSync(app.getPath('userData'), { recursive: true })
    if (this.load()) return
    this.save()
  }

  get isEncrypted(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  private get key(): Buffer {
    if (safeStorage.isEncryptionAvailable()) {
      // safeStorage gebruikt de OS-keyring (gnome-keyring) — geen eigen sleutel nodig.
      return Buffer.alloc(0)
    }
    // Fallback (R3): eigen 256-bit sleutel in gebruikersconfig (chmod 600).
    if (this.fallbackKey) return this.fallbackKey
    const keyPath = join(app.getPath('userData'), KEY_FILE)
    if (existsSync(keyPath)) {
      this.fallbackKey = Buffer.from(readFileSync(keyPath, 'utf8'), 'hex')
    } else {
      this.fallbackKey = randomBytes(32)
      writeFileSync(keyPath, this.fallbackKey.toString('hex'), { mode: 0o600 })
    }
    return this.fallbackKey
  }

  private encrypt(value: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return 'ss:' + safeStorage.encryptString(value).toString('base64')
    }
    const key = this.key
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `fb:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`
  }

  private decrypt(payload: string): string {
    if (payload.startsWith('ss:')) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Vault: safeStorage niet beschikbaar, kan secret niet ontsleutelen')
      }
      return safeStorage.decryptString(Buffer.from(payload.slice(3), 'base64'))
    }
    if (payload.startsWith('fb:')) {
      const [, ivB64, tagB64, dataB64] = payload.split(':')
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final()
      ]).toString('utf8')
    }
    throw new Error('Vault: onbekend payload-formaat')
  }

  /** Versleutelde blob wegschrijven (chmod 600). */
  private save(): void {
    const data: VaultEntry[] = [...this.entries.entries()].map(([id, secrets]) => ({
      id,
      secrets
    }))
    const json = JSON.stringify({ version: VAULT_VERSION, entries: data })
    writeFileSync(this.filePath, json, { mode: 0o600 })
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // bestandssysteem zonder chmod-ondersteuning
    }
  }

  private load(): boolean {
    if (!existsSync(this.filePath)) return false
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as {
        version: number
        entries: VaultEntry[]
      }
      for (const e of parsed.entries ?? []) {
        this.entries.set(e.id, e.secrets ?? {})
      }
      return true
    } catch {
      return false
    }
  }

  setSecret(connectionId: string, field: string, value: string): void {
    const entry = this.entries.get(connectionId) ?? {}
    entry[field] = this.encrypt(value)
    this.entries.set(connectionId, entry)
    this.save()
  }

  getSecret(connectionId: string, field: string): string | null {
    const entry = this.entries.get(connectionId)
    if (!entry?.[field]) return null
    try {
      return this.decrypt(entry[field])
    } catch {
      return null
    }
  }

  hasSecrets(connectionId: string): boolean {
    const entry = this.entries.get(connectionId)
    return !!entry && Object.keys(entry).length > 0
  }

  remove(connectionId: string): void {
    this.entries.delete(connectionId)
    this.save()
  }
}

/** Waarschuwing tonen wanneer fallback actief is (R3). */
export function vaultWarning(vault: Vault): string | null {
  if (vault.isEncrypted) return null
  return 'Let op: OS-keyring niet beschikbaar; credentials worden versleuteld met een lokale fallback-sleutel.'
}
