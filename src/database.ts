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
  stores: Record<string, string>; // app tables only
  upgrade?: (tx: import('dexie').Transaction) => Promise<void>;
}

export interface DatabaseConfig {
  name: string;
  versions: DatabaseVersionConfig[];
}

// System tables auto-added to every version
const SYSTEM_TABLES: Record<string, string> = {
  syncQueue: '++id, table, entityId, timestamp',
  conflictHistory: '++id, entityId, entityType, timestamp',
  offlineCredentials: 'id',
  offlineSession: 'id',
  singleUserConfig: 'id'
};

let managedDb: Dexie | null = null;

/**
 * Create a Dexie database with system tables auto-merged into every version.
 */
export function createDatabase(config: DatabaseConfig): Dexie {
  const db = new Dexie(config.name);

  for (const ver of config.versions) {
    // Merge app tables with system tables
    const mergedStores = { ...ver.stores, ...SYSTEM_TABLES };

    if (ver.upgrade) {
      db.version(ver.version).stores(mergedStores).upgrade(ver.upgrade);
    } else {
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
export function getDb(): Dexie {
  if (!managedDb) {
    throw new Error('No database available. Call initEngine() with database config or db first.');
  }
  return managedDb;
}

/**
 * Set the managed database instance (used when db is provided directly via config).
 */
export function _setManagedDb(db: Dexie): void {
  managedDb = db;
}
