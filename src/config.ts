/**
 * @fileoverview Engine Configuration and Initialization
 *
 * Central configuration hub for the sync engine. {@link initEngine} is the
 * first function consumers call — it accepts a {@link SyncEngineConfig} object
 * that describes:
 *   - Which Supabase tables to sync and their IndexedDB schemas
 *   - Authentication mode (multi-user, single-user, or none)
 *   - Sync timing parameters (debounce, polling interval, tombstone TTL)
 *   - Optional callbacks for auth state changes
 *
 * The config is stored as a module-level singleton and accessed by every other
 * module via {@link getEngineConfig}. The database creation flow supports two
 * modes:
 *   1. **Managed** — Engine creates and owns the Dexie instance from a
 *      {@link DatabaseConfig} (recommended).
 *   2. **Provided** — Consumer passes a pre-created `Dexie` instance for
 *      backward compatibility.
 *
 * @see {@link database.ts} for Dexie instance creation
 * @see {@link engine.ts} for the sync lifecycle that consumes this config
 */

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

// =============================================================================
// Configuration Interfaces
// =============================================================================

/**
 * Top-level configuration for the sync engine.
 *
 * Passed to {@link initEngine} at app startup. All fields except `tables`
 * and `prefix` have sensible defaults.
 *
 * @example
 * initEngine({
 *   prefix: 'myapp',
 *   tables: [
 *     { supabaseName: 'goals', columns: 'id,title,target,current_value,...' },
 *   ],
 *   database: { name: 'myapp-db', versions: [{ version: 1, stores: { goals: 'id,user_id' } }] },
 *   syncDebounceMs: 1000,
 * });
 */
export interface SyncEngineConfig {
  /** Per-table sync configuration (required). */
  tables: TableConfig[];
  /** Application prefix — used for localStorage keys, debug logging, etc. */
  prefix: string;

  /** Provide a pre-created Dexie instance (backward compat). Mutually exclusive with `database`. */
  db?: Dexie;
  /** Provide a pre-created Supabase client (backward compat). Engine creates one internally if not provided. */
  supabase?: SupabaseClient;
  /** Engine creates and owns the Dexie instance when this is provided. */
  database?: DatabaseConfig;

  /** Authentication configuration. */
  auth?: {
    /** Auth mode: `'multi-user'` (default) or `'single-user'` (anonymous Supabase auth with local gate). */
    mode?: 'multi-user' | 'single-user';
    /** Single-user mode gate configuration (required when `mode === 'single-user'`). */
    singleUser?: {
      gateType: SingleUserGateType;
      /** Required when `gateType === 'code'`. */
      codeLength?: 4 | 6;
    };
    /** Extract app-specific profile fields from Supabase `user_metadata`. */
    profileExtractor?: (userMetadata: Record<string, unknown>) => Record<string, unknown>;
    /** Convert app-specific profile back to Supabase `user_metadata` shape. */
    profileToMetadata?: (profile: Record<string, unknown>) => Record<string, unknown>;
    /** Enable offline credential caching and offline sign-in. */
    enableOfflineAuth?: boolean;
    /** How often to re-validate the Supabase session (ms). Default: 1 hour. */
    sessionValidationIntervalMs?: number;
    /** Path to redirect to after email confirmation (e.g., `'/auth/confirm'`). */
    confirmRedirectPath?: string;
    /** Predicate to determine if a user has admin privileges. */
    adminCheck?: (user: User | null) => boolean;
    /** Device verification for untrusted devices (requires email OTP). */
    deviceVerification?: {
      enabled: boolean;
      /** Days before a trusted device must re-verify (default: 90). */
      trustDurationDays?: number;
    };
    /** Whether signup requires email confirmation before access. */
    emailConfirmation?: {
      enabled: boolean;
    };
  };

  /** Called when Supabase auth state changes (SIGNED_IN, SIGNED_OUT, etc.). */
  onAuthStateChange?: (event: string, session: Session | null) => void;
  /** Called when the user is kicked back to login (e.g., credentials invalid on reconnect). */
  onAuthKicked?: (message: string) => void;

  /** Delay (ms) after a local write before triggering a push sync. Default: 2000. */
  syncDebounceMs?: number;
  /** Interval (ms) between background polling syncs. Default: 900000 (15 min). */
  syncIntervalMs?: number;
  /** Days to retain soft-deleted tombstones before hard-deleting. Default: 7. */
  tombstoneMaxAgeDays?: number;
  /** Minimum time (ms) the tab must be hidden before a visibility sync triggers. Default: 300000 (5 min). */
  visibilitySyncMinAwayMs?: number;
  /** Minimum time (ms) between online-reconnect syncs to avoid duplicate traffic. Default: 120000 (2 min). */
  onlineReconnectCooldownMs?: number;
}

