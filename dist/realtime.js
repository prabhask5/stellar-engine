/**
 * Real-Time Subscription Manager
 *
 * Phase 5 of multi-device sync: Implements Supabase Realtime subscriptions
 * for instant multi-device synchronization.
 *
 * Design decisions:
 * - Uses Supabase Realtime PostgreSQL Changes for all entity tables
 * - Skips echo (own changes) by comparing device_id in the payload
 * - Tracks recently processed entities to prevent duplicate processing with polling
 * - Applies changes through existing conflict resolution engine
 * - Falls back to polling if WebSocket connection fails (max 5 reconnect attempts)
 * - Single channel per user with filter by user_id for efficiency
 * - Pauses reconnection attempts while offline (waits for online event)
 * - Uses reconnectScheduled flag to prevent duplicate reconnect attempts
 */
import { debugLog, debugWarn, debugError } from './debug';
import { getEngineConfig } from './config';
import { getDeviceId } from './deviceId';
import { resolveConflicts, storeConflictHistory, getPendingOpsForEntity } from './conflicts';
import { getPendingEntityIds } from './queue';
import { remoteChangesStore } from './stores/remoteChanges';
// Protection window for recently modified entities (matches engine.ts)
const RECENTLY_MODIFIED_TTL_MS = 2000;
// Track entities that realtime has just processed (to prevent duplicate processing with polling)
// This is separate from engine.ts's recentlyModifiedEntities (which tracks local writes)
const recentlyProcessedByRealtime = new Map();
const state = {
    channel: null,
    connectionState: 'disconnected',
    userId: null,
    deviceId: '',
    lastError: null,
    reconnectAttempts: 0,
    reconnectTimeout: null
};
// Callbacks for state changes and data updates
const connectionCallbacks = new Set();
const dataUpdateCallbacks = new Set();
// Maximum reconnect attempts before giving up (will fall back to polling)
const MAX_RECONNECT_ATTEMPTS = 5;
// Base delay for exponential backoff (ms)
const RECONNECT_BASE_DELAY = 1000;
// Lock to prevent concurrent start/stop operations
let operationInProgress = false;
// Flag to track if reconnect is already scheduled (prevents duplicate scheduling)
let reconnectScheduled = false;
/**
 * Subscribe to connection state changes
 */
export function onConnectionStateChange(callback) {
    connectionCallbacks.add(callback);
    // Immediately call with current state
    callback(state.connectionState);
    return () => connectionCallbacks.delete(callback);
}
/**
 * Subscribe to data update notifications (called after local DB is updated)
 */
export function onRealtimeDataUpdate(callback) {
    dataUpdateCallbacks.add(callback);
    return () => dataUpdateCallbacks.delete(callback);
}
/**
 * Get current realtime connection state.
 * Used by debug utilities exposed on the window object.
 */
export function getConnectionState() {
    return state.connectionState;
}
/**
 * Check if an entity was recently processed via realtime
 * Used by engine.ts to prevent duplicate processing during polling
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
 * Update connection state and notify subscribers
 */
function setConnectionState(newState, error) {
    state.connectionState = newState;
    state.lastError = error || null;
    for (const callback of connectionCallbacks) {
        try {
            callback(newState);
        }
        catch (e) {
            debugError('[Realtime] Connection callback error:', e);
        }
    }
}
/**
 * Notify data update subscribers
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
/**
 * Check if this change came from our own device (skip to prevent echo)
 */
function isOwnDeviceChange(record) {
    if (!record)
        return false;
    const recordDeviceId = record.device_id;
    return recordDeviceId === state.deviceId;
}
/**
 * Check if entity was recently processed by realtime (prevent duplicate processing)
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
/**
 * Handle incoming realtime change
 */
