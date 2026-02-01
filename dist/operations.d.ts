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
export declare function operationToMutation(operation: SyncOperationItem, currentValue?: unknown): {
    mutationType: 'insert' | 'update' | 'delete';
    payload: Record<string, unknown>;
};
/**
 * Infer the appropriate operation type based on the value and field name.
 *
 * @param value The value being set
 * @param fieldName The name of the field
 * @param isIncrement Whether this is a known increment operation
 * @returns The inferred operation type
 */
export declare function inferOperationType(_value: unknown, _fieldName: string, isIncrement?: boolean): OperationType;
/**
 * Create an increment operation item.
 */
export declare function createIncrementOperation(table: string, entityId: string, field: string, delta: number, timestamp: string): SyncOperationItem;
/**
 * Create a set operation item for a single field.
 */
export declare function createSetOperation(table: string, entityId: string, field: string, value: unknown, timestamp: string): SyncOperationItem;
/**
 * Create a set operation item for multiple fields.
 */
export declare function createMultiFieldSetOperation(table: string, entityId: string, fields: Record<string, unknown>, timestamp: string): SyncOperationItem;
/**
 * Create a create operation item.
 */
export declare function createCreateOperation(table: string, entityId: string, payload: Record<string, unknown>, timestamp: string): SyncOperationItem;
/**
 * Create a delete operation item.
 */
export declare function createDeleteOperation(table: string, entityId: string, timestamp: string): SyncOperationItem;
/**
 * Check if two operations can be coalesced together.
 *
 * Coalescing rules:
 * - Same table + entityId + operationType can be coalesced
 * - Increment operations: can be coalesced if same field (sums deltas)
 * - Set operations: can be coalesced (keeps merged/latest values)
 * - Create/delete: cannot coalesce (would lose intent)
 */
export declare function canCoalesce(a: SyncOperationItem, b: SyncOperationItem): boolean;
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
export declare function coalesceOperations(older: SyncOperationItem, newer: SyncOperationItem): SyncOperationItem;
//# sourceMappingURL=operations.d.ts.map