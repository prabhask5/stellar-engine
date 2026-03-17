/**
 * @fileoverview Main entry point — `stellar-drive`
 *
 * This is the primary barrel export for the stellar-drive package. It
 * re-exports the **full** public API surface, covering:
 *
 * - **Engine Configuration & Lifecycle** — initialize, start, and run the
 *   offline-first sync engine.
 * - **Database Access** — get a handle to the IndexedDB instance or reset it.
 * - **Generic CRUD & Query** — create, read, update, delete, batch write,
 *   increment, and query data in the local database.
 * - **Authentication** — Single-user PIN/password gate auth, device
 *   verification, login guards, and session management.
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
 * (e.g. `stellar-drive/auth`, `stellar-drive/stores`)
 * which expose focused subsets of this API.
 */
// =============================================================================
//  Engine Configuration
// =============================================================================
// `initEngine` bootstraps the sync engine with the provided configuration
// (Supabase credentials, table definitions, conflict strategies, etc.).
// `SyncEngineConfig` and `TableConfig` describe the configuration shape.
export { initEngine } from './config';
// =============================================================================
//  Database Access
// =============================================================================
// Direct access to the underlying IndexedDB database:
// - `getDb` — returns a typed handle to the open database instance.
// - `resetDatabase` — deletes and re-creates the local database (destructive).
export { getDb, resetDatabase } from './database';
export { SYSTEM_INDEXES, computeSchemaVersion } from './database';
// =============================================================================
//  Engine Lifecycle
// =============================================================================
// Controls for the sync engine's runtime lifecycle:
// - `startSyncEngine` — begins periodic background sync and realtime
//   subscription after the engine has been initialized.
// - `runFullSync` — triggers an immediate full sync cycle (push + pull).
// - `onSyncComplete` — registers a callback that fires after each successful
//   sync cycle (useful for refreshing UI or derived data).
export { startSyncEngine, runFullSync, repairSyncQueue } from './engine';
export { onSyncComplete } from './engine';
// =============================================================================
//  Generic CRUD Operations
// =============================================================================
// Framework-agnostic data mutation functions that write to IndexedDB and queue
// changes for the next sync cycle:
// - `engineCreate` — inserts a new entity.
// - `engineUpdate` — patches an existing entity.
// - `engineDelete` — marks an entity as deleted (soft-delete for sync).
// - `engineBatchWrite` — applies multiple operations atomically.
// - `engineIncrement` — atomically increments a numeric field.
export { engineCreate, engineUpdate, engineDelete, engineBatchWrite, engineIncrement } from './data';
// =============================================================================
//  Generic Query Operations
// =============================================================================
// Read-only data access functions that query the local IndexedDB:
// - `engineGet` — retrieves a single entity by primary key.
// - `engineGetAll` — retrieves all entities in a table.
// - `engineQuery` — retrieves entities matching a key-value filter.
// - `engineQueryRange` — retrieves entities within an IDB key range.
// - `engineGetOrCreate` — retrieves an entity or creates it with defaults.
export { engineGet, engineGetAll, engineQuery, engineQueryRange, engineGetOrCreate } from './data';
// =============================================================================
//  Query & Repository Helpers
// =============================================================================
// Convenience wrappers that eliminate repetitive query and repository patterns:
// - `queryAll` — fetches all non-deleted records, sorted by order.
// - `queryOne` — fetches a single non-deleted record by ID.
// - `reorderEntity` — updates just the order field on any entity.
// - `prependOrder` — computes the next prepend-order value.
export { queryAll, queryOne, reorderEntity, prependOrder } from './data';
// =============================================================================
//  Supabase Auth — Core Authentication Utilities
// =============================================================================
// Sign-out with full teardown, session management, profile CRUD, email
// confirmation resend, OTP verification, and session validation.
export { signOut, resendConfirmationEmail, getUserProfile, updateProfile, verifyOtp, getValidSession } from './supabase/auth';
// =============================================================================
//  Auth State Resolution
// =============================================================================
// Determines the user's authentication state during app initialization.
// Returns an `AuthStateResult` describing whether the user is authenticated,
// anonymous, has an expired session, or needs setup.
export { resolveAuthState } from './auth/resolveAuthState';
// =============================================================================
//  Login Guard
// =============================================================================
// Prevents duplicate login attempts by maintaining a transient lock.
// `resetLoginGuard` clears the lock (e.g. after a failed attempt).
export { resetLoginGuard } from './auth/loginGuard';
// =============================================================================
//  Single-User Auth (PIN/Password Gate)
// =============================================================================
// Full lifecycle for single-user (kiosk/personal device) authentication:
// setup, lock/unlock, profile management, device linking, and remote config.
export { isSingleUserSetUp, getSingleUserInfo, setupSingleUser, unlockSingleUser, lockSingleUser, changeSingleUserGate, updateSingleUserProfile, resetSingleUser, completeSingleUserSetup, completeDeviceVerification, pollDeviceVerification, padPin, changeSingleUserEmail, completeSingleUserEmailChange, fetchRemoteGateConfig, linkSingleUserDevice, resetSingleUserRemote } from './auth/singleUser';
// =============================================================================
//  Auth Display Utilities
// =============================================================================
// Pure helper functions that resolve user-facing display values from the auth
// state. Each handles the full fallback chain across online (Supabase session)
// and offline (cached credential) modes.
export { resolveFirstName, resolveUserId, resolveAvatarInitial } from './auth/displayUtils';
// =============================================================================
//  Device Verification
// =============================================================================
// Trust management for multi-device single-user setups:
// - `isDeviceTrusted` / `trustCurrentDevice` / `trustPendingDevice` — manage
//   the trust status of the current or a pending device.
// - `getTrustedDevices` / `removeTrustedDevice` — list and revoke trusted devices.
// - `maskEmail` — partially masks an email for display during verification.
// - `sendDeviceVerification` — initiates the device verification email flow.
// - `getCurrentDeviceId` / `getDeviceLabel` — device identification helpers.
export { isDeviceTrusted, trustCurrentDevice, trustPendingDevice, getTrustedDevices, removeTrustedDevice, maskEmail, sendDeviceVerification, getCurrentDeviceId, getDeviceLabel } from './auth/deviceVerification';
// =============================================================================
//  Reactive Stores
// =============================================================================
// Svelte-compatible stores providing real-time observability into the engine:
// - `syncStatusStore` — sync lifecycle state, pending count, errors, realtime state.
// - `remoteChangesStore` — incoming remote changes and deferred-change tracking.
// - `isOnline` — boolean reflecting browser online/offline status.
// - `authState` / `isAuthenticated` / `userDisplayInfo` — auth state stores.
export { syncStatusStore } from './stores/sync';
export { remoteChangesStore } from './stores/remoteChanges';
export { isOnline } from './stores/network';
export { authState, isAuthenticated, userDisplayInfo } from './stores/authState';
// =============================================================================
//  Store Factories
// =============================================================================
// Generic factory functions for creating reactive stores with built-in loading
// state and sync-complete auto-refresh.
export { createCollectionStore, createDetailStore } from './stores/factories';
// =============================================================================
//  Realtime Event Subscriptions
// =============================================================================
// Callback registration for app-specific event hooks. `onRealtimeDataUpdate`
// fires when a realtime payload is received and applied to the local database,
// allowing the app to react to cross-device changes.
export { onRealtimeDataUpdate } from './realtime';
// =============================================================================
//  Supabase Client (Advanced / Custom Queries)
// =============================================================================
// Direct access to the initialized Supabase client instance. Use this for
// queries or operations not covered by the generic CRUD layer (e.g. RPC calls,
// storage operations, or custom PostgREST filters).
export { supabase } from './supabase/client';
// =============================================================================
//  Runtime Configuration
// =============================================================================
// Application-level configuration store:
// - `initConfig` — initializes with defaults on app boot.
// - `getConfig` — reads the current configuration snapshot.
// - `setConfig` — merges partial updates into the active configuration.
// - `probeNetworkReachability` — async probe that tests actual connectivity.
// - `isOffline` — synchronous check: is the device effectively offline?
// - `setOfflineFlag` — manual offline flag control (internal / SW bridge).
export { initConfig, getConfig, setConfig, probeNetworkReachability, isOffline, setOfflineFlag } from './runtime/runtimeConfig';
// =============================================================================
//  Debug Utilities
// =============================================================================
// Development-time logging and debug mode management:
// - `debug` — conditional logger (only outputs when debug mode is active).
// - `isDebugMode` / `setDebugMode` — query and toggle debug mode at runtime.
export { debug, isDebugMode, setDebugMode } from './debug';
// =============================================================================
//  General Utilities
// =============================================================================
// Pure helper functions:
// - `generateId` — produces a unique identifier.
// - `now` — returns the current ISO 8601 timestamp.
// - `calculateNewOrder` — computes fractional order for reorderable lists.
// - `snakeToCamel` — converts `snake_case` to `camelCase`.
export { generateId, now, calculateNewOrder, snakeToCamel, formatBytes } from './utils';
// =============================================================================
//  Diagnostics
// =============================================================================
// Unified diagnostics API for inspecting sync engine internal state.
// `getDiagnostics()` returns a comprehensive JSON snapshot; sub-category
// functions provide lightweight access to specific sections.
export { getDiagnostics, getSyncDiagnostics, getRealtimeDiagnostics, getQueueDiagnostics, getConflictDiagnostics, getEngineDiagnostics, getNetworkDiagnostics, getErrorDiagnostics } from './diagnostics';
// =============================================================================
//  Svelte Actions
// =============================================================================
// DOM-level `use:action` directives for remote-change visual feedback:
// - `remoteChangeAnimation` — applies a highlight/pulse when a remote update arrives.
// - `trackEditing` — marks an element as actively being edited.
// - `triggerLocalAnimation` — manually fires the animation for local feedback.
export { remoteChangeAnimation, trackEditing, triggerLocalAnimation } from './actions/remoteChange';
// =============================================================================
//  Demo Mode
// =============================================================================
// Demo mode provides a completely isolated sandbox for consumer apps:
// - `isDemoMode` — checks whether the app is running in demo mode.
// - `setDemoMode` — activates or deactivates demo mode (requires page reload).
// - `seedDemoData` — seeds the demo database with mock data (idempotent).
// - `cleanupDemoDatabase` — deletes the demo database entirely.
// - `DemoConfig` — configuration interface for demo mode.
export { isDemoMode, setDemoMode, seedDemoData, cleanupDemoDatabase, getDemoConfig } from './demo';
// =============================================================================
//  SQL Generation
// =============================================================================
// Generate complete Supabase SQL from a declarative schema definition.
// These are also available via `stellar-drive/utils`.
export { generateSupabaseSQL, inferColumnType, generateTypeScript } from './schema';
// =============================================================================
//  Supabase Credential Validation (Server-Side)
// =============================================================================
// Server-side utilities for validating Supabase credentials and database
// schema during initial app setup flows:
// - `validateSupabaseCredentials` — tests that the provided URL and publishable key
//   can successfully connect to a Supabase project.
// - `validateSchema` — verifies that the required database tables and columns
//   exist in the connected Supabase project.
export { validateSupabaseCredentials, validateSchema } from './supabase/validate';
//# sourceMappingURL=index.js.map