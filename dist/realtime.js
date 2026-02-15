/**
 * @fileoverview Real-Time Subscription Manager -- Supabase Realtime WebSocket Layer
 *
 * Phase 5 of multi-device sync: Implements Supabase Realtime subscriptions
 * for instant multi-device synchronization.
 *
 * ## Architecture
 *
 * This module manages a single Supabase Realtime channel per authenticated user,
 * listening for PostgreSQL changes (INSERT, UPDATE, DELETE) across all configured
 * entity tables. When a change arrives from another device, it is applied to the
 * local Dexie (IndexedDB) store and subscribers are notified so the UI can react.
 *
 * ```
 *   Supabase Postgres  --(CDC)--> Supabase Realtime Server
 *                                        |
 *                                   WebSocket
 *                                        |
 *                                   This module
 *                                        |
 *                          +-------------+-------------+
 *                          |                           |
 *                   Local Dexie DB             UI Notification
 *                  (conflict-resolved)       (animation / refresh)
 * ```
 *
 * ## Echo Suppression
 *
 * Every write to Supabase includes a `device_id` field. When a realtime event
 * arrives, we compare its `device_id` against our own. If they match, the event
 * originated from this device and is silently discarded. This prevents the
 * "echo" problem where a device processes its own outgoing changes a second time.
 *
 * ## Deduplication with Polling
 *
 * The sync engine also runs periodic polling as a fallback. To prevent the same
 * remote change from being applied twice (once via realtime, once via poll), this
 * module maintains a short-lived `recentlyProcessedByRealtime` map. The polling
 * path in `engine.ts` checks this map before processing a change.
 *
 * ## Reconnection Strategy
 *
 * On WebSocket disconnection the module uses exponential backoff (1s, 2s, 4s, ...)
 * up to {@link MAX_RECONNECT_ATTEMPTS} (5) attempts. If the browser is offline,
 * reconnection is paused entirely -- no timers fire until a `navigator.onLine`
 * event restores connectivity. A `reconnectScheduled` flag prevents duplicate
 * reconnection timers from stacking up when multiple channel events fire in
 * quick succession.
 *
 * ## Soft Deletes and Animations
 *
 * When a soft delete is detected (UPDATE with `deleted=true`), the module
 * records the deletion in {@link remoteChangesStore} *before* writing to Dexie.
 * This ordering is intentional: it allows the UI layer to play a removal
 * animation before the reactive store filters out the deleted record.
 *
 * ## Security Considerations
 *
 * - **Row-Level Security (RLS):** No client-side user ID filter is applied to
 *   the channel subscription. All access control is enforced by Supabase RLS
 *   policies at the database level. This is a deliberate security decision:
 *   client-side filters can be bypassed, whereas RLS operates inside Postgres
 *   and cannot be circumvented by a malicious client.
 * - **Device ID trust boundary:** The `device_id` field is used only for echo
 *   suppression and conflict tiebreaking, **not** for authorization. A spoofed
 *   `device_id` could cause an event to be incorrectly suppressed on another
 *   device, but it cannot escalate privileges or access unauthorized data.
 * - **Channel naming:** The channel name includes the user ID to ensure
 *   Supabase routes CDC events correctly. This is a routing hint, not a
 *   security boundary -- RLS is the actual enforcement mechanism.
 *
 * @see {@link ./engine.ts} for the orchestrating sync engine and polling loop
 * @see {@link ./conflicts.ts} for the conflict resolution algorithm
 * @see {@link ./queue.ts} for the pending operations queue
 * @see {@link ./stores/remoteChanges.ts} for UI change-tracking and animations
 * @see {@link ./deviceId.ts} for per-device identity generation
 */
import { debugLog, debugWarn, debugError, isDebugMode } from './debug';
import { getEngineConfig, getDexieTableFor } from './config';
import { getDeviceId } from './deviceId';
import { resolveConflicts, storeConflictHistory, getPendingOpsForEntity } from './conflicts';
import { getPendingEntityIds } from './queue';
import { remoteChangesStore } from './stores/remoteChanges';
// =============================================================================
// CONSTANTS
// =============================================================================
/**
 * How long (in ms) a processed entity is considered "recent."
 * Must match the TTL used in engine.ts for `recentlyModifiedEntities`
 * so that the deduplication windows overlap correctly.
 *
 * **Why 2 seconds?** This window must be long enough to span the typical
 * latency gap between a realtime WebSocket push and the next polling cycle.
 * If the poll fires within 2s of the realtime event, the entity will still
 * be in the dedup map and the poll result will be skipped.
 *
 * @see {@link ./engine.ts} -- `RECENTLY_MODIFIED_TTL_MS`
 */
const RECENTLY_MODIFIED_TTL_MS = 2000;
/**
 * Maximum number of reconnection attempts before the module gives up
 * and falls back to polling-only mode.
 *
 * **Why 5?** With exponential backoff (1s, 2s, 4s, 8s, 16s) the total
 * wait before giving up is ~31 seconds, which covers most transient
 * network hiccups without annoying the user with prolonged retry noise.
 */
const MAX_RECONNECT_ATTEMPTS = 5;
/**
 * Base delay for exponential backoff between reconnection attempts.
 * Actual delay = RECONNECT_BASE_DELAY * 2^(attemptIndex).
 */
