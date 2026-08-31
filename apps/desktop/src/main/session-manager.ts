/**
 * Session Manager — beheert actieve DbSessions per connectionId.
 *
 * - Eén sessie per verbinding (F0; F1: per tab-sessie met transacties)
 * - Sessies leven in main process; renderer krijgt alleen sessionId/serverInfo.
 */

import { randomUUID } from 'node:crypto'
import type {
  ConnectionConfig,
  ConnectionSecret,
  DbSession,
  ServerInfo
} from '@nvag/contracts'
import { registry } from './registry'

export interface OpenSessionResult {
  sessionId: string
  connectionId: string
  serverInfo: ServerInfo
}

export class SessionManager {
  /** sessionId → DbSession */
  private sessions = new Map<string, DbSession>()

  async open(config: ConnectionConfig, secret?: ConnectionSecret): Promise<OpenSessionResult> {
    const provider = registry.get(config.providerId)
    const session = await provider.connect(config, secret)
    const sessionId = randomUUID()
    this.sessions.set(sessionId, session)
    const serverInfo = await provider.getServerInfo(session)
    return { sessionId, connectionId: config.id, serverInfo }
  }

  get(sessionId: string): DbSession | undefined {
    return this.sessions.get(sessionId)
  }

  getByConnectionId(connectionId: string): DbSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.connectionId === connectionId) return session
    }
    return undefined
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      const provider = registry.get(session.providerId)
      await provider.close(session)
    } finally {
      this.sessions.delete(sessionId)
    }
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.close(id)
    }
  }
}

export const sessionManager = new SessionManager()
