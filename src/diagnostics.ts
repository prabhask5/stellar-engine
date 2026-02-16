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
import { isCRDTEnabled, getCRDTConfig } from './crdt/config';
import { getActiveProviderEntries } from './crdt/provider';
import { getOfflineDocuments, loadPendingUpdates } from './crdt/store';
import { getCollaborators } from './crdt/awareness';
import type { ConflictHistoryEntry, SyncStatus } from './types';
import type { RealtimeConnectionState } from './realtime';
import type { SyncError } from './stores/sync';
import { encodeStateAsUpdate } from 'yjs';
import type { CRDTConnectionState } from './crdt/types';

// =============================================================================
// Types
// =============================================================================

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
    byTable: Record<
      string,
      { bytes: number; formatted: string; records: number; percentage: string }
    >;
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
export async function getDiagnostics(): Promise<DiagnosticsSnapshot> {
  const config = getEngineConfig();
  const engineState = _getEngineDiagnostics();
  const realtimeState = _getRealtimeDiagnostics();
  const syncState = get(syncStatusStore);

  // Run async operations in parallel
  const [queueData, conflictData, crdtData] = await Promise.all([
    getQueueDiagnostics(),
    getConflictDiagnostics(),
    getCRDTDiagnostics()
  ]);

  // Build egress section with formatted values
  const egressByTable: DiagnosticsSnapshot['egress']['byTable'] = {};
  for (const [table, stats] of Object.entries(engineState.egressStats.byTable)) {
    const pct =
      engineState.egressStats.totalBytes > 0
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
  const cyclesLastMinute = engineState.syncStats.filter(
    (s) => new Date(s.timestamp).getTime() > oneMinuteAgo
  ).length;

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

    crdt: crdtData,

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
// CRDT Diagnostics
// =============================================================================

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
export async function getCRDTDiagnostics(): Promise<DiagnosticsSnapshot['crdt']> {
  if (!isCRDTEnabled()) {
    return {
      enabled: false,
      config: null,
      activeDocuments: [],
      activeDocumentCount: 0,
      offline: {
        documentCount: 0,
        maxDocuments: 0,
        totalSizeBytes: 0,
        totalSizeFormatted: '0 B',
        documents: []
      },
      pendingUpdates: [],
      totalPendingUpdates: 0
    };
  }

  const config = getCRDTConfig();

  /* Gather active document diagnostics. */
  const activeDocuments: DiagnosticsSnapshot['crdt']['activeDocuments'] = [];
  const entries = getActiveProviderEntries();

  /* Collect documentIds for pending update queries. */
  const activeDocumentIds: string[] = [];

  for (const [documentId, provider] of entries) {
    activeDocumentIds.push(documentId);

    /* Get Y.Doc state size (encode to measure byte length). */
    const state = encodeStateAsUpdate(provider.doc);
    const stateSizeBytes = state.byteLength;

    /* Get collaborators for this document. */
    const collaborators = getCollaborators(documentId);

    activeDocuments.push({
      documentId: provider.documentId,
      pageId: provider.pageId,
      connectionState: provider.connectionState,
      isDirty: provider.isDirty,
      stateSizeBytes,
      stateSizeFormatted: formatBytes(stateSizeBytes),
      collaboratorCount: collaborators.length,
      collaboratorNames: collaborators.map((c) => c.name)
    });
  }

  /* Gather pending updates for each active document. */
  const pendingUpdatesResults = await Promise.all(
    activeDocumentIds.map(async (documentId) => {
      const updates = await loadPendingUpdates(documentId);
      return { documentId, updateCount: updates.length };
    })
  );
  const pendingUpdates = pendingUpdatesResults.filter((p) => p.updateCount > 0);
  const totalPendingUpdates = pendingUpdates.reduce((sum, p) => sum + p.updateCount, 0);

  /* Gather offline document diagnostics. */
  const offlineDocs = await getOfflineDocuments();
  let offlineTotalSize = 0;

  const offlineDocDetails = offlineDocs.map((doc) => {
    offlineTotalSize += doc.stateSize;
    return {
      documentId: doc.documentId,
      pageId: doc.pageId,
      stateSizeBytes: doc.stateSize,
      stateSizeFormatted: formatBytes(doc.stateSize),
      localUpdatedAt: doc.localUpdatedAt,
      lastPersistedAt: doc.lastPersistedAt,
      syncedWithRemote: doc.lastPersistedAt !== null && doc.lastPersistedAt >= doc.localUpdatedAt
    };
  });

  return {
    enabled: true,
    config: {
      supabaseTable: config.supabaseTable,
      persistIntervalMs: config.persistIntervalMs,
      broadcastDebounceMs: config.broadcastDebounceMs,
      localSaveDebounceMs: config.localSaveDebounceMs,
      cursorDebounceMs: config.cursorDebounceMs,
      maxOfflineDocuments: config.maxOfflineDocuments,
      maxBroadcastPayloadBytes: config.maxBroadcastPayloadBytes,
      syncPeerTimeoutMs: config.syncPeerTimeoutMs,
      maxReconnectAttempts: config.maxReconnectAttempts,
      reconnectBaseDelayMs: config.reconnectBaseDelayMs
    },
    activeDocuments,
    activeDocumentCount: activeDocuments.length,
    offline: {
      documentCount: offlineDocs.length,
      maxDocuments: config.maxOfflineDocuments,
      totalSizeBytes: offlineTotalSize,
      totalSizeFormatted: formatBytes(offlineTotalSize),
      documents: offlineDocDetails
    },
    pendingUpdates,
    totalPendingUpdates
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
export function getSyncDiagnostics(): Pick<DiagnosticsSnapshot, 'sync' | 'egress'> {
  const engineState = _getEngineDiagnostics();
  const syncState = get(syncStatusStore);

  const egressByTable: DiagnosticsSnapshot['egress']['byTable'] = {};
  for (const [table, stats] of Object.entries(engineState.egressStats.byTable)) {
    const pct =
      engineState.egressStats.totalBytes > 0
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
  const cyclesLastMinute = engineState.syncStats.filter(
    (s) => new Date(s.timestamp).getTime() > oneMinuteAgo
  ).length;

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
export async function getQueueDiagnostics(): Promise<DiagnosticsSnapshot['queue']> {
  const pending = await getPendingSync();
  const entityIds = await getPendingEntityIds();

  // Breakdown by table
  const byTable: Record<string, number> = {};
  const byOperationType: Record<string, number> = {};
  let oldestTimestamp: string | null = null;
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
export async function getConflictDiagnostics(): Promise<{
  recentHistory: ConflictHistoryEntry[];
  totalCount: number;
}> {
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
