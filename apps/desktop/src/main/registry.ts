/**
 * Provider Registry — registreert en ontsluit DatabaseProviders.
 * (ADR-002, eis 21 + 29)
 *
 * F0: statische registratie van de SQLite-provider.
 * F3: externe plugins via dynamic import.
 */

import type { DatabaseProvider, ProviderRegistry } from '@nvag/contracts'
import { createSqliteProvider } from '@nvag/provider-sqlite'

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

export function registerBuiltinProviders(): void {
  registry.register(createSqliteProvider())
}
