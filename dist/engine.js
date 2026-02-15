/**
 * @fileoverview Local-First Sync Engine - Core orchestrator for offline-first data synchronization.
 *
 * This is the heart of stellar-engine: a bidirectional sync engine that keeps local
 * IndexedDB (via Dexie) in sync with a remote Supabase database. It implements the
 * "local-first" pattern where all reads/writes happen against the local DB for instant
 * responsiveness, and a background sync loop reconciles with the server.
 *
 * ## Architecture Overview
 *
 * ```
 * ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
 * │   UI Layer   │────▶│  Local DB    │────▶│  Sync Engine │────▶ Supabase
 * │  (instant)   │◀────│  (IndexedDB) │◀────│  (background)│◀──── (remote)
 * └─────────────┘     └──────────────┘     └──────────────┘
 * ```
 *
 * ## Core Rules
 *
 * 1. **All reads come from local DB** (IndexedDB via Dexie)
 * 2. **All writes go to local DB first**, immediately (no waiting for network)
 * 3. **Every write creates a pending operation** in the sync queue (outbox pattern)
 * 4. **Sync loop ships outbox to server** in the background (push phase)
 * 5. **On refresh, load local state instantly**, then run background sync (pull phase)
 *
 * ## Sync Cycle Flow
 *
 * 1. **Push**: Coalesce pending ops → send to Supabase → remove from queue
 * 2. **Pull**: Fetch changes since last cursor → apply with conflict resolution → update cursor
 * 3. **Notify**: Tell registered stores to refresh from local DB
 *
 * ## Key Subsystems
 *
 * - **Egress monitoring**: Tracks bytes/records transferred for debugging bandwidth usage
 * - **Sync lock (mutex)**: Prevents concurrent sync cycles from corrupting state
 * - **Watchdog**: Detects stuck syncs and auto-releases locks after timeout
 * - **Tombstone cleanup**: Garbage-collects soft-deleted records after configured TTL
 * - **Auth validation**: Ensures valid session before syncing (prevents silent RLS failures)
 * - **Visibility sync**: Smart re-sync when user returns to tab after extended absence
 * - **Realtime integration**: Skips polling pull when WebSocket subscription is healthy
 *
 * ## Egress Optimization Strategy
 *
 * The engine aggressively minimizes Supabase egress (bandwidth) through:
 * - Operation coalescing (50 rapid updates → 1 request)
 * - Push-only mode when realtime is healthy (skip pull after local writes)
 * - Cached user validation (1 getUser() call per hour instead of per sync)
 * - Visibility-aware sync (skip sync if tab was hidden briefly)
 * - Reconnect cooldown (skip sync if we just synced before going offline)
 * - Selective column fetching (only request configured columns, not `*`)
 *
 * @module engine
 * @see {@link ./queue.ts} - Sync queue (outbox) management
 * @see {@link ./conflicts.ts} - Field-level conflict resolution
 * @see {@link ./realtime.ts} - Supabase Realtime WebSocket subscriptions
 * @see {@link ./config.ts} - Engine configuration and table definitions
 */
import { getEngineConfig, getDexieTableFor, waitForDb } from './config';
import { debugLog, debugWarn, debugError, isDebugMode } from './debug';
import { getPendingSync, removeSyncItem, incrementRetry, getPendingEntityIds, cleanupFailedItems, coalescePendingOps, queueSyncOperation } from './queue';
import { getDeviceId } from './deviceId';
import { syncStatusStore } from './stores/sync';
import { resolveConflicts, storeConflictHistory, cleanupConflictHistory, getPendingOpsForEntity } from './conflicts';
import { startRealtimeSubscriptions, stopRealtimeSubscriptions, onRealtimeDataUpdate, onConnectionStateChange, cleanupRealtimeTracking, isRealtimeHealthy, pauseRealtime, wasRecentlyProcessedByRealtime } from './realtime';
import { isOnline } from './stores/network';
import { getSession } from './supabase/auth';
import { supabase as supabaseProxy } from './supabase/client';
import { getOfflineCredentials } from './auth/offlineCredentials';
import { getValidOfflineSession, createOfflineSession } from './auth/offlineSession';
import { validateSchema } from './supabase/validate';
import { formatBytes } from './utils';
import { getDiagnostics } from './diagnostics';
import { isDemoMode } from './demo';
// =============================================================================
// CONFIG ACCESSORS
// =============================================================================
//
// These helper functions provide lazy access to engine configuration values.
// They exist because the engine config is set at runtime via `initEngine()`,
// so we can't read config values at module load time (they'd be undefined).
// Each function reads from the live config on every call to support hot-reloading.
// =============================================================================
/**
 * Get the Dexie database instance from the engine config.
 *
 * @returns The initialized Dexie database
 * @throws {Error} If the database hasn't been initialized via `initEngine()`
 */
function getDb() {
    const db = getEngineConfig().db;
    if (!db)
        throw new Error('Database not initialized. Provide db or database config to initEngine().');
    return db;
}
/**
 * Get the Supabase client instance.
 *
 * Prefers the explicitly-provided client from config, falling back to the
 * proxy-based client (which defers initialization until first use).
 *
 * @returns The Supabase client for server communication
 */
function getSupabase() {
    const config = getEngineConfig();
    if (config.supabase)
        return config.supabase;
    return supabaseProxy;
}
/**
 * Map a Supabase table name to its corresponding Dexie (local) table name.
 *
 * Table name mapping allows the local DB schema to differ from the remote schema.
 * Falls back to using the Supabase name directly if no mapping is configured.
 *
 * @param supabaseName - The remote Supabase table name
 * @returns The local Dexie table name (may include a prefix)
 */
function getDexieTableName(supabaseName) {
    const table = getEngineConfig().tables.find((t) => t.supabaseName === supabaseName);
    return table ? getDexieTableFor(table) : supabaseName;
}
/**
 * Get the column selection string for a Supabase table.
 *
 * Used in SELECT queries to limit which columns are fetched from the server.
 * This is an **egress optimization** — fetching only needed columns reduces
 * bandwidth usage, especially for tables with large text/JSON columns.
 *
 * @param supabaseName - The remote Supabase table name
 * @returns PostgREST column selector (e.g., `"id,name,updated_at"` or `"*"`)
 */
function getColumns(supabaseName) {
    const table = getEngineConfig().tables.find((t) => t.supabaseName === supabaseName);
    return table?.columns || '*';
}
/**
 * Check if a Supabase table is configured as a singleton (one row per user).
 *
 * Singleton tables have special handling during sync: when a duplicate key
 * error occurs on create, the engine reconciles the local ID with the server's
 * existing row instead of treating it as an error.
 *
 * @param supabaseName - The remote Supabase table name
 * @returns `true` if the table is a singleton
 */
function isSingletonTable(supabaseName) {
    const table = getEngineConfig().tables.find((t) => t.supabaseName === supabaseName);
    return table?.isSingleton || false;
}
// --- Timing & Threshold Config Accessors ---
// Each has a sensible default if not configured by the consumer.
/** Delay before pushing local writes to server (debounces rapid edits). Default: 2000ms */
function getSyncDebounceMs() {
    return getEngineConfig().syncDebounceMs ?? 2000;
}
/** Interval for periodic background sync (polling fallback when realtime is down). Default: 15min */
function getSyncIntervalMs() {
    return getEngineConfig().syncIntervalMs ?? 900000;
}
/** How long to keep soft-deleted (tombstone) records before hard-deleting. Default: 7 days */
function getTombstoneMaxAgeDays() {
    return getEngineConfig().tombstoneMaxAgeDays ?? 7;
}
/** Minimum time tab must be hidden before triggering a sync on return. Default: 5min */
function getVisibilitySyncMinAwayMs() {
    return getEngineConfig().visibilitySyncMinAwayMs ?? 300000;
}
/** Cooldown after a successful sync before allowing reconnect-triggered sync. Default: 2min */
function getOnlineReconnectCooldownMs() {
    return getEngineConfig().onlineReconnectCooldownMs ?? 120000;
}
/** Engine prefix used for localStorage keys and debug window utilities. Default: "engine" */
function getPrefix() {
    return getEngineConfig().prefix || 'engine';
}
// =============================================================================
// AUTH STATE TRACKING
// =============================================================================
//
// When the device goes offline and comes back online, we must re-validate the
// user's session before allowing any sync operations. Without this, an expired
// or revoked session could cause Supabase RLS to silently block all writes
// (returning success but affecting 0 rows — the "ghost sync" bug).
// =============================================================================
/** Whether the device was recently offline (triggers auth validation on reconnect) */
let wasOffline = false;
/** Whether auth has been validated since the last offline→online transition. Starts `true` (no validation needed on fresh start) */
let authValidatedAfterReconnect = true;
/** One-time flag: has the Supabase schema been validated this session? */
let _schemaValidated = false;
/**
 * Clear all pending sync operations from the outbox queue.
 *
 * **SECURITY**: Called when offline credentials are found to be invalid, to prevent
 * unauthorized data from being synced to the server. Without this, a user who
 * tampered with offline credentials could queue malicious writes that get pushed
 * once the device reconnects.
 *
 * @returns The number of operations that were cleared
 *
 * @example
 * ```ts
 * // Called during auth validation failure
 * const cleared = await clearPendingSyncQueue();
 * console.log(`Prevented ${cleared} unauthorized sync operations`);
 * ```
 */
export async function clearPendingSyncQueue() {
    try {
        const db = getDb();
        const count = await db.table('syncQueue').count();
        await db.table('syncQueue').clear();
        debugLog(`[SYNC] Cleared ${count} pending sync operations (auth invalid)`);
        return count;
    }
    catch (e) {
        debugError('[SYNC] Failed to clear sync queue:', e);
        return 0;
    }
}
/**
 * Mark that we need auth validation before next sync
 * Called when going offline
 */
function markOffline() {
    wasOffline = true;
    authValidatedAfterReconnect = false;
}
/**
 * Mark auth as validated (safe to sync)
 * Called after successful credential validation on reconnect
 */
function markAuthValidated() {
    authValidatedAfterReconnect = true;
    wasOffline = false;
}
/**
 * Check if auth needs validation before syncing
 */
function needsAuthValidation() {
    return wasOffline && !authValidatedAfterReconnect;
}
/** Rolling log of recent sync cycles (max 100 entries) */
const syncStats = [];
/** Total number of sync cycles since page load */
let totalSyncCycles = 0;
const egressStats = {
    totalBytes: 0,
    totalRecords: 0,
    byTable: {},
    sessionStart: new Date().toISOString()
};
/**
 * Estimate the byte size of a JSON-serializable value.
 *
 * Uses `Blob` for accurate UTF-8 byte counting when available,
 * falling back to string length (which undercounts multi-byte chars).
 *
 * @param data - Any JSON-serializable value
 * @returns Estimated size in bytes
 */
function estimateJsonSize(data) {
    try {
        return new Blob([JSON.stringify(data)]).size;
    }
    catch {
        // Fallback: rough estimate based on JSON string length
        return JSON.stringify(data).length;
    }
}
/**
 * Record egress (data downloaded) for a specific table.
 *
 * Updates both the per-table and global cumulative counters. Called after
 * every Supabase SELECT query to build an accurate picture of bandwidth usage.
 *
 * @param tableName - The Supabase table name
 * @param data - The rows returned from the query (null/empty = no egress)
 * @returns The bytes and record count for this specific fetch
 */
function trackEgress(tableName, data) {
    if (!data || data.length === 0) {
        return { bytes: 0, records: 0 };
    }
    const bytes = estimateJsonSize(data);
    const records = data.length;
    // Update totals
    egressStats.totalBytes += bytes;
    egressStats.totalRecords += records;
    // Update per-table stats
    if (!egressStats.byTable[tableName]) {
        egressStats.byTable[tableName] = { bytes: 0, records: 0 };
    }
    egressStats.byTable[tableName].bytes += bytes;
    egressStats.byTable[tableName].records += records;
    return { bytes, records };
}
/**
 * Record a completed sync cycle in the rolling stats log.
 *
 * Automatically timestamps the entry and trims the log to 100 entries.
 * Also emits a debug log line summarizing the cycle for real-time monitoring.
 *
 * @param stats - Sync cycle metrics (trigger, items pushed/pulled, egress, duration)
 */
