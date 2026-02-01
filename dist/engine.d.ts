/**
 * Clear all pending sync operations (used when auth is invalid)
 * SECURITY: Called when offline credentials are found to be invalid
 * to prevent unauthorized data from being synced to the server
 */
export declare function clearPendingSyncQueue(): Promise<number>;
/**
 * Mark that we need auth validation before next sync
 * Called when going offline
 */
export declare function markOffline(): void;
/**
 * Mark auth as validated (safe to sync)
 * Called after successful credential validation on reconnect
 */
export declare function markAuthValidated(): void;
/**
 * Check if auth needs validation before syncing
 */
export declare function needsAuthValidation(): boolean;
export declare function markEntityModified(entityId: string): void;
export declare function onSyncComplete(callback: () => void): () => void;
export declare function scheduleSyncPush(): void;
/**
 * Reset the sync cursor to force a full sync on next sync cycle.
 * This is useful when data is out of sync between devices.
 */
export declare function resetSyncCursor(): Promise<void>;
/**
 * Force a full sync by resetting the cursor and running sync.
 * This clears local data and re-downloads everything from the server.
 */
export declare function forceFullSync(): Promise<void>;
export declare function getPushErrors(): {
    message: string;
    table: string;
    operation: string;
    entityId: string;
}[];
export declare function runFullSync(quiet?: boolean, skipPull?: boolean): Promise<void>;
/**
 * Reconcile orphaned local changes with remote.
 *
 * After re-login, local IndexedDB may have items that were modified offline
 * but whose sync queue entries were lost (e.g. cleared by a previous bug).
 * This scans all tables for items modified after the last sync cursor and
 * re-queues them so they get pushed on the next sync.
 *
 * Only runs when the sync queue is empty (otherwise normal sync handles it).
 */
export declare function reconcileLocalWithRemote(): Promise<number>;
export declare function hydrateFromRemote(): Promise<void>;
export declare function debugTombstones(options?: {
    cleanup?: boolean;
    force?: boolean;
}): Promise<void>;
export declare function startSyncEngine(): Promise<void>;
export declare function stopSyncEngine(): Promise<void>;
export declare function clearLocalCache(): Promise<void>;
export declare function performSync(): Promise<void>;
declare function initDebugSyncUtilities(): void;
export { initDebugSyncUtilities };
//# sourceMappingURL=engine.d.ts.map