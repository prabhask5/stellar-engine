/**
 * @fileoverview Engine Configuration and Initialization
 *
 * Central configuration hub for the sync engine. {@link initEngine} is the
 * first function consumers call — it accepts a configuration object that
 * describes:
 *   - Which Supabase tables to sync and their IndexedDB schemas
 *   - Authentication configuration (single-user gate, offline auth, etc.)
 *   - Sync timing parameters (debounce, polling interval, tombstone TTL)
 *   - Optional callbacks for auth state changes
 *
 * The config is stored as a module-level singleton and accessed by every other
 * module via {@link getEngineConfig}. Supports two configuration modes:
 *   1. **Schema-driven** (recommended) — Provide a `schema` object. The engine
 *      auto-generates tables, Dexie stores, versioning, and database naming.
 *   2. **Manual** — Provide explicit `tables` and `database` for full control
 *      over IndexedDB versioning and migration history.
 *
 * @see {@link database.ts} for Dexie instance creation
 * @see {@link engine.ts} for the sync lifecycle that consumes this config
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import type Dexie from 'dexie';
import type { SingleUserGateType, SchemaDefinition, AuthConfig } from './types';
import type { CRDTConfig } from './crdt/types';
import type { DemoConfig } from './demo';
import { type DatabaseConfig } from './database';
/**
 * Top-level configuration for the sync engine.
 *
 * Passed to {@link initEngine} at app startup. Supports two configuration modes:
 *
 * 1. **Schema-driven** (recommended) — Provide a `schema` object. The engine
 *    auto-generates `tables`, Dexie stores, versioning, and database naming.
 * 2. **Manual** — Provide explicit `tables` and `database` for full control
 *    over IndexedDB versioning and migration history.
 *
 * The two modes are mutually exclusive (`schema` vs `tables` + `database`).
 *
 * @example
 * // Schema-driven (recommended):
 * initEngine({
 *   prefix: 'myapp',
 *   schema: {
 *     goals: 'goal_list_id, order',
 *     focus_settings: { singleton: true },
 *   },
 *   auth: { gateType: 'code', codeLength: 6 },
 * });
 */