function logSyncCycle(stats) {
    const entry = {
        ...stats,
        timestamp: new Date().toISOString()
    };
    syncStats.push(entry);
    totalSyncCycles++;
    // Keep only last 100 entries
    if (syncStats.length > 100) {
        syncStats.shift();
    }
    debugLog(`[SYNC] Cycle #${totalSyncCycles}: ` +
        `trigger=${stats.trigger}, pushed=${stats.pushedItems}, ` +
        `pulled=${stats.pulledRecords} records (${formatBytes(stats.egressBytes)}), ${stats.durationMs}ms`);
}
// =============================================================================
// MODULE-LEVEL STATE
// =============================================================================
//
// These variables track the engine's runtime state. They're module-scoped
// (not class properties) because the engine is a singleton — there's only ever
// one sync engine per page. All state is reset by `stopSyncEngine()`.
// =============================================================================
/** Timer handle for the debounced sync-after-write (cleared on each new write) */
let syncTimeout = null;
/** Timer handle for the periodic background sync interval */
let syncInterval = null;
/** Whether initial hydration (empty-DB pull) has been attempted this session */
let _hasHydrated = false;
// --- EGRESS OPTIMIZATION: Cached user validation ---
// `getUser()` makes a network round-trip to Supabase. Calling it every sync cycle
// wastes bandwidth. Instead, we cache the result and only re-validate once per hour.
// If the token is revoked server-side between validations, the push will fail with
// an RLS error — which is acceptable since it triggers a session refresh.
/** Timestamp of the last successful `getUser()` network call */
let lastUserValidation = 0;
/** User ID returned by the last successful `getUser()` call */
let lastValidatedUserId = null;
/** How often to re-validate the user with a network call (1 hour) */
const USER_VALIDATION_INTERVAL_MS = 60 * 60 * 1000;
// --- Sync timing & visibility tracking ---
/** Timestamp of the last successful sync completion (used for reconnect cooldown) */
let lastSuccessfulSyncTimestamp = 0;
/** Whether the browser tab is currently visible (drives periodic sync decisions) */
let isTabVisible = true;
/** Timer handle for debouncing visibility-change-triggered syncs */
let visibilityDebounceTimeout = null;
/** When the tab became hidden (null if currently visible) — used to calculate away duration */
let tabHiddenAt = null;
/** Debounce delay for visibility-change syncs (prevents rapid tab-switching spam) */
const VISIBILITY_SYNC_DEBOUNCE_MS = 1000;
/**
 * How long a locally-modified entity is "protected" from being overwritten by pull.
 *
 * When the user writes locally, the entity is marked as recently modified.
 * During pull, if a remote version arrives within this TTL, it's skipped to
 * prevent the pull from reverting the user's fresh local change before the
 * push has a chance to send it to the server.
 *
 * Industry standard range: 500ms–2000ms. We use 2s to cover the sync debounce
 * window (1s default) plus network latency with margin.
 */
const RECENTLY_MODIFIED_TTL_MS = 2000;
/**
 * Map of entity ID → timestamp for recently modified entities.
 *
 * This provides an additional layer of protection beyond the pending queue check.
 * Even if the queue is coalesced or cleared, recently modified entities won't be
 * overwritten by stale remote data during pull.
 */
const recentlyModifiedEntities = new Map();
/**
 * Mark an entity as recently modified to protect it from being overwritten by pull.
 *
 * Called by repository functions after every local write. The protection expires
 * after `RECENTLY_MODIFIED_TTL_MS` (2 seconds).
 *
 * @param entityId - The UUID of the entity that was just modified locally
 */
export function markEntityModified(entityId) {
    recentlyModifiedEntities.set(entityId, Date.now());
}
/**
 * Return a snapshot of engine-internal state for diagnostics.
 *
 * This function is prefixed with `_` to signal that it exposes module-private
 * state and should only be consumed by the diagnostics module.
 *
 * @returns A plain object containing current engine state values
 */
export function _getEngineDiagnostics() {
    return {
        syncStats: syncStats.slice(-10),
        totalSyncCycles,
        egressStats: { ...egressStats, byTable: { ...egressStats.byTable } },
        hasHydrated: _hasHydrated,
        schemaValidated: _schemaValidated,
        isTabVisible,
        tabHiddenAt,
        lockHeld: lockPromise !== null,
        lockHeldForMs: lockAcquiredAt ? Date.now() - lockAcquiredAt : null,
        recentlyModifiedCount: recentlyModifiedEntities.size,
        wasOffline,
        authValidatedAfterReconnect,
        lastSuccessfulSyncTimestamp
    };
}
/**
 * Check if an entity was recently modified locally (within the TTL window).
 *
 * Used during pull to skip remote updates for entities the user just edited.
 * Automatically cleans up expired entries on access.
 *
 * @param entityId - The UUID to check
 * @returns `true` if the entity was modified within `RECENTLY_MODIFIED_TTL_MS`
 */
function isRecentlyModified(entityId) {
    const modifiedAt = recentlyModifiedEntities.get(entityId);
    if (!modifiedAt)
        return false;
    const age = Date.now() - modifiedAt;
    if (age > RECENTLY_MODIFIED_TTL_MS) {
        // Expired, clean up
        recentlyModifiedEntities.delete(entityId);
        return false;
    }
    return true;
}
/**
 * Garbage-collect expired entries from the recently-modified map.
 *
 * Called periodically by the sync interval timer to prevent the map
 * from growing unbounded in long-running sessions.
 */
function cleanupRecentlyModified() {
    const now = Date.now();
    for (const [entityId, modifiedAt] of recentlyModifiedEntities) {
        if (now - modifiedAt > RECENTLY_MODIFIED_TTL_MS) {
            recentlyModifiedEntities.delete(entityId);
        }
    }
}
// =============================================================================
// SYNC LOCK (MUTEX)
// =============================================================================
//
// Prevents concurrent sync cycles from running simultaneously. Without this,
// two overlapping syncs could both read the same pending ops and push duplicates,
// or interleave pull writes causing inconsistent local state.
//
// The lock uses a simple promise-based approach: acquiring the lock creates a
// promise that blocks subsequent acquirers. Releasing resolves the promise.
// A timeout ensures the lock is force-released if a sync hangs.
// =============================================================================
/** The pending lock promise (null = lock is free) */
let lockPromise = null;
/** Resolver function for the current lock holder */
let lockResolve = null;
/** Timestamp when the lock was acquired (for stale-lock detection) */
let lockAcquiredAt = null;
/** Maximum time a sync lock can be held before force-release (60 seconds) */
const SYNC_LOCK_TIMEOUT_MS = 60000;
// --- Event listener references (stored for cleanup in stopSyncEngine) ---
let handleOnlineRef = null;
let handleOfflineRef = null;
let handleVisibilityChangeRef = null;
// --- Watchdog timer ---
// Runs every 15s to detect stuck syncs. If the lock has been held longer than
// SYNC_LOCK_TIMEOUT_MS, the watchdog force-releases it and triggers a retry.
// This prevents permanent sync stalls from unhandled promise rejections.
/** Timer handle for the sync watchdog */
let watchdogInterval = null;
/** How often the watchdog checks for stuck locks */
const WATCHDOG_INTERVAL_MS = 15000;
/** Maximum time allowed for individual push/pull operations before abort */
const SYNC_OPERATION_TIMEOUT_MS = 45000;
/**
 * Attempt to acquire the sync lock (non-blocking).
 *
 * If the lock is currently held, checks whether it's stale (held beyond timeout).
 * Stale locks are force-released to recover from stuck syncs. If the lock is
 * legitimately held by an active sync, returns `false` immediately (no waiting).
 *
 * @returns `true` if the lock was acquired, `false` if another sync is in progress
 */
async function acquireSyncLock() {
    // If lock is held, check if it's stale (held too long)
    if (lockPromise !== null) {
        if (lockAcquiredAt && Date.now() - lockAcquiredAt > SYNC_LOCK_TIMEOUT_MS) {
            debugWarn(`[SYNC] Force-releasing stale sync lock (held for ${Math.round((Date.now() - lockAcquiredAt) / 1000)}s)`);
            releaseSyncLock();
        }
        else {
            debugLog(`[SYNC] Lock contention: sync skipped (lock held for ${lockAcquiredAt ? Math.round((Date.now() - lockAcquiredAt) / 1000) : '?'}s)`);
            return false;
        }
    }
    // Create a new lock promise
    lockPromise = new Promise((resolve) => {
        lockResolve = resolve;
    });
    lockAcquiredAt = Date.now();
    debugLog('[SYNC] Lock acquired');
    return true;
}
/**
 * Release the sync lock, allowing the next sync cycle to proceed.
 *
 * Resolves the lock promise (unblocking any waiters), then clears all lock state.
 * Safe to call even if the lock isn't held (no-op).
 */
function releaseSyncLock() {
    if (lockResolve) {
        lockResolve();
    }
    lockPromise = null;
    lockResolve = null;
    lockAcquiredAt = null;
}
/**
 * Race a promise against a timeout, rejecting if the timeout fires first.
 *
 * Used to prevent sync operations from hanging indefinitely when Supabase
 * doesn't respond (e.g., during a service outage or DNS failure).
 *
 * @template T - The resolved type of the promise
 * @param promise - The async operation to wrap
 * @param ms - Maximum wait time in milliseconds
 * @param label - Human-readable label for the timeout error message
 * @returns The resolved value if the promise wins the race
 * @throws {Error} `"<label> timed out after <N>s"` if the timeout fires first
 */
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
        promise.then((val) => {
            clearTimeout(timer);
            resolve(val);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
// =============================================================================
// SYNC COMPLETION CALLBACKS
// =============================================================================
//
// Svelte stores register callbacks here to be notified when a sync cycle
// completes (either push or pull). This triggers stores to re-read from
// the local DB, ensuring the UI reflects the latest synced state.
// =============================================================================
/** Set of registered callbacks to invoke after every successful sync cycle */
const syncCompleteCallbacks = new Set();
/**
 * Register a callback to be invoked when a sync cycle completes.
 *
 * Used by Svelte stores to refresh their data from the local DB after new
 * remote data has been pulled. Returns an unsubscribe function for cleanup.
 *
 * @param callback - Function to call after each sync completion
 * @returns Unsubscribe function that removes the callback
 *
 * @example
 * ```ts
 * // In a Svelte store
 * const unsubscribe = onSyncComplete(() => {
 *   refreshFromLocalDb();
 * });
 * // Later, during cleanup:
 * unsubscribe();
 * ```
 */
export function onSyncComplete(callback) {
    syncCompleteCallbacks.add(callback);
    debugLog(`[SYNC] Store registered for sync complete (total: ${syncCompleteCallbacks.size})`);
    return () => {
        syncCompleteCallbacks.delete(callback);
        debugLog(`[SYNC] Store unregistered from sync complete (total: ${syncCompleteCallbacks.size})`);
    };
}
/**
 * Invoke all registered sync-complete callbacks.
 *
 * Each callback is wrapped in try/catch so a failing store refresh doesn't
 * prevent other stores from updating.
 */
function notifySyncComplete() {
    debugLog(`[SYNC] Notifying ${syncCompleteCallbacks.size} store callbacks to refresh`);
    for (const callback of syncCompleteCallbacks) {
        try {
            callback();
        }
        catch (e) {
            debugError('Sync callback error:', e);
        }
    }
}
// =============================================================================
// SYNC OPERATIONS — Push & Pull
// =============================================================================
//
// The core sync cycle has two phases:
//
// 1. **PUSH** (outbox → server): Read pending ops from the sync queue,
//    coalesce redundant updates, then send each operation to Supabase.
//    Operations are intent-based (create/set/increment/delete) not CRUD,
//    which enables smarter coalescing and conflict resolution.
//
// 2. **PULL** (server → local): Fetch all rows modified since the last
//    sync cursor, apply them to the local DB with field-level conflict
//    resolution, and advance the cursor.
//
// Push always runs before pull so that local changes are persisted to the
// server before we fetch remote changes. This ordering ensures that the
// pull's conflict resolution has access to the server's view of our changes.
// =============================================================================
/**
 * Schedule a debounced sync push after a local write.
 *
 * Called by repository functions after every write to the local DB. The debounce
 * prevents hammering the server during rapid edits (e.g., typing in a text field).
 * When realtime is healthy, runs in push-only mode (skips the pull phase) since
 * remote changes arrive via WebSocket.
 *
 * @example
 * ```ts
 * // After a local write in a repository
 * await db.table('todos').put(newTodo);
 * scheduleSyncPush(); // Sync will fire after debounce delay
 * ```
 */
export function scheduleSyncPush() {
    if (isDemoMode())
        return;
    if (syncTimeout) {
        clearTimeout(syncTimeout);
    }
    syncTimeout = setTimeout(() => {
        // EGRESS OPTIMIZATION: When realtime is healthy, other devices' changes arrive via realtime.
        // Skip pulling all tables after local writes - just push.
        const skipPull = isRealtimeHealthy();
        if (skipPull) {
            debugLog('[SYNC] Realtime healthy - push-only mode (skipping pull)');
        }
        runFullSync(false, skipPull).catch((e) => debugError('[SYNC] Push-triggered sync failed:', e)); // Show syncing indicator for user-triggered writes
    }, getSyncDebounceMs());
}
/**
 * Get the current authenticated user's ID, validating the session is actually valid.
 *
 * **CRITICAL**: This doesn't just read a cached token — it verifies the session
 * is genuinely valid. This catches cases where:
 * - The session token expired while the tab was in the background
 * - The token was revoked server-side (e.g., password change, admin action)
 * - The refresh token is invalid (e.g., user signed out on another device)
 *
 * **EGRESS OPTIMIZATION**: The expensive `getUser()` network call is cached for
 * 1 hour. Between validations, we trust the local session token. If the token
 * was revoked, the next push will fail with an RLS error, triggering a refresh.
 *
 * @returns The user's UUID, or `null` if not authenticated / session invalid
 */
async function getCurrentUserId() {
    try {
        const supabase = getSupabase();
        // First check if we have a session at all
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
            debugWarn('[SYNC] Session error:', sessionError.message);
            return null;
        }
        if (!session) {
            debugWarn('[SYNC] No active session');
            return null;
        }
        // Check if session is expired
        const expiresAt = session.expires_at;
        if (expiresAt && expiresAt * 1000 < Date.now()) {
            debugLog('[SYNC] Session expired, attempting refresh...');
            // Try to refresh the session
            const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
            if (refreshError || !refreshData.session) {
                debugWarn('[SYNC] Failed to refresh session:', refreshError?.message);
                return null;
            }
            debugLog('[SYNC] Session refreshed successfully');
            const refreshedId = refreshData.session.user?.id || null;
            if (refreshedId) {
                lastValidatedUserId = refreshedId;
                lastUserValidation = Date.now();
            }
            return refreshedId;
        }
        // EGRESS OPTIMIZATION: Only validate with getUser() (network call) once per hour.
        // Between validations, trust the cached session.
        const now = Date.now();
        if (lastValidatedUserId &&
            session.user?.id === lastValidatedUserId &&
            now - lastUserValidation < USER_VALIDATION_INTERVAL_MS) {
            debugLog(`[SYNC] Using cached user validation (${Math.round((now - lastUserValidation) / 1000)}s old)`);
            return session.user.id;
        }
        debugLog('[SYNC] Cached user validation expired, refreshing with getUser() network call');
        // Session is valid, but also validate with getUser() which makes a network call
        // This catches cases where the token is revoked server-side
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError) {
            debugWarn('[SYNC] User validation failed:', userError.message);
            // Invalidate cache on error
            lastValidatedUserId = null;
            lastUserValidation = 0;
            // Try to refresh the session
            const { data: refreshData, error: refreshError } = await supabase.auth.refreshSession();
            if (refreshError || !refreshData.session) {
                debugWarn('[SYNC] Failed to refresh after user validation error');
                return null;
            }
            const refreshedId = refreshData.session.user?.id || null;
            if (refreshedId) {
                lastValidatedUserId = refreshedId;
                lastUserValidation = Date.now();
            }
            return refreshedId;
        }
        // Cache successful validation
        if (user?.id) {
            lastValidatedUserId = user.id;
            lastUserValidation = Date.now();
        }
        return user?.id || null;
    }
    catch (e) {
        debugError('[SYNC] Auth validation error:', e);
        return null;
    }
}
/**
 * Read the last sync cursor from localStorage.
 *
 * The cursor is an ISO 8601 timestamp representing the `updated_at` of the most
 * recent record we've seen. It's stored **per-user** to prevent cross-user sync
 * issues when multiple accounts use the same browser (each user has their own
 * cursor so switching accounts doesn't skip or re-pull data).
 *
 * @param userId - The user ID for cursor isolation (null = legacy global cursor)
 * @returns ISO timestamp cursor, or epoch if no cursor is stored
 */
