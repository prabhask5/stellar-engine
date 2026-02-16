/**
 * @fileoverview Engine Configuration and Initialization
 *
 * Central configuration hub for the sync engine. {@link initEngine} is the
 * first function consumers call — it accepts a {@link SyncEngineConfig} object
 * that describes:
 *   - Which Supabase tables to sync and their IndexedDB schemas
 *   - Authentication configuration (single-user gate, offline auth, etc.)
 *   - Sync timing parameters (debounce, polling interval, tombstone TTL)
 *   - Optional callbacks for auth state changes
 *
 * The config is stored as a module-level singleton and accessed by every other
 * module via {@link getEngineConfig}. The database creation flow supports two
 * modes:
 *   1. **Managed** — Engine creates and owns the Dexie instance from a
 *      {@link DatabaseConfig} (recommended).
 *   2. **Provided** — Consumer passes a pre-created `Dexie` instance for
 *      backward compatibility.
 *
 * @see {@link database.ts} for Dexie instance creation
 * @see {@link engine.ts} for the sync lifecycle that consumes this config
 */
import { _setDebugPrefix } from './debug';
import { _setDeviceIdPrefix } from './deviceId';
import { _setClientPrefix } from './supabase/client';
import { _setConfigPrefix } from './runtime/runtimeConfig';
import { registerDemoConfig, _setDemoPrefix, isDemoMode } from './demo';
import { createDatabase, _setManagedDb } from './database';
import { _initCRDT } from './crdt/config';
import { snakeToCamel } from './utils';
// =============================================================================
// Module State
// =============================================================================
/** Singleton engine configuration (set by {@link initEngine}). */
let engineConfig = null;
/** Promise that resolves when the database is fully opened and upgraded. */
let _dbReady = null;
// =============================================================================
// Initialization
// =============================================================================
/**
 * Initialize the sync engine with the provided configuration.
 *
 * Must be called once at app startup, before any other engine function.
 * Propagates the `prefix` to all internal modules (debug, deviceId,
 * Supabase client, runtime config) and creates or registers the Dexie
 * database instance.
 *
 * @param config - The full engine configuration object.
 *
 * @example
 * // In your app's root layout or entry point:
 * initEngine({
 *   prefix: 'myapp',
 *   tables: [...],
 *   database: { name: 'myapp-db', versions: [...] },
 * });
 */
export function initEngine(config) {
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
    /* Handle database creation — either managed or provided.
     * Pass crdtEnabled flag so CRDT IndexedDB tables are conditionally included. */
    if (config.database) {
        _dbReady = createDatabase(config.database, !!config.crdt).then((db) => {
            /* Store on config for backward compat (engine.ts reads config.db). */
            config.db = db;
        });
    }
    else if (config.db) {
        /* Backward compat: use the consumer-provided Dexie instance. */
        _setManagedDb(config.db);
        _dbReady = Promise.resolve();
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
    return snakeToCamel(table.supabaseName);
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
        map[table.supabaseName] = getDexieTableFor(table);
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
export function getTableColumns(supabaseName) {
    const config = getEngineConfig();
    const table = config.tables.find((t) => t.supabaseName === supabaseName);
    if (!table) {
        throw new Error(`Table ${supabaseName} not found in engine config`);
    }
    return table.columns;
}
//# sourceMappingURL=config.js.map