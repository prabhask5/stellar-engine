/**
 * Sync Operation Helpers
 *
 * Provides utilities for:
 * - Transforming operations to Supabase mutations
 * - Creating operation items
 * - Operation coalescing logic
 */

import type { SyncOperationItem, OperationType } from './types';

/**
 * Transform a SyncOperationItem into a Supabase mutation payload.
 * This is called by the sync engine when pushing to Supabase.
 *
 * @param operation The operation to transform
 * @param currentValue The current value of the field (needed for increment operations)
 * @returns The payload to send to Supabase
 */
export function operationToMutation(
  operation: SyncOperationItem,
  currentValue?: unknown
): { mutationType: 'insert' | 'update' | 'delete'; payload: Record<string, unknown> } {
  switch (operation.operationType) {
    case 'create':
      return {
        mutationType: 'insert',
        payload: {
          id: operation.entityId,
          ...(operation.value as Record<string, unknown>)
        }
      };

    case 'delete':
      return {
        mutationType: 'update',
        payload: {
          deleted: true,
          updated_at: operation.timestamp
        }
      };

    case 'increment': {
      // For increment, we need to compute the new value
      // currentValue should be provided by the caller from the local entity
      const base = typeof currentValue === 'number' ? currentValue : 0;
      const delta = typeof operation.value === 'number' ? operation.value : 0;
      const newValue = base + delta;

      if (!operation.field) {
        throw new Error('Increment operation requires a field');
      }

      return {
        mutationType: 'update',
        payload: {
          [operation.field]: newValue,
          updated_at: operation.timestamp
        }
      };
    }

    case 'set': {
      // For set, we either have a single field or a full payload
      if (operation.field) {
        // Single field set
        return {
          mutationType: 'update',
          payload: {
            [operation.field]: operation.value,
            updated_at: operation.timestamp
          }
        };
      } else {
        // Full payload set
        return {
          mutationType: 'update',
          payload: {
            ...(operation.value as Record<string, unknown>),
            updated_at: operation.timestamp
          }
        };
      }
    }

    default:
      throw new Error(`Unknown operation type: ${(operation as SyncOperationItem).operationType}`);
  }
}

/**
 * Infer the appropriate operation type based on the value and field name.
 *
 * @param value The value being set
 * @param fieldName The name of the field
 * @param isIncrement Whether this is a known increment operation
 * @returns The inferred operation type
 */
export function inferOperationType(
  _value: unknown,
  _fieldName: string,
  isIncrement?: boolean
): OperationType {
  if (isIncrement) {
    return 'increment';
  }

  // All non-increment operations are 'set'
  return 'set';
}

/**
 * Create an increment operation item.
 */
export function createIncrementOperation(
  table: string,
  entityId: string,
  field: string,
  delta: number,
  timestamp: string
): SyncOperationItem {
  return {
    table,
    entityId,
    operationType: 'increment',
    field,
    value: delta,
    timestamp,
    retries: 0
  };
}

/**
 * Create a set operation item for a single field.
 */
export function createSetOperation(
  table: string,
  entityId: string,
  field: string,
  value: unknown,
  timestamp: string
): SyncOperationItem {
  return {
    table,
    entityId,
    operationType: 'set',
    field,
    value,
    timestamp,
    retries: 0
  };
}

/**
 * Create a set operation item for multiple fields.
 */
export function createMultiFieldSetOperation(
  table: string,
  entityId: string,
  fields: Record<string, unknown>,
  timestamp: string
): SyncOperationItem {
  return {
    table,
    entityId,
    operationType: 'set',
    value: fields,
    timestamp,
    retries: 0
  };
}

/**
 * Create a create operation item.
 */
export function createCreateOperation(
  table: string,
  entityId: string,
  payload: Record<string, unknown>,
  timestamp: string
): SyncOperationItem {
  return {
    table,
    entityId,
    operationType: 'create',
    value: payload,
    timestamp,
    retries: 0
  };
}

/**
 * Create a delete operation item.
 */
export function createDeleteOperation(
  table: string,
  entityId: string,
  timestamp: string
): SyncOperationItem {
  return {
    table,
    entityId,
    operationType: 'delete',
    timestamp,
    retries: 0
  };
}

/**
 * Check if two operations can be coalesced together.
 *
 * Coalescing rules:
 * - Same table + entityId + operationType can be coalesced
 * - Increment operations: can be coalesced if same field (sums deltas)
 * - Set operations: can be coalesced (keeps merged/latest values)
 * - Create/delete: cannot coalesce (would lose intent)
 */
export function canCoalesce(a: SyncOperationItem, b: SyncOperationItem): boolean {
  if (a.table !== b.table || a.entityId !== b.entityId) {
    return false;
  }

  // Same operation type on same field can be coalesced
  if (a.operationType === b.operationType) {
    // Create and delete cannot coalesce (would lose intent)
    if (a.operationType === 'create' || a.operationType === 'delete') {
      return false;
    }

    // For increment operations, must be same field
    if (a.operationType === 'increment') {
      // Both must have a field specified
      if (!a.field || !b.field) {
        return false;
      }
      // Must be the same field
      return a.field === b.field;
    }

    // For set operations with a specific field, must be same field
    if (a.field && b.field && a.field !== b.field) {
      return false;
    }

    return true;
  }

  return false;
}

/**
 * Coalesce two operations into one.
 *
 * Coalescing strategy by operation type:
 * - Increment: sum the deltas (e.g., +1 and +1 = +2)
 * - Set: keep the newer value (last-write-wins)
 *
 * @param older The older operation
 * @param newer The newer operation
 * @returns The coalesced operation
 */
export function coalesceOperations(
  older: SyncOperationItem,
  newer: SyncOperationItem
): SyncOperationItem {
  // For increment operations: sum the deltas
  if (older.operationType === 'increment' && newer.operationType === 'increment') {
    const olderDelta = typeof older.value === 'number' ? older.value : 0;
    const newerDelta = typeof newer.value === 'number' ? newer.value : 0;
    const summedDelta = olderDelta + newerDelta;

    return {
      ...older,
      // Keep older's id and timestamp for queue management and backoff
      value: summedDelta
    };
  }

  // For set operations: keep the newer value but preserve older's id/timestamp
  return {
    ...newer,
    id: older.id,
    // Keep oldest timestamp for backoff calculation
    timestamp: older.timestamp
  };
}
