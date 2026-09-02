#!/usr/bin/env node
/**
 * Fake Db2-bridge voor tests (F1-9).
 *
 * Spreekt hetzelfde NDJSON-protocol als src/bridge/Db2Bridge.java en simuleert
 * een kleine Db2 LUW-database met de contract-fixture (contract_dml,
 * contract_meta, vw_contract_active) — inclusief SYSCAT.*-catalogus.
 *
 * Zo kan de volledige contract-suite draaien zonder Java/Db2 (de provider
 * wordt met NVAG_DB2_BRIDGE_CMD op deze fake gericht). De échte integratie
 * tegen een live Db2 blijft env-gated (NVAG_TEST_DB2_URL).
 *
 * Dit is een TEST-DOUBLE: de catalogus-antwoorden zijn vereenvoudigd en
 * dekken alleen wat de suite gebruikt.
 */
import readline from 'node:readline'

const SCHEMA = 'DB2INST1'

// tabelnaam → { columns: [naam, ...], rows: [[...], ...] } (kolommen uppercase,
// zoals DB2 unquoted identifiers vouwt; tabellen zijn gequoted-lowercase in
// de fixture zodat quoteIdentifier('contract_dml') = "contract_dml" matcht).
const tables = {
  contract_dml: {
    columns: ['ID', 'NAME'],
    rows: [
      [1, 'a'],
      [2, 'b'],
      [3, 'c']
    ]
  },
  contract_meta: {
    columns: ['ID', 'NAME', 'EMAIL', 'AMOUNT', 'ACTIVE'],
    rows: [
      [1, 'Alice', 'alice@x.nl', 10.5, 1],
      [2, 'Bob', 'bob@x.nl', 20.25, 0]
    ]
  }
}
const views = new Set(['vw_contract_active'])
// Identity-per-tabel (zoals Db2: elke tabel heeft een eigen sequence die bij
// DROP+CREATE opnieuw bij 1 begint — nodig voor de idempotente fixture).
const nextIds = {
  contract_dml: 4,
  contract_meta: 3
}

function initialColumnMeta() {
  return {
    contract_dml: [
      { NAME: 'ID', DATA_TYPE: 'INTEGER', LENGTH: 4, SCALE: 0, NULLABLE: 0, DEFAULT_VALUE: null, IS_IDENTITY: 1, IS_COMPUTED: 0, ORDINAL: 1 },
      { NAME: 'NAME', DATA_TYPE: 'VARCHAR', LENGTH: 100, SCALE: 0, NULLABLE: 0, DEFAULT_VALUE: null, IS_IDENTITY: 0, IS_COMPUTED: 0, ORDINAL: 2 }
    ],
    contract_meta: [
      { NAME: 'ID', DATA_TYPE: 'INTEGER', LENGTH: 4, SCALE: 0, NULLABLE: 0, DEFAULT_VALUE: null, IS_IDENTITY: 1, IS_COMPUTED: 0, ORDINAL: 1 },
      { NAME: 'NAME', DATA_TYPE: 'VARCHAR', LENGTH: 100, SCALE: 0, NULLABLE: 0, DEFAULT_VALUE: null, IS_IDENTITY: 0, IS_COMPUTED: 0, ORDINAL: 2 },
      { NAME: 'EMAIL', DATA_TYPE: 'VARCHAR', LENGTH: 255, SCALE: 0, NULLABLE: 1, DEFAULT_VALUE: null, IS_IDENTITY: 0, IS_COMPUTED: 0, ORDINAL: 3 },
      { NAME: 'AMOUNT', DATA_TYPE: 'DECIMAL', LENGTH: 10, SCALE: 2, NULLABLE: 1, DEFAULT_VALUE: null, IS_IDENTITY: 0, IS_COMPUTED: 0, ORDINAL: 4 },
      { NAME: 'ACTIVE', DATA_TYPE: 'INTEGER', LENGTH: 4, SCALE: 0, NULLABLE: 1, DEFAULT_VALUE: '1', IS_IDENTITY: 0, IS_COMPUTED: 0, ORDINAL: 5 }
    ]
  }
}
const columnMeta = initialColumnMeta()

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
function ok(id, result) {
  send({ id, ok: true, result })
}
function err(id, message) {
  send({ id, ok: false, error: message })
}
function event(id, ev, payload) {
  send({ id, ok: true, event: ev, [ev]: payload })
}
function done(id, rowCount, durationMs = 1) {
  send({ id, ok: true, event: 'done', rowCount, durationMs })
}

