import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AdminActionResult,
  ConstraintInfo,
  DatabaseInfo,
  DbObjectRef,
  IndexInfo,
  ProviderCapabilities,
  SchemaInfo,
  ScriptKind,
  SqlDialectId,
  TableInfo,
  ViewInfo
} from '@nvag/contracts'
import { buildCreateDatabase, buildDrop, quoteQualifiedName } from '@nvag/sql-dialect'
import { useAppStore, type AdminDialogTab } from '../state/store'
import { ObjectViewer, type ObjectViewerSelection } from './ObjectViewer'
import { EnvBadge } from './StatusBar'
import { ConfirmDialog } from './ConfirmDialog'
import {
  DatabasePropertiesDialog,
  ObjectDefinitionDialog,
  type DatabasePropertiesState,
  type ObjectDefinitionState
} from './ObjectPropertiesDialogs'
import {
  ChevronIcon,
  DataIcon,
  NewQueryIcon,
  OBJECT_ICONS,
  PropertiesIcon,
  RefreshIcon
} from './ObjectIcons'

/**
 * Object Explorer (SAL-32): SSMS-achtige hiërarchie.
 *
 * Server → Databases → Database → objectfolders:
 *   Tables, Views, Synonyms, Programmability (Stored Procedures, Functions,
 *   Database Triggers), Security (Users, Roles, Schemas), Sequences.
 * Tabel-nodes klappen uit naar Columns / Keys / Constraints / Triggers /
 * Indexes (via getTableMetadata). Refresh per niveau + contextmenu.
 * Alle lazy nodes worden bij (her)uitklappen opnieuw opgehaald (SAL-30),
 * zodat nieuwe/verwijderde objecten zonder app-herstart verschijnen.
 */

type NodeKind =
  | 'server'
  | 'folder'
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'procedure'
  | 'function'
  | 'trigger'
  | 'sequence'
  | 'synonym'
  | 'user'
  | 'role'
  | 'column'
  | 'key'
  | 'constraint'
  | 'index'

/** Objectfolders onder een database (folderId → label + kind). */
const DB_FOLDERS: { id: string; label: string; icon: string }[] = [
  { id: 'tables', label: 'Tables', icon: 'table' },
  { id: 'views', label: 'Views', icon: 'view' },
  { id: 'synonyms', label: 'Synonyms', icon: 'synonym' },
  { id: 'procs', label: 'Stored Procedures', icon: 'procedure' },
  { id: 'funcs', label: 'Functions', icon: 'function' },
  { id: 'triggers', label: 'Database Triggers', icon: 'trigger' },
  { id: 'users', label: 'Users', icon: 'user' },
  { id: 'roles', label: 'Roles', icon: 'role' },
  { id: 'schemas', label: 'Schemas', icon: 'schema' },
  { id: 'sequences', label: 'Sequences', icon: 'sequence' }
]

const PROGRAMMABILITY_FOLDERS = ['procs', 'funcs', 'triggers']
const SECURITY_FOLDERS = ['users', 'roles', 'schemas']

interface NodeCtx {
  connId: string
  db?: string
  schema?: string
  table?: string
  name?: string
  folderId?: string
}

interface TreeNode {
  key: string
  label: string
  kind: NodeKind
  children: TreeNode[]
  /** true zodra children zijn geladen (lazy). */
  loaded: boolean
  /** Fout bij het laden van de children (SAL-29: tonen i.p.v. crash/leeg). */
  error?: string
  ctx?: NodeCtx
  /** Omgeving van de server-connectie (F1-8: kleurbadge). */
  environment?: string
  /** Secundaire tekst (schema-suffix, type, detail). */
  detail?: string
  /** Objectreferentie voor viewer/script (tabel/view). */
  ref?: { connId: string; db: string; schema?: string; name: string; kind: 'table' | 'view' }
  /** SAL-43: server-node heeft een open sessie (statusindicator ⚪/🟢-equivalent). */
  connected?: boolean
}

interface MenuItem {
  label: string
  icon?: React.ReactNode
  action?: () => void
  danger?: boolean
  separator?: boolean
  /** Niet-ondersteund/vergrendeld item (SAL-34). */
  disabled?: boolean
  title?: string
}

interface ContextMenuState {
  x: number
  y: number
  node: TreeNode
  items: MenuItem[]
}

/** Destructieve DROP-actie die op expliciete bevestiging wacht (SAL-34). */
type DropTarget =
  | { kind: 'database'; connId: string; db: string; sql: string }
  | { kind: 'table'; connId: string; db: string; schema: string; table: string; sql: string }
  | { kind: 'view'; connId: string; db: string; schema: string; view: string; sql: string }
  | { kind: 'schema'; connId: string; db: string; schema: string; sql: string }

interface DropConfirmState {
  target: DropTarget
  /** Titel van de bevestigingsdialoog. */
  label: string
  /** Guard-redenen (environment-safety) na een eerste geblokkeerde poging. */
  reasons?: string[]
  /** Fout van de backend. */
  error?: string | null
  /** Bezig met uitvoeren (knop disabled). */
  busy: boolean
  /** Bevestiging al gegeven (heruitvoering met confirmed: true). */
  confirmed: boolean
}

/** Standaard-schema per dialect (voor de schema-suffix in de boom). */
const DEFAULT_SCHEMA: Record<string, string> = {
  tsql: 'dbo',
  sqlite: 'main',
  postgres: 'public'
}

function schemaSuffix(schema: string | undefined, providerId: string | undefined): string | undefined {
  if (!schema) return undefined
  if (providerId && DEFAULT_SCHEMA[providerId] === schema) return undefined
  return schema
}

/** SAL-34: dialect-correcte CALL/EXEC/SELECT voor het uitvoeren van een routine. */
function buildRoutineCall(
  dialect: SqlDialectId,
  kind: 'procedure' | 'function',
  schema: string | undefined,
  name: string
): string {
  const qualified = quoteQualifiedName(dialect, schema || null, name)
  if (kind === 'function' && (dialect === 'tsql' || dialect === 'postgres')) {
    return `SELECT ${qualified}();`
  }
  if (dialect === 'tsql') return `EXEC ${qualified};`
  return `CALL ${qualified}();`
}

