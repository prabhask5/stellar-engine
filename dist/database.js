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
 *
 * Opens the database eagerly so version upgrades run immediately.
 * If the upgrade fails (e.g., another tab blocked it, or the DB is corrupted),
 * deletes and recreates the database from scratch.
 */
export async function createDatabase(config) {
    let db = buildDexie(config);
    try {
        // Open eagerly to trigger version upgrade NOW, not lazily on first access.
        // This surfaces upgrade errors immediately instead of failing silently later.
        await db.open();
        // Verify actual IndexedDB object stores match the declared schema.
        // db.tables uses the declared schema; the real stores may differ if an
        // upgrade was skipped (e.g., service worker served stale JS during a
        // previous version bump).
        const idb = db.backendDB();
        if (idb) {
            const actualStores = Array.from(idb.objectStoreNames);
            const expectedStores = db.tables.map(t => t.name);
            const missing = expectedStores.filter(s => !actualStores.includes(s));
            if (missing.length > 0) {
                console.error(`[DB] Object store mismatch after open! Missing: ${missing.join(', ')}. ` +
                    `DB version: ${idb.version}, Dexie version: ${db.verno}. Deleting and recreating...`);
                db.close();
                await Dexie.delete(config.name);
                db = buildDexie(config);
                await db.open();
            }
        }
    }
    catch (e) {
        // Upgrade failed — delete the corrupted DB and start fresh
        console.error('[DB] Failed to open database, deleting and recreating:', e);
        try {
            db.close();
        }
        catch { /* ignore */ }
        await Dexie.delete(config.name);
        db = buildDexie(config);
        await db.open();
    }
    managedDb = db;
    return db;
}
/** Build a Dexie instance with version declarations (does NOT open it). */
function buildDexie(config) {
    const db = new Dexie(config.name);
    for (const ver of config.versions) {
        const mergedStores = { ...ver.stores, ...SYSTEM_TABLES };
        if (ver.upgrade) {
            db.version(ver.version).stores(mergedStores).upgrade(ver.upgrade);
        }
        else {
            db.version(ver.version).stores(mergedStores);
        }
    }
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
    // Clear sync cursors from localStorage (but NOT auth session keys —
    // preserving the Supabase session allows the app to recover the same
    // anonymous user on reload instead of creating a new one with no data)
    if (typeof localStorage !== 'undefined') {
        const keysToRemove = Object.keys(localStorage).filter(k => k.startsWith('lastSyncCursor'));
        for (const key of keysToRemove) {
            localStorage.removeItem(key);
        }
    }
    return dbName;
}
//# sourceMappingURL=database.js.map