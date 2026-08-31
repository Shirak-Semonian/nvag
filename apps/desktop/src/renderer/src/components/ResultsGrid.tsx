import type { QueryRunResponse } from '@nvag/contracts'

export function ResultsGrid({ result }: { result: QueryRunResponse | null }): React.JSX.Element {
  if (!result) {
    return <div className="results-empty">Voer een query uit om resultaten te zien.</div>
  }
  if (result.error) {
    return <div className="results-error">⚠️ {result.error}</div>
  }
  if (result.columns.length === 0) {
    return (
      <div className="results-empty">
        Query uitgevoerd. {result.rowCount} rij(en) beïnvloed in {result.durationMs} ms.
      </div>
    )
  }

  return (
    <div className="results-grid-wrap">
      <table className="results-grid">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.name}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i}>
              {row.values.map((v, j) => (
                <td key={j} className={v === null ? 'cell-null' : ''}>
                  {v === null ? 'NULL' : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.truncated && (
        <div className="results-truncated">
          ⚠️ Resultaat afgekapt op {result.rowCount} rijen (max-rij-cap). Verfijn je query of verhoog de cap.
        </div>
      )}
    </div>
  )
}

export function MessagesPanel({ result }: { result: QueryRunResponse | null }): React.JSX.Element {
  if (!result) {
    return <div className="messages-empty">Klaar.</div>
  }
  return (
    <div className="messages-panel">
      {result.error ? (
        <div className="msg-error">Fout: {result.error}</div>
      ) : (
        <div className="msg-ok">
          Query voltooid — {result.rowCount} rij(en) in {result.durationMs} ms
          {result.columns.length > 0 ? `, ${result.columns.length} kolom(men)` : ''}.
        </div>
      )}
    </div>
  )
}
