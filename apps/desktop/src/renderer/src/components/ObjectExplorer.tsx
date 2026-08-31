import { useCallback, useEffect, useState } from 'react'
import type {
  DatabaseInfo,
  SchemaInfo,
  TableInfo,
  TableMetadata,
  ViewInfo
} from '@nvag/contracts'
import { useAppStore } from '../state/store'

type NodeKind = 'server' | 'folder' | 'database' | 'schema' | 'table' | 'view'

interface TreeNode {
  key: string
  label: string
  icon: string
  kind: NodeKind
  children: TreeNode[]
  /** true zodra children zijn geladen (lazy) */
  loaded: boolean
  /** Voor tabel/view: geparste context (dubbelklik SELECT, klik details). */
  ref?: { connId: string; db: string; schema?: string; name: string }
}

interface DetailState {
  ref: NonNullable<TreeNode['ref']>
  kind: 'table' | 'view'
  meta: TableMetadata | null
  error?: string
}

export function ObjectExplorer(): React.JSX.Element {
  const connections = useAppStore((s) => s.connections)
  const openSessions = useAppStore((s) => s.openSessions)
  const openConnectionDialog = useAppStore((s) => s.openConnectionDialog)
  const openTableQuery = useAppStore((s) => s.openTableQuery)

  const [tree, setTree] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState<DetailState | null>(null)

  // Boom opbouwen uit connections (alleen servers + folders zichtbaar)
  useEffect(() => {
    const nodes: TreeNode[] = connections.map((conn) => ({
      key: `conn:${conn.id}`,
      label: conn.name,
      icon: openSessions[conn.id] ? '🟢' : '⚪',
      kind: 'server',
      children: openSessions[conn.id]
        ? [{ key: `dbs:${conn.id}`, label: 'Databases', icon: '🗄️', kind: 'folder', children: [], loaded: false }]
        : [],
      loaded: !!openSessions[conn.id]
    }))
    setTree(nodes)
    setDetails(null)
  }, [connections, openSessions])

  const patchNode = useCallback((nodes: TreeNode[], key: string, fn: (n: TreeNode) => TreeNode): TreeNode[] => {
    return nodes.map((n) => {
      if (n.key === key) return fn(n)
      if (n.children.length > 0) return { ...n, children: patchNode(n.children, key, fn) }
      return n
    })
  }, [])

  const loadChildren = useCallback(
    async (node: TreeNode): Promise<void> => {
      let children: TreeNode[] = []
      const [, connId, dbName, schemaName] = node.key.split(':')

      if (node.kind === 'folder' && node.key.startsWith('dbs:')) {
        const dbs = await window.nvag.metadata.listDatabases(connId)
        children = dbs.map((d: DatabaseInfo) => ({
          key: `db:${connId}:${d.name}`,
          label: d.name,
          icon: '📁',
          kind: 'database',
          children: [],
          loaded: false
        }))
      } else if (node.kind === 'database') {
        const schemas = await window.nvag.metadata.listSchemas(connId, dbName)
        children = schemas.map((s: SchemaInfo) => ({
          key: `schema:${connId}:${dbName}:${s.name}`,
          label: s.name,
          icon: '📂',
          kind: 'schema',
          children: [],
          loaded: false
        }))
      } else if (node.kind === 'schema') {
        const [tables, views] = await Promise.all([
          window.nvag.metadata.listTables(connId, dbName, schemaName),
          window.nvag.metadata.listViews(connId, dbName, schemaName)
        ])
        children = [
          ...tables.map((t: TableInfo) => ({
            key: `table:${connId}:${dbName}:${schemaName}:${t.name}`,
            label: t.name,
            icon: '📋',
            kind: 'table' as const,
            children: [],
            loaded: true,
            ref: { connId, db: dbName, schema: schemaName, name: t.name }
          })),
          ...views.map((v: ViewInfo) => ({
            key: `view:${connId}:${dbName}:${schemaName}:${v.name}`,
            label: v.name,
            icon: '👁️',
            kind: 'view' as const,
            children: [],
            loaded: true,
            ref: { connId, db: dbName, schema: schemaName, name: v.name }
          }))
        ]
      }

      setTree((t) => patchNode(t, node.key, (n) => ({ ...n, children, loaded: true })))
    },
    [patchNode]
  )

  const toggle = async (node: TreeNode): Promise<void> => {
    if (node.kind === 'table' || node.kind === 'view') return
    const next = new Set(expanded)
    if (next.has(node.key)) {
      next.delete(node.key)
    } else {
      next.add(node.key)
      if (!node.loaded) await loadChildren(node)
    }
    setExpanded(next)
  }

  /** Klik op tabel/view: kolomdetails laden en tonen (SAL-11). */
  const showDetails = useCallback(async (node: TreeNode): Promise<void> => {
    if (!node.ref) return
    const kind = node.kind === 'view' ? 'view' : 'table'
    setDetails({ ref: node.ref, kind, meta: null })
    try {
      const meta = await window.nvag.metadata.getTableMetadata(
        node.ref.connId,
        node.ref.db,
        node.ref.schema ?? 'main',
        node.ref.name
      )
      setDetails({ ref: node.ref, kind, meta })
    } catch (err) {
      setDetails({ ref: node.ref, kind, meta: null, error: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const handleNodeClick = (node: TreeNode): void => {
    if (node.kind === 'table' || node.kind === 'view') {
      void showDetails(node)
      return
    }
    void toggle(node)
  }

  const handleNodeDoubleClick = (node: TreeNode): void => {
    if (node.kind === 'table' || node.kind === 'view') {
      // F0/SQLite: geen schema in de SELECT (main is default); zie SAL-11 claim
      if (node.ref) openTableQuery(node.ref.connId, node.ref.name)
      return
    }
    void toggle(node)
  }

  const renderNodes = (nodes: TreeNode[], depth: number): React.JSX.Element[] =>
    nodes.map((node) => {
      const isOpen = expanded.has(node.key)
      const expandable = node.kind !== 'table' && node.kind !== 'view'
      return (
        <div key={node.key}>
          <div
            className={`tree-node tree-${node.kind}`}
            style={{ paddingLeft: depth * 14 + 6 }}
            onClick={() => handleNodeClick(node)}
            onDoubleClick={() => handleNodeDoubleClick(node)}
            title={
              node.kind === 'table' || node.kind === 'view'
                ? 'Klik: kolomdetails · Dubbelklik: SELECT in nieuw tabblad'
                : node.kind === 'server'
                  ? 'Dubbelklik om te openen'
                  : node.label
            }
          >
            <span className="tree-arrow">{expandable ? (isOpen ? '▾' : '▸') : ''}</span>
            <span className="tree-icon">{node.icon}</span>
            <span className="tree-label">{node.label}</span>
          </div>
          {isOpen && node.children.length > 0 && (
            <div className="tree-children">{renderNodes(node.children, depth + 1)}</div>
          )}
        </div>
      )
    })

  return (
    <div className="object-explorer">
      <div className="panel-header">
        <span>Object Explorer</span>
        <button className="icon-btn" title="Nieuwe verbinding" onClick={() => openConnectionDialog('create')}>
          ➕
        </button>
      </div>
      <div className="tree">
        {tree.length === 0 && <div className="tree-empty">Geen verbindingen. Klik ➕ om er een toe te voegen.</div>}
        {renderNodes(tree, 0)}
      </div>
      {details && (
        <div className="tree-details">
          <div className="tree-details-header">
            <span>
              {details.kind === 'view' ? 'View' : 'Tabel'}: {details.ref.name}
            </span>
            <button className="icon-btn" title="Sluiten" onClick={() => setDetails(null)}>
              ✕
            </button>
          </div>
          {details.error ? (
            <div className="tree-details-error">⚠️ {details.error}</div>
          ) : details.meta ? (
            <div className="tree-details-body">
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
                  {details.meta.columns.map((c) => (
                    <tr key={c.name}>
                      <td>
                        {c.name}
                        {c.isPrimaryKey ? ' 🔑' : ''}
                        {c.isIdentity ? ' (identity)' : ''}
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
              <div className="details-meta">
                Rijen: {details.meta.rowCount ?? '—'} · Indexen: {details.meta.indexes.length} · FKs:{' '}
                {details.meta.foreignKeys.length} · Triggers: {details.meta.triggers.length}
              </div>
            </div>
          ) : (
            <div className="tree-details-loading">Bezig met laden…</div>
          )}
        </div>
      )}
    </div>
  )
}
