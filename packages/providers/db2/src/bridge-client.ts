/**
 * NDJSON-client voor de Db2 JDBC-bridge (F1-9).
 *
 * Spawnt de Java-sidecar (`Db2Bridge.java`) en wisselt newline-gescheiden
 * JSON uit over stdin/stdout. `request()` is voor eenmalige ops,
 * `executeQuery()` streamt events (columns/rows/done/error) voor één query.
 *
 * Protocol:
 *   → {"id":1,"op":"connect","params":{...}}
 *   ← {"id":1,"ok":true,"result":{...}}            (eenmalig)
 *   ← {"id":1,"ok":false,"error":"..."}            (fout, terminal)
 *   ← {"id":2,"ok":true,"event":"columns",...}     (query, streamed)
 *   ← {"id":2,"ok":true,"event":"rows","rows":[...]}
 *   ← {"id":2,"ok":true,"event":"done",...}        (terminal)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'
import { resolveBridgeCommand, resolveJccJar } from './jcc.ts'

export type BridgeEvent =
  | { kind: 'columns'; columns: { name: string }[] }
  | { kind: 'rows'; rows: unknown[][] }
  | { kind: 'done'; rowCount: number; durationMs: number }
  | { kind: 'error'; message: string }

interface PendingRequest {
  id: number
  lines: unknown[]
  waiters: Array<() => void>
  terminal: boolean
  terminalLine: unknown | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export class BridgeClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stderrTail = ''

  /** Start de bridge (lazy, eenmalig). Gooit een fout met installatiehint. */
  async ensureStarted(): Promise<void> {
    if (this.proc) return
    const jccJar = resolveJccJar()
    const cmd = resolveBridgeCommand(jccJar)
    if (!cmd || cmd.length === 0) {
      throw new Error(
        'Db2: JDBC-driver (jcc.jar) niet gevonden. Zet NVAG_DB2_JCC_JAR of kopieer de ' +
          'driver naar ~/.nvag/db2jcc/jcc.jar — zie packages/providers/db2/src/bridge/README.md'
      )
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(cmd[0]!, cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      throw new Error(
        `Db2: bridge niet te starten (${cmd[0]}) — ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
    this.proc = child
    child.stderr.on('data', (buf: Buffer) => {
      this.stderrTail = (this.stderrTail + buf.toString()).slice(-2048)
    })
    // spawn-fouten (ENOENT e.d.) komen als 'error'-event, niet als throw.
    child.on('error', (err) => {
      this.failAll(
        `Db2: bridge niet te starten (${cmd[0]}) — ${err.message}` +
          (this.stderrTail ? ` — stderr: ${this.stderrTail.trim()}` : '')
      )
      this.proc = null
    })
    child.on('exit', (code, signal) => {
      this.failAll(
        `Db2: JDBC-bridge gestopt (exit ${code ?? '?'}${signal ? `, ${signal}` : ''})` +
          (this.stderrTail ? ` — stderr: ${this.stderrTail.trim()}` : '')
      )
      this.proc = null
    })
    readline
      .createInterface({ input: child.stdout })
      .on('line', (line) => this.handleLine(line))
  }

  private failAll(message: string): void {
    for (const p of this.pending.values()) {
      p.terminal = true
      p.terminalLine = { ok: false, error: message }
      this.wake(p)
    }
    this.pending.clear()
  }

  private handleLine(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line) as unknown
    } catch {
      // Geen JSON (bijv. JVM-waarschuwing op stderr-achtige stdout) — negeren.
      return
    }
    if (!isRecord(msg) || typeof msg.id !== 'number') return
    const p = this.pending.get(msg.id)
    if (!p) return
    if (!('event' in msg) || msg.ok === false) {
      p.terminal = true
      p.terminalLine = msg
    }
    p.lines.push(msg)
    this.wake(p)
  }

  private wake(p: PendingRequest): void {
    const w = p.waiters
    p.waiters = []
    for (const fn of w) fn()
  }

  private async nextLine(p: PendingRequest): Promise<unknown> {
    for (;;) {
      if (p.lines.length > 0) return p.lines.shift()
      if (p.terminal) return p.terminalLine
      await new Promise<void>((resolve) => p.waiters.push(resolve))
    }
  }

  private send(p: PendingRequest, op: string, params: unknown): void {
    if (!this.proc) throw new Error('Db2: bridge is niet gestart')
    this.proc.stdin.write(JSON.stringify({ id: p.id, op, params }) + '\n')
  }

  /** Eenmalige op: wacht op de terminale response en retourneer `result`. */
  async request<T>(op: string, params: unknown): Promise<T> {
    await this.ensureStarted()
    const p: PendingRequest = {
      id: this.nextId++,
      lines: [],
      waiters: [],
      terminal: false,
      terminalLine: null
    }
    this.pending.set(p.id, p)
    this.send(p, op, params)
    const line = await this.nextLine(p)
    this.pending.delete(p.id)
    if (isRecord(line) && line.ok === true) return (line.result ?? null) as T
    const err = isRecord(line) && typeof line.error === 'string' ? line.error : 'onbekende bridge-fout'
    throw new Error(`Db2: ${err}`)
  }

  /** Query-op: streamt events tot done/error. */
  async *executeQuery(connId: string, sql: string, maxRows: number): AsyncGenerator<BridgeEvent> {
    await this.ensureStarted()
    const p: PendingRequest = {
      id: this.nextId++,
      lines: [],
      waiters: [],
      terminal: false,
      terminalLine: null
    }
    this.pending.set(p.id, p)
    this.send(p, 'query', { connId, sql, maxRows })
    try {
      for (;;) {
        const line = await this.nextLine(p)
        if (!isRecord(line)) continue
        if (line.event === 'columns') {
          yield { kind: 'columns', columns: (line.columns ?? []) as { name: string }[] }
        } else if (line.event === 'rows') {
          yield { kind: 'rows', rows: (line.rows ?? []) as unknown[][] }
        } else if (line.event === 'done') {
          yield {
            kind: 'done',
            rowCount: typeof line.rowCount === 'number' ? line.rowCount : 0,
            durationMs: typeof line.durationMs === 'number' ? line.durationMs : 0
          }
          return
        } else if (line.ok === false) {
          yield { kind: 'error', message: typeof line.error === 'string' ? line.error : 'onbekende bridge-fout' }
          return
        } else {
          // Terminal zonder event (theoretisch niet voor query) — stoppen.
          return
        }
      }
    } finally {
      this.pending.delete(p.id)
    }
  }

  /** Stoppen van het sidecar-proces (bijv. in tests). */
  async stop(): Promise<void> {
    const proc = this.proc
    this.proc = null
    if (!proc || proc.exitCode !== null) return
    proc.stdin.end()
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1500)
      proc.once('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
    if (proc.exitCode === null) proc.kill()
  }
}
