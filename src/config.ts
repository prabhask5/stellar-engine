/**
 * @fileoverview Engine Configuration and Initialization
 *
 * Central configuration hub for the sync engine. {@link initEngine} is the
 * first function consumers call — it accepts a configuration object that
 * describes:
 *   - Which Supabase tables to sync and their IndexedDB schemas
 *   - Authentication configuration (single-user gate, offline auth, etc.)
 *   - Sync timing parameters (debounce, polling interval, tombstone TTL)
 *   - Optional callbacks for auth state changes
 *
 * The config is stored as a module-level singleton and accessed by every other
 * module via {@link getEngineConfig}. Supports two configuration modes:
 *   1. **Schema-driven** (recommended) — Provide a `schema` object. The engine
 *      auto-generates tables, Dexie stores, versioning, and database naming.
 *   2. **Manual** — Provide explicit `tables` and `database` for full control
 *      over IndexedDB versioning and migration history.
 *
 * @see {@link database.ts} for Dexie instance creation
 * @see {@link engine.ts} for the sync lifecycle that consumes this config
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import type Dexie from 'dexie';
import type { SingleUserGateType, SchemaDefinition, SchemaTableConfig, AuthConfig } from './types';
import type { CRDTConfig } from './crdt/types';
import type { DemoConfig } from './demo';
import { _setDebugPrefix } from './debug';
import { _setDeviceIdPrefix } from './deviceId';
import { _setClientPrefix } from './supabase/client';
import { _setConfigPrefix } from './runtime/runtimeConfig';
import { registerDemoConfig, _setDemoPrefix, isDemoMode } from './demo';
import {
  createDatabase,
  SYSTEM_INDEXES,
  computeSchemaVersion,
  type DatabaseConfig
} from './database';
import { _initCRDT } from './crdt/config';
import { snakeToCamel } from './utils';

// =============================================================================
// Configuration Interfaces
// =============================================================================

/**
 * Top-level configuration for the sync engine.
 *
 * Passed to {@link initEngine} at app startup. Supports two configuration modes:
 *
 * 1. **Schema-driven** (recommended) — Provide a `schema` object. The engine
 *    auto-generates `tables`, Dexie stores, versioning, and database naming.
 * 2. **Manual** — Provide explicit `tables` and `database` for full control
 *    over IndexedDB versioning and migration history.
 *
 * The two modes are mutually exclusive (`schema` vs `tables` + `database`).
 *
 * @example
 * // Schema-driven (recommended):
 * initEngine({
 *   prefix: 'myapp',
 *   schema: {
 *     goals: 'goal_list_id, order',
 *     focus_settings: { singleton: true },
 *   },
 *   auth: { gateType: 'code', codeLength: 6 },
 * });
 */
export interface SyncEngineConfig {
  /** Per-table sync configuration. Auto-populated when using `schema`. */
  tables: TableConfig[];
  /** Application prefix — used for localStorage keys, debug logging, etc. */
  prefix: string;
  /** Human-readable app name (e.g., "Stellar Planner"). Included in Supabase user_metadata for email templates. */
  name: string;
  /** Production domain with protocol (e.g., "https://stellar.example.com"). Included in Supabase user_metadata for email templates. */
  domain: string;

  /**
   * Declarative schema definition — replaces both `tables` and `database`.
   *
   * Each key is a Supabase table name (snake_case). Values are either a string
   * of Dexie indexes or a {@link SchemaTableConfig} object for full control.
   * Mutually exclusive with `tables` + `database`.
   *
   * @see {@link SchemaDefinition} for the full type definition
   */
  schema?: SchemaDefinition;

  /**
   * Override the auto-generated database name when using `schema`.
   *
   * By default, the database is named `${prefix}DB` (e.g., `stellarDB`).
   * Use this to keep an existing database name for data continuity.
   */
  databaseName?: string;

  /** Dexie instance — set internally by `createDatabase()`. Do not set manually. */
  db?: Dexie;
  /** Supabase client — pass to use a custom client instead of the engine's internal proxy. */
  supabase?: SupabaseClient;
  /** Database creation config — auto-generated when using `schema`, or provided manually. */
  database?: DatabaseConfig;

