import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import type Dexie from 'dexie';
import type { SingleUserGateType } from './types';
import { type DatabaseConfig } from './database';
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
            codeLength?: 4 | 6;
        };
        profileExtractor?: (userMetadata: Record<string, unknown>) => Record<string, unknown>;
        profileToMetadata?: (profile: Record<string, unknown>) => Record<string, unknown>;
        enableOfflineAuth?: boolean;
        sessionValidationIntervalMs?: number;
        confirmRedirectPath?: string;
        /** Check if a user has admin privileges */
        adminCheck?: (user: User | null) => boolean;
        /** Device verification for untrusted devices (requires email OTP) */
        deviceVerification?: {
            enabled: boolean;
            trustDurationDays?: number;
        };
        /** Whether signup requires email confirmation */
        emailConfirmation?: {
            enabled: boolean;
        };
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
export declare function initEngine(config: SyncEngineConfig): void;
/**
 * Wait for the database to be fully opened and upgraded.
 * Must be awaited before any DB access.
 */
export declare function waitForDb(): Promise<void>;
export declare function getEngineConfig(): SyncEngineConfig;
/**
 * Get the Dexie (IndexedDB) table name for a TableConfig entry.
 * Derives from supabaseName via snake_case → camelCase conversion.
 */
export declare function getDexieTableFor(table: TableConfig): string;
/**
 * Get the Supabase-to-Dexie table mapping derived from config.
 */
export declare function getTableMap(): Record<string, string>;
/**
 * Get columns for a specific Supabase table from config.
 */
export declare function getTableColumns(supabaseName: string): string;
//# sourceMappingURL=config.d.ts.map