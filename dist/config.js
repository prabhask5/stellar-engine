import { _setDebugPrefix } from './debug';
import { _setDeviceIdPrefix } from './deviceId';
import { _setClientPrefix } from './supabase/client';
import { _setConfigPrefix } from './runtime/runtimeConfig';
import { createDatabase, _setManagedDb } from './database';
import { snakeToCamel } from './utils';
let engineConfig = null;
let _dbReady = null;
export function initEngine(config) {
    engineConfig = config;
    // Propagate prefix to all internal modules
    if (config.prefix) {
        _setDebugPrefix(config.prefix);
        _setDeviceIdPrefix(config.prefix);
        _setClientPrefix(config.prefix);
        _setConfigPrefix(config.prefix);
    }
    // Handle database creation
    if (config.database) {
        _dbReady = createDatabase(config.database).then(db => {
            // Store on config for backward compat (engine.ts reads config.db)
            config.db = db;
        });
    }
    else if (config.db) {
        // Backward compat: use provided Dexie instance
        _setManagedDb(config.db);
        _dbReady = Promise.resolve();
    }
}
/**
 * Wait for the database to be fully opened and upgraded.
 * Must be awaited before any DB access.
 */
export function waitForDb() {
    return _dbReady || Promise.resolve();
}
export function getEngineConfig() {
    if (!engineConfig) {
        throw new Error('Sync engine not initialized. Call initEngine() first.');
    }
    return engineConfig;
}
/**
 * Get the Dexie (IndexedDB) table name for a TableConfig entry.
 * Derives from supabaseName via snake_case → camelCase conversion.
 */
export function getDexieTableFor(table) {
    return snakeToCamel(table.supabaseName);
}
/**
 * Get the Supabase-to-Dexie table mapping derived from config.
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
 * Get columns for a specific Supabase table from config.
 */
export function getTableColumns(supabaseName) {
    const config = getEngineConfig();
    const table = config.tables.find(t => t.supabaseName === supabaseName);
    if (!table) {
        throw new Error(`Table ${supabaseName} not found in engine config`);
    }
    return table.columns;
}
//# sourceMappingURL=config.js.map