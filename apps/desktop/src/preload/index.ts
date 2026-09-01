import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AdminActionResult,
  AdminUserInfo,
  AuditEntry,
  BackupResult,
  ConnectionConfig,
  DashboardData,
  DataDiff,
  DatabaseInfo,
  ExportResult,
  ExplainResult,
  FuncInfo,
  HistoryEntry,
  ImportFileFormat,
  ImportGenerateResult,
  ImportPreview,
  MonitoringRow,
  NvagIpcApi,
  PluginInfo,
  ProcInfo,
  ProviderCapabilities,
  ProviderDescriptor,
  QueryChunkEvent,
  QueryFileOpenResult,
  QueryFileSaveResult,
  QueryPerformanceStats,
  QueryRunStartResponse,
  RestoreResult,
  SchemaDiff,
  SchemaInfo,
  ScriptObjectResult,
  SearchMatch,
  SeqInfo,
  ServerInfo,
  SnippetEntry,
  TableDataResult,
  TableEditResult,
  TableInfo,
  TableMetadata,
  TestResult,
  TransactionStatus,
  TriggerInfo,
  ViewInfo
} from '@nvag/contracts'

function handle<T>(channel: string): (...args: unknown[]) => Promise<T> {
  return (...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>
}

const api: NvagIpcApi = {
  providers: {
    list: handle<ProviderDescriptor[]>('providers:list')
  },
  connections: {
    list: handle<ConnectionConfig[]>('connections:list'),
    save: handle<ConnectionConfig>('connections:save'),
    remove: handle<void>('connections:remove'),
    test: handle<TestResult>('connections:test')
  },
  query: {
    run: handle<QueryRunStartResponse>('query:run'),
    start: handle<void>('query:start'),
    cancel: handle<void>('query:cancel'),
    onChunk(cb: (evt: QueryChunkEvent) => void): () => void {
      const listener = (_e: Electron.IpcRendererEvent, evt: QueryChunkEvent): void => cb(evt)
      ipcRenderer.on('query:chunk', listener)
      return () => {
        ipcRenderer.removeListener('query:chunk', listener)
      }
    },
    exportCsv: handle<{ canceled: boolean; filePath?: string }>('query:exportCsv'),
    exportResults: handle<ExportResult>('query:exportResults')
  },
  metadata: {
    listDatabases: handle<DatabaseInfo[]>('metadata:listDatabases'),
    listSchemas: handle<SchemaInfo[]>('metadata:listSchemas'),
    listTables: handle<TableInfo[]>('metadata:listTables'),
    listViews: handle<ViewInfo[]>('metadata:listViews'),
    listProcedures: handle<ProcInfo[]>('metadata:listProcedures'),
    listFunctions: handle<FuncInfo[]>('metadata:listFunctions'),
    listTriggers: handle<TriggerInfo[]>('metadata:listTriggers'),
    listSequences: handle<SeqInfo[]>('metadata:listSequences'),
    getTableMetadata: handle<TableMetadata>('metadata:getTableMetadata'),
    getObjectDefinition: handle<string>('metadata:getObjectDefinition'),
    scriptObject: handle<ScriptObjectResult>('metadata:scriptObject')
  },
  sessions: {
    open: handle<{ sessionId: string; serverInfo: ServerInfo }>('sessions:open'),
    close: handle<void>('sessions:close'),
    openSaved: handle<{ sessionId: string; serverInfo: ServerInfo }>('sessions:openSaved'),
    useDatabase: handle<{ sessionId: string; serverInfo: ServerInfo }>('sessions:useDatabase')
  },
  queryFiles: {
    open: handle<QueryFileOpenResult>('queryFiles:open'),
    save: handle<QueryFileSaveResult>('queryFiles:save')
  },
  history: {
    list: handle<HistoryEntry[]>('history:list'),
    clear: handle<void>('history:clear')
  },
  tableData: {
    getRows: handle<TableDataResult>('tableData:getRows'),
    edit: handle<TableEditResult & { blocked?: string[]; guardSeverity?: 'warn' | 'confirm' }>('tableData:edit')
  },
  transactions: {
    begin: handle<TransactionStatus>('transactions:begin'),
    commit: handle<TransactionStatus>('transactions:commit'),
    rollback: handle<TransactionStatus>('transactions:rollback'),
    status: handle<TransactionStatus>('transactions:status')
  },
  admin: {
    createDatabase: handle<AdminActionResult>('admin:createDatabase'),
    dropDatabase: handle<AdminActionResult>('admin:dropDatabase'),
    createSchema: handle<AdminActionResult>('admin:createSchema'),
    dropSchema: handle<AdminActionResult>('admin:dropSchema'),
    createTable: handle<AdminActionResult>('admin:createTable'),
    dropTable: handle<AdminActionResult>('admin:dropTable'),
    createView: handle<AdminActionResult>('admin:createView'),
    dropView: handle<AdminActionResult>('admin:dropView'),
    createIndex: handle<AdminActionResult>('admin:createIndex'),
    dropIndex: handle<AdminActionResult>('admin:dropIndex'),
    listUsers: handle<AdminUserInfo[]>('admin:listUsers'),
    createUser: handle<AdminActionResult>('admin:createUser'),
    dropUser: handle<AdminActionResult>('admin:dropUser'),
    capabilities: handle<ProviderCapabilities>('admin:capabilities'),
    backupDatabase: handle<BackupResult>('admin:backupDatabase'),
    restoreDatabase: handle<RestoreResult>('admin:restoreDatabase')
  },
  performance: {
    getStats: handle<QueryPerformanceStats & { explain?: ExplainResult }>('performance:getStats')
  },
  search: {
    search: handle<SearchMatch[]>('search:search')
  },
  snippets: {
    list: handle<SnippetEntry[]>('snippets:list'),
    save: handle<SnippetEntry>('snippets:save'),
    remove: handle<void>('snippets:remove'),
    listFolders: handle<string[]>('snippets:listFolders')
  },
  import: {
    pickFile: handle<{ canceled: boolean; filePath?: string; format?: ImportFileFormat }>('import:pickFile'),
    preview: handle<ImportPreview>('import:preview'),
    generate: handle<ImportGenerateResult>('import:generate'),
    execute: handle<{ ok: boolean; rowCount: number; blocked?: string[]; guardSeverity?: 'warn' | 'confirm' }>('import:execute')
  },
  audit: {
    list: handle<AuditEntry[]>('audit:list'),
    clear: handle<void>('audit:clear')
  },
  dashboard: {
    get: handle<DashboardData>('dashboard:get')
  },
  monitoring: {
    activeQueries: handle<MonitoringRow[]>('monitoring:activeQueries'),
    locks: handle<unknown[]>('monitoring:locks')
  },
  compare: {
    schemas: handle<SchemaDiff>('compare:schemas'),
    data: handle<DataDiff>('compare:data'),
    deployScript: handle<string>('compare:deployScript')
  },
  ai: {
    saveConfig: handle<void>('ai:saveConfig'),
    chat: handle<{ text: string }>('ai:chat')
  },
  plugins: {
    list: handle<PluginInfo[]>('plugins:list'),
    reload: handle<PluginInfo[]>('plugins:reload')
  },
  app: {
    getVersion: handle<string>('app:getVersion')
  }
}

// Custom APIs for renderer
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('nvag', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.nvag = api
}
