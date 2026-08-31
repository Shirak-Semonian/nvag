/**
 * Driverkeuze F1-9 (ADR-005): Db2 via een JDBC-bridge.
 *
 * De provider praat niet direct met Db2, maar met een kleine Java-sidecar
 * (`Db2Bridge.java`) die de IBM DB2 JDBC-driver (`jcc.jar`, Type 4) draait.
 * Node en Java wisselen NDJSON uit over stdin/stdout — de core merkt niets
 * van de bridge (zie packages/providers/db2/src/bridge/README.md).
 *
 * Dit bestand regelt het vinden van `java` en `jcc.jar` en de JDBC-URL.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionConfig } from '@nvag/contracts'

/** Standaard-poort van Db2 LUW. */
export const DB2_DEFAULT_PORT = 50000

/** Mogelijke locaties van de IBM DB2 JDBC-driver (jcc.jar / db2jcc4.jar). */
export function resolveJccJar(): string | null {
  const candidates: Array<string | null> = [
    process.env.NVAG_DB2_JCC_JAR ?? null,
    process.env.NVAG_DB2_JCC_DIR ? join(process.env.NVAG_DB2_JCC_DIR, 'jcc.jar') : null,
    join(homedir(), '.nvag', 'db2jcc', 'jcc.jar'),
    join(homedir(), '.nvag', 'db2jcc', 'db2jcc4.jar'),
    '/opt/ibm/db2/V11.5/java/jcc.jar',
    '/opt/ibm/db2/V11.5/java/db2jcc4.jar',
    '/opt/ibm/db2/V11.1/java/jcc.jar'
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

export function javaBinary(): string {
  return process.env.NVAG_DB2_JAVA || 'java'
}

/**
 * Bouw de JDBC-URL voor Db2 LUW.
 * `jdbc:db2://host:port/database` — Db2 kent geen server-level verbinding,
 * een database is dus verplicht (anders kan de driver niet verbinden).
 */
export function buildJdbcUrl(config: ConnectionConfig): string {
  const host = config.host
  const port = config.port ?? DB2_DEFAULT_PORT
  const database = config.database ?? ''
  if (!host) throw new Error('Db2: geen host opgegeven')
  if (!database) throw new Error('Db2: geen database opgegeven (Db2 vereist een database in de verbinding)')
  const timeout = config.connectionTimeoutMs ?? 15000
  // jcc-URL-eigenschappen zijn `key=value;`-gescheiden achter een `:`.
  return `jdbc:db2://${host}:${port}/${database}:loginTimeout=${Math.max(1, Math.round(timeout / 1000))};`
}

/**
 * Bepaal het bridge-commando.
 *
 * Standaard: `java -cp <jcc.jar> <Db2Bridge.java>` (single-file source launch,
 * Java 11+). Voor tests kan `NVAG_DB2_BRIDGE_CMD` een andere executable
 * zetten (bijv. een fake-bridge in Node) — dan wordt de jcc-discovery
 * overgeslagen.
 */
export function resolveBridgeCommand(jccJar: string | null): string[] | null {
  const override = process.env.NVAG_DB2_BRIDGE_CMD
  if (override) {
    // Eenvoudige whitespace-splitsing; paden met spaties worden niet ondersteund.
    return override.split(/\s+/).filter(Boolean)
  }
  if (!jccJar) return null
  const bridgeSource = new URL('./bridge/Db2Bridge.java', import.meta.url).pathname
  return [javaBinary(), '-cp', jccJar, bridgeSource]
}
