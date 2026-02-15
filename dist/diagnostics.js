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
import { _getEngineDiagnostics } from './engine';
import { _getRealtimeDiagnostics } from './realtime';
import { _getRecentConflictHistory } from './conflicts';
import { getPendingSync, getPendingEntityIds } from './queue';
import { getEngineConfig } from './config';
import { getDeviceId } from './deviceId';
import { syncStatusStore } from './stores/sync';
import { isOnline } from './stores/network';
import { formatBytes } from './utils';
import { get } from 'svelte/store';
// =============================================================================
// Main Diagnostics Function
// =============================================================================
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
export async function getDiagnostics() {
    const config = getEngineConfig();
    const engineState = _getEngineDiagnostics();
    const realtimeState = _getRealtimeDiagnostics();
    const syncState = get(syncStatusStore);
    // Run async operations in parallel
    const [queueData, conflictData] = await Promise.all([
        getQueueDiagnostics(),
        getConflictDiagnostics()
    ]);
    // Build egress section with formatted values
    const egressByTable = {};
    for (const [table, stats] of Object.entries(engineState.egressStats.byTable)) {
        const pct = engineState.egressStats.totalBytes > 0
            ? ((stats.bytes / engineState.egressStats.totalBytes) * 100).toFixed(1)
            : '0.0';
        egressByTable[table] = {
            bytes: stats.bytes,
            formatted: formatBytes(stats.bytes),
            records: stats.records,
            percentage: `${pct}%`
        };
    }
    // Count cycles in the last minute
    const oneMinuteAgo = Date.now() - 60000;
    const cyclesLastMinute = engineState.syncStats.filter((s) => new Date(s.timestamp).getTime() > oneMinuteAgo).length;
    return {
        timestamp: new Date().toISOString(),
        prefix: config.prefix || 'engine',
        deviceId: getDeviceId(),
        sync: {
            status: syncState.status,
            totalCycles: engineState.totalSyncCycles,
            lastSyncTime: syncState.lastSyncTime,
            lastSuccessfulSyncTimestamp: engineState.lastSuccessfulSyncTimestamp
                ? new Date(engineState.lastSuccessfulSyncTimestamp).toISOString()
                : null,
            syncMessage: syncState.syncMessage,
            recentCycles: engineState.syncStats,
            cyclesLastMinute,
            hasHydrated: engineState.hasHydrated,
            schemaValidated: engineState.schemaValidated,
            pendingCount: syncState.pendingCount
        },
        egress: {
            sessionStart: engineState.egressStats.sessionStart,
            totalBytes: engineState.egressStats.totalBytes,
            totalFormatted: formatBytes(engineState.egressStats.totalBytes),
            totalRecords: engineState.egressStats.totalRecords,
            byTable: egressByTable
        },
        queue: queueData,
        realtime: realtimeState,
        network: getNetworkDiagnostics(),
        engine: {
            isTabVisible: engineState.isTabVisible,
            tabHiddenAt: engineState.tabHiddenAt ? new Date(engineState.tabHiddenAt).toISOString() : null,
            lockHeld: engineState.lockHeld,
            lockHeldForMs: engineState.lockHeldForMs,
            recentlyModifiedCount: engineState.recentlyModifiedCount,
            wasOffline: engineState.wasOffline,
            authValidatedAfterReconnect: engineState.authValidatedAfterReconnect
        },
        conflicts: conflictData,
        errors: getErrorDiagnostics(),
        config: {
            tableCount: config.tables.length,
            tableNames: config.tables.map((t) => t.supabaseName),
            syncDebounceMs: config.syncDebounceMs ?? 2000,
            syncIntervalMs: config.syncIntervalMs ?? 900000,
            tombstoneMaxAgeDays: config.tombstoneMaxAgeDays ?? 7
        }
    };
}
// =============================================================================
// Sub-Category Diagnostics Functions
// =============================================================================
/**
 * Get sync cycle and egress diagnostics (synchronous).
 *
 * @returns Sync stats, egress totals, and per-table breakdown
 */
