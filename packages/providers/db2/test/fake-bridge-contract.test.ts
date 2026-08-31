/**
 * Contracttests Db2 tegen de fake-bridge (F1-9, SAL-22).
 *
 * Draait de VOLLEDIGE generieke contract-suite zonder Java/Db2: de provider
 * wordt met NVAG_DB2_BRIDGE_CMD op test/fake-bridge.mjs gericht, een
 * Node-testdouble die het bridge-protocol en een kleine Db2-catalogus
 * simuleert. Zo blijft de provider-logica (verbinding, SYSCAT-metadata,
 * FETCH FIRST-cap, DML, multi-statement-beleid, foutmapping) continu groen,
 * ook zonder een live Db2-server.
 *
 * De echte integratie tegen een live server blijft apart env-gated
 * (contract.test.ts, NVAG_TEST_DB2_URL).
 */

import { fileURLToPath } from 'node:url'
import { runProviderContractTests } from '@nvag/contract-tests'
import { createDb2Harness, type Db2TestConfig } from './db2-harness'

const fakeBridgePath = fileURLToPath(new URL('./fake-bridge.mjs', import.meta.url))
process.env.NVAG_DB2_BRIDGE_CMD = `node ${fakeBridgePath}`

const fakeCfg: Db2TestConfig = {
  host: 'fake',
  port: 50000,
  database: 'nvagdb',
  user: 'db2inst1',
  password: 'test-password'
}

runProviderContractTests(createDb2Harness(fakeCfg, 'db2 (fake-bridge)'), { enabled: true })
