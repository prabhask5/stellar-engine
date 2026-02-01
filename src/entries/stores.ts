// Stores subpath barrel – @prabhask5/stellar-engine/stores
export { syncStatusStore } from '../stores/sync';
export type { SyncError, RealtimeState } from '../stores/sync';

export { remoteChangesStore } from '../stores/remoteChanges';
export type { RemoteActionType } from '../stores/remoteChanges';

export { isOnline } from '../stores/network';

export { authState, isAuthenticated, userDisplayInfo } from '../stores/authState';

// Lifecycle event subscriptions
export { onSyncComplete } from '../engine';
export { onRealtimeDataUpdate } from '../realtime';
