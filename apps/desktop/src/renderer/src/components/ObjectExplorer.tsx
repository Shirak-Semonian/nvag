import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  DatabaseInfo,
  DbObjectRef,
  SchemaInfo,
  ScriptKind,
  TableInfo,
  ViewInfo
} from '@nvag/contracts'
import { useAppStore } from '../state/store'
import { ObjectViewer, type ObjectViewerSelection } from './ObjectViewer'
import { EnvBadge } from './StatusBar'

type NodeKind = 'server' | 'folder' | 'database' | 'schema' | 'table' | 'view'

interface TreeNode {
  key: string
  label: string
  icon: string
  kind: NodeKind
  children: TreeNode[]
  /** true zodra children zijn geladen (lazy) */
  loaded: boolean
  /** Fout bij het laden van de children (SAL-29: tonen i.p.v. crash/leeg). */
  error?: string
  /** Voor tabel/view: geparste context (dubbelklik SELECT, klik details). */
  ref?: { connId: string; db: string; schema?: string; name: string }
  /** Omgeving van de server-connectie (F1-8: kleurbadge in object explorer). */
  environment?: string
}

export function ObjectExplorer(): React.JSX.Element {
  const connections = useAppStore((s) => s.connections)
  const openSessions = useAppStore((s) => s.openSessions)
  const openConnectionDialog = useAppStore((s) => s.openConnectionDialog)
  const openTableQuery = useAppStore((s) => s.openTableQuery)
  const openTableDataTab = useAppStore((s) => s.openTableDataTab)
  // SAL-31: AdminDialog verhoogt dit signaal na CREATE/DROP DATABASE zodat
  // de databaselijst automatisch opnieuw wordt opgehaald.
  const dbListRevision = useAppStore((s) => s.dbListRevision)

  const [tree, setTree] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState<ObjectViewerSelection | null>(null)
  /** Lijst-refresh bezig (SAL-31: knop toont spinner, blokkeert dubbelklik). */
  const [refreshing, setRefreshing] = useState(false)
  /** Meest recente boom voor refreshDatabases (stable callback). */
  const treeRef = useRef<TreeNode[]>([])
  useEffect(() => {
    treeRef.current = tree
  }, [tree])

  // SAL-31: refresh-knop alleen bruikbaar wanneer er minstens één open sessie
  // is (alleen dan bestaat een dbs:-folder in de boom).
  const hasOpenDbFolders = tree.some((n) => n.children.some((c) => c.key.startsWith('dbs:')))

  // Boom opbouwen uit connections (alleen servers + folders zichtbaar)
  useEffect(() => {
    const nodes: TreeNode[] = connections.map((conn) => ({
      key: `conn:${conn.id}`,
      label: conn.name,
      icon: openSessions[conn.id] ? '🟢' : '⚪',
      kind: 'server',
      environment: conn.environment,
      children: openSessions[conn.id]
        ? [{ key: `dbs:${conn.id}`, label: 'Databases', icon: '🗄️', kind: 'folder', children: [], loaded: false }]
        : [],
      loaded: !!openSessions[conn.id]
    }))
    setTree(nodes)
    setSelection(null)
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

      try {
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
      } catch (err) {
        // SAL-29: een metadata-fout (bijv. SQL Server: geen toegang tot de
        // database) is geen crash — toon de fout in de boom, de rest van de
        // boom blijft bruikbaar.
        const text = err instanceof Error ? err.message : String(err)
        setTree((t) =>
          patchNode(t, node.key, (n) => ({
            ...n,
            children: [],
            loaded: true,
            error: `Kan ${node.kind === 'database' ? "schema's" : node.kind === 'schema' ? 'objecten' : 'gegevens'} niet laden: ${text}`
          }))
        )
        return
      }

      setTree((t) => patchNode(t, node.key, (n) => ({ ...n, children, loaded: true, error: undefined })))
    },
    [patchNode]
  )

  /**
   * SAL-31: haalt de databaselijst van alle open verbindingen opnieuw op
   * (verse query, geen cache). Gebruikt treeRef zodat de callback stabiel is
   * en ook vanuit de dbListRevision-effect zonder loopeffecten draait.
   */
  const refreshDatabases = useCallback(async (): Promise<void> => {
    const folderNodes: TreeNode[] = []
    const collect = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        if (n.kind === 'folder' && n.key.startsWith('dbs:')) folderNodes.push(n)
        if (n.children.length > 0) collect(n.children)
      }
    }
    collect(treeRef.current)
    if (folderNodes.length === 0) return
    setRefreshing(true)
    try {
      // Fouten per folder tonen via de SAL-29-foutweergave in de boom
      // (loadChildren vangt ze af); de rest van de boom blijft bruikbaar.
      await Promise.all(folderNodes.map((n) => loadChildren(n)))
    } finally {
      setRefreshing(false)
    }
  }, [loadChildren])

  // SAL-31: automatische refresh na CREATE/DROP DATABASE via de Admin-knop.
  useEffect(() => {
    if (dbListRevision > 0) void refreshDatabases()
  }, [dbListRevision, refreshDatabases])

  const toggle = async (node: TreeNode): Promise<void> => {
    if (node.kind === 'table' || node.kind === 'view') return
    const next = new Set(expanded)
    if (next.has(node.key)) {
      next.delete(node.key)
    } else {
      next.add(node.key)
      // SAL-30: bij (her)uitklappen van een lazy node altijd de actuele lijst
      // ophalen. Een node die eerder is geladen (loaded=true) kan stale zijn
      // na DDL via de Admin-knop (bijv. CREATE DATABASE); de metadata-services
      // cachen niet, dus een verse query toont een nieuwe database direct.
      // Server-nodes slaan we over: hun children (Databases-folder) komen uit
      // de sessie-state, niet uit metadata.
      if (node.kind === 'folder' || node.kind === 'database' || node.kind === 'schema') {
        await loadChildren(node)
      }
    }
    setExpanded(next)
  }

  /** Klik op tabel/view: Object Viewer openen met eigenschappen per type (F1-5). */
  const showViewer = useCallback((node: TreeNode): void => {
    if (!node.ref) return
    const kind = node.kind === 'view' ? 'view' : 'table'
    setSelection({ connId: node.ref.connId, db: node.ref.db, schema: node.ref.schema, name: node.ref.name, kind })
  }, [])

  /** Script Object (F1-5): genereer SQL en open een nieuwe querytab. */
  const handleScript = useCallback((obj: DbObjectRef, kind: ScriptKind): void => {
    const { connId } = selection ?? { connId: null }
    if (!connId) return
    void useAppStore.getState().openScriptTab(connId, obj, kind)
  }, [selection])

  const handleNodeClick = (node: TreeNode): void => {
    if (node.kind === 'table' || node.kind === 'view') {
      showViewer(node)
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
            {node.kind === 'table' && node.ref && (
              <button
                className="tree-action"
                title="Tabelgegevens bekijken/bewerken (F2-1, eis 8)"
                onClick={(e) => {
                  e.stopPropagation()
                  openTableDataTab(node.ref!.connId, node.ref!.db, node.ref!.schema ?? 'main', node.ref!.name)
                }}
              >
                ▦
              </button>
            )}
            {node.environment && <EnvBadge environment={node.environment} />}
          </div>
          {isOpen && node.children.length > 0 && (
            <div className="tree-children">{renderNodes(node.children, depth + 1)}</div>
          )}
          {isOpen && node.error && <div className="tree-error">{node.error}</div>}
        </div>
      )
    })

  return (
    <div className="object-explorer">
      <div className="panel-header">
        <span>Object Explorer</span>
        <div className="panel-actions">
          <button
            className={`icon-btn ${refreshing ? 'spin' : ''}`}
            title={
              refreshing
                ? 'Bezig met vernieuwen…'
                : hasOpenDbFolders
                  ? 'Vernieuwen (databaselijst opnieuw ophalen)'
                  : 'Vernieuwen (open eerst een verbinding)'
            }
            aria-label="Databases vernieuwen"
            disabled={!hasOpenDbFolders || refreshing}
            onClick={() => void refreshDatabases()}
          >
            ⟳
          </button>
          <button className="icon-btn" title="Nieuwe verbinding" onClick={() => openConnectionDialog('create')}>
            ➕
          </button>
        </div>
      </div>
      <div className="tree">
        {tree.length === 0 && <div className="tree-empty">Geen verbindingen. Klik ➕ om er een toe te voegen.</div>}
        {renderNodes(tree, 0)}
      </div>
      {selection && (
        <ObjectViewer
          selection={selection}
          onClose={() => setSelection(null)}
          onScript={handleScript}
        />
      )}
    </div>
  )
}