function getLastSyncCursor(userId) {
    if (typeof localStorage === 'undefined')
        return '1970-01-01T00:00:00.000Z';
    const key = userId ? `lastSyncCursor_${userId}` : 'lastSyncCursor';
    return localStorage.getItem(key) || '1970-01-01T00:00:00.000Z';
}
/**
 * Persist the sync cursor to localStorage (per-user).
 *
 * @param cursor - ISO 8601 timestamp of the newest `updated_at` seen
 * @param userId - The user ID for cursor isolation
 */
function setLastSyncCursor(cursor, userId) {
    if (typeof localStorage !== 'undefined') {
        const key = userId ? `lastSyncCursor_${userId}` : 'lastSyncCursor';
        localStorage.setItem(key, cursor);
    }
}
/**
 * Reset the sync cursor so the next sync pulls ALL data.
 */
async function resetSyncCursor() {
    const userId = await getCurrentUserId();
    if (typeof localStorage !== 'undefined') {
        const key = userId ? `lastSyncCursor_${userId}` : 'lastSyncCursor';
        localStorage.removeItem(key);
        debugLog('[SYNC] Sync cursor reset - next sync will pull all data');
    }
}
/**
 * Force a full sync by resetting the cursor and re-downloading all data.
 */
async function forceFullSync() {
    debugLog('[SYNC] Starting force full sync...');
    // Acquire sync lock to prevent concurrent syncs
    const acquired = await acquireSyncLock();
    if (!acquired) {
        debugWarn('[SYNC] Force full sync skipped - sync already in progress');
        return;
    }
    try {
        const config = getEngineConfig();
        const db = config.db;
        await resetSyncCursor();
        // Clear local data (except sync queue - keep pending changes)
        const entityTables = config.tables.map((t) => db.table(getDexieTableFor(t)));
        await db.transaction('rw', entityTables, async () => {
            for (const t of entityTables) {
                await t.clear();
            }
        });
        debugLog('[SYNC] Local data cleared, pulling from server...');
        syncStatusStore.setStatus('syncing');
        syncStatusStore.setSyncMessage('Downloading all data...');
        await pullRemoteChanges();
        syncStatusStore.setStatus('idle');
        syncStatusStore.setSyncMessage('Full sync complete');
        notifySyncComplete();
        debugLog('[SYNC] Force full sync complete');
    }
    catch (error) {
        debugError('[SYNC] Force full sync failed:', error);
        syncStatusStore.setStatus('error');
        syncStatusStore.setError('Full sync failed', String(error));
        throw error;
    }
    finally {
        releaseSyncLock();
    }
}
/**
 * **PULL PHASE**: Fetch all changes from Supabase since the last sync cursor.
 *
 * This is the "download" half of the sync cycle. It:
 * 1. Queries all configured tables for rows with `updated_at > lastSyncCursor`
 * 2. For each remote record, applies it to local DB with conflict resolution
 * 3. Skips recently-modified entities (protected by the TTL guard)
 * 4. Skips entities just processed by realtime (prevents double-processing)
 * 5. Advances the sync cursor to the newest `updated_at` seen
 *
 * All table queries run in parallel for minimal wall-clock time. The entire
 * local write is wrapped in a Dexie transaction for atomicity.
 *
 * @param minCursor - Optional minimum cursor override (e.g., post-push timestamp
 *   to avoid re-fetching records we just pushed). Uses the later of this and
 *   the stored cursor.
 * @returns Egress stats (bytes and record count) for this pull
 * @throws {Error} If no authenticated user is available
 */
async function pullRemoteChanges(minCursor) {
    const userId = await getCurrentUserId();
    // Abort if no authenticated user (avoids confusing RLS errors)
    if (!userId) {
        throw new Error('Not authenticated. Please sign in to sync.');
    }
    const config = getEngineConfig();
    const db = config.db;
    const supabase = config.supabase;
    // Use the later of stored cursor or provided minCursor
    // This prevents re-fetching records we just pushed in this sync cycle
    const storedCursor = getLastSyncCursor(userId);
    const lastSync = minCursor && minCursor > storedCursor ? minCursor : storedCursor;
    debugLog(`[SYNC] Pulling changes since: ${lastSync} (stored: ${storedCursor}, min: ${minCursor || 'none'})`);
    // Track the newest updated_at we see
    let newestUpdate = lastSync;
    // Track egress for this pull
    let pullBytes = 0;
    let pullRecords = 0;
    // Pull all tables in parallel (egress optimization: reduces wall time per sync cycle)
    // Wrapped in timeout to prevent hanging if Supabase doesn't respond
    const results = await withTimeout(Promise.all(config.tables.map((table) => supabase
        .from(table.supabaseName)
        .select(table.columns)
        .gt('updated_at', lastSync)
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true }))), 30000, 'Pull remote changes');
    // Check for errors
    for (let i = 0; i < results.length; i++) {
        if (results[i].error)
            throw results[i].error;
    }
    // Track egress
    const tableNames = config.tables.map((t) => t.supabaseName);
    for (let i = 0; i < config.tables.length; i++) {
        const egress = trackEgress(tableNames[i], results[i].data);
        pullBytes += egress.bytes;
        pullRecords += egress.records;
    }
    /**
     * Apply remote records to local DB with field-level conflict resolution.
     *
     * For each remote record:
     * - **No local copy**: Accept remote (simple insert)
     * - **Local is newer**: Skip (no conflict possible)
     * - **Remote is newer, no pending ops**: Accept remote (fast path)
     * - **Remote is newer, has pending ops**: Run 3-tier conflict resolution
     *   (auto-merge non-conflicting fields, then pending-local-wins for conflicting fields)
     *
     * @param entityType - The Supabase table name (for conflict history logging)
     * @param remoteRecords - Records fetched from the server
     * @param table - Dexie table handle for local reads/writes
     */
    async function applyRemoteWithConflictResolution(entityType, remoteRecords, table) {
        // Fetch pending entity IDs per-table to avoid stale data from earlier in the pull
        const pendingEntityIds = await getPendingEntityIds();
        for (const remote of remoteRecords || []) {
            // Skip recently modified entities (protects against race conditions)
            // Note: We no longer skip entities with pending ops - conflict resolution handles them
            if (isRecentlyModified(remote.id)) {
                debugLog(`[SYNC] Pull: skipping recently modified entity ${entityType}/${remote.id}`);
                continue;
            }
            // Skip entities that were just processed by realtime (prevents duplicate processing)
            if (wasRecentlyProcessedByRealtime(remote.id))
                continue;
            const local = await table.get(remote.id);
            // Track newest update for cursor
            if (remote.updated_at > newestUpdate)
                newestUpdate = remote.updated_at;
            // If no local entity, just accept remote
            if (!local) {
                await table.put(remote);
                continue;
            }
            // If remote is not newer than local, skip (no conflict possible)
            if (new Date(remote.updated_at) <= new Date(local.updated_at)) {
                continue;
            }
            // Check if we have pending operations for this entity
            const hasPendingOps = pendingEntityIds.has(remote.id);
            if (!hasPendingOps) {
                // No pending ops and remote is newer - simple case, accept remote
                await table.put(remote);
            }
            else {
                // Entity has pending operations - apply field-level conflict resolution
                const pendingOps = await getPendingOpsForEntity(remote.id);
                const resolution = await resolveConflicts(entityType, remote.id, local, remote, pendingOps);
                // Store the merged entity
                await table.put(resolution.mergedEntity);
                // Store conflict history if there were conflicts
                if (resolution.hasConflicts) {
                    await storeConflictHistory(resolution);
                }
            }
        }
    }
    // Log what we're about to apply
    const pullSummary = {};
    for (let i = 0; i < config.tables.length; i++) {
        pullSummary[tableNames[i]] = results[i].data?.length || 0;
    }
    debugLog(`[SYNC] Pulled from server:`, pullSummary);
    // Apply changes to local DB with conflict handling
    const entityTables = config.tables.map((t) => db.table(getDexieTableFor(t)));
    // Check if any table has data to process (avoid opening transaction on empty pull)
    const hasData = results.some((r) => r.data && r.data.length > 0);
    if (hasData) {
        await db.transaction('rw', [...entityTables, db.table('syncQueue'), db.table('conflictHistory')], async () => {
            for (let i = 0; i < config.tables.length; i++) {
                const data = results[i].data;
                await applyRemoteWithConflictResolution(tableNames[i], data, db.table(getDexieTableFor(config.tables[i])));
            }
        });
    }
    // Update sync cursor (per-user)
    setLastSyncCursor(newestUpdate, userId);
    return { bytes: pullBytes, records: pullRecords };
}
/**
 * Errors collected during the current push phase.
 *
 * Reset at the start of each push cycle. Used by `runFullSync()` to determine
 * whether to show error status in the UI. Only "significant" errors (persistent
 * or final-retry transient) are added here.
 */