/**
 * Per-table sync configuration.
 *
 * Each entry describes one Supabase table and how it maps to the local
 * IndexedDB store.
 *
 * @example
 * {
 *   supabaseName: 'goals',
 *   columns: 'id,title,target,current_value,completed,order,deleted,created_at,updated_at,user_id,device_id',
 *   ownershipFilter: 'user_id',
 *   numericMergeFields: ['current_value'],
 *   excludeFromConflict: ['device_id'],
 * }
 */
export interface TableConfig {
  /** The table name in Supabase (snake_case). Also used as the API surface name. */
  supabaseName: string;
  /** Comma-separated column list for Supabase SELECT queries (egress optimization). */
  columns: string;
  /** Column name used to filter rows by the current user (e.g., `'user_id'`). */
  ownershipFilter?: string;
  /** If `true`, only one row per user exists (e.g., user settings). */
  isSingleton?: boolean;
  /** Fields to skip during conflict resolution (e.g., metadata fields). */
  excludeFromConflict?: string[];
  /** Numeric fields that should attempt additive merge during conflicts. */
  numericMergeFields?: string[];
  /** Optional callback invoked when a remote change arrives for this table via realtime. */
  onRemoteChange?: (table: string, record: Record<string, unknown>) => void;
}

// =============================================================================
// Module State
// =============================================================================

/** Singleton engine configuration (set by {@link initEngine}). */
let engineConfig: SyncEngineConfig | null = null;

/** Promise that resolves when the database is fully opened and upgraded. */
let _dbReady: Promise<void> | null = null;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize the sync engine with the provided configuration.
 *
 * Must be called once at app startup, before any other engine function.
 * Propagates the `prefix` to all internal modules (debug, deviceId,
 * Supabase client, runtime config) and creates or registers the Dexie
 * database instance.
 *
 * @param config - The full engine configuration object.
 *
 * @example
 * // In your app's root layout or entry point:
 * initEngine({
 *   prefix: 'myapp',
 *   tables: [...],
 *   database: { name: 'myapp-db', versions: [...] },
 * });
 */
export function initEngine(config: SyncEngineConfig): void {
  engineConfig = config;

  /* Propagate prefix to all internal modules that use localStorage keys. */
  if (config.prefix) {
    _setDebugPrefix(config.prefix);
    _setDeviceIdPrefix(config.prefix);
    _setClientPrefix(config.prefix);
    _setConfigPrefix(config.prefix);
  }

  /* Handle database creation — either managed or provided. */
  if (config.database) {
    _dbReady = createDatabase(config.database).then((db) => {
      /* Store on config for backward compat (engine.ts reads config.db). */
      (config as { db: Dexie }).db = db;
    });
  } else if (config.db) {
    /* Backward compat: use the consumer-provided Dexie instance. */
    _setManagedDb(config.db);
    _dbReady = Promise.resolve();
  }
}

// =============================================================================
// Accessors
// =============================================================================

/**
 * Wait for the database to be fully opened and upgraded.
 *
 * Must be awaited before any IndexedDB access. Returns immediately if
 * the database was provided directly (no async creation needed).
 *
 * @returns A promise that resolves when the DB is ready.
 */
export function waitForDb(): Promise<void> {
  return _dbReady || Promise.resolve();
}

/**
 * Get the current engine configuration.
 *
 * @throws {Error} If {@link initEngine} has not been called yet.
 * @returns The singleton {@link SyncEngineConfig} object.
 */
export function getEngineConfig(): SyncEngineConfig {
  if (!engineConfig) {
    throw new Error('Sync engine not initialized. Call initEngine() first.');
  }
  return engineConfig;
}

/**
 * Get the Dexie (IndexedDB) table name for a given table config entry.
 *
 * Derives the name from `supabaseName` via snake_case → camelCase conversion.
 *
 * @param table - A table configuration entry.
 * @returns The camelCase Dexie table name (e.g., `'goalLists'` for `'goal_lists'`).
 */
export function getDexieTableFor(table: TableConfig): string {
  return snakeToCamel(table.supabaseName);
}

/**
 * Build a lookup map from Supabase table names to Dexie table names.
 *
 * Used by {@link data.ts} to resolve table names at runtime.
 *
 * @returns An object mapping Supabase names → Dexie names.
 *
 * @example
 * getTableMap(); // { goal_lists: 'goalLists', goals: 'goals' }
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
 * Get the SELECT column list for a specific Supabase table.
 *
 * Used to build egress-optimized queries that only fetch needed columns.
 *
 * @param supabaseName - The Supabase table name (e.g., `'goals'`).
 * @throws {Error} If the table is not found in the engine config.
 * @returns The comma-separated column string.
 */
export function getTableColumns(supabaseName: string): string {
  const config = getEngineConfig();
  const table = config.tables.find((t) => t.supabaseName === supabaseName);
  if (!table) {
    throw new Error(`Table ${supabaseName} not found in engine config`);
  }
  return table.columns;
}
