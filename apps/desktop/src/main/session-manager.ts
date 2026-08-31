/**
 * Session Manager — beheert actieve DbSessions per connectionId.
 *
 * - Eén sessie per verbinding (F0; F1: per tab-sessie met transacties)
 * - Sessies leven in main process; renderer krijgt alleen sessionId/serverInfo.
 * - F1-10 (eis 24): `openSaved` opent een sessie voor een opgeslagen verbinding
 *   met het vault-secret (snelle switch via dropdown), `switchDatabase` wisselt
 *   de database van een sessie (USE in-place, of reconnect waar nodig).
 */

import { randomUUID } from 'node:crypto'
import type {
  ConnectionConfig,
  ConnectionSecret,
  DatabaseProvider,
  DbSession,
  ServerInfo
} from '@nvag/contracts'
import { registry } from './registry'
import { transactionManager } from './transactions'

export interface OpenSessionResult {
  sessionId: string
  connectionId: string
  serverInfo: ServerInfo
}

/** Config + secret van een opgeslagen verbinding (ingevuld door ipc-bootstrap). */
export interface ConnectionSource {
  config: ConnectionConfig
  secret?: ConnectionSecret
}

export class SessionManager {
  /** sessionId → DbSession */
  private sessions = new Map<string, DbSession>()
  /** connectionId → sessionId (snel zoeken + hergebruik bij openSaved). */
  private byConnectionId = new Map<string, string>()

  /**
   * Haalt config + secret voor een opgeslagen verbinding op (voor openSaved en
   * reconnect bij database-switch). Geïnjecteerd vanuit ipc-bootstrap.
   */
  configProvider: ((connectionId: string) => ConnectionSource | undefined) | null = null

  async open(config: ConnectionConfig, secret?: ConnectionSecret): Promise<OpenSessionResult> {
    const provider = registry.get(config.providerId)
    const session = await provider.connect(config, secret)
    const sessionId = randomUUID()
    this.sessions.set(sessionId, session)
    this.byConnectionId.set(config.id, sessionId)
    const serverInfo = await provider.getServerInfo(session)
    return { sessionId, connectionId: config.id, serverInfo }
  }

  /**
   * Opent een sessie voor een opgeslagen verbinding met het vault-secret.
   * Bestaande sessies worden hergebruikt (fast switch; eis 24).
   */
  async openSaved(connectionId: string): Promise<OpenSessionResult> {
    const existingId = this.byConnectionId.get(connectionId)
    if (existingId) {
      const session = this.sessions.get(existingId)
      if (session) {
        const provider = registry.get(session.providerId)
        const serverInfo = await provider.getServerInfo(session)
        return { sessionId: existingId, connectionId, serverInfo }
      }
    }
    const source = this.configProvider?.(connectionId)
    if (!source) {
      throw new Error('Verbinding niet gevonden. Bewaar de verbinding eerst in de Connection Manager.')
    }
    return this.open(source.config, source.secret)
  }

  /**
   * Wisselt de database van de actieve sessie (eis 24).
   * - tsql/mysql: in-place via `USE <db>` op de bestaande sessie.
   * - postgres: reconnect met de nieuwe database (PG kent geen USE).
   * - sqlite/overig: geen echte switch; huidige sessie-info wordt geretourneerd.
   */
  async switchDatabase(connectionId: string, database: string): Promise<OpenSessionResult> {
    const session = this.getByConnectionId(connectionId)
    if (!session) {
      throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
    }
    const sessionId = this.byConnectionId.get(connectionId)
    if (!sessionId) {
      throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
    }
    const provider = registry.get(session.providerId)
    const dialect = provider.capabilities.dialect

    // Zelfde database → niets doen, alleen actuele serverinfo teruggeven.
    if (database === session.database) {
      return { sessionId, connectionId, serverInfo: await provider.getServerInfo(session) }
    }

    if (dialect === 'tsql' || dialect === 'mysql') {
      await runUseStatement(provider, session, buildUseStatement(dialect, database))
      session.database = database
      return { sessionId, connectionId, serverInfo: await provider.getServerInfo(session) }
    }

    if (dialect === 'postgres') {
      // PostgreSQL kan niet van database wisselen op een bestaande verbinding;
      // sluit de sessie en heropen met de nieuwe database.
      const source = this.configProvider?.(connectionId)
      if (!source) {
        throw new Error('Verbinding niet gevonden. Bewaar de verbinding eerst in de Connection Manager.')
      }
      await this.close(sessionId)
      return this.open({ ...source.config, database }, source.secret)
    }

    // sqlite e.d.: database is het bestand zelf; geen wissel nodig.
    return { sessionId, connectionId, serverInfo: await provider.getServerInfo(session) }
  }

  get(sessionId: string): DbSession | undefined {
    return this.sessions.get(sessionId)
  }

  getByConnectionId(connectionId: string): DbSession | undefined {
    const sessionId = this.byConnectionId.get(connectionId)
    if (!sessionId) return undefined
    return this.sessions.get(sessionId)
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      const provider = registry.get(session.providerId)
      await provider.close(session)
    } finally {
      this.sessions.delete(sessionId)
      if (this.byConnectionId.get(session.connectionId) === sessionId) {
        this.byConnectionId.delete(session.connectionId)
      }
      // Transactiestatus van de verbinding wissen (F2-2, eis 23).
      transactionManager.clear(session.connectionId)
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.close(id)
    }
  }
}

/** Dialect-correct `USE <db>` statement (tsql: [x], mysql: `x`). */
function buildUseStatement(dialect: 'tsql' | 'mysql', database: string): string {
  if (dialect === 'tsql') {
    return `USE [${database.replace(/\]/g, ']]')}]`
  }
  return `USE \`${database.replace(/`/g, '``')}\``
}

/** Voert een statement uit via de provider en gooit bij een error-chunk. */
async function runUseStatement(
  provider: DatabaseProvider,
  session: DbSession,
  sql: string
): Promise<void> {
  for await (const chunk of provider.executeQuery(session, sql, {})) {
    if (chunk.kind === 'error') throw new Error(chunk.message)
    if (chunk.kind === 'done') return
  }
}

export const sessionManager = new SessionManager()