let pushErrors = [];
/**
 * **PUSH PHASE**: Send all pending operations from the sync queue to Supabase.
 *
 * This is the "upload" half of the sync cycle. It:
 * 1. Pre-flight auth check (fail fast if session is expired)
 * 2. Coalesces redundant operations (e.g., 50 rapid edits → 1 update)
 * 3. Processes each queue item via `processSyncItem()`
 * 4. Removes successfully pushed items from the queue
 * 5. Increments retry count for failed items (exponential backoff)
 *
 * Loops until the queue is empty or `maxIterations` is reached. The loop
 * catches items that were added to the queue *during* the push (e.g., the
 * user made another edit while sync was running).
 *
 * @returns Push statistics (original count, coalesced count, actually pushed)
 * @throws {Error} If auth validation fails before push
 */
async function pushPendingOps() {
    const maxIterations = 10; // Safety limit to prevent infinite loops
    let iterations = 0;
    let actualPushed = 0;
    const db = getDb();
    // Clear previous push errors
    pushErrors = [];
    // Get original count before coalescing
    const originalItems = await getPendingSync();
    const originalCount = originalItems.length;
    // CRITICAL: Pre-flight auth check before attempting to push
    // This catches expired/invalid sessions early, before we try operations that would fail silently
    if (originalCount > 0) {
        const userId = await getCurrentUserId();
        if (!userId) {
            debugError('[SYNC] Auth validation failed before push - session may be expired');
            const authError = {
                message: 'Session expired - please sign in again',
                table: 'auth',
                operation: 'validate',
                entityId: 'session'
            };
            pushErrors.push(authError);
            syncStatusStore.addSyncError({
                ...authError,
                timestamp: new Date().toISOString()
            });
            throw new Error('Authentication required - please sign in again');
        }
    }
    // Coalesce multiple updates to the same entity before pushing
    // This merges e.g. 50 rapid increments into 1 update request
    const coalescedCount = await coalescePendingOps();
    if (coalescedCount > 0) {
        debugLog(`[SYNC] Coalesced ${coalescedCount} redundant operations (${originalCount} -> ${originalCount - coalescedCount})`);
    }
    // Snapshot: capture the IDs to process in THIS cycle. Items queued after
    // this point are left for the next cycle, allowing the UI to show the
    // "pending" state between sync cycles instead of silently consuming them.
    const snapshotItems = await getPendingSync();
    const snapshotIds = new Set(snapshotItems.map((item) => item.id));
    while (iterations < maxIterations) {
        const pendingItems = (await getPendingSync()).filter((item) => snapshotIds.has(item.id));
        if (pendingItems.length === 0)
            break;
        iterations++;
        let processedAny = false;
        for (const item of pendingItems) {
            try {
                // Skip items that were purged from the queue during reconciliation
                // (e.g. singleton ID reconciliation deletes old queued ops)
                if (item.id) {
                    const stillQueued = await db.table('syncQueue').get(item.id);
                    if (!stillQueued) {
                        debugLog(`[SYNC] Skipping purged item: ${item.operationType} ${item.table}/${item.entityId}`);
                        continue;
                    }
                }
                debugLog(`[SYNC] Processing: ${item.operationType} ${item.table}/${item.entityId}`);
                await processSyncItem(item);
                if (item.id) {
                    await removeSyncItem(item.id);
                    processedAny = true;
                    actualPushed++;
                    debugLog(`[SYNC] Success: ${item.operationType} ${item.table}/${item.entityId}`);
                }
            }
            catch (error) {
                debugError(`[SYNC] Failed: ${item.operationType} ${item.table}/${item.entityId}:`, error);
                // Determine if this is a transient error that will likely succeed on retry
                const transient = isTransientError(error);
                // Only show error in UI if:
                // 1. It's a persistent error (won't fix itself) OR
                // 2. It's a transient error AND this is the last retry attempt (retries >= 3)
                // This prevents momentary error flashes for network hiccups that resolve on retry
                const shouldShowError = !transient || item.retries >= 3;
                if (shouldShowError) {
                    // Capture error details for UI display
                    const errorInfo = {
                        message: extractErrorMessage(error),
                        table: item.table,
                        operation: item.operationType,
                        entityId: item.entityId
                    };
                    pushErrors.push(errorInfo);
                    // Also add to the sync status store for UI
                    syncStatusStore.addSyncError({
                        ...errorInfo,
                        timestamp: new Date().toISOString()
                    });
                }
                if (item.id) {
                    await incrementRetry(item.id);
                }
            }
        }
        // If we didn't process anything (all items in backoff), stop iterating
        if (!processedAny)
            break;
    }
    return { originalCount, coalescedCount, actualPushed };
}
/**
 * Check if a Supabase/PostgreSQL error is a duplicate key violation.
 *
 * Handles multiple error formats: PostgreSQL error code `23505`,
 * PostgREST error code `PGRST409`, and fallback message matching.
 * Used during CREATE operations to gracefully handle race conditions
 * where the same entity was created on multiple devices simultaneously.
 *
 * @param error - The error object from Supabase
 * @returns `true` if this is a duplicate key / unique constraint violation
 */
function isDuplicateKeyError(error) {
    // PostgreSQL error code for unique violation
    if (error.code === '23505')
        return true;
    // PostgREST error codes
    if (error.code === 'PGRST409')
        return true;
    // Fallback to message check for compatibility
    const msg = (error.message || '').toLowerCase();
    return msg.includes('duplicate') || msg.includes('unique') || msg.includes('already exists');
}
/**
 * Check if a Supabase/PostgreSQL error indicates the target row doesn't exist.
 *
 * Used during DELETE and UPDATE operations. If a row doesn't exist, the operation
 * is treated as a no-op (idempotent) rather than an error.
 *
 * @param error - The error object from Supabase
 * @returns `true` if this is a "not found" / "no rows" error
 */
function isNotFoundError(error) {
    // PostgREST error code for no rows affected/found
    if (error.code === 'PGRST116')
        return true;
    // HTTP 404 style code
    if (error.code === '404')
        return true;
    // Fallback to message check
    const msg = (error.message || '').toLowerCase();
    return msg.includes('not found') || msg.includes('no rows');
}
/**
 * Classify an error as transient (will likely succeed on retry) or persistent (won't improve).
 *
 * This classification drives the UI error strategy:
 * - **Transient errors** (network, timeout, rate limit, 5xx): Don't show error in UI
 *   until retry attempts are exhausted. The user doesn't need to know about a brief
 *   network hiccup that resolved on the next attempt.
 * - **Persistent errors** (auth, validation, RLS): Show error immediately since they
 *   require user action (re-login, fix data, etc.) and won't resolve with retries.
 *
 * @param error - The error to classify
 * @returns `true` if the error is transient (likely to succeed on retry)
 */
function isTransientError(error) {
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const errObj = error;
    // Network/connectivity issues - transient
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('failed to fetch')) {
        return true;
    }
    if (msg.includes('timeout') || msg.includes('timed out')) {
        return true;
    }
    if (msg.includes('connection') || msg.includes('offline')) {
        return true;
    }
    // Rate limiting - transient (will succeed after backoff)
    if (msg.includes('rate') || msg.includes('limit') || msg.includes('too many')) {
        return true;
    }
    if (errObj.code === '429' || errObj.status === 429) {
        return true;
    }
    // Server errors (5xx) - transient
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
        return true;
    }
    if (errObj.status && errObj.status >= 500 && errObj.status < 600) {
        return true;
    }
    // Service unavailable - transient
    if (msg.includes('unavailable') || msg.includes('temporarily')) {
        return true;
    }
    // Everything else (auth errors, validation errors, etc.) - persistent
    // These require user action and won't fix themselves with retries
    return false;
}
/**
 * Process a single sync queue item by sending it to Supabase.
 *
 * Handles four operation types: `create`, `set`, `increment`, and `delete`.
 * Each operation maps to a specific Supabase query pattern.
 *
 * **CRITICAL**: All operations use `.select()` to verify they actually affected a row.
 * Without this, Supabase's Row Level Security (RLS) can **silently block** operations —
 * returning a successful response with 0 rows affected. The `.select()` call lets us
 * detect this and throw an appropriate error instead of silently losing data.
 *
 * **Singleton table handling**: For tables marked as `isSingleton` (one row per user),
 * special reconciliation logic handles the case where the local UUID doesn't match
 * the server's UUID (e.g., created offline before the server row existed).
 *
 * @param item - The sync queue item to process
 * @throws {Error} If the operation fails or is blocked by RLS
 */
async function processSyncItem(item) {
    const { table, entityId, operationType, field, value, timestamp } = item;
    const deviceId = getDeviceId();
    const supabase = getSupabase();
    const db = getDb();
    const dexieTable = getDexieTableName(table);
    switch (operationType) {
        case 'create': {
            // INSERT the full entity payload with the originating device_id.
            // Uses .select('id').maybeSingle() to verify the row was actually created
            // (RLS can silently block inserts, returning success with no data).
            const payload = value;
            const { data, error } = await supabase
                .from(table)
                .insert({ id: entityId, ...payload, device_id: deviceId })
                .select('id')
                .maybeSingle();
            // Duplicate key = another device already created this entity.
            // For regular tables, this is a no-op (the entity exists, which is what we wanted).
            // For singleton tables, we need to reconcile: the local UUID was generated offline
            // and doesn't match the server's UUID, so we swap the local ID to match.
            if (error && isDuplicateKeyError(error)) {
                if (isSingletonTable(table) && payload.user_id) {
                    const { data: existing } = await supabase
                        .from(table)
                        .select(getColumns(table))
                        .eq('user_id', payload.user_id)
                        .maybeSingle();
                    if (existing) {
                        // Replace local entry: delete old ID, add with server ID
                        await db.table(dexieTable).delete(entityId);
                        await db.table(dexieTable).put(existing);
                        // Purge any queued operations referencing the old ID
                        await db.table('syncQueue').where('entityId').equals(entityId).delete();
                    }
                }
                break;
            }
            if (error) {
                throw error;
            }
            // If no error but also no data returned, RLS likely blocked the insert
            if (!data) {
                // Check if it already exists (could be a race condition)
                const { data: existing } = await supabase
                    .from(table)
                    .select('id')
                    .eq('id', entityId)
                    .maybeSingle();
                if (!existing) {
                    throw new Error(`Insert blocked by RLS - please re-authenticate`);
                }
                // Already exists, treat as success
            }
            break;
        }
        case 'delete': {
            // SOFT DELETE: Set `deleted: true` rather than physically removing the row.
            // Other devices discover the deletion during their next pull and remove their local copy.
            // The tombstone is eventually hard-deleted by `cleanupServerTombstones()` after the TTL.
            const { data, error } = await supabase
                .from(table)
                .update({ deleted: true, updated_at: timestamp, device_id: deviceId })
                .eq('id', entityId)
                .select('id')
                .maybeSingle();
            // Ignore "not found" errors - item may already be deleted
            if (error && !isNotFoundError(error)) {
                throw error;
            }
            // If update returned no data, the row may not exist or RLS blocked it
            // For deletes, we treat this as success (already deleted or will be on next sync)
            if (!error && !data) {
                debugLog(`[SYNC] Delete may have been blocked or row missing: ${table}/${entityId}`);
            }
            break;
        }
        case 'increment': {
            // INCREMENT: Push the final computed value (not the delta) to the server.
            // The local DB already has the correct value after the increment was applied locally.
            // We read it from IndexedDB and send it as a SET to the server. This avoids the
            // need for a server-side atomic increment (which Supabase doesn't natively support
            // without an RPC function) and ensures eventual consistency.
            if (!field) {
                throw new Error('Increment operation requires a field');
            }
            // For increment, the local DB already has the final value after increment
            // We need to read it to get what to push to the server
            const localEntity = await db.table(dexieTable).get(entityId);
            if (!localEntity) {
                // Entity was deleted locally, skip this increment
                debugWarn(`[SYNC] Skipping increment for deleted entity: ${table}/${entityId}`);
                return;
            }
            const currentValue = localEntity[field];
            const updatePayload = {
                [field]: currentValue,
                updated_at: timestamp,
                device_id: deviceId
            };
            // Also sync completed status if this is a goal/progress increment
            if ('completed' in localEntity) {
                updatePayload.completed = localEntity.completed;
            }
            const { data, error } = await supabase
                .from(table)
                .update(updatePayload)
                .eq('id', entityId)
                .select('id')
                .maybeSingle();
            if (error)
                throw error;
            // Check if update actually affected any rows
            if (!data) {
                throw new Error(`Update blocked by RLS or row missing: ${table}/${entityId}`);
            }
            break;
        }
        case 'set': {
            // SET: Update one or more fields on the server. Supports both single-field
            // updates (field + value) and multi-field updates (value is a payload object).
            // Includes singleton table reconciliation for ID mismatches (same as 'create').
            let updatePayload;
            if (field) {
                // Single field set
                updatePayload = {
                    [field]: value,
                    updated_at: timestamp,
                    device_id: deviceId
                };
            }
            else {
                // Multi-field set (value is the full payload)
                updatePayload = {
                    ...value,
                    updated_at: timestamp,
                    device_id: deviceId
                };
            }
            const { data, error } = await supabase
                .from(table)
                .update(updatePayload)
                .eq('id', entityId)
                .select('id')
                .maybeSingle();
            if (error)
                throw error;
            // Check if update actually affected any rows
            if (!data) {
                // For singleton tables, the local ID may not match the server.
                // Look up the server's record by user_id and re-apply the update with the correct ID.
                if (isSingletonTable(table)) {
                    const localEntity = await db.table(dexieTable).get(entityId);
                    const userId = localEntity?.user_id;
                    if (userId) {
                        const { data: serverRow } = await supabase
                            .from(table)
                            .select('*')
                            .eq('user_id', userId)
                            .maybeSingle();
                        if (serverRow) {
                            // Apply the update to the correct server row
                            const { error: retryError } = await supabase
                                .from(table)
                                .update(updatePayload)
                                .eq('id', serverRow.id)
                                .select('id')
                                .maybeSingle();
                            // Reconcile local: replace stale ID with server ID
                            await db.table(dexieTable).delete(entityId);
                            // Merge our pending changes into the server row
                            const merged = { ...serverRow, ...updatePayload, id: serverRow.id };
                            await db.table(dexieTable).put(merged);
                            // Purge any remaining queued operations referencing the old ID
                            await db.table('syncQueue').where('entityId').equals(entityId).delete();
                            if (retryError)
                                throw retryError;
                            break;
                        }
                    }
                }
                throw new Error(`Update blocked by RLS or row missing: ${table}/${entityId}`);
            }
            break;
        }
        default:
            throw new Error(`Unknown operation type: ${operationType}`);
    }
}
/**
 * Extract a raw error message from various error object formats.
 *
 * Handles: standard `Error` objects, Supabase/PostgreSQL error objects
 * (with `message`, `details`, `hint`, `code` properties), wrapper objects
 * with `error` or `description` properties, and primitive values.
 *
 * @param error - Any error value (Error, Supabase error object, string, etc.)
 * @returns A human-readable error message string
 */