export function ObjectExplorer(): React.JSX.Element {
  const connections = useAppStore((s) => s.connections)
  const openSessions = useAppStore((s) => s.openSessions)
  const openConnectionDialog = useAppStore((s) => s.openConnectionDialog)
  const openTableQuery = useAppStore((s) => s.openTableQuery)
  const openTableDataTab = useAppStore((s) => s.openTableDataTab)
  // SAL-43: sessie voor een opgeslagen verbinding openen (dubbelklik/"Verbinding maken").
  const openSavedConnection = useAppStore((s) => s.openSavedConnection)
  // SAL-31: AdminDialog verhoogt dit signaal na CREATE/DROP DATABASE.
  const dbListRevision = useAppStore((s) => s.dbListRevision)
  // SAL-32: AdminDialog verhoogt dit signaal na DDL op database-objecten.
  const dbObjectsRevision = useAppStore((s) => s.dbObjectsRevision)

  const [tree, setTree] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [selection, setSelection] = useState<ObjectViewerSelection | null>(null)
  /** Lijst-refresh bezig (SAL-31). */
  const [refreshing, setRefreshing] = useState(false)
  /** Nodes waarvan de children momenteel worden geladen (spinner). */
  const [loadingKeys, setLoadingKeys] = useState<Set<string>>(new Set())
  /** Contextmenu (SAL-32). */
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  /** SAL-34: destructieve actie die op bevestiging wacht. */
  const [confirm, setConfirm] = useState<DropConfirmState | null>(null)
  /** SAL-34: eigenschappen-dialoog van een database. */
  const [dbProps, setDbProps] = useState<DatabasePropertiesState | null>(null)
  /** SAL-34: eigenschappen-dialoog (definitie) van procedure/function/trigger. */
  const [objProps, setObjProps] = useState<ObjectDefinitionState | null>(null)
  /** SAL-34: korte melding (drop-succes/fout, script gegenereerd). */
  const [notice, setNotice] = useState<{ text: string; kind: 'success' | 'error' | 'info' } | null>(null)
  /** Capabilities per verbinding (SAL-32: folder-gating). */
  const [capsByConn, setCapsByConn] = useState<Record<string, ProviderCapabilities>>({})

  /** Meest recente boom voor stable callbacks. */
  const treeRef = useRef<TreeNode[]>([])
  useEffect(() => {
    treeRef.current = tree
  }, [tree])
  const expandedRef = useRef<Set<string>>(expanded)
  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])
  const capsRef = useRef(capsByConn)
  useEffect(() => {
    capsRef.current = capsByConn
  }, [capsByConn])

  const hasOpenDbFolders = tree.some((n) => n.children.some((c) => c.key.startsWith('dbs:')))

  /**
   * Commits boom + treeRef synchroon (geen effect-lag): async flows (toggle,
   * runLoader, refresh) lezen treeRef kort na een update; een laggende effect
   * ref zou een stale boom opleveren en race-condities veroorzaken.
   */
  const commitTree = useCallback((updater: (prev: TreeNode[]) => TreeNode[]): void => {
    const next = updater(treeRef.current)
    treeRef.current = next
    setTree(next)
  }, [])

  /** Commits expanded + expandedRef synchroon (zelfde reden als commitTree). */
  const commitExpanded = useCallback((next: Set<string>): void => {
    expandedRef.current = next
    setExpanded(next)
  }, [])

  // Boom opbouwen uit connections (alleen servers + folders zichtbaar).
  useEffect(() => {
    const nodes: TreeNode[] = connections.map((conn) => {
      const open = !!openSessions[conn.id]
      return {
        key: `conn:${conn.id}`,
        label: conn.name,
        kind: 'server',
        environment: conn.environment,
        ctx: { connId: conn.id },
        // SAL-43: connected-flag stuurt de statusindicator + contextmenu
        // (Verbinding verbreken vs. Verbinding maken).
        connected: open,
        children: open
          ? [{ key: `dbs:${conn.id}`, label: 'Databases', kind: 'folder', children: [], loaded: false, ctx: { connId: conn.id } }]
          : [],
        loaded: open
      }
    })
    commitTree(() => nodes)
    setSelection(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections, openSessions])

  // SAL-32: capabilities per open verbinding ophalen (folder-gating).
  useEffect(() => {
    for (const conn of connections) {
      if (!openSessions[conn.id]) continue
      if (capsRef.current[conn.id]) continue
      window.nvag.admin
        .capabilities(conn.id)
        .then((caps) => setCapsByConn((prev) => (prev[conn.id] ? prev : { ...prev, [conn.id]: caps })))
        .catch(() => {
          // zonder capabilities: universele folders tonen
        })
    }
  }, [connections, openSessions])

  const patchNode = useCallback((nodes: TreeNode[], key: string, fn: (n: TreeNode) => TreeNode): TreeNode[] => {
    return nodes.map((n) => {
      if (n.key === key) return fn(n)
      if (n.children.length > 0) return { ...n, children: patchNode(n.children, key, fn) }
      return n
    })
  }, [])

  /** Zet een node in/uit loading en voert een loader uit; past de boom aan. */
  const runLoader = useCallback(
    async (node: TreeNode, loader: () => Promise<TreeNode[]>, errorLabel: string): Promise<void> => {
      setLoadingKeys((s) => new Set(s).add(node.key))
      try {
        const children = await loader()
        commitTree((t) => patchNode(t, node.key, (n) => ({ ...n, children, loaded: true, error: undefined })))
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        commitTree((t) =>
          patchNode(t, node.key, (n) => ({
            ...n,
            children: [],
            loaded: true,
            error: `Kan ${errorLabel} niet laden: ${text}`
          }))
        )
      } finally {
        setLoadingKeys((s) => {
          const next = new Set(s)
          next.delete(node.key)
          return next
        })
      }
    },
    [commitTree, patchNode]
  )

  const ensureCaps = useCallback(async (connId: string): Promise<ProviderCapabilities | undefined> => {
    if (capsRef.current[connId]) return capsRef.current[connId]
    try {
      const caps = await window.nvag.admin.capabilities(connId)
      setCapsByConn((prev) => ({ ...prev, [connId]: caps }))
      return caps
    } catch {
      return undefined
    }
  }, [])

  /** SAL-34: korte melding onderaan de Object Explorer (auto-dismiss). */
  const noticeTimer = useRef<number | null>(null)
  const showNotice = useCallback((text: string, kind: 'success' | 'error' | 'info'): void => {
    setNotice({ text, kind })
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000)
  }, [])

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    }
  }, [])

  /**
   * SAL-43: "Verbinding verbreken" uit het contextmenu. Sluit de sessie en
   * geeft altijd terugkoppeling: bij succes verdwijnen de databases/children
   * direct (boom-rebuild) + een bevestiging; bij een al gesloten verbinding
   * een melding (geen stille no-op); bij een falende close-IPC een foutmelding.
   */
  const handleDisconnect = useCallback(
    async (connId: string, label: string): Promise<void> => {
      try {
        const result = await useAppStore.getState().closeSession(connId)
        if (!result.closed) {
          showNotice(`Deze verbinding (${label}) is al gesloten.`, 'info')
          return
        }
        if (result.error) {
          showNotice(`Verbinding (${label}) gesloten, maar het sluiten gaf een fout: ${result.error}`, 'error')
          return
        }
        showNotice(`Verbinding (${label}) verbroken.`, 'success')
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        showNotice(`Verbinding verbreken mislukt: ${text}`, 'error')
      }
    },
    [showNotice]
  )

  /** SAL-43: "Verbinding maken" op een gesloten server-node (openSaved, vault-secret). */
  const handleConnect = useCallback(
    async (connId: string, label: string): Promise<void> => {
      try {
        await openSavedConnection(connId)
        showNotice(`Verbinding (${label}) geopend.`, 'success')
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        showNotice(`Verbinding maken mislukt: ${text}`, 'error')
      }
    },
    [openSavedConnection, showNotice]
  )

  /** SAL-34: start een destructieve DROP met bevestigingsdialoog. */
  const startDrop = useCallback((target: DropTarget, label: string): void => {
    setMenu(null)
    setConfirm({ target, label, busy: false, confirmed: false })
  }, [])

  /**
   * Voert de bevestigde DROP uit. De eerste poging gaat zonder `confirmed`
   * door de environment-safety-guard (F2-3): bij een confirm-blokkade toont de
   * dialoog de redenen en wordt de actie pas na een tweede, expliciete
   * bevestiging opnieuw uitgevoerd met `confirmed: true`. Annuleren doet nooit
   * iets destructiefs.
   */
  const runDrop = useCallback(
    async (state: DropConfirmState): Promise<void> => {
      const t = state.target
      setConfirm({ ...state, busy: true, error: null })
      try {
        let result: AdminActionResult
        switch (t.kind) {
          case 'database':
            result = await window.nvag.admin.dropDatabase(t.connId, t.db, state.confirmed)
            break
          case 'table':
            result = await window.nvag.admin.dropTable(t.connId, t.db, t.schema, t.table, state.confirmed)
            break
          case 'view':
            result = await window.nvag.admin.dropView(t.connId, t.db, t.schema, t.view, state.confirmed)
            break
          case 'schema':
            result = await window.nvag.admin.dropSchema(t.connId, t.db, t.schema, state.confirmed)
            break
        }
        if (!result.ok && result.blocked && result.blocked.length > 0) {
          // guard-blokkade: redenen tonen; volgende poging is expliciet bevestigd.
          setConfirm({ ...state, busy: false, reasons: result.blocked, confirmed: true })
          return
        }
        setConfirm(null)
        if (t.kind === 'database') {
          // SAL-31-signaal: Object Explorer + database-dropdown herladen.
          useAppStore.getState().bumpDbListRevision()
          showNotice(`Database '${t.db}' verwijderd.`, 'success')
        } else {
          // SAL-32-signaal: geopende objectfolders herladen.
          useAppStore.getState().bumpDbObjectsRevision()
          const name = t.kind === 'table' ? t.table : t.kind === 'view' ? t.view : t.schema
          showNotice(`'${name}' verwijderd.`, 'success')
        }
      } catch (err) {
        setConfirm({ ...state, busy: false, error: err instanceof Error ? err.message : String(err) })
      }
    },
    [showNotice]
  )

  const buildDatabaseFolders = useCallback(
    async (connId: string, db: string): Promise<TreeNode[]> => {
      const caps = await ensureCaps(connId)
      const folders: TreeNode[] = []
      const mkFolder = (id: string, label: string): TreeNode => ({
        key: `f:${connId}:${db}:${id}`,
        label,
        kind: 'folder',
        children: [],
        loaded: false,
        ctx: { connId, db, folderId: id }
      })
      folders.push(mkFolder('tables', 'Tables'))
      folders.push(mkFolder('views', 'Views'))
      if (caps?.supportsSynonyms) folders.push(mkFolder('synonyms', 'Synonyms'))
      folders.push(mkFolder('programmability', 'Programmability'))
      folders.push(mkFolder('security', 'Security'))
      if (caps?.supportsSequences) folders.push(mkFolder('sequences', 'Sequences'))
      // Programmability- en Security-folder krijgen hun subfolders direct mee
      // (structureel; de inhoud wordt per subfolder lazy geladen).
      const programmability = folders.find((f) => f.key.endsWith(':programmability'))
      if (programmability) {
        programmability.kind = 'folder'
        programmability.children = PROGRAMMABILITY_FOLDERS.map((id) => mkFolder(id, DB_FOLDERS.find((d) => d.id === id)!.label))
        programmability.loaded = true
      }
      const security = folders.find((f) => f.key.endsWith(':security'))
      if (security) {
        const sub = SECURITY_FOLDERS.filter((id) =>
          id === 'users' || id === 'roles' ? caps?.supportsUsersAndRoles : caps?.supportsSchemas
        ).map((id) => mkFolder(id, DB_FOLDERS.find((d) => d.id === id)!.label))
        security.children = sub
        security.loaded = true
      }
      return folders
    },
    [connections, ensureCaps]
  )

  const loadChildren = useCallback(
    async (node: TreeNode): Promise<TreeNode[]> => {
      const ctx = node.ctx
      if (!ctx?.connId) return []

      if (node.kind === 'folder' && node.key.startsWith('dbs:')) {
        const dbs = await window.nvag.metadata.listDatabases(ctx.connId)
        return dbs.map((d: DatabaseInfo) => ({
          key: `db:${ctx.connId}:${d.name}`,
          label: d.name,
          kind: 'database' as const,
          children: [],
          loaded: false,
          ctx: { connId: ctx.connId, db: d.name }
        }))
      }

      if (node.kind === 'database' && ctx.db) {
        return buildDatabaseFolders(ctx.connId, ctx.db)
      }

      if (node.kind === 'folder' && ctx.folderId && ctx.db) {
        // Programmability/Security en tabel-subfolders (Columns/Keys/...) zijn
        // structureel voorgebouwd — geen netwerk-call bij (her)uitklappen.
        if (['programmability', 'security'].includes(ctx.folderId) || ctx.table) return node.children
        return loadObjectFolder(ctx.connId, ctx.db, ctx.folderId)
      }

      if (node.kind === 'table' && ctx.db && ctx.schema && ctx.name) {
        return loadTableSubfolders(ctx.connId, ctx.db, ctx.schema, ctx.name)
      }

      return []
    },
    [buildDatabaseFolders]
  )

  /** Laadt de inhoud van één objectfolder (Tables/Views/.../Sequences). */
  const loadObjectFolder = useCallback(
    async (connId: string, db: string, folderId: string): Promise<TreeNode[]> => {
      const conn = connections.find((c) => c.id === connId)
      const providerId = conn?.providerId
      const mkLeaf = (
        kind: NodeKind,
        label: string,
        name: string,
        schema?: string,
        extra?: Partial<TreeNode>
      ): TreeNode => ({
        key: `o:${connId}:${db}:${kind}:${name}`,
        label,
        kind,
        children: [],
        loaded: true,
        detail: schemaSuffix(schema, providerId),
        ctx: { connId, db, schema, name },
        ...extra
      })

      switch (folderId) {
        case 'tables': {
          const tables = await window.nvag.metadata.listTables(connId, db)
          return tables.map((t: TableInfo) =>
            mkLeaf('table', t.name, t.name, t.schema, {
              key: `t:${connId}:${db}:${t.schema ?? 'main'}:${t.name}`,
              ref: { connId, db, schema: t.schema ?? 'main', name: t.name, kind: 'table' as const }
            })
          )
        }
        case 'views': {
          const views = await window.nvag.metadata.listViews(connId, db)
          return views.map((v: ViewInfo) =>
            mkLeaf('view', v.name, v.name, v.schema, {
              ref: { connId, db, schema: v.schema ?? 'main', name: v.name, kind: 'view' as const }
            })
          )
        }
        case 'synonyms': {
          const syns = await window.nvag.metadata.listSynonyms(connId, db)
          return syns.map((s) => mkLeaf('synonym', s.name, s.name, s.schema, { detail: s.baseObject }))
        }
        case 'procs': {
          const procs = await window.nvag.metadata.listProcedures(connId, db)
          return procs.map((p) => mkLeaf('procedure', p.name, p.name, p.schema))
        }
        case 'funcs': {
          const funcs = await window.nvag.metadata.listFunctions(connId, db)
          return funcs.map((f) => mkLeaf('function', f.name, f.name, f.schema))
        }
        case 'triggers': {
          const trigs = await window.nvag.metadata.listTriggers(connId, db)
          return trigs.map((t) => mkLeaf('trigger', t.name, t.name, t.schema, { detail: t.table }))
        }
        case 'users': {
          const users = await window.nvag.metadata.listUsers(connId, db)
          return users.map((u) => mkLeaf('user', u.name, u.name))
        }
        case 'roles': {
          const roles = await window.nvag.metadata.listRoles(connId, db)
          return roles.map((r) => mkLeaf('role', r.name, r.name))
        }
        case 'schemas': {
          const schemas = await window.nvag.metadata.listSchemas(connId, db)
          return schemas.map((s: SchemaInfo) => mkLeaf('schema', s.name, s.name))
        }
        case 'sequences': {
          const seqs = await window.nvag.metadata.listSequences(connId, db)
          return seqs.map((s) => mkLeaf('sequence', s.name, s.name, s.schema))
        }
        default:
          return []
      }
    },
    [connections]
  )

  /** Tabel-node → subfolders Columns / Keys / Constraints / Triggers / Indexes. */
  const loadTableSubfolders = useCallback(
    async (connId: string, db: string, schema: string, table: string): Promise<TreeNode[]> => {
      const meta = await window.nvag.metadata.getTableMetadata(connId, db, schema, table)
      const mkSub = (subId: string, label: string, children: TreeNode[]): TreeNode => ({
        key: `s:${connId}:${db}:${schema}:${table}:${subId}`,
        label,
        kind: 'folder',
        children,
        loaded: true,
        ctx: { connId, db, schema, table, folderId: subId }
      })
      const leaf = (kind: NodeKind, label: string, detail?: string): TreeNode => ({
        key: `c:${connId}:${db}:${schema}:${table}:${kind}:${label}`,
        label,
        kind,
        children: [],
        loaded: true,
        detail,
        ctx: { connId, db, schema, table, name: label }
      })

      const columns = meta.columns.map((c) =>
        leaf('column', c.name, `${c.dataType}${c.isPrimaryKey ? ' · PK' : ''}${c.nullable ? '' : ' · NOT NULL'}`)
      )

      const keys: TreeNode[] = []
      if (meta.primaryKey.length > 0) {
        keys.push(leaf('key', `PK_${table}`, `PRIMARY KEY (${meta.primaryKey.join(', ')})`))
      }
      for (const fk of meta.foreignKeys) {
        const ref = [fk.referencedSchema, fk.referencedTable].filter(Boolean).join('.')
        keys.push(leaf('key', fk.name, `→ ${ref} (${fk.columns.join(', ')})`))
      }

      const constraints = meta.constraints.map((c: ConstraintInfo) =>
        leaf('constraint', c.name, c.type)
      )

      const triggers = meta.triggers.map((t) => leaf('trigger', t))

      const indexes = meta.indexes.map((i: IndexInfo) =>
        leaf('index', i.name, `${i.isUnique ? 'UNIQUE' : ''}${i.isPrimaryKey ? ' · PK' : ''} (${i.columns.join(', ')})`.trim())
      )

      return [
        mkSub('columns', 'Columns', columns),
        mkSub('keys', 'Keys', keys),
        mkSub('constraints', 'Constraints', constraints),
        mkSub('triggers', 'Triggers', triggers),
        mkSub('indexes', 'Indexes', indexes)
      ]
    },
    []
  )

  /** Verwijdert alle afstammeling-keys uit de expanded-set (bij inklappen van een parent). */
  const removeDescendants = useCallback((node: TreeNode, set: Set<string>): void => {
    for (const c of node.children) {
      set.delete(c.key)
      removeDescendants(c, set)
    }
  }, [])

  const toggle = useCallback(
    async (node: TreeNode): Promise<void> => {
      if (node.kind === 'table' || node.kind === 'view') return
      const next = new Set(expandedRef.current)
      if (next.has(node.key)) {
        next.delete(node.key)
        // SAL-32: bij inklappen van een parent ook afstammelingen sluiten,
        // zodat heruitklappen altijd met verse (lege) folders begint.
        removeDescendants(node, next)
      } else {
        next.add(node.key)
        // SAL-30: bij (her)uitklappen van een lazy node altijd de actuele
        // lijst ophalen (verse query, geen cache). Server-nodes slaan we
        // over: hun children (Databases-folder) komen uit de sessie-state.
        if (node.kind === 'folder' || node.kind === 'database') {
          await runLoader(node, () => loadChildren(node), node.kind === 'database' ? "schema's" : 'gegevens')
        }
      }
      commitExpanded(next)
    },
    [commitExpanded, loadChildren, removeDescendants, runLoader]
  )

  /** Tabel via chevron uit-/inklappen (subfolders). */
  const toggleTable = useCallback(
    async (node: TreeNode): Promise<void> => {
      const next = new Set(expandedRef.current)
      if (next.has(node.key)) {
        next.delete(node.key)
        removeDescendants(node, next)
      } else {
        next.add(node.key)
        await runLoader(node, () => loadChildren(node), 'tabelmetagegevens')
      }
      commitExpanded(next)
    },
    [commitExpanded, loadChildren, removeDescendants, runLoader]
  )

  /**
   * Refresh op één niveau: children van de node opnieuw ophalen.
   * SAL-34: op database-niveau worden ook de geopende objectfolders eronder
   * opnieuw geladen, zodat nieuwe/gewijzigde/verwijderde objecten direct
   * zichtbaar worden (niet alleen de folderstructuur).
   */
  const refreshNode = useCallback(
    async (node: TreeNode): Promise<void> => {
      if (node.kind === 'server') {
        // Server-niveau: databaselijst van alle open verbindingen verversen.
        await refreshDatabases()
        return
      }
      if (node.kind === 'database') {
        // Eerst de geopende objectfolders onder deze database verzamelen
        // (vóór de herlading, want die vervangt de children-referenties).
        const descendants: TreeNode[] = []
        const visit = (nodes: TreeNode[]): void => {
          for (const n of nodes) {
            const isObjectFolder =
              n.kind === 'folder' && n.ctx?.folderId !== undefined && !['programmability', 'security'].includes(n.ctx.folderId)
            if (isObjectFolder && n.loaded && expandedRef.current.has(n.key)) descendants.push(n)
            if (n.children.length > 0) visit(n.children)
          }
        }
        visit(node.children)
        await runLoader(node, () => loadChildren(node), "schema's")
        await Promise.all(descendants.map((n) => runLoader(n, () => loadChildren(n), 'gegevens')))
        return
      }
      await runLoader(node, () => loadChildren(node), 'gegevens')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadChildren, runLoader]
  )

  /**
   * SAL-31: haalt de databaselijst van alle open verbindingen opnieuw op.
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
      await Promise.all(folderNodes.map((n) => runLoader(n, () => loadChildren(n), 'gegevens')))
    } finally {
      setRefreshing(false)
    }
  }, [loadChildren, runLoader])

  // SAL-31: automatische refresh na CREATE/DROP DATABASE via de Admin-knop.
  useEffect(() => {
    if (dbListRevision > 0) void refreshDatabases()
  }, [dbListRevision, refreshDatabases])

  // SAL-32: automatische refresh van geopende objectfolders na DDL via Admin.
  useEffect(() => {
    if (dbObjectsRevision === 0) return
    const targets: TreeNode[] = []
    const collect = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        const isObjectFolder =
          n.kind === 'folder' &&
          n.ctx?.folderId !== undefined &&
          !['programmability', 'security'].includes(n.ctx.folderId)
        if (isObjectFolder && n.loaded && expandedRef.current.has(n.key)) targets.push(n)
        if (n.children.length > 0) collect(n.children)
      }
    }
    collect(treeRef.current)
    if (targets.length === 0) return
    void Promise.all(targets.map((n) => runLoader(n, () => loadChildren(n), 'gegevens')))
  }, [dbObjectsRevision, loadChildren, runLoader])

  /** Klik op tabel/view: Object Viewer openen met eigenschappen per type (F1-5). */
  const showViewer = useCallback((node: TreeNode): void => {
    if (!node.ref) return
    setSelectedKey(node.key)
    setSelection({ connId: node.ref.connId, db: node.ref.db, schema: node.ref.schema, name: node.ref.name, kind: node.ref.kind })
  }, [])

  /** Script Object (F1-5): genereer SQL en open een nieuwe querytab. */
  const handleScript = useCallback(
    (connId: string, obj: DbObjectRef, kind: ScriptKind): void => {
      void useAppStore
        .getState()
        .openScriptTab(connId, obj, kind)
        .catch((err) => {
          showNotice(`Script genereren mislukt: ${err instanceof Error ? err.message : String(err)}`, 'error')
        })
    },
    [showNotice]
  )

  const handleNodeClick = (node: TreeNode): void => {
    if (node.kind === 'table' || node.kind === 'view') {
      showViewer(node)
      return
    }
    setSelectedKey(node.key)
    void toggle(node)
  }

  const handleNodeDoubleClick = (node: TreeNode): void => {
    if (node.kind === 'table' || node.kind === 'view') {
      if (node.ref) openTableQuery(node.ref.connId, node.ref.name, node.ref.schema)
      return
    }
    // SAL-43: dubbelklik op een gesloten server-node opent de sessie opnieuw
    // (title beloofde dit al; dit is ook de reconnect-flow ná "Verbinding
    // verbreken"). Bij een open server gedraagt dubbelklik zich als klik.
    if (node.kind === 'server' && node.ctx?.connId && !node.connected) {
      void handleConnect(node.ctx.connId, node.label)
      return
    }
    void toggle(node)
  }

  /** SAL-34: contextmenu-items per objecttype, gated per engine-capability. */
  const buildMenu = (node: TreeNode, caps: ProviderCapabilities | undefined): MenuItem[] => {
    const connId = node.ctx?.connId
    const db = node.ctx?.db
    const connName = connId ? connections.find((c) => c.id === connId)?.name : undefined
    const connLabel = connName ?? node.label
    const items: MenuItem[] = []
    const refreshItem: MenuItem = {
      label: 'Vernieuwen',
      icon: <RefreshIcon size={14} />,
      action: () => void refreshNode(node)
    }
    const newQueryItem = (database?: string): MenuItem => ({
      label: 'Nieuwe query',
      icon: <NewQueryIcon size={14} />,
      action: () => useAppStore.getState().addTab({ connectionId: connId, database })
    })
    const propertiesItem = (action: () => void): MenuItem => ({
      label: 'Eigenschappen',
      icon: <PropertiesIcon size={14} />,
      action
    })
    const disconnectItem: MenuItem = {
      label: 'Verbinding verbreken',
      action: () => {
        if (!connId) return
        void handleDisconnect(connId, connLabel)
      }
    }
    const connectItem: MenuItem = {
      label: 'Verbinding maken',
      action: () => {
        if (!connId) return
        void handleConnect(connId, connLabel)
      }
    }
    const dropItem = (label: string, action: () => void): MenuItem => ({
      label,
      danger: true,
      action
    })

    switch (node.kind) {
      case 'server':
        items.push(refreshItem)
        items.push({ separator: true, label: '' })
        items.push(newQueryItem())
        items.push({ separator: true, label: '' })
        // SAL-43: SSMS-achtig — gesloten server toont "Verbinding maken",
        // open server toont "Verbinding verbreken" (geen stille no-op op een
        // al gesloten verbinding; de optie die niets kan doen ontbreekt).
        if (connId && node.connected) items.push(disconnectItem)
        else if (connId && !node.connected) items.push(connectItem)
        break
      case 'database': {
        if (!connId || !db) break
        const dialect = caps?.dialect
        items.push(newQueryItem(db))
        items.push(refreshItem)
        items.push({ separator: true, label: '' })
        items.push(
          propertiesItem(() => {
            setDbProps({ connId, db })
            setMenu(null)
          })
        )
        // Scripts genereren: dialect-correct CREATE DATABASE in een nieuwe tab.
        items.push({
          label: 'Scripts genereren',
          action: () => {
            setMenu(null)
            if (!dialect) return
            const sql = buildCreateDatabase(dialect, db)
            useAppStore.getState().addTab({ sql, connectionId: connId, database: db, title: `${db} — CREATE` })
            showNotice(`CREATE DATABASE-script voor '${db}' gegenereerd.`, 'success')
          }
        })
        items.push({ separator: true, label: '' })
        if (caps?.supportsDdlAdmin) {
          items.push({
            label: 'Nieuwe objecten aanmaken…',
            action: () => {
              setMenu(null)
              useAppStore.getState().openAdminDialog(connId, 'database')
            }
          })
        }
        if (caps?.supportsBackupRestore) {
          items.push({
            label: 'Taken…',
            action: () => {
              setMenu(null)
              useAppStore.getState().openAdminDialog(connId, 'backup')
            }
          })
        }
        items.push(disconnectItem)
        if (caps?.supportsDdlAdmin) {
          items.push({ separator: true, label: '' })
          items.push(
            dropItem('Database verwijderen…', () =>
              startDrop({ kind: 'database', connId, db, sql: dialect ? buildDrop(dialect, 'DATABASE', db) : `DROP DATABASE ${db};` }, `Database '${db}' verwijderen`)
            )
          )
        }
        break
      }
      case 'folder': {
        const folderId = node.ctx?.folderId
        items.push(refreshItem)
        // Waar logisch "Nieuwe X aanmaken…" → AdminDialog op de juiste tab.
        const createActions: { folderId: string; label: string; tab: AdminDialogTab }[] = [
          { folderId: 'tables', label: 'Nieuwe tabel…', tab: 'table' },
          { folderId: 'views', label: 'Nieuwe view…', tab: 'view' },
          { folderId: 'schemas', label: 'Nieuw schema…', tab: 'schema' },
          { folderId: 'users', label: 'Nieuwe gebruiker…', tab: 'users' }
        ]
        const createAction = createActions.find((a) => a.folderId === folderId)
        const gated =
          folderId === 'schemas'
            ? (caps?.supportsSchemas ?? false) && (caps?.supportsDdlAdmin ?? false)
            : folderId === 'users'
              ? (caps?.supportsUsersAndRoles ?? false) && (caps?.supportsDdlAdmin ?? false)
              : caps?.supportsDdlAdmin ?? false
        if (createAction && connId && gated) {
          items.push({ separator: true, label: '' })
          items.push({
            label: createAction.label,
            action: () => {
              setMenu(null)
              useAppStore.getState().openAdminDialog(connId, createAction.tab)
            }
          })
        }
        break
      }
      case 'table': {
        const ref = node.ref
        if (!ref) break
        const obj: DbObjectRef = { type: 'table', database: ref.db, schema: ref.schema, name: ref.name }
        items.push(refreshItem)
        items.push({
          label: 'Tabelgegevens bekijken',
          icon: <DataIcon size={14} />,
          action: () => openTableDataTab(ref.connId, ref.db, ref.schema ?? 'main', ref.name)
        })
        items.push({
          label: 'Eigenschappen',
          icon: <PropertiesIcon size={14} />,
          action: () => showViewer(node)
        })
        items.push({ separator: true, label: '' })
        items.push({ label: 'Script Object als CREATE', action: () => handleScript(ref.connId, obj, 'CREATE') })
        items.push({ label: 'Script Object als SELECT', action: () => handleScript(ref.connId, obj, 'SELECT') })
        items.push({ label: 'Script Object als INSERT', action: () => handleScript(ref.connId, obj, 'INSERT') })
        items.push({ label: 'Script Object als UPDATE', action: () => handleScript(ref.connId, obj, 'UPDATE') })
        items.push({ label: 'Script Object als DELETE', action: () => handleScript(ref.connId, obj, 'DELETE') })
        items.push({ separator: true, label: '' })
        items.push({
          label: 'SELECT in nieuwe query',
          icon: <NewQueryIcon size={14} />,
          action: () => openTableQuery(ref.connId, ref.name, ref.schema)
        })
        if (caps?.supportsDdlAdmin) {
          items.push({ separator: true, label: '' })
          items.push(
            dropItem('Tabel verwijderen…', () =>
              startDrop(
                {
                  kind: 'table',
                  connId: ref.connId,
                  db: ref.db,
                  schema: ref.schema ?? 'main',
                  table: ref.name,
                  sql: caps.dialect ? buildDrop(caps.dialect, 'TABLE', ref.name, { schema: ref.schema ?? null }) : `DROP TABLE ${ref.name};`
                },
                `Tabel '${ref.name}' verwijderen`
              )
            )
          )
        }
        break
      }
      case 'view': {
        const ref = node.ref
        if (!ref) break
        const obj: DbObjectRef = { type: 'view', database: ref.db, schema: ref.schema, name: ref.name }
        items.push(refreshItem)
        items.push({
          label: 'Eigenschappen',
          icon: <PropertiesIcon size={14} />,
          action: () => showViewer(node)
        })
        items.push({ separator: true, label: '' })
        items.push({ label: 'Script Object als CREATE', action: () => handleScript(ref.connId, obj, 'CREATE') })
        items.push({ label: 'Script Object als SELECT', action: () => handleScript(ref.connId, obj, 'SELECT') })
        items.push({ separator: true, label: '' })
        items.push(newQueryItem(ref.db))
        if (caps?.supportsDdlAdmin) {
          items.push({ separator: true, label: '' })
          items.push(
            dropItem('View verwijderen…', () =>
              startDrop(
                {
                  kind: 'view',
                  connId: ref.connId,
                  db: ref.db,
                  schema: ref.schema ?? 'main',
                  view: ref.name,
                  sql: caps.dialect ? buildDrop(caps.dialect, 'VIEW', ref.name, { schema: ref.schema ?? null }) : `DROP VIEW ${ref.name};`
                },
                `View '${ref.name}' verwijderen`
              )
            )
          )
        }
        break
      }
      case 'procedure':
      case 'function':
      case 'trigger': {
        const type = node.kind === 'procedure' ? 'procedure' : node.kind === 'function' ? 'function' : 'trigger'
        const objName = node.ctx?.name
        const schema = node.ctx?.schema ?? 'dbo'
        const database = node.ctx?.db
        if (connId && objName && database) {
          const obj: DbObjectRef = { type, database, schema, name: objName }
          items.push({ label: 'Script Object als CREATE', action: () => handleScript(connId, obj, 'CREATE') })
          // Uitvoeren: dialect-correcte CALL/EXEC/SELECT in een nieuwe querytab.
          if (node.kind === 'procedure' || node.kind === 'function') {
            const routineKind: 'procedure' | 'function' = node.kind
            items.push({
              label: 'Uitvoeren…',
              icon: <NewQueryIcon size={14} />,
              action: () => {
                setMenu(null)
                const dialect = caps?.dialect ?? 'tsql'
                const sql = buildRoutineCall(dialect, routineKind, schema, objName)
                useAppStore.getState().addTab({ sql, connectionId: connId, database, title: `${objName} — uitvoeren` })
              }
            })
          }
          items.push(
            propertiesItem(() => {
              setMenu(null)
              setObjProps({ connId, db: database, schema, name: objName, kind: type })
            })
          )
        }
        break
      }
      case 'sequence':
      case 'synonym':
      case 'schema':
      case 'user':
      case 'role': {
        const objName = node.ctx?.name
        if (connId && objName && db) {
          items.push(newQueryItem(db))
          if (node.kind === 'schema' && caps?.supportsSchemas && caps?.supportsDdlAdmin) {
            items.push({ separator: true, label: '' })
            items.push(
              dropItem('Schema verwijderen…', () =>
                startDrop(
                  {
                    kind: 'schema',
                    connId,
                    db,
                    schema: objName,
                    sql: caps.dialect ? buildDrop(caps.dialect, 'SCHEMA', objName) : `DROP SCHEMA ${objName};`
                  },
                  `Schema '${objName}' verwijderen`
                )
              )
            )
          }
        }
        break
      }
      default:
        break
    }
    return items
  }

  const onContextMenu = async (e: React.MouseEvent, node: TreeNode): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    // Capability-gating up-to-date houden (SAL-34: opties per engine).
    const caps = node.ctx?.connId ? await ensureCaps(node.ctx.connId) : undefined
    const items = buildMenu(node, caps)
    if (items.length === 0) {
      setMenu(null)
      return
    }
    setSelectedKey(node.key)
    setMenu({ x: e.clientX, y: e.clientY, node, items })
  }

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    // Klik buiten de boom sluit het menu; een rechtsklik op een ándere
    // tree-node opent via onContextMenu een nieuw menu (niet sluiten).
    const onContext = (e: MouseEvent): void => {
      if (!(e.target instanceof Element) || !e.target.closest('.tree-node')) setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('contextmenu', onContext)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('contextmenu', onContext)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const renderNodes = useCallback(
    (nodes: TreeNode[], depth: number): React.JSX.Element[] =>
      nodes.map((node) => {
        const isOpen = expanded.has(node.key)
        const isLoading = loadingKeys.has(node.key)
        const expandable =
          node.kind !== 'view' &&
          node.kind !== 'schema' &&
          node.kind !== 'procedure' &&
          node.kind !== 'function' &&
          node.kind !== 'trigger' &&
          node.kind !== 'sequence' &&
          node.kind !== 'synonym' &&
          node.kind !== 'user' &&
          node.kind !== 'role' &&
          node.kind !== 'column' &&
          node.kind !== 'key' &&
          node.kind !== 'constraint' &&
          node.kind !== 'index'
        const Icon = OBJECT_ICONS[node.kind] ?? OBJECT_ICONS.folder
        const isSelected = selectedKey === node.key
        const showEmpty =
          isOpen &&
          node.loaded &&
          node.children.length === 0 &&
          (node.kind === 'folder' || node.kind === 'database')
        const showError = isOpen && node.error !== undefined
        const nodeTitle = nodeTitleFor(node)

        return (
          <div key={node.key}>
            <div
              className={`tree-node tree-${node.kind}${isSelected ? ' selected' : ''}`}
              style={{ paddingLeft: depth * 14 + 6 }}
              onClick={() => handleNodeClick(node)}
              onDoubleClick={() => handleNodeDoubleClick(node)}
              onContextMenu={(e) => onContextMenu(e, node)}
              title={nodeTitle}
              role="treeitem"
              aria-expanded={expandable ? isOpen : undefined}
              aria-selected={isSelected}
            >
              <span className={`tree-arrow${expandable ? ' clickable' : ''}`}>
                {isLoading ? (
                  <span className="tree-spinner" aria-label="Laden…" />
                ) : node.kind === 'table' ? (
                  // Tabel: rijklik opent de viewer — de chevron klapt de
                  // subobjecten (Columns/Keys/...) apart uit/in.
                  <button
                    className="tree-arrow-btn"
                    title={isOpen ? 'Subobjecten inklappen' : 'Subobjecten tonen (kolommen, keys, …)'}
                    aria-label={isOpen ? 'Tabel inklappen' : 'Tabel uitklappen'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void toggleTable(node)
                    }}
                  >
                    <ChevronIcon open={isOpen} />
                  </button>
                ) : expandable ? (
                  <ChevronIcon open={isOpen} />
                ) : null}
              </span>
              <span className="tree-icon">
                <Icon size={15} />
              </span>
              <span className="tree-label">{node.label}</span>
              {node.detail && <span className="tree-detail">{node.detail}</span>}
              {node.kind === 'table' && node.ref && (
                <button
                  className="tree-action"
                  title="Tabelgegevens bekijken/bewerken (F2-1, eis 8)"
                  onClick={(e) => {
                    e.stopPropagation()
                    openTableDataTab(node.ref!.connId, node.ref!.db, node.ref!.schema ?? 'main', node.ref!.name)
                  }}
                >
                  <DataIcon size={13} />
                </button>
              )}
              {(node.kind === 'database' ||
                (node.kind === 'folder' &&
                  node.ctx?.folderId !== undefined &&
                  !['programmability', 'security'].includes(node.ctx.folderId))) && (
                <button
                  className="tree-action tree-refresh-action"
                  title="Vernieuwen (actuele metadata ophalen)"
                  aria-label={`Vernieuwen ${node.label}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void refreshNode(node)
                  }}
                >
                  <RefreshIcon size={12} />
                </button>
              )}
              {node.kind === 'server' && (
                <span
                  className={`status-dot ${node.connected ? 'connected' : ''}`}
                  title={node.connected ? 'Verbonden' : 'Niet verbonden — dubbelklik om te verbinden'}
                />
              )}
              {node.environment && <EnvBadge environment={node.environment} />}
            </div>
            {isOpen && node.children.length > 0 && (
              <div className="tree-children">{renderNodes(node.children, depth + 1)}</div>
            )}
            {showEmpty && (
              <div className="tree-empty-child" style={{ paddingLeft: depth * 14 + 6 + 22 }}>
                Geen objecten
              </div>
            )}
            {showError && (
              <div className="tree-error" style={{ paddingLeft: depth * 14 + 6 + 22 }}>
                {node.error}
              </div>
            )}
          </div>
        )
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [expanded, loadingKeys, selectedKey, handleNodeClick, handleNodeDoubleClick, onContextMenu, openTableDataTab, toggleTable, refreshNode]
  )

  return (
    <div className="object-explorer" onContextMenu={(e) => e.preventDefault()}>
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
            <RefreshIcon size={14} />
          </button>
          <button className="icon-btn" title="Nieuwe verbinding" onClick={() => openConnectionDialog('create')}>
            ＋
          </button>
        </div>
      </div>
      <div className="tree" role="tree">
        {tree.length === 0 && <div className="tree-empty">Geen verbindingen. Klik ＋ om er een toe te voegen.</div>}
        {renderNodes(tree, 0)}
      </div>
      {menu && (
        <div
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          {menu.items.map((item, i) =>
            item.separator ? (
              <div key={i} className="context-menu-sep" />
            ) : (
              <button
                key={i}
                className={`context-menu-item${item.danger ? ' danger' : ''}`}
                role="menuitem"
                disabled={item.disabled}
                title={item.title}
                onClick={() => {
                  setMenu(null)
                  item.action?.()
                }}
              >
                {item.icon && <span className="context-menu-icon">{item.icon}</span>}
                {item.label}
              </button>
            )
          )}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.label}
          message={
            confirm.reasons && confirm.reasons.length > 0
              ? 'De environment-safety-guard blokkeert deze actie. Alleen met expliciete bevestiging wordt de onderstaande SQL uitgevoerd:'
              : 'Deze actie kan niet ongedaan worden gemaakt. Weet je zeker dat je door wilt gaan?'
          }
          sql={confirm.target.sql}
          reasons={confirm.reasons}
          confirmLabel={confirm.confirmed ? 'Toch verwijderen' : 'Verwijderen'}
          busy={confirm.busy}
          error={confirm.error}
          onConfirm={() => void runDrop(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {dbProps && <DatabasePropertiesDialog state={dbProps} onClose={() => setDbProps(null)} />}
      {objProps && <ObjectDefinitionDialog state={objProps} onClose={() => setObjProps(null)} />}
      {selection && (
        <ObjectViewer
          selection={selection}
          onClose={() => setSelection(null)}
          onScript={(obj, kind) => handleScript(selection.connId, obj, kind)}
        />
      )}
      {notice && (
        <div className={`oe-notice ${notice.kind}`} role="status">
          {notice.text}
        </div>
      )}
    </div>
  )
}

function nodeTitleFor(node: TreeNode): string {
  switch (node.kind) {
    case 'table':
    case 'view':
      return 'Klik: kolomdetails · Dubbelklik: SELECT in nieuw tabblad'
    case 'server':
      return node.connected
        ? 'Verbonden — klik om Databases te tonen · Rechtsklik: opties'
        : 'Niet verbonden — dubbelklik om te verbinden · Rechtsklik: opties'
    case 'folder':
      return 'Klik om uit te klappen · Rechtsklik: opties'
    case 'database':
      return 'Klik om uit te klappen · Rechtsklik: opties'
    default:
      return node.detail ? `${node.label} — ${node.detail}` : node.label
  }
}
