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

/** Severity van de environment-safety-guard (ADR-009, F1-8). */
export type GuardSeverity = 'warn' | 'confirm'

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

export interface SynonymInfo {
  name: string
  schema?: string
  /** Doelobject van de synonym (bijv. 'dbo.klanten'). */
  baseObject?: string
}

export interface DbUserInfo {
  name: string
  /** Principal-type (SQL Server: 'S' | 'U' | 'G' | ...). */
  type?: string
  defaultSchema?: string
}

export interface DbRoleInfo {
  name: string
  /** Principal-type (SQL Server: 'R' = database role). */
  type?: string
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

/** Script Object-acties (F1-5): gegenereerde SQL per object. */
export type ScriptKind = 'CREATE' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'

export interface ScriptObjectResult {
  sql: string
  /** Tabtitel, bijv. 'users — SELECT'. */
  title: string
}

// ---------------------------------------------------------------------------
// Query-uitvoering
// ---------------------------------------------------------------------------

export interface QueryOptions {
  maxRows?: number
  /** SQL-selectie uit de editor; zonder selectie = hele tekst. */
  selection?: { start: number; end: number }
  /**
   * Unieke uitvoerings-id. Providers registreren de actieve request hiermee,
   * zodat `cancel(session, executionId)` de juiste request kan afbreken
   * (cruciaal bij parallelle queries/meerdere tabs).
   */
  executionId?: string
  /**
   * AbortSignaal waarmee de runner een annulering doorgeeft. Providers moeten
   * hun wacht-punten (awaits/streams) met dit signaal afbreken zodat de
   * async-generator schoon eindigt en er geen resources achterblijven.
   */
  signal?: AbortSignal
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
  | {
      kind: 'done'
      rowCount: number
      durationMs: number
      /** De runner heeft eerder gestopt dan de provider (maxRows-cap). */
      truncated?: boolean
      /** De uitvoering is door de gebruiker geannuleerd. */
      cancelled?: boolean
    }
  | { kind: 'error'; message: string; position?: ErrorPosition }
  | { kind: 'warning'; message: string; position?: ErrorPosition }

/** Eén resultatenset binnen een query-uitvoering (meerdere sets = tabs in de UI). */
export interface QueryResultSet {
  columns: QueryColumn[]
  rows: QueryRow[]
  truncated: boolean
  rowCount: number
}

export type QueryMessageSeverity = 'error' | 'warning' | 'info'

export interface QueryMessage {
  severity: QueryMessageSeverity
  text: string
  position?: ErrorPosition
}

export interface QueryStats {
  rowCount: number
  durationMs: number
  cpuMs?: number
}

export interface ErrorPosition {
  line: number
  column: number
}

/** Chunk-event dat main process naar de renderer stuurt tijdens streaming. */
export interface QueryChunkEvent {
  executionId: string
  chunk: QueryChunk
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
  | 'databricks'

export interface ProviderCapabilities {
  supportsSchemas: boolean // MySQL/MariaDB: geen schemas (db = schema)
  supportsSequences: boolean
  supportsSynonyms: boolean // SQL Server: sys.synonyms; andere engines vaak n.v.t.
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
// Fase 4: Backup & Restore (DBA) — gated via `supportsBackupRestore`
// ---------------------------------------------------------------------------

export interface BackupOptions {
  /** Overschrijf een bestaand backupbestand. */
  overwrite?: boolean
}

export interface RestoreOptions {
  /** Vervang een bestaande database (SQL Server: WITH REPLACE). */
  replace?: boolean
}

export interface BackupResult {
  ok: boolean
  /** Gegenereerde/uitgevoerde SQL (indien van toepassing). */
  sql?: string
  targetPath: string
  durationMs: number
  message?: string
  /** Guard-blokkade (confirm-niveau). */
  blocked?: string[]
  guardSeverity?: GuardSeverity
}

export interface RestoreResult {
  ok: boolean
  sql?: string
  sourcePath: string
  durationMs: number
  message?: string
  blocked?: string[]
  guardSeverity?: GuardSeverity
}

/** Optionele backup/restore-API (F4); alleen aanwezig wanneer de provider
 * `supportsBackupRestore` adverteert. */
export interface BackupRestoreApi {
  backupDatabase?(
    session: DbSession,
    database: string,
    targetPath: string,
    options?: BackupOptions
  ): Promise<BackupResult>
  restoreDatabase?(
    session: DbSession,
    database: string,
    sourcePath: string,
    options?: RestoreOptions
  ): Promise<RestoreResult>
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
  listSynonyms(session: DbSession, db: string, schema?: string): Promise<SynonymInfo[]>
  listUsers(session: DbSession, db: string): Promise<DbUserInfo[]>
  listRoles(session: DbSession, db: string): Promise<DbRoleInfo[]>

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

