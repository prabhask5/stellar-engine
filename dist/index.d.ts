/**
 * @fileoverview Main entry point — `@prabhask5/stellar-engine`
 *
 * This is the primary barrel export for the stellar-engine package. It
 * re-exports the **full** public API surface, covering:
 *
 * - **Engine Configuration & Lifecycle** — initialize, start, and run the
 *   offline-first sync engine.
 * - **Database Access** — get a handle to the IndexedDB instance or reset it.
 * - **Generic CRUD & Query** — create, read, update, delete, batch write,
 *   increment, and query data in the local database.
 * - **Authentication** — Supabase GoTrue auth, offline login, single-user
 *   (kiosk) auth, admin checks, device verification, and login guards.
 * - **Reactive Stores** — Svelte-compatible stores for sync status, network
 *   state, remote changes, and auth state.
 * - **Realtime Events** — lifecycle hooks for sync completion and realtime
 *   data updates.
 * - **Runtime Configuration** — read and write app-level config at runtime.
 * - **Debug & Utilities** — logging, ID generation, ordering, and string
 *   conversion helpers.
 * - **Svelte Actions** — DOM-level directives for remote-change animations.
 * - **Type Definitions** — all public TypeScript types and interfaces.
 * - **Supabase Client** — direct access to the Supabase client for advanced
 *   or custom queries.
 * - **Supabase Validation** — server-side credential and schema validation.
 *
 * For tree-shaking or smaller bundle sizes, prefer the subpath entry points
 * (e.g. `@prabhask5/stellar-engine/auth`, `@prabhask5/stellar-engine/stores`)
 * which expose focused subsets of this API.
 */
export { initEngine } from './config';
export type { SyncEngineConfig, TableConfig } from './config';
export { getDb, resetDatabase } from './database';
export type { DatabaseConfig, DatabaseVersionConfig } from './database';
export { startSyncEngine, runFullSync } from './engine';
export { onSyncComplete } from './engine';
export { engineCreate, engineUpdate, engineDelete, engineBatchWrite, engineIncrement } from './data';
export type { BatchOperation } from './data';
export { engineGet, engineGetAll, engineQuery, engineQueryRange, engineGetOrCreate } from './data';
export { signIn, signUp, signOut, changePassword, changeEmail, completeEmailChange, resendConfirmationEmail, getUserProfile, updateProfile, verifyOtp, getValidSession } from './supabase/auth';
export type { AuthResponse } from './supabase/auth';
export { resolveAuthState } from './auth/resolveAuthState';
export type { AuthStateResult } from './auth/resolveAuthState';
export { isAdmin } from './auth/admin';
export { resetLoginGuard } from './auth/loginGuard';
export { signInOffline, getOfflineLoginInfo } from './auth/offlineLogin';
export { isSingleUserSetUp, getSingleUserInfo, setupSingleUser, unlockSingleUser, lockSingleUser, changeSingleUserGate, updateSingleUserProfile, resetSingleUser, completeSingleUserSetup, completeDeviceVerification, pollDeviceVerification, padPin, changeSingleUserEmail, completeSingleUserEmailChange, fetchRemoteGateConfig, linkSingleUserDevice, resetSingleUserRemote } from './auth/singleUser';
export { isDeviceTrusted, trustCurrentDevice, trustPendingDevice, getTrustedDevices, removeTrustedDevice, maskEmail, sendDeviceVerification, getCurrentDeviceId, getDeviceLabel } from './auth/deviceVerification';
export { syncStatusStore } from './stores/sync';
export type { SyncError, RealtimeState } from './stores/sync';
export { remoteChangesStore } from './stores/remoteChanges';
export type { RemoteActionType } from './stores/remoteChanges';
export { isOnline } from './stores/network';
export { authState, isAuthenticated, userDisplayInfo } from './stores/authState';
export { onRealtimeDataUpdate } from './realtime';
export { supabase } from './supabase/client';
export { initConfig, getConfig, setConfig } from './runtime/runtimeConfig';
export type { AppConfig } from './runtime/runtimeConfig';
export { debug, isDebugMode, setDebugMode } from './debug';
export { generateId, now, calculateNewOrder, snakeToCamel } from './utils';
export { remoteChangeAnimation, trackEditing, triggerLocalAnimation } from './actions/remoteChange';
export type { SyncOperationItem, OperationType, OfflineCredentials, OfflineSession, ConflictHistoryEntry, SyncStatus, AuthMode, SingleUserConfig, SingleUserGateType, TrustedDevice } from './types';
export type { Session } from '@supabase/supabase-js';
export { validateSupabaseCredentials, validateSchema } from './supabase/validate';
//# sourceMappingURL=index.d.ts.map