const RECONNECT_BASE_DELAY = 1000;
// =============================================================================
// MODULE-LEVEL STATE
// =============================================================================
/**
 * Tracks entities that realtime has recently processed, keyed by entity ID
 * with the timestamp of processing as the value.
 *
 * This is intentionally separate from `engine.ts`'s `recentlyModifiedEntities`
 * (which tracks *local* writes). This map tracks *remote* changes received via
 * WebSocket so that the polling path can skip them.
 *
 * **Memory note:** Entries are lazily evicted on read (see {@link wasRecentlyProcessed})
 * and actively cleaned by {@link cleanupRealtimeTracking}. In the worst case the map
 * holds one entry per entity modified within the last {@link RECENTLY_MODIFIED_TTL_MS}.
 */
const recentlyProcessedByRealtime = new Map();
/**
 * Singleton state instance. Initialized to a clean "disconnected" baseline.
 *
 * **Why a singleton?** A browser tab should never have more than one WebSocket
 * connection to Supabase Realtime for the same user. Multiple connections would
 * cause duplicate event processing and wasted bandwidth. The singleton pattern
 * enforces this at the module level.
 */
const state = {
    channel: null,
    connectionState: 'disconnected',
    userId: null,
    deviceId: '',
    lastError: null,
    reconnectAttempts: 0,
    reconnectTimeout: null
};
// =============================================================================
// CALLBACK REGISTRIES
// =============================================================================
/**
 * Registered listeners that fire whenever the connection state transitions.
 * Each callback receives the new {@link RealtimeConnectionState}.
 *
 * **Why a Set?** Using a `Set` ensures the same callback reference cannot be
 * registered twice, which prevents duplicate notifications if consumer code
 * accidentally calls `onConnectionStateChange` more than once with the same fn.
 */
const connectionCallbacks = new Set();
/**
 * Registered listeners that fire after a remote change has been applied to the
 * local Dexie database. Consumers (e.g. Svelte stores) use this to trigger
 * reactive re-queries.
 *
 * **Ordering guarantee:** Callbacks are invoked *after* the Dexie write has
 * completed, so any re-query inside the callback will return the updated data.
 */
const dataUpdateCallbacks = new Set();
// =============================================================================
// CONCURRENCY GUARDS
// =============================================================================
/**
 * Mutex-like flag preventing concurrent `start` / `stop` operations.
 * Because channel setup and teardown are async, overlapping calls could leave
 * the module in an inconsistent state without this guard.
 *
 * **Not a true mutex:** This is a cooperative lock -- it relies on callers
 * checking the flag and bailing out. Since JavaScript is single-threaded,
 * there is no race between the check and the set, making this safe.
 */
let operationInProgress = false;
/**
 * Prevents duplicate reconnection timers from being scheduled.
 * Supabase may emit both `CHANNEL_ERROR` and `CLOSED` events for the same
 * disconnection; without this flag each event would schedule its own timer.
 *
 * **Reset points:** This flag is cleared in three places:
 * 1. Inside the setTimeout callback (normal reconnect flow)
 * 2. In {@link stopRealtimeSubscriptionsInternal} (teardown)
 * 3. In {@link pauseRealtime} (offline transition)
 */
let reconnectScheduled = false;
// =============================================================================
// PUBLIC API -- SUBSCRIPTION HOOKS
// =============================================================================
/**
 * Subscribe to connection state changes.
 *
 * The callback is invoked immediately with the current state upon registration,
 * then again on every subsequent transition.
 *
 * @param callback - Function invoked with the new {@link RealtimeConnectionState}.
 * @returns An unsubscribe function. Call it to remove the listener.
 *
 * @example
 * ```ts
 * const unsub = onConnectionStateChange((state) => {
 *   if (state === 'error') showReconnectBanner();
 * });
 * // Later, to stop listening:
 * unsub();
 * ```
 */
export function onConnectionStateChange(callback) {
    connectionCallbacks.add(callback);
    /* Deliver the current state immediately so the subscriber doesn't have to
       wait for the next transition to learn the baseline. This pattern is common
       in observable/store implementations (e.g., Svelte stores call subscribers
       on subscription). */
    callback(state.connectionState);
    return () => connectionCallbacks.delete(callback);
}
/**
 * Subscribe to data update notifications.
 *
 * Callbacks fire *after* the remote change has been written to the local Dexie
 * database, so re-querying inside the callback will return fresh data.
 *
 * @param callback - Function invoked with the Supabase table name and entity ID.
 * @returns An unsubscribe function. Call it to remove the listener.
 *
 * @example
 * ```ts
 * const unsub = onRealtimeDataUpdate((table, entityId) => {
 *   if (table === 'habits') refreshHabitStore();
 * });
 * ```
 *
 * @see {@link notifyDataUpdate} for the internal dispatch function
 */
export function onRealtimeDataUpdate(callback) {
    dataUpdateCallbacks.add(callback);
    return () => dataUpdateCallbacks.delete(callback);
}
// =============================================================================
// PUBLIC API -- STATE QUERIES
// =============================================================================
/**
 * Check whether an entity was recently processed via a realtime event.
 *
 * Called by `engine.ts` during polling to avoid applying the same remote
 * change twice (once from realtime, once from the poll response).
 *
 * **Side effect:** Expired entries are lazily evicted on access. This keeps
 * the map from growing during bursts of activity, complementing the
 * periodic cleanup in {@link cleanupRealtimeTracking}.
 *
 * @param entityId - The UUID of the entity to check.
 * @returns `true` if the entity was processed within the last {@link RECENTLY_MODIFIED_TTL_MS} ms.
 *
 * @example
 * ```ts
 * if (wasRecentlyProcessedByRealtime(entity.id)) {
 *   // Skip -- realtime already handled this change
 *   continue;
 * }
 * ```
 *
 * @see {@link ./engine.ts} -- polling path
 */
