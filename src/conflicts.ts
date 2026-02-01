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

import { debugLog, debugWarn, debugError } from './debug';
import { getEngineConfig } from './config';
import { getDeviceId } from './deviceId';
import type { SyncOperationItem } from './types';
import type { ConflictHistoryEntry } from './types';

// Re-export for convenience
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
 * Get excluded fields for a given entity type.
 * Combines the default excluded fields with any per-table excludeFromConflict config.
 */
function getExcludedFields(entityType: string): Set<string> {
  const defaultExcluded = new Set(['id', 'user_id', 'created_at', '_version']);
  const tableConfig = getEngineConfig().tables.find(t => t.supabaseName === entityType);
  return new Set([...defaultExcluded, ...(tableConfig?.excludeFromConflict || [])]);
}

/**
 * Get numeric merge fields for a given entity type from per-table config.
 */
function getNumericMergeFields(entityType: string): Set<string> {
  const tableConfig = getEngineConfig().tables.find(t => t.supabaseName === entityType);
  return new Set(tableConfig?.numericMergeFields || []);
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
export async function resolveConflicts(
  entityType: string,
  entityId: string,
  local: Record<string, unknown> | null,
  remote: Record<string, unknown>,
  pendingOps: SyncOperationItem[]
): Promise<ConflictResolution> {
  const timestamp = new Date().toISOString();
  const fieldResolutions: FieldConflictResolution[] = [];
  const deviceId = getDeviceId();

  // If no local entity, remote wins entirely (no conflict)
  if (!local) {
    return {
      entityId,
      entityType,
      localUpdatedAt: '',
      remoteUpdatedAt: remote.updated_at as string,
      fieldResolutions: [],
      mergedEntity: { ...remote },
      hasConflicts: false,
      timestamp
    };
  }

  const localUpdatedAt = local.updated_at as string;
  const remoteUpdatedAt = remote.updated_at as string;

  // Start with remote as base (since it's newer if we're processing it)
  const mergedEntity: Record<string, unknown> = { ...remote };

  // Get all unique fields from both entities
  const allFields = new Set([...Object.keys(local), ...Object.keys(remote)]);

  // Check for pending operations on specific fields
  const pendingFieldOps = new Map<string, SyncOperationItem[]>();
  for (const op of pendingOps) {
    if (op.field) {
      const existing = pendingFieldOps.get(op.field) || [];
      existing.push(op);
      pendingFieldOps.set(op.field, existing);
    } else if (op.operationType === 'set' && typeof op.value === 'object' && op.value !== null) {
      // Multi-field set operation - extract fields
      for (const field of Object.keys(op.value as Record<string, unknown>)) {
        const existing = pendingFieldOps.get(field) || [];
        existing.push(op);
        pendingFieldOps.set(field, existing);
      }
    }
  }

  // Check if there's a pending delete
  const hasPendingDelete = pendingOps.some((op) => op.operationType === 'delete');

  // If there's a pending delete locally, local delete wins
  if (hasPendingDelete && !remote.deleted) {
    mergedEntity.deleted = true;
    fieldResolutions.push({
      field: 'deleted',
      localValue: true,
      remoteValue: remote.deleted,
      resolvedValue: true,
      winner: 'local',
      strategy: 'local_pending'
    });
  }

  // If remote is deleted but local has pending edits, delete still wins
  // (This prevents resurrection of deleted entities)
  if (remote.deleted && !hasPendingDelete) {
    // Remote delete wins - entity should stay deleted
    return {
      entityId,
      entityType,
      localUpdatedAt,
      remoteUpdatedAt,
      fieldResolutions: [
        {
          field: 'deleted',
          localValue: local.deleted,
          remoteValue: true,
          resolvedValue: true,
          winner: 'remote',
          strategy: 'delete_wins'
        }
      ],
      mergedEntity: { ...remote },
      hasConflicts: true,
      timestamp
    };
  }

  // Get config-driven field sets for this entity type
  const excludedFields = getExcludedFields(entityType);
  const numericMergeFields = getNumericMergeFields(entityType);

  // Process each field
  for (const field of allFields) {
    if (excludedFields.has(field)) continue;
    if (field === 'deleted' && hasPendingDelete) continue; // Already handled

    const localValue = local[field];
    const remoteValue = remote[field];

    // If values are equal, no conflict
    if (valuesEqual(localValue, remoteValue)) {
      continue;
    }

    // Check for pending operations on this field
    const fieldOps = pendingFieldOps.get(field) || [];
    const hasPendingOps = fieldOps.length > 0;

    // Determine resolution strategy
    let resolution: FieldConflictResolution;

    if (hasPendingOps) {
      // Tier 3a: Field has pending local operations - local wins
      resolution = {
        field,
        localValue,
        remoteValue,
        resolvedValue: localValue,
        winner: 'local',
        strategy: 'local_pending'
      };
      mergedEntity[field] = localValue;
    } else if (numericMergeFields.has(field) && canNumericMerge(local, remote, field)) {
      // Tier 3b: Numeric field that could theoretically be merged
      // For now, use last-write-wins since we only have final values, not operation deltas
      // True numeric merge (e.g., +50 + +30 = +80) would require an operation inbox system
      resolution = resolveByTimestamp(
        field,
        local,
        remote,
        localUpdatedAt,
        remoteUpdatedAt,
        deviceId
      );
      mergedEntity[field] = resolution.resolvedValue;
    } else {
      // Tier 3c: Last-write-wins with timestamp comparison
      resolution = resolveByTimestamp(
        field,
        local,
        remote,
        localUpdatedAt,
        remoteUpdatedAt,
        deviceId
      );
      mergedEntity[field] = resolution.resolvedValue;
    }

    fieldResolutions.push(resolution);
  }

  // If there were field-level resolutions, we need to update the version
  if (fieldResolutions.length > 0) {
    const localVersion = typeof local._version === 'number' ? local._version : 1;
    const remoteVersion = typeof remote._version === 'number' ? remote._version : 1;
    mergedEntity._version = Math.max(localVersion, remoteVersion) + 1;
  }

  // Update updated_at to the later of the two
  if (localUpdatedAt > remoteUpdatedAt) {
    mergedEntity.updated_at = localUpdatedAt;
  }

  return {
    entityId,
    entityType,
    localUpdatedAt,
    remoteUpdatedAt,
    fieldResolutions,
    mergedEntity,
    hasConflicts: fieldResolutions.length > 0,
    timestamp
  };
}

/**
 * Resolve a field conflict using last-write-wins strategy.
 * Uses deviceId as deterministic tiebreaker when timestamps are equal.
 */
function resolveByTimestamp(
  field: string,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  localUpdatedAt: string,
  remoteUpdatedAt: string,
  localDeviceId: string
): FieldConflictResolution {
  const localValue = local[field];
  const remoteValue = remote[field];

  // Compare timestamps
  const localTime = new Date(localUpdatedAt).getTime();
  const remoteTime = new Date(remoteUpdatedAt).getTime();

  let winner: 'local' | 'remote';
  let resolvedValue: unknown;

  if (localTime > remoteTime) {
    winner = 'local';
    resolvedValue = localValue;
  } else if (remoteTime > localTime) {
    winner = 'remote';
    resolvedValue = remoteValue;
  } else {
    // Timestamps are equal - use deviceId as deterministic tiebreaker
    // Lower deviceId wins (arbitrary but consistent across all devices)
    const remoteDeviceId = (remote.device_id as string) || '';

    if (remoteDeviceId && localDeviceId < remoteDeviceId) {
      winner = 'local';
      resolvedValue = localValue;
    } else if (remoteDeviceId && localDeviceId > remoteDeviceId) {
      winner = 'remote';
      resolvedValue = remoteValue;
    } else {
      // Same device or no remote device_id - local wins (it's the more recent action)
      winner = 'local';
      resolvedValue = localValue;
    }
  }

  return {
    field,
    localValue,
    remoteValue,
    resolvedValue,
    winner,
    strategy: 'last_write'
  };
}

/**
 * Check if two values are equal (deep comparison for objects/arrays).
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => valuesEqual(val, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      valuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
  }

  return false;
}

/**
 * Check if a numeric field can be merged (both sides have numeric values).
 */
function canNumericMerge(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  field: string
): boolean {
  return typeof local[field] === 'number' && typeof remote[field] === 'number';
}

/**
 * Store conflict resolution history for review/undo.
 *
 * @param resolution The conflict resolution result
 */
export async function storeConflictHistory(resolution: ConflictResolution): Promise<void> {
  if (!resolution.hasConflicts) return;

  try {
    const entries: ConflictHistoryEntry[] = resolution.fieldResolutions.map((fr) => ({
      entityId: resolution.entityId,
      entityType: resolution.entityType,
      field: fr.field,
      localValue: fr.localValue,
      remoteValue: fr.remoteValue,
      resolvedValue: fr.resolvedValue,
      winner: fr.winner,
      strategy: fr.strategy,
      timestamp: resolution.timestamp
    }));

    await getEngineConfig().db.table('conflictHistory').bulkAdd(entries);
  } catch (error) {
    debugError('[Conflict] Failed to store conflict history:', error);
  }
}

/**
 * Get pending operations for a specific entity from the sync queue.
 *
 * @param entityId The entity ID to check
 * @returns Array of pending operations for this entity
 */
export async function getPendingOpsForEntity(entityId: string): Promise<SyncOperationItem[]> {
  const allPending = await getEngineConfig().db.table('syncQueue').where('entityId').equals(entityId).toArray();
  return allPending as unknown as SyncOperationItem[];
}

/**
 * Clean up old conflict history entries (older than 30 days).
 */
export async function cleanupConflictHistory(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);
  const cutoffStr = cutoffDate.toISOString();

  try {
    const count = await getEngineConfig().db.table('conflictHistory').filter((entry: ConflictHistoryEntry) => entry.timestamp < cutoffStr).delete();

    if (count > 0) {
      debugLog(`[Conflict] Cleaned up ${count} old conflict history entries`);
    }

    return count;
  } catch (error) {
    debugError('[Conflict] Failed to cleanup conflict history:', error);
    return 0;
  }
}

/**
 * Get recent conflict history for an entity.
 *
 * @param entityId The entity ID to check
 * @param limit Maximum number of entries to return
 * @returns Array of conflict history entries
 */
export async function getConflictHistory(
  entityId: string,
  limit: number = 10
): Promise<ConflictHistoryEntry[]> {
  const entries = await getEngineConfig().db.table('conflictHistory')
    .where('entityId')
    .equals(entityId)
    .reverse()
    .limit(limit)
    .toArray();

  return entries;
}
