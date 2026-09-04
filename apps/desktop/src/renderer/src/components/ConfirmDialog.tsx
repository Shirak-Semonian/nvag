import { useEffect } from 'react'

/**
 * Destructieve-bevestigingdialoog (SAL-34).
 *
 * Wordt gebruikt voor DROP-acties uit het Object Explorer-contextmenu
 * (database/tabel/view/schema). Toont een duidelijke waarschuwing, de
 * gegenereerde SQL en — wanneer de environment-safety-guard de actie blokkeert
 * — de guard-redenen; pas na expliciete bevestiging wordt de DROP uitgevoerd.
 * Annuleren voert nooit iets destructiefs uit.
 */
export interface ConfirmDialogProps {
  title: string
  message: React.ReactNode
  /** Gegenereerde SQL die wordt uitgevoerd (preview). */
  sql?: string
  /** Guard-redenen (environment-safety); tonen wanneer aanwezig. */
  reasons?: string[]
  /** Label van de bevestigingsknop (default 'Verwijderen'). */
  confirmLabel?: string
  /** Bezig-indicatie (voorkomt dubbelklik tijdens uitvoeren). */
  busy?: boolean
  /** Foutmelding van een mislukte uitvoering. */
  error?: string | null
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  sql,
  reasons,
  confirmLabel = 'Delete',
  busy = false,
  error,
  onConfirm,
  onCancel
}: ConfirmDialogProps): React.JSX.Element {
  // Toetsenbord-ontsnapping (SAL-34, eis: sluiten met Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-label={title}>
        <div className="modal-header">
          <span>⚠️ {title}</span>
          <button type="button" className="icon-btn" onClick={onCancel} disabled={busy} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body confirm-body">
          <p className="confirm-message">{message}</p>
          {reasons && reasons.length > 0 && (
            <ul className="guard-reasons">
              {reasons.map((reason) => (
                <li key={reason} className="msg-warning">
                  ⚠️ {reason}
                </li>
              ))}
            </ul>
          )}
          {sql && (
            <>
              <p className="confirm-sql-label">SQL to execute:</p>
              <pre className="guard-sql">{sql}</pre>
            </>
          )}
          {error && <div className="confirm-error">❌ {error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
