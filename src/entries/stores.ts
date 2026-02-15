/**
 * @fileoverview Stores subpath barrel — `@prabhask5/stellar-engine/stores`
 *
 * Re-exports all Svelte-compatible reactive stores and lifecycle event
 * subscription hooks. These stores provide real-time observability into the
 * engine's sync status, network connectivity, remote data changes, and
 * authentication state.
 *
 * All stores follow the Svelte store contract (subscribe/unsubscribe) and can
 * be used with the `$store` auto-subscription syntax in `.svelte` files.
 */

// =============================================================================
//  Sync Status Store
// =============================================================================
// Exposes the current state of the sync engine: whether it is idle, syncing,
// or in error; the number of pending local changes; the last error message;
// the realtime connection state; and the timestamp of the last successful sync.

export { syncStatusStore } from '../stores/sync';
export type { SyncError, RealtimeState } from '../stores/sync';

// =============================================================================
//  Remote Changes Store
// =============================================================================
// Tracks incoming remote changes from other devices via Supabase Realtime.
// Provides methods to check for deferred changes (changes that arrived while
// the user was actively editing an entity) and to clear them after the user
// has acknowledged or dismissed the notification.

export { remoteChangesStore } from '../stores/remoteChanges';
export type { RemoteActionType } from '../stores/remoteChanges';

// =============================================================================
//  Network Connectivity Store
// =============================================================================
// A boolean Svelte store that reflects the browser's online/offline status.
// Automatically updates via `navigator.onLine` and `online`/`offline` events.

export { isOnline } from '../stores/network';

// =============================================================================
//  Auth State Stores
// =============================================================================
// Reactive stores for the current authentication state:
// - `authState` — full auth state object (user, session, mode, etc.).
// - `isAuthenticated` — derived boolean: `true` when a valid session exists.
// - `userDisplayInfo` — derived store with the user's display name and avatar.

export { authState, isAuthenticated, userDisplayInfo } from '../stores/authState';

// =============================================================================
//  Lifecycle Event Subscriptions
// =============================================================================
// Callback registration hooks for engine lifecycle events:
// - `onSyncComplete` — fires after every successful sync cycle completes.
// - `onRealtimeDataUpdate` — fires when a realtime payload is received and
//   applied to the local database.

export { onSyncComplete } from '../engine';
export { onRealtimeDataUpdate } from '../realtime';

// =============================================================================
//  Store Factories
// =============================================================================
// Generic factory functions that create Svelte-compatible reactive stores for
// common data-loading patterns. These eliminate the repetitive loading-state /
// sync-listener / refresh boilerplate from every collection or detail store.

export { createCollectionStore, createDetailStore } from '../stores/factories';
export type {
  CollectionStore,
  CollectionStoreConfig,
  DetailStore,
  DetailStoreConfig
} from '../stores/factories';
