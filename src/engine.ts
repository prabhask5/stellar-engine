import { getEngineConfig, getDexieTableFor, waitForDb } from './config';
import { debugLog, debugWarn, debugError, isDebugMode } from './debug';
import {
  getPendingSync,
  removeSyncItem,
  incrementRetry,
  getPendingEntityIds,
  cleanupFailedItems,
  coalescePendingOps,
  queueSyncOperation
} from './queue';
import { getDeviceId } from './deviceId';
import type { SyncOperationItem } from './types';
import { syncStatusStore } from './stores/sync';
import {
  resolveConflicts,
  storeConflictHistory,
  cleanupConflictHistory,
  getPendingOpsForEntity
} from './conflicts';
import {
  startRealtimeSubscriptions,
  stopRealtimeSubscriptions,
  onRealtimeDataUpdate,
  onConnectionStateChange,
  cleanupRealtimeTracking,
  isRealtimeHealthy,
  getConnectionState,
  pauseRealtime,
  wasRecentlyProcessedByRealtime,
  type RealtimeConnectionState
} from './realtime';
import { isOnline } from './stores/network';
import { getSession } from './supabase/auth';
import { supabase as supabaseProxy } from './supabase/client';
import { getOfflineCredentials } from './auth/offlineCredentials';
import { getValidOfflineSession, createOfflineSession } from './auth/offlineSession';
import { validateSchema } from './supabase/validate';

// ============================================================
// LOCAL-FIRST SYNC ENGINE
//
// Rules:
// 1. All reads come from local DB (IndexedDB)
// 2. All writes go to local DB first, immediately
// 3. Every write creates a pending operation in the outbox
// 4. Sync loop ships outbox to server in background
// 5. On refresh, load local state instantly, then run background sync
// ============================================================

// Helper functions for config-driven access
function getDb() {
  const db = getEngineConfig().db;
  if (!db) throw new Error('Database not initialized. Provide db or database config to initEngine().');
  return db;
}
function getSupabase() {
  const config = getEngineConfig();
  if (config.supabase) return config.supabase;
  // Fall back to the proxy-based supabase client
  return supabaseProxy;
}
function getDexieTableName(supabaseName: string): string {
  const table = getEngineConfig().tables.find(t => t.supabaseName === supabaseName);
  return table ? getDexieTableFor(table) : supabaseName;
}
function getColumns(supabaseName: string): string {
  const table = getEngineConfig().tables.find(t => t.supabaseName === supabaseName);
  return table?.columns || '*';
}
function isSingletonTable(supabaseName: string): boolean {
  const table = getEngineConfig().tables.find(t => t.supabaseName === supabaseName);
  return table?.isSingleton || false;
}

// Getter functions for config values (can't read config at module level)
function getSyncDebounceMs(): number {
  return getEngineConfig().syncDebounceMs ?? 2000;
}
function getSyncIntervalMs(): number {
  return getEngineConfig().syncIntervalMs ?? 900000;
}
function getTombstoneMaxAgeDays(): number {
  return getEngineConfig().tombstoneMaxAgeDays ?? 1;
}
function getVisibilitySyncMinAwayMs(): number {
  return getEngineConfig().visibilitySyncMinAwayMs ?? 300000;
}
function getOnlineReconnectCooldownMs(): number {
  return getEngineConfig().onlineReconnectCooldownMs ?? 120000;
}
function getPrefix(): string {
  return getEngineConfig().prefix || 'engine';
}

// Track if we were recently offline (for auth validation on reconnect)
let wasOffline = false;
let authValidatedAfterReconnect = true; // Start as true (no validation needed initially)
let _schemaValidated = false; // One-time schema validation flag

/**
 * Clear all pending sync operations (used when auth is invalid)
 * SECURITY: Called when offline credentials are found to be invalid
 * to prevent unauthorized data from being synced to the server
 */
export async function clearPendingSyncQueue(): Promise<number> {
  try {
    const db = getDb();
    const count = await db.table('syncQueue').count();
    await db.table('syncQueue').clear();
    debugLog(`[SYNC] Cleared ${count} pending sync operations (auth invalid)`);
    return count;
  } catch (e) {
    debugError('[SYNC] Failed to clear sync queue:', e);
    return 0;
  }
}

/**
 * Mark that we need auth validation before next sync
 * Called when going offline
 */
function markOffline(): void {
  wasOffline = true;
  authValidatedAfterReconnect = false;
}

/**
 * Mark auth as validated (safe to sync)
 * Called after successful credential validation on reconnect
 */
function markAuthValidated(): void {
  authValidatedAfterReconnect = true;
  wasOffline = false;
}

/**
 * Check if auth needs validation before syncing
 */
function needsAuthValidation(): boolean {
  return wasOffline && !authValidatedAfterReconnect;
}

// ============================================================
// EGRESS MONITORING - Track sync cycles for debugging
// ============================================================
interface SyncCycleStats {
  timestamp: string;
  trigger: string;
  pushedItems: number;
  pulledTables: number;
  pulledRecords: number;
  egressBytes: number;
  durationMs: number;
}

const syncStats: SyncCycleStats[] = [];
let totalSyncCycles = 0;

// Egress tracking
interface EgressStats {
  totalBytes: number;
  totalRecords: number;
  byTable: Record<string, { bytes: number; records: number }>;
  sessionStart: string;
}

const egressStats: EgressStats = {
  totalBytes: 0,
  totalRecords: 0,
  byTable: {},
  sessionStart: new Date().toISOString()
};

// Helper to estimate JSON size in bytes
function estimateJsonSize(data: unknown): number {
  try {
    return new Blob([JSON.stringify(data)]).size;
  } catch {
    // Fallback: rough estimate based on JSON string length
    return JSON.stringify(data).length;
  }
}

