/**
 * Provider Registry — registreert en ontsluit DatabaseProviders.
 * (ADR-002, eis 21 + 29)
 *
 * F0: statische registratie van de SQLite-provider.
 * F2-9: Oracle/Snowflake/Azure/Databricks worden dynamisch geladen met
 * try/catch — een ontbrekende of niet-buildbare driver (native modules)
 * mag de app-start nooit breken; de provider wordt dan simpelweg niet
 * geregistreerd (en toont een duidelijke melding bij gebruik).
 * F3: externe plugins via dynamic import.
 */

import type { DatabaseProvider, ProviderRegistry } from '@nvag/contracts'
import { createSqliteProvider } from '@nvag/provider-sqlite'
import { createSqlServerProvider } from '@nvag/provider-sqlserver'
import { createDb2Provider } from '@nvag/provider-db2'

class Registry implements ProviderRegistry {
  private providers = new Map<string, DatabaseProvider>()

  register(provider: DatabaseProvider): void {
    this.providers.set(provider.id, provider)
  }

  get(id: string): DatabaseProvider {
    const p = this.providers.get(id)
    if (!p) throw new Error(`Provider niet geregistreerd: ${id}`)
    return p
  }

  list(): DatabaseProvider[] {
    return [...this.providers.values()]
  }

  has(id: string): boolean {
    return this.providers.has(id)
  }
}

export const registry: ProviderRegistry = new Registry()

/** Registreert een provider dynamisch; faalt de import/driver, dan wordt hij overgeslagen. */
async function registerLazy(name: string, factory: () => Promise<DatabaseProvider>): Promise<void> {
  try {
    const provider = await factory()
    registry.register(provider)
  } catch (err) {
    console.warn(`[nvag] Provider ${name} niet geladen: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function registerBuiltinProviders(): Promise<void> {
  // Statisch: altijd beschikbaar (geen native drivers).
  registry.register(createSqliteProvider())
  registry.register(createSqlServerProvider())
  registry.register(createDb2Provider())

  // Dynamisch (F2-9): drivers kunnen native zijn of zwaar; app moet blijven starten.
  await registerLazy('postgresql', async () => {
    const { createPostgresProvider } = await import('@nvag/provider-postgresql')
    return createPostgresProvider()
  })
  await registerLazy('mysql', async () => {
    const { createMySqlProvider } = await import('@nvag/provider-mysql')
    return createMySqlProvider()
  })
  await registerLazy('oracle', async () => {
    const { createOracleProvider } = await import('@nvag/provider-oracle')
    return createOracleProvider()
  })
  await registerLazy('snowflake', async () => {
    const { createSnowflakeProvider } = await import('@nvag/provider-snowflake')
    return createSnowflakeProvider()
  })
  await registerLazy('azure', async () => {
    const { createAzureProvider } = await import('@nvag/provider-azure')
    return createAzureProvider()
  })
  await registerLazy('databricks', async () => {
    const { createDatabricksProvider } = await import('@nvag/provider-databricks')
    return createDatabricksProvider()
  })
}
