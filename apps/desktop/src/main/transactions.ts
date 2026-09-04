/**
 * Transaction Manager (F2-2, eis 23).
 *
 * Per verbinding wordt bijgehouden of er een actieve transactie loopt.
 * BEGIN/COMMIT/ROLLBACK worden als één statement door de provider
 * uitgevoerd (node:sqlite / pg / mysql2 / mssql ondersteunen dit).
 *
 * De status is per connectionId (de sessie van een verbinding deelt de
 * transactie); de UI toont een actieve-transactie-indicator per tab.
 */

import type { TransactionState, TransactionStatus } from '@nvag/contracts'
import { sessionManager } from './session-manager'
import { registry } from './registry'

export class TransactionManager {
  private states = new Map<string, TransactionState>()

  state(connectionId: string): TransactionState {
    return this.states.get(connectionId) ?? 'none'
  }

  status(connectionId: string): TransactionStatus {
    return { connectionId, state: this.state(connectionId) }
  }

  private async execute(connectionId: string, sql: string): Promise<void> {
    const session = sessionManager.getByConnectionId(connectionId)
    if (!session) {
      throw new Error('No active session for this connection. Open the connection first.')
    }
    const provider = registry.get(session.providerId)
    if (!provider.capabilities.supportsTransactions) {
      throw new Error('This provider does not support transactions.')
    }
    for await (const chunk of provider.executeQuery(session, sql, {})) {
      if (chunk.kind === 'error') throw new Error(chunk.message)
      if (chunk.kind === 'done') return
    }
  }

  async begin(connectionId: string): Promise<TransactionStatus> {
    if (this.state(connectionId) === 'active') {
      return this.status(connectionId)
    }
    await this.execute(connectionId, 'BEGIN')
    this.states.set(connectionId, 'active')
    return this.status(connectionId)
  }

  async commit(connectionId: string): Promise<TransactionStatus> {
    await this.execute(connectionId, 'COMMIT')
    this.states.set(connectionId, 'none')
    return this.status(connectionId)
  }

  async rollback(connectionId: string): Promise<TransactionStatus> {
    await this.execute(connectionId, 'ROLLBACK')
    this.states.set(connectionId, 'none')
    return this.status(connectionId)
  }

  /** Zet de status terug naar 'none' (bij sessie-sluiten). */
  clear(connectionId: string): void {
    this.states.delete(connectionId)
  }

  clearAll(): void {
    this.states.clear()
  }
}

export const transactionManager = new TransactionManager()