export interface SyncEngineConfig {
    /** Per-table sync configuration. Auto-populated when using `schema`. */
    tables: TableConfig[];
    /** Application prefix — used for localStorage keys, debug logging, etc. */
    prefix: string;
    /** Human-readable app name (e.g., "Stellar Planner"). Included in Supabase user_metadata for email templates. */
    name: string;
    /** Production domain with protocol (e.g., "https://stellar.example.com"). Included in Supabase user_metadata for email templates. */
    domain: string;
    /**
     * Declarative schema definition — replaces both `tables` and `database`.
     *
     * Each key is a Supabase table name (snake_case). Values are either a string
     * of Dexie indexes or a {@link SchemaTableConfig} object for full control.
     * Mutually exclusive with `tables` + `database`.
     *
     * @see {@link SchemaDefinition} for the full type definition
     */
    schema?: SchemaDefinition;
    /**
     * Override the auto-generated database name when using `schema`.
     *
     * By default, the database is named `${prefix}DB` (e.g., `stellarDB`).
     * Use this to keep an existing database name for data continuity.
     */
    databaseName?: string;
    /** Dexie instance — set internally by `createDatabase()`. Do not set manually. */
    db?: Dexie;
    /** Supabase client — pass to use a custom client instead of the engine's internal proxy. */
    supabase?: SupabaseClient;
    /** Database creation config — auto-generated when using `schema`, or provided manually. */
    database?: DatabaseConfig;
    /** Authentication configuration (nested/internal form). */
    auth?: {
        /** Single-user mode gate configuration. */
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
    /**
     * Demo mode configuration. When provided, enables the demo mode system.
     * In demo mode, the app uses a separate sandboxed Dexie database, makes
     * zero Supabase connections, and seeds mock data on each page load.
     *
     * @see {@link DemoConfig} for the configuration shape
     */
    demo?: DemoConfig;
    /**
     * CRDT collaborative editing configuration.
     *
     * When provided, enables the CRDT subsystem — creates IndexedDB tables for
     * CRDT document storage and allows use of the `stellar-drive/crdt` API.
     * When omitted, no CRDT tables are created and CRDT imports will throw.
     *
     * Pass `true` as shorthand for `{}` (all defaults).
     *
     * @see {@link CRDTConfig} for available configuration options
     */
    crdt?: CRDTConfig | true;
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
    /** The actual table name in Supabase (prefixed, e.g., `'stellar_goals'`). */
    supabaseName: string;
    /**
     * The raw schema key (unprefixed, e.g., `'goals'`).
     * Used for Dexie table name derivation and consumer-facing API lookups.
     * When not set (manual config), falls back to `supabaseName`.
     */
    schemaKey?: string;
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
/**
 * Initialize the sync engine with the provided configuration.
 *
 * Must be called once at app startup, before any other engine function.
 * Propagates the `prefix` to all internal modules (debug, deviceId,
 * Supabase client, runtime config) and creates the Dexie database instance.
 *
 * @param config - The engine configuration object.
 *
 * @example
 * initEngine({
 *   prefix: 'myapp',
 *   schema: { goals: 'goal_list_id, order' },
 *   auth: { gateType: 'code', codeLength: 6 },
 * });
 */
/**
 * Input type for {@link initEngine}.
 *
 * Differs from {@link SyncEngineConfig} in two ways:
 * - `tables` is optional (auto-generated when `schema` is provided)
 * - `auth` accepts either the flat {@link AuthConfig} or the nested internal form
 */
export type InitEngineInput = Omit<SyncEngineConfig, 'tables' | 'auth'> & {
    tables?: TableConfig[];
    auth?: AuthConfig | SyncEngineConfig['auth'];
};
export declare function initEngine(config: InitEngineInput): void;
/**
 * Wait for the database to be fully opened and upgraded.
 *
 * Must be awaited before any IndexedDB access. Returns immediately if
 * the database was provided directly (no async creation needed).
 *
 * @returns A promise that resolves when the DB is ready.
 */
export declare function waitForDb(): Promise<void>;
/**
 * Get the current engine configuration.
 *
 * @throws {Error} If {@link initEngine} has not been called yet.
 * @returns The singleton {@link SyncEngineConfig} object.
 */
export declare function getEngineConfig(): SyncEngineConfig;
/**
 * Get the Dexie (IndexedDB) table name for a given table config entry.
 *
 * Derives the name from `supabaseName` via snake_case → camelCase conversion.
 *
 * @param table - A table configuration entry.
 * @returns The camelCase Dexie table name (e.g., `'goalLists'` for `'goal_lists'`).
 */
export declare function getDexieTableFor(table: TableConfig): string;
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
export declare function getTableMap(): Record<string, string>;
/**
 * Get the SELECT column list for a specific Supabase table.
 *
 * Used to build egress-optimized queries that only fetch needed columns.
 *
 * @param supabaseName - The Supabase table name (e.g., `'goals'`).
 * @throws {Error} If the table is not found in the engine config.
 * @returns The comma-separated column string.
 */
export declare function getTableColumns(name: string): string;
/**
 * Resolve a consumer-facing schema key to the actual Supabase table name.
 *
 * Consumers use unprefixed names (e.g., `'goals'`), but the actual Supabase
 * table is prefixed (e.g., `'stellar_goals'`). This function performs the
 * lookup. Falls back to the input name if no match is found (backward
 * compatibility with manual config or direct supabase name usage).
 *
 * @param schemaKey - The raw schema key (e.g., `'goals'`).
 * @returns The prefixed Supabase table name (e.g., `'stellar_goals'`).
 */
export declare function resolveSupabaseName(schemaKey: string): string;
//# sourceMappingURL=config.d.ts.map