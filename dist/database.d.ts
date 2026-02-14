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
/**
 * A single database version declaration.
 *
 * Maps to a Dexie `.version(n).stores({...}).upgrade(fn)` call.
 * System tables are automatically merged — only declare app tables here.
 */
export interface DatabaseVersionConfig {
    /** The version number (must be a positive integer, monotonically increasing). */
    version: number;
    /** App table schemas (Dexie index syntax). System tables are auto-merged. */
    stores: Record<string, string>;
    /** Optional upgrade function for data migrations between versions. */
    upgrade?: (tx: import('dexie').Transaction) => Promise<void>;
}
/**
 * Database creation configuration passed to {@link createDatabase}.
 */
export interface DatabaseConfig {
    /** IndexedDB database name (should be unique per app). */
    name: string;
    /** Ordered list of version declarations (each adds or modifies tables). */
    versions: DatabaseVersionConfig[];
}
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
export declare function createDatabase(config: DatabaseConfig): Promise<Dexie>;
/**
 * Get the engine-managed Dexie instance.
 *
 * @throws {Error} If no database has been created or registered yet.
 * @returns The active Dexie instance.
 */
export declare function getDb(): Dexie;
/**
 * Register a consumer-provided Dexie instance as the managed database.
 *
 * Used in backward-compatibility mode when the consumer creates their own
 * Dexie instance and passes it via `initEngine({ db: myDexie })`.
 *
 * @param db - The consumer-created Dexie instance.
 * @internal
 */
export declare function _setManagedDb(db: Dexie): void;
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
export declare function resetDatabase(): Promise<string | null>;
//# sourceMappingURL=database.d.ts.map