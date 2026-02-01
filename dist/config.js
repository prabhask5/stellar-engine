import { _setDebugPrefix } from './debug';
import { _setDeviceIdPrefix } from './deviceId';
import { _setClientPrefix } from './supabase/client';
import { _setConfigPrefix } from './runtime/runtimeConfig';
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
/**
 * Get a TableConfig by its Supabase name.
 */
export function getTableConfig(supabaseName) {
    const config = getEngineConfig();
    return config.tables.find(t => t.supabaseName === supabaseName);
}
//# sourceMappingURL=config.js.map