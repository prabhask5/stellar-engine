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
/**
 * Delete the IndexedDB database entirely and recreate it.
 *
 * Use this as a nuclear recovery option when the database is corrupted
 * (e.g., missing object stores due to failed upgrades). After this call,
 * the app should reload so initEngine() runs fresh and rehydrates from Supabase.
 *
 * Returns the name of the database that was deleted.
 */
export async function resetDatabase() {
    if (!managedDb)
        return null;
    const dbName = managedDb.name;
    // Close all connections so IndexedDB allows deletion
    managedDb.close();
    managedDb = null;
    // Delete the database
    await Dexie.delete(dbName);
    // Clear sync cursors and auth data from localStorage
    if (typeof localStorage !== 'undefined') {
        const keysToRemove = Object.keys(localStorage).filter(k => k.startsWith('lastSyncCursor') || k.startsWith('sb-'));
        for (const key of keysToRemove) {
            localStorage.removeItem(key);
        }
    }
    return dbName;
}
//# sourceMappingURL=database.js.map