export function wasRecentlyProcessedByRealtime(entityId) {
    const processedAt = recentlyProcessedByRealtime.get(entityId);
    if (!processedAt)
        return false;
    const age = Date.now() - processedAt;
    if (age > RECENTLY_MODIFIED_TTL_MS) {
        recentlyProcessedByRealtime.delete(entityId);
        return false;
    }
    return true;
}
/**
 * Check if the realtime connection is healthy (connected and not in an error state).
 *
 * @returns `true` when the WebSocket channel is in the `'connected'` state.
 */
export function isRealtimeHealthy() {
    return state.connectionState === 'connected';
}
/**
 * Return a snapshot of realtime-internal state for diagnostics.
 *
 * This function is prefixed with `_` to signal that it exposes module-private
 * state and should only be consumed by the diagnostics module.
 *
 * @returns A plain object containing current realtime state values
 */
export function _getRealtimeDiagnostics() {
    return {
        connectionState: state.connectionState,
        healthy: state.connectionState === 'connected',
        reconnectAttempts: state.reconnectAttempts,
        lastError: state.lastError,
        userId: state.userId,
        deviceId: state.deviceId,
        recentlyProcessedCount: recentlyProcessedByRealtime.size,
        operationInProgress,
        reconnectScheduled
    };
}
/**
 * Remove expired entries from the recently-processed tracking map.
 *
 * Called periodically by the sync engine's maintenance loop to prevent
 * unbounded memory growth in long-running sessions.
 *
 * **Why explicit cleanup?** Lazy eviction in {@link wasRecentlyProcessedByRealtime}
 * only fires when an entity is looked up. If an entity is processed by realtime
 * but never polled (e.g., a table not included in the current poll cycle),
 * its entry would persist indefinitely without this active sweep.
 *
 * @see {@link RECENTLY_MODIFIED_TTL_MS}
 */
export function cleanupRealtimeTracking() {
    const now = Date.now();
    for (const [entityId, processedAt] of recentlyProcessedByRealtime) {
        if (now - processedAt > RECENTLY_MODIFIED_TTL_MS) {
            recentlyProcessedByRealtime.delete(entityId);
        }
    }
}
// =============================================================================
// INTERNAL HELPERS -- STATE NOTIFICATIONS
// =============================================================================
/**
 * Transition the connection state and notify all registered listeners.
 *
 * Errors thrown by individual callbacks are caught and logged so that one
 * misbehaving listener cannot break the notification chain.
 *
 * @param newState - The {@link RealtimeConnectionState} to transition to.
 * @param error    - Optional human-readable error message stored in {@link state.lastError}.
 */
function setConnectionState(newState, error) {
    state.connectionState = newState;
    state.lastError = error || null;
    for (const callback of connectionCallbacks) {
        try {
            callback(newState);
        }
        catch (e) {
            /* Catch-and-continue: a broken subscriber must not prevent other
               subscribers from being notified, nor should it crash the realtime
               lifecycle management. */
            debugError('[Realtime] Connection callback error:', e);
        }
    }
}
/**
 * Dispatch a data-update event to all registered subscribers.
 *
 * Called after a remote change has been written to Dexie. Errors thrown by
 * individual callbacks are caught and logged.
 *
 * @param table    - The Supabase table name where the change originated (e.g. `'habits'`).
 * @param entityId - The UUID of the changed entity.
 *
 * @see {@link onRealtimeDataUpdate} for the public subscription API
 */
function notifyDataUpdate(table, entityId) {
    debugLog(`[Realtime] Notifying ${dataUpdateCallbacks.size} subscribers of update: ${table}/${entityId}`);
    for (const callback of dataUpdateCallbacks) {
        try {
            callback(table, entityId);
        }
        catch (e) {
            debugError('[Realtime] Data update callback error:', e);
        }
    }
}
// =============================================================================
// INTERNAL HELPERS -- ECHO & DEDUP FILTERS
// =============================================================================
/**
 * Determine whether a change event originated from this device.
 *
 * Supabase Realtime delivers *all* changes matching the channel filter,
 * including changes made by the current device. We compare the `device_id`
 * field in the payload against our own to suppress these "echoes."
 *
 * **Security note:** The `device_id` comparison is used purely for performance
 * optimization (avoiding redundant local writes). It is **not** a security
 * mechanism. A spoofed `device_id` could only cause an event to be skipped
 * on the spoofing device -- it cannot grant access to other users' data
 * because RLS enforces row-level access at the database level.
 *
 * @param record - The `new` record from the realtime payload, or `null`.
 * @returns `true` if the record's `device_id` matches this device.
 *
 * @see {@link ./deviceId.ts} -- where the device identity is generated
 */
