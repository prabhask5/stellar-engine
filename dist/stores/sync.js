/**
 * @fileoverview Sync Status Store
 *
 * Tracks the overall synchronization state between the local database and the
 * remote Supabase backend. Provides a unified view of sync progress, errors,
 * realtime connection health, and tab visibility for UI status indicators.
 *
 * **Svelte Store Pattern:**
 * Uses a custom writable store created via `createSyncStatusStore()`. The store
 * exposes the standard `subscribe` method for reactive UI binding, plus focused
 * setter methods for each aspect of the sync state. Closure variables
 * (`currentStatus`, `syncingStartTime`, `pendingStatusChange`) maintain
 * timing state outside the store to implement the anti-flicker logic.
 *
 * **Reactive Architecture:**
 * The sync engine calls `setStatus()` to transition through sync lifecycle phases
 * (idle -> syncing -> idle/error). UI components subscribe to the store to display
 * sync indicators, error banners, and connection badges. The store enforces a
 * minimum display time for the 'syncing' state to prevent visual flickering on
 * fast sync operations.
 *
 * @see {@link ../types} for the SyncStatus type definition
 * @see {@link ./network} for the network connectivity store that gates sync
 * @see {@link ./remoteChanges} for remote change tracking during sync
 */
import { writable } from 'svelte/store';
// =============================================================================
// Constants
// =============================================================================
/**
 * Minimum time (ms) to display the 'syncing' status in the UI.
 * Prevents visual flickering when sync completes faster than the user can
 * perceive the status change.
 */
const MIN_SYNCING_TIME = 500;
/**
 * Maximum number of detailed error entries to retain in the `syncErrors` array.
 * Older entries are discarded (FIFO) when this limit is reached.
 */
const MAX_ERROR_HISTORY = 10;
// =============================================================================
// Store Factory
// =============================================================================
/**
 * Creates the singleton sync status store.
 *
 * The store implements anti-flicker logic for the 'syncing' status: when
 * transitioning away from 'syncing', it ensures the syncing indicator was
 * displayed for at least `MIN_SYNCING_TIME` ms. If the sync completed faster,
 * the status transition is delayed to meet the minimum display time.
 *
 * Closure variables outside the store maintain timing state:
 *   - `currentStatus` - Tracks the last-set status for redundancy filtering
 *   - `syncingStartTime` - Records when 'syncing' status was entered
 *   - `pendingStatusChange` - Holds a delayed status transition (with its timeout handle)
 *
 * @returns A Svelte-compatible store with sync-specific setter methods
 *
 * @example
 * ```ts
 * // Sync engine usage:
 * syncStatusStore.setStatus('syncing');
 * syncStatusStore.setSyncMessage('Pushing 5 changes...');
 * await pushChanges();
 * syncStatusStore.setStatus('idle');
 *
 * // Component usage:
 * $: showSpinner = $syncStatusStore.status === 'syncing';
 * $: showError = $syncStatusStore.lastError !== null;
 * ```
 */