  // Optioneel: admin / monitoring / plans / backup-restore (gated via capabilities)
  admin?: AdminApi
  monitoring?: MonitoringApi
  executionPlan?: ExecutionPlanApi
  backupRestore?: BackupRestoreApi
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
  // Providers (F2-9: dynamische lijst uit de registry)
  providers: {
    /** Beschikbare providers (id + displayName + dialect). */
    list(): Promise<ProviderDescriptor[]>
  }

  // Connections
  connections: {
    list(): Promise<ConnectionConfig[]>
    save(config: ConnectionConfig, secret?: ConnectionSecret): Promise<ConnectionConfig>
    remove(id: string): Promise<void>
    test(config: ConnectionConfig, secret?: ConnectionSecret): Promise<TestResult>
  }

  // Query
  query: {
    /**
     * Registreert een uitvoering en geeft direct een executionId terug;
     * het daadwerkelijk streamen start pas na `start(executionId)`.
     * Wanneer `blocked` gevuld is, is de query door environment-safety
     * geweigerd en is `executionId` leeg.
     */
    run(req: QueryRunRequest): Promise<QueryRunStartResponse>
    /** Start het streamen van chunks naar de renderer (`query:chunk`-events). */
    start(executionId: string): Promise<void>
    cancel(executionId: string): Promise<void>
    /** Abonneer op gestreamde chunks; retourneert een unsubscribe-functie. */
    onChunk(cb: (evt: QueryChunkEvent) => void): () => void
    /**
     * Sla resultaten op als CSV via een save-dialoog in main process.
     * `csv` is de RFC-4180-tekst (zonder BOM); main voegt BOM toe voor Excel.
     */
    exportCsv(req: {
      defaultFileName: string
      csv: string
    }): Promise<{ canceled: boolean; filePath?: string }>
    /**
     * Exporteren (F1-7): CSV (papaparse) of XLSX (exceljs), naar bestand
     * (save-dialoog) of klembord. Logic in main process; renderer stuurt
     * alleen kolommen + rijwaarden mee.
     */
    exportResults(req: ExportRequest): Promise<ExportResult>
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
    listSynonyms(connectionId: string, db: string, schema?: string): Promise<SynonymInfo[]>
    listUsers(connectionId: string, db: string): Promise<DbUserInfo[]>
    listRoles(connectionId: string, db: string): Promise<DbRoleInfo[]>
    getTableMetadata(
      connectionId: string,
      db: string,
      schema: string,
      table: string
    ): Promise<TableMetadata>
    /** Exacte objectdefinitie (CREATE) zoals de provider die kent. */
    getObjectDefinition(connectionId: string, obj: DbObjectRef): Promise<string>
    /**
     * Script Object: genereer dialect-correcte CREATE/SELECT/INSERT/UPDATE/DELETE
     * voor een object (F1-5); resultaat is bedoeld voor een nieuwe querytab.
     */
    scriptObject(
      connectionId: string,
      obj: DbObjectRef,
      kind: ScriptKind
    ): Promise<ScriptObjectResult>
  }

  // Sessiebeheer
  sessions: {
    open(config: ConnectionConfig, secret?: ConnectionSecret): Promise<{ sessionId: string; serverInfo: ServerInfo }>
    close(sessionId: string): Promise<void>
    /**
     * Snelle switch (eis 24): opent een sessie voor een opgeslagen verbinding
     * met het vault-secret, zonder dat de renderer secrets hoeft te kennen.
     * Wanneer de sessie al open is, wordt de bestaande sessie hergebruikt.
     */
    openSaved(connectionId: string): Promise<{ sessionId: string; serverInfo: ServerInfo }>
    /**
     * Wissel de database van de actieve sessie voor een tab (eis 24):
     * in-place via USE (tsql/mysql) of reconnect met nieuwe database
     * (postgres). Retourneert de bijgewerkte sessie-info.
     */
    useDatabase(connectionId: string, database: string): Promise<{ sessionId: string; serverInfo: ServerInfo }>
  }