  /** Authentication configuration (nested/internal form). */
  auth?: {
    /** Single-user mode gate configuration. */
    singleUser?: {
      gateType: SingleUserGateType;
      /** Required when `gateType === 'code'`. */
      codeLength?: 4 | 6;
    };
    /** Extract app-specific profile fields from Supabase `user_metadata`. */
    profileExtractor?: (userMetadata: Record<string, unknown>) => Record<string, unknown>;
    /** Convert app-specific profile back to Supabase `user_metadata` shape. */
    profileToMetadata?: (profile: Record<string, unknown>) => Record<string, unknown>;
    /** Enable offline credential caching and offline sign-in. */
    enableOfflineAuth?: boolean;
    /** How often to re-validate the Supabase session (ms). Default: 1 hour. */
    sessionValidationIntervalMs?: number;
    /** Path to redirect to after email confirmation (e.g., `'/auth/confirm'`). */
    confirmRedirectPath?: string;
    /** Device verification for untrusted devices (requires email OTP). */
    deviceVerification?: {
      enabled: boolean;
      /** Days before a trusted device must re-verify (default: 90). */
      trustDurationDays?: number;
    };
    /** Whether signup requires email confirmation before access. */
    emailConfirmation?: {
      enabled: boolean;
    };
  };

  /** Called when Supabase auth state changes (SIGNED_IN, SIGNED_OUT, etc.). */
  onAuthStateChange?: (event: string, session: Session | null) => void;
  /** Called when the user is kicked back to login (e.g., credentials invalid on reconnect). */
  onAuthKicked?: (message: string) => void;

  /** Delay (ms) after a local write before triggering a push sync. Default: 2000. */
  syncDebounceMs?: number;
  /** Interval (ms) between background polling syncs. Default: 900000 (15 min). */
  syncIntervalMs?: number;
  /** Days to retain soft-deleted tombstones before hard-deleting. Default: 7. */
  tombstoneMaxAgeDays?: number;
  /** Minimum time (ms) the tab must be hidden before a visibility sync triggers. Default: 300000 (5 min). */
  visibilitySyncMinAwayMs?: number;
  /** Minimum time (ms) between online-reconnect syncs to avoid duplicate traffic. Default: 120000 (2 min). */
  onlineReconnectCooldownMs?: number;

  /**
   * Demo mode configuration. When provided, enables the demo mode system.
   * In demo mode, the app uses a separate sandboxed Dexie database, makes
   * zero Supabase connections, and seeds mock data on each page load.
   *
   * @see {@link DemoConfig} for the configuration shape
   */
  demo?: DemoConfig;

  /**
   * CRDT collaborative editing configuration.
   *
   * When provided, enables the CRDT subsystem — creates IndexedDB tables for
   * CRDT document storage and allows use of the `stellar-drive/crdt` API.
   * When omitted, no CRDT tables are created and CRDT imports will throw.
   *
   * Pass `true` as shorthand for `{}` (all defaults).
   *
   * @see {@link CRDTConfig} for available configuration options
   */
  crdt?: CRDTConfig | true;
}

/**
 * Per-table sync configuration.
 *
 * Each entry describes one Supabase table and how it maps to the local
 * IndexedDB store.
 *
 * @example
 * {
 *   supabaseName: 'goals',
 *   columns: 'id,title,target,current_value,completed,order,deleted,created_at,updated_at,user_id,device_id',
 *   ownershipFilter: 'user_id',
 *   numericMergeFields: ['current_value'],
 *   excludeFromConflict: ['device_id'],
 * }
 */
export interface TableConfig {
  /** The actual table name in Supabase (prefixed, e.g., `'stellar_goals'`). */
  supabaseName: string;
  /**
   * The raw schema key (unprefixed, e.g., `'goals'`).
   * Used for Dexie table name derivation and consumer-facing API lookups.
   * When not set (manual config), falls back to `supabaseName`.
   */
  schemaKey?: string;
  /** Comma-separated column list for Supabase SELECT queries (egress optimization). */
  columns: string;
  /** Column name used to filter rows by the current user (e.g., `'user_id'`). */
  ownershipFilter?: string;
  /** If `true`, only one row per user exists (e.g., user settings). */
  isSingleton?: boolean;
  /** Fields to skip during conflict resolution (e.g., metadata fields). */
  excludeFromConflict?: string[];
  /** Numeric fields that should attempt additive merge during conflicts. */
  numericMergeFields?: string[];
  /** Optional callback invoked when a remote change arrives for this table via realtime. */
  onRemoteChange?: (table: string, record: Record<string, unknown>) => void;
}

