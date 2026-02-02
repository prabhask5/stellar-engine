import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import type Dexie from 'dexie';
import type { SingleUserGateType } from './types';
import { _setDebugPrefix } from './debug';
import { _setDeviceIdPrefix } from './deviceId';
import { _setClientPrefix } from './supabase/client';
import { _setConfigPrefix } from './runtime/runtimeConfig';
import { createDatabase, _setManagedDb, type DatabaseConfig } from './database';
import { snakeToCamel } from './utils';

export interface SyncEngineConfig {
  tables: TableConfig[];
  prefix: string;

  /** Provide a pre-created Dexie instance (backward compat). Mutually exclusive with `database`. */
  db?: Dexie;
  /** Provide a pre-created Supabase client (backward compat). Engine creates one internally if not provided. */
  supabase?: SupabaseClient;
  /** Engine creates and owns the Dexie instance when this is provided. */
  database?: DatabaseConfig;

  auth?: {
    /** Auth mode: 'multi-user' (default) or 'single-user' (anonymous Supabase auth with local gate) */
    mode?: 'multi-user' | 'single-user';
    /** Single-user mode configuration */
    singleUser?: {
      gateType: SingleUserGateType;
      codeLength?: 4 | 6; // required when gateType === 'code'
    };
    profileExtractor?: (userMetadata: Record<string, unknown>) => Record<string, unknown>;
    profileToMetadata?: (profile: Record<string, unknown>) => Record<string, unknown>;
    enableOfflineAuth?: boolean;
    sessionValidationIntervalMs?: number;
    confirmRedirectPath?: string;
    /** Check if a user has admin privileges */
    adminCheck?: (user: User | null) => boolean;
  };

  /** Called when Supabase auth state changes (SIGNED_IN, SIGNED_OUT, etc.) */
  onAuthStateChange?: (event: string, session: Session | null) => void;
  /** Called when user is kicked back to login (e.g., credentials invalid on reconnect) */
  onAuthKicked?: (message: string) => void;

  syncDebounceMs?: number;
  syncIntervalMs?: number;
  tombstoneMaxAgeDays?: number;
  visibilitySyncMinAwayMs?: number;
  onlineReconnectCooldownMs?: number;
}

export interface TableConfig {
  supabaseName: string;
  columns: string;
  ownershipFilter?: string;
  isSingleton?: boolean;
  excludeFromConflict?: string[];
  numericMergeFields?: string[];
  onRemoteChange?: (table: string, record: Record<string, unknown>) => void;
}

let engineConfig: SyncEngineConfig | null = null;
let _dbReady: Promise<void> | null = null;

export function initEngine(config: SyncEngineConfig): void {
  engineConfig = config;

  // Propagate prefix to all internal modules
  if (config.prefix) {
    _setDebugPrefix(config.prefix);
    _setDeviceIdPrefix(config.prefix);
    _setClientPrefix(config.prefix);
    _setConfigPrefix(config.prefix);
  }

  // Handle database creation
  if (config.database) {
    _dbReady = createDatabase(config.database).then(db => {
      // Store on config for backward compat (engine.ts reads config.db)
      (config as { db: Dexie }).db = db;
    });
  } else if (config.db) {
    // Backward compat: use provided Dexie instance
    _setManagedDb(config.db);
    _dbReady = Promise.resolve();
  }
}

/**
 * Wait for the database to be fully opened and upgraded.
 * Must be awaited before any DB access.
 */
export function waitForDb(): Promise<void> {
  return _dbReady || Promise.resolve();
}

export function getEngineConfig(): SyncEngineConfig {
  if (!engineConfig) {
    throw new Error('Sync engine not initialized. Call initEngine() first.');
  }
  return engineConfig;
}


/**
 * Get the Dexie (IndexedDB) table name for a TableConfig entry.
 * Derives from supabaseName via snake_case → camelCase conversion.
 */
export function getDexieTableFor(table: TableConfig): string {
  return snakeToCamel(table.supabaseName);
}

/**
 * Get the Supabase-to-Dexie table mapping derived from config.
 */
export function getTableMap(): Record<string, string> {
  const config = getEngineConfig();
  const map: Record<string, string> = {};
  for (const table of config.tables) {
    map[table.supabaseName] = getDexieTableFor(table);
  }
  return map;
}

/**
 * Get columns for a specific Supabase table from config.
 */
export function getTableColumns(supabaseName: string): string {
  const config = getEngineConfig();
  const table = config.tables.find(t => t.supabaseName === supabaseName);
  if (!table) {
    throw new Error(`Table ${supabaseName} not found in engine config`);
  }
  return table.columns;
}

