/**
 * @fileoverview IndexedDB Database Management via Dexie
 *
 * Manages the lifecycle of the Dexie (IndexedDB) database instance used
 * by the sync engine. The engine creates and owns the Dexie instance
 * via {@link createDatabase}. System tables (syncQueue, conflictHistory,
 * etc.) are automatically merged into every schema version declaration.
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
 * Dexie indexes automatically appended to every app table when using the
 * schema-driven API (`initEngine({ schema: {...} })`).
 *
 * These correspond to the system columns that every synced table has:
 * - `id`         — UUID primary key
 * - `user_id`    — ownership filter for RLS
 * - `created_at` — creation timestamp
 * - `updated_at` — last modification timestamp (sync cursor)
 * - `deleted`    — soft-delete flag
 * - `_version`   — optimistic concurrency version counter
 *
 * @see {@link config.ts#generateDatabaseFromSchema} for usage
 */
export declare const SYSTEM_INDEXES = "id, user_id, created_at, updated_at, deleted, _version";
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
export declare function createDatabase(config: DatabaseConfig, crdtEnabled?: boolean): Promise<Dexie>;
/**
 * Get the engine-managed Dexie instance.
 *
 * @throws {Error} If no database has been created or registered yet.
 * @returns The active Dexie instance.
 */
export declare function getDb(): Dexie;
/**
 * Result of schema version computation.
 *
 * Contains the resolved version number plus the previous stores schema
 * (if any) so that the caller can declare both versions and give Dexie
 * a proper upgrade path.
 */
export interface SchemaVersionResult {
    /** The resolved Dexie version number (positive integer, starts at 1). */
    version: number;
    /**
     * The previous version's store schema, or `null` if this is the first
     * run or no change was detected. When non-null, the caller should declare
     * **both** `previousStores` at `version - 1` and the current stores at
     * `version` so Dexie can perform a non-destructive upgrade.
     */
    previousStores: Record<string, string> | null;
    /** The previous version number, or `null` if no upgrade is needed. */
    previousVersion: number | null;
}
/**
 * Compute a stable Dexie version number from a merged store schema.
 *
 * Uses a localStorage-backed hash comparison to detect schema changes:
 *   1. Compute a deterministic hash of the stringified stores object.
 *   2. Compare to the previously stored hash in localStorage.
 *   3. If changed → increment the stored version, persist both hash and
 *      previous stores schema, and return the upgrade info.
 *   4. If unchanged → return the stored version.
 *   5. If first run → return version 1.
 *
 * When a schema change is detected, the previous stores schema is returned
 * so that the caller can declare both versions. This gives Dexie a proper
 * upgrade path (version N → version N+1) instead of requiring a full
 * database rebuild.
 *
 * @param prefix - Application prefix for namespacing localStorage keys.
 * @param mergedStores - The complete Dexie store schema (app + system tables).
 * @returns Version info including previous stores for upgrade path.
 *
 * @example
 * const result = computeSchemaVersion('stellar', {
 *   goals: 'id, user_id, goal_list_id, order',
 * });
 * // First run:  { version: 1, previousStores: null, previousVersion: null }
 * // On change:  { version: 2, previousStores: { goals: '...' }, previousVersion: 1 }
 *
 * @see {@link config.ts#generateDatabaseFromSchema} for the caller
 */
export declare function computeSchemaVersion(prefix: string, mergedStores: Record<string, string>): SchemaVersionResult;
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