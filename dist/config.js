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
import { _setDebugPrefix } from './debug';
import { _setDeviceIdPrefix } from './deviceId';
import { _setClientPrefix } from './supabase/client';
import { _setConfigPrefix } from './runtime/runtimeConfig';
import { registerDemoConfig, _setDemoPrefix, isDemoMode } from './demo';
import { createDatabase, SYSTEM_INDEXES, computeSchemaVersion } from './database';
import { _initCRDT } from './crdt/config';
import { snakeToCamel } from './utils';
// =============================================================================
// Module State
// =============================================================================
/** Singleton engine configuration (set by {@link initEngine}). */
let engineConfig = null;
/** Promise that resolves when the database is fully opened and upgraded. */
let _dbReady = null;
let _engineInitialized = false;
export function initEngine(config) {
    if (_engineInitialized)
        return;
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
            throw new Error('initEngine: `schema` is mutually exclusive with `tables` and `database`. ' +
                'Use either the schema-driven API or the manual API, not both.');
        }
        config.tables = generateTablesFromSchema(config.schema, config.prefix);
        config.database = generateDatabaseFromSchema(config.schema, config.prefix, config.databaseName, !!config.crdt);
    }
    /* Validate that tables are configured (either manually or via schema). */
    if (!config.tables || config.tables.length === 0) {
        throw new Error('initEngine: No tables configured. Provide `schema` or `tables` + `database`.');
    }
    /* At this point tables is guaranteed to be populated — safe to cast. */
    engineConfig = config;
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
            config.db = db;
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
export function waitForDb() {
    return _dbReady || Promise.resolve();
}
/**
 * Get the current engine configuration.
 *
 * @throws {Error} If {@link initEngine} has not been called yet.
 * @returns The singleton {@link SyncEngineConfig} object.
 */
export function getEngineConfig() {
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
export function getDexieTableFor(table) {
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
export function getTableMap() {
    const config = getEngineConfig();
    const map = {};
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
export function getTableColumns(name) {
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
function prefixTableName(prefix, tableName) {
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
export function resolveSupabaseName(schemaKey) {
    const config = getEngineConfig();
    const table = config.tables.find((t) => t.schemaKey === schemaKey || t.supabaseName === schemaKey);
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
function hasDirectOwnership(config) {
    return typeof config.ownership !== 'object';
}
function buildColumnsFromFields(config) {
    if (!config.fields || Object.keys(config.fields).length === 0)
        return null;
    const systemCols = ['id', 'created_at', 'updated_at', 'deleted', '_version', 'device_id'];
    /* Include user_id only for tables that have direct user ownership.
       Child tables (ownership: { parent, fk }) inherit ownership through
       RLS policies on the parent table's FK and don't have a user_id column. */
    if (hasDirectOwnership(config)) {
        const ownershipCol = config.ownership || 'user_id';
        systemCols.splice(1, 0, ownershipCol);
    }
    const appCols = Object.keys(config.fields);
    return [...systemCols, ...appCols].join(',');
}
function generateTablesFromSchema(schema, prefix) {
    const tables = [];
    for (const [tableName, definition] of Object.entries(schema)) {
        /* String form is sugar for { indexes: theString }. */
        const config = typeof definition === 'string' ? { indexes: definition } : definition;
        const tableConfig = {
            supabaseName: prefixTableName(prefix, tableName),
            schemaKey: tableName,
            columns: config.columns || buildColumnsFromFields(config) || '*',
            ownershipFilter: hasDirectOwnership(config)
                ? config.ownership || 'user_id'
                : undefined
        };
        if (config.singleton)
            tableConfig.isSingleton = true;
        if (config.excludeFromConflict)
            tableConfig.excludeFromConflict = config.excludeFromConflict;
        if (config.numericMergeFields)
            tableConfig.numericMergeFields = config.numericMergeFields;
        if (config.onRemoteChange)
            tableConfig.onRemoteChange = config.onRemoteChange;
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
function generateDatabaseFromSchema(schema, prefix, databaseName, crdtEnabled = false) {
    const stores = {};
    for (const [tableName, definition] of Object.entries(schema)) {
        const config = typeof definition === 'string' ? { indexes: definition } : definition;
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
    const versions = [];
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
function normalizeAuthConfig(auth) {
    if (!auth)
        return auth;
    /* Detect nested form by the presence of `singleUser` key. */
    if ('singleUser' in auth) {
        return auth;
    }
    /* Flat form (AuthConfig) → convert to nested structure. */
    const flat = auth;
    const nested = {};
    /* Map flat singleUser fields to nested singleUser object. */
    const gateType = flat.gateType || 'code';
    const codeLength = flat.codeLength || 6;
    nested.singleUser = {
        gateType,
        ...(gateType === 'code' ? { codeLength } : {})
    };
    /* Map flat boolean flags to nested object structures. */
    const emailConfirmation = flat.emailConfirmation !== undefined ? flat.emailConfirmation : true;
    nested.emailConfirmation = { enabled: emailConfirmation };
    const deviceVerification = flat.deviceVerification !== undefined ? flat.deviceVerification : true;
    nested.deviceVerification = {
        enabled: deviceVerification,
        trustDurationDays: flat.trustDurationDays || 90
    };
    /* Pass through remaining fields with defaults. */
    nested.confirmRedirectPath = flat.confirmRedirectPath || '/confirm';
    nested.enableOfflineAuth =
        flat.enableOfflineAuth !== undefined ? flat.enableOfflineAuth : true;
    if (flat.sessionValidationIntervalMs !== undefined) {
        nested.sessionValidationIntervalMs =
            flat.sessionValidationIntervalMs;
    }
    if (flat.profileExtractor) {
        nested.profileExtractor = flat.profileExtractor;
    }
    if (flat.profileToMetadata) {
        nested.profileToMetadata = flat.profileToMetadata;
    }
    return nested;
}
//# sourceMappingURL=config.js.map