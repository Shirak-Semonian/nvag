import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ConnectionConfig,
  DatabaseInfo,
  FuncInfo,
  HistoryEntry,
  NvagIpcApi,
  ProcInfo,
  QueryChunkEvent,
  QueryFileOpenResult,
  QueryFileSaveResult,
  QueryRunStartResponse,
  SchemaInfo,
  ScriptObjectResult,
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
    exportCsv: handle<{ canceled: boolean; filePath?: string }>('query:exportCsv')
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
    close: handle<void>('sessions:close')
  },
  queryFiles: {
    open: handle<QueryFileOpenResult>('queryFiles:open'),
    save: handle<QueryFileSaveResult>('queryFiles:save')
  },
  history: {
    list: handle<HistoryEntry[]>('history:list'),
    clear: handle<void>('history:clear')
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
