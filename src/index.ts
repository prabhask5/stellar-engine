// Config
export { initEngine } from './config';
export type { SyncEngineConfig, TableConfig } from './config';

// Database
export { getDb, resetDatabase } from './database';
export type { DatabaseConfig, DatabaseVersionConfig } from './database';

// Engine lifecycle
export { startSyncEngine, runFullSync } from './engine';
export { onSyncComplete } from './engine';

// Generic CRUD operations
export { engineCreate, engineUpdate, engineDelete, engineBatchWrite, engineIncrement } from './data';
export type { BatchOperation } from './data';

// Generic query operations
export { engineGet, engineGetAll, engineQuery, engineQueryRange, engineGetOrCreate } from './data';

// Auth
export { signIn, signUp, signOut, changePassword, resendConfirmationEmail, getUserProfile, updateProfile, verifyOtp, getValidSession } from './supabase/auth';
export type { AuthResponse } from './supabase/auth';

// Auth lifecycle
export { resolveAuthState } from './auth/resolveAuthState';
export type { AuthStateResult } from './auth/resolveAuthState';

// Admin
export { isAdmin } from './auth/admin';

// Offline login
export { signInOffline, getOfflineLoginInfo } from './auth/offlineLogin';

// Single-user auth
export { isSingleUserSetUp, getSingleUserInfo, setupSingleUser, unlockSingleUser, lockSingleUser, changeSingleUserGate, updateSingleUserProfile, resetSingleUser, completeSingleUserSetup, completeDeviceVerification, padPin } from './auth/singleUser';

// Device verification
export { isDeviceTrusted, trustCurrentDevice, getTrustedDevices, removeTrustedDevice, maskEmail, sendDeviceVerification, getCurrentDeviceId, getDeviceLabel } from './auth/deviceVerification';

// Stores
export { syncStatusStore } from './stores/sync';
export type { SyncError, RealtimeState } from './stores/sync';
export { remoteChangesStore } from './stores/remoteChanges';
export type { RemoteActionType } from './stores/remoteChanges';
export { isOnline } from './stores/network';
export { authState, isAuthenticated, userDisplayInfo } from './stores/authState';

// Realtime event subscriptions (app-specific event hooks)
export { onRealtimeDataUpdate } from './realtime';

// Supabase client (for advanced/custom queries)
export { supabase } from './supabase/client';

// Runtime config
export { initConfig, getConfig, setConfig } from './runtime/runtimeConfig';
export type { AppConfig } from './runtime/runtimeConfig';

// Debug
export { debug, isDebugMode, setDebugMode } from './debug';

// Utilities
export { generateId, now, calculateNewOrder, snakeToCamel } from './utils';

// Svelte actions
export { remoteChangeAnimation, trackEditing, triggerLocalAnimation } from './actions/remoteChange';

// Types
export type { SyncOperationItem, OperationType, OfflineCredentials, OfflineSession, ConflictHistoryEntry, SyncStatus, AuthMode, SingleUserConfig, SingleUserGateType, TrustedDevice } from './types';

// Re-export Session type from Supabase so consumers don't need a direct dependency
export type { Session } from '@supabase/supabase-js';

// Supabase credential validation (server-side setup flows)
export { validateSupabaseCredentials, validateSchema } from './supabase/validate';