// =============================================================================
// Module State
// =============================================================================

/** Singleton engine configuration (set by {@link initEngine}). */
let engineConfig: SyncEngineConfig | null = null;

/** Promise that resolves when the database is fully opened and upgraded. */
let _dbReady: Promise<void> | null = null;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the sync engine with the provided configuration.
 *
 * Must be called once at app startup, before any other engine function.
 * Propagates the `prefix` to all internal modules (debug, deviceId,
 * Supabase client, runtime config) and creates the Dexie database instance.
 *
 * @param config - The engine configuration object.
 *
 * @example
 * initEngine({
 *   prefix: 'myapp',
 *   schema: { goals: 'goal_list_id, order' },
 *   auth: { gateType: 'code', codeLength: 6 },
 * });
 */
/**
 * Input type for {@link initEngine}.
 *
 * Differs from {@link SyncEngineConfig} in two ways:
 * - `tables` is optional (auto-generated when `schema` is provided)
 * - `auth` accepts either the flat {@link AuthConfig} or the nested internal form
 */
export type InitEngineInput = Omit<SyncEngineConfig, 'tables' | 'auth'> & {
  tables?: TableConfig[];
  auth?: AuthConfig | SyncEngineConfig['auth'];
};

let _engineInitialized = false;

export function initEngine(config: InitEngineInput): void {
  if (_engineInitialized) return;
  _engineInitialized = true;

  /* Normalize `crdt: true` shorthand to `crdt: {}`. */
  if (config.crdt === true) {
    config.crdt = {};
  }

  /* Normalize flat auth config to the nested structure used internally. */
  if (config.auth) {
    config.auth = normalizeAuthConfig(config.auth);
  }

  /*
   * Schema-driven mode: auto-generate `tables` and `database` from the
   * declarative schema definition.
   */
  if (config.schema) {
    if (config.tables || config.database) {
      throw new Error(
        'initEngine: `schema` is mutually exclusive with `tables` and `database`. ' +
          'Use either the schema-driven API or the manual API, not both.'
      );
    }
    config.tables = generateTablesFromSchema(config.schema, config.prefix);
    config.database = generateDatabaseFromSchema(
      config.schema,
      config.prefix,
      config.databaseName,
      !!config.crdt
    );
  }

  /* Validate that tables are configured (either manually or via schema).
   * Schema-driven mode may have 0 entity tables (app uses only auth/system features),
   * so we only throw when neither `schema` nor `tables` was provided. */
  if (!config.schema && (!config.tables || config.tables.length === 0)) {
    throw new Error('initEngine: No tables configured. Provide `schema` or `tables` + `database`.');
  }
  /* Default to empty array when schema is provided but has no entity tables. */
  if (!config.tables) {
    config.tables = [];
  }

  /* At this point tables is guaranteed to be populated — safe to cast. */
  engineConfig = config as SyncEngineConfig;

  /* Propagate prefix to all internal modules that use localStorage keys. */
  if (config.prefix) {
    _setDebugPrefix(config.prefix);
    _setDeviceIdPrefix(config.prefix);
    _setClientPrefix(config.prefix);
    _setConfigPrefix(config.prefix);
    _setDemoPrefix(config.prefix);
  }

  /* Register demo config if provided. */
  if (config.demo) {
    registerDemoConfig(config.demo);
  }

  /* Initialize CRDT subsystem if configured. */
  if (config.crdt) {
    _initCRDT(config.crdt, config.prefix);
  }

  /* If demo mode is active, switch to a separate sandboxed database. */
  if (isDemoMode() && config.database) {
    config.database = { ...config.database, name: config.database.name + '_demo' };
  }

  /* Create the Dexie database and store the instance on config for engine.ts access.
   * Pass crdtEnabled flag so CRDT IndexedDB tables are conditionally included. */
  if (config.database) {
    _dbReady = createDatabase(config.database, !!config.crdt).then((db) => {
      (config as { db: Dexie }).db = db;
    });
  }
}