// Track egress for a table
function trackEgress(
  tableName: string,
  data: unknown[] | null
): { bytes: number; records: number } {
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

// Format bytes for display
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function logSyncCycle(stats: Omit<SyncCycleStats, 'timestamp'>) {
  const entry: SyncCycleStats = {
    ...stats,
    timestamp: new Date().toISOString()
  };
  syncStats.push(entry);
  totalSyncCycles++;

  // Keep only last 100 entries
  if (syncStats.length > 100) {
    syncStats.shift();
  }

  debugLog(
    `[SYNC] Cycle #${totalSyncCycles}: ` +
      `trigger=${stats.trigger}, pushed=${stats.pushedItems}, ` +
      `pulled=${stats.pulledRecords} records (${formatBytes(stats.egressBytes)}), ${stats.durationMs}ms`
  );
}

// Export for debugging in browser console
// Uses configurable prefix: window.__<prefix>SyncStats?.()
// Also: window.__<prefix>Tombstones?.() or window.__<prefix>Tombstones?.({ cleanup: true, force: true })
// Also: window.__<prefix>Egress?.()
// Also: window.__<prefix>Sync.forceFullSync(), .resetSyncCursor(), .sync(), .getStatus(), .checkConnection(), .realtimeStatus()
function initDebugWindowUtilities(): void {
  if (typeof window === 'undefined' || !isDebugMode()) return;

  const prefix = getPrefix();

  (window as unknown as Record<string, unknown>)[`__${prefix}SyncStats`] = () => {
    const recentMinute = syncStats.filter(
      (s) => new Date(s.timestamp).getTime() > Date.now() - 60000
    );
    debugLog(`=== ${prefix.toUpperCase()} SYNC STATS ===`);
    debugLog(`Total cycles: ${totalSyncCycles}`);
    debugLog(`Last minute: ${recentMinute.length} cycles`);
    debugLog(`Recent cycles:`, syncStats.slice(-10));
    return { totalSyncCycles, recentMinute: recentMinute.length, recent: syncStats.slice(-10) };
  };

  (window as unknown as Record<string, unknown>)[`__${prefix}Egress`] = () => {
    debugLog(`=== ${prefix.toUpperCase()} EGRESS STATS ===`);
    debugLog(`Session started: ${egressStats.sessionStart}`);
    debugLog(
      `Total egress: ${formatBytes(egressStats.totalBytes)} (${egressStats.totalRecords} records)`
    );
    debugLog('');
    debugLog('--- BY TABLE ---');

    // Sort tables by bytes descending
    const sortedTables = Object.entries(egressStats.byTable).sort(
      ([, a], [, b]) => b.bytes - a.bytes
    );

    for (const [table, stats] of sortedTables) {
      const pct =
        egressStats.totalBytes > 0
          ? ((stats.bytes / egressStats.totalBytes) * 100).toFixed(1)
          : '0';
      debugLog(`  ${table}: ${formatBytes(stats.bytes)} (${stats.records} records, ${pct}%)`);
    }

    debugLog('');
    debugLog('--- RECENT SYNC CYCLES ---');
    const recent = syncStats.slice(-5);
    for (const cycle of recent) {
      debugLog(
        `  ${cycle.timestamp}: ${formatBytes(cycle.egressBytes)} (${cycle.pulledRecords} records)`
      );
    }

    return {
      sessionStart: egressStats.sessionStart,
      totalBytes: egressStats.totalBytes,
      totalFormatted: formatBytes(egressStats.totalBytes),
      totalRecords: egressStats.totalRecords,
      byTable: egressStats.byTable,
      recentCycles: syncStats.slice(-10)
    };
  };

  // Tombstone debug - will be initialized after debugTombstones function is defined
  // See below where it's assigned after the function definition
}

let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let syncInterval: ReturnType<typeof setInterval> | null = null;
let _hasHydrated = false; // Track if initial hydration has been attempted

// EGRESS OPTIMIZATION: Cache getUser() validation to avoid network call every sync cycle
let lastUserValidation = 0;
let lastValidatedUserId: string | null = null;
const USER_VALIDATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// EGRESS OPTIMIZATION: Track last successful sync for online-reconnect cooldown
let lastSuccessfulSyncTimestamp = 0;
let isTabVisible = true; // Track tab visibility
let visibilityDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
let tabHiddenAt: number | null = null; // Track when tab became hidden for smart sync
const VISIBILITY_SYNC_DEBOUNCE_MS = 1000; // Debounce for visibility change syncs
const RECENTLY_MODIFIED_TTL_MS = 2000; // Protect recently modified entities for 2 seconds
// Industry standard: 500ms-2000ms. 2s covers sync debounce (1s) + network latency with margin.

// Track recently modified entity IDs to prevent pull from overwriting fresh local changes
// This provides an additional layer of protection beyond the pending queue check
const recentlyModifiedEntities: Map<string, number> = new Map();

// Mark an entity as recently modified (called by repositories after local writes)
export function markEntityModified(entityId: string): void {
  recentlyModifiedEntities.set(entityId, Date.now());
}

// Check if entity was recently modified locally
function isRecentlyModified(entityId: string): boolean {
  const modifiedAt = recentlyModifiedEntities.get(entityId);
  if (!modifiedAt) return false;

  const age = Date.now() - modifiedAt;
  if (age > RECENTLY_MODIFIED_TTL_MS) {
    // Expired, clean up
    recentlyModifiedEntities.delete(entityId);
    return false;
  }
  return true;
}

// Clean up expired entries (called periodically)
function cleanupRecentlyModified(): void {
  const now = Date.now();
  for (const [entityId, modifiedAt] of recentlyModifiedEntities) {
    if (now - modifiedAt > RECENTLY_MODIFIED_TTL_MS) {
      recentlyModifiedEntities.delete(entityId);
    }
  }
}

// Proper async mutex to prevent concurrent syncs
// Uses a queue-based approach where each caller waits for the previous one
let lockPromise: Promise<void> | null = null;
let lockResolve: (() => void) | null = null;
let lockAcquiredAt: number | null = null;
const SYNC_LOCK_TIMEOUT_MS = 60_000; // Force-release lock after 60s

// Store event listener references for cleanup
let handleOnlineRef: (() => void) | null = null;
let handleOfflineRef: (() => void) | null = null;
let handleVisibilityChangeRef: (() => void) | null = null;

// Watchdog: detect stuck syncs and auto-retry
let watchdogInterval: ReturnType<typeof setInterval> | null = null;
const WATCHDOG_INTERVAL_MS = 15_000; // Check every 15s
const SYNC_OPERATION_TIMEOUT_MS = 45_000; // Abort sync operations after 45s

async function acquireSyncLock(): Promise<boolean> {
  // If lock is held, check if it's stale (held too long)
  if (lockPromise !== null) {
    if (lockAcquiredAt && Date.now() - lockAcquiredAt > SYNC_LOCK_TIMEOUT_MS) {
      debugWarn(`[SYNC] Force-releasing stale sync lock (held for ${Math.round((Date.now() - lockAcquiredAt) / 1000)}s)`);
      releaseSyncLock();
    } else {
      return false;
    }
  }

  // Create a new lock promise
  lockPromise = new Promise<void>((resolve) => {
    lockResolve = resolve;
  });
  lockAcquiredAt = Date.now();

  return true;
}

function releaseSyncLock(): void {
  if (lockResolve) {
    lockResolve();
  }
  lockPromise = null;
  lockResolve = null;
  lockAcquiredAt = null;
}

// Timeout wrapper: races a promise against a timeout
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// Callbacks for when sync completes (stores can refresh from local)
const syncCompleteCallbacks: Set<() => void> = new Set();

export function onSyncComplete(callback: () => void): () => void {
  syncCompleteCallbacks.add(callback);
  debugLog(`[SYNC] Store registered for sync complete (total: ${syncCompleteCallbacks.size})`);
  return () => {
    syncCompleteCallbacks.delete(callback);
    debugLog(
      `[SYNC] Store unregistered from sync complete (total: ${syncCompleteCallbacks.size})`
    );
  };
}

function notifySyncComplete(): void {
  debugLog(`[SYNC] Notifying ${syncCompleteCallbacks.size} store callbacks to refresh`);
  for (const callback of syncCompleteCallbacks) {
    try {
      callback();
    } catch (e) {
      debugError('Sync callback error:', e);
    }
  }
}

// ============================================================
// SYNC OPERATIONS - Background sync to/from Supabase
// ============================================================

// Schedule a debounced sync after local writes
export function scheduleSyncPush(): void {
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
    runFullSync(false, skipPull).catch(e => debugError('[SYNC] Push-triggered sync failed:', e)); // Show syncing indicator for user-triggered writes
  }, getSyncDebounceMs());
}

