/**
 * Database Administration-dialoog (F2-3, eis 9).
 *
 * Creëer/verwijder databases, schemas, tabellen, views en indexen;
 * users/roles alleen waar de provider-capability dat ondersteunt.
 * Alle acties tonen de gegenereerde SQL en passeren de environment-safety.
 */

import { useEffect, useRef, useState } from 'react'
import type { AdminActionResult, AdminColumnDef, SqlDialectId } from '@nvag/contracts'
import { dataTypeOptionsFor, defaultColumnDataTypes } from '@nvag/sql-dialect'
import { useAppStore, type AdminDialogTab } from '../state/store'

type AdminTab = AdminDialogTab

/** SAL-51: dialecten waar DDL op een andere database kan draaien (de
 * Admin-dialoog toont daar een database-dropdown). SQLite e.d.: de database
 * ís de verbinding (geen dropdown; database='' → sessie-database). */
const MULTI_DB_DIALECTS: ReadonlySet<SqlDialectId> = new Set(['tsql', 'mysql', 'postgres'])

type AdminActionFn = (confirmed?: boolean) => Promise<AdminActionResult>

/** SAL-31: opties per admin-actie; refreshDbList laat ObjectExplorer de databaselijst herladen. */
interface AdminRunOpts {
  refreshDbList?: boolean
}

interface BackupAdminActionFn {
  (confirmed?: boolean): Promise<BackupAdminActionFnResult>
}

interface PendingConfirm {
  label: string
  sql: string
  reasons: string[]
  kind: 'admin' | 'backup'
  rerun: () => Promise<AdminActionResult | BackupAdminActionFnResult>
  refreshDbList?: boolean
}

type BackupAdminActionFnResult = {
  ok: boolean
  sql?: string
  targetPath?: string
  sourcePath?: string
  durationMs?: number
  message?: string
  blocked?: string[]
  guardSeverity?: 'warn' | 'confirm'
}