function isOwnDeviceChange(record) {
    if (!record)
        return false;
    const recordDeviceId = record.device_id;
    return recordDeviceId === state.deviceId;
}
/**
 * Check if an entity was recently processed by this realtime handler.
 *
 * This is the *internal* counterpart of the exported
 * {@link wasRecentlyProcessedByRealtime}. It is called inside
 * {@link handleRealtimeChange} to short-circuit duplicate events that may
 * arrive in rapid succession (e.g. due to Supabase retries).
 *
 * **Why a separate function?** The internal version is used in the hot path
 * of change processing, while the exported version is used by the polling
 * engine. Keeping them separate makes it clear which is the internal guard
 * and which is the cross-module dedup check.
 *
 * @param entityId - The UUID of the entity to check.
 * @returns `true` if the entity is within the deduplication window.
 */
function wasRecentlyProcessed(entityId) {
    const processedAt = recentlyProcessedByRealtime.get(entityId);
    if (!processedAt)
        return false;
    const age = Date.now() - processedAt;
    if (age > RECENTLY_MODIFIED_TTL_MS) {
        recentlyProcessedByRealtime.delete(entityId);
        return false;
    }
    return true;
}
// =============================================================================
// CORE CHANGE HANDLER
// =============================================================================
/**
 * Process an incoming realtime change event from Supabase.
 *
 * This is the central routing function for all realtime events. It:
 * 1. Extracts the entity ID and event type from the payload.
 * 2. Applies echo suppression and deduplication filters.
 * 3. Looks up the matching Dexie table via the engine config.
 * 4. Delegates to the appropriate branch: INSERT/UPDATE or DELETE.
 * 5. Records the change in {@link remoteChangesStore} for UI animations.
 * 6. Marks the entity as recently processed to prevent polling duplication.
 * 7. Notifies data-update subscribers.
 *
 * For INSERT/UPDATE events with pending local operations, the function
 * delegates to {@link resolveConflicts} to produce a merged entity.
 *
 * **Error handling:** All errors are caught at the top level and logged.
 * A failure to process one event must not crash the WebSocket listener or
 * prevent subsequent events from being handled.
 *
 * **Ordering contract with remoteChangesStore:**
 * For delete operations (both soft and hard), the change is recorded in
 * remoteChangesStore **before** writing to Dexie. This ordering is critical
 * for exit animations -- see the soft delete and hard delete sections below.
 *
 * @param table   - The Supabase table name (e.g. `'habits'`, `'entries'`).
 * @param payload - The raw Supabase realtime change payload.
 *
 * @throws Never throws -- all errors are caught internally and logged.
 *
 * @see {@link resolveConflicts} for the conflict resolution algorithm
 * @see {@link remoteChangesStore} for how the UI animates remote changes
 */
