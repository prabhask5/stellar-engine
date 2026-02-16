/**
 * @fileoverview Types subpath barrel — `@prabhask5/stellar-engine/types`
 *
 * Aggregates all public TypeScript type exports from the stellar-engine package
 * into a single, convenient entry point. Consumers can import any type from
 * this path without needing to know the internal module structure.
 *
 * No runtime code is emitted from this file — it contains only `export type`
 * statements and will be fully erased during compilation.
 */
export type { SyncEngineConfig, TableConfig } from '../config';
export type { DatabaseConfig, DatabaseVersionConfig } from '../database';
export type { BatchOperation } from '../data';
export type { AuthStateResult } from '../auth/resolveAuthState';
export type { AppConfig } from '../runtime/runtimeConfig';
export type { SyncOperationItem, OperationType, OfflineCredentials, OfflineSession, ConflictHistoryEntry, SyncStatus, AuthMode, SingleUserConfig, SingleUserGateType } from '../types';
export type { SyncError, RealtimeState } from '../stores/sync';
export type { RemoteActionType } from '../stores/remoteChanges';
export type { DiagnosticsSnapshot } from '../diagnostics';
export type { Session } from '@supabase/supabase-js';
export type { CRDTConfig, UserPresenceState } from '../crdt/types';
//# sourceMappingURL=types.d.ts.map