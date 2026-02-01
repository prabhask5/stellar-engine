// Config
export { initEngine, getEngineConfig } from './config';
// Engine lifecycle
export { startSyncEngine, stopSyncEngine } from './engine';
export { scheduleSyncPush, runFullSync, forceFullSync, resetSyncCursor } from './engine';
export { hydrateFromRemote, reconcileLocalWithRemote, performSync } from './engine';
export { clearLocalCache, clearPendingSyncQueue } from './engine';
// Entity modification tracking
export { markEntityModified, onSyncComplete } from './engine';
// Auth
export { markOffline, markAuthValidated, needsAuthValidation } from './engine';
export { signIn, signUp, signOut, getSession, isSessionExpired, changePassword, resendConfirmationEmail, getUserProfile, updateProfile } from './supabase/auth';
export { cacheOfflineCredentials, getOfflineCredentials, verifyOfflineCredentials, clearOfflineCredentials, updateOfflineCredentialsPassword, updateOfflineCredentialsProfile } from './auth/offlineCredentials';
export { createOfflineSession, getOfflineSession, getValidOfflineSession, hasValidOfflineSession, clearOfflineSession, getOfflineSessionInfo } from './auth/offlineSession';
// Queue operations (for app repositories to call)
export { queueSyncOperation, queueIncrementOperation, queueSetOperation, queueMultiFieldSetOperation, queueCreateOperation, queueDeleteOperation } from './queue';
export { coalescePendingOps, getPendingSync, getPendingEntityIds } from './queue';
// Conflict resolution
export { resolveConflicts, getConflictHistory } from './conflicts';
// Realtime
export { startRealtimeSubscriptions, stopRealtimeSubscriptions, isRealtimeHealthy, getConnectionState, wasRecentlyProcessedByRealtime, onRealtimeDataUpdate } from './realtime';
// Stores
export { syncStatusStore } from './stores/sync';
export { remoteChangesStore, createRecentChangeIndicator, createPendingDeleteIndicator } from './stores/remoteChanges';
export { isOnline } from './stores/network';
export { authState, isAuthenticated, userDisplayInfo } from './stores/authState';
// Supabase client
export { supabase, getSupabaseAsync, resetSupabaseClient } from './supabase/client';
// Runtime config
export { initConfig, getConfig, waitForConfig, isConfigured, setConfig, clearConfigCache } from './runtime/runtimeConfig';
// Device ID
export { getDeviceId } from './deviceId';
// Debug
export { debugLog, debugWarn, debugError, isDebugMode, setDebugMode } from './debug';
// Reconnect handler
export { setReconnectHandler, callReconnectHandler } from './reconnectHandler';
// Utilities
export { generateId, now, calculateNewOrder } from './utils';
// Svelte actions
export { remoteChangeAnimation, trackEditing, triggerLocalAnimation } from './actions/remoteChange';
export { isOperationItem } from './types';
//# sourceMappingURL=index.js.map