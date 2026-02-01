import type { SupabaseClient } from '@supabase/supabase-js';
import type Dexie from 'dexie';
export interface SyncEngineConfig {
    tables: TableConfig[];
    supabase: SupabaseClient;
    db: Dexie;
    prefix: string;
    auth?: {
        profileExtractor?: (userMetadata: Record<string, unknown>) => Record<string, unknown>;
        profileToMetadata?: (profile: Record<string, unknown>) => Record<string, unknown>;
        enableOfflineAuth?: boolean;
        sessionValidationIntervalMs?: number;
        confirmRedirectPath?: string;
    };
    syncDebounceMs?: number;
    syncIntervalMs?: number;
    tombstoneMaxAgeDays?: number;
    visibilitySyncMinAwayMs?: number;
    onlineReconnectCooldownMs?: number;
}
export interface TableConfig {
    supabaseName: string;
    dexieTable: string;
    columns: string;
    ownershipFilter?: string;
    isSingleton?: boolean;
    excludeFromConflict?: string[];
    numericMergeFields?: string[];
    onRemoteChange?: (table: string, record: Record<string, unknown>) => void;
}
export declare function initEngine(config: SyncEngineConfig): void;
export declare function getEngineConfig(): SyncEngineConfig;
/**
 * Get the Supabase-to-Dexie table mapping derived from config.
 */
export declare function getTableMap(): Record<string, string>;
/**
 * Get columns for a specific Supabase table from config.
 */
export declare function getTableColumns(supabaseName: string): string;
/**
 * Get a TableConfig by its Supabase name.
 */
export declare function getTableConfig(supabaseName: string): TableConfig | undefined;
//# sourceMappingURL=config.d.ts.map