async function handleRealtimeChange(table, payload) {
    const eventType = payload.eventType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newRecord = payload.new;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldRecord = payload.old;
    /* For DELETEs, Supabase only populates `old`; for INSERTs only `new`.
       UPDATEs populate both. We need the ID from whichever is available. */
    const entityId = (newRecord?.id || oldRecord?.id);
    debugLog(`[Realtime] Received ${eventType} on ${table}:`, entityId);
    if (!entityId) {
        debugWarn('[Realtime] Change without entity ID:', table, eventType);
        return;
    }
    /* ---- Echo suppression ----
       Skip events that originated from this device. Without this check, every
       local write would be processed a second time when the CDC event arrives
       back through the WebSocket, causing redundant Dexie writes and UI flicker. */
    if (isOwnDeviceChange(newRecord)) {
        debugLog(`[Realtime] Skipping own device change: ${table}/${entityId}`);
        return;
    }
    /* ---- Deduplication ----
       Skip events for entities we already processed very recently. This guards
       against Supabase delivering the same CDC event multiple times (which can
       happen during server-side reconnection or rebalancing). */
    if (wasRecentlyProcessed(entityId)) {
        debugLog(`[Realtime] Skipping recently processed: ${table}/${entityId}`);
        return;
    }
    debugLog(`[Realtime] Processing remote change: ${eventType} ${table}/${entityId}`);
    const tableConfig = getEngineConfig().tables.find((t) => t.supabaseName === table);
    const dexieTable = tableConfig ? getDexieTableFor(tableConfig) : undefined;
    if (!dexieTable) {
        debugWarn('[Realtime] Unknown table:', table);
        return;
    }
    try {
        switch (eventType) {
            // -----------------------------------------------------------------------
            // INSERT / UPDATE -- the bulk of the logic lives here
            // -----------------------------------------------------------------------
            case 'INSERT':
            case 'UPDATE': {
                if (!newRecord)
                    return;
                /* Check if entity is being edited in a manual-save form. When true,
                   remoteChangesStore will defer the incoming change until the form is
                   closed, preventing jarring mid-edit overwrites. This is a UX decision:
                   we prioritize the active editing experience over instant sync. */
                const _isBeingEdited = remoteChangesStore.isEditing(entityId, table);
                /* Fetch the local version so we can diff fields and detect conflicts. */
                const localEntity = await getEngineConfig().db.table(dexieTable).get(entityId);
                /* Build a list of fields whose values actually differ between local
                   and remote. We skip metadata fields (updated_at, _version) because
                   they always change and would produce noisy animations. These fields
                   are managed by the sync engine, not the user, so highlighting them
                   would be misleading. */
                const changedFields = [];
                if (localEntity && newRecord) {
                    for (const key of Object.keys(newRecord)) {
                        if (key === 'updated_at' || key === '_version')
                            continue;
                        /* JSON.stringify comparison handles nested objects/arrays correctly.
                           For primitives it is equivalent to ===, with the caveat that
                           undefined fields are omitted (which is the desired behavior). */
                        if (JSON.stringify(localEntity[key]) !== JSON.stringify(newRecord[key])) {
                            changedFields.push(key);
                        }
                    }
                }
                /* ---- Soft delete detection ----
                   A soft delete manifests as an UPDATE where `deleted` transitions from
                   false to true. We handle this specially: the UI animation (fade-out)
                   must play BEFORE the record is written to Dexie, because reactive
                   stores will immediately filter out deleted records, removing the DOM
                   element and preventing any exit animation.
        
                   **Why not use CSS `animation-fill-mode: forwards`?** Because the DOM
                   element is removed entirely by the reactive framework (Svelte's
                   {#each} block), not just hidden. Once the Dexie write triggers a
                   store update, the element is gone from the DOM. */
                const isSoftDelete = newRecord.deleted === true && localEntity && !localEntity.deleted;
                if (isSoftDelete) {
                    debugLog(`[Realtime] Soft delete detected for ${table}/${entityId}`);
                    /* Record + await the delete animation before touching the DB.
                       The wildcard ['*'] signals the UI that the entire row is affected. */
                    remoteChangesStore.recordRemoteChange(entityId, table, ['*'], true, 'DELETE');
                    await remoteChangesStore.markPendingDelete(entityId, table);
                    /* Now persist the soft-deleted record; reactive stores refresh. */
                    await getEngineConfig().db.table(dexieTable).put(newRecord);
                    recentlyProcessedByRealtime.set(entityId, Date.now());
                    notifyDataUpdate(table, entityId);
                    break;
                }
                /* ---- Conflict resolution path ----
                   Three branches depending on local state:
                   1. No local entity  -> simple insert (no conflict possible)
                   2. No pending ops   -> accept remote if newer (last-write-wins)
                   3. Pending ops exist -> full conflict resolution via resolveConflicts
        
                   **Why check pending ops?** If the user has unsynced local changes,
                   blindly accepting the remote version would silently discard the
                   user's work. The conflict resolver preserves local pending changes
                   while incorporating non-conflicting remote updates. */
                const pendingEntityIds = await getPendingEntityIds();
                const hasPendingOps = pendingEntityIds.has(entityId);
                let applied = false;
                if (!localEntity) {
                    /* Branch 1: Entity doesn't exist locally -- just insert.
                       This happens when another device creates a new entity. */
                    await getEngineConfig().db.table(dexieTable).put(newRecord);
                    applied = true;
                }
                else if (!hasPendingOps) {
                    /* Branch 2: No unsynced local changes -- simple timestamp comparison.
                       Only overwrite if the remote timestamp is strictly newer. If the
                       local version is newer (possible if a local write just happened
                       but hasn't been pushed yet), we keep the local version to avoid
                       regressing the UI. */
                    const localUpdatedAt = new Date(localEntity.updated_at).getTime();
                    const remoteUpdatedAt = new Date(newRecord.updated_at).getTime();
                    if (remoteUpdatedAt > localUpdatedAt) {
                        await getEngineConfig().db.table(dexieTable).put(newRecord);
                        applied = true;
                    }
                }
                else {
                    /* Branch 3: Pending local operations exist -- we must merge.
                       The conflict resolver produces a merged entity that preserves
                       non-conflicting local edits while incorporating the remote state.
                       See conflicts.ts for the three-tier resolution algorithm. */
                    const pendingOps = await getPendingOpsForEntity(entityId);
                    const resolution = await resolveConflicts(table, entityId, localEntity, newRecord, pendingOps);
                    await getEngineConfig().db.table(dexieTable).put(resolution.mergedEntity);
                    applied = true;
                    /* Persist conflict history for auditability and potential undo.
                       Only stored when actual field-level conflicts were detected
                       (not for clean auto-merges). */
                    if (resolution.hasConflicts) {
                        await storeConflictHistory(resolution);
                    }
                }
                /* ---- Value delta for counter animations ----
                   If the `current_value` field changed, compute the delta so the UI
                   can show an increment/decrement animation (e.g. "+1" / "-3").
                   This is specific to counter-style entities (e.g., habit streaks,
                   goal progress). */
                let valueDelta;
                if (changedFields.includes('current_value') && localEntity && newRecord) {
                    const oldValue = localEntity.current_value || 0;
                    const newValue = newRecord.current_value || 0;
                    valueDelta = newValue - oldValue;
                }
                /* ---- UI change notification ----
                   Record the change in remoteChangesStore so the UI can highlight
                   the affected row / field. If the entity is currently being edited
                   in a form, the store defers the notification until editing ends.
        
                   We only notify when there are actual visible changes (changedFields > 0)
                   or when the entity is entirely new (!localEntity). This prevents
                   spurious highlight animations for metadata-only updates. */
                if (changedFields.length > 0 || !localEntity) {
                    remoteChangesStore.recordRemoteChange(entityId, table, changedFields.length > 0 ? changedFields : ['*'], applied, eventType, valueDelta);
                    /* Fire the optional per-table hook so consumers can run custom
                       side-effects (e.g. toast notifications, badge updates). */
                    const tblConfig = getEngineConfig().tables.find((t) => t.supabaseName === table);
                    if (tblConfig?.onRemoteChange) {
                        tblConfig.onRemoteChange(table, newRecord);
                    }
                }
                /* Mark as recently processed so the polling path skips this entity.
                   This is the bridge between realtime and polling deduplication. */
                recentlyProcessedByRealtime.set(entityId, Date.now());
                notifyDataUpdate(table, entityId);
                break;
            }
            // -----------------------------------------------------------------------
            // DELETE -- hard-delete path (rare in soft-delete systems)
            // -----------------------------------------------------------------------
            case 'DELETE': {
                /* In a soft-delete system most deletions arrive as UPDATEs with
                   `deleted=true` (handled above). A hard DELETE is uncommon but must
                   still be handled for correctness -- it can occur when:
                   - An admin purges records directly in the database
                   - A scheduled cleanup job removes old soft-deleted rows
                   - The application uses hard deletes for certain entity types */
                if (oldRecord) {
                    /* Record delete animation BEFORE removing from DB, same ordering
                       rationale as the soft-delete path above: the reactive framework
                       will remove the DOM element immediately on Dexie deletion, so
                       the animation must be set up first. */
                    remoteChangesStore.recordRemoteChange(entityId, table, ['*'], true, 'DELETE');
                    /* Wait for the pending-delete animation to complete so the UI has
                       time to play an exit transition before the DOM element disappears. */
                    await remoteChangesStore.markPendingDelete(entityId, table);
                    /* Now remove the record from Dexie (triggers reactive DOM removal). */
                    await getEngineConfig().db.table(dexieTable).delete(entityId);
                    recentlyProcessedByRealtime.set(entityId, Date.now());
                    notifyDataUpdate(table, entityId);
                }
                break;
            }
        }
    }
    catch (error) {
        /* Top-level catch ensures one bad event never crashes the WebSocket
           listener. The channel continues processing subsequent events. */
        debugError(`[Realtime] Error handling ${eventType} on ${table}:`, error);
    }
}
// =============================================================================
// RECONNECTION LOGIC
// =============================================================================
/**
 * Schedule a reconnection attempt using exponential backoff.
 *
 * Behavior:
 * - If the browser is offline (`navigator.onLine === false`), reconnection is
 *   skipped entirely. The sync engine's `online` event handler will re-trigger
 *   subscription start when connectivity returns.
 * - If the maximum number of attempts has been reached, the module gives up and
 *   transitions to `'error'` state; the polling fallback remains active.
 * - A `reconnectScheduled` flag prevents duplicate timers from being created
 *   when multiple channel events (e.g. CHANNEL_ERROR + CLOSED) fire in quick
 *   succession for the same disconnection.
 *
 * **Backoff schedule:** 1s, 2s, 4s, 8s, 16s (geometric progression).
 * Total wait across all 5 attempts: ~31 seconds.
 *
 * @see {@link MAX_RECONNECT_ATTEMPTS}
 * @see {@link RECONNECT_BASE_DELAY}
 * @see {@link startRealtimeSubscriptions} -- called by the timer callback
 */