function extractErrorMessage(error) {
    // Standard Error object
    if (error instanceof Error) {
        return error.message;
    }
    // Supabase/PostgreSQL error object: { message, details, hint, code }
    if (error && typeof error === 'object') {
        const err = error;
        // Try common error message properties
        if (typeof err.message === 'string' && err.message) {
            // Include details/hint if available for more context
            let msg = err.message;
            if (typeof err.details === 'string' && err.details) {
                msg += ` - ${err.details}`;
            }
            if (typeof err.hint === 'string' && err.hint) {
                msg += ` (${err.hint})`;
            }
            return msg;
        }
        // Try error property (some wrappers use this)
        if (typeof err.error === 'string' && err.error) {
            return err.error;
        }
        // Try description property
        if (typeof err.description === 'string' && err.description) {
            return err.description;
        }
        // Last resort: stringify the object
        try {
            return JSON.stringify(error);
        }
        catch {
            return '[Unable to parse error]';
        }
    }
    // Primitive types
    return String(error);
}
/**
 * Convert a technical error into a user-friendly message for the UI.
 *
 * Maps common error patterns (network, auth, rate limiting, server errors)
 * to clear, actionable messages. Truncates unknown errors to 100 characters.
 *
 * @param error - The error to parse
 * @returns A user-friendly error message suitable for display in the UI
 */
function parseErrorMessage(error) {
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        // Network errors
        if (msg.includes('fetch') || msg.includes('network') || msg.includes('failed to fetch')) {
            return 'Network connection lost. Changes saved locally.';
        }
        if (msg.includes('timeout') || msg.includes('timed out')) {
            return 'Server took too long to respond. Will retry.';
        }
        // Auth errors
        if (msg.includes('jwt') ||
            msg.includes('token') ||
            msg.includes('unauthorized') ||
            msg.includes('401')) {
            return 'Session expired. Please sign in again.';
        }
        // Rate limiting
        if (msg.includes('rate') || msg.includes('limit') || msg.includes('429')) {
            return 'Too many requests. Will retry shortly.';
        }
        // Server errors
        if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
            return 'Server is temporarily unavailable.';
        }
        // Return clean error message
        return error.message.length > 100 ? error.message.substring(0, 100) + '...' : error.message;
    }
    return 'An unexpected error occurred';
}
/**
 * Execute a full sync cycle: push local changes, then pull remote changes.
 *
 * This is the main entry point for sync. It orchestrates the complete cycle:
 * 1. **Pre-flight checks**: Online status, auth validation, session validity
 * 2. **Acquire lock**: Prevent concurrent syncs
 * 3. **Push phase**: Send pending local changes to Supabase
 * 4. **Pull phase**: Fetch remote changes since last cursor (with retry)
 * 5. **Post-sync**: Update UI status, notify stores, log egress stats
 *
 * The `quiet` flag controls whether the UI sync indicator is shown. Background
 * periodic syncs use `quiet=true` to avoid distracting the user. User-triggered
 * syncs (after local writes) use `quiet=false` to show progress.
 *
 * The `skipPull` flag enables push-only mode when realtime subscriptions are
 * healthy — since remote changes arrive via WebSocket, polling is redundant.
 *
 * @param quiet - If `true`, don't update the UI status indicator
 * @param skipPull - If `true`, skip the pull phase (push-only mode)
 */
export async function runFullSync(quiet = false, skipPull = false) {
    if (isDemoMode())
        return;
    if (typeof navigator === 'undefined' || !navigator.onLine) {
        if (!quiet) {
            syncStatusStore.setStatus('offline');
            syncStatusStore.setSyncMessage("You're offline. Changes will sync when reconnected.");
        }
        return;
    }
    // SECURITY: If we were offline and came back online, auth must be validated first
    // This prevents syncing potentially unauthorized data from an invalid offline session
    if (needsAuthValidation()) {
        debugLog('[SYNC] Waiting for auth validation before syncing (was offline)');
        if (!quiet) {
            syncStatusStore.setStatus('idle');
            syncStatusStore.setSyncMessage('Validating credentials...');
        }
        return;
    }
    // CRITICAL: Validate auth before attempting any sync operations
    // Without valid auth, Supabase RLS silently blocks writes (returns no error but 0 rows affected)
    // This causes the "sync succeeded but nothing synced" bug
    const userId = await getCurrentUserId();
    if (!userId) {
        debugWarn('[SYNC] No authenticated user - cannot sync. RLS would silently block all writes.');
        if (!quiet) {
            syncStatusStore.setStatus('error');
            syncStatusStore.setError('Not signed in', 'Please sign in to sync your data.');
            syncStatusStore.setSyncMessage('Sign in required to sync');
        }
        return;
    }
    // Atomically acquire sync lock to prevent concurrent syncs
    const acquired = await acquireSyncLock();
    if (!acquired)
        return;
    const config = getEngineConfig();
    // Track sync cycle for egress monitoring
    const cycleStart = Date.now();
    const trigger = quiet ? 'periodic' : 'user';
    let pushedItems = 0;
    let cycleEgressBytes = 0;
    let cycleEgressRecords = 0;
    let pushSucceeded = false;
    let pullSucceeded = false;
    try {
        // Only show "syncing" indicator for non-quiet syncs
        if (!quiet) {
            syncStatusStore.setStatus('syncing');
            syncStatusStore.setSyncMessage('Preparing changes...');
        }
        // Push first so local changes are persisted
        // Note: pushPendingOps coalesces before pushing, so actual requests are lower
        const pushStats = await withTimeout(pushPendingOps(), SYNC_OPERATION_TIMEOUT_MS, 'Push pending ops');
        pushedItems = pushStats.actualPushed;
        pushSucceeded = true;
        // EGRESS OPTIMIZATION: Skip pull when realtime is healthy and this is a push-triggered sync
        let pullEgress = { bytes: 0, records: 0 };
        if (skipPull) {
            debugLog('[SYNC] Skipping pull (realtime healthy, push-only mode)');
            pullSucceeded = true;
        }
        else {
            if (!quiet) {
                syncStatusStore.setSyncMessage('Downloading latest data...');
            }
            // Pull remote changes - retry up to 3 times if push succeeded
            // Uses stored cursor to get all changes since last sync
            // Conflict resolution handles our own pushed changes via device_id check
            let pullAttempts = 0;
            const maxPullAttempts = 3;
            let lastPullError = null;
            while (pullAttempts < maxPullAttempts && !pullSucceeded) {
                try {
                    // Don't pass postPushCursor - we want ALL changes since stored cursor
                    // The conflict resolution handles our own pushed changes via device_id check
                    pullEgress = await withTimeout(pullRemoteChanges(), SYNC_OPERATION_TIMEOUT_MS, 'Pull remote changes');
                    pullSucceeded = true;
                }
                catch (pullError) {
                    lastPullError = pullError;
                    pullAttempts++;
                    debugWarn(`[SYNC] Pull attempt ${pullAttempts}/${maxPullAttempts} failed:`, pullError);
                    if (pullAttempts < maxPullAttempts) {
                        // Wait before retry (exponential backoff: 1s, 2s)
                        await new Promise((resolve) => setTimeout(resolve, pullAttempts * 1000));
                    }
                }
            }
            if (!pullSucceeded && lastPullError) {
                throw lastPullError;
            }
        }
        // Store egress for logging
        cycleEgressBytes = pullEgress.bytes;
        cycleEgressRecords = pullEgress.records;
        // Update status only for non-quiet syncs
        if (!quiet) {
            const remaining = await getPendingSync();
            syncStatusStore.setPendingCount(remaining.length);
            // Only show error status if:
            // 1. We have push errors that were deemed serious enough to show, OR
            // 2. Remaining items have been retrying for a while (retries >= 2)
            // This prevents "error" flash for items that will succeed on next retry
            const hasSignificantErrors = pushErrors.length > 0;
            const hasStaleRetries = remaining.some((item) => item.retries >= 2);
            const showErrorStatus = remaining.length > 0 && (hasSignificantErrors || hasStaleRetries);
            syncStatusStore.setStatus(showErrorStatus ? 'error' : 'idle');
            syncStatusStore.setLastSyncTime(new Date().toISOString());
            // Update message based on actual error state
            if (showErrorStatus) {
                syncStatusStore.setSyncMessage(`${remaining.length} change${remaining.length === 1 ? '' : 's'} failed to sync`);
                // Show error details
                if (hasSignificantErrors) {
                    // Show the latest specific error
                    const latestError = pushErrors[pushErrors.length - 1];
                    syncStatusStore.setError(`Failed to sync ${latestError.table} (${latestError.operation})`, latestError.message);
                }
                else {
                    // Items in retry backoff - no specific errors this cycle
                    // Show pending retry info instead of clearing error details
                    const retryInfo = remaining
                        .map((item) => `${item.table} (${item.operationType})`)
                        .slice(0, 3);
                    const moreCount = remaining.length - retryInfo.length;
                    const details = moreCount > 0 ? `${retryInfo.join(', ')} and ${moreCount} more` : retryInfo.join(', ');
                    syncStatusStore.setError(`${remaining.length} change${remaining.length === 1 ? '' : 's'} pending retry`, `Affected: ${details}. Will retry automatically.`);
                }
            }
            else if (remaining.length > 0) {
                // Items exist but don't show error status yet (still early in retry cycle)
                // Show a neutral "syncing" message instead of error
                syncStatusStore.setSyncMessage('Syncing changes...');
                syncStatusStore.setError(null);
            }
            else {
                syncStatusStore.setSyncMessage('Everything is synced!');
                syncStatusStore.setError(null);
            }
        }
        // Notify stores that sync is complete so they can refresh from local
        notifySyncComplete();
        lastSuccessfulSyncTimestamp = Date.now();
    }
    catch (error) {
        debugError('Sync failed:', error);
        // Only show errors for user-initiated syncs (non-quiet)
        // Background syncs fail silently - they'll retry automatically
        if (!quiet) {
            const friendlyMessage = parseErrorMessage(error);
            const rawMessage = extractErrorMessage(error);
            syncStatusStore.setStatus('error');
            syncStatusStore.setError(friendlyMessage, rawMessage);
            syncStatusStore.setSyncMessage(friendlyMessage);
        }
        // If push succeeded but pull failed, still notify so UI refreshes with pushed data
        if (pushSucceeded && !pullSucceeded) {
            notifySyncComplete();
        }
    }
    finally {
        // Log sync cycle stats for egress monitoring
        logSyncCycle({
            trigger,
            pushedItems,
            pulledTables: pullSucceeded && !skipPull ? config.tables.length : 0,
            pulledRecords: cycleEgressRecords,
            egressBytes: cycleEgressBytes,
            durationMs: Date.now() - cycleStart
        });
        releaseSyncLock();
    }
}
/**
 * Reconcile orphaned local changes with remote.
 *
 * After re-login, local IndexedDB may have items that were modified offline
 * but whose sync queue entries were lost (e.g. cleared by a previous bug).
 * This scans all tables for items modified after the last sync cursor and
 * re-queues them so they get pushed on the next sync.
 *
 * Only runs when the sync queue is empty (otherwise normal sync handles it).
 */
