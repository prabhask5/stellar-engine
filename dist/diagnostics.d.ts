/**
 * @fileoverview Unified Diagnostics Module
 *
 * Provides a single entry point for inspecting the internal state of the
 * stellar-engine sync system. The main `getDiagnostics()` function returns a
 * comprehensive JSON snapshot covering sync cycles, egress, queue, realtime,
 * network, conflict history, errors, and configuration.
 *
 * Each call returns a **point-in-time snapshot** — the data is not reactive.
 * For a live dashboard, the consumer app should poll `getDiagnostics()` at the
 * desired frequency (e.g., via `setInterval` or `onSyncComplete` callback).
 *
 * Sub-category functions (`getSyncDiagnostics`, `getRealtimeDiagnostics`, etc.)
 * are also exported for lightweight access to specific sections without
 * incurring the cost of async operations (queue/conflict reads).
 *
 * **Dependency direction:** This module imports from engine, realtime, queue,
 * conflicts, config, deviceId, stores, and utils. No module imports from
 * diagnostics — this guarantees zero circular dependency risk.
 *
 * @module diagnostics
 * @see {@link ./engine.ts} for the core sync engine
 * @see {@link ./realtime.ts} for WebSocket connection management
 * @see {@link ./conflicts.ts} for conflict resolution history
 */
import type { ConflictHistoryEntry, SyncStatus } from './types';
import type { RealtimeConnectionState } from './realtime';
import type { SyncError } from './stores/sync';
import type { CRDTConnectionState } from './crdt/types';
/**
 * Comprehensive diagnostics snapshot returned by {@link getDiagnostics}.
 *
 * Contains every observable aspect of the sync engine's runtime state,
 * structured into logical sections for easy consumption by dashboards,
 * logging pipelines, or browser console inspection.
 */
export interface DiagnosticsSnapshot {
    /** ISO 8601 timestamp of when this snapshot was captured */
    timestamp: string;
    /** Engine prefix (e.g., `"engine"` or `"stellar"`) */
    prefix: string;
    /** Stable device identifier for this browser/device */
    deviceId: string;
    /** Sync cycle statistics and cursor state */
    sync: {
        status: SyncStatus;
        totalCycles: number;
        lastSyncTime: string | null;
        lastSuccessfulSyncTimestamp: string | null;
        syncMessage: string | null;
        recentCycles: Array<{
            timestamp: string;
            trigger: string;
            pushedItems: number;
            pulledTables: number;
            pulledRecords: number;
            egressBytes: number;
            durationMs: number;
        }>;
        cyclesLastMinute: number;
        hasHydrated: boolean;
        schemaValidated: boolean;
        pendingCount: number;
    };
    /** Cumulative egress (bandwidth) statistics for the current session */
    egress: {
        sessionStart: string;
        totalBytes: number;
        totalFormatted: string;
        totalRecords: number;
        byTable: Record<string, {
            bytes: number;
            formatted: string;
            records: number;
            percentage: string;
        }>;
    };
    /** Pending sync queue state */
    queue: {
        pendingOperations: number;
        pendingEntityIds: string[];
        byTable: Record<string, number>;
        byOperationType: Record<string, number>;
        oldestPendingTimestamp: string | null;
        itemsInBackoff: number;
    };
    /** Realtime WebSocket connection state */
    realtime: {
        connectionState: RealtimeConnectionState;
        healthy: boolean;
        reconnectAttempts: number;
        lastError: string | null;
        userId: string | null;
        deviceId: string;
        recentlyProcessedCount: number;
        operationInProgress: boolean;
        reconnectScheduled: boolean;
    };
    /** Browser network connectivity */
    network: {
        online: boolean;
    };
    /** Engine-internal state (locks, visibility, auth) */
    engine: {
        isTabVisible: boolean;
        tabHiddenAt: string | null;
        lockHeld: boolean;
        lockHeldForMs: number | null;
        recentlyModifiedCount: number;
        wasOffline: boolean;
        authValidatedAfterReconnect: boolean;
    };
    /** Recent conflict resolution history */
    conflicts: {
        recentHistory: ConflictHistoryEntry[];
        totalCount: number;
    };
    /** Error state from the sync status store */
    errors: {
        lastError: string | null;
        lastErrorDetails: string | null;
        recentErrors: SyncError[];
    };
    /** CRDT collaborative editing subsystem diagnostics */
    crdt: {
        /** Whether the CRDT subsystem is enabled (crdt config provided to initEngine). */
        enabled: boolean;
        /** Resolved CRDT configuration (null if not enabled). */
        config: {
            supabaseTable: string;
            persistIntervalMs: number;
            broadcastDebounceMs: number;
            localSaveDebounceMs: number;
            cursorDebounceMs: number;
            maxOfflineDocuments: number;
            maxBroadcastPayloadBytes: number;
            syncPeerTimeoutMs: number;
            maxReconnectAttempts: number;
            reconnectBaseDelayMs: number;
        } | null;
        /** Currently active (open) CRDT documents. */
        activeDocuments: Array<{
            documentId: string;
            pageId: string;
            connectionState: CRDTConnectionState;
            isDirty: boolean;
            /** Current Y.Doc state size in bytes. */
            stateSizeBytes: number;
            stateSizeFormatted: string;
            /** Number of remote collaborators currently connected. */
            collaboratorCount: number;
            /** Names of connected collaborators. */
            collaboratorNames: string[];
        }>;
        /** Total number of active documents. */
        activeDocumentCount: number;
        /** Offline storage statistics. */
        offline: {
            /** Number of documents stored for offline access. */
            documentCount: number;
            /** Max offline documents allowed. */
            maxDocuments: number;
            /** Total bytes stored across all offline documents. */
            totalSizeBytes: number;
            totalSizeFormatted: string;
            /** Per-document offline storage details. */
            documents: Array<{
                documentId: string;
                pageId: string;
                stateSizeBytes: number;
                stateSizeFormatted: string;
                localUpdatedAt: string;
                lastPersistedAt: string | null;
                /** Whether this document has been persisted to Supabase since last local edit. */
                syncedWithRemote: boolean;
            }>;
        };
        /** Pending crash-recovery updates per active document. */
        pendingUpdates: Array<{
            documentId: string;
            updateCount: number;
        }>;
        /** Total pending updates across all documents. */
        totalPendingUpdates: number;
    };
    /** Engine configuration summary */
    config: {
        tableCount: number;
        tableNames: string[];
        syncDebounceMs: number;
        syncIntervalMs: number;
        tombstoneMaxAgeDays: number;
    };
}
/**
 * Capture a comprehensive diagnostics snapshot of the sync engine.
 *
 * This async function reads from all engine subsystems and returns a single
 * JSON-serializable object. The async operations (queue reads, conflict
 * history) are run in parallel for minimal latency.
 *
 * @returns A complete {@link DiagnosticsSnapshot}
 *
 * @example
 * ```ts
 * const snapshot = await getDiagnostics();
 * console.log(JSON.stringify(snapshot, null, 2));
 * ```
 */