// Get current user ID for sync cursor isolation
// CRITICAL: This validates the session is actually valid, not just cached
async function getCurrentUserId(): Promise<string | null> {
  try {
    const supabase = getSupabase();

    // First check if we have a session at all
    const {
      data: { session },
      error: sessionError
    } = await supabase.auth.getSession();

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
    if (lastValidatedUserId && session.user?.id === lastValidatedUserId && (now - lastUserValidation) < USER_VALIDATION_INTERVAL_MS) {
      return session.user.id;
    }

    // Session is valid, but also validate with getUser() which makes a network call
    // This catches cases where the token is revoked server-side
    const {
      data: { user },
      error: userError
    } = await supabase.auth.getUser();

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
  } catch (e) {
    debugError('[SYNC] Auth validation error:', e);
    return null;
  }
}

// Get last sync cursor from localStorage (per-user to prevent cross-user sync issues)
function getLastSyncCursor(userId: string | null): string {
  if (typeof localStorage === 'undefined') return '1970-01-01T00:00:00.000Z';
  const key = userId ? `lastSyncCursor_${userId}` : 'lastSyncCursor';
  return localStorage.getItem(key) || '1970-01-01T00:00:00.000Z';
}

// Set last sync cursor (per-user)
function setLastSyncCursor(cursor: string, userId: string | null): void {
  if (typeof localStorage !== 'undefined') {
    const key = userId ? `lastSyncCursor_${userId}` : 'lastSyncCursor';
    localStorage.setItem(key, cursor);
  }
}

/**
 * Reset the sync cursor so the next sync pulls ALL data.
 * Available in browser console via window.__<prefix>Sync.resetSyncCursor()
 */
async function resetSyncCursor(): Promise<void> {
  const userId = await getCurrentUserId();
  if (typeof localStorage !== 'undefined') {
    const key = userId ? `lastSyncCursor_${userId}` : 'lastSyncCursor';
    localStorage.removeItem(key);
    debugLog('[SYNC] Sync cursor reset - next sync will pull all data');
  }
}

/**
 * Force a full sync by resetting the cursor and re-downloading all data.
 * Available in browser console via window.__<prefix>Sync.forceFullSync()
 */
async function forceFullSync(): Promise<void> {
  debugLog('[SYNC] Starting force full sync...');

  // Acquire sync lock to prevent concurrent syncs
  const acquired = await acquireSyncLock();
  if (!acquired) {
    debugWarn('[SYNC] Force full sync skipped - sync already in progress');
    return;
  }

  try {
    const config = getEngineConfig();
    const db = config.db!;

    await resetSyncCursor();

    // Clear local data (except sync queue - keep pending changes)
    const entityTables = config.tables.map(t => db.table(getDexieTableFor(t)));
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
  } catch (error) {
    debugError('[SYNC] Force full sync failed:', error);
    syncStatusStore.setStatus('error');
    syncStatusStore.setError('Full sync failed', String(error));
    throw error;
  } finally {
    releaseSyncLock();
  }
}

