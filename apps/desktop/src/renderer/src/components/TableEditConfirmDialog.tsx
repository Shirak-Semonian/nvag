/**
 * TableEditConfirmDialog (F2-1, eis 8) — bevestigingsdialoog voor
 * tabelbewerkingen die door environment-safety zijn geblokkeerd.
 * Toont de omgeving + badge, de redenen en de exacte SQL die zal draaien.
 */

import { useAppStore } from '../state/store'
import { EnvBadge } from './StatusBar'

export function TableEditConfirmDialog(): React.JSX.Element | null {
  const pending = useAppStore((s) => s.pendingTableEdit)
  const confirm = useAppStore((s) => s.confirmTableEdit)
  const cancel = useAppStore((s) => s.cancelTableEdit)

  if (!pending) return null

  return (
    <div className="modal-backdrop" onClick={cancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Tabelbewerking bevestigen</span>
          <EnvBadge environment={pending.environment} />
        </div>
        <div className="guard-reasons">
          {pending.reasons.map((r, i) => (
            <div key={i} className="msg-warning">
              ⚠️ {r}
            </div>
          ))}
        </div>
        <p>De volgende SQL wordt uitgevoerd:</p>
        <pre className="guard-sql">{pending.sql}</pre>
        <div className="modal-actions">
          <button type="button" onClick={cancel}>
            Annuleren
          </button>
          <button type="button" className="danger" onClick={() => void confirm()}>
            Toch uitvoeren
          </button>
        </div>
      </div>
    </div>
  )
}