// =============================================================================
// Accessors
// =============================================================================

/**
 * Wait for the database to be fully opened and upgraded.
 *
 * Must be awaited before any IndexedDB access. Returns immediately if
 * the database was provided directly (no async creation needed).
 *
 * @returns A promise that resolves when the DB is ready.
 */
export function waitForDb(): Promise<void> {
  return _dbReady || Promise.resolve();
}

/**
 * Get the current engine configuration.
 *
 * @throws {Error} If {@link initEngine} has not been called yet.
 * @returns The singleton {@link SyncEngineConfig} object.
 */
export function getEngineConfig(): SyncEngineConfig {
  if (!engineConfig) {
    throw new Error('Sync engine not initialized. Call initEngine() first.');
  }
  return engineConfig;
}

/**
 * Get the Dexie (IndexedDB) table name for a given table config entry.
 *
 * Derives the name from `supabaseName` via snake_case → camelCase conversion.
 *
 * @param table - A table configuration entry.
 * @returns The camelCase Dexie table name (e.g., `'goalLists'` for `'goal_lists'`).
 */
export function getDexieTableFor(table: TableConfig): string {
  return snakeToCamel(table.schemaKey || table.supabaseName);
}

/**
 * Build a lookup map from Supabase table names to Dexie table names.
 *
 * Used by {@link data.ts} to resolve table names at runtime.
 *
 * @returns An object mapping Supabase names → Dexie names.
 *
 * @example
 * getTableMap(); // { goal_lists: 'goalLists', goals: 'goals' }
 */
export function getTableMap(): Record<string, string> {
  const config = getEngineConfig();
  const map: Record<string, string> = {};
  for (const table of config.tables) {
    const key = table.schemaKey || table.supabaseName;
    map[key] = getDexieTableFor(table);
  }
  return map;
}

/**
 * Get the SELECT column list for a specific Supabase table.
 *
 * Used to build egress-optimized queries that only fetch needed columns.
 *
 * @param supabaseName - The Supabase table name (e.g., `'goals'`).
 * @throws {Error} If the table is not found in the engine config.
 * @returns The comma-separated column string.
 */
export function getTableColumns(name: string): string {
  const config = getEngineConfig();
  const table = config.tables.find((t) => t.supabaseName === name || t.schemaKey === name);
  if (!table) {
    throw new Error(`Table ${name} not found in engine config`);
  }
  return table.columns;
}

// =============================================================================
// Table Name Prefixing (Multi-Tenant Support)
// =============================================================================

/**
 * Prefix a raw table name with the app prefix for Supabase.
 *
 * @param prefix - The app prefix (e.g., `'stellar'`).
 * @param tableName - The raw table name (e.g., `'goals'`).
 * @returns The prefixed name (e.g., `'stellar_goals'`).
 */
function prefixTableName(prefix: string, tableName: string): string {
  return `${prefix}_${tableName}`;
}

/**
 * Resolve a consumer-facing schema key to the actual Supabase table name.
 *
 * Consumers use unprefixed names (e.g., `'goals'`), but the actual Supabase
 * table is prefixed (e.g., `'stellar_goals'`). This function performs the
 * lookup. Falls back to the input name if no match is found (backward
 * compatibility with manual config or direct supabase name usage).
 *
 * @param schemaKey - The raw schema key (e.g., `'goals'`).
 * @returns The prefixed Supabase table name (e.g., `'stellar_goals'`).
 */
export function resolveSupabaseName(schemaKey: string): string {
  const config = getEngineConfig();
  const table = config.tables.find(
    (t) => t.schemaKey === schemaKey || t.supabaseName === schemaKey
  );
  return table ? table.supabaseName : schemaKey;
}

// =============================================================================
// Schema → Config Generation
// =============================================================================

