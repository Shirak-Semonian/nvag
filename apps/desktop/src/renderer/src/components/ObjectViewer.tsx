import { useEffect, useState } from 'react'
import type { DbObjectRef, ScriptKind, TableMetadata } from '@nvag/contracts'

export interface ObjectViewerSelection {
  connId: string
  db: string
  schema?: string
  name: string
  kind: 'table' | 'view'
}

type SectionId =
  | 'algemeen'
  | 'kolommen'
  | 'indexen'
  | 'foreignkeys'
  | 'constraints'
  | 'triggers'
  | 'afhankelijkheden'
  | 'definitie'

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'algemeen', label: 'Algemeen' },
  { id: 'kolommen', label: 'Kolommen' },
  { id: 'indexen', label: 'Indexen' },
  { id: 'foreignkeys', label: 'FKs' },
  { id: 'constraints', label: 'Constraints' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'afhankelijkheden', label: 'Afhankelijkheden' },
  { id: 'definitie', label: 'Definitie' }
]

export interface ObjectViewerProps {
  selection: ObjectViewerSelection
  onClose: () => void
  /** Script Object-actie: gegenereerde SQL naar een nieuwe querytab (F1-5). */
  onScript: (obj: DbObjectRef, kind: ScriptKind) => void
}

export function ObjectViewer({
  selection,
  onClose,
  onScript
}: ObjectViewerProps): React.JSX.Element {
  const [meta, setMeta] = useState<TableMetadata | null>(null)
  const [definition, setDefinition] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [section, setSection] = useState<SectionId>('algemeen')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(undefined)
    setMeta(null)
    setDefinition(null)
    setSection('algemeen')

    const obj: DbObjectRef = {
      type: selection.kind,
      database: selection.db,
      schema: selection.schema,
      name: selection.name
    }
    const metaP = window.nvag.metadata
      .getTableMetadata(selection.connId, selection.db, selection.schema ?? 'main', selection.name)
      .catch(() => null)
    const defP = window.nvag.metadata.getObjectDefinition(selection.connId, obj).catch(() => null)

    void Promise.all([metaP, defP]).then(([m, def]) => {
      if (cancelled) return
      setMeta(m)
      setDefinition(def)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [selection])

  const obj: DbObjectRef = {
    type: selection.kind,
    database: selection.db,
    schema: selection.schema,
    name: selection.name
  }
  const scriptKinds: ScriptKind[] =
    selection.kind === 'view' ? ['CREATE', 'SELECT'] : ['CREATE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']

  const metaSection = (): React.JSX.Element => {
    if (!meta) return <div className="tree-details-loading">Geen metadata beschikbaar.</div>

    switch (section) {
      case 'algemeen':
        return (
          <table className="details-table">
            <tbody>
              <tr>
                <th>Type</th>
                <td>{selection.kind === 'view' ? 'View' : 'Tabel'}</td>
              </tr>
              <tr>
                <th>Database</th>
                <td>{selection.db}</td>
              </tr>
              <tr>
                <th>Schema</th>
                <td>{selection.schema ?? '—'}</td>
              </tr>
              <tr>
                <th>Rijen</th>
                <td>{meta.rowCount ?? '—'}</td>
              </tr>
              <tr>
                <th>Kolommen</th>
                <td>{meta.columns.length}</td>
              </tr>
              <tr>
                <th>Indexen</th>
                <td>{meta.indexes.length}</td>
              </tr>
              <tr>
                <th>Foreign keys</th>
                <td>{meta.foreignKeys.length}</td>
              </tr>
              <tr>
                <th>Triggers</th>
                <td>{meta.triggers.length}</td>
              </tr>
            </tbody>
          </table>
        )
      case 'kolommen':
        return (
          <table className="details-table">
            <thead>
              <tr>
                <th>Kolom</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Default</th>
              </tr>
            </thead>
            <tbody>
              {meta.columns.map((c) => (
                <tr key={c.name}>
                  <td className="detail-col-name">
                    {c.name}
                    {c.isPrimaryKey ? ' 🔑' : ''}
                    {c.isIdentity ? ' (identity)' : ''}
                    {c.isComputed ? ' (berekend)' : ''}
                  </td>
                  <td>{c.dataType}</td>
                  <td>{c.nullable ? 'ja' : 'nee'}</td>
                  <td className={c.defaultValue == null ? 'cell-null' : ''}>
                    {c.defaultValue == null ? 'NULL' : String(c.defaultValue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      case 'indexen':
        return (
          <table className="details-table">
            <thead>
              <tr>
                <th>Naam</th>
                <th>Kolommen</th>
                <th>Uniek</th>
                <th>PK</th>
              </tr>
            </thead>
            <tbody>
              {meta.indexes.map((i) => (
                <tr key={i.name}>
                  <td className="detail-col-name">{i.name}</td>
                  <td>{i.columns.join(', ')}</td>
                  <td>{i.isUnique ? 'ja' : 'nee'}</td>
                  <td>{i.isPrimaryKey ? 'ja' : 'nee'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      case 'foreignkeys':
        return (
          <table className="details-table">
            <thead>
              <tr>
                <th>Naam</th>
                <th>Kolommen</th>
                <th>Referentie</th>
                <th>On Delete</th>
                <th>On Update</th>
              </tr>
            </thead>
            <tbody>
              {meta.foreignKeys.map((fk) => (
                <tr key={fk.name}>
                  <td className="detail-col-name">{fk.name}</td>
                  <td>{fk.columns.join(', ')}</td>
                  <td>
                    {fk.referencedSchema ? `${fk.referencedSchema}.` : ''}
                    {fk.referencedTable}({fk.referencedColumns.join(', ')})
                  </td>
                  <td>{fk.onDelete ?? '—'}</td>
                  <td>{fk.onUpdate ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      case 'constraints':
        return (
          <table className="details-table">
            <thead>
              <tr>
                <th>Naam</th>
                <th>Type</th>
                <th>Definitie</th>
              </tr>
            </thead>
            <tbody>
              {meta.constraints.map((c) => (
                <tr key={`${c.type}:${c.name}`}>
                  <td className="detail-col-name">{c.name}</td>
                  <td>{c.type}</td>
                  <td>{c.definition ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      case 'triggers':
        return meta.triggers.length === 0 ? (
          <div className="tree-details-loading">Geen triggers.</div>
        ) : (
          <ul className="object-viewer-list">
            {meta.triggers.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )
      case 'afhankelijkheden':
        return meta.dependencies.length === 0 ? (
          <div className="tree-details-loading">Geen afhankelijkheden.</div>
        ) : (
          <ul className="object-viewer-list">
            {meta.dependencies.map((d, i) => (
              <li key={`${d.direction}:${d.objectName}:${i}`}>
                {d.direction === 'depends-on' ? '→' : '←'}{' '}
                <span className="detail-col-name">{d.objectName}</span>{' '}
                <span className="muted">({d.objectType})</span>
              </li>
            ))}
          </ul>
        )
      case 'definitie':
        return definition ? (
          <pre className="object-viewer-definition">{definition}</pre>
        ) : (
          <div className="tree-details-loading">Geen definitie beschikbaar.</div>
        )
    }
  }

  return (
    <div className="object-viewer" data-testid="object-viewer">
      <div className="tree-details-header">
        <span className="table-detail-title">
          {selection.kind === 'view' ? 'View' : 'Tabel'}: {selection.name}
        </span>
        <button className="icon-btn" title="Sluiten" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="object-viewer-scriptbar" aria-label="Script als">
        {scriptKinds.map((kind) => (
          <button
            key={kind}
            className="script-btn"
            title={`Script als ${kind} → nieuwe querytab`}
            onClick={() => onScript(obj, kind)}
          >
            {kind}
          </button>
        ))}
      </div>

      <div className="object-viewer-tabs" role="tablist" aria-label="Objecteigenschappen">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={section === s.id}
            className={`object-viewer-tab ${section === s.id ? 'active' : ''}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="tree-details-body">
        {error && <div className="tree-details-error">⚠️ {error}</div>}
        {loading ? <div className="tree-details-loading">Bezig met laden…</div> : metaSection()}
      </div>
    </div>
  )
}
