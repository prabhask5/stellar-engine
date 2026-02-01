import type { SupabaseClient } from '@supabase/supabase-js';
import type Dexie from 'dexie';
import { _setDebugPrefix } from './debug';
import { _setDeviceIdPrefix } from './deviceId';
import { _setClientPrefix } from './supabase/client';
import { _setConfigPrefix } from './runtime/runtimeConfig';

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

let engineConfig: SyncEngineConfig | null = null;

export function initEngine(config: SyncEngineConfig): void {
  engineConfig = config;

  // Propagate prefix to all internal modules
  if (config.prefix) {
    _setDebugPrefix(config.prefix);
    _setDeviceIdPrefix(config.prefix);
    _setClientPrefix(config.prefix);
    _setConfigPrefix(config.prefix);
  }
}

export function getEngineConfig(): SyncEngineConfig {
  if (!engineConfig) {
    throw new Error('Sync engine not initialized. Call initEngine() first.');
  }
  return engineConfig;
}

/**
 * Get the Supabase-to-Dexie table mapping derived from config.
 */
export function getTableMap(): Record<string, string> {
  const config = getEngineConfig();
  const map: Record<string, string> = {};
  for (const table of config.tables) {
    map[table.supabaseName] = table.dexieTable;
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

/**
 * Get a TableConfig by its Supabase name.
 */
export function getTableConfig(supabaseName: string): TableConfig | undefined {
  const config = getEngineConfig();
  return config.tables.find(t => t.supabaseName === supabaseName);
}