async function handleRealtimeChange(table, payload) {
    const eventType = payload.eventType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newRecord = payload.new;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldRecord = payload.old;
    // Determine entity ID
    const entityId = (newRecord?.id || oldRecord?.id);
    debugLog(`[Realtime] Received ${eventType} on ${table}:`, entityId);
    if (!entityId) {
        debugWarn('[Realtime] Change without entity ID:', table, eventType);
        return;
    }
    // Skip if this change came from our own device (prevents echo)
    if (isOwnDeviceChange(newRecord)) {
        debugLog(`[Realtime] Skipping own device change: ${table}/${entityId}`);
        return;
    }
    // Skip if we just processed this entity (prevents rapid duplicate processing)
    if (wasRecentlyProcessed(entityId)) {
        debugLog(`[Realtime] Skipping recently processed: ${table}/${entityId}`);
        return;
    }
    debugLog(`[Realtime] Processing remote change: ${eventType} ${table}/${entityId}`);
    const dexieTable = getEngineConfig().tables.find(t => t.supabaseName === table)?.dexieTable;
    if (!dexieTable) {
        debugWarn('[Realtime] Unknown table:', table);
        return;
    }
    try {
        switch (eventType) {
            case 'INSERT':
            case 'UPDATE': {
                if (!newRecord)
                    return;
                // Check if entity is being edited in a manual-save form
                const _isBeingEdited = remoteChangesStore.isEditing(entityId, table);
                // Get local entity if it exists
                const localEntity = await getEngineConfig().db.table(dexieTable).get(entityId);
                // Determine which fields changed
                const changedFields = [];
                if (localEntity && newRecord) {
                    for (const key of Object.keys(newRecord)) {
                        if (key === 'updated_at' || key === '_version')
                            continue;
                        if (JSON.stringify(localEntity[key]) !== JSON.stringify(newRecord[key])) {
                            changedFields.push(key);
                        }
                    }
                }
                // Soft delete: UPDATE with deleted=true is treated as a deletion
                // Play the delete animation BEFORE writing to DB so stores don't filter it out instantly
                const isSoftDelete = newRecord.deleted === true && localEntity && !localEntity.deleted;
                if (isSoftDelete) {
                    debugLog(`[Realtime] Soft delete detected for ${table}/${entityId}`);
                    // Record delete animation and wait for it to play
                    remoteChangesStore.recordRemoteChange(entityId, table, ['*'], true, 'DELETE');
                    await remoteChangesStore.markPendingDelete(entityId, table);
                    // Now write the soft-deleted record to DB (triggers reactive store refresh)
                    await getEngineConfig().db.table(dexieTable).put(newRecord);
                    recentlyProcessedByRealtime.set(entityId, Date.now());
                    notifyDataUpdate(table, entityId);
                    break;
                }
                // Check for pending operations
                const pendingEntityIds = await getPendingEntityIds();
                const hasPendingOps = pendingEntityIds.has(entityId);
                let applied = false;
                if (!localEntity) {
                    // New entity - just insert it
                    await getEngineConfig().db.table(dexieTable).put(newRecord);
                    applied = true;
                }
                else if (!hasPendingOps) {
                    // No pending ops - check if remote is newer
                    const localUpdatedAt = new Date(localEntity.updated_at).getTime();
                    const remoteUpdatedAt = new Date(newRecord.updated_at).getTime();
                    if (remoteUpdatedAt > localUpdatedAt) {
                        // Remote is newer, accept it
                        await getEngineConfig().db.table(dexieTable).put(newRecord);
                        applied = true;
                    }
                }
                else {
                    // Has pending operations - use conflict resolution
                    const pendingOps = await getPendingOpsForEntity(entityId);
                    const resolution = await resolveConflicts(table, entityId, localEntity, newRecord, pendingOps);
                    // Store merged entity
                    await getEngineConfig().db.table(dexieTable).put(resolution.mergedEntity);
                    applied = true;
                    // Store conflict history if there were conflicts
                    if (resolution.hasConflicts) {
                        await storeConflictHistory(resolution);
                    }
                }
                // Calculate value delta for increment/decrement detection
                let valueDelta;
                if (changedFields.includes('current_value') && localEntity && newRecord) {
                    const oldValue = localEntity.current_value || 0;
                    const newValue = newRecord.current_value || 0;
                    valueDelta = newValue - oldValue;
                }
                // Record the remote change for UI animation
                // If entity is being edited in a form, the change will be deferred
                // We pass the eventType so the store can detect the action type
                if (changedFields.length > 0 || !localEntity) {
                    remoteChangesStore.recordRemoteChange(entityId, table, changedFields.length > 0 ? changedFields : ['*'], applied, eventType, valueDelta);
                    // Call table-specific onRemoteChange hook if configured
                    const tblConfig = getEngineConfig().tables.find(t => t.supabaseName === table);
                    if (tblConfig?.onRemoteChange) {
                        tblConfig.onRemoteChange(table, newRecord);
                    }
                }
                // Mark as recently processed to prevent duplicate processing by polling
                recentlyProcessedByRealtime.set(entityId, Date.now());
                // Notify subscribers
                notifyDataUpdate(table, entityId);
                break;
            }
            case 'DELETE': {
                // For soft-delete systems, this would be an UPDATE with deleted=true
                // But if hard delete happens, we should remove locally too
                if (oldRecord) {
                    // Record the delete for UI animation before removing
                    remoteChangesStore.recordRemoteChange(entityId, table, ['*'], true, 'DELETE');
                    // Mark as pending delete and wait for animation to complete
                    // This allows the UI to play the delete animation before DOM removal
                    await remoteChangesStore.markPendingDelete(entityId, table);
                    // Now actually delete from database (triggers reactive DOM removal)
                    await getEngineConfig().db.table(dexieTable).delete(entityId);
                    // Mark as recently processed
                    recentlyProcessedByRealtime.set(entityId, Date.now());
                    notifyDataUpdate(table, entityId);
                }
                break;
            }
        }
    }
    catch (error) {
        debugError(`[Realtime] Error handling ${eventType} on ${table}:`, error);
    }
}
/**
 * Schedule reconnection with exponential backoff
 * Only schedules if online - no point reconnecting while offline
 */