function scheduleReconnect() {
    /* Guard: prevent duplicate scheduling from multiple event callbacks.
       Supabase can emit CHANNEL_ERROR followed closely by CLOSED for the same
       disconnection event; both would call this function without this guard. */
    if (reconnectScheduled) {
        debugLog('[Realtime] Reconnect skipped: timer already scheduled (duplicate guard)');
        return;
    }
    if (state.reconnectTimeout) {
        clearTimeout(state.reconnectTimeout);
        state.reconnectTimeout = null;
    }
    /* No point burning reconnect attempts while the network is down.
       The sync engine listens for the browser's `online` event and will call
       startRealtimeSubscriptions() when connectivity returns. */
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        debugLog('[Realtime] Offline - waiting for online event to reconnect');
        setConnectionState('disconnected');
        return;
    }
    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        debugLog('[Realtime] Max reconnect attempts reached, falling back to polling');
        setConnectionState('error', 'Max reconnection attempts reached');
        return;
    }
    reconnectScheduled = true;
    /* Exponential backoff: 1s, 2s, 4s, 8s, 16s */
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, state.reconnectAttempts);
    debugLog(`[Realtime] Scheduling reconnect attempt ${state.reconnectAttempts + 1} in ${delay}ms`);
    state.reconnectTimeout = setTimeout(async () => {
        reconnectScheduled = false;
        /* Re-check online status in case we went offline during the backoff wait.
           This avoids wasting a reconnect attempt on a network that's now down. */
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
            debugLog('[Realtime] Went offline during backoff, cancelling reconnect');
            return;
        }
        state.reconnectAttempts++;
        if (state.userId) {
            await startRealtimeSubscriptions(state.userId);
        }
    }, delay);
}
// =============================================================================
// LIFECYCLE -- START / STOP / PAUSE
// =============================================================================
/**
 * Internal teardown: remove the channel and reset connection state.
 *
 * Does **not** acquire the `operationInProgress` lock -- callers are
 * responsible for holding it. This allows {@link startRealtimeSubscriptions}
 * to call it mid-operation without deadlocking.
 *
 * **Why separate from the public `stopRealtimeSubscriptions`?** The public
 * version acquires the concurrency lock and clears session-level state (userId,
 * tracking map). This internal version only handles the channel teardown,
 * making it safe to call from within `startRealtimeSubscriptions` which
 * already holds the lock.
 *
 * @see {@link stopRealtimeSubscriptions} -- the public API that wraps this
 */
