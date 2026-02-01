import { _setDebugPrefix } from './debug';
import { _setDeviceIdPrefix } from './deviceId';
import { _setClientPrefix } from './supabase/client';
import { _setConfigPrefix } from './runtime/runtimeConfig';
import { createDatabase, _setManagedDb } from './database';
let engineConfig = null;
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
        const db = createDatabase(config.database);
        // Store on config for backward compat (engine.ts reads config.db)
        config.db = db;
    }
    else if (config.db) {
        // Backward compat: use provided Dexie instance
        _setManagedDb(config.db);
    }
}
export function getEngineConfig() {
    if (!engineConfig) {
        throw new Error('Sync engine not initialized. Call initEngine() first.');
    }
    return engineConfig;
}
/**
 * Get the Supabase-to-Dexie table mapping derived from config.
 */
export function getTableMap() {
    const config = getEngineConfig();
    const map = {};
    for (const table of config.tables) {
        map[table.supabaseName] = table.dexieTable;
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