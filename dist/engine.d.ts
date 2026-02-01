/**
 * Clear all pending sync operations (used when auth is invalid)
 * SECURITY: Called when offline credentials are found to be invalid
 * to prevent unauthorized data from being synced to the server
 */
export declare function clearPendingSyncQueue(): Promise<number>;
export declare function markEntityModified(entityId: string): void;
export declare function onSyncComplete(callback: () => void): () => void;
export declare function scheduleSyncPush(): void;
export declare function runFullSync(quiet?: boolean, skipPull?: boolean): Promise<void>;
export declare function startSyncEngine(): Promise<void>;
export declare function stopSyncEngine(): Promise<void>;
export declare function clearLocalCache(): Promise<void>;
//# sourceMappingURL=engine.d.ts.map