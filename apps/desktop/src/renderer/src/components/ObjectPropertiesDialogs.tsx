import { useCallback, useEffect, useState } from 'react'
import type { AlterDatabaseResult, DatabasePropertiesResult, DbObjectRef } from '@nvag/contracts'
import { useAppStore } from '../state/store'

/**
 * Eigenschappendialogen voor Object Explorer (SAL-34 / SAL-50).
 *
 * - DatabasePropertiesDialog: SAL-50 — toont database-eigenschappen (live via
 *   admin.getDatabaseProperties) en laat ondersteunde eigenschappen wijzigen
 *   via dialect-correct ALTER DATABASE (SQL-preview + guard-bevestiging).
 *   Providers zonder ALTER-ondersteuning tonen read-only-info + reden.
 * - ObjectDefinitionDialog: toont de definitie (CREATE-script) van een
 *   procedure/function/trigger via getObjectDefinition.
 */

/** Sluit de dialoog met Escape (SAL-34: toetsenbord-ontsnapping). */
function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

export interface DatabasePropertiesState {
  connId: string
  db: string
}

interface PendingAlter {
  /** Gewijzigde eigenschappen (key → nieuwe waarde). */
  changes: Record<string, string>
  /** Gegenereerde SQL-preview (na guard-blokkade). */
  sql: string
  /** Guard-redenen (environment-safety). */
  reasons: string[]
  /** Fout van een mislukte bevestigde poging. */
  error: string | null
}

