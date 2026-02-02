// Types subpath barrel – @prabhask5/stellar-engine/types
export type { SyncEngineConfig, TableConfig } from '../config';
export type { DatabaseConfig, DatabaseVersionConfig } from '../database';
export type { BatchOperation } from '../data';
export type { AuthResponse } from '../supabase/auth';
export type { AuthStateResult } from '../auth/resolveAuthState';
export type { AppConfig } from '../runtime/runtimeConfig';
export type { SyncOperationItem, OperationType, OfflineCredentials, OfflineSession, ConflictHistoryEntry, SyncStatus, AuthMode, SingleUserConfig, SingleUserGateType } from '../types';
export type { SyncError, RealtimeState } from '../stores/sync';
export type { RemoteActionType } from '../stores/remoteChanges';

// Re-export Session from Supabase so consumers don't need a direct dependency
export type { Session } from '@supabase/supabase-js';
