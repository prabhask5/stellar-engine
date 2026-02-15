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

// =============================================================================
//  Sync Engine Configuration Types
// =============================================================================
// - `SyncEngineConfig` — top-level configuration passed to `initEngine`.
// - `TableConfig` — per-table sync configuration (conflict strategy, filters, etc.).

export type { SyncEngineConfig, TableConfig } from '../config';

// =============================================================================
//  Database Configuration Types
// =============================================================================
// - `DatabaseConfig` — IndexedDB database name, version, and schema definition.
// - `DatabaseVersionConfig` — per-version migration descriptor for DB upgrades.

export type { DatabaseConfig, DatabaseVersionConfig } from '../database';

// =============================================================================
//  Data Operation Types
// =============================================================================
// - `BatchOperation` — describes a single create/update/delete operation within
//   an `engineBatchWrite` call.

export type { BatchOperation } from '../data';

// =============================================================================
//  Auth State Types
// =============================================================================
// - `AuthStateResult` — result of `resolveAuthState`, describing the user's
//   current authentication status at app startup.

export type { AuthStateResult } from '../auth/resolveAuthState';

// =============================================================================
//  Runtime Configuration Types
// =============================================================================
// - `AppConfig` — shape of the application's runtime configuration object.

export type { AppConfig } from '../runtime/runtimeConfig';

// =============================================================================
//  Core Domain Types
// =============================================================================
// Fundamental types used throughout the engine:
// - `SyncOperationItem` — a queued sync operation (create/update/delete + payload).
// - `OperationType` — union: `'create' | 'update' | 'delete'`.
// - `OfflineCredentials` / `OfflineSession` — cached auth data for offline login.
// - `ConflictHistoryEntry` — record of a resolved sync conflict.
// - `SyncStatus` — union of sync lifecycle states (`'idle' | 'syncing' | 'error'`).
// - `AuthMode` — the active authentication strategy.
// - `SingleUserConfig` — configuration for single-user (kiosk) mode.
// - `SingleUserGateType` — the type of gate (PIN, password, etc.).

export type {
  SyncOperationItem,
  OperationType,
  OfflineCredentials,
  OfflineSession,
  ConflictHistoryEntry,
  SyncStatus,
  AuthMode,
  SingleUserConfig,
  SingleUserGateType
} from '../types';

// =============================================================================
//  Store-Related Types
// =============================================================================
// - `SyncError` — per-entity error details surfaced by the sync status store.
// - `RealtimeState` — Supabase Realtime connection state union.
// - `RemoteActionType` — the kind of remote change (insert, update, delete).

export type { SyncError, RealtimeState } from '../stores/sync';
export type { RemoteActionType } from '../stores/remoteChanges';

// =============================================================================
//  Third-Party Re-exports
// =============================================================================
// Re-export the Supabase `Session` type so consumers do not need a direct
// `@supabase/supabase-js` dependency to type-check session objects.

export type { Session } from '@supabase/supabase-js';