// PULL: Fetch changes from remote since last sync
// Returns egress stats for this pull operation
// minCursor: optional minimum cursor to use (e.g., timestamp after push completes)
async function pullRemoteChanges(minCursor?: string): Promise<{ bytes: number; records: number }> {
  const userId = await getCurrentUserId();

  // Abort if no authenticated user (avoids confusing RLS errors)
  if (!userId) {
    throw new Error('Not authenticated. Please sign in to sync.');
  }

  const config = getEngineConfig();
  const db = config.db!;
  const supabase = config.supabase!;

  // Use the later of stored cursor or provided minCursor
  // This prevents re-fetching records we just pushed in this sync cycle
  const storedCursor = getLastSyncCursor(userId);
  const lastSync = minCursor && minCursor > storedCursor ? minCursor : storedCursor;

  debugLog(
    `[SYNC] Pulling changes since: ${lastSync} (stored: ${storedCursor}, min: ${minCursor || 'none'})`
  );

  // Track the newest updated_at we see
  let newestUpdate = lastSync;

  // Track egress for this pull
  let pullBytes = 0;
  let pullRecords = 0;

  // Pull all tables in parallel (egress optimization: reduces wall time per sync cycle)
  // Wrapped in timeout to prevent hanging if Supabase doesn't respond
  const results = await withTimeout(Promise.all(
    config.tables.map(table =>
      supabase.from(table.supabaseName).select(table.columns).gt('updated_at', lastSync).order('updated_at', { ascending: true }).order('id', { ascending: true })
    )
  ), 30_000, 'Pull remote changes');

  // Check for errors
  for (let i = 0; i < results.length; i++) {
    if (results[i].error) throw results[i].error;
  }

  // Track egress
  const tableNames = config.tables.map(t => t.supabaseName);
  for (let i = 0; i < config.tables.length; i++) {
    const egress = trackEgress(tableNames[i], results[i].data);
    pullBytes += egress.bytes;
    pullRecords += egress.records;
  }

  // Helper function to apply remote changes with field-level conflict resolution
  async function applyRemoteWithConflictResolution<T extends { id: string; updated_at: string }>(
    entityType: string,
    remoteRecords: T[] | null,
    table: { get: (id: string) => Promise<T | undefined>; put: (entity: T) => Promise<unknown> }
  ): Promise<void> {
    // Fetch pending entity IDs per-table to avoid stale data from earlier in the pull
    const pendingEntityIds = await getPendingEntityIds();

    for (const remote of remoteRecords || []) {
      // Skip recently modified entities (protects against race conditions)
      // Note: We no longer skip entities with pending ops - conflict resolution handles them
      if (isRecentlyModified(remote.id)) continue;

      // Skip entities that were just processed by realtime (prevents duplicate processing)
      if (wasRecentlyProcessedByRealtime(remote.id)) continue;

      const local = await table.get(remote.id);

      // Track newest update for cursor
      if (remote.updated_at > newestUpdate) newestUpdate = remote.updated_at;

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
      } else {
        // Entity has pending operations - apply field-level conflict resolution
        const pendingOps = await getPendingOpsForEntity(remote.id);
        const resolution = await resolveConflicts(
          entityType,
          remote.id,
          local as unknown as Record<string, unknown>,
          remote as unknown as Record<string, unknown>,
          pendingOps
        );

        // Store the merged entity
        await table.put(resolution.mergedEntity as unknown as T);

        // Store conflict history if there were conflicts
        if (resolution.hasConflicts) {
          await storeConflictHistory(resolution);
        }
      }
    }
  }

  // Log what we're about to apply
  const pullSummary: Record<string, number> = {};
  for (let i = 0; i < config.tables.length; i++) {
    pullSummary[tableNames[i]] = results[i].data?.length || 0;
  }
  debugLog(`[SYNC] Pulled from server:`, pullSummary);

  // Apply changes to local DB with conflict handling
  const entityTables = config.tables.map(t => db.table(getDexieTableFor(t)));

  // Check if any table has data to process (avoid opening transaction on empty pull)
  const hasData = results.some(r => r.data && r.data.length > 0);

  if (hasData) {
    await db.transaction(
      'rw',
      [...entityTables, db.table('syncQueue'), db.table('conflictHistory')],
      async () => {
        for (let i = 0; i < config.tables.length; i++) {
          const data = results[i].data as { id: string; updated_at: string }[] | null;
          await applyRemoteWithConflictResolution(
            tableNames[i],
            data,
            db.table(getDexieTableFor(config.tables[i]))
          );
        }
      }
    );
  }

  // Update sync cursor (per-user)
  setLastSyncCursor(newestUpdate, userId);

  return { bytes: pullBytes, records: pullRecords };
}

// PUSH: Send pending operations to remote
// Continues until queue is empty to catch items added during sync
// Track push errors for this sync cycle
let pushErrors: Array<{ message: string; table: string; operation: string; entityId: string }> = [];

interface PushStats {
  originalCount: number;
  coalescedCount: number;
  actualPushed: number;
}

async function pushPendingOps(): Promise<PushStats> {
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
    debugLog(
      `[SYNC] Coalesced ${coalescedCount} redundant operations (${originalCount} -> ${originalCount - coalescedCount})`
    );
  }

  while (iterations < maxIterations) {
    const pendingItems = await getPendingSync();
    if (pendingItems.length === 0) break;

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
      } catch (error) {
        debugError(
          `[SYNC] Failed: ${item.operationType} ${item.table}/${item.entityId}:`,
          error
        );

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
    if (!processedAny) break;
  }

  return { originalCount, coalescedCount, actualPushed };
}

// Check if error is a duplicate key violation (item already exists)
function isDuplicateKeyError(error: { code?: string; message?: string }): boolean {
  // PostgreSQL error code for unique violation
  if (error.code === '23505') return true;
  // PostgREST error codes
  if (error.code === 'PGRST409') return true;
  // Fallback to message check for compatibility
  const msg = (error.message || '').toLowerCase();
  return msg.includes('duplicate') || msg.includes('unique') || msg.includes('already exists');
}

// Check if error is a "not found" error (item doesn't exist)
function isNotFoundError(error: { code?: string; message?: string }): boolean {
  // PostgREST error code for no rows affected/found
  if (error.code === 'PGRST116') return true;
  // HTTP 404 style code
  if (error.code === '404') return true;
  // Fallback to message check
  const msg = (error.message || '').toLowerCase();
  return msg.includes('not found') || msg.includes('no rows');
}

