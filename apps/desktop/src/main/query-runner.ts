/**
 * Query Runner — voert queries uit via de provider en streamt chunks
 * naar de renderer over IPC (`query:chunk`-events).
 *
 * F1-4 (SAL-17): twee-fasen-protocol om chunk-verlies te voorkomen:
 *   1. `run(req)`   — registreert een uitvoering en geeft executionId terug
 *                     (er wordt nog niets uitgevoerd).
 *   2. `start(id)`  — consumeert de provider-iterable en stuurt elke chunk
 *                     naar de window die de query startte.
 *   `cancel(id)`    — vraagt annulering aan; de runner stopt en stuurt een
 *                     done-chunk met `cancelled: true`.
 *
 * SAL-33: annuleren is nu een ECHTE provider-cancel, niet alleen lokaal
 * stoppen met consumeren:
 *   - `run()` maakt per uitvoering een AbortController aan; `start()` geeft
 *     `executionId` + `signal` mee aan `provider.executeQuery(...)`.
 *   - `cancel()` roept `provider.cancel(session, executionId)` aan (SQL
 *     Server: request.cancel() → attention-signaal → server stopt de query)
 *     en breekt daarna de stream af via `signal.abort()`.
 *   - Providers die geen echte cancel ondersteunen melden dit (cancel() gooit
 *     een duidelijke fout); de runner stuurt dan een warning-chunk in plaats
 *     van stil te doen alsof er gecanceld is.
 *   - Resources (actief/prepared-maps en provider-request-maps) worden altijd
 *     in `finally` vrijgemaakt; na annuleren is direct een nieuwe query
 *     mogelijk (geen kapotte pool/request).
 *
 * De maxRows-cap (standaard provider.capabilities.maxResultRowsDefault) wordt
 * hier afgedwongen op het aantal rijen dat naar de renderer gaat; bij
 * overschrijding stopt de runner en stuurt een warning-chunk.
 */

import { randomUUID } from 'node:crypto'
import type {
  DbSession,
  QueryChunk,
  QueryRunStartResponse
} from '@nvag/contracts'
import { registry } from './registry'
import { sessionManager } from './session-manager'
import type { HistoryStore } from './history-store'
import type { AuditStore } from './audit-store'

export interface RunRequest {
  connectionId: string
  sql: string
  maxRows?: number
  selection?: { start: number; end: number }
  /** Verbindingsnaam (server) voor de SQL-history; ingevuld door ipc.ts. */
  server?: string
}

/**
 * Minimale sender-interface: de runner heeft alleen `send` + `isDestroyed`
 * nodig (electron.WebContents voldoet structureel; tests kunnen een fake
 * meegeven).
 */
export interface QuerySender {
  send(channel: string, ...args: unknown[]): void
  isDestroyed(): boolean
}

interface PreparedExecution {
  session: DbSession
  providerId: string
  req: RunRequest
}

interface ActiveExecution {
  sender: QuerySender
  cancelRequested: boolean
  /** SAL-33: breekt de provider-iterable af; provider-cancel koppelt hieraan. */
  abortController: AbortController
}

export class QueryRunner {
  private active = new Map<string, ActiveExecution>()
  private prepared = new Map<string, PreparedExecution>()

  /** SQL-history (eis 19); geïnjecteerd vanuit ipc-bootstrap. */
  historyStore: HistoryStore | null = null

  /** Auditlog (F2-8, eis 26); geïnjecteerd vanuit ipc-bootstrap. */
  auditStore: AuditStore | null = null

  /**
   * Registreert een uitvoering; consumeert nog niets.
   * Gooit wanneer er geen actieve sessie is voor de verbinding.
   */
  run(req: RunRequest, sender: QuerySender): QueryRunStartResponse {
    const session = sessionManager.getByConnectionId(req.connectionId)
    if (!session) {
      throw new Error('Geen actieve sessie voor deze verbinding. Open eerst de verbinding.')
    }
    const provider = registry.get(session.providerId)
    const executionId = randomUUID()
    this.active.set(executionId, {
      sender,
      cancelRequested: false,
      abortController: new AbortController()
    })
    this.prepared.set(executionId, {
      session,
      providerId: provider.id,
      req
    })
    return { executionId }
  }