function createSyncStatusStore() {
    const { subscribe, set, update } = writable({
        status: 'idle',
        pendingCount: 0,
        lastError: null,
        lastErrorDetails: null,
        syncErrors: [],
        lastSyncTime: null,
        syncMessage: null,
        isTabVisible: true,
        realtimeState: 'disconnected'
    });
    // ---------------------------------------------------------------------------
    // Anti-Flicker Timing State
    // ---------------------------------------------------------------------------
    /** The last status value that was actually applied to the store */
    let currentStatus = 'idle';
    /** Timestamp when 'syncing' status was entered; null when not syncing */
    let syncingStartTime = null;
    /**
     * Holds a pending delayed status transition.
     * When sync completes before `MIN_SYNCING_TIME`, the final status change
     * is scheduled via setTimeout to prevent UI flickering.
     */
    let pendingStatusChange = null;
    // ---------------------------------------------------------------------------
    // Store Methods
    // ---------------------------------------------------------------------------
    return {
        subscribe,
        /**
         * Set the high-level sync status with anti-flicker protection.
         *
         * Transition rules:
         *   - Redundant updates (same status) are ignored to prevent unnecessary re-renders,
         *     except for 'syncing' which always resets the timer.
         *   - Entering 'syncing' clears previous errors and records the start time.
         *   - Leaving 'syncing' enforces `MIN_SYNCING_TIME` ms minimum display duration.
         *   - Transitioning to 'idle' clears the `lastError` field.
         *
         * @param status - The new sync status to set
         *
         * @see {@link MIN_SYNCING_TIME} for the anti-flicker threshold
         */
        setStatus: (status) => {
            /* Ignore redundant status updates to prevent unnecessary re-renders.
             * Exception: 'syncing' is always processed to reset the timer. */
            if (status === currentStatus && status !== 'syncing') {
                return;
            }
            /* Clear any pending delayed status change from a previous transition */
            if (pendingStatusChange) {
                clearTimeout(pendingStatusChange.timeout);
                pendingStatusChange = null;
            }
            if (status === 'syncing') {
                /* Starting sync - record the time and clear previous errors */
                syncingStartTime = Date.now();
                currentStatus = status;
                update((state) => ({ ...state, status, lastError: null, syncErrors: [] }));
            }
            else if (syncingStartTime !== null) {
                /* Ending sync - enforce minimum display time to prevent flickering */
                const elapsed = Date.now() - syncingStartTime;
                const remaining = MIN_SYNCING_TIME - elapsed;
                if (remaining > 0) {
                    /* Sync completed too fast - delay the status change so the user
                     * can see the syncing indicator for at least MIN_SYNCING_TIME */
                    pendingStatusChange = {
                        status,
                        timeout: setTimeout(() => {
                            syncingStartTime = null;
                            pendingStatusChange = null;
                            currentStatus = status;
                            update((state) => ({
                                ...state,
                                status,
                                lastError: status === 'idle' ? null : state.lastError
                            }));
                        }, remaining)
                    };
                }
                else {
                    /* Sync took long enough - apply the status change immediately */
                    syncingStartTime = null;
                    currentStatus = status;
                    update((state) => ({
                        ...state,
                        status,
                        lastError: status === 'idle' ? null : state.lastError
                    }));
                }
            }
            else {
                /* Direct status change (not coming from 'syncing') */
                currentStatus = status;
                update((state) => ({
                    ...state,
                    status,
                    lastError: status === 'idle' ? null : state.lastError
                }));
            }
        },
        /**
         * Update the count of local changes pending remote push.
         *
         * @param count - Number of pending changes
         */
        setPendingCount: (count) => update((state) => ({ ...state, pendingCount: count })),
        /**
         * Set or clear the error messages (both user-friendly and raw/technical).
         *
         * @param friendly - Human-readable error message for UI display, or null to clear
         * @param raw - Optional raw technical error string for debugging
         */
        setError: (friendly, raw) => update((state) => ({
            ...state,
            lastError: friendly,
            lastErrorDetails: raw ?? null
        })),
        /**
         * Append a detailed sync error to the rolling error history.
         * The history is capped at `MAX_ERROR_HISTORY` entries (oldest discarded first).
         *
         * @param error - The detailed sync error record to add
         *
         * @see {@link SyncError} for the error record structure
         * @see {@link MAX_ERROR_HISTORY} for the history size limit
         */
        addSyncError: (error) => update((state) => ({
            ...state,
            syncErrors: [...state.syncErrors, error].slice(-MAX_ERROR_HISTORY)
        })),
        /**
         * Clear all entries from the sync error history.
         * Typically called when a new sync cycle begins successfully.
         */
        clearSyncErrors: () => update((state) => ({ ...state, syncErrors: [] })),
        /**
         * Record the timestamp of the last successful sync completion.
         *
         * @param time - ISO 8601 formatted timestamp string
         */
        setLastSyncTime: (time) => update((state) => ({ ...state, lastSyncTime: time })),
        /**
         * Set or clear the human-readable sync progress message.
         *
         * @param message - Status text (e.g., "Pushing 3 changes...") or null to clear
         */
        setSyncMessage: (message) => update((state) => ({ ...state, syncMessage: message })),
        /**
         * Update the tab visibility flag.
         * Used by the sync engine to pause or throttle operations when backgrounded.
         *
         * @param visible - Whether the browser tab is currently visible
         */
        setTabVisible: (visible) => update((state) => ({ ...state, isTabVisible: visible })),
        /**
         * Update the Supabase Realtime channel connection state.
         *
         * @param realtimeState - The current realtime connection state
         *
         * @see {@link RealtimeState} for possible values
         */
        setRealtimeState: (realtimeState) => update((state) => ({ ...state, realtimeState })),
        /**
         * Reset the entire store to its initial default state.
         *
         * Cleans up any pending delayed status transitions and resets all closure
         * variables. Called during logout or app teardown to prevent stale state
         * from carrying over.
         */
        reset: () => {
            /* Clean up pending anti-flicker timeout to avoid orphaned callbacks */
            if (pendingStatusChange) {
                clearTimeout(pendingStatusChange.timeout);
                pendingStatusChange = null;
            }
            syncingStartTime = null;
            currentStatus = 'idle';
            set({
                status: 'idle',
                pendingCount: 0,
                lastError: null,
                lastErrorDetails: null,
                syncErrors: [],
                lastSyncTime: null,
                syncMessage: null,
                isTabVisible: true,
                realtimeState: 'disconnected'
            });
        }
    };
}
// =============================================================================
// Singleton Store Instance
// =============================================================================
/**
 * Singleton sync status store used throughout the application.
 *
 * @see {@link createSyncStatusStore} for implementation details
 */
export const syncStatusStore = createSyncStatusStore();
//# sourceMappingURL=sync.js.map