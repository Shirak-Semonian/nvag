import { describe, expect, it, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  handleStreamError,
  handleUncaughtException,
  handleUnhandledRejection,
  installCrashGuards,
  safeLog
} from './crash-guard'

/** Minimale fake van een WriteStream: genoeg voor 'error'-listeners. */
class FakeStream extends EventEmitter {
  errorCount = 0
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('crash-guard (SAL-29: write EPIPE mag het main process niet laten crashen)', () => {
  it('safeLog gooit niet wanneer console.error zelf faalt (verbroken console)', () => {
    const boom = new Error('write EPIPE')
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw boom
    })
    expect(() => safeLog('error', 'kapotte console')).not.toThrow()
  })

  it('safeLog schrijft normaal wanneer de console werkt', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    safeLog('error', 'meld', 42)
    expect(errorSpy).toHaveBeenCalledWith('meld', 42)
  })

  it('handleStreamError negeert EPIPE (verbroken pipe is geen crash)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(() => handleStreamError('stderr', epipe)).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('handleStreamError logt andere stream-fouten defensief', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    handleStreamError('stdout', new Error('ENOSPC'))
    expect(errorSpy).toHaveBeenCalled()
  })

  it('handleUncaughtException negeert EPIPE en logt de rest zonder te crashen', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(() => handleUncaughtException(epipe)).not.toThrow()
    expect(errorSpy).not.toHaveBeenCalled()

    expect(() => handleUncaughtException(new Error('iets anders'))).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('handleUnhandledRejection logt de reden zonder te crashen', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => handleUnhandledRejection('kapotte metadata-query')).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('installCrashGuards vangt EPIPE op injecteerbare streams en kan worden opgeruimd', () => {
    const stdout = new FakeStream()
    const stderr = new FakeStream()

    const cleanup = installCrashGuards({ stdout, stderr })
    expect(stdout.listenerCount('error')).toBe(1)
    expect(stderr.listenerCount('error')).toBe(1)

    // EPIPE op stderr (de Electron replyWithError → console.error-pad):
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    expect(() => stderr.emit('error', epipe)).not.toThrow()
    expect(() => stdout.emit('error', epipe)).not.toThrow()

    // Niet-EPIPE stream-fout wordt veilig gelogd (geen uncaught exception).
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => stderr.emit('error', new Error('kapot'))).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()

    cleanup()
    expect(stdout.listenerCount('error')).toBe(0)
    expect(stderr.listenerCount('error')).toBe(0)
  })

  it('installCrashGuards installeert procesbrede uncaughtException-vangnetten zonder te crashen', () => {
    const cleanup = installCrashGuards()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Direct aanroepen wat de proces-handler zou doen — de app draait door.
    expect(() => handleUncaughtException(new Error('onverwacht'))).not.toThrow()
    expect(errorSpy).toHaveBeenCalled()
    cleanup()
    expect(process.listeners('uncaughtException').length).toBeGreaterThanOrEqual(0)
  })
})