// Classify an error as transient (will likely succeed on retry) or persistent (won't improve)
// Transient errors should not show UI errors until retries are exhausted
// Persistent errors should show immediately since they require user action
function isTransientError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const errObj = error as { code?: string; status?: number };

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

// Process a single sync item (intent-based operation format)
// CRITICAL: All operations use .select() to verify they succeeded
// RLS can silently block operations - returning success but affecting 0 rows
async function processSyncItem(item: SyncOperationItem): Promise<void> {
  const { table, entityId, operationType, field, value, timestamp } = item;
  const deviceId = getDeviceId();
  const supabase = getSupabase();
  const db = getDb();
  const dexieTable = getDexieTableName(table);

  switch (operationType) {
    case 'create': {
      // Create: insert the full payload with device_id
      const payload = value as Record<string, unknown>;
      const { data, error } = await supabase
        .from(table)
        .insert({ id: entityId, ...payload, device_id: deviceId })
        .select('id')
        .maybeSingle();
      // Ignore duplicate key errors (item already synced from another device)
      if (error && isDuplicateKeyError(error)) {
        // For singleton tables, reconcile local ID with server
        if (isSingletonTable(table) && payload.user_id) {
          const { data: existing } = await supabase
            .from(table)
            .select(getColumns(table))
            .eq('user_id', payload.user_id as string)
            .maybeSingle();

          if (existing) {
            // Replace local entry: delete old ID, add with server ID
            await db.table(dexieTable).delete(entityId);
            await db.table(dexieTable).put(existing);
            // Purge any queued operations referencing the old ID
            await db.table('syncQueue')
              .where('entityId')
              .equals(entityId)
              .delete();
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
      // Delete: soft delete with tombstone and device_id
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
      // Increment: we need to read current value, add delta, and update
      // This is done atomically by reading from local DB (which has the current state)
      // The value we push is already the final computed value from local
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
      const updatePayload: Record<string, unknown> = {
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
      if (error) throw error;
      // Check if update actually affected any rows
      if (!data) {
        throw new Error(`Update blocked by RLS or row missing: ${table}/${entityId}`);
      }
      break;
    }

    case 'set': {
      // Set: update the field(s) with the new value(s) and device_id
      let updatePayload: Record<string, unknown>;

      if (field) {
        // Single field set
        updatePayload = {
          [field]: value,
          updated_at: timestamp,
          device_id: deviceId
        };
      } else {
        // Multi-field set (value is the full payload)
        updatePayload = {
          ...(value as Record<string, unknown>),
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
      if (error) throw error;
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
              await db.table('syncQueue')
                .where('entityId')
                .equals(entityId)
                .delete();

              if (retryError) throw retryError;
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

// Extract raw error message from various error formats (Supabase, Error, etc.)
function extractErrorMessage(error: unknown): string {
  // Standard Error object
  if (error instanceof Error) {
    return error.message;
  }

  // Supabase/PostgreSQL error object: { message, details, hint, code }
  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;

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
    } catch {
      return '[Unable to parse error]';
    }
  }

  // Primitive types
  return String(error);
}

// Parse error into user-friendly message
function parseErrorMessage(error: unknown): string {
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
    if (
      msg.includes('jwt') ||
      msg.includes('token') ||
      msg.includes('unauthorized') ||
      msg.includes('401')
    ) {
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

// Full sync: push first (so our changes are persisted), then pull
// quiet: if true, don't update UI status at all (for background periodic syncs)
export async function runFullSync(quiet: boolean = false, skipPull: boolean = false): Promise<void> {
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
    debugWarn(
      '[SYNC] No authenticated user - cannot sync. RLS would silently block all writes.'
    );
    if (!quiet) {
      syncStatusStore.setStatus('error');
      syncStatusStore.setError('Not signed in', 'Please sign in to sync your data.');
      syncStatusStore.setSyncMessage('Sign in required to sync');
    }
    return;
  }

  // Atomically acquire sync lock to prevent concurrent syncs
  const acquired = await acquireSyncLock();
  if (!acquired) return;

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
    } else {
      if (!quiet) {
        syncStatusStore.setSyncMessage('Downloading latest data...');
      }

      // Pull remote changes - retry up to 3 times if push succeeded
      // Uses stored cursor to get all changes since last sync
      // Conflict resolution handles our own pushed changes via device_id check
      let pullAttempts = 0;
      const maxPullAttempts = 3;
      let lastPullError: unknown = null;

      while (pullAttempts < maxPullAttempts && !pullSucceeded) {
        try {
          // Don't pass postPushCursor - we want ALL changes since stored cursor
          // The conflict resolution handles our own pushed changes via device_id check
          pullEgress = await withTimeout(pullRemoteChanges(), SYNC_OPERATION_TIMEOUT_MS, 'Pull remote changes');
          pullSucceeded = true;
        } catch (pullError) {
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
        syncStatusStore.setSyncMessage(
          `${remaining.length} change${remaining.length === 1 ? '' : 's'} failed to sync`
        );

        // Show error details
        if (hasSignificantErrors) {
          // Show the latest specific error
          const latestError = pushErrors[pushErrors.length - 1];
          syncStatusStore.setError(
            `Failed to sync ${latestError.table} (${latestError.operation})`,
            latestError.message
          );
        } else {
          // Items in retry backoff - no specific errors this cycle
          // Show pending retry info instead of clearing error details
          const retryInfo = remaining
            .map((item) => `${item.table} (${item.operationType})`)
            .slice(0, 3);
          const moreCount = remaining.length - retryInfo.length;
          const details =
            moreCount > 0 ? `${retryInfo.join(', ')} and ${moreCount} more` : retryInfo.join(', ');
          syncStatusStore.setError(
            `${remaining.length} change${remaining.length === 1 ? '' : 's'} pending retry`,
            `Affected: ${details}. Will retry automatically.`
          );
        }
      } else if (remaining.length > 0) {
        // Items exist but don't show error status yet (still early in retry cycle)
        // Show a neutral "syncing" message instead of error
        syncStatusStore.setSyncMessage('Syncing changes...');
        syncStatusStore.setError(null);
      } else {
        syncStatusStore.setSyncMessage('Everything is synced!');
        syncStatusStore.setError(null);
      }
    }

    // Notify stores that sync is complete so they can refresh from local
    notifySyncComplete();
    lastSuccessfulSyncTimestamp = Date.now();
  } catch (error) {
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
  } finally {
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
async function reconcileLocalWithRemote(): Promise<number> {
  const db = getDb();
  const config = getEngineConfig();

  const queueCount = await db.table('syncQueue').count();
  if (queueCount > 0) return 0; // Queue has items, no reconciliation needed

  const userId = await getCurrentUserId();
  if (!userId) return 0;

  const cursor = getLastSyncCursor(userId);

  let requeued = 0;

  for (const tableConfig of config.tables) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allItems: any[] = await db.table(getDexieTableFor(tableConfig)).toArray();
    for (const item of allItems) {
      if (item.updated_at && item.updated_at > cursor) {
        const { id: _id, ...payload } = item;
        await queueSyncOperation({
          table: tableConfig.supabaseName,
          entityId: item.id,
          operationType: item.deleted ? 'delete' : 'create',
          value: item.deleted ? undefined : payload,
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

// Initial hydration: if local DB is empty, pull everything from remote
async function hydrateFromRemote(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.onLine) return;

  // Atomically acquire sync lock to prevent concurrent syncs/hydrations
  const acquired = await acquireSyncLock();
  if (!acquired) return;

  const config = getEngineConfig();
  const db = config.db!;
  const supabase = config.supabase!;

  // Get user ID for sync cursor isolation
  const userId = await getCurrentUserId();

  // Abort if no authenticated user (can't hydrate without auth)
  if (!userId) {
    releaseSyncLock();
    return;
  }

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
    releaseSyncLock();
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
    const results = await Promise.all(
      config.tables.map(table =>
        supabase.from(table.supabaseName).select(table.columns).or('deleted.is.null,deleted.eq.false')
      )
    );

    // Check for errors
    for (const r of results) {
      if (r.error) throw r.error;
    }

    // Track egress for initial hydration
    for (let i = 0; i < config.tables.length; i++) {
      trackEgress(config.tables[i].supabaseName, results[i].data);
    }

    let totalRecords = 0;
    for (const r of results) {
      totalRecords += r.data?.length || 0;
    }
    debugLog(
      `[SYNC] Initial hydration: ${totalRecords} records (${formatBytes(egressStats.totalBytes)})`
    );

    // Calculate the max updated_at from all pulled data to use as sync cursor
    // This prevents missing changes that happened during hydration
    let maxUpdatedAt = '1970-01-01T00:00:00.000Z';
    for (const r of results) {
      for (const item of (r.data || []) as unknown as Record<string, unknown>[]) {
        const updatedAt = item.updated_at as string;
        if (updatedAt && updatedAt > maxUpdatedAt) {
          maxUpdatedAt = updatedAt;
        }
      }
    }

    // Store everything locally
    const entityTables = config.tables.map(t => db.table(getDexieTableFor(t)));
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
  } catch (error) {
    debugError('Hydration failed:', error);
    const friendlyMessage = parseErrorMessage(error);
    const rawMessage = extractErrorMessage(error);
    syncStatusStore.setStatus('error');
    syncStatusStore.setError(friendlyMessage, rawMessage);
    syncStatusStore.setSyncMessage(friendlyMessage);
    // Reset _hasHydrated so next read attempt can retry hydration
    _hasHydrated = false;
  } finally {
    releaseSyncLock();
  }
}

// ============================================================
// TOMBSTONE CLEANUP
// ============================================================

// Clean up old tombstones (deleted records) from local DB AND Supabase
// This prevents indefinite accumulation of soft-deleted records
const CLEANUP_INTERVAL_MS = 86400000; // 24 hours - only run server cleanup once per day
let lastServerCleanup = 0;

// Clean up old tombstones from LOCAL IndexedDB
async function cleanupLocalTombstones(): Promise<number> {
  const tombstoneMaxAgeDays = getTombstoneMaxAgeDays();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - tombstoneMaxAgeDays);
  const cutoffStr = cutoffDate.toISOString();

  const config = getEngineConfig();
  const db = config.db!;
  let totalDeleted = 0;

  try {
    const entityTables = config.tables.map(t => db.table(getDexieTableFor(t)));
    await db.transaction('rw', entityTables, async () => {
      for (const tableConfig of config.tables) {
        const table = db.table(getDexieTableFor(tableConfig));
        const count = await table
          .filter((item: Record<string, unknown>) => item.deleted === true && (item.updated_at as string) < cutoffStr)
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
  } catch (error) {
    debugError('[Tombstone] Failed to cleanup local tombstones:', error);
  }

  return totalDeleted;
}

// Clean up old tombstones from SUPABASE (runs once per day max)
async function cleanupServerTombstones(force = false): Promise<number> {
  // Only run once per day to avoid unnecessary requests (unless forced)
  const now = Date.now();
  if (!force && now - lastServerCleanup < CLEANUP_INTERVAL_MS) {
    return 0;
  }

  if (typeof navigator === 'undefined' || !navigator.onLine) return 0;

  const tombstoneMaxAgeDays = getTombstoneMaxAgeDays();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - tombstoneMaxAgeDays);
  const cutoffStr = cutoffDate.toISOString();

  const config = getEngineConfig();
  const supabase = config.supabase!;

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
      } else if (data && data.length > 0) {
        debugLog(`[Tombstone] Cleaned ${data.length} old records from server ${tableConfig.supabaseName}`);
        totalDeleted += data.length;
      }
    }

    lastServerCleanup = now;

    if (totalDeleted > 0) {
      debugLog(`[Tombstone] Server cleanup complete: ${totalDeleted} total records removed`);
    }
  } catch (error) {
    debugError('[Tombstone] Failed to cleanup server tombstones:', error);
  }

  return totalDeleted;
}

// Combined cleanup function
async function cleanupOldTombstones(): Promise<{ local: number; server: number }> {
  const local = await cleanupLocalTombstones();
  const server = await cleanupServerTombstones();
  return { local, server };
}

// Debug function to check tombstone status and manually trigger cleanup
async function debugTombstones(options?: {
  cleanup?: boolean;
  force?: boolean;
}): Promise<void> {
  const tombstoneMaxAgeDays = getTombstoneMaxAgeDays();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - tombstoneMaxAgeDays);
  const cutoffStr = cutoffDate.toISOString();

  const config = getEngineConfig();
  const db = config.db!;
  const supabase = config.supabase!;

  debugLog('=== TOMBSTONE DEBUG ===');
  debugLog(`Cutoff date (${tombstoneMaxAgeDays} days ago): ${cutoffStr}`);
  debugLog(
    `Last server cleanup: ${lastServerCleanup ? new Date(lastServerCleanup).toISOString() : 'Never'}`
  );
  debugLog('');

  // Check local tombstones
  debugLog('--- LOCAL TOMBSTONES (IndexedDB) ---');

  let totalLocalTombstones = 0;
  let totalLocalEligible = 0;

  for (const tableConfig of config.tables) {
    const table = db.table(getDexieTableFor(tableConfig));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allDeleted = await table.filter((item: any) => item.deleted === true).toArray();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eligible = allDeleted.filter((item: any) => item.updated_at < cutoffStr);

    if (allDeleted.length > 0) {
      debugLog(
        `  ${getDexieTableFor(tableConfig)}: ${allDeleted.length} tombstones (${eligible.length} eligible for cleanup)`
      );
      totalLocalTombstones += allDeleted.length;
      totalLocalEligible += eligible.length;

      // Show oldest tombstone
      if (allDeleted.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const oldest = allDeleted.reduce((a: any, b: any) => (a.updated_at < b.updated_at ? a : b));
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
      const eligible = (allDeleted || []).filter((item: any) => item.updated_at < cutoffStr);

      if (allDeleted && allDeleted.length > 0) {
        debugLog(
          `  ${tableConfig.supabaseName}: ${allDeleted.length} tombstones (${eligible.length} eligible for cleanup)`
        );
        totalServerTombstones += allDeleted.length;
        totalServerEligible += eligible.length;

        // Show oldest tombstone
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const oldest = allDeleted.reduce((a: any, b: any) => (a.updated_at < b.updated_at ? a : b));
        debugLog(`    Oldest: ${oldest.updated_at}`);
      }
    }

    debugLog(`  TOTAL: ${totalServerTombstones} tombstones (${totalServerEligible} eligible)`);
  } else {
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
  } else {
    debugLog('To run cleanup, call: debugTombstones({ cleanup: true })');
    debugLog(
      'To force server cleanup (bypass 24h limit): debugTombstones({ cleanup: true, force: true })'
    );
  }

  debugLog('========================');
}

// ============================================================
// LIFECYCLE
// ============================================================

// Store cleanup functions for realtime subscriptions
let realtimeDataUnsubscribe: (() => void) | null = null;
let realtimeConnectionUnsubscribe: (() => void) | null = null;
let authStateUnsubscribe: { data: { subscription: { unsubscribe: () => void } } } | null = null;

export async function startSyncEngine(): Promise<void> {
  if (typeof window === 'undefined') return;

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

  // Initialize debug window utilities now that config is available
  initDebugWindowUtilities();

  // Initialize network status monitoring (idempotent)
  isOnline.init();

  // Subscribe to auth state changes - critical for iOS PWA where sessions can expire
  authStateUnsubscribe = supabase.auth.onAuthStateChange(async (event, session) => {
    debugLog(`[SYNC] Auth state change: ${event}`);

    if (event === 'SIGNED_OUT') {
      // User signed out - stop realtime and show error
      debugWarn('[SYNC] User signed out - stopping sync');
      stopRealtimeSubscriptions();
      syncStatusStore.setStatus('error');
      syncStatusStore.setError('Signed out', 'Please sign in to sync your data.');
    } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
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
        runFullSync(false).catch(e => debugError('[SYNC] Auth-triggered sync failed:', e));
      }
    }

    // Delegate to app-level callback
    const config = getEngineConfig();
    if (config.onAuthStateChange) {
      config.onAuthStateChange(event, session);
    }
  });

  // Register disconnect handler: create offline session from cached credentials
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
      if (credentials.userId !== currentSession.user.id || credentials.email !== currentSession.user.email) {
        debugWarn('[Engine] Cached credentials do not match current user - skipping offline session creation');
        return;
      }

      const existingSession = await getValidOfflineSession();
      if (!existingSession) {
        await createOfflineSession(credentials.userId);
        debugLog('[Engine] Offline session created from cached credentials');
      }
    } catch (e) {
      debugError('[Engine] Failed to create offline session:', e);
    }
  });

  // Register reconnect handler: re-validate credentials with Supabase
  isOnline.onReconnect(async () => {
    debugLog('[Engine] Back online - validating credentials');
    const config = getEngineConfig();

    try {
      // Re-validate with Supabase with 15s timeout
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15000));
      const validationPromise = (async () => {
        const { data: { user }, error } = await getSupabase().auth.getUser();
        if (error || !user) return null;
        return user;
      })();

      const user = await Promise.race([validationPromise, timeoutPromise]);

      if (user) {
        markAuthValidated();
        debugLog('[Engine] Auth validated on reconnect');
        // Trigger sync after successful auth validation
        runFullSync(false).catch(e => debugError('[SYNC] Reconnect sync failed:', e));
      } else {
        debugWarn('[Engine] Auth validation failed on reconnect');
        if (config.onAuthKicked) {
          // Stop engine and clear data
          await clearPendingSyncQueue();
          config.onAuthKicked('Session expired. Please sign in again.');
        }
      }
    } catch (e) {
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

  // Handle online event - run sync and start realtime when connection restored
  handleOnlineRef = async () => {
    // EGRESS OPTIMIZATION: Skip sync if last successful sync was recent
    // iOS PWA triggers frequent network transitions - avoid redundant full syncs
    const timeSinceLastSync = Date.now() - lastSuccessfulSyncTimestamp;
    if (timeSinceLastSync < getOnlineReconnectCooldownMs()) {
      debugLog(`[SYNC] Skipping online-reconnect sync (last sync ${Math.round(timeSinceLastSync / 1000)}s ago)`);
    } else {
      runFullSync(false).catch(e => debugError('[SYNC] Online-reconnect sync failed:', e));
    }
    // Always restart realtime subscriptions regardless of cooldown
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
        // User was only away briefly, skip sync
        return;
      }

      // Skip sync if realtime is healthy (we're already up-to-date)
      if (isRealtimeHealthy()) {
        return;
      }

      // Clear any pending visibility sync
      if (visibilityDebounceTimeout) {
        clearTimeout(visibilityDebounceTimeout);
      }
      // Debounce to prevent rapid syncs when user quickly switches tabs
      visibilityDebounceTimeout = setTimeout(() => {
        visibilityDebounceTimeout = null;
        runFullSync(true).catch(e => debugError('[SYNC] Visibility sync failed:', e)); // Quiet - no error shown if it fails
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
    realtimeConnectionUnsubscribe = onConnectionStateChange(
      (connectionState: RealtimeConnectionState) => {
        // Update sync store with realtime connection state
        syncStatusStore.setRealtimeState(connectionState);

        // Note: 'error' state means max reconnect attempts exhausted
        // Polling will automatically pick up the slack (periodic sync runs when realtime unhealthy)
      }
    );

    // Start realtime subscriptions
    startRealtimeSubscriptions(userId);
  }

  // Start periodic sync (quiet mode - don't show indicator unless needed)
  // Reduced frequency when realtime is healthy
  syncInterval = setInterval(async () => {
    // Only run periodic sync if tab is visible and online
    // Skip if realtime is healthy (reduces egress significantly)
    if (navigator.onLine && isTabVisible && !isRealtimeHealthy()) {
      runFullSync(true).catch(e => debugError('[SYNC] Periodic sync failed:', e)); // Quiet background sync
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
      syncStatusStore.setError(
        `${failedResult.count} change(s) could not be synced and were discarded.`,
        `Affected: ${failedResult.tables.join(', ')}`
      );
      syncStatusStore.setSyncMessage(`${failedResult.count} change(s) failed to sync`);
    }
  }, getSyncIntervalMs());

  // One-time schema validation (only when online, only first run)
  if (navigator.onLine && !_schemaValidated) {
    _schemaValidated = true;
    validateSchema().then(result => {
      if (!result.valid) {
        const msg = `Missing or inaccessible Supabase tables: ${result.missingTables.length > 0 ? result.missingTables.join(', ') : 'see errors'}`;
        debugError('[SYNC]', msg);
        for (const err of result.errors) {
          debugError('[SYNC]', err);
        }
        syncStatusStore.setStatus('error');
        syncStatusStore.setError(msg, 'Create the required tables in your Supabase project. See stellar-engine README for the required SQL schema.');
      }
    }).catch(() => {});
  }

  // Initial sync: hydrate if empty, otherwise push pending
  if (navigator.onLine) {
    hydrateFromRemote().catch(e => debugError('[SYNC] Initial hydration failed:', e));
  }

  // Run initial cleanup
  cleanupOldTombstones();
  cleanupConflictHistory();
  cleanupRealtimeTracking();
  cleanupFailedItems().then((failedResult) => {
    if (failedResult.count > 0) {
      syncStatusStore.setStatus('error');
      syncStatusStore.setError(
        `${failedResult.count} change(s) could not be synced and were discarded.`,
        `Affected: ${failedResult.tables.join(', ')}`
      );
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
        runFullSync(true).catch(e => debugError('[SYNC] Watchdog retry sync failed:', e));
      }
    }
  }, WATCHDOG_INTERVAL_MS);

  // Expose debug utilities to window for console access
  if (typeof window !== 'undefined' && isDebugMode()) {
    const prefix = getPrefix();
    const supabase = getSupabase();

    (window as unknown as Record<string, unknown>)[`__${prefix}Tombstones`] = debugTombstones;

    // Sync debug tools: window.__<prefix>Sync.forceFullSync(), .resetSyncCursor(), etc.
    (window as unknown as Record<string, unknown>)[`__${prefix}Sync`] = {
      forceFullSync,
      resetSyncCursor,
      sync: () => runFullSync(false),
      getStatus: () => ({
        cursor:
          typeof localStorage !== 'undefined'
            ? localStorage.getItem('lastSyncCursor') ||
              Object.entries(localStorage)
                .filter(([k]) => k.startsWith('lastSyncCursor_'))
                .map(([k, v]) => ({ [k]: v }))[0]
            : 'N/A',
        pendingOps: getPendingSync().then((ops) => ops.length)
      }),
      checkConnection: async () => {
        try {
          const config = getEngineConfig();
          const firstTable = config.tables[0]?.supabaseName;
          if (!firstTable) return { connected: false, error: 'No tables configured' };
          const { data, error } = await supabase.from(firstTable).select('id').limit(1);
          if (error) return { connected: false, error: error.message };
          return { connected: true, records: data?.length || 0 };
        } catch (e) {
          return { connected: false, error: String(e) };
        }
      },
      realtimeStatus: () => ({
        state: getConnectionState(),
        healthy: isRealtimeHealthy()
      })
    };

    debugLog(`[SYNC] Debug utilities available at window.__${prefix}Sync`);
  }
}

export async function stopSyncEngine(): Promise<void> {
  if (typeof window === 'undefined') return;

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
}

// Clear local cache (for logout)
export async function clearLocalCache(): Promise<void> {
  const config = getEngineConfig();
  const db = config.db!;

  // Get user ID before clearing to remove their sync cursor
  const userId = await getCurrentUserId();

  const entityTables = config.tables.map(t => db.table(getDexieTableFor(t)));
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