function tableNameFromWhere(sql) {
  const m = /UPPER\(TABNAME\)\s*=\s*UPPER\('([^']+)'\)/i.exec(sql)
  return m ? m[1] : null
}

function runQuery(id, sql, maxRows) {
  const upper = sql.toUpperCase()

  // --- Catalogus (SYSCAT.*) ---
  if (/FROM SYSIBM\.SYSDUMMY1/i.test(sql)) {
    event(id, 'columns', [{ name: 'NAME' }])
    event(id, 'rows', [['NVAGDB']])
    return done(id, 1)
  }
  if (/FROM SYSCAT\.SCHEMATA/i.test(sql)) {
    event(id, 'columns', [{ name: 'NAME' }])
    event(id, 'rows', [[SCHEMA], ['SYSIBM'], ['SYSTOOLS']])
    return done(id, 3)
  }
  if (/SELECT NUMROWS AS "ROW_COUNT"/i.test(sql)) {
    event(id, 'columns', [{ name: 'ROW_COUNT' }])
    event(id, 'rows', [[3]])
    return done(id, 1)
  }
  if (/FROM SYSCAT\.TABLES/i.test(sql)) {
    const rows = Object.keys(tables).map((t) => [SCHEMA, t])
    event(id, 'columns', [{ name: 'SCHEMA' }, { name: 'NAME' }])
    event(id, 'rows', rows)
    return done(id, rows.length)
  }
  if (/FROM SYSCAT\.VIEWS/i.test(sql)) {
    const rows = [...views].map((v) => [SCHEMA, v])
    event(id, 'columns', [{ name: 'SCHEMA' }, { name: 'NAME' }])
    event(id, 'rows', rows)
    return done(id, rows.length)
  }
  if (/FROM SYSCAT\.COLUMNS/i.test(sql)) {
    const t = tableNameFromWhere(sql)
    const cols = columnMeta[t] ?? []
    // Zelfde kolommen als de echte SYSCAT.COLUMNS-relevante selectie (géén
    // PRECISION — die kolom bestaat niet in Db2, SAL-37).
    const names = ['NAME', 'DATA_TYPE', 'LENGTH', 'SCALE', 'NULLABLE', 'DEFAULT_VALUE', 'IS_IDENTITY', 'IS_COMPUTED', 'ORDINAL']
    event(id, 'columns', names.map((n) => ({ name: n })))
    event(id, 'rows', cols.map((c) => names.map((n) => c[n])))
    return done(id, cols.length)
  }
  if (/FROM SYSCAT\.KEYCOLUSE/i.test(sql)) {
    const t = tableNameFromWhere(sql)
    const pk = t === 'contract_meta' ? ['ID'] : ['ID']
    event(id, 'columns', [{ name: 'NAME' }])
    event(id, 'rows', pk.map((c) => [c]))
    return done(id, pk.length)
  }
  if (/FROM SYSCAT\.REFERENCES/i.test(sql)) {
    const names = ['NAME', 'COL', 'REF_SCHEMA', 'REF_TABLE', 'REF_COL', 'ORD', 'ON_DELETE', 'ON_UPDATE']
    event(id, 'columns', names.map((n) => ({ name: n })))
    event(id, 'rows', [])
    return done(id, 0)
  }
  if (/FROM SYSCAT\.INDEXES i JOIN SYSCAT\.INDEXCOLUSE/i.test(sql)) {
    const names = ['NAME', 'UNIQUERULE', 'COL', 'ORD']
    event(id, 'columns', names.map((n) => ({ name: n })))
    event(id, 'rows', [])
    return done(id, 0)
  }
  if (/FROM SYSCAT\.INDEXES/i.test(sql) && /UNIQUERULE = 'U'/i.test(sql)) {
    event(id, 'columns', [{ name: 'NAME' }])
    event(id, 'rows', [])
    return done(id, 0)
  }
  if (/FROM SYSCAT\.CHECKS/i.test(sql)) {
    event(id, 'columns', [{ name: 'NAME' }, { name: 'DEFINITION' }])
    event(id, 'rows', [])
    return done(id, 0)
  }
  if (/FROM SYSCAT\.TABDEP/i.test(sql)) {
    const names = ['OBJECT_SCHEMA', 'OBJECT_NAME', 'OBJECT_TYPE']
    event(id, 'columns', names.map((n) => ({ name: n })))
    event(id, 'rows', [])
    return done(id, 0)
  }
  if (/FROM SYSCAT\.TRIGGERS/i.test(sql)) {
    const list = /SELECT TRIGSCHEMA AS "SCHEMA"/i.test(sql)
    if (list) {
      event(id, 'columns', [{ name: 'SCHEMA' }, { name: 'NAME' }, { name: 'TABLE' }])
      event(id, 'rows', [])
      return done(id, 0)
    }
    event(id, 'columns', [{ name: 'NAME' }])
    event(id, 'rows', [])
    return done(id, 0)
  }
  if (/SELECT NUMROWS AS "ROW_COUNT"/i.test(sql)) {
    event(id, 'columns', [{ name: 'ROW_COUNT' }])
    event(id, 'rows', [[3]])
    return done(id, 1)
  }

  // --- DDL / DML (fixture + contract-DML) ---
  const dropTable = /DROP TABLE IF EXISTS "([^"]+)"/i.exec(sql)
  if (dropTable) {
    const t = dropTable[1]
    delete tables[t]
    delete columnMeta[t]
    delete nextIds[t]
    return done(id, 0)
  }
  const createTable = /CREATE TABLE "([^"]+)"/i.exec(sql)
  if (createTable) {
    const t = createTable[1]
    if (!tables[t]) {
      tables[t] = { columns: ['ID', 'NAME', 'EMAIL', 'ACTIVE'], rows: [] }
    }
    // Fixture is idempotent: na DROP+CREATE begint de identity weer bij 1 en
    // is de catalogus-metadata weer aanwezig (zoals op een echte Db2).
    nextIds[t] = 1
    if (!columnMeta[t] && initialColumnMeta()[t]) {
      columnMeta[t] = initialColumnMeta()[t]
    }
    return done(id, 0)
  }
  // Db2 LUW 11.5 kent geen DROP VIEW IF EXISTS (SQLCODE=-104) en geen
  // DROP TABLE ... CASCADE; een DROP TABLE laat een afhankelijke view als
  // inoperative achter. De fixture maakt de view daarom met CREATE OR
  // REPLACE VIEW (vervangt ook een inoperative view met dezelfde naam).
  const createView = /CREATE OR REPLACE VIEW "([^"]+)"/i.exec(sql)
  if (createView) {
    views.add(createView[1])
    return done(id, 0)
  }
  const createIndex = /CREATE INDEX/i.test(sql)
  if (createIndex) return done(id, 0)

  const insert = /INSERT INTO "([^"]+)"\s*\(([^)]*)\)\s*VALUES\s*(.*)$/is.exec(sql)
  if (insert) {
    const t = tables[insert[1]]
    if (!t) return err(id, `Fake Db2: tabel niet gevonden: ${insert[1]}`)
    const tuples = [...insert[3].matchAll(/\(([^)]*)\)/g)].map((m) =>
      m[1].split(',').map((v) => v.trim().replace(/^'(.*)'$/, '$1').replace(/^(\d+)$/, Number))
    )
    for (const tuple of tuples) {
      t.rows.push([nextIds[t] ?? 1, ...tuple])
      nextIds[t] = (nextIds[t] ?? 1) + 1
    }
    return done(id, tuples.length)
  }

  const update = /UPDATE "([^"]+)"\s+SET\s+(\w+)\s*=\s*'([^']*)'\s+WHERE\s+(\w+)\s*=\s*(\d+)/i.exec(sql)
  if (update) {
    const t = tables[update[1]]
    if (!t) return err(id, `Fake Db2: tabel niet gevonden: ${update[1]}`)
    const col = update[2].toUpperCase()
    const whereCol = update[4].toUpperCase()
    const whereVal = Number(update[5])
    let count = 0
    for (const row of t.rows) {
      const idx = t.columns.indexOf(col)
      const wIdx = t.columns.indexOf(whereCol)
      if (row[wIdx] === whereVal) {
        row[idx] = update[3]
        count++
      }
    }
    return done(id, count)
  }

  const del = /DELETE FROM "([^"]+)"\s+WHERE\s+(\w+)\s*=\s*(\d+)/i.exec(sql)
  if (del) {
    const t = tables[del[1]]
    if (!t) return err(id, `Fake Db2: tabel niet gevonden: ${del[1]}`)
    const whereCol = del[2].toUpperCase()
    const whereVal = Number(del[3])
    const before = t.rows.length
    t.rows = t.rows.filter((r) => r[t.columns.indexOf(whereCol)] !== whereVal)
    return done(id, before - t.rows.length)
  }

  // --- SELECT ---
  const select = /^SELECT \* FROM "([^"]+)"/i.exec(sql.trim())
  if (select) {
    const t = tables[select[1]]
    if (!t) return err(id, `Fake Db2: tabel niet gevonden: ${select[1]}`)
    const limit = /FETCH FIRST (\d+) ROWS ONLY/i.exec(sql)
    const rows = limit ? t.rows.slice(0, Number(limit[1])) : t.rows
    event(id, 'columns', t.columns.map((c) => ({ name: c })))
    if (rows.length > 0) event(id, 'rows', rows)
    return done(id, rows.length)
  }

  // --- BACKUP / RESTORE (F4-3) ---
  if (/^BACKUP DB /i.test(sql.trim())) {
    return done(id, 0)
  }
  if (/^RESTORE DB /i.test(sql.trim())) {
    return done(id, 0)
  }

  // --- Syntaxfout (contract: error-chunk + SQLERRMC) ---
  if (/^SELEC\b/i.test(sql.trim())) {
    return err(id, "DB2 SQL Error: SQLCODE=-104, SQLSTATE=42601, SQLERRMC=SELEC")
  }

  return err(id, `Fake Db2: onbekende query: ${sql.slice(0, 120)}`)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    send({ id: 0, ok: false, error: 'Fake Db2: ongeldige JSON' })
    return
  }
  const { id, op, params = {} } = req
  try {
    if (op === 'connect') {
      const portMatch = /jdbc:db2:\/\/[^:]+:(\d+)\//.exec(params.url || '')
      if (portMatch && Number(portMatch[1]) === 1) {
        return err(id, 'Fake Db2: verbinding geweigerd (poort 1)')
      }
      return ok(id, { connId: 'fake-' + Math.random().toString(36).slice(2, 10) })
    }
    if (op === 'close') return ok(id, { closed: true })
    if (op === 'serverInfo') {
      return ok(id, {
        dbmsName: 'DB2/LINUXX8664',
        dbmsVersion: '11.05.0900',
        database: 'NVAGDB',
        user: SCHEMA
      })
    }
    if (op === 'query') {
      return runQuery(id, String(params.sql ?? ''), Number(params.maxRows ?? 0))
    }
    return err(id, `Fake Db2: onbekende op: ${op}`)
  } catch (e) {
    return err(id, `Fake Db2: ${e?.message ?? String(e)}`)
  }
})