async function stopRealtimeSubscriptionsInternal() {
    /* Clear any pending reconnect timer and reset the scheduling flag.
       If we don't clear these, a pending timer could fire after the channel
       is torn down and attempt to reconnect with stale state. */
    if (state.reconnectTimeout) {
        clearTimeout(state.reconnectTimeout);
        state.reconnectTimeout = null;
    }
    reconnectScheduled = false;
    /* Unsubscribe from the Supabase channel. This sends an unsubscribe
       message over the WebSocket and cleans up the local channel state. */
    if (state.channel) {
        try {
            await getEngineConfig().supabase.removeChannel(state.channel);
        }
        catch (error) {
            /* Log but don't rethrow -- we're tearing down and must continue
               cleanup even if the server-side unsubscribe fails (e.g., the
               WebSocket is already dead). */
            debugError('[Realtime] Error removing channel:', error);
        }
        state.channel = null;
    }
    state.reconnectAttempts = 0;
    setConnectionState('disconnected');
}
/**
 * Start realtime subscriptions for an authenticated user.
 *
 * Creates a single Supabase Realtime channel and registers PostgreSQL change
 * listeners for every table defined in the engine config.
 *
 * **Security:** Access control is enforced by Supabase RLS policies at the
 * database level -- no client-side `user_id` filter is applied to the channel
 * subscription. The Realtime server evaluates RLS policies for each CDC event
 * and only delivers events the user is authorized to see.
 *
 * This function is idempotent: if the channel is already connected for the
 * same user, it returns immediately. If a different user is provided, the
 * existing channel is torn down first.
 *
 * **Channel multiplexing:** One channel is created for all tables rather than
 * one per table. This is more efficient because Supabase multiplexes all
 * subscriptions over a single WebSocket connection regardless, so separate
 * channels would only add overhead without improving parallelism.
 *
 * @param userId - The authenticated user's UUID. Used to construct a unique
 *                 channel name (`{prefix}_sync_{userId}`).
 *
 * @throws Never throws -- all errors are caught internally. On failure, the
 *         connection state transitions to `'error'` and reconnection is
 *         scheduled automatically.
 *
 * @example
 * ```ts
 * // After login:
 * await startRealtimeSubscriptions(session.user.id);
 * ```
 *
 * @see {@link stopRealtimeSubscriptions} to cleanly tear down the channel
 * @see {@link getEngineConfig} for the table configuration consumed here
 */
export async function startRealtimeSubscriptions(userId) {
    /* SSR guard: realtime requires a browser environment for WebSocket.
       In SSR contexts (e.g., SvelteKit server-side rendering), `window` is
       undefined and we must bail early to avoid runtime errors. */
    if (typeof window === 'undefined')
        return;
    /* Don't attempt connection while offline; the sync engine's `online` event
       will call us again when connectivity is restored. Attempting to connect
       while offline would waste a reconnect attempt on an inevitable failure. */
    if (!navigator.onLine) {
        debugLog('[Realtime] Offline - skipping subscription start');
        return;
    }
    /* Idempotency: skip if already connected for this user. This prevents
       unnecessary channel teardown/recreation when the caller doesn't track
       whether we're already connected. */
    if (state.channel && state.userId === userId && state.connectionState === 'connected') {
        return;
    }
    /* Concurrency guard: prevent overlapping start/stop sequences. Without
       this, rapid login/logout cycles could interleave async channel operations
       and leave the module in an inconsistent state. */
    if (operationInProgress) {
        debugLog('[Realtime] Start blocked: operation already in progress (concurrent start/stop guard)');
        return;
    }
    operationInProgress = true;
    try {
        /* Tear down any existing channel before creating a new one. This handles
           the case where we're switching users (logout + login) or recovering
           from an error state. */
        await stopRealtimeSubscriptionsInternal();
        state.userId = userId;
        state.deviceId = getDeviceId();
        setConnectionState('connecting');
        const config = getEngineConfig();
        const realtimeTables = config.tables.map((t) => t.supabaseName);
        /* ---- Channel creation ----
           One channel per user, listening to all configured tables. This is more
           efficient than one channel per table because Supabase multiplexes all
           subscriptions over a single WebSocket connection regardless. The channel
           name includes the user ID to ensure uniqueness across browser tabs that
           might have different users logged in. */
        const channelName = `${config.prefix}_sync_${userId}`;
        state.channel = config.supabase.channel(channelName);
        /* ---- Register table listeners ----
           We subscribe to `event: '*'` (INSERT, UPDATE, DELETE) on each table.
           No `filter` parameter is used because RLS policies enforce row-level
           security at the database level. Adding a client-side filter would be
           redundant and could fall out of sync with the RLS policy definitions. */
        debugLog(`[Realtime] Setting up subscriptions for ${realtimeTables.length} tables`);
        for (const table of realtimeTables) {
            state.channel = state.channel.on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: table
            }, (payload) => {
                debugLog(`[Realtime] Raw payload received for ${table}:`, payload.eventType);
                /* Fire-and-forget: the handler runs asynchronously. Errors are caught
                   inside handleRealtimeChange so they don't propagate to the Supabase
                   client's event loop. */
                handleRealtimeChange(table, payload).catch((error) => {
                    debugError(`[Realtime] Error processing ${table} change:`, error);
                });
            });
        }
        /* ---- Activate the channel ----
           The status callback handles lifecycle transitions. Note that Supabase
           may emit multiple statuses for the same underlying event (e.g.,
           CHANNEL_ERROR followed by CLOSED for a single disconnection). */
        state.channel.subscribe((status, err) => {
            switch (status) {
                case 'SUBSCRIBED':
                    debugLog('[Realtime] Connected and subscribed');
                    /* Reset backoff counter on successful connection so the next
                       disconnection starts fresh with a 1s delay. */
                    state.reconnectAttempts = 0;
                    reconnectScheduled = false;
                    setConnectionState('connected');
                    break;
                case 'CHANNEL_ERROR':
                    debugError('[Realtime] Channel error:', err?.message || 'unknown', err);
                    setConnectionState('error', err?.message || 'Channel error');
                    scheduleReconnect();
                    break;
                case 'TIMED_OUT':
                    debugWarn('[Realtime] Connection timed out');
                    setConnectionState('error', 'Connection timed out');
                    scheduleReconnect();
                    break;
                case 'CLOSED':
                    debugLog('[Realtime] Channel closed');
                    /* Only reconnect if:
                       1. This wasn't an intentional disconnect (state would be 'disconnected').
                       2. We still have a user to reconnect for.
                       3. A reconnect isn't already scheduled (prevents duplicate timers
                          when CHANNEL_ERROR fires shortly before CLOSED).
                       Without condition 3, we would schedule two overlapping reconnect
                       timers for a single disconnection event. */
                    if (state.connectionState !== 'disconnected' && state.userId && !reconnectScheduled) {
                        setConnectionState('disconnected');
                        scheduleReconnect();
                    }
                    else if (isDebugMode()) {
                        debugLog(`[Realtime] CLOSED reconnect suppressed: state=${state.connectionState}, userId=${!!state.userId}, reconnectScheduled=${reconnectScheduled}`);
                    }
                    break;
            }
        });
    }
    catch (error) {
        debugError('[Realtime] Failed to start subscriptions:', error);
        setConnectionState('error', error instanceof Error ? error.message : 'Failed to connect');
        scheduleReconnect();
    }
    finally {
        /* Always release the concurrency lock, even on error. Without this,
           a failed start would permanently block all future start/stop attempts. */
        operationInProgress = false;
    }
}
/**
 * Stop realtime subscriptions and clean up all state.
 *
 * This is the public-facing teardown API. It acquires the concurrency lock,
 * delegates to {@link stopRealtimeSubscriptionsInternal}, clears the user ID,
 * and wipes the recently-processed tracking map.
 *
 * **When to call:** On user logout or app shutdown. For temporary connectivity
 * loss, use {@link pauseRealtime} instead (it preserves the userId so
 * reconnection can resume automatically).
 *
 * @throws Never throws -- errors during channel removal are caught and logged.
 *
 * @example
 * ```ts
 * // On logout:
 * await stopRealtimeSubscriptions();
 * ```
 *
 * @see {@link startRealtimeSubscriptions} to re-establish the connection
 * @see {@link pauseRealtime} for temporary disconnection (offline)
 */
