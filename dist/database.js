/**
 * Database Management
 *
 * Engine creates and owns the Dexie instance when `database` config is provided.
 * System tables (syncQueue, conflictHistory, offlineCredentials, offlineSession)
 * are automatically merged into every schema version.
 */
import Dexie from 'dexie';
// System tables auto-added to every version
const SYSTEM_TABLES = {
    syncQueue: '++id, table, entityId, timestamp',
    conflictHistory: '++id, entityId, entityType, timestamp',
    offlineCredentials: 'id',
    offlineSession: 'id',
    singleUserConfig: 'id'
};
let managedDb = null;
/**
 * Create a Dexie database with system tables auto-merged into every version.
 */
export function createDatabase(config) {
    const db = new Dexie(config.name);
    for (const ver of config.versions) {
        // Merge app tables with system tables
        const mergedStores = { ...ver.stores, ...SYSTEM_TABLES };
        if (ver.upgrade) {
            db.version(ver.version).stores(mergedStores).upgrade(ver.upgrade);
        }
        else {
            db.version(ver.version).stores(mergedStores);
        }
    }
    managedDb = db;
    return db;
}
/**
 * Get the engine-managed Dexie instance.
 * Must be set via createDatabase() or _setManagedDb() before use.
 */
export function getDb() {
    if (!managedDb) {
        throw new Error('No database available. Call initEngine() with database config or db first.');
    }
    return managedDb;
}
/**
 * Set the managed database instance (used when db is provided directly via config).
 */
export function _setManagedDb(db) {
    managedDb = db;
}
//# sourceMappingURL=database.js.map