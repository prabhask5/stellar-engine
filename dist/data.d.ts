/**
 * Generic CRUD and Query Operations
 *
 * Replaces repository infrastructure boilerplate.
 * Uses Supabase table names as the API surface, internally resolves to Dexie table names.
 */
/**
 * Create a new entity. Auto: transaction + queue + markModified + schedulePush.
 * Caller provides all fields including id, timestamps, etc.
 */
export declare function engineCreate(table: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
/**
 * Update an entity's fields. Auto-sets updated_at, queues sync, marks modified.
 */
export declare function engineUpdate(table: string, id: string, fields: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
/**
 * Soft-delete an entity. Sets deleted=true, queues delete op.
 */
export declare function engineDelete(table: string, id: string): Promise<void>;
export type BatchOperation = {
    type: 'create';
    table: string;
    data: Record<string, unknown>;
} | {
    type: 'update';
    table: string;
    id: string;
    fields: Record<string, unknown>;
} | {
    type: 'delete';
    table: string;
    id: string;
};
/**
 * Execute multiple write operations in a single atomic transaction.
 * All ops succeed or all roll back.
 */
export declare function engineBatchWrite(operations: BatchOperation[]): Promise<void>;
/**
 * Increment a numeric field on an entity, preserving increment intent for conflict resolution.
 * Uses increment operationType in the sync queue so multi-device increments are additive.
 * Optionally sets additional fields (e.g., completed, updated_at) alongside the increment.
 */
export declare function engineIncrement(table: string, id: string, field: string, amount: number, additionalFields?: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
/**
 * Get a single entity by ID. Optional remote fallback if not found locally.
 */
export declare function engineGet(table: string, id: string, opts?: {
    remoteFallback?: boolean;
}): Promise<Record<string, unknown> | null>;
/**
 * Get all entities from a table. Optional ordering and remote fallback.
 */
export declare function engineGetAll(table: string, opts?: {
    orderBy?: string;
    remoteFallback?: boolean;
}): Promise<Record<string, unknown>[]>;
/**
 * Query entities by index value (WHERE index = value).
 */
export declare function engineQuery(table: string, index: string, value: unknown, opts?: {
    remoteFallback?: boolean;
}): Promise<Record<string, unknown>[]>;
/**
 * Range query (WHERE index BETWEEN lower AND upper).
 */
export declare function engineQueryRange(table: string, index: string, lower: unknown, upper: unknown, opts?: {
    remoteFallback?: boolean;
}): Promise<Record<string, unknown>[]>;
/**
 * Singleton get-or-create with optional remote check.
 * Used for patterns like focus_settings where one record per user exists.
 */
export declare function engineGetOrCreate(table: string, index: string, value: unknown, defaults: Record<string, unknown>, opts?: {
    checkRemote?: boolean;
}): Promise<Record<string, unknown>>;
//# sourceMappingURL=data.d.ts.map