export async function stopRealtimeSubscriptions() {
    /* Concurrency guard: prevent overlapping start/stop sequences. */
    if (operationInProgress) {
        debugLog('[Realtime] Stop blocked: operation already in progress (concurrent start/stop guard)');
        return;
    }
    operationInProgress = true;
    try {
        await stopRealtimeSubscriptionsInternal();
        state.userId = null;
        /* Clear tracking so stale entries don't leak across sessions. Without
           this, a dedup entry from user A's session could cause user B's session
           (if they log in on the same device) to skip a legitimate change. */
        recentlyProcessedByRealtime.clear();
    }
    finally {
        operationInProgress = false;
    }
}
/**
 * Pause realtime subscriptions when the browser goes offline.
 *
 * Unlike {@link stopRealtimeSubscriptions}, this does **not** clear
 * `state.userId` -- the user is still authenticated, we just can't reach
 * the server. When the browser comes back online, the sync engine calls
 * {@link startRealtimeSubscriptions} with the same user ID.
 *
 * Key behaviors:
 * - Cancels any pending reconnect timers.
 * - Resets the reconnect attempt counter so we get a fresh set of attempts
 *   when connectivity returns.
 * - Transitions to `'disconnected'` state.
 *
 * **Why not call stopRealtimeSubscriptionsInternal?** Because the offline
 * transition is often transient (e.g., brief WiFi dropout). We want to
 * preserve the userId and avoid the overhead of `removeChannel()` (which
 * tries to send an unsubscribe message over the dead WebSocket). Simply
 * clearing the reconnect state and transitioning to `'disconnected'` is
 * faster and avoids potential errors from network calls during offline.
 *
 * @see {@link ./engine.ts} -- calls this from the `offline` event handler
 */
export function pauseRealtime() {
    /* Cancel any in-flight reconnection timer and reset the flag.
       Without this, a timer set before the offline event could fire during
       the offline period and waste a reconnect attempt. */
    if (state.reconnectTimeout) {
        clearTimeout(state.reconnectTimeout);
        state.reconnectTimeout = null;
    }
    reconnectScheduled = false;
    /* Reset attempts so the next online event gets the full backoff budget.
       This is more forgiving than carrying over the count: if the user's
       network flaps repeatedly, they get a full set of 5 attempts each time. */
    state.reconnectAttempts = 0;
    setConnectionState('disconnected');
    debugLog('[Realtime] Paused - waiting for online event');
}
//# sourceMappingURL=realtime.js.map