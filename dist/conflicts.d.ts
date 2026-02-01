/**
 * Conflict Resolution Engine
 *
 * Implements three-tier conflict resolution for multi-device sync:
 *
 * Tier 1: Non-overlapping (different entities) → AUTO-MERGE
 * Tier 2: Different fields → AUTO-MERGE FIELDS
 * Tier 3: Same field → Apply resolution strategy
 *
 * Resolution strategies for Tier 3:
 * - Numeric fields with pending increments: Merge (sum deltas)
 * - Delete operations: Delete wins over edits
 * - All other cases: Last-write-wins (with deviceId tiebreaker)
 */
import type { SyncOperationItem } from './types';
import type { ConflictHistoryEntry } from './types';
export type { ConflictHistoryEntry };
/**
 * Conflict resolution result for a single field
 */
export interface FieldConflictResolution {
    field: string;
    localValue: unknown;
    remoteValue: unknown;
    resolvedValue: unknown;
    winner: 'local' | 'remote' | 'merged';
    strategy: 'last_write' | 'numeric_merge' | 'delete_wins' | 'local_pending';
}
/**
 * Full conflict resolution result for an entity
 */
export interface ConflictResolution {
    entityId: string;
    entityType: string;
    localUpdatedAt: string;
    remoteUpdatedAt: string;
    fieldResolutions: FieldConflictResolution[];
    mergedEntity: Record<string, unknown>;
    hasConflicts: boolean;
    timestamp: string;
}
/**
 * Resolve conflicts between local and remote entity states.
 *
 * @param entityType The type of entity (table name)
 * @param entityId The entity's ID
 * @param local The local entity state (may be null if entity doesn't exist locally)
 * @param remote The remote entity state
 * @param pendingOps Pending operations for this entity from the sync queue
 * @returns The merged entity with conflict resolution applied
 */
export declare function resolveConflicts(entityType: string, entityId: string, local: Record<string, unknown> | null, remote: Record<string, unknown>, pendingOps: SyncOperationItem[]): Promise<ConflictResolution>;
/**
 * Store conflict resolution history for review/undo.
 *
 * @param resolution The conflict resolution result
 */
export declare function storeConflictHistory(resolution: ConflictResolution): Promise<void>;
/**
 * Get pending operations for a specific entity from the sync queue.
 *
 * @param entityId The entity ID to check
 * @returns Array of pending operations for this entity
 */
export declare function getPendingOpsForEntity(entityId: string): Promise<SyncOperationItem[]>;
/**
 * Clean up old conflict history entries (older than 30 days).
 */
export declare function cleanupConflictHistory(): Promise<number>;
/**
 * Get recent conflict history for an entity.
 *
 * @param entityId The entity ID to check
 * @param limit Maximum number of entries to return
 * @returns Array of conflict history entries
 */
export declare function getConflictHistory(entityId: string, limit?: number): Promise<ConflictHistoryEntry[]>;
//# sourceMappingURL=conflicts.d.ts.map