  // Query-bestanden (openen/opslaan via dialoog in main process)
  queryFiles: {
    open(): Promise<QueryFileOpenResult>
    save(content: string, path?: string): Promise<QueryFileSaveResult>
  }

  // SQL History (eis 19) — lokale uitvoeringsgeschiedenis in SQLite
  history: {
    /** Recente uitvoeringen; met `query` wordt er op SQL/server/database gezocht. */
    list(query?: string, limit?: number): Promise<HistoryEntry[]>
    clear(): Promise<void>
  }

  // F2-1: Table Data Viewer/Editor (eis 8)
  tableData: {
    /** Haalt rijen op van een tabel (SELECT Top N). */
    getRows(
      connectionId: string,
      database: string,
      schema: string,
      table: string,
      maxRows?: number
    ): Promise<TableDataResult>
    /**
     * Voert een gegenereerde UPDATE/INSERT/DELETE uit op basis van de
     * primary key. De gegenereerde SQL wordt geretourneerd (zichtbaar);
     * bij een guard-blokkade wordt `blocked` gevuld en niets uitgevoerd.
     */
    edit(req: TableEditRequest): Promise<
      TableEditResult & { blocked?: string[]; guardSeverity?: GuardSeverity }
    >
  }

  // F2-2: Transactions (eis 23)
  transactions: {
    /** START TRANSACTION / BEGIN op de sessie van een verbinding. */
    begin(connectionId: string): Promise<TransactionStatus>
    commit(connectionId: string): Promise<TransactionStatus>
    rollback(connectionId: string): Promise<TransactionStatus>
    /** Huidige transactiestatus per verbinding. */
    status(connectionId: string): Promise<TransactionStatus>
  }

  // F2-3: Database Administration (eis 9)
  admin: {
    createDatabase(connectionId: string, name: string, confirmed?: boolean): Promise<AdminActionResult>
    dropDatabase(connectionId: string, name: string, confirmed?: boolean): Promise<AdminActionResult>
    createSchema(connectionId: string, database: string, name: string, confirmed?: boolean): Promise<AdminActionResult>
    dropSchema(connectionId: string, database: string, name: string, confirmed?: boolean): Promise<AdminActionResult>
    createTable(req: AdminTableCreateRequest, confirmed?: boolean): Promise<AdminActionResult>
    dropTable(connectionId: string, database: string, schema: string, table: string, confirmed?: boolean): Promise<AdminActionResult>
    createView(connectionId: string, database: string, schema: string, name: string, sql: string, confirmed?: boolean): Promise<AdminActionResult>
    dropView(connectionId: string, database: string, schema: string, name: string, confirmed?: boolean): Promise<AdminActionResult>
    createIndex(req: AdminIndexCreateRequest, confirmed?: boolean): Promise<AdminActionResult>
    dropIndex(connectionId: string, database: string, schema: string, table: string, index: string, confirmed?: boolean): Promise<AdminActionResult>
    listUsers(connectionId: string): Promise<AdminUserInfo[]>
    createUser(req: AdminUserRequest, confirmed?: boolean): Promise<AdminActionResult>
    dropUser(connectionId: string, name: string, confirmed?: boolean): Promise<AdminActionResult>
    // SAL-45: DROP voor de overige Object Explorer-objecttypen (routines,
    // trigger, sequence, synonym) en tabel-constraints.
    dropProcedure(connectionId: string, database: string, schema: string | undefined, name: string, confirmed?: boolean): Promise<AdminActionResult>
    dropFunction(connectionId: string, database: string, schema: string | undefined, name: string, confirmed?: boolean): Promise<AdminActionResult>
    dropTrigger(connectionId: string, database: string, schema: string | undefined, name: string, table?: string, confirmed?: boolean): Promise<AdminActionResult>
    dropSequence(connectionId: string, database: string, schema: string | undefined, name: string, confirmed?: boolean): Promise<AdminActionResult>
    dropSynonym(connectionId: string, database: string, schema: string | undefined, name: string, confirmed?: boolean): Promise<AdminActionResult>
    dropRole(connectionId: string, name: string, confirmed?: boolean): Promise<AdminActionResult>
    dropConstraint(connectionId: string, database: string, schema: string | undefined, table: string, name: string, confirmed?: boolean): Promise<AdminActionResult>
    // SAL-50: eigenschappen van een bestaande database lezen/wijzigen
    // (bewerkbare eigenschappen-dialoog + ALTER DATABASE).
    getDatabaseProperties(connectionId: string, database: string): Promise<DatabasePropertiesResult>
    alterDatabase(connectionId: string, database: string, changes: Record<string, string>, confirmed?: boolean): Promise<AlterDatabaseResult>
    /** Capabilities van de provider (voor UI-gating). */
    capabilities(connectionId: string): Promise<ProviderCapabilities>
    // Fase 4: Backup & Restore (DBA), gated via `supportsBackupRestore`
    backupDatabase(connectionId: string, database: string, targetPath: string, confirmed?: boolean): Promise<BackupResult>
    restoreDatabase(connectionId: string, database: string, sourcePath: string, confirmed?: boolean): Promise<RestoreResult>
  }

