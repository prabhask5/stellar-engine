/**
 * Database Management
 *
 * Engine creates and owns the Dexie instance when `database` config is provided.
 * System tables (syncQueue, conflictHistory, offlineCredentials, offlineSession)
 * are automatically merged into every schema version.
 */
import Dexie from 'dexie';
export interface DatabaseVersionConfig {
    version: number;
    stores: Record<string, string>;
    upgrade?: (tx: import('dexie').Transaction) => Promise<void>;
}
export interface DatabaseConfig {
    name: string;
    versions: DatabaseVersionConfig[];
}
/**
 * Create a Dexie database with system tables auto-merged into every version.
 *
 * Opens the database eagerly so version upgrades run immediately.
 * If the upgrade fails (e.g., another tab blocked it, or the DB is corrupted),
 * deletes and recreates the database from scratch.
 */
export declare function createDatabase(config: DatabaseConfig): Promise<Dexie>;
/**
 * Get the engine-managed Dexie instance.
 * Must be set via createDatabase() or _setManagedDb() before use.
 */
export declare function getDb(): Dexie;
/**
 * Set the managed database instance (used when db is provided directly via config).
 */
export declare function _setManagedDb(db: Dexie): void;
/**
 * Delete the IndexedDB database entirely and recreate it.
 *
 * Use this as a nuclear recovery option when the database is corrupted
 * (e.g., missing object stores due to failed upgrades). After this call,
 * the app should reload so initEngine() runs fresh and rehydrates from Supabase.
 *
 * Returns the name of the database that was deleted.
 */
export declare function resetDatabase(): Promise<string | null>;
//# sourceMappingURL=database.d.ts.map