export function getSyncDiagnostics() {
    const engineState = _getEngineDiagnostics();
    const syncState = get(syncStatusStore);
    const egressByTable = {};
    for (const [table, stats] of Object.entries(engineState.egressStats.byTable)) {
        const pct = engineState.egressStats.totalBytes > 0
            ? ((stats.bytes / engineState.egressStats.totalBytes) * 100).toFixed(1)
            : '0.0';
        egressByTable[table] = {
            bytes: stats.bytes,
            formatted: formatBytes(stats.bytes),
            records: stats.records,
            percentage: `${pct}%`
        };
    }
    const oneMinuteAgo = Date.now() - 60000;
    const cyclesLastMinute = engineState.syncStats.filter((s) => new Date(s.timestamp).getTime() > oneMinuteAgo).length;
    return {
        sync: {
            status: syncState.status,
            totalCycles: engineState.totalSyncCycles,
            lastSyncTime: syncState.lastSyncTime,
            lastSuccessfulSyncTimestamp: engineState.lastSuccessfulSyncTimestamp
                ? new Date(engineState.lastSuccessfulSyncTimestamp).toISOString()
                : null,
            syncMessage: syncState.syncMessage,
            recentCycles: engineState.syncStats,
            cyclesLastMinute,
            hasHydrated: engineState.hasHydrated,
            schemaValidated: engineState.schemaValidated,
            pendingCount: syncState.pendingCount
        },
        egress: {
            sessionStart: engineState.egressStats.sessionStart,
            totalBytes: engineState.egressStats.totalBytes,
            totalFormatted: formatBytes(engineState.egressStats.totalBytes),
            totalRecords: engineState.egressStats.totalRecords,
            byTable: egressByTable
        }
    };
}
/**
 * Get realtime WebSocket connection diagnostics (synchronous).
 *
 * @returns Current realtime connection state and metadata
 */
export function getRealtimeDiagnostics() {
    return _getRealtimeDiagnostics();
}
/**
 * Get pending sync queue diagnostics (async — reads IndexedDB).
 *
 * @returns Pending operation count, entity IDs, and breakdowns by table/operation type
 */
export async function getQueueDiagnostics() {
    const pending = await getPendingSync();
    const entityIds = await getPendingEntityIds();
    // Breakdown by table
    const byTable = {};
    const byOperationType = {};
    let oldestTimestamp = null;
    let itemsInBackoff = 0;
    for (const item of pending) {
        byTable[item.table] = (byTable[item.table] || 0) + 1;
        byOperationType[item.operationType] = (byOperationType[item.operationType] || 0) + 1;
        if (!oldestTimestamp || item.timestamp < oldestTimestamp) {
            oldestTimestamp = item.timestamp;
        }
        if (item.retries > 0) {
            itemsInBackoff++;
        }
    }
    return {
        pendingOperations: pending.length,
        pendingEntityIds: Array.from(entityIds),
        byTable,
        byOperationType,
        oldestPendingTimestamp: oldestTimestamp,
        itemsInBackoff
    };
}
/**
 * Get conflict resolution history diagnostics (async — reads IndexedDB).
 *
 * @returns Recent conflict entries and total count
 */
export async function getConflictDiagnostics() {
    const { entries, totalCount } = await _getRecentConflictHistory();
    return { recentHistory: entries, totalCount };
}
/**
 * Get engine-internal state diagnostics (synchronous).
 *
 * @returns Lock state, visibility, auth validation status
 */
export function getEngineDiagnostics() {
    const engineState = _getEngineDiagnostics();
    return {
        isTabVisible: engineState.isTabVisible,
        tabHiddenAt: engineState.tabHiddenAt ? new Date(engineState.tabHiddenAt).toISOString() : null,
        lockHeld: engineState.lockHeld,
        lockHeldForMs: engineState.lockHeldForMs,
        recentlyModifiedCount: engineState.recentlyModifiedCount,
        wasOffline: engineState.wasOffline,
        authValidatedAfterReconnect: engineState.authValidatedAfterReconnect
    };
}
/**
 * Get network connectivity diagnostics (synchronous).
 *
 * @returns Current online/offline status
 */
export function getNetworkDiagnostics() {
    return {
        online: get(isOnline)
    };
}
/**
 * Get error state diagnostics (synchronous).
 *
 * @returns Latest error info and recent error history
 */
export function getErrorDiagnostics() {
    const syncState = get(syncStatusStore);
    return {
        lastError: syncState.lastError,
        lastErrorDetails: syncState.lastErrorDetails,
        recentErrors: syncState.syncErrors
    };
}
//# sourceMappingURL=diagnostics.js.map