  // F2-4: Query Performance (eis 11)
  performance: {
    /**
     * Statistieken voor de laatst uitgevoerde query van een tab (of een
     * EXPLAIN-run). Wanneer `sql` is meegegeven, draait de provider een
     * EXPLAIN-achtige analyse en retourneert de ruwe output.
     */
    getStats(
      connectionId: string,
      sql?: string,
      maxRows?: number
    ): Promise<QueryPerformanceStats & { explain?: ExplainResult }>
  }

  // F2-5: Database Search (eis 13)
  search: {
    /**
     * Doorzoekt objecten (tabellen/views/procs/functies/kolommen) en tekst
     * in definities via de metadata cache.
     */
    search(
      connectionId: string,
      query: string,
      options?: { database?: string; limit?: number }
    ): Promise<SearchMatch[]>
  }

  // F2-6: Snippets/Favorites (eis 20)
  snippets: {
    list(folder?: string): Promise<SnippetEntry[]>
    save(entry: NewSnippetEntry): Promise<SnippetEntry>
    remove(id: number): Promise<void>
    listFolders(): Promise<string[]>
  }

  // F2-7: Import (eis 17)
  import: {
    /** Kiest een bestand via dialoog en retourneert pad + formaat. */
    pickFile(): Promise<{ canceled: boolean; filePath?: string; format?: ImportFileFormat }>
    /** Parseert het bestand en retourneert een preview (kolommen + eerste rijen). */
    preview(req: ImportParseRequest): Promise<ImportPreview>
    /**
     * Genereert INSERT-SQL uit het bestand met kolom-mapping.
     * `rowLimit` 0 = alle rijen.
     */
    generate(req: ImportGenerateRequest): Promise<ImportGenerateResult>
    /** Voert de gegenereerde INSERTs direct uit (met guard-check). */
    execute(
      connectionId: string,
      sql: string,
      confirmed?: boolean
    ): Promise<{ ok: boolean; rowCount: number; blocked?: string[]; guardSeverity?: GuardSeverity }>
  }

  // F2-8: Logging & Audit (eis 26)
  audit: {
    list(limit?: number): Promise<AuditEntry[]>
    clear(): Promise<void>
  }

  // F2-10: Dashboard (eis 25)
  dashboard: {
    get(connectionId: string): Promise<DashboardData>
  }

  // F3-2: Monitoring/Activity (eis 12)
  monitoring: {
    /** Actieve queries/sessies; `includeIdle` toont ook idle sessies. */
    activeQueries(connectionId: string, includeIdle?: boolean): Promise<MonitoringRow[]>
    /** Locks (waar beschikbaar). */
    locks(connectionId: string): Promise<unknown[]>
  }