async function reconcileLocalWithRemote() {
    const db = getDb();
    const config = getEngineConfig();
    const queueCount = await db.table('syncQueue').count();
    if (queueCount > 0)
        return 0; // Queue has items, no reconciliation needed
    const userId = await getCurrentUserId();
    if (!userId)
        return 0;
    const cursor = getLastSyncCursor(userId);
    let requeued = 0;
    for (const tableConfig of config.tables) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allItems = await db.table(getDexieTableFor(tableConfig)).toArray();
        for (const item of allItems) {
            if (item.updated_at && item.updated_at > cursor) {
                const { id: _id, ...payload } = item;
                await queueSyncOperation({
                    table: tableConfig.supabaseName,
                    entityId: item.id,
                    operationType: item.deleted ? 'delete' : 'create',
                    value: item.deleted ? undefined : payload
                });
                requeued++;
            }
        }
    }
    if (requeued > 0) {
        debugLog(`[SYNC] Reconciliation: re-queued ${requeued} orphaned items for sync`);
    }
    return requeued;
}
/**
 * Full reconciliation: removes local records that no longer exist on the server.
 *
 * When a client has been offline longer than the tombstone TTL, soft-deleted
 * records may have been hard-deleted from the server. The normal incremental
 * pull can't detect these missing records. This function fetches all non-deleted
 * IDs from the server and deletes any local records not found in that set.
 *
 * Only runs when the client's sync cursor is older than tombstoneMaxAgeDays,
 * indicating the client may have missed tombstone cleanup.
 */
async function fullReconciliation() {
    const userId = await getCurrentUserId();
    if (!userId)
        return 0;
    const config = getEngineConfig();
    const db = config.db;
    const supabase = config.supabase;
    // Check if cursor is stale enough to warrant full reconciliation
    const cursor = getLastSyncCursor(userId);
    const cursorDate = new Date(cursor);
    const staleCutoff = new Date();
    staleCutoff.setDate(staleCutoff.getDate() - getTombstoneMaxAgeDays());
    if (cursorDate >= staleCutoff) {
        return 0; // Cursor is fresh enough, incremental sync is sufficient
    }
    debugLog(`[SYNC] Full reconciliation: cursor ${cursor} is older than tombstone TTL, checking for orphaned local records`);
    let totalRemoved = 0;
    try {
        // Fetch all non-deleted IDs from each table on the server
        const results = await withTimeout(Promise.all(config.tables.map((table) => supabase.from(table.supabaseName).select('id').or('deleted.is.null,deleted.eq.false'))), SYNC_OPERATION_TIMEOUT_MS, 'Full reconciliation');
        // Check for errors
        for (let i = 0; i < results.length; i++) {
            if (results[i].error) {
                debugError(`[SYNC] Full reconciliation failed for ${config.tables[i].supabaseName}:`, results[i].error);
                continue;
            }
        }
        // Compare local IDs against server IDs and remove orphans
        const entityTables = config.tables.map((t) => db.table(getDexieTableFor(t)));
        await db.transaction('rw', entityTables, async () => {
            for (let i = 0; i < config.tables.length; i++) {
                if (results[i].error)
                    continue;
                const serverIds = new Set((results[i].data || []).map((r) => r.id));
                const localTable = db.table(getDexieTableFor(config.tables[i]));
                const localRecords = (await localTable.toArray());
                const orphanIds = [];
                for (const local of localRecords) {
                    // Record exists locally but not on server (and isn't already marked deleted)
                    if (!local.deleted && !serverIds.has(local.id)) {
                        orphanIds.push(local.id);
                    }
                }
                if (orphanIds.length > 0) {
                    await localTable.bulkDelete(orphanIds);
                    totalRemoved += orphanIds.length;
                    debugLog(`[SYNC] Full reconciliation: removed ${orphanIds.length} orphaned records from ${getDexieTableFor(config.tables[i])}`);
                }
            }
        });
        if (totalRemoved > 0) {
            debugLog(`[SYNC] Full reconciliation complete: ${totalRemoved} orphaned records removed`);
            notifySyncComplete();
        }
    }
    catch (error) {
        debugError('[SYNC] Full reconciliation failed:', error);
    }
    return totalRemoved;
}
/**
 * Initial hydration: populate an empty local DB from the remote server.
 *
 * This runs once on first load (or after a cache clear). If the local DB already
 * has data, it falls through to a normal sync cycle instead.
 *
 * **Flow for empty local DB**:
 * 1. Acquire sync lock
 * 2. Pull ALL non-deleted records from every configured table
 * 3. Store in local DB via bulk put (single transaction)
 * 4. Set sync cursor to the max `updated_at` seen (not "now") to avoid missing
 *    changes that happened during the hydration query
 * 5. Notify stores to render the freshly loaded data
 *
 * **Flow for populated local DB**:
 * 1. Run full reconciliation (if cursor is stale past tombstone TTL)
 * 2. Reconcile orphaned local changes (items modified after cursor with empty queue)
 * 3. Run normal full sync
 *
 * @see {@link fullReconciliation} - Handles the "been offline too long" case
 * @see {@link reconcileLocalWithRemote} - Re-queues orphaned local changes
 */
async function hydrateFromRemote() {
    if (typeof navigator === 'undefined' || !navigator.onLine)
        return;
    // Atomically acquire sync lock to prevent concurrent syncs/hydrations
    const acquired = await acquireSyncLock();
    if (!acquired)
        return;
    const config = getEngineConfig();
    const db = config.db;
    const supabase = config.supabase;
    // Get user ID for sync cursor isolation
    const userId = await getCurrentUserId();
    // Abort if no authenticated user (can't hydrate without auth)
    if (!userId) {
        debugLog('[SYNC] Hydration skipped: no authenticated user');
        releaseSyncLock();
        return;
    }
    debugLog('[SYNC] Hydration starting...');
    // Mark that we've attempted hydration (even if local has data)
    _hasHydrated = true;
    // Check if local DB has any data
    let hasLocalData = false;
    for (const table of config.tables) {
        const count = await db.table(getDexieTableFor(table)).count();
        if (count > 0) {
            hasLocalData = true;
            break;
        }
    }
    if (hasLocalData) {
        // Local has data, release lock and do a normal sync
        debugLog('[SYNC] Hydration: local data exists, falling through to incremental sync');
        releaseSyncLock();
        // If client has been offline longer than tombstone TTL, run full reconciliation
        // to remove local records whose server tombstones were already hard-deleted
        await fullReconciliation();
        // Check for orphaned changes (local data modified after last sync, but empty queue)
        await reconcileLocalWithRemote();
        await runFullSync();
        return;
    }
    // Local is empty, do a full pull (we already hold the lock)
    syncStatusStore.setStatus('syncing');
    syncStatusStore.setSyncMessage('Loading your data...');
    try {
        // Pull all non-deleted records from each table (explicit columns for egress optimization)
        // Filter deleted = false OR deleted IS NULL to exclude tombstones
        const results = await Promise.all(config.tables.map((table) => supabase
            .from(table.supabaseName)
            .select(table.columns)
            .or('deleted.is.null,deleted.eq.false')));
        // Check for errors
        for (const r of results) {
            if (r.error)
                throw r.error;
        }
        // Track egress for initial hydration
        for (let i = 0; i < config.tables.length; i++) {
            trackEgress(config.tables[i].supabaseName, results[i].data);
        }
        let totalRecords = 0;
        for (const r of results) {
            totalRecords += r.data?.length || 0;
        }
        debugLog(`[SYNC] Initial hydration: ${totalRecords} records (${formatBytes(egressStats.totalBytes)})`);
        // Calculate the max updated_at from all pulled data to use as sync cursor
        // This prevents missing changes that happened during hydration
        let maxUpdatedAt = '1970-01-01T00:00:00.000Z';
        for (const r of results) {
            for (const item of (r.data || [])) {
                const updatedAt = item.updated_at;
                if (updatedAt && updatedAt > maxUpdatedAt) {
                    maxUpdatedAt = updatedAt;
                }
            }
        }
        // Store everything locally
        const entityTables = config.tables.map((t) => db.table(getDexieTableFor(t)));
        await db.transaction('rw', entityTables, async () => {
            for (let i = 0; i < config.tables.length; i++) {
                const data = results[i].data;
                if (data && data.length > 0) {
                    await db.table(getDexieTableFor(config.tables[i])).bulkPut(data);
                }
            }
        });
        // Set sync cursor to MAX of pulled data timestamps (prevents missing concurrent changes)
        setLastSyncCursor(maxUpdatedAt, userId);
        syncStatusStore.setStatus('idle');
        syncStatusStore.setLastSyncTime(new Date().toISOString());
        syncStatusStore.setSyncMessage('Everything is synced!');
        syncStatusStore.setError(null);
        // Notify stores
        notifySyncComplete();
    }
    catch (error) {
        debugError('Hydration failed:', error);
        const friendlyMessage = parseErrorMessage(error);
        const rawMessage = extractErrorMessage(error);
        syncStatusStore.setStatus('error');
        syncStatusStore.setError(friendlyMessage, rawMessage);
        syncStatusStore.setSyncMessage(friendlyMessage);
        // Reset _hasHydrated so next read attempt can retry hydration
        _hasHydrated = false;
    }
    finally {
        releaseSyncLock();
    }
}
// =============================================================================
// TOMBSTONE CLEANUP
// =============================================================================
//
// The engine uses "soft deletes" — deleted records are marked `deleted: true`
// rather than being physically removed. This allows other devices to discover
// the deletion during their next sync (they see the tombstone and remove their
// local copy).
//
// However, tombstones accumulate over time. After `tombstoneMaxAgeDays` (default 7),
// tombstones are "hard deleted" (physically removed) from both local and server.
//
// **Important**: If a device has been offline longer than the tombstone TTL, it may
// miss tombstone deletions. The `fullReconciliation()` function handles this by
// comparing local IDs against server IDs and removing orphans.
// =============================================================================
/** Minimum interval between server-side tombstone cleanups (24 hours) */
const CLEANUP_INTERVAL_MS = 86400000;
/** Timestamp of the last server-side cleanup (prevents running more than once/day) */
let lastServerCleanup = 0;
/**
 * Remove expired tombstones from the local IndexedDB.
 *
 * Scans all entity tables for records with `deleted === true` and
 * `updated_at` older than the tombstone cutoff date. Runs inside
 * a Dexie transaction for atomicity.
 *
 * @returns Number of tombstones removed
 */
async function cleanupLocalTombstones() {
    const tombstoneMaxAgeDays = getTombstoneMaxAgeDays();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - tombstoneMaxAgeDays);
    const cutoffStr = cutoffDate.toISOString();
    const config = getEngineConfig();
    const db = config.db;
    let totalDeleted = 0;
    try {
        const entityTables = config.tables.map((t) => db.table(getDexieTableFor(t)));
        await db.transaction('rw', entityTables, async () => {
            for (const tableConfig of config.tables) {
                const table = db.table(getDexieTableFor(tableConfig));
                const count = await table
                    .filter((item) => item.deleted === true && item.updated_at < cutoffStr)
                    .delete();
                if (count > 0) {
                    debugLog(`[Tombstone] Cleaned ${count} old records from local ${getDexieTableFor(tableConfig)}`);
                    totalDeleted += count;
                }
            }
        });
        if (totalDeleted > 0) {
            debugLog(`[Tombstone] Local cleanup complete: ${totalDeleted} total records removed`);
        }
    }
    catch (error) {
        debugError('[Tombstone] Failed to cleanup local tombstones:', error);
    }
    return totalDeleted;
}
/**
 * Remove expired tombstones from Supabase (server-side cleanup).
 *
 * Rate-limited to once per 24 hours to avoid unnecessary API calls.
 * Uses actual DELETE (not soft delete) to physically remove the rows.
 * Can be forced via the `force` parameter (used by debug utilities).
 *
 * @param force - If `true`, bypass the 24-hour rate limit
 * @returns Number of tombstones removed from the server
 */
