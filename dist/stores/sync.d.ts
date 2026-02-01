import type { SyncStatus } from '../types';
export interface SyncError {
    table: string;
    operation: string;
    entityId: string;
    message: string;
    timestamp: string;
}
export type RealtimeState = 'disconnected' | 'connecting' | 'connected' | 'error';
interface SyncState {
    status: SyncStatus;
    pendingCount: number;
    lastError: string | null;
    lastErrorDetails: string | null;
    syncErrors: SyncError[];
    lastSyncTime: string | null;
    syncMessage: string | null;
    isTabVisible: boolean;
    realtimeState: RealtimeState;
}
export declare const syncStatusStore: {
    subscribe: (this: void, run: import("svelte/store").Subscriber<SyncState>, invalidate?: () => void) => import("svelte/store").Unsubscriber;
    setStatus: (status: SyncStatus) => void;
    setPendingCount: (count: number) => void;
    setError: (friendly: string | null, raw?: string | null) => void;
    addSyncError: (error: SyncError) => void;
    clearSyncErrors: () => void;
    setLastSyncTime: (time: string) => void;
    setSyncMessage: (message: string | null) => void;
    setTabVisible: (visible: boolean) => void;
    setRealtimeState: (realtimeState: RealtimeState) => void;
    reset: () => void;
};
export {};
//# sourceMappingURL=sync.d.ts.map