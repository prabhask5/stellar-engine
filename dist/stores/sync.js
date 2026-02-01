import { writable } from 'svelte/store';
// Minimum time to show 'syncing' state to prevent flickering (ms)
const MIN_SYNCING_TIME = 500;
// Max errors to keep in history
const MAX_ERROR_HISTORY = 10;
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
    let currentStatus = 'idle';
    let syncingStartTime = null;
    let pendingStatusChange = null;
    return {
        subscribe,
        setStatus: (status) => {
            // Ignore redundant status updates to prevent unnecessary re-renders
            if (status === currentStatus && status !== 'syncing') {
                return;
            }
            // Clear any pending status change
            if (pendingStatusChange) {
                clearTimeout(pendingStatusChange.timeout);
                pendingStatusChange = null;
            }
            if (status === 'syncing') {
                // Starting sync - record the time and clear previous errors
                syncingStartTime = Date.now();
                currentStatus = status;
                update((state) => ({ ...state, status, lastError: null, syncErrors: [] }));
            }
            else if (syncingStartTime !== null) {
                // Ending sync - ensure minimum display time
                const elapsed = Date.now() - syncingStartTime;
                const remaining = MIN_SYNCING_TIME - elapsed;
                if (remaining > 0) {
                    // Delay the status change to prevent flickering
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
                currentStatus = status;
                update((state) => ({
                    ...state,
                    status,
                    lastError: status === 'idle' ? null : state.lastError
                }));
            }
        },
        setPendingCount: (count) => update((state) => ({ ...state, pendingCount: count })),
        setError: (friendly, raw) => update((state) => ({
            ...state,
            lastError: friendly,
            lastErrorDetails: raw ?? null
        })),
        addSyncError: (error) => update((state) => ({
            ...state,
            syncErrors: [...state.syncErrors, error].slice(-MAX_ERROR_HISTORY)
        })),
        clearSyncErrors: () => update((state) => ({ ...state, syncErrors: [] })),
        setLastSyncTime: (time) => update((state) => ({ ...state, lastSyncTime: time })),
        setSyncMessage: (message) => update((state) => ({ ...state, syncMessage: message })),
        setTabVisible: (visible) => update((state) => ({ ...state, isTabVisible: visible })),
        setRealtimeState: (realtimeState) => update((state) => ({ ...state, realtimeState })),
        reset: () => {
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
export const syncStatusStore = createSyncStatusStore();
//# sourceMappingURL=sync.js.map