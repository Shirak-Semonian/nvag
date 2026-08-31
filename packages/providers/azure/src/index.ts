/**
 * @nvag/provider-azure — Azure SQL / Azure Synapse via de mssql-provider.
 *
 * F2-9: Azure SQL Database en Azure Synapse Analytics spreken het T-SQL-
 * protocol; we hergebruiken daarom de SQL Server-provider (mssql-driver)
 * en passen alleen id + displayName aan. Capabilities en dialect zijn
 * identiek (tsql).
 */

import type { DatabaseProvider } from '@nvag/contracts'
import { createSqlServerProvider } from '@nvag/provider-sqlserver'

export function createAzureProvider(): DatabaseProvider {
  const inner = createSqlServerProvider()
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'id') return 'azure'
      if (prop === 'displayName') return 'Azure SQL / Synapse'
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}
