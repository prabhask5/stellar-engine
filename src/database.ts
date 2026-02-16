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

// =============================================================================
// Configuration Interfaces
// =============================================================================

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

// =============================================================================
// System Indexes
// =============================================================================

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
export const SYSTEM_INDEXES = 'id, user_id, created_at, updated_at, deleted, _version';

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
const SYSTEM_TABLES: Record<string, string> = {
  syncQueue: '++id, table, entityId, timestamp',
  conflictHistory: '++id, entityId, entityType, timestamp',
  offlineCredentials: 'id',
  offlineSession: 'id',
  singleUserConfig: 'id'
};

/**
 * CRDT tables — only included when the CRDT subsystem is enabled via
 * `initEngine({ crdt: {...} })`.
 *
 * - `crdtDocuments`      — Full Yjs document state snapshots for offline access
 *                          and cross-session recovery
 * - `crdtPendingUpdates` — Incremental Yjs update deltas for crash safety
 *                          (replayed if browser crashes between full saves)
 *
 * @see {@link ./crdt/types.ts} for record shapes
 * @see {@link ./crdt/store.ts} for CRUD operations on these tables
 */
const CRDT_SYSTEM_TABLES: Record<string, string> = {
  crdtDocuments: 'documentId, pageId, offlineEnabled',
  crdtPendingUpdates: '++id, documentId, timestamp'
};

// =============================================================================
// Module State
// =============================================================================

/** The engine-managed Dexie instance (set by createDatabase). */
let managedDb: Dexie | null = null;

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
export async function createDatabase(config: DatabaseConfig, crdtEnabled = false): Promise<Dexie> {
  let db = buildDexie(config, crdtEnabled);

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
        console.error(
          `[DB] Object store mismatch after open! Missing: ${missing.join(', ')}. ` +
            `DB version: ${idb.version}, Dexie version: ${db.verno}. Deleting and recreating...`
        );
        db.close();
        await Dexie.delete(config.name);
        db = buildDexie(config, crdtEnabled);
        await db.open();
      }
    }
  } catch (e) {
    /*
     * Upgrade failed — delete the corrupted DB and start fresh.
     * Common causes: another tab blocking the upgrade, or a previous
     * partial upgrade left the schema in an inconsistent state.
     */
    console.error('[DB] Failed to open database, deleting and recreating:', e);
    try {
      db.close();
    } catch {
      /* Ignore close errors — the connection may already be broken. */
    }
    await Dexie.delete(config.name);
    db = buildDexie(config, crdtEnabled);
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
function buildDexie(config: DatabaseConfig, crdtEnabled = false): Dexie {
  const db = new Dexie(config.name);

  for (const ver of config.versions) {
    /* Merge app tables with system tables — system tables always included.
     * CRDT tables are only included when the CRDT subsystem is enabled. */
    const mergedStores = {
      ...ver.stores,
      ...SYSTEM_TABLES,
      ...(crdtEnabled ? CRDT_SYSTEM_TABLES : {})
    };
    if (ver.upgrade) {
      db.version(ver.version).stores(mergedStores).upgrade(ver.upgrade);
    } else {
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
export function getDb(): Dexie {
  if (!managedDb) {
    throw new Error(
      'No database available. Call initEngine() with schema or database config first.'
    );
  }
  return managedDb;
}

// =============================================================================
// Schema Auto-Versioning
// =============================================================================

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
export function computeSchemaVersion(
  prefix: string,
  mergedStores: Record<string, string>
): SchemaVersionResult {
  /* 1. Build a stable, sorted string representation of the schema. */
  const schemaString = JSON.stringify(
    Object.keys(mergedStores)
      .sort()
      .map((k) => `${k}:${mergedStores[k]}`)
  );
  const hash = djb2Hash(schemaString);

  /* 2. Compare to the stored hash. */
  const hashKey = `${prefix}_schema_hash`;
  const versionKey = `${prefix}_schema_version`;
  const storesKey = `${prefix}_schema_stores`;

  /* Guard for SSR or environments without localStorage. */
  if (typeof localStorage === 'undefined') {
    return { version: 1, previousStores: null, previousVersion: null };
  }

  const storedHash = localStorage.getItem(hashKey);
  const storedVersion = parseInt(localStorage.getItem(versionKey) || '0', 10);

  if (storedHash === hash) {
    /* Schema unchanged — use the stored version. */
    return { version: storedVersion || 1, previousStores: null, previousVersion: null };
  }

  /* 3. Schema changed (or first run) — bump version. */
  const newVersion = (storedVersion || 0) + 1;

  /* Retrieve the previous stores schema for the upgrade path. */
  let previousStores: Record<string, string> | null = null;
  const previousVersion = storedVersion || null;
  const storedStores = localStorage.getItem(storesKey);
  if (storedStores) {
    try {
      previousStores = JSON.parse(storedStores);
    } catch {
      /* Corrupted — treat as first run. */
    }
  }

  /* Persist the new state. */
  localStorage.setItem(hashKey, hash);
  localStorage.setItem(versionKey, String(newVersion));
  localStorage.setItem(storesKey, JSON.stringify(mergedStores));
  return { version: newVersion, previousStores, previousVersion };
}

/**
 * DJB2 hash function — fast, deterministic string hash.
 *
 * Produces a hex string from an arbitrary input string. Not cryptographic,
 * but sufficient for detecting schema changes across app restarts.
 *
 * @param str - The input string to hash.
 * @returns A hex string representation of the hash.
 * @internal
 */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  /* Convert to unsigned 32-bit integer, then to hex. */
  return (hash >>> 0).toString(16);
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
export async function resetDatabase(): Promise<string | null> {
  if (!managedDb) return null;

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
