import { useAppStore } from '../state/store'
import { EnvBadge } from './StatusBar'

/**
 * Bevestigingsdialoog voor environment-safety (ADR-009, F1-8).
 *
 * Toont de redenen waarom de query-guard in main process de query blokkeerde
 * en vraagt expliciet of de gebruiker de query (bijv. DELETE zonder WHERE,
 * DROP/TRUNCATE/ALTER, grote operatie) alsnog wil uitvoeren. Op PROD wordt
 * standaard altijd om bevestiging gevraagd.
 */
export function QueryGuardDialog(): React.JSX.Element | null {
  const pending = useAppStore((s) => s.pendingGuard)
  const confirmGuardQuery = useAppStore((s) => s.confirmGuardQuery)
  const cancelGuardQuery = useAppStore((s) => s.cancelGuardQuery)

  if (!pending) return null

  const isProd = pending.environment === 'PROD'

  return (
    <div className="modal-overlay">
      <div className="modal guard-modal">
        <h2>⚠️ Environment safety — confirmation required</h2>
        <div className="modal-body">
          <div className="guard-env-row">
            <span>Environment:</span>
            <EnvBadge environment={pending.environment} />
            {isProd && <span className="guard-prod-note">Production: always confirm</span>}
          </div>
          <p className="guard-intro">
            The query guard has flagged this query as risky. Do you really want to run
            it?
          </p>
          <ul className="guard-reasons">
            {pending.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <pre className="guard-sql">{pending.sql}</pre>
        </div>
        <div className="modal-footer">
          <button className="danger" onClick={() => void confirmGuardQuery()}>
            Run anyway
          </button>
          <button className="primary" onClick={cancelGuardQuery}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