/**
 * Generate `TableConfig[]` from a declarative {@link SchemaDefinition}.
 *
 * Each schema key becomes a `TableConfig` with:
 * - `supabaseName` = the schema key (snake_case)
 * - `columns` = `'*'` (SELECT all by default — no egress micro-optimization)
 * - `ownershipFilter` = `'user_id'` (default, since RLS always filters by user)
 * - `isSingleton`, `excludeFromConflict`, `numericMergeFields`, `onRemoteChange`
 *   from the object form (if provided)
 *
 * @param schema - The declarative schema definition.
 * @returns An array of `TableConfig` objects ready for engine consumption.
 *
 * @example
 * generateTablesFromSchema({
 *   goals: 'goal_list_id, order',
 *   focus_settings: { singleton: true },
 * });
 * // → [
 * //   { supabaseName: 'goals', columns: '*', ownershipFilter: 'user_id' },
 * //   { supabaseName: 'focus_settings', columns: '*', ownershipFilter: 'user_id', isSingleton: true },
 * // ]
 */
/**
 * Build a comma-separated column list from a schema's `fields` definition.
 *
 * Combines the standard system columns (always present on every synced table)
 * with the app-specific columns declared in `fields`. Returns `null` if no
 * fields are declared, falling back to `'*'` (SELECT all).
 *
 * @param config - The per-table schema configuration.
 * @returns A comma-separated column string, or `null` if no fields are declared.
 * @internal
 */
/**
 * Whether this table has its own `user_id` column (direct ownership).
 * Child tables with `ownership: { parent, fk }` do NOT have `user_id`.
 */
function hasDirectOwnership(config: SchemaTableConfig): boolean {
  return typeof config.ownership !== 'object';
}

function buildColumnsFromFields(config: SchemaTableConfig): string | null {
  if (!config.fields || Object.keys(config.fields).length === 0) return null;
  const systemCols = ['id', 'created_at', 'updated_at', 'deleted', '_version', 'device_id'];
  /* Include user_id only for tables that have direct user ownership.
     Child tables (ownership: { parent, fk }) inherit ownership through
     RLS policies on the parent table's FK and don't have a user_id column. */
  if (hasDirectOwnership(config)) {
    const ownershipCol = config.ownership || 'user_id';
    systemCols.splice(1, 0, ownershipCol as string);
  }
  const appCols = Object.keys(config.fields);
  return [...systemCols, ...appCols].join(',');
}

function generateTablesFromSchema(schema: SchemaDefinition, prefix: string): TableConfig[] {
  const tables: TableConfig[] = [];

  for (const [tableName, definition] of Object.entries(schema)) {
    /* String form is sugar for { indexes: theString }. */
    const config: SchemaTableConfig =
      typeof definition === 'string' ? { indexes: definition } : definition;

    const tableConfig: TableConfig = {
      supabaseName: prefixTableName(prefix, tableName),
      schemaKey: tableName,
      columns: config.columns || buildColumnsFromFields(config) || '*',
      ownershipFilter: hasDirectOwnership(config)
        ? (config.ownership as string) || 'user_id'
        : undefined
    };

    if (config.singleton) tableConfig.isSingleton = true;
    if (config.excludeFromConflict) tableConfig.excludeFromConflict = config.excludeFromConflict;
    if (config.numericMergeFields) tableConfig.numericMergeFields = config.numericMergeFields;
    if (config.onRemoteChange) tableConfig.onRemoteChange = config.onRemoteChange;

    tables.push(tableConfig);
  }

  return tables;
}

/**
 * Generate a `DatabaseConfig` from a declarative {@link SchemaDefinition}.
 *
 * Builds the Dexie store schema for each table by combining the app-specific
 * indexes from the schema with the {@link SYSTEM_INDEXES} constant. Uses
 * {@link computeSchemaVersion} for automatic version management.
 *
 * @param schema - The declarative schema definition.
 * @param prefix - Application prefix for database naming and versioning.
 * @param databaseName - Optional override for the database name.
 * @param crdtEnabled - Whether the CRDT subsystem is enabled.
 * @returns A `DatabaseConfig` ready for `createDatabase()`.
 *
 * @example
 * generateDatabaseFromSchema(
 *   { goals: 'goal_list_id, order' },
 *   'stellar',
 *   undefined,
 *   false
 * );
 * // → {
 * //   name: 'stellarDB',
 * //   versions: [{ version: 1, stores: { goals: 'id, user_id, ..., goal_list_id, order' } }]
 * // }
 */
