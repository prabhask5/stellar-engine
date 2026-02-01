import { writable } from 'svelte/store';
import type { SyncStatus } from '../types';

// Detailed sync error for debugging
export interface SyncError {
  table: string;
  operation: string;
  entityId: string;
  message: string;
  timestamp: string;
}

// Realtime connection state
export type RealtimeState = 'disconnected' | 'connecting' | 'connected' | 'error';

interface SyncState {
  status: SyncStatus;
  pendingCount: number;
  lastError: string | null; // Friendly error message
  lastErrorDetails: string | null; // Raw technical error
  syncErrors: SyncError[]; // Detailed errors for debugging
  lastSyncTime: string | null;
  syncMessage: string | null; // Human-readable status message
  isTabVisible: boolean; // Track if tab is visible
  realtimeState: RealtimeState; // Track realtime connection
}

// Minimum time to show 'syncing' state to prevent flickering (ms)
const MIN_SYNCING_TIME = 500;

// Max errors to keep in history
const MAX_ERROR_HISTORY = 10;

function createSyncStatusStore() {
  const { subscribe, set, update } = writable<SyncState>({
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

  let currentStatus: SyncStatus = 'idle';
  let syncingStartTime: number | null = null;
  let pendingStatusChange: { status: SyncStatus; timeout: ReturnType<typeof setTimeout> } | null =
    null;

  return {
    subscribe,
    setStatus: (status: SyncStatus) => {
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
      } else if (syncingStartTime !== null) {
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
        } else {
          syncingStartTime = null;
          currentStatus = status;
          update((state) => ({
            ...state,
            status,
            lastError: status === 'idle' ? null : state.lastError
          }));
        }
      } else {
        currentStatus = status;
        update((state) => ({
          ...state,
          status,
          lastError: status === 'idle' ? null : state.lastError
        }));
      }
    },
    setPendingCount: (count: number) => update((state) => ({ ...state, pendingCount: count })),
    setError: (friendly: string | null, raw?: string | null) =>
      update((state) => ({
        ...state,
        lastError: friendly,
        lastErrorDetails: raw ?? null
      })),
    addSyncError: (error: SyncError) =>
      update((state) => ({
        ...state,
        syncErrors: [...state.syncErrors, error].slice(-MAX_ERROR_HISTORY)
      })),
    clearSyncErrors: () => update((state) => ({ ...state, syncErrors: [] })),
    setLastSyncTime: (time: string) => update((state) => ({ ...state, lastSyncTime: time })),
    setSyncMessage: (message: string | null) =>
      update((state) => ({ ...state, syncMessage: message })),
    setTabVisible: (visible: boolean) => update((state) => ({ ...state, isTabVisible: visible })),
    setRealtimeState: (realtimeState: RealtimeState) =>
      update((state) => ({ ...state, realtimeState })),
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