async function cleanupServerTombstones(force = false) {
    // Only run once per day to avoid unnecessary requests (unless forced)
    const now = Date.now();
    if (!force && now - lastServerCleanup < CLEANUP_INTERVAL_MS) {
        return 0;
    }
    if (typeof navigator === 'undefined' || !navigator.onLine)
        return 0;
    const tombstoneMaxAgeDays = getTombstoneMaxAgeDays();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - tombstoneMaxAgeDays);
    const cutoffStr = cutoffDate.toISOString();
    const config = getEngineConfig();
    const supabase = config.supabase;
    let totalDeleted = 0;
    try {
        for (const tableConfig of config.tables) {
            const { data, error } = await supabase
                .from(tableConfig.supabaseName)
                .delete()
                .eq('deleted', true)
                .lt('updated_at', cutoffStr)
                .select('id');
            if (error) {
                debugError(`[Tombstone] Failed to cleanup ${tableConfig.supabaseName}:`, error.message);
            }
            else if (data && data.length > 0) {
                debugLog(`[Tombstone] Cleaned ${data.length} old records from server ${tableConfig.supabaseName}`);
                totalDeleted += data.length;
            }
        }
        lastServerCleanup = now;
        if (totalDeleted > 0) {
            debugLog(`[Tombstone] Server cleanup complete: ${totalDeleted} total records removed`);
        }
    }
    catch (error) {
        debugError('[Tombstone] Failed to cleanup server tombstones:', error);
    }
    return totalDeleted;
}
/**
 * Run both local and server tombstone cleanup.
 *
 * @returns Object with counts of tombstones removed locally and from the server
 */
async function cleanupOldTombstones() {
    const local = await cleanupLocalTombstones();
    const server = await cleanupServerTombstones();
    return { local, server };
}
/**
 * Debug utility: inspect tombstone counts and optionally trigger cleanup.
 *
 * Displays per-table tombstone counts, ages, and eligibility for cleanup.
 *
 * @param options - Control cleanup behavior
 * @param options.cleanup - If `true`, run tombstone cleanup after inspection
 * @param options.force - If `true`, bypass the 24-hour server cleanup rate limit
 *
 * @example
 * ```js
 * // In browser console:
 * __engineTombstones()                          // Inspect only
 * __engineTombstones({ cleanup: true })          // Inspect + cleanup
 * __engineTombstones({ cleanup: true, force: true })  // Force server cleanup too
 * ```
 */
async function debugTombstones(options) {
    const tombstoneMaxAgeDays = getTombstoneMaxAgeDays();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - tombstoneMaxAgeDays);
    const cutoffStr = cutoffDate.toISOString();
    const config = getEngineConfig();
    const db = config.db;
    const supabase = config.supabase;
    debugLog('=== TOMBSTONE DEBUG ===');
    debugLog(`Cutoff date (${tombstoneMaxAgeDays} days ago): ${cutoffStr}`);
    debugLog(`Last server cleanup: ${lastServerCleanup ? new Date(lastServerCleanup).toISOString() : 'Never'}`);
    debugLog('');
    // Check local tombstones
    debugLog('--- LOCAL TOMBSTONES (IndexedDB) ---');
    let totalLocalTombstones = 0;
    let totalLocalEligible = 0;
    for (const tableConfig of config.tables) {
        const table = db.table(getDexieTableFor(tableConfig));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allDeleted = await table.filter((item) => item.deleted === true).toArray();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eligible = allDeleted.filter((item) => item.updated_at < cutoffStr);
        if (allDeleted.length > 0) {
            debugLog(`  ${getDexieTableFor(tableConfig)}: ${allDeleted.length} tombstones (${eligible.length} eligible for cleanup)`);
            totalLocalTombstones += allDeleted.length;
            totalLocalEligible += eligible.length;
            // Show oldest tombstone
            if (allDeleted.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const oldest = allDeleted.reduce((a, b) => (a.updated_at < b.updated_at ? a : b));
                debugLog(`    Oldest: ${oldest.updated_at}`);
            }
        }
    }
    debugLog(`  TOTAL: ${totalLocalTombstones} tombstones (${totalLocalEligible} eligible)`);
    debugLog('');
    // Check server tombstones (if online)
    if (navigator.onLine) {
        debugLog('--- SERVER TOMBSTONES (Supabase) ---');
        let totalServerTombstones = 0;
        let totalServerEligible = 0;
        for (const tableConfig of config.tables) {
            const { data: allDeleted, error } = await supabase
                .from(tableConfig.supabaseName)
                .select('id,updated_at')
                .eq('deleted', true);
            if (error) {
                debugLog(`  ${tableConfig.supabaseName}: ERROR - ${error.message}`);
                continue;
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const eligible = (allDeleted || []).filter((item) => item.updated_at < cutoffStr);
            if (allDeleted && allDeleted.length > 0) {
                debugLog(`  ${tableConfig.supabaseName}: ${allDeleted.length} tombstones (${eligible.length} eligible for cleanup)`);
                totalServerTombstones += allDeleted.length;
                totalServerEligible += eligible.length;
                // Show oldest tombstone
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const oldest = allDeleted.reduce((a, b) => (a.updated_at < b.updated_at ? a : b));
                debugLog(`    Oldest: ${oldest.updated_at}`);
            }
        }
        debugLog(`  TOTAL: ${totalServerTombstones} tombstones (${totalServerEligible} eligible)`);
    }
    else {
        debugLog('--- SERVER TOMBSTONES: Offline, skipping ---');
    }
    debugLog('');
    // Run cleanup if requested
    if (options?.cleanup) {
        debugLog('--- RUNNING CLEANUP ---');
        const localDeleted = await cleanupLocalTombstones();
        const serverDeleted = options?.force
            ? await cleanupServerTombstones(true)
            : await cleanupServerTombstones();
        debugLog(`Cleanup complete: ${localDeleted} local, ${serverDeleted} server records removed`);
    }
    else {
        debugLog('To run cleanup, call: debugTombstones({ cleanup: true })');
        debugLog('To force server cleanup (bypass 24h limit): debugTombstones({ cleanup: true, force: true })');
    }
    debugLog('========================');
}
// =============================================================================
// LIFECYCLE — Start / Stop
// =============================================================================
//
// The sync engine has a clear lifecycle:
//
// 1. **startSyncEngine()**: Called once after `initEngine()` configures the engine.
//    Sets up all event listeners, timers, realtime subscriptions, and runs the
//    initial hydration/sync. Idempotent — safe to call multiple times (cleans up
//    existing listeners first).
//
// 2. **stopSyncEngine()**: Called during app teardown or before reconfiguring.
//    Removes all event listeners, clears timers, unsubscribes from realtime,
//    and releases the sync lock. After this, no sync activity occurs.
//
// 3. **clearLocalCache()**: Called during logout to wipe all local data.
//    Clears entity tables, sync queue, conflict history, and sync cursors.
// =============================================================================
/** Unsubscribe function for realtime data update events */
let realtimeDataUnsubscribe = null;
/** Unsubscribe function for realtime connection state change events */
let realtimeConnectionUnsubscribe = null;
/** Supabase auth state change subscription (has nested unsubscribe structure) */
let authStateUnsubscribe = null;
/**
 * Start the sync engine: initialize all listeners, timers, and subscriptions.
 *
 * This is the main "boot" function for the sync engine. It:
 * 1. Ensures the Dexie DB is open and upgraded
 * 2. Cleans up any existing listeners (idempotent restart support)
 * 3. Subscribes to Supabase auth state changes (handles sign-out/token-refresh)
 * 4. Registers online/offline handlers with auth validation
 * 5. Registers visibility change handler for smart tab-return syncing
 * 6. Starts realtime WebSocket subscriptions
 * 7. Starts periodic background sync interval
 * 8. Validates Supabase schema (one-time)
 * 9. Runs initial hydration (if local DB is empty) or full sync
 * 10. Runs initial cleanup (tombstones, conflicts, failed items)
 * 11. Starts the watchdog timer
 * 12. Registers debug window utilities (Tombstones, Sync, Diagnostics)
 *
 * **Must be called after `initEngine()`** — requires configuration to be set.
 * Safe to call multiple times (previous listeners are cleaned up first).
 */