function generateDatabaseFromSchema(
  schema: SchemaDefinition,
  prefix: string,
  databaseName?: string,
  crdtEnabled = false
): DatabaseConfig {
  const stores: Record<string, string> = {};

  for (const [tableName, definition] of Object.entries(schema)) {
    const config: SchemaTableConfig =
      typeof definition === 'string' ? { indexes: definition } : definition;

    /* Determine the Dexie table name (camelCase by default, or explicit override). */
    const dexieName = config.dexieName || snakeToCamel(tableName);

    /* Merge system indexes with app-specific indexes. */
    const appIndexes = (config.indexes || '').trim();
    stores[dexieName] = appIndexes ? `${SYSTEM_INDEXES}, ${appIndexes}` : SYSTEM_INDEXES;
  }

  /* Compute auto-version based on the merged store schema.
   * The CRDT flag affects the schema hash because CRDT system tables are merged
   * by buildDexie() — if CRDT is toggled, the version should bump. */
  const hashInput = crdtEnabled ? { ...stores, __crdt: 'enabled' } : stores;
  const result = computeSchemaVersion(prefix, hashInput);

  /*
   * Build the versions array. When an upgrade is detected, declare BOTH
   * the previous version and the current version so Dexie has a proper
   * upgrade path (v(N-1) → vN). This avoids the UpgradeError that occurs
   * when only the new version is declared and the browser already has the
   * old version's IndexedDB schema.
   *
   * Dexie handles additive changes (new tables, new indexes) natively.
   * For the previous version we use its original stores so Dexie can diff
   * and apply the structural changes.
   */
  const versions: DatabaseConfig['versions'] = [];

  if (result.previousStores && result.previousVersion) {
    versions.push({ version: result.previousVersion, stores: result.previousStores });
  }

  versions.push({ version: result.version, stores });

  return {
    name: databaseName || `${prefix}DB`,
    versions
  };
}

/**
 * Normalize an auth config to the internal nested structure.
 *
 * Detects whether the config is in the flat form ({@link AuthConfig}) or
 * the nested form (has a `singleUser` key). Flat form is converted to
 * nested; nested form is passed through unchanged.
 *
 * @param auth - The auth config (flat or nested).
 * @returns The normalized nested auth config.
 * @internal
 */
function normalizeAuthConfig(auth: InitEngineInput['auth']): SyncEngineConfig['auth'] {
  if (!auth) return auth;

  /* Detect nested form by the presence of `singleUser` key. */
  if ('singleUser' in auth) {
    return auth;
  }

  /* Flat form (AuthConfig) → convert to nested structure. */
  const flat = auth as AuthConfig;
  const nested: SyncEngineConfig['auth'] = {};

  /* Map flat singleUser fields to nested singleUser object. */
  const gateType = flat.gateType || 'code';
  const codeLength = flat.codeLength || 6;
  (nested as Record<string, unknown>).singleUser = {
    gateType,
    ...(gateType === 'code' ? { codeLength } : {})
  };

  /* Map flat boolean flags to nested object structures. */
  const emailConfirmation = flat.emailConfirmation !== undefined ? flat.emailConfirmation : true;
  (nested as Record<string, unknown>).emailConfirmation = { enabled: emailConfirmation };

  const deviceVerification = flat.deviceVerification !== undefined ? flat.deviceVerification : true;
  (nested as Record<string, unknown>).deviceVerification = {
    enabled: deviceVerification,
    trustDurationDays: flat.trustDurationDays || 90
  };

  /* Pass through remaining fields with defaults. */
  (nested as Record<string, unknown>).confirmRedirectPath = flat.confirmRedirectPath || '/confirm';
  (nested as Record<string, unknown>).enableOfflineAuth =
    flat.enableOfflineAuth !== undefined ? flat.enableOfflineAuth : true;
  if (flat.sessionValidationIntervalMs !== undefined) {
    (nested as Record<string, unknown>).sessionValidationIntervalMs =
      flat.sessionValidationIntervalMs;
  }
  if (flat.profileExtractor) {
    (nested as Record<string, unknown>).profileExtractor = flat.profileExtractor;
  }
  if (flat.profileToMetadata) {
    (nested as Record<string, unknown>).profileToMetadata = flat.profileToMetadata;
  }

  return nested;
}
