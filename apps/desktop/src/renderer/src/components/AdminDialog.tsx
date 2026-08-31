/**
 * Database Administration-dialoog (F2-3, eis 9).
 *
 * Creëer/verwijder databases, schemas, tabellen, views en indexen;
 * users/roles alleen waar de provider-capability dat ondersteunt.
 * Alle acties tonen de gegenereerde SQL en passeren de environment-safety.
 */

import { useEffect, useState } from 'react'
import type { AdminColumnDef } from '@nvag/contracts'
import { useAppStore } from '../state/store'

type AdminTab = 'database' | 'schema' | 'table' | 'view' | 'index' | 'users'

export function AdminDialog({ connectionId }: { connectionId: string | null }): React.JSX.Element {
  const caps = useAppStore((s) => s.adminCapabilities)
  const users = useAppStore((s) => s.adminUsers)
  const close = useAppStore((s) => s.closeAdminDialog)
  const loadAdminState = useAppStore((s) => s.loadAdminState)

  const [tab, setTab] = useState<AdminTab>('database')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (connectionId) void loadAdminState(connectionId)
  }, [connectionId, loadAdminState])

  const run = async (fn: () => Promise<{ sql: string }>, label: string): Promise<void> => {
    try {
      const r = await fn()
      setMessage(`✅ ${label}\n${r.sql}`)
    } catch (err) {
      setMessage(`❌ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const supportsSchemas = caps?.supportsSchemas ?? false
  const supportsUsers = caps?.supportsUsersAndRoles ?? false

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal admin-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Database Administration {caps ? `(${caps.dialect})` : ''}</span>
          <button type="button" className="icon-btn" onClick={close} aria-label="Sluiten">
            ✕
          </button>
        </div>
        <div className="admin-tabs" role="tablist">
          {(['database', 'schema', 'table', 'view', 'index', 'users'] as AdminTab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`admin-tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
              disabled={t === 'users' && !supportsUsers}
              title={t === 'users' && !supportsUsers ? 'Provider ondersteunt geen users/roles' : undefined}
            >
              {t === 'database' ? 'Databases' : t === 'schema' ? 'Schemas' : t === 'table' ? 'Tabellen' : t === 'view' ? 'Views' : t === 'index' ? 'Indexen' : 'Users'}
            </button>
          ))}
        </div>
        <div className="admin-body">
          {tab === 'database' && <DatabaseAdminTab connectionId={connectionId} onRun={run} />}
          {tab === 'schema' && <SchemaAdminTab connectionId={connectionId} onRun={run} supportsSchemas={supportsSchemas} />}
          {tab === 'table' && <TableAdminTab connectionId={connectionId} onRun={run} />}
          {tab === 'view' && <ViewAdminTab connectionId={connectionId} onRun={run} />}
          {tab === 'index' && <IndexAdminTab connectionId={connectionId} onRun={run} />}
          {tab === 'users' && <UsersAdminTab connectionId={connectionId} onRun={run} users={users} />}
        </div>
        {message && <pre className="admin-message">{message}</pre>}
      </div>
    </div>
  )
}

function DatabaseAdminTab({ connectionId, onRun }: { connectionId: string | null; onRun: (fn: () => Promise<{ sql: string }>, label: string) => Promise<void> }): React.JSX.Element {
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
          onClick={() => onRun(() => window.nvag.admin.createDatabase(connectionId, name), `CREATE DATABASE ${name}`)}
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!name}
          onClick={() => onRun(() => window.nvag.admin.dropDatabase(connectionId, name), `DROP DATABASE ${name}`)}
        >
          Verwijderen
        </button>
      </div>
    </div>
  )
}

function SchemaAdminTab({ connectionId, onRun, supportsSchemas }: { connectionId: string | null; onRun: (fn: () => Promise<{ sql: string }>, label: string) => Promise<void>; supportsSchemas: boolean }): React.JSX.Element {
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
          onClick={() => onRun(() => window.nvag.admin.createSchema(connectionId, '', name), `CREATE SCHEMA ${name}`)}
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!name}
          onClick={() => onRun(() => window.nvag.admin.dropSchema(connectionId, '', name), `DROP SCHEMA ${name}`)}
        >
          Verwijderen
        </button>
      </div>
    </div>
  )
}

function TableAdminTab({ connectionId, onRun }: { connectionId: string | null; onRun: (fn: () => Promise<{ sql: string }>, label: string) => Promise<void> }): React.JSX.Element {
  const [table, setTable] = useState('')
  const [schema, setSchema] = useState('')
  const [columns, setColumns] = useState<AdminColumnDef[]>([{ name: 'id', dataType: 'INTEGER', primaryKey: true }])

  if (!connectionId) return <div className="results-empty">Open eerst een verbinding.</div>

  const updateColumn = (i: number, patch: Partial<AdminColumnDef>): void => {
    setColumns((cols) => cols.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

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
                <input value={c.dataType} onChange={(e) => updateColumn(i, { dataType: e.target.value })} />
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
      <button onClick={() => setColumns((cols) => [...cols, { name: '', dataType: 'TEXT' }])}>
        ＋ Kolom
      </button>
      <div className="admin-actions">
        <button
          className="primary"
          disabled={!table || columns.some((c) => !c.name || !c.dataType)}
          onClick={() =>
            onRun(
              () => window.nvag.admin.createTable({ connectionId, database: '', schema: schema || undefined, table, columns }),
              `CREATE TABLE ${table}`
            )
          }
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!table}
          onClick={() => onRun(() => window.nvag.admin.dropTable(connectionId, '', schema || 'main', table), `DROP TABLE ${table}`)}
        >
          Tabel verwijderen
        </button>
      </div>
    </div>
  )
}

function ViewAdminTab({ connectionId, onRun }: { connectionId: string | null; onRun: (fn: () => Promise<{ sql: string }>, label: string) => Promise<void> }): React.JSX.Element {
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
          onClick={() => onRun(() => window.nvag.admin.createView(connectionId, '', schema || 'main', name, selectSql), `CREATE VIEW ${name}`)}
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!name}
          onClick={() => onRun(() => window.nvag.admin.dropView(connectionId, '', schema || 'main', name), `DROP VIEW ${name}`)}
        >
          Verwijderen
        </button>
      </div>
    </div>
  )
}

function IndexAdminTab({ connectionId, onRun }: { connectionId: string | null; onRun: (fn: () => Promise<{ sql: string }>, label: string) => Promise<void> }): React.JSX.Element {
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
              () => window.nvag.admin.createIndex({ connectionId, database: '', schema: schema || undefined, index: { name, table, schema: schema || undefined, columns: cols, unique } }),
              `CREATE INDEX ${name}`
            )
          }
        >
          Creëren
        </button>
        <button
          className="danger"
          disabled={!name || !table}
          onClick={() => onRun(() => window.nvag.admin.dropIndex(connectionId, '', schema || 'main', table, name), `DROP INDEX ${name}`)}
        >
          Verwijderen
        </button>
      </div>
    </div>
  )
}

function UsersAdminTab({ connectionId, onRun, users }: { connectionId: string | null; onRun: (fn: () => Promise<{ sql: string }>, label: string) => Promise<void>; users: { name: string; role?: string }[] }): React.JSX.Element {
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
          onClick={() => onRun(() => window.nvag.admin.createUser({ connectionId, name, password: password || undefined }), `CREATE USER ${name}`)}
        >
          Gebruiker aanmaken
        </button>
        <button
          className="danger"
          disabled={!name}
          onClick={() => onRun(() => window.nvag.admin.dropUser(connectionId, name), `DROP USER ${name}`)}
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
