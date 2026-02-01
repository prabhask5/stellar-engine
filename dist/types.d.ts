/**
 * Intent-Based Sync Operation Types
 *
 * These types enable preserving operation intent (e.g., "increment by 1")
 * rather than just final state (e.g., "current_value: 50").
 *
 * Benefits:
 * - Rapid increments are coalesced locally (50 +1s -> single +50) reducing sync traffic
 * - Pending operations are protected during conflict resolution
 *
 * Note: True numeric merge across devices (e.g., +50 + +30 = +80) is not implemented.
 * Operations are converted to final values before pushing to Supabase, so conflicts
 * use last-write-wins. Full numeric merge would require an operation inbox system.
 */
/**
 * Operation types that preserve intent:
 * - 'increment': Add delta to numeric field (e.g., current_value += 1)
 * - 'set': Set field to value (works for any type)
 * - 'create': Create new entity
 * - 'delete': Soft delete entity
 */
export type OperationType = 'increment' | 'set' | 'create' | 'delete';
/**
 * Intent-based sync operation item.
 *
 * Key design:
 * - Uses `operationType` to specify the operation intent
 * - Has optional `field` for field-level operations
 * - `value` is the delta (for increment) or new value (for set/create)
 *
 * For create operations, value contains the full entity payload.
 * For increment operations, value contains the delta to add.
 * For set operations, value contains the new field value(s).
 * For delete operations, value is not used.
 */
export interface SyncOperationItem {
    id?: number;
    table: string;
    entityId: string;
    operationType: OperationType;
    field?: string;
    value?: unknown;
    timestamp: string;
    retries: number;
}
/**
 * Type guard to check if an item is a SyncOperationItem
 */
export declare function isOperationItem(item: unknown): item is SyncOperationItem;
export interface OfflineCredentials {
    id: string;
    userId: string;
    email: string;
    password: string;
    profile: Record<string, unknown>;
    cachedAt: string;
}
export interface OfflineSession {
    id: string;
    userId: string;
    offlineToken: string;
    createdAt: string;
}
/**
 * Conflict history entry (stored in IndexedDB)
 * Records field-level conflict resolutions for review and potential undo
 */
export interface ConflictHistoryEntry {
    id?: number;
    entityId: string;
    entityType: string;
    field: string;
    localValue: unknown;
    remoteValue: unknown;
    resolvedValue: unknown;
    winner: 'local' | 'remote' | 'merged';
    strategy: string;
    timestamp: string;
}
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';
export type AuthMode = 'supabase' | 'offline' | 'none';
//# sourceMappingURL=types.d.ts.map