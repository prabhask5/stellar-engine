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
import type { SyncStatus } from '../types';
/**
 * Detailed sync error record for debugging and error history display.
 * Stored in the `syncErrors` array (capped at `MAX_ERROR_HISTORY` entries).
 */
export interface SyncError {
    /** Database table where the error occurred */
    table: string;
    /** The sync operation that failed (e.g., 'push', 'pull', 'upsert') */
    operation: string;
    /** Unique identifier of the entity involved in the failed operation */
    entityId: string;
    /** Human-readable error message */
    message: string;
    /** ISO 8601 timestamp of when the error occurred */
    timestamp: string;
}
/**
 * Supabase Realtime channel connection state.
 * Tracks the lifecycle of the realtime subscription independently of sync status.
 */
export type RealtimeState = 'disconnected' | 'connecting' | 'connected' | 'error';
/**
 * Complete internal state shape for the sync status store.
 */
interface SyncState {
    /** Current high-level sync lifecycle phase */
    status: SyncStatus;
    /** Number of local changes waiting to be pushed to the remote */
    pendingCount: number;
    /** User-friendly error message for display in UI banners */
    lastError: string | null;
    /** Raw technical error string for debugging (e.g., Supabase error codes) */
    lastErrorDetails: string | null;
    /** Rolling history of detailed sync errors (capped at MAX_ERROR_HISTORY) */
    syncErrors: SyncError[];
    /** ISO 8601 timestamp of the last successful sync completion */
    lastSyncTime: string | null;
    /** Human-readable status message (e.g., "Syncing 3 changes...") */
    syncMessage: string | null;
    /**
     * Whether the browser tab is currently visible.
     * Used to throttle or pause sync operations when the app is backgrounded.
     */
    isTabVisible: boolean;
    /**
     * Current state of the Supabase Realtime channel connection.
     * Tracked separately from `status` since realtime can disconnect
     * independently of the push/pull sync cycle.
     */
    realtimeState: RealtimeState;
}
/**
 * Singleton sync status store used throughout the application.
 *
 * @see {@link createSyncStatusStore} for implementation details
 */
export declare const syncStatusStore: {
    subscribe: (this: void, run: import("svelte/store").Subscriber<SyncState>, invalidate?: () => void) => import("svelte/store").Unsubscriber;
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
    setStatus: (status: SyncStatus) => void;
    /**
     * Update the count of local changes pending remote push.
     *
     * @param count - Number of pending changes
     */
    setPendingCount: (count: number) => void;
    /**
     * Set or clear the error messages (both user-friendly and raw/technical).
     *
     * @param friendly - Human-readable error message for UI display, or null to clear
     * @param raw - Optional raw technical error string for debugging
     */
    setError: (friendly: string | null, raw?: string | null) => void;
    /**
     * Append a detailed sync error to the rolling error history.
     * The history is capped at `MAX_ERROR_HISTORY` entries (oldest discarded first).
     *
     * @param error - The detailed sync error record to add
     *
     * @see {@link SyncError} for the error record structure
     * @see {@link MAX_ERROR_HISTORY} for the history size limit
     */
    addSyncError: (error: SyncError) => void;
    /**
     * Clear all entries from the sync error history.
     * Typically called when a new sync cycle begins successfully.
     */
    clearSyncErrors: () => void;
    /**
     * Record the timestamp of the last successful sync completion.
     *
     * @param time - ISO 8601 formatted timestamp string
     */
    setLastSyncTime: (time: string) => void;
    /**
     * Set or clear the human-readable sync progress message.
     *
     * @param message - Status text (e.g., "Pushing 3 changes...") or null to clear
     */
    setSyncMessage: (message: string | null) => void;
    /**
     * Update the tab visibility flag.
     * Used by the sync engine to pause or throttle operations when backgrounded.
     *
     * @param visible - Whether the browser tab is currently visible
     */
    setTabVisible: (visible: boolean) => void;
    /**
     * Update the Supabase Realtime channel connection state.
     *
     * @param realtimeState - The current realtime connection state
     *
     * @see {@link RealtimeState} for possible values
     */
    setRealtimeState: (realtimeState: RealtimeState) => void;
    /**
     * Reset the entire store to its initial default state.
     *
     * Cleans up any pending delayed status transitions and resets all closure
     * variables. Called during logout or app teardown to prevent stale state
     * from carrying over.
     */
    reset: () => void;
};
export {};
//# sourceMappingURL=sync.d.ts.map