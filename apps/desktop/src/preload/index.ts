import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ConnectionConfig,
  DatabaseInfo,
  FuncInfo,
  NvagIpcApi,
  ProcInfo,
  QueryRunResponse,
  SchemaInfo,
  SeqInfo,
  ServerInfo,
  TableInfo,
  TableMetadata,
  TestResult,
  TriggerInfo,
  ViewInfo
} from '@nvag/contracts'

function handle<T>(channel: string): (...args: unknown[]) => Promise<T> {
  return (...args: unknown[]) => ipcRenderer.invoke(channel, ...args) as Promise<T>
}

const api: NvagIpcApi = {
  connections: {
    list: handle<ConnectionConfig[]>('connections:list'),
    save: handle<ConnectionConfig>('connections:save'),
    remove: handle<void>('connections:remove'),
    test: handle<TestResult>('connections:test')
  },
  query: {
    run: handle<QueryRunResponse>('query:run'),
    cancel: handle<void>('query:cancel')
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
    getTableMetadata: handle<TableMetadata>('metadata:getTableMetadata')
  },
  sessions: {
    open: handle<{ sessionId: string; serverInfo: ServerInfo }>('sessions:open'),
    close: handle<void>('sessions:close')
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