  /** Start het streamen; resolveert wanneer de uitvoering is afgelopen. */
  async start(executionId: string): Promise<void> {
    const active = this.active.get(executionId)
    const prepared = this.prepared.get(executionId)
    if (!active || !prepared) return

    const { session, providerId, req } = prepared
    const provider = registry.get(providerId)
    const maxRows = req.maxRows ?? provider.capabilities.maxResultRowsDefault
    const start = performance.now()
    let delivered = 0
    let providerRowCount = 0
    let error: string | undefined
    let truncated = false
    let finished = false

    const send = (chunk: QueryChunk): void => {
      if (active.sender.isDestroyed()) return
      active.sender.send('query:chunk', { executionId, chunk })
    }

    const warnTruncated = (): void => {
      send({
        kind: 'warning',
        message: `Resultaat afgekapt op ${maxRows} rijen (max-rij-cap). Verfijn je query of verhoog de cap.`
      })
    }

    try {
      // Annulering vóór de start (run → cancel → start): direct beëindigen,
      // de provider-query wordt dan nooit gestart.
      if (active.cancelRequested) {
        send({ kind: 'done', rowCount: 0, durationMs: 0, cancelled: true })
        return
      }

      const iter = provider.executeQuery(session, req.sql, {
        maxRows,
        selection: req.selection,
        executionId,
        signal: active.abortController.signal
      })
      for await (const chunk of iter) {
        if (active.cancelRequested) break

        if (chunk.kind === 'columns' || chunk.kind === 'warning') {
          send(chunk)
        } else if (chunk.kind === 'rows') {
          const remaining = maxRows - delivered
          if (remaining <= 0) {
            truncated = true
            warnTruncated()
            active.abortController.abort()
            break
          }
          if (chunk.rows.length > remaining) {
            send({ kind: 'rows', rows: chunk.rows.slice(0, remaining) })
            delivered += remaining
            truncated = true
            warnTruncated()
            active.abortController.abort()
            break
          }
          send(chunk)
          delivered += chunk.rows.length
        } else if (chunk.kind === 'error') {
          error = chunk.message
          send(chunk)
          finished = true
          break
        } else if (chunk.kind === 'done') {
          providerRowCount = chunk.rowCount
          send({
            ...chunk,
            truncated: truncated || chunk.truncated === true,
            cancelled: active.cancelRequested || chunk.cancelled === true
          })
          finished = true
          break
        }
      }

      if (!finished) {
        send({
          kind: 'done',
          rowCount: delivered,
          durationMs: Math.round(performance.now() - start),
          truncated,
          cancelled: active.cancelRequested
        })
      }
    } catch (err) {
      if (active.cancelRequested) {
        // Provider gooide tijdens een annulering (bijv. abort-achtige fout):
        // dat is géén rode foutmelding maar een nette annulering.
        send({
          kind: 'done',
          rowCount: delivered,
          durationMs: Math.round(performance.now() - start),
          truncated,
          cancelled: true
        })
      } else {
        error = err instanceof Error ? err.message : String(err)
        send({
          kind: 'error',
          message: error
        })
      }
    } finally {
      // Zorg dat de provider-iterable (en daarmee request/stream) altijd
      // beëindigd wordt, ook bij truncation/break vóór het natuurlijke einde.
      active.abortController.abort()
      this.active.delete(executionId)
      this.prepared.delete(executionId)

      // SQL-history (eis 19): elke uitvoering vastleggen — datum/tijd, server,
      // database, SQL, execution time, succes/fout, rowcount.
      const history = this.historyStore
      if (history) {
        try {
          history.add({
            connectionId: req.connectionId,
            server: req.server ?? req.connectionId,
            database: session.database ?? '',
            sql: req.sql,
            durationMs: Math.round(performance.now() - start),
            success: !error && !active.cancelRequested,
            ...(error ? { error } : {}),
            rowCount: providerRowCount > 0 ? providerRowCount : delivered
          })
        } catch {
          // History is best-effort; een fout hier mag de query niet breken.
        }
      }

      // Auditlog (F2-8, eis 26): query-uitvoering, best-effort.
      const audit = this.auditStore
      if (audit) {
        try {
          audit.add({
            action: 'query.executed',
            server: req.server ?? req.connectionId,
            database: session.database ?? '',
            detail: `Query ${error ? 'mislukt' : active.cancelRequested ? 'geannuleerd' : 'uitgevoerd'}: ${req.sql.slice(0, 300)}${req.sql.length > 300 ? '…' : ''}`,
            success: !error && !active.cancelRequested,
            ...(error ? { error } : {})
          })
        } catch {
          // Audit is best-effort.
        }
      }
    }
  }

  async cancel(executionId: string): Promise<void> {
    const active = this.active.get(executionId)
    if (!active || active.cancelRequested) return
    active.cancelRequested = true

    // Eerst de provider-cancel (echte server-side cancel waar ondersteund),
    // daarna de stream afbreken zodat de generator schoon eindigt.
    const prepared = this.prepared.get(executionId)
    let cancelError: unknown
    if (prepared) {
      const provider = registry.get(prepared.providerId)
      try {
        await provider.cancel(prepared.session, executionId)
      } catch (err) {
        cancelError = err
      }
    }
    active.abortController.abort()

    // Geen stille no-op: wanneer de provider geen echte cancel ondersteunt
    // (of de cancel zelf faalt), krijgt de gebruiker een duidelijke melding.
    if (cancelError !== undefined && !active.sender.isDestroyed()) {
      const message =
        cancelError instanceof Error ? cancelError.message : String(cancelError)
      active.sender.send('query:chunk', {
        executionId,
        chunk: {
          kind: 'warning',
          message: `Annuleren niet volledig ondersteund door de provider: ${message} De query wordt lokaal gestopt; de server-side uitvoering kan nog kort doorlopen.`
        }
      })
    }
  }

  /** Aantal actieve uitvoeringen (diagnostiek/tests). */
  get activeCount(): number {
    return this.active.size
  }
}

export const queryRunner = new QueryRunner()