export function AdminDialog({ connectionId }: { connectionId: string | null }): React.JSX.Element {
  const caps = useAppStore((s) => s.adminCapabilities)
  const users = useAppStore((s) => s.adminUsers)
  const close = useAppStore((s) => s.closeAdminDialog)
  const loadAdminState = useAppStore((s) => s.loadAdminState)
  // SAL-34: Object Explorer kan een specifieke tab openen (bijv. 'table' bij
  // "Nieuwe tabel…"); zonder opgave default naar 'database'.
  const requestedTab = useAppStore((s) => s.adminDialogTab)
  // SAL-51: database-context van de open-actie (Tables-folder van db X →
  // X); zonder opgave de sessie-database van de verbinding.
  const requestedDatabase = useAppStore((s) => s.adminDialogDatabase)
  const sessionDb = useAppStore((s) => (connectionId ? s.openSessions[connectionId]?.serverInfo.currentDatabase : null))

  const [tab, setTab] = useState<AdminTab>(requestedTab ?? 'database')
  const [message, setMessage] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  const dialect: SqlDialectId | undefined = caps?.dialect
  const multiDb = dialect !== undefined && MULTI_DB_DIALECTS.has(dialect)
  /** SAL-51: actieve doeldatabase van de dialoog (leeg = sessie-database). */
  const [database, setDatabase] = useState<string>(() => requestedDatabase ?? sessionDb ?? '')
  const [dbOptions, setDbOptions] = useState<string[]>([])

  useEffect(() => {
    if (connectionId) void loadAdminState(connectionId)
  }, [connectionId, loadAdminState])

  // SAL-51: databaselijst van de verbinding ophalen voor de dropdown. Alleen
  // waar de DDL een database-context kent (tsql/mysql/postgres); sqlite e.d.
  // heeft precies één database (de verbinding zelf).
  useEffect(() => {
    if (!connectionId || !multiDb) {
      setDbOptions([])
      return
    }
    let alive = true
    window.nvag.metadata
      .listDatabases(connectionId)
      .then((list) => {
        if (!alive) return
        const names = list.map((d) => d.name)
        setDbOptions(names)
        setDatabase((prev) => prev || names[0] || '')
      })
      .catch(() => {
        if (alive) setDbOptions([])
      })
    return () => {
      alive = false
    }
  }, [connectionId, multiDb])

  /**
   * Voert een admin-actie uit met environment-safety (F2-3):
   * - `warn`-niveau (CREATE buiten PROD): uitvoeren + waarschuwing tonen.
   * - `confirm`-niveau (DROP/ALTER/PROD): bevestiging vragen met de SQL.
   * F4: ook backup/restore-resultaten (zonder SQL) worden getoond.
   */
  const run = async (
    fn: AdminActionFn | BackupAdminActionFn,
    label: string,
    kind: 'admin' | 'backup' = 'admin',
    opts?: AdminRunOpts
  ): Promise<void> => {
    try {
      const r = await fn()
      if (!r.ok && r.blocked && r.blocked.length > 0) {
        setPending({ label, sql: r.sql ?? '', reasons: r.blocked, kind, rerun: () => fn(true), refreshDbList: opts?.refreshDbList })
        return
      }
      // SAL-31: na geslaagde CREATE/DROP DATABASE de Object Explorer
      // automatisch laten vernieuwen (gebeurt ook na guard-bevestiging).
      if (opts?.refreshDbList) useAppStore.getState().bumpDbListRevision()
      // SAL-32: na DDL op database-objecten (table/view/index/schema/user)
      // de geopende objectfolders automatisch laten vernieuwen.
      if (kind === 'admin' && !opts?.refreshDbList) useAppStore.getState().bumpDbObjectsRevision()
      if (kind === 'backup') {
        const br = r as {
          ok: boolean
          targetPath?: string
          sourcePath?: string
          durationMs?: number
          message?: string
        }
        const where = br.targetPath ? ` → ${br.targetPath}` : br.sourcePath ? ` ← ${br.sourcePath}` : ''
        const meta = br.durationMs !== undefined ? ` (${br.durationMs} ms)` : ''
        setMessage(
          `✅ ${label}${where}${meta}${br.message ? `\n⚠ ${br.message}` : ''}`
        )
        return
      }
      const ar = r as AdminActionResult
      const warning = ar.warning && ar.warning.length > 0 ? `\n⚠ ${ar.warning.join(', ')}` : ''
      setMessage(`✅ ${label}\n${ar.sql}${warning}`)
    } catch (err) {
      setMessage(`❌ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const confirmPending = async (): Promise<void> => {
    if (!pending) return
    try {
      const r = await pending.rerun()
      if (pending.kind === 'backup') {
        const br = r as {
          ok: boolean
          targetPath?: string
          sourcePath?: string
          durationMs?: number
          message?: string
        }
        const where = br.targetPath ? ` → ${br.targetPath}` : br.sourcePath ? ` ← ${br.sourcePath}` : ''
        const meta = br.durationMs !== undefined ? ` (${br.durationMs} ms)` : ''
        setMessage(
          `✅ ${pending.label}${where}${meta}${br.message ? `\n⚠ ${br.message}` : ''}`
        )
      } else {
        const ar = r as AdminActionResult
        setMessage(`✅ ${pending.label}\n${ar.sql}`)
      }
      // SAL-31: ook na een bevestigde (guard) CREATE/DROP DATABASE de
      // Object Explorer automatisch laten vernieuwen.
      if (pending.refreshDbList) useAppStore.getState().bumpDbListRevision()
      // SAL-32: ook na bevestigde (guard) object-DDL de objectfolders verversen.
      if (pending.kind === 'admin' && !pending.refreshDbList) useAppStore.getState().bumpDbObjectsRevision()
    } catch (err) {
      setMessage(`❌ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPending(null)
    }
  }

  const supportsSchemas = caps?.supportsSchemas ?? false
  const supportsUsers = caps?.supportsUsersAndRoles ?? false
  const supportsBackup = caps?.supportsBackupRestore ?? false

  // SAL-51: tabs op 'database' (server-level CREATE/DROP DATABASE) en 'users'
  // (postgres: clusterbreed) krijgen geen database-context; de overige tabs
  // (schema/table/view/index/backup) werken op de gekozen doeldatabase.
  const targetDb = multiDb && tab !== 'database' && tab !== 'users' ? database : ''

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Database Administration {caps ? `(${caps.dialect})` : ''}</span>
          <button type="button" className="icon-btn" onClick={close} aria-label="Sluiten">
            ✕
          </button>
        </div>
        {multiDb && tab !== 'database' && tab !== 'users' && (
          <div className="admin-dbrow">
            <label>
              Doeldatabase{' '}
              <select value={database} onChange={(e) => setDatabase(e.target.value)} aria-label="Doeldatabase">
                {!database && <option value="">(sessie-database)</option>}
                {dbOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                {database && !dbOptions.includes(database) && (
                  <option value={database}>{database} (sessie)</option>
                )}
              </select>
            </label>
          </div>
        )}
        <div className="admin-tabs" role="tablist">
          {(['database', 'schema', 'table', 'view', 'index', 'users', 'backup'] as AdminTab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`admin-tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
              disabled={(t === 'users' && !supportsUsers) || (t === 'backup' && !supportsBackup)}
              title={
                (t === 'users' && !supportsUsers
                  ? 'Provider ondersteunt geen users/roles'
                  : t === 'backup' && !supportsBackup
                    ? 'Provider ondersteunt geen backup/restore'
                    : undefined)
              }
            >
              {t === 'database' ? 'Databases' : t === 'schema' ? 'Schemas' : t === 'table' ? 'Tabellen' : t === 'view' ? 'Views' : t === 'index' ? 'Indexen' : t === 'users' ? 'Users' : 'Backup'}
            </button>
          ))}
        </div>
        <div className="admin-body">
          {tab === 'database' && <DatabaseAdminTab connectionId={connectionId} onRun={run} />}
          {tab === 'schema' && <SchemaAdminTab connectionId={connectionId} database={targetDb} onRun={run} supportsSchemas={supportsSchemas} />}
          {tab === 'table' && <TableAdminTab connectionId={connectionId} database={targetDb} onRun={run} />}
          {tab === 'view' && <ViewAdminTab connectionId={connectionId} database={targetDb} onRun={run} />}
          {tab === 'index' && <IndexAdminTab connectionId={connectionId} database={targetDb} onRun={run} />}
          {tab === 'users' && <UsersAdminTab connectionId={connectionId} onRun={run} users={users} />}
          {tab === 'backup' && <BackupAdminTab connectionId={connectionId} database={targetDb} onRun={run} />}
        </div>
        {pending && (
          <div className="admin-confirm">
            <div className="guard-reasons">
              {pending.reasons.map((r, i) => (
                <div key={i} className="msg-warning">⚠️ {r}</div>
              ))}
            </div>
            <p>De volgende SQL wordt uitgevoerd:</p>
            <pre className="guard-sql">{pending.sql}</pre>
            <div className="modal-actions">
              <button type="button" onClick={() => setPending(null)}>Annuleren</button>
              <button type="button" className="danger" onClick={() => void confirmPending()}>
                Toch uitvoeren
              </button>
            </div>
          </div>
        )}
        {message && <pre className="admin-message">{message}</pre>}
      </div>
    </div>
  )
}

function DatabaseAdminTab({ connectionId, onRun }: { connectionId: string | null; onRun: (fn: AdminActionFn, label: string, kind?: 'admin' | 'backup', opts?: AdminRunOpts) => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState('')
  if (!connectionId) return <div className="results-empty">Open eerst een verbinding.</div>
  return (
    <div className="admin-form">
      <label>
        Naam{' '}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="bijv. nieuwe_db" />
      </label>
      <div className="admin-actions">
        <button
          className="primary"
          disabled={!name}
          onClick={() => onRun((confirmed) => window.nvag.admin.createDatabase(connectionId, name, confirmed), `CREATE DATABASE ${name}`, 'admin', { refreshDbList: true })}
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!name}
          onClick={() => onRun((confirmed) => window.nvag.admin.dropDatabase(connectionId, name, confirmed), `DROP DATABASE ${name}`, 'admin', { refreshDbList: true })}
        >
          Verwijderen
        </button>
      </div>
    </div>
  )
}

function SchemaAdminTab({ connectionId, database, onRun, supportsSchemas }: { connectionId: string | null; database: string; onRun: (fn: AdminActionFn, label: string) => Promise<void>; supportsSchemas: boolean }): React.JSX.Element {
  const [name, setName] = useState('')
  if (!connectionId) return <div className="results-empty">Open eerst een verbinding.</div>
  if (!supportsSchemas) return <div className="results-empty">Deze provider ondersteunt geen aparte schemas.</div>
  return (
    <div className="admin-form">
      <label>
        Naam{' '}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="bijv. audit" />
      </label>
      <div className="admin-actions">
        <button
          className="primary"
          disabled={!name}
          onClick={() => onRun((confirmed) => window.nvag.admin.createSchema(connectionId, database, name, confirmed), `CREATE SCHEMA ${name}`)}
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!name}
          onClick={() => onRun((confirmed) => window.nvag.admin.dropSchema(connectionId, database, name, confirmed), `DROP SCHEMA ${name}`)}
        >
          Verwijderen
        </button>
      </div>
    </div>
  )
}

/**
 * SAL-51: TableAdminTab — tabel aanmaken op de gekozen doeldatabase en een
 * datatype-combobox (dialect-correcte types via @nvag/sql-dialect; eigen type
 * typen blijft mogelijk, datalist-input). De standaardkolom krijgt een
 * dialect-passend type (tsql: int, sqlite: INTEGER, …).
 */
function TableAdminTab({ connectionId, database, onRun }: { connectionId: string | null; database: string; onRun: (fn: AdminActionFn, label: string) => Promise<void> }): React.JSX.Element {
  const [table, setTable] = useState('')
  const [schema, setSchema] = useState('')
  const caps = useAppStore((s) => s.adminCapabilities)
  const dialect: SqlDialectId = caps?.dialect ?? 'sqlite'
  const [columns, setColumns] = useState<AdminColumnDef[]>([])
  const seededFor = useRef<SqlDialectId | null>(null)

  // Vul bij het eerste render (of zodra het dialect bekend is) een
  // dialect-passende standaardkolom in — niet overschrijven zodra de
  // gebruiker kolommen heeft bewerkt.
  useEffect(() => {
    if (seededFor.current === dialect) return
    seededFor.current = dialect
    const [pkType] = defaultColumnDataTypes(dialect)
    setColumns([{ name: 'id', dataType: pkType, primaryKey: true }])
  }, [dialect])

  if (!connectionId) return <div className="results-empty">Open eerst een verbinding.</div>

  const updateColumn = (i: number, patch: Partial<AdminColumnDef>): void => {
    setColumns((cols) => cols.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  const typeOptions = dataTypeOptionsFor(dialect)
  const addColumnType = defaultColumnDataTypes(dialect)[1]

  return (
    <div className="admin-form">
      <div className="f2-panel-row">
        <label>
          Tabel{' '}
          <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="naam" />
        </label>
        <label>
          Schema (optioneel){' '}
          <input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="main/public/dbo" />
        </label>
      </div>
      <table className="admin-column-table">
        <thead>
          <tr>
            <th>Kolom</th>
            <th>Type</th>
            <th>PK</th>
            <th>NOT NULL</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c, i) => (
            <tr key={i}>
              <td>
                <input value={c.name} onChange={(e) => updateColumn(i, { name: e.target.value })} />
              </td>
              <td>
                <input
                  list={`admin-datatypes-${connectionId}`}
                  value={c.dataType}
                  onChange={(e) => updateColumn(i, { dataType: e.target.value })}
                  placeholder="type"
                />
              </td>
              <td>
                <input type="checkbox" checked={c.primaryKey ?? false} onChange={(e) => updateColumn(i, { primaryKey: e.target.checked })} />
              </td>
              <td>
                <input type="checkbox" checked={c.nullable === false} onChange={(e) => updateColumn(i, { nullable: !e.target.checked })} />
              </td>
              <td>
                <button className="icon-btn" onClick={() => setColumns((cols) => cols.filter((_, idx) => idx !== i))}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id={`admin-datatypes-${connectionId}`}>
        {typeOptions.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <button onClick={() => setColumns((cols) => [...cols, { name: '', dataType: addColumnType }])}>
        ＋ Kolom
      </button>
      <div className="admin-actions">
        <button
          className="primary"
          disabled={!table || columns.some((c) => !c.name || !c.dataType)}
          onClick={() =>
            onRun(
              (confirmed) => window.nvag.admin.createTable({ connectionId, database, schema: schema || undefined, table, columns }, confirmed),
              `CREATE TABLE ${table}`
            )
          }
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!table}
          onClick={() => onRun((confirmed) => window.nvag.admin.dropTable(connectionId, database, schema || 'main', table, confirmed), `DROP TABLE ${table}`)}
        >
          Tabel verwijderen
        </button>
      </div>
    </div>
  )
}

function ViewAdminTab({ connectionId, database, onRun }: { connectionId: string | null; database: string; onRun: (fn: AdminActionFn, label: string) => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState('')
  const [schema, setSchema] = useState('')
  const [selectSql, setSelectSql] = useState('SELECT * FROM ')
  if (!connectionId) return <div className="results-empty">Open eerst een verbinding.</div>
  return (
    <div className="admin-form">
      <div className="f2-panel-row">
        <label>
          Naam{' '}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="view_naam" />
        </label>
        <label>
          Schema (optioneel){' '}
          <input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="main/public/dbo" />
        </label>
      </div>
      <textarea
        placeholder="SELECT ..."
        value={selectSql}
        onChange={(e) => setSelectSql(e.target.value)}
        rows={4}
      />
      <div className="admin-actions">
        <button
          className="primary"
          disabled={!name || !selectSql.trim()}
          onClick={() => onRun((confirmed) => window.nvag.admin.createView(connectionId, database, schema || 'main', name, selectSql, confirmed), `CREATE VIEW ${name}`)}
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!name}
          onClick={() => onRun((confirmed) => window.nvag.admin.dropView(connectionId, database, schema || 'main', name, confirmed), `DROP VIEW ${name}`)}
        >
          Verwijderen
        </button>
      </div>
    </div>
  )
}

function IndexAdminTab({ connectionId, database, onRun }: { connectionId: string | null; database: string; onRun: (fn: AdminActionFn, label: string) => Promise<void> }): React.JSX.Element {
  const [name, setName] = useState('')
  const [table, setTable] = useState('')
  const [schema, setSchema] = useState('')
  const [columns, setColumns] = useState('')
  const [unique, setUnique] = useState(false)
  if (!connectionId) return <div className="results-empty">Open eerst een verbinding.</div>
  const cols = columns.split(',').map((c) => c.trim()).filter(Boolean)
  return (
    <div className="admin-form">
      <div className="f2-panel-row">
        <label>
          Indexnaam <input value={name} onChange={(e) => setName(e.target.value)} placeholder="idx_naam" />
        </label>
        <label>
          Tabel <input value={table} onChange={(e) => setTable(e.target.value)} placeholder="users" />
        </label>
        <label>
          Schema (optioneel){' '}
          <input value={schema} onChange={(e) => setSchema(e.target.value)} placeholder="public" />
        </label>
      </div>
      <div className="f2-panel-row">
        <label>
          Kolommen (komma-gescheiden){' '}
          <input value={columns} onChange={(e) => setColumns(e.target.value)} placeholder="naam, email" />
        </label>
        <label>
          <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} /> UNIQUE
        </label>
      </div>
      <div className="admin-actions">
        <button
          className="primary"
          disabled={!name || !table || cols.length === 0}
          onClick={() =>
            onRun(
              (confirmed) => window.nvag.admin.createIndex({ connectionId, database, schema: schema || undefined, index: { name, table, schema: schema || undefined, columns: cols, unique } }, confirmed),
              `CREATE INDEX ${name}`
            )
          }
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!name || !table}
          onClick={() => onRun((confirmed) => window.nvag.admin.dropIndex(connectionId, database, schema || 'main', table, name, confirmed), `DROP INDEX ${name}`)}
        >
          Verwijderen
        </button>
      </div>
    </div>
  )
}

function UsersAdminTab({ connectionId, onRun, users }: { connectionId: string | null; onRun: (fn: AdminActionFn, label: string) => Promise<void>; users: { name: string; role?: string }[] }): React.JSX.Element {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  if (!connectionId) return <div className="results-empty">Open eerst een verbinding.</div>
  return (
    <div className="admin-form">
      <div className="f2-panel-row">
        <label>
          Gebruikersnaam{' '}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="bijv. app_ro" />
        </label>
        <label>
          Wachtwoord (optioneel){' '}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
      </div>
      <div className="admin-actions">
        <button
          className="primary"
          disabled={!name}
          onClick={() => onRun((confirmed) => window.nvag.admin.createUser({ connectionId, name, password: password || undefined }, confirmed), `CREATE USER ${name}`)}
        >
          Gebruiker aanmaken
        </button>
        <button
          className="danger"
          disabled={!name}
          onClick={() => onRun((confirmed) => window.nvag.admin.dropUser(connectionId, '', name, confirmed), `DROP USER ${name}`)}
        >
          Verwijderen
        </button>
      </div>
      <div className="audit-list">
        {users.map((u) => (
          <div key={u.name} className="audit-row">
            <span className="audit-action">{u.name}</span>
            {u.role && <span className="audit-server">{u.role}</span>}
          </div>
        ))}
        {users.length === 0 && <div className="results-empty">Geen gebruikers (of niet ondersteund).</div>}
      </div>
    </div>
  )
}

/**
 * F4: Backup & Restore (DBA) — gated via `supportsBackupRestore`.
 * - Backup: database + doelpad → BACKUP DATABASE (guard: warn buiten PROD,
 *   confirm op PROD).
 * - Restore: database + bronpad → RESTORE DATABASE (guard: altijd confirm).
 * Gebruikt dezelfde guard-confirm-flow als de andere admin-acties.
 */
function BackupAdminTab({
  connectionId,
  database,
  onRun
}: {
  connectionId: string | null
  database: string
  onRun: (fn: BackupAdminActionFn, label: string, kind: 'backup') => Promise<void>
}): React.JSX.Element {
  const [databaseName, setDatabaseName] = useState(database ?? '')
  const [targetPath, setTargetPath] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  // SAL-51: database-context uit Object Explorer / dropdown doorgeven als de
  // gebruiker de backup-database niet zelf heeft ingevuld.
  useEffect(() => {
    if (database) setDatabaseName((prev) => prev || database)
  }, [database])
  if (!connectionId) return <div className="results-empty">Open eerst een verbinding.</div>
  return (
    <div className="admin-form">
      <label>
        Database{' '}
        <input value={databaseName} onChange={(e) => setDatabaseName(e.target.value)} placeholder="bijv. main / SalesDB" />
      </label>

      <div className="f2-panel-row">
        <label>
          Backup naar (pad){' '}
          <input value={targetPath} onChange={(e) => setTargetPath(e.target.value)} placeholder="/pad/naar/backup.db" />
        </label>
      </div>
      <div className="admin-actions">
        <button
          className="primary"
          disabled={!databaseName || !targetPath}
          onClick={() =>
            onRun(
              (confirmed) => window.nvag.admin.backupDatabase(connectionId, databaseName, targetPath, confirmed),
              `BACKUP ${databaseName}`,
              'backup'
            )
          }
        >
          Backup maken
        </button>
      </div>

      <hr className="admin-separator" />

      <div className="f2-panel-row">
        <label>
          Herstellen vanuit (pad){' '}
          <input value={sourcePath} onChange={(e) => setSourcePath(e.target.value)} placeholder="/pad/naar/bron-backup.db" />
        </label>
      </div>
      <div className="admin-actions">
        <button
          className="danger"
          disabled={!databaseName || !sourcePath}
          onClick={() =>
            onRun(
              (confirmed) => window.nvag.admin.restoreDatabase(connectionId, databaseName, sourcePath, confirmed),
              `RESTORE ${databaseName}`,
              'backup'
            )
          }
        >
          Herstellen
        </button>
      </div>
      <p className="admin-hint">
        RESTORE overschrijft de database en vraagt altijd bevestiging.
      </p>
    </div>
  )
}
