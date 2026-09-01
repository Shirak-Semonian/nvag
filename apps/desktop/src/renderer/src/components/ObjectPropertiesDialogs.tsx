import { useEffect, useState } from 'react'
import type { DbObjectRef } from '@nvag/contracts'
import { useAppStore } from '../state/store'

/**
 * Eigenschappendialogen voor Object Explorer (SAL-34).
 *
 * - DatabasePropertiesDialog: toont database-eigenschappen (naam, verbinding,
 *   provider, omgeving, dialect) — de Object Explorer heeft geen aparte
 *   database-metadata-API, dus tonen we de bekende context.
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal properties-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Database-eigenschappen">
        <div className="modal-header">
          <span>Database-eigenschappen</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Sluiten">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <table className="details-table">
            <tbody>
              <tr>
                <th>Naam</th>
                <td>{state.db}</td>
              </tr>
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