export function DatabasePropertiesDialog({
  state,
  onClose
}: {
  state: DatabasePropertiesState
  onClose: () => void
}): React.JSX.Element {
  const connections = useAppStore((s) => s.connections)
  const conn = connections.find((c) => c.id === state.connId)
  useEscape(onClose)

  const [result, setResult] = useState<DatabasePropertiesResult | null>(null)
  const [dbName, setDbName] = useState(state.db)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Bewerkbare eigenschappen: key → nieuwe waarde (initieel huidige waarde). */
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const [pending, setPending] = useState<PendingAlter | null>(null)

  const fetchProperties = useCallback(
    async (db: string): Promise<void> => {
      setLoading(true)
      setError(null)
      setMessage(null)
      try {
        const res = await window.nvag.admin.getDatabaseProperties(state.connId, db)
        setResult(res)
        setDbName(res.database)
        setDraft(Object.fromEntries(res.properties.filter((p) => p.editable).map((p) => [p.key, p.value])))
      } catch (err) {
        setResult(null)
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [state.connId]
  )

  useEffect(() => {
    void fetchProperties(state.db)
  }, [state.db, fetchProperties])

  if (loading || error || result === null) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal properties-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Database-eigenschappen">
          <div className="modal-header">
            <span>Database-eigenschappen: {dbName}</span>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Sluiten">
              ✕
            </button>
          </div>
          <div className="modal-body">
            <table className="details-table">
              <tbody>
                <tr>
                  <th>Verbinding</th>
                  <td>{conn?.name ?? state.connId}</td>
                </tr>
                <tr>
                  <th>Provider</th>
                  <td>{conn?.providerId ?? '—'}</td>
                </tr>
                <tr>
                  <th>Omgeving</th>
                  <td>{conn?.environment ?? '—'}</td>
                </tr>
              </tbody>
            </table>
            {loading && <div className="tree-details-loading">Eigenschappen laden…</div>}
            {error && <div className="confirm-error">Eigenschappen niet beschikbaar: {error}</div>}
          </div>
          <div className="modal-footer">
            <button type="button" className="primary" onClick={onClose}>
              Sluiten
            </button>
          </div>
        </div>
      </div>
    )
  }

  const editableProps = result.properties.filter((p) => p.editable)
  const infoProps = result.properties.filter((p) => !p.editable)
  const hasChanges = editableProps.some((p) => (draft[p.key] ?? p.value) !== p.value)

  /** Na een geslaagde ALTER: melding, refresh, boom/tab-context bijwerken. */
  const applyAlterSuccess = async (alterResult: AlterDatabaseResult): Promise<void> => {
    const lines = ['✅ Eigenschappen gewijzigd.']
    if (alterResult.warning && alterResult.warning.length > 0) {
      lines.push(`⚠ ${alterResult.warning.join(', ')}`)
    }
    lines.push(alterResult.sql)
    useAppStore.getState().bumpDbListRevision()
    if (alterResult.renamedTo && alterResult.renamedTo !== dbName) {
      // SQL Server: naamsverandering ook in boom/query-context doorvoeren.
      useAppStore.getState().renameDatabaseInTabs(dbName, alterResult.renamedTo)
      await fetchProperties(alterResult.renamedTo)
    } else {
      await fetchProperties(dbName)
    }
    // Melding ná de refresh zetten: fetchProperties wist de vorige melding.
    setMessage({ kind: 'success', text: lines.join('\n') })
  }

  const handleSave = async (): Promise<void> => {
    if (!result || !hasChanges || busy) return
    const changes: Record<string, string> = {}
    for (const p of editableProps) {
      if ((draft[p.key] ?? p.value) !== p.value) changes[p.key] = draft[p.key] ?? ''
    }
    if (Object.keys(changes).length === 0) return
    setBusy(true)
    setMessage(null)
    try {
      const alterResult = await window.nvag.admin.alterDatabase(state.connId, dbName, changes)
      if (!alterResult.ok && alterResult.blocked && alterResult.blocked.length > 0) {
        // Guard-blokkade: SQL-preview + redenen; volgende poging is bevestigd.
        setPending({ changes, sql: alterResult.sql, reasons: alterResult.blocked, error: null })
        return
      }
      await applyAlterSuccess(alterResult)
    } catch (err) {
      setMessage({ kind: 'error', text: `❌ ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setBusy(false)
    }
  }

  const confirmPending = async (): Promise<void> => {
    if (!pending || busy) return
    setBusy(true)
    setPending({ ...pending, error: null })
    try {
      const alterResult = await window.nvag.admin.alterDatabase(state.connId, dbName, pending.changes, true)
      setPending(null)
      await applyAlterSuccess(alterResult)
    } catch (err) {
      setPending({ ...pending, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const setValue = (key: string, value: string): void => {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal properties-modal dbprops-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Database-eigenschappen">
        <div className="modal-header">
          <span>Database-eigenschappen: {dbName}</span>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Sluiten">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <table className="details-table">
            <tbody>
              <tr>
                <th>Verbinding</th>
                <td>{conn?.name ?? state.connId}</td>
              </tr>
              <tr>
                <th>Provider</th>
                <td>{conn?.providerId ?? '—'}</td>
              </tr>
              <tr>
                <th>Omgeving</th>
                <td>{conn?.environment ?? '—'}</td>
              </tr>
              <tr>
                <th>Dialect</th>
                <td>{result.dialect}</td>
              </tr>
            </tbody>
          </table>

          {!result.supportsAlter && result.message && (
            <div className="dbprops-note" role="status">
              ℹ️ {result.message}
            </div>
          )}

          {result.supportsAlter && editableProps.length > 0 && (
            <div className="dbprop-fields">
              <p className="confirm-sql-label">Wijzigbare eigenschappen</p>
              {editableProps.map((p) =>
                p.kind === 'select' ? (
                  <label key={p.key} className="dbprop-field">
                    {p.label}
                    <select
                      value={draft[p.key] ?? p.value}
                      onChange={(e) => setValue(p.key, e.target.value)}
                      disabled={busy}
                    >
                      {(p.options ?? []).map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label key={p.key} className="dbprop-field">
                    {p.label}
                    <input
                      type="text"
                      value={draft[p.key] ?? p.value}
                      onChange={(e) => setValue(p.key, e.target.value)}
                      disabled={busy}
                    />
                    {p.note && <span className="dbprop-hint">{p.note}</span>}
                  </label>
                )
              )}
            </div>
          )}

          {infoProps.length > 0 && (
            <table className="details-table">
              <tbody>
                {infoProps.map((p) => (
                  <tr key={p.key}>
                    <th>{p.label}</th>
                    <td>
                      {p.value}
                      {p.note && <div className="dbprop-hint">{p.note}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {message && (
            <pre className={`test-msg ${message.kind === 'success' ? 'ok' : 'err'}`}>{message.text}</pre>
          )}

          {pending && (
            <div className="admin-confirm">
              <div className="guard-reasons">
                {pending.reasons.map((reason) => (
                  <div key={reason} className="msg-warning">
                    ⚠️ {reason}
                  </div>
                ))}
              </div>
              <p className="confirm-message">De volgende ALTER DATABASE-statement(s) worden uitgevoerd:</p>
              <pre className="guard-sql">{pending.sql}</pre>
              {pending.error && <div className="confirm-error">❌ {pending.error}</div>}
              <div className="modal-actions">
                <button type="button" onClick={() => setPending(null)} disabled={busy}>
                  Annuleren
                </button>
                <button type="button" className="danger" onClick={() => void confirmPending()} disabled={busy}>
                  {busy ? 'Bezig…' : 'Toch uitvoeren'}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          {result.supportsAlter && (
            <button
              type="button"
              className="primary"
              onClick={() => void handleSave()}
              disabled={busy || loading || !hasChanges || pending !== null}
            >
              {busy ? 'Bezig…' : 'Wijzigingen opslaan'}
            </button>
          )}
          <button type="button" onClick={onClose} disabled={busy}>
            Sluiten
          </button>
        </div>
      </div>
    </div>
  )
}

export interface ObjectDefinitionState {
  connId: string
  db: string
  schema?: string
  name: string
  kind: 'procedure' | 'function' | 'trigger'
}

const KIND_LABELS: Record<string, string> = {
  procedure: 'Stored procedure',
  function: 'Functie',
  trigger: 'Trigger'
}

export function ObjectDefinitionDialog({
  state,
  onClose
}: {
  state: ObjectDefinitionState
  onClose: () => void
}): React.JSX.Element {
  const [definition, setDefinition] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEscape(onClose)

  // Component mount alleen wanneer de dialoog geopend wordt → initial state is
  // per opening vers; geen sync setState in het effect nodig.
  useEffect(() => {
    let cancelled = false
    const obj: DbObjectRef = {
      type: state.kind,
      database: state.db,
      schema: state.schema,
      name: state.name
    }
    window.nvag.metadata
      .getObjectDefinition(state.connId, obj)
      .then((def) => {
        if (!cancelled) {
          setDefinition(def)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [state])

  const label = KIND_LABELS[state.kind] ?? state.kind

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal properties-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${label}-eigenschappen`}>
        <div className="modal-header">
          <span>
            {label}: {state.name}
          </span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Sluiten">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <table className="details-table">
            <tbody>
              <tr>
                <th>Type</th>
                <td>{label}</td>
              </tr>
              <tr>
                <th>Database</th>
                <td>{state.db}</td>
              </tr>
              <tr>
                <th>Schema</th>
                <td>{state.schema ?? '—'}</td>
              </tr>
            </tbody>
          </table>
          {loading && <div className="tree-details-loading">Definitie laden…</div>}
          {!loading && definition !== null && (
            <>
              <p className="confirm-sql-label">Definitie:</p>
              <pre className="guard-sql">{definition}</pre>
            </>
          )}
          {!loading && error !== null && (
            <div className="confirm-error">Definitie niet beschikbaar: {error}</div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="primary" onClick={onClose}>
            Sluiten
          </button>
        </div>
      </div>
    </div>
  )
}