export declare function getDiagnostics(): Promise<DiagnosticsSnapshot>;
/**
 * Get CRDT subsystem diagnostics (async — reads IndexedDB for offline and pending data).
 *
 * Returns a comprehensive snapshot of the CRDT subsystem including active documents,
 * their state sizes, connection states, collaborator counts, offline storage usage,
 * and pending crash-recovery updates.
 *
 * If CRDT is not enabled, returns a minimal object with `enabled: false`.
 *
 * @returns CRDT diagnostics section of the {@link DiagnosticsSnapshot}.
 */
export declare function getCRDTDiagnostics(): Promise<DiagnosticsSnapshot['crdt']>;
/**
 * Get sync cycle and egress diagnostics (synchronous).
 *
 * @returns Sync stats, egress totals, and per-table breakdown
 */
export declare function getSyncDiagnostics(): Pick<DiagnosticsSnapshot, 'sync' | 'egress'>;
/**
 * Get realtime WebSocket connection diagnostics (synchronous).
 *
 * @returns Current realtime connection state and metadata
 */
export declare function getRealtimeDiagnostics(): {
    connectionState: RealtimeConnectionState;
    healthy: boolean;
    reconnectAttempts: number;
    lastError: string | null;
    userId: string | null;
    deviceId: string;
    recentlyProcessedCount: number;
    operationInProgress: boolean;
    reconnectScheduled: boolean;
};
/**
 * Get pending sync queue diagnostics (async — reads IndexedDB).
 *
 * @returns Pending operation count, entity IDs, and breakdowns by table/operation type
 */
export declare function getQueueDiagnostics(): Promise<DiagnosticsSnapshot['queue']>;
/**
 * Get conflict resolution history diagnostics (async — reads IndexedDB).
 *
 * @returns Recent conflict entries and total count
 */
export declare function getConflictDiagnostics(): Promise<{
    recentHistory: ConflictHistoryEntry[];
    totalCount: number;
}>;
/**
 * Get engine-internal state diagnostics (synchronous).
 *
 * @returns Lock state, visibility, auth validation status
 */
export declare function getEngineDiagnostics(): {
    isTabVisible: boolean;
    tabHiddenAt: string | null;
    lockHeld: boolean;
    lockHeldForMs: number | null;
    recentlyModifiedCount: number;
    wasOffline: boolean;
    authValidatedAfterReconnect: boolean;
};
/**
 * Get network connectivity diagnostics (synchronous).
 *
 * @returns Current online/offline status
 */
export declare function getNetworkDiagnostics(): {
    online: boolean;
};
/**
 * Get error state diagnostics (synchronous).
 *
 * @returns Latest error info and recent error history
 */
export declare function getErrorDiagnostics(): {
    lastError: string | null;
    lastErrorDetails: string | null;
    recentErrors: SyncError[];
};
//# sourceMappingURL=diagnostics.d.ts.map