/**
 * @fileoverview Stores subpath barrel — `stellar-drive/stores`
 *
 * Re-exports all Svelte-compatible reactive stores and lifecycle event
 * subscription hooks. These stores provide real-time observability into the
 * engine's sync status, network connectivity, remote data changes, and
 * authentication state.
 *
 * All stores follow the Svelte store contract (subscribe/unsubscribe) and can
 * be used with the `$store` auto-subscription syntax in `.svelte` files.
 */
export { syncStatusStore } from '../stores/sync';
export type { SyncError, RealtimeState } from '../stores/sync';
export { remoteChangesStore } from '../stores/remoteChanges';
export type { RemoteActionType } from '../stores/remoteChanges';
export { isOnline } from '../stores/network';
export { authState, isAuthenticated, userDisplayInfo } from '../stores/authState';
export { onSyncComplete } from '../engine';
export { onRealtimeDataUpdate } from '../realtime';
export { createCollectionStore, createDetailStore } from '../stores/factories';
export type { CollectionStore, CollectionStoreConfig, DetailStore, DetailStoreConfig } from '../stores/factories';
//# sourceMappingURL=stores.d.ts.map