export async function startSyncEngine() {
    if (typeof window === 'undefined')
        return;
    if (isDemoMode())
        return;
    // Ensure DB is open and upgraded before any access
    await waitForDb();
    const supabase = getSupabase();
    // Clean up any existing listeners and intervals first (prevents duplicates if called multiple times)
    if (handleOnlineRef) {
        window.removeEventListener('online', handleOnlineRef);
    }
    if (handleOfflineRef) {
        window.removeEventListener('offline', handleOfflineRef);
    }
    if (handleVisibilityChangeRef) {
        document.removeEventListener('visibilitychange', handleVisibilityChangeRef);
    }
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
    if (syncTimeout) {
        clearTimeout(syncTimeout);
        syncTimeout = null;
    }
    if (visibilityDebounceTimeout) {
        clearTimeout(visibilityDebounceTimeout);
        visibilityDebounceTimeout = null;
    }
    if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
    }
    if (realtimeDataUnsubscribe) {
        realtimeDataUnsubscribe();
        realtimeDataUnsubscribe = null;
    }
    if (realtimeConnectionUnsubscribe) {
        realtimeConnectionUnsubscribe();
        realtimeConnectionUnsubscribe = null;
    }
    if (authStateUnsubscribe) {
        authStateUnsubscribe.data.subscription.unsubscribe();
        authStateUnsubscribe = null;
    }
    // Initialize network status monitoring (idempotent)
    isOnline.init();
    // Subscribe to auth state changes.
    // CRITICAL for iOS PWA: Safari aggressively kills background tabs, which can expire
    // the Supabase session. When the user returns, TOKEN_REFRESHED fires and we need
    // to restart realtime + trigger a sync to catch up on missed changes.
    authStateUnsubscribe = supabase.auth.onAuthStateChange(async (event, session) => {
        debugLog(`[SYNC] Auth state change: ${event}`);
        if (event === 'SIGNED_OUT') {
            // User signed out - stop realtime and show error
            debugWarn('[SYNC] User signed out - stopping sync');
            stopRealtimeSubscriptions();
            syncStatusStore.setStatus('error');
            syncStatusStore.setError('Signed out', 'Please sign in to sync your data.');
        }
        else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
            // User signed in or token refreshed - restart sync
            debugLog('[SYNC] Auth restored - resuming sync');
            if (navigator.onLine) {
                // Clear any auth errors
                syncStatusStore.reset();
                // Restart realtime
                if (session?.user?.id) {
                    startRealtimeSubscriptions(session.user.id);
                }
                // Run a sync to push any pending changes
                runFullSync(false).catch((e) => debugError('[SYNC] Auth-triggered sync failed:', e));
            }
        }
        // Delegate to app-level callback
        const config = getEngineConfig();
        if (config.onAuthStateChange) {
            config.onAuthStateChange(event, session);
        }
    });
    // Register disconnect handler: proactively create an offline session from cached
    // credentials so the user can continue working without interruption. The offline
    // session is validated on reconnect before any sync operations are allowed.
    isOnline.onDisconnect(async () => {
        debugLog('[Engine] Gone offline - creating offline session if credentials cached');
        try {
            const currentSession = await getSession();
            if (!currentSession?.user?.id) {
                debugLog('[Engine] No active Supabase session - skipping offline session creation');
                return;
            }
            const credentials = await getOfflineCredentials();
            if (!credentials) {
                debugLog('[Engine] No cached credentials - skipping offline session creation');
                return;
            }
            // SECURITY: Only create offline session if credentials match current user
            if (credentials.userId !== currentSession.user.id ||
                credentials.email !== currentSession.user.email) {
                debugWarn('[Engine] Cached credentials do not match current user - skipping offline session creation');
                return;
            }
            const existingSession = await getValidOfflineSession();
            if (!existingSession) {
                await createOfflineSession(credentials.userId);
                debugLog('[Engine] Offline session created from cached credentials');
            }
        }
        catch (e) {
            debugError('[Engine] Failed to create offline session:', e);
        }
    });
    // Register reconnect handler: re-validate credentials with Supabase
    isOnline.onReconnect(async () => {
        debugLog('[Engine] Back online - validating credentials');
        const config = getEngineConfig();
        try {
            // Re-validate with Supabase with 15s timeout
            const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), 15000));
            const validationPromise = (async () => {
                const { data: { user }, error } = await getSupabase().auth.getUser();
                if (error || !user)
                    return null;
                return user;
            })();
            const user = await Promise.race([validationPromise, timeoutPromise]);
            if (user) {
                markAuthValidated();
                debugLog('[Engine] Auth validated on reconnect');
                // Trigger sync after successful auth validation (with egress cooldown)
                const timeSinceLastSync = Date.now() - lastSuccessfulSyncTimestamp;
                if (timeSinceLastSync < getOnlineReconnectCooldownMs()) {
                    debugLog(`[SYNC] Skipping reconnect sync (last sync ${Math.round(timeSinceLastSync / 1000)}s ago)`);
                }
                else {
                    runFullSync(false).catch((e) => debugError('[SYNC] Reconnect sync failed:', e));
                }
            }
            else {
                debugWarn('[Engine] Auth validation failed on reconnect');
                if (config.onAuthKicked) {
                    // Stop engine and clear data
                    await clearPendingSyncQueue();
                    config.onAuthKicked('Session expired. Please sign in again.');
                }
            }
        }
        catch (e) {
            debugError('[Engine] Reconnect auth check failed:', e);
            if (config.onAuthKicked) {
                config.onAuthKicked('Failed to verify session. Please sign in again.');
            }
        }
    });
    // Reset sync status to clean state (clears any stale error from previous session)
    // This prevents error flash when navigating back after a previous sync failure
    syncStatusStore.reset();
    // IMPORTANT: If starting while offline, mark that auth validation is needed
    // This ensures we don't attempt to sync until credentials are validated on reconnect
    // Fixes race condition where sync engine's 'online' handler fires before auth check
    if (!navigator.onLine) {
        markOffline();
    }
    // Handle browser 'online' event — restart realtime WebSocket subscriptions.
    //
    // IMPORTANT: We do NOT trigger a sync here. Sync is handled by the
    // `isOnline.onReconnect()` callback (registered above), which runs AFTER auth
    // has been validated. If we called `runFullSync()` here, it would race with
    // the reconnect handler's auth check and could attempt to sync with an expired
    // session, causing silent RLS failures.
    handleOnlineRef = async () => {
        const userId = await getCurrentUserId();
        if (userId) {
            startRealtimeSubscriptions(userId);
        }
    };
    window.addEventListener('online', handleOnlineRef);
    // Handle offline event - immediately update status indicator and mark for auth validation
    handleOfflineRef = () => {
        markOffline(); // Mark that auth needs validation when we come back online
        syncStatusStore.setStatus('offline');
        syncStatusStore.setSyncMessage("You're offline. Changes will sync when reconnected.");
        // Pause realtime - stops reconnection attempts until we come back online
        pauseRealtime();
    };
    window.addEventListener('offline', handleOfflineRef);
    // Track visibility and sync when returning to tab (with smart timing)
    handleVisibilityChangeRef = () => {
        const wasHidden = !isTabVisible;
        isTabVisible = !document.hidden;
        syncStatusStore.setTabVisible(isTabVisible);
        // Track when tab becomes hidden
        if (!isTabVisible) {
            tabHiddenAt = Date.now();
            return;
        }
        // If tab just became visible, check if we should sync
        if (wasHidden && isTabVisible && navigator.onLine) {
            // Only sync if user was away for > configured minutes AND realtime is not healthy
            // If realtime is connected, we're already up-to-date
            const awayDuration = tabHiddenAt ? Date.now() - tabHiddenAt : 0;
            tabHiddenAt = null;
            if (awayDuration < getVisibilitySyncMinAwayMs()) {
                debugLog(`[SYNC] Visibility sync skipped: away only ${Math.round(awayDuration / 1000)}s (min: ${Math.round(getVisibilitySyncMinAwayMs() / 1000)}s)`);
                return;
            }
            // Skip sync if realtime is healthy (we're already up-to-date)
            if (isRealtimeHealthy()) {
                debugLog('[SYNC] Visibility sync skipped: realtime is healthy');
                return;
            }
            // Clear any pending visibility sync
            if (visibilityDebounceTimeout) {
                clearTimeout(visibilityDebounceTimeout);
            }
            // Debounce to prevent rapid syncs when user quickly switches tabs
            visibilityDebounceTimeout = setTimeout(() => {
                visibilityDebounceTimeout = null;
                runFullSync(true).catch((e) => debugError('[SYNC] Visibility sync failed:', e)); // Quiet - no error shown if it fails
            }, VISIBILITY_SYNC_DEBOUNCE_MS);
        }
    };
    document.addEventListener('visibilitychange', handleVisibilityChangeRef);
    // Set initial visibility state
    isTabVisible = !document.hidden;
    syncStatusStore.setTabVisible(isTabVisible);
    // Setup realtime subscriptions
    const userId = await getCurrentUserId();
    if (userId && navigator.onLine) {
        // Subscribe to realtime data updates - refresh stores when remote changes arrive
        realtimeDataUnsubscribe = onRealtimeDataUpdate((table, entityId) => {
            debugLog(`[SYNC] Realtime update received: ${table}/${entityId} - refreshing stores`);
            // Notify stores to refresh from local DB
            notifySyncComplete();
        });
        // Subscribe to realtime connection state changes
        realtimeConnectionUnsubscribe = onConnectionStateChange((connectionState) => {
            // Update sync store with realtime connection state
            syncStatusStore.setRealtimeState(connectionState);
            // Note: 'error' state means max reconnect attempts exhausted
            // Polling will automatically pick up the slack (periodic sync runs when realtime unhealthy)
        });
        // Start realtime subscriptions
        startRealtimeSubscriptions(userId);
    }
    // Start the periodic background sync timer.
    // This is the polling fallback for when realtime subscriptions are down.
    // When realtime IS healthy, periodic sync is skipped entirely — realtime
    // delivers changes in near-real-time, making polling redundant.
    // Also runs housekeeping tasks (tombstone cleanup, conflict history, etc.)
    syncInterval = setInterval(async () => {
        // Only poll if: tab is visible AND online AND realtime is NOT healthy.
        // This egress optimization is critical — without it, every open tab polls
        // the entire database every 15 minutes regardless of realtime status.
        if (navigator.onLine && isTabVisible && !isRealtimeHealthy()) {
            runFullSync(true).catch((e) => debugError('[SYNC] Periodic sync failed:', e)); // Quiet background sync
        }
        // Cleanup old tombstones, conflict history, failed sync items, and recently modified cache
        await cleanupOldTombstones();
        await cleanupConflictHistory();
        cleanupRecentlyModified();
        cleanupRealtimeTracking();
        const failedResult = await cleanupFailedItems();
        // Notify user if items permanently failed
        if (failedResult.count > 0) {
            syncStatusStore.setStatus('error');
            syncStatusStore.setError(`${failedResult.count} change(s) could not be synced and were discarded.`, `Affected: ${failedResult.tables.join(', ')}`);
            syncStatusStore.setSyncMessage(`${failedResult.count} change(s) failed to sync`);
        }
    }, getSyncIntervalMs());
    // One-time schema validation (only when online, only first run)
    if (navigator.onLine && !_schemaValidated) {
        _schemaValidated = true;
        validateSchema()
            .then((result) => {
            if (!result.valid) {
                const msg = `Missing or inaccessible Supabase tables: ${result.missingTables.length > 0 ? result.missingTables.join(', ') : 'see errors'}`;
                debugError('[SYNC]', msg);
                for (const err of result.errors) {
                    debugError('[SYNC]', err);
                }
                syncStatusStore.setStatus('error');
                syncStatusStore.setError(msg, 'Create the required tables in your Supabase project. See stellar-engine README for the required SQL schema.');
            }
        })
            .catch(() => { });
    }
    // Initial sync: hydrate if empty, otherwise push pending
    if (navigator.onLine) {
        hydrateFromRemote().catch((e) => debugError('[SYNC] Initial hydration failed:', e));
    }
    // Run initial cleanup
    cleanupOldTombstones();
    cleanupConflictHistory();
    cleanupRealtimeTracking();
    cleanupFailedItems().then((failedResult) => {
        if (failedResult.count > 0) {
            syncStatusStore.setStatus('error');
            syncStatusStore.setError(`${failedResult.count} change(s) could not be synced and were discarded.`, `Affected: ${failedResult.tables.join(', ')}`);
        }
    });
    // Watchdog: detect stuck syncs and auto-retry
    if (watchdogInterval) {
        clearInterval(watchdogInterval);
    }
    watchdogInterval = setInterval(() => {
        // If the sync lock has been held for too long, force-release and retry
        if (lockAcquiredAt && Date.now() - lockAcquiredAt > SYNC_LOCK_TIMEOUT_MS) {
            debugWarn(`[SYNC] Watchdog: sync lock stuck for ${Math.round((Date.now() - lockAcquiredAt) / 1000)}s - force-releasing and retrying`);
            releaseSyncLock();
            syncStatusStore.setStatus('idle');
            // Auto-retry after force-release
            if (navigator.onLine) {
                runFullSync(true).catch((e) => debugError('[SYNC] Watchdog retry sync failed:', e));
            }
        }
    }, WATCHDOG_INTERVAL_MS);
    // Expose debug utilities to window for console access
    if (typeof window !== 'undefined' && isDebugMode()) {
        const prefix = getPrefix();
        window[`__${prefix}Tombstones`] = debugTombstones;
        // Sync action tools: forceFullSync, resetSyncCursor, sync
        window[`__${prefix}Sync`] = {
            forceFullSync,
            resetSyncCursor,
            sync: () => runFullSync(false)
        };
        // Unified diagnostics: returns a full JSON snapshot of engine state
        window[`__${prefix}Diagnostics`] = getDiagnostics;
        debugLog(`[SYNC] Debug utilities registered: __${prefix}Sync, __${prefix}Tombstones, __${prefix}Diagnostics`);
    }
}
/**
 * Stop the sync engine: tear down all listeners, timers, and subscriptions.
 *
 * After calling this, no sync activity will occur. All event listeners are
 * removed to prevent memory leaks. The sync lock is released in case a sync
 * was in progress. Hydration and schema validation flags are reset so the
 * engine can be cleanly restarted.
 *
 * Call this during app teardown, before reconfiguring the engine, or when
 * the user navigates away from pages that need sync.
 */
export async function stopSyncEngine() {
    if (typeof window === 'undefined')
        return;
    // Stop watchdog
    if (watchdogInterval) {
        clearInterval(watchdogInterval);
        watchdogInterval = null;
    }
    // Remove event listeners to prevent memory leaks
    if (handleOnlineRef) {
        window.removeEventListener('online', handleOnlineRef);
        handleOnlineRef = null;
    }
    if (handleOfflineRef) {
        window.removeEventListener('offline', handleOfflineRef);
        handleOfflineRef = null;
    }
    if (handleVisibilityChangeRef) {
        document.removeEventListener('visibilitychange', handleVisibilityChangeRef);
        handleVisibilityChangeRef = null;
    }
    // Clean up realtime subscription callbacks
    if (realtimeDataUnsubscribe) {
        realtimeDataUnsubscribe();
        realtimeDataUnsubscribe = null;
    }
    if (realtimeConnectionUnsubscribe) {
        realtimeConnectionUnsubscribe();
        realtimeConnectionUnsubscribe = null;
    }
    if (authStateUnsubscribe) {
        authStateUnsubscribe.data.subscription.unsubscribe();
        authStateUnsubscribe = null;
    }
    // Stop realtime subscriptions
    await stopRealtimeSubscriptions();
    if (syncTimeout) {
        clearTimeout(syncTimeout);
        syncTimeout = null;
    }
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
    if (visibilityDebounceTimeout) {
        clearTimeout(visibilityDebounceTimeout);
        visibilityDebounceTimeout = null;
    }
    releaseSyncLock();
    _hasHydrated = false;
    _schemaValidated = false;
    // Clean up debug window utilities
    if (typeof window !== 'undefined') {
        const prefix = getPrefix();
        delete window[`__${prefix}Tombstones`];
        delete window[`__${prefix}Sync`];
        delete window[`__${prefix}Diagnostics`];
    }
}
/**
 * Clear all local data from IndexedDB (used during logout).
 *
 * Wipes all entity tables, the sync queue, and conflict history in a single
 * transaction. Also removes the user's sync cursor from localStorage and
 * resets the hydration flag so the next login triggers a fresh hydration.
 *
 * **IMPORTANT**: Call this BEFORE calling `stopSyncEngine()` to ensure the
 * database is still open when clearing tables.
 */
export async function clearLocalCache() {
    const config = getEngineConfig();
    const db = config.db;
    // Get user ID before clearing to remove their sync cursor
    const userId = await getCurrentUserId();
    const entityTables = config.tables.map((t) => db.table(getDexieTableFor(t)));
    const metaTables = [db.table('syncQueue'), db.table('conflictHistory')];
    await db.transaction('rw', [...entityTables, ...metaTables], async () => {
        for (const t of entityTables) {
            await t.clear();
        }
        await db.table('syncQueue').clear();
        await db.table('conflictHistory').clear();
    });
    // Reset sync cursor (user-specific) and hydration flag
    if (typeof localStorage !== 'undefined') {
        // Remove user-specific cursor if we have userId
        if (userId) {
            localStorage.removeItem(`lastSyncCursor_${userId}`);
        }
        // Also remove legacy cursor for cleanup
        localStorage.removeItem('lastSyncCursor');
    }
    _hasHydrated = false;
}
//# sourceMappingURL=engine.js.map