  // F3-3: Schema Compare + Data Compare (eis 15 + 16)
  compare: {
    schemas(
      sourceConnectionId: string,
      sourceSchema: string | undefined,
      targetConnectionId: string,
      targetSchema: string | undefined
    ): Promise<SchemaDiff>
    data(
      sourceConnectionId: string,
      sourceSchema: string | undefined,
      targetConnectionId: string,
      targetSchema: string | undefined,
      table: string
    ): Promise<DataDiff>
    deployScript(
      sourceConnectionId: string,
      sourceSchema: string | undefined,
      targetConnectionId: string,
      targetSchema: string | undefined,
      diff: SchemaDiff
    ): Promise<string>
  }

  // F3-6: AI Assistant (eis 27)
  ai: {
    /** Config opslaan (apiKey gaat versleuteld naar de vault). */
    saveConfig(config: AiConfigInput): Promise<void>
    /** AI-aanroep (generate/explain/optimize/convert). */
    chat(req: AiRequest): Promise<{ text: string }>
  }

  // F3-7: Extern plugin-systeem (eis 29)
  plugins: {
    list(): Promise<PluginInfo[]>
    reload(): Promise<PluginInfo[]>
  }

  app: {
    getVersion(): Promise<string>
  }
}

export interface MonitoringRow {
  id: string
  user?: string
  database?: string
  status?: string
  durationMs?: number
  query?: string
  blockedBy?: string
  cpuMs?: number
  locks?: number
}

// F3-3
export interface SchemaDiff {
  tablesOnlyInSource: string[]
  tablesOnlyInTarget: string[]
  columnDiffs: {
    table: string
    missingInTarget: string[]
    missingInSource: string[]
  }[]
  missingTables: number
  missingColumns: number
}

export interface DataDiff {
  table: string
  sourceRowCount: number
  targetRowCount: number
  differs: boolean
}

// F3-6
export interface AiConfigInput {
  baseUrl?: string
  model?: string
  apiKey?: string
}

export interface AiRequest {
  connectionId?: string
  mode: 'generate' | 'explain' | 'optimize' | 'convert' | 'free'
  input: string
  targetDialect?: string
}

// F3-7
export interface PluginInfo {
  name: string
  source: string
  providerId?: string
  providerName?: string
  ok: boolean
  error?: string
}

export interface SnippetEntry {
  id: number
  folder: string
  title: string
  sql: string
  /** Sorteer-/gebruiksdatum (ISO). */
  updatedAt: string
}

export interface NewSnippetEntry {
  folder: string
  title: string
  sql: string
}

/** Beperkte provider-beschrijving voor de UI (F2-9). */
export interface ProviderDescriptor {
  id: string
  displayName: string
  dialect: SqlDialectId
  defaultPort: number
}

export interface QueryFileOpenResult {
  canceled: boolean
  path?: string
  /** Bestandsnaam zonder map (voor tab-titel). */
  name?: string
  content?: string
}

export interface QueryFileSaveResult {
  canceled: boolean
  path?: string
}

export interface QueryRunRequest {
  connectionId: string
  sql: string
  selection?: { start: number; end: number }
  maxRows?: number
  /** Environment-safety (F1-8): gebruiker bevestigde de query in de dialoog. */
  confirmed?: boolean
}

// ---------------------------------------------------------------------------
// SQL History (eis 19)
// ---------------------------------------------------------------------------

/** Eén uitvoering in de lokale SQL-history. */
export interface HistoryEntry {
  id: number
  /** ISO-tijdstip van uitvoering (UTC). */
  executedAt: string
  connectionId: string
  /** Verbindingsnaam (server) zoals in de Connection Manager. */
  server: string
  /** Database waarop de query draaide (indien bekend). */
  database: string
  sql: string
  durationMs: number
  success: boolean
  error?: string
  rowCount: number
}

export interface QueryRunStartResponse {
  executionId: string
  /** Redenen waarom environment-safety de query blokkeerde (executionId is dan leeg). */
  blocked?: string[]
  /** Severity van de blokkade: 'confirm' → dialoog; 'warn' → uitvoeren met waarschuwing. */
  guardSeverity?: GuardSeverity
}

// ---------------------------------------------------------------------------
// Resultaten exporteren (F1-7, SAL-20) — CSV (papaparse) en XLSX (exceljs)
// ---------------------------------------------------------------------------

export type ExportFormat = 'csv' | 'xlsx'

/** Doel van een export: save-dialoog naar bestand, of systeemklembord. */
export type ExportTarget = 'file' | 'clipboard'

/** Kolomdefinitie voor export (naam + optioneel datatype). */
export interface ExportColumn {
  name: string
  dataType?: string
}

export interface ExportRequest {
  format: ExportFormat
  target: ExportTarget
  /** Standaard bestandsnaam (zonder extensie) voor de save-dialoog. */
  fileName: string
  columns: ExportColumn[]
  /**
   * Rijen als platte waardes in kolomvolgorde (kolom i ↔ columns[i]).
   * Waardes zijn QueryCellValue-achtig; bigint/Uint8Array worden
   * genormaliseerd (string resp. "[BLOB n bytes]").
   */
  rows: unknown[][]
  /** CSV-scheidingsteken; standaard ';' (Excel NL-locale). */
  delimiter?: ';' | ',' | '\t'
}

export interface ExportResult {
  /** file-target: gebruiker annuleerde de save-dialoog. */
  canceled?: boolean
  /** file-target: gekozen pad. */
  filePath?: string
  /** clipboard-target: gelukt. */
  ok?: boolean
  /** Aantal geëxporteerde rijen (zonder header). */
  rowCount?: number
  error?: string
}

export interface QueryRunResponse {
  executionId: string
  /** Eerste resultatenset (backward-compat); bij DML leeg. */
  columns: QueryColumn[]
  rows: QueryRow[]
  truncated: boolean
  rowCount: number
  durationMs: number
  error?: string
  errorPosition?: ErrorPosition
  /** Redenen waarom environment-safety de query blokkeerde. */
  blocked?: string[]
  /** Uitvoering is door de gebruiker geannuleerd. */
  cancelled?: boolean
  /** Alle resultatensets (meerdere sets → tabs in de UI). */
  results?: QueryResultSet[]
  /** Structured messages-paneel: errors, warnings, info. */
  messages?: QueryMessage[]
}

// ---------------------------------------------------------------------------
// Fase 2 — Beheer & productiviteit
// ---------------------------------------------------------------------------

// F2-1: Table Data Viewer/Editor (eis 8)
// ---------------------------------------------------------------------------

export interface TableDataResult {
  columns: QueryColumn[]
  rows: QueryRow[]
  truncated: boolean
  rowCount: number
  /** Primary key-kolommen (voor UPDATE/DELETE-generatie). */
  primaryKey: string[]
  /** Bewerkbare kolommen (niet identity, niet computed). */
  editableColumns: string[]
}

export type TableEditKind = 'update' | 'insert' | 'delete'

export interface TableEditRequest {
  connectionId: string
  database: string
  schema?: string
  table: string
  kind: TableEditKind
  /** Kolom → waarde voor INSERT; kolom → nieuwe waarde voor UPDATE. */
  values: Record<string, QueryCellValue>
  /** Kolom → oorspronkelijke PK-waarde voor UPDATE/DELETE. */
  pkValues: Record<string, QueryCellValue>
  /** Environment-safety (F2-1): gebruiker bevestigde de gegenereerde SQL. */
  confirmed?: boolean
}

export interface TableEditResult {
  rowCount: number
  /** De SQL die is uitgevoerd (zichtbaar voor de gebruiker). */
  sql: string
}

// F2-2: Transactions (eis 23)
// ---------------------------------------------------------------------------

export type TransactionState = 'none' | 'active'

export interface TransactionStatus {
  connectionId: string
  state: TransactionState
}

// F2-3: Database Administration (eis 9)
// ---------------------------------------------------------------------------

export interface AdminColumnDef {
  name: string
  dataType: string
  length?: number
  precision?: number
  scale?: number
  nullable?: boolean
  primaryKey?: boolean
  defaultValue?: string
}

export interface AdminIndexDef {
  name: string
  table: string
  schema?: string
  columns: string[]
  unique?: boolean
}

export interface AdminUserInfo {
  name: string
  /** Rolnaam voor gebruikers-rollen (indien van toepassing). */
  role?: string
  canLogin?: boolean
}

export interface AdminRequest {
  connectionId: string
  database?: string
  schema?: string
  object?: string
  name?: string
}

export interface AdminTableCreateRequest {
  connectionId: string
  database: string
  schema?: string
  table: string
  columns: AdminColumnDef[]
}

export interface AdminIndexCreateRequest {
  connectionId: string
  database: string
  schema?: string
  index: AdminIndexDef
}

export interface AdminUserRequest {
  connectionId: string
  name: string
  password?: string
}

/**
 * Resultaat van een admin-DDL-actie (F2-3, eis 9).
 * Bij een guard-blokkade op `confirm`-niveau (DROP/ALTER/PROD) wordt
 * `ok: false` + `blocked` geretourneerd; de UI vraagt bevestiging en
 * voert dezelfde actie opnieuw uit met `confirmed: true`.
 * Op `warn`-niveau (CREATE buiten PROD) wordt de actie uitgevoerd en
 * staat de reden in `warning`.
 */
export interface AdminActionResult {
  ok: boolean
  /** De gegenereerde/uitgevoerde SQL (altijd zichtbaar). */
  sql: string
  /** Guard-redenen (alleen bij `ok: false`; `guardSeverity` is dan 'confirm'). */
  blocked?: string[]
  guardSeverity?: GuardSeverity
  /** Waarschuwing bij een uitgevoerde actie op `warn`-niveau. */
  warning?: string[]
}

// F2-3 / SAL-50: database-eigenschappen opvragen en wijzigen (ALTER DATABASE)
// ---------------------------------------------------------------------------

/** Hoe een eigenschap in de dialoog getoond/bewerkt wordt. */
export type DatabasePropertyKind = 'info' | 'text' | 'select'

export interface DatabasePropertyOption {
  value: string
  label: string
}

export interface DatabaseProperty {
  /** Machine-key, bijv. 'recovery_model' of 'name'. */
  key: string
  /** Nederlands label in de dialoog. */
  label: string
  kind: DatabasePropertyKind
  /** Huidige waarde (weergave; bij kind='select' één van options[].value). */
  value: string
  /** false → read-only-info (geen ALTER-clausule voor deze property). */
  editable: boolean
  /** Keuzes voor kind='select'. */
  options?: DatabasePropertyOption[]
  /** Reden waarom de property niet bewerkbaar is (toont de UI). */
  note?: string
  /** true → wijzigen hernoemt de database; UI moet boom/tab-context bijwerken. */
  renamesDatabase?: boolean
  /**
   * Sectie in het SSMS-achtige overzicht ('algemeen' | 'opties' | overig).
   * Alleen read-only-info-groepen; bewerkbare velden toont de UI apart.
   */
  section?: string
}

/** Eén databasebestand (SQL Server: sys.master_files). */
export interface DatabaseFileInfo {
  /** Logische bestandsnaam, bijv. 'Klanten' of 'Klanten_log'. */
  name: string
  /** Type: ROWS / LOG / FILESTREAM / FULLTEXT. */
  type: string
  /** Fysiek pad op de server. */
  physicalName: string
  sizeMb: number
  /** null = onbeperkt (max_size = -1). */
  maxSizeMb: number | null
  /** null = procentuele groei (is_percent_growth). */
  growthMb: number | null
}

export interface DatabasePropertiesResult {
  database: string
  dialect: SqlDialectId
  /** Of ALTER DATABASE voor deze provider/database ondersteund is. */
  supportsAlter: boolean
  /** Toelichting wanneer `supportsAlter` false is (netjes tonen). */
  message?: string
  properties: DatabaseProperty[]
  /** Bestanden van de database (SQL Server: sys.master_files). */
  files?: DatabaseFileInfo[]
}

/** Resultaat van alterDatabase: AdminActionResult + hernoeminfo voor de UI. */
export interface AlterDatabaseResult extends AdminActionResult {
  /** Nieuwe databasenaam na een geslaagde naamswijziging (MODIFY NAME). */
  renamedTo?: string
}

// F2-4: Query Performance (eis 11)
// ---------------------------------------------------------------------------

/** Extra statistieken die providers waar mogelijk vullen (F2-4). */
export interface QueryPerformanceStats {
  elapsedMs: number
  rowsReturned: number
  /** Aantal gelezen rijen (indien provider dit rapporteert). */
  rowsRead?: number
  /** CPU-tijd in ms (indien beschikbaar). */
  cpuMs?: number
  /** Provider-specifieke extra statistieken (bijv. EXPLAIN-resultaat). */
  extra?: Record<string, string | number | boolean>
}

export interface ExplainResult {
  /** Dialect (voor de parser/visualisatie). */
  dialect: SqlDialectId
  /** Ruwe output van de provider (bijv. EXPLAIN FORMAT=JSON-string). */
  raw: string
  /** Gestructureerde operators (F3-1): boom van operatorknooppunten. */
  plan?: ExplainPlanNode[]
}

export interface ExplainPlanNode {
  operator: string
  detail?: string
  cost?: number
  rows?: number
  width?: number
  children: ExplainPlanNode[]
}

// F2-5: Database Search (eis 13)
// ---------------------------------------------------------------------------

export interface SearchMatch {
  objectType: 'table' | 'view' | 'procedure' | 'function' | 'column' | 'definition'
  database: string
  schema?: string
  object: string
  /** Waar de match is gevonden (objectnaam, kolomnaam of definitie-tekst). */
  field: 'name' | 'column' | 'definition'
  /** Klein fragment rond de match (voor weergave). */
  snippet?: string
}

// F2-7: Import (eis 17)
// ---------------------------------------------------------------------------

export type ImportFileFormat = 'csv' | 'json' | 'xlsx' | 'xml'

export interface ImportParseRequest {
  /** Pad naar het bronbestand (gekozen via dialoog in main process). */
  filePath: string
  format: ImportFileFormat
}

export interface ImportColumnDef {
  name: string
  dataType?: string
}

export interface ImportPreview {
  fileName: string
  format: ImportFileFormat
  columns: ImportColumnDef[]
  /** Eerste N rijen als platte waardes in kolomvolgorde. */
  rows: unknown[][]
  totalRows: number
  /** Unieke kolomnamen (na normalisatie van duplicaten). */
  uniqueColumns: string[]
}

export interface ImportGenerateRequest {
  filePath: string
  format: ImportFileFormat
  /** Verbinding (voor het dialect van de gegenereerde SQL). */
  connectionId: string
  /** Doeltabel. */
  table: string
  schema?: string
  /** Kolom-mapping: bronkolom (index) → doelkolomnaam. */
  mapping: Record<number, string>
  /** Alleen eerste N rijen (0 = alles). */
  rowLimit?: number
}

export interface ImportGenerateResult {
  sql: string
  rowCount: number
}

// F2-8: Logging & Audit (eis 26)
// ---------------------------------------------------------------------------

export type AuditAction =
  | 'connection.created'
  | 'connection.removed'
  | 'session.opened'
  | 'query.executed'
  | 'query.exported'
  | 'table.edit'
  | 'import.executed'
  | 'admin.ddl'
  | 'transaction.commit'
  | 'transaction.rollback'

export interface AuditEntry {
  id: number
  /** ISO-tijdstip (UTC). */
  at: string
  action: AuditAction
  /** Verbindingsnaam of '—'. */
  server?: string
  database?: string
  /** Korte beschrijving (SQL is geredigeerd; secrets worden verwijderd). */
  detail: string
  success: boolean
  /** Fouttekst (indien aanwezig; secrets geredigeerd). */
  error?: string
}

// F2-10: Dashboard (eis 25)
// ---------------------------------------------------------------------------

export interface DatabaseSizeInfo extends DatabaseInfo {
  sizeBytes?: number
  /** Aantal tabellen (indien beschikbaar). */
  tableCount?: number
}

export interface DashboardData {
  serverInfo: ServerInfo
  databases: DatabaseSizeInfo[]
  /** Actieve queries (waar ondersteund; anders leeg). */
  activeQueries: unknown[]
  /** Provider-specifieke extra gegevens. */
  extra?: Record<string, string | number | boolean>
}
