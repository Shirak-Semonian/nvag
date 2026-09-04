/**
 * Crash-guard (SAL-29) — voorkomt dat het main process crasht op een verbroken
 * console-stream (EPIPE).
 *
 * Achtergrond: wanneer een IPC-handler faalt (bijv. een metadata-query van de
 * SQL Server-provider tijdens het uitklappen van een database), logt Electron
 * die fout intern via console.error (replyWithError). Wanneer de app is
 * gestart met een stdout/stderr-pipe die inmiddels verbroken is (bijv. vanuit
 * een launcher/terminal die is gesloten), gooit die write zelf
 * `Error: write EPIPE` — als uncaught exception in het main process, met de
 * Electron-crashdialoog ("A JavaScript error occurred in the main process")
 * tot gevolg.
 *
 * De guard:
 *  1. vangt 'error'-events op process.stdout/process.stderr af (EPIPE is een
 *     verbruikte pipe en wordt genegeerd; de app draait gewoon door);
 *  2. installeert een laatste vangnet voor uncaught exceptions en unhandled
 *     rejections — loggen (defensief) in plaats van crashen.
 *
 * Bewuste keuze: een desktop-database-app beëindigt niet op een residuele
 * uncaught exception; de gebruiker verliest anders zijn sessie. De fout wordt
 * gelogd zodat de oorzaak traceerbaar blijft.
 */

/** Alleen de listener-API die de guard gebruikt (testbaar met fakes). */
export interface GuardStream {
  on(event: 'error', listener: (err: Error) => void): unknown
  removeListener(event: 'error', listener: (err: Error) => void): unknown
}

export interface CrashGuardStreams {
  stdout?: GuardStream
  stderr?: GuardStream
}

const EPIPE = 'EPIPE'

/** Log defensief: een kapotte console mag nooit zelf een crash veroorzaken. */
export function safeLog(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
  try {
    const fn = console[level] ?? console.log
    fn(...args)
  } catch {
    // console is verbroken (EPIPE e.d.) — negeren; de app draait door.
  }
}

/** 'error'-event op een proces-stream: EPIPE negeren, rest veilig loggen. */
export function handleStreamError(streamName: 'stdout' | 'stderr', err: unknown): void {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === EPIPE) {
    // Verbruikte pipe (ouderproces gestopt) — geen crash, niets te melden.
    return
  }
  safeLog('error', `[nvag] Error writing to ${streamName}:`, err)
}

/** Laatste vangnet: uncaught exception mag de app niet laten crashen. */
export function handleUncaughtException(err: unknown): void {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === EPIPE) return
  safeLog('error', '[nvag] Uncaught exception (main process):', err)
}

/** Laatste vangnet: unhandled rejection loggen (geen crash). */
export function handleUnhandledRejection(reason: unknown): void {
  safeLog('error', '[nvag] Unhandled promise rejection (main process):', reason)
}

/**
 * Installeer de guards. Default op de echte proces-streams; streams zijn
 * injecteerbaar zodat tests de logica zonder echte stdout/stderr kunnen
 * dekken. Retourneert een cleanup-functie (voor tests / herinstallatie).
 */
export function installCrashGuards(
  streams: CrashGuardStreams = { stdout: process.stdout, stderr: process.stderr }
): () => void {
  const onStdoutError = (err: Error): void => handleStreamError('stdout', err)
  const onStderrError = (err: Error): void => handleStreamError('stderr', err)
  const onUncaught = (err: Error): void => handleUncaughtException(err)
  const onRejection = (reason: unknown): void => handleUnhandledRejection(reason)

  streams.stdout?.on('error', onStdoutError)
  streams.stderr?.on('error', onStderrError)
  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)

  return () => {
    streams.stdout?.removeListener('error', onStdoutError)
    streams.stderr?.removeListener('error', onStderrError)
    process.removeListener('uncaughtException', onUncaught)
    process.removeListener('unhandledRejection', onRejection)
  }
}
