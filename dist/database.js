/**
 * @fileoverview IndexedDB Database Management via Dexie
 *
 * Manages the lifecycle of the Dexie (IndexedDB) database instance used
 * by the sync engine. The engine can operate in two modes:
 *
 *   1. **Managed mode** — The engine creates and owns the Dexie instance
 *      via {@link createDatabase}. System tables (syncQueue, conflictHistory,
 *      etc.) are automatically merged into every schema version declaration.
 *
 *   2. **Provided mode** — The consumer passes a pre-created Dexie instance
 *      via {@link _setManagedDb} (backward compatibility).
 *
 * Recovery strategy:
 *   If the database fails to open (e.g., blocked by another tab, corrupted
 *   schema, or mismatched object stores from a stale service worker), the
 *   engine deletes the entire IndexedDB and recreates it from scratch. Data
 *   is recovered on the next sync cycle via hydration from Supabase.
 *
 * @see {@link config.ts#initEngine} for the initialization entry point
 * @see {@link engine.ts#hydrateFromRemote} for post-recovery data restoration
 */
import Dexie from 'dexie';
// =============================================================================
// System Tables
// =============================================================================
/**
 * Internal tables automatically added to every schema version.
 *
 * These support core engine functionality:
 * - `syncQueue`          — Pending outbound operations (push queue / outbox)
 * - `conflictHistory`    — Field-level conflict resolution records
 * - `offlineCredentials` — Cached user credentials for offline sign-in
 * - `offlineSession`     — Offline session tokens
 * - `singleUserConfig`   — Single-user mode gate configuration
 */
const SYSTEM_TABLES = {
    syncQueue: '++id, table, entityId, timestamp',
    conflictHistory: '++id, entityId, entityType, timestamp',
    offlineCredentials: 'id',
    offlineSession: 'id',
    singleUserConfig: 'id'
};
// =============================================================================
// Module State
// =============================================================================
/** The engine-managed Dexie instance (set by createDatabase or _setManagedDb). */
let managedDb = null;
// =============================================================================
// Database Creation
// =============================================================================
/**
 * Create a Dexie database with system tables auto-merged into every version.
 *
 * Opens the database eagerly so version upgrades run immediately (not lazily
 * on first table access). After opening, validates that the actual IndexedDB
 * object stores match the declared schema — if they don't, deletes and
 * recreates the database.
 *
 * Recovery flow:
 *   1. Try to open the database normally.
 *   2. If open succeeds, verify object stores match expectations.
 *   3. If stores mismatch (stale service worker) or open fails (corruption),
 *      delete the database and rebuild from scratch.
 *   4. Data is rehydrated from Supabase on the next sync cycle.
 *
 * @param config - Database name and version declarations.
 * @returns The opened Dexie instance, ready for use.
 */
export async function createDatabase(config) {
    let db = buildDexie(config);
    try {
        /*
         * Open eagerly to trigger version upgrade NOW, not lazily on first access.
         * This surfaces upgrade errors immediately instead of failing silently
         * on the first table read/write.
         */
        await db.open();
        /*
         * Verify actual IndexedDB object stores match the declared schema.
         *
         * db.tables uses the declared schema; the real stores may differ if an
         * upgrade was skipped (e.g., service worker served stale JS during a
         * previous version bump). When this happens, reads/writes to the
         * missing stores throw confusing "table not found" errors.
         */
        const idb = db.backendDB();
        if (idb) {
            const actualStores = Array.from(idb.objectStoreNames);
            const expectedStores = db.tables.map((t) => t.name);
            const missing = expectedStores.filter((s) => !actualStores.includes(s));
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
        /*
         * Upgrade failed — delete the corrupted DB and start fresh.
         * Common causes: another tab blocking the upgrade, or a previous
         * partial upgrade left the schema in an inconsistent state.
         */
        console.error('[DB] Failed to open database, deleting and recreating:', e);
        try {
            db.close();
        }
        catch {
            /* Ignore close errors — the connection may already be broken. */
        }
        await Dexie.delete(config.name);
        db = buildDexie(config);
        await db.open();
    }
    managedDb = db;
    return db;
}
/**
 * Build a Dexie instance with version declarations (does NOT open it).
 *
 * Merges {@link SYSTEM_TABLES} into every version's store declarations
 * so consumers don't need to declare engine-internal tables.
 *
 * @param config - Database name and version declarations.
 * @returns An unopened Dexie instance with all versions declared.
 */
function buildDexie(config) {
    const db = new Dexie(config.name);
    for (const ver of config.versions) {
        /* Merge app tables with system tables — system tables always included. */
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
// =============================================================================
// Accessors
// =============================================================================
/**
 * Get the engine-managed Dexie instance.
 *
 * @throws {Error} If no database has been created or registered yet.
 * @returns The active Dexie instance.
 */
export function getDb() {
    if (!managedDb) {
        throw new Error('No database available. Call initEngine() with database config or db first.');
    }
    return managedDb;
}
/**
 * Register a consumer-provided Dexie instance as the managed database.
 *
 * Used in backward-compatibility mode when the consumer creates their own
 * Dexie instance and passes it via `initEngine({ db: myDexie })`.
 *
 * @param db - The consumer-created Dexie instance.
 * @internal
 */
export function _setManagedDb(db) {
    managedDb = db;
}
// =============================================================================
// Recovery
// =============================================================================
/**
 * Delete the IndexedDB database entirely and clear associated state.
 *
 * Use this as a **nuclear recovery option** when the database is corrupted
 * (e.g., missing object stores due to failed upgrades, unrecoverable data
 * inconsistencies). After calling this, the app should reload so
 * {@link config.ts#initEngine} runs fresh and rehydrates from Supabase.
 *
 * Preserves the Supabase auth session in localStorage so the same anonymous
 * user is recovered on reload (instead of creating a new user with no data).
 *
 * @returns The name of the deleted database, or `null` if no database was managed.
 *
 * @example
 * const deleted = await resetDatabase();
 * if (deleted) {
 *   window.location.reload(); // Triggers fresh initEngine + hydration
 * }
 */
export async function resetDatabase() {
    if (!managedDb)
        return null;
    const dbName = managedDb.name;
    /* Close all connections so IndexedDB allows deletion. */
    managedDb.close();
    managedDb = null;
    /* Delete the database. */
    await Dexie.delete(dbName);
    /*
     * Clear sync cursors from localStorage, but NOT auth session keys —
     * preserving the Supabase session allows the app to recover the same
     * anonymous user on reload instead of creating a new one with no data.
     */
    if (typeof localStorage !== 'undefined') {
        const keysToRemove = Object.keys(localStorage).filter((k) => k.startsWith('lastSyncCursor'));
        for (const key of keysToRemove) {
            localStorage.removeItem(key);
        }
    }
    return dbName;
}
//# sourceMappingURL=database.js.map