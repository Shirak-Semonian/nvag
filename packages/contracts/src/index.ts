/**
 * @nvag/contracts — stabiele contracten voor Nvag.
 *
 * Dit package bevat ALLEEN types (geen runtime-logica) zodat het door
 * main process, renderer, providers en eventuele externe plugins kan
 * worden gedeeld zonder afhankelijkheden.
 */

// ---------------------------------------------------------------------------
// Verbindingsconfiguratie
// ---------------------------------------------------------------------------

export type Environment = 'DEV' | 'TEST' | 'ACC' | 'PROD'

export type AuthMethod =
  | 'username-password'
  | 'windows'
  | 'entra'
  | 'kerberos'
  | 'oauth'
  | 'token'
  | 'certificate'

export interface SslConfig {
  mode: 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'
  caPath?: string
  certPath?: string
  keyPath?: string
}

export interface ConnectionConfig {
  id: string // uuid
  name: string // 'SQL-PROD'
  providerId: string
  environment: Environment
  host: string
  port?: number
  instance?: string // SQL Server named instance
  database?: string
  username?: string
  auth: AuthMethod
  ssl: SslConfig
  connectionTimeoutMs: number
  /** Bestand-gebaseerde providers (SQLite): maak het bestand aan wanneer het niet bestaat. */
  createIfMissing?: boolean
  encryption?: Record<string, string> // provider-specifiek
  extraParams?: Record<string, string> // vrije connection-string parameters
  group: string // folder: 'Development', 'Test', ...
  color?: string // env-kleur override
  // Secrets staan NIET in dit object na opslag; ze gaan apart
  // versleuteld naar de vault (zie Security-model).
}

/** Secret die los van de config naar de vault gaat. */
export interface ConnectionSecret {
  password?: string
  token?: string
}

export interface TestResult {
  ok: boolean
  message?: string
  serverInfo?: ServerInfo
}

export interface ServerInfo {
  providerId: string
  providerName: string
  serverVersion: string
  productName?: string
  currentDatabase?: string
  currentUser?: string
}

// ---------------------------------------------------------------------------
// Databasesessie en metadata
// ---------------------------------------------------------------------------

export interface DbSession {
  /** Provider-specifiek sessie-object; nooit over IPC sturen. */
  handle: unknown
  connectionId: string
  providerId: string
  database: string
}

export interface DatabaseInfo {
  name: string
  sizeBytes?: number
  status?: string
}

export interface SchemaInfo {
  name: string
}

export interface TableInfo {
  name: string
  schema?: string
  type?: 'table' | 'view'
}

export interface ViewInfo {
  name: string
  schema?: string
}

export interface ProcInfo {
  name: string
  schema?: string
  type?: 'procedure' | 'function' | 'aggregate'
}

export interface FuncInfo {
  name: string
  schema?: string
}

export interface TriggerInfo {
  name: string
  schema?: string
  table?: string
}

export interface SeqInfo {
  name: string
  schema?: string
}

export interface ColumnInfo {
  name: string
  dataType: string
  length?: number
  precision?: number
  scale?: number
  nullable: boolean
  defaultValue?: string | null
  isIdentity: boolean
  isComputed: boolean
  isPrimaryKey: boolean
  isUnique?: boolean
  ordinalPosition: number
}

export interface IndexInfo {
  name: string
  columns: string[]
  isUnique: boolean
  isPrimaryKey?: boolean
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  referencedTable: string
  referencedSchema?: string
  referencedColumns: string[]
  onDelete?: string
  onUpdate?: string
}

export interface ConstraintInfo {
  name: string
  type: 'CHECK' | 'DEFAULT' | 'UNIQUE' | 'PRIMARY KEY' | 'FOREIGN KEY'
  definition?: string
}

export interface DependencyInfo {
  objectName: string
  objectSchema?: string
  objectType: string
  direction: 'depends-on' | 'used-by'
}

export interface TableMetadata {
  columns: ColumnInfo[]
  primaryKey: string[]
  foreignKeys: ForeignKeyInfo[]
  indexes: IndexInfo[]
  constraints: ConstraintInfo[]
  triggers: string[]
  dependencies: DependencyInfo[]
  rowCount?: number
}

export type DbObjectType =
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'procedure'
  | 'function'
  | 'trigger'
  | 'sequence'

export interface DbObjectRef {
  type: DbObjectType
  database: string
  schema?: string
  name: string
}

// ---------------------------------------------------------------------------
// Query-uitvoering
// ---------------------------------------------------------------------------

export interface QueryOptions {
  maxRows?: number
  /** SQL-selectie uit de editor; zonder selectie = hele tekst. */
  selection?: { start: number; end: number }
}

export interface QueryColumn {
  name: string
  dataType?: string
}

export type QueryCellValue = string | number | bigint | boolean | null | Uint8Array

export interface QueryRow {
  values: QueryCellValue[]
}

/** Gestreamde chunks van de provider naar de UI. */
export type QueryChunk =
  | { kind: 'columns'; columns: QueryColumn[] }
  | { kind: 'rows'; rows: QueryRow[] }
  | { kind: 'done'; rowCount: number; durationMs: number }
  | { kind: 'error'; message: string; position?: { line: number; column: number } }

export interface QueryStats {
  rowCount: number
  durationMs: number
  cpuMs?: number
}

export interface ErrorPosition {
  line: number
  column: number
}

// ---------------------------------------------------------------------------
// Capabilities en dialect
// ---------------------------------------------------------------------------

export type SqlDialectId =
  | 'sqlite'
  | 'tsql'
  | 'postgres'
  | 'mysql'
  | 'db2'
  | 'oracle'
  | 'snowflake'

