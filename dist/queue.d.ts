import type { SyncOperationItem } from './types';
/**
 * Coalesce multiple operations to the same entity into fewer operations.
 * This dramatically reduces the number of server requests and data transfer.
 *
 * PERFORMANCE OPTIMIZED:
 * - Single DB fetch at start (no re-fetching between phases)
 * - All processing done in memory
 * - Batch deletes and updates at the end
 */
export declare function coalescePendingOps(): Promise<number>;
export declare function getPendingSync(): Promise<SyncOperationItem[]>;
export declare function cleanupFailedItems(): Promise<{
    count: number;
    tables: string[];
}>;
export declare function removeSyncItem(id: number): Promise<void>;
export declare function incrementRetry(id: number): Promise<void>;
export declare function getPendingEntityIds(): Promise<Set<string>>;
/**
 * Queue a sync operation using the intent-based format.
 */
export declare function queueSyncOperation(item: Omit<SyncOperationItem, 'id' | 'timestamp' | 'retries'>): Promise<void>;
/**
 * Helper to queue an increment operation.
 */
export declare function queueIncrementOperation(table: string, entityId: string, field: string, delta: number): Promise<void>;
/**
 * Helper to queue a set operation for a single field.
 */
export declare function queueSetOperation(table: string, entityId: string, field: string, value: unknown): Promise<void>;
/**
 * Helper to queue a set operation for multiple fields.
 */
export declare function queueMultiFieldSetOperation(table: string, entityId: string, fields: Record<string, unknown>): Promise<void>;
/**
 * Helper to queue a create operation.
 */
export declare function queueCreateOperation(table: string, entityId: string, payload: Record<string, unknown>): Promise<void>;
/**
 * Helper to queue a delete operation.
 */
export declare function queueDeleteOperation(table: string, entityId: string): Promise<void>;
//# sourceMappingURL=queue.d.ts.map