function scheduleReconnect() {
    // Prevent duplicate scheduling from multiple event callbacks
    if (reconnectScheduled) {
        return;
    }
    if (state.reconnectTimeout) {
        clearTimeout(state.reconnectTimeout);
        state.reconnectTimeout = null;
    }
    // Don't attempt reconnection while offline - wait for online event
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
    const delay = RECONNECT_BASE_DELAY * Math.pow(2, state.reconnectAttempts);
    debugLog(`[Realtime] Scheduling reconnect attempt ${state.reconnectAttempts + 1} in ${delay}ms`);
    state.reconnectTimeout = setTimeout(async () => {
        reconnectScheduled = false;
        // Double-check we're still online before attempting
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
/**
 * Internal stop function (doesn't check operation lock)
 */
async function stopRealtimeSubscriptionsInternal() {
    // Clear reconnect timeout and flag
    if (state.reconnectTimeout) {
        clearTimeout(state.reconnectTimeout);
        state.reconnectTimeout = null;
    }
    reconnectScheduled = false;
    // Unsubscribe from channel
    if (state.channel) {
        try {
            await getEngineConfig().supabase.removeChannel(state.channel);
        }
        catch (error) {
            debugError('[Realtime] Error removing channel:', error);
        }
        state.channel = null;
    }
    state.reconnectAttempts = 0;
    setConnectionState('disconnected');
}
/**
 * Start realtime subscriptions for a user
 */
export async function startRealtimeSubscriptions(userId) {
    if (typeof window === 'undefined')
        return;
    // Don't start if offline - wait for online event
    if (!navigator.onLine) {
        debugLog('[Realtime] Offline - skipping subscription start');
        return;
    }
    // Don't start if already connected with same user
    if (state.channel && state.userId === userId && state.connectionState === 'connected') {
        return;
    }
    // Prevent concurrent start/stop operations
    if (operationInProgress) {
        debugLog('[Realtime] Operation already in progress, skipping');
        return;
    }
    operationInProgress = true;
    try {
        // Stop existing subscriptions first
        await stopRealtimeSubscriptionsInternal();
        state.userId = userId;
        state.deviceId = getDeviceId();
        setConnectionState('connecting');
        const config = getEngineConfig();
        const realtimeTables = config.tables.map(t => t.supabaseName);
        // Create a single channel for all tables
        // Using a unique channel name per user
        const channelName = `${config.prefix}_sync_${userId}`;
        state.channel = config.supabase.channel(channelName);
        // Subscribe to all tables without user_id filter
        // RLS (Row Level Security) policies handle security at the database level
        debugLog(`[Realtime] Setting up subscriptions for ${realtimeTables.length} tables`);
        for (const table of realtimeTables) {
            state.channel = state.channel.on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: table
            }, (payload) => {
                debugLog(`[Realtime] Raw payload received for ${table}:`, payload.eventType);
                handleRealtimeChange(table, payload).catch((error) => {
                    debugError(`[Realtime] Error processing ${table} change:`, error);
                });
            });
        }
        // Subscribe to the channel
        state.channel.subscribe((status, err) => {
            // Release the operation lock once we get any response
            operationInProgress = false;
            switch (status) {
                case 'SUBSCRIBED':
                    debugLog('[Realtime] Connected and subscribed');
                    state.reconnectAttempts = 0;
                    reconnectScheduled = false;
                    setConnectionState('connected');
                    break;
                case 'CHANNEL_ERROR':
                    if (err?.message) {
                        debugError('[Realtime] Channel error:', err?.message);
                    }
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
                    // Only try to reconnect if:
                    // 1. We weren't intentionally disconnected
                    // 2. We have a user
                    // 3. We're not already scheduled for reconnect (prevents duplicate from CHANNEL_ERROR + CLOSED)
                    if (state.connectionState !== 'disconnected' && state.userId && !reconnectScheduled) {
                        setConnectionState('disconnected');
                        scheduleReconnect();
                    }
                    break;
            }
        });
    }
    catch (error) {
        operationInProgress = false;
        debugError('[Realtime] Failed to start subscriptions:', error);
        setConnectionState('error', error instanceof Error ? error.message : 'Failed to connect');
        scheduleReconnect();
    }
}
/**
 * Stop realtime subscriptions (public API)
 */
export async function stopRealtimeSubscriptions() {
    // Prevent concurrent operations
    if (operationInProgress) {
        debugLog('[Realtime] Operation already in progress, skipping stop');
        return;
    }
    operationInProgress = true;
    try {
        await stopRealtimeSubscriptionsInternal();
        state.userId = null;
        // Clear recently processed tracking
        recentlyProcessedByRealtime.clear();
    }
    finally {
        operationInProgress = false;
    }
}
/**
 * Pause realtime (when going offline) - stops reconnection attempts
 * Called by sync engine when offline event fires
 */
export function pauseRealtime() {
    // Clear any pending reconnect attempts and reset flags
    if (state.reconnectTimeout) {
        clearTimeout(state.reconnectTimeout);
        state.reconnectTimeout = null;
    }
    reconnectScheduled = false;
    // Reset reconnect attempts so we get fresh attempts when coming online
    state.reconnectAttempts = 0;
    setConnectionState('disconnected');
    debugLog('[Realtime] Paused - waiting for online event');
}
/**
 * Check if realtime is healthy (connected and not in error state)
 */
export function isRealtimeHealthy() {
    return state.connectionState === 'connected';
}
/**
 * Clean up expired entries from recently processed tracking
 */
export function cleanupRealtimeTracking() {
    const now = Date.now();
    for (const [entityId, processedAt] of recentlyProcessedByRealtime) {
        if (now - processedAt > RECENTLY_MODIFIED_TTL_MS) {
            recentlyProcessedByRealtime.delete(entityId);
        }
    }
}
//# sourceMappingURL=realtime.js.map