export interface ProviderCapabilities {
  supportsSchemas: boolean // MySQL/MariaDB: geen schemas (db = schema)
  supportsSequences: boolean
  supportsTriggers: boolean
  supportsExecutionPlans: boolean
  supportsMonitoring: boolean
  supportsTransactions: boolean
  supportsIdentityColumns: boolean
  supportsGeneratedColumns: boolean
  supportsDdlAdmin: boolean
  supportsUsersAndRoles: boolean
  supportsBackupRestore: boolean
  maxResultRowsDefault: number
  dialect: SqlDialectId
}

// ---------------------------------------------------------------------------
// Optionele API's (fase 2/3, gated via capabilities)
// ---------------------------------------------------------------------------

export interface AdminApi {
  createDatabase?(session: DbSession, name: string): Promise<void>
  dropDatabase?(session: DbSession, name: string): Promise<void>
}

export interface MonitoringApi {
  getActiveQueries?(session: DbSession): Promise<unknown[]>
}

export interface ExecutionPlanApi {
  getPlan?(session: DbSession, sql: string): Promise<unknown>
}

// ---------------------------------------------------------------------------
// DatabaseProvider — de kern-interface (ADR-002)
// ---------------------------------------------------------------------------

export interface DatabaseProvider {
  readonly id: string // 'sqlserver' | 'postgresql' | ...
  readonly displayName: string
  readonly defaultPort: number
  readonly capabilities: ProviderCapabilities

  // Verbinding
  connect(config: ConnectionConfig, secret?: ConnectionSecret): Promise<DbSession>
  testConnection(config: ConnectionConfig, secret?: ConnectionSecret): Promise<TestResult>
  getServerInfo(session: DbSession): Promise<ServerInfo>
  close(session: DbSession): Promise<void>

  // Metadata (Object Explorer, lazy per niveau)
  listDatabases(session: DbSession): Promise<DatabaseInfo[]>
  listSchemas(session: DbSession, db: string): Promise<SchemaInfo[]>
  listTables(session: DbSession, db: string, schema?: string): Promise<TableInfo[]>
  listViews(session: DbSession, db: string, schema?: string): Promise<ViewInfo[]>
  listProcedures(session: DbSession, db: string, schema?: string): Promise<ProcInfo[]>
  listFunctions(session: DbSession, db: string, schema?: string): Promise<FuncInfo[]>
  listTriggers(session: DbSession, db: string, schema?: string): Promise<TriggerInfo[]>
  listSequences(session: DbSession, db: string, schema?: string): Promise<SeqInfo[]>

  getTableMetadata(
    session: DbSession,
    db: string,
    schema: string,
    table: string
  ): Promise<TableMetadata>

  // Objectdefinities (Script Object)
  getObjectDefinition(session: DbSession, obj: DbObjectRef): Promise<string>

  // Query-uitvoering
  executeQuery(
    session: DbSession,
    sql: string,
    opts: QueryOptions
  ): AsyncIterable<QueryChunk>
  cancel(session: DbSession, executionId: string): Promise<void>
  getExecutionStats(session: DbSession, executionId: string): Promise<QueryStats>

  // Optioneel: admin / monitoring / plans (gated via capabilities)
  admin?: AdminApi
  monitoring?: MonitoringApi
  executionPlan?: ExecutionPlanApi
}

export interface ProviderRegistry {
  register(provider: DatabaseProvider): void
  get(id: string): DatabaseProvider
  list(): DatabaseProvider[]
  has(id: string): boolean
}

// ---------------------------------------------------------------------------
// IPC-contract (gedeeld tussen main en renderer)
// ---------------------------------------------------------------------------

export interface NvagIpcApi {
  // Connections
  connections: {
    list(): Promise<ConnectionConfig[]>
    save(config: ConnectionConfig, secret?: ConnectionSecret): Promise<ConnectionConfig>
    remove(id: string): Promise<void>
    test(config: ConnectionConfig, secret?: ConnectionSecret): Promise<TestResult>
  }

  // Query
  query: {
    run(req: QueryRunRequest): Promise<QueryRunResponse>
    cancel(executionId: string): Promise<void>
  }

  // Metadata / Object Explorer
  metadata: {
    listDatabases(connectionId: string): Promise<DatabaseInfo[]>
    listSchemas(connectionId: string, db: string): Promise<SchemaInfo[]>
    listTables(connectionId: string, db: string, schema?: string): Promise<TableInfo[]>
    listViews(connectionId: string, db: string, schema?: string): Promise<ViewInfo[]>
    listProcedures(connectionId: string, db: string, schema?: string): Promise<ProcInfo[]>
    listFunctions(connectionId: string, db: string, schema?: string): Promise<FuncInfo[]>
    listTriggers(connectionId: string, db: string, schema?: string): Promise<TriggerInfo[]>
    listSequences(connectionId: string, db: string, schema?: string): Promise<SeqInfo[]>
    getTableMetadata(
      connectionId: string,
      db: string,
      schema: string,
      table: string
    ): Promise<TableMetadata>
  }

  // Sessiebeheer
  sessions: {
    open(config: ConnectionConfig, secret?: ConnectionSecret): Promise<{ sessionId: string; serverInfo: ServerInfo }>
    close(sessionId: string): Promise<void>
  }

  app: {
    getVersion(): Promise<string>
  }
}

export interface QueryRunRequest {
  connectionId: string
  sql: string
  selection?: { start: number; end: number }
  maxRows?: number
}

export interface QueryRunResponse {
  executionId: string
  columns: QueryColumn[]
  rows: QueryRow[]
  truncated: boolean
  rowCount: number
  durationMs: number
  error?: string
  errorPosition?: ErrorPosition
}
