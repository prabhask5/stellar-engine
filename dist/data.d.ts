/**
 * @fileoverview Generic CRUD and Query Operations for the Stellar Sync Engine
 *
 * This module serves as the primary data access layer for the sync engine,
 * replacing per-entity repository boilerplate with a unified, table-driven API.
 *
 * Architecture:
 * - Callers reference tables by their **Supabase** name (the remote/canonical name).
 * - Internally, every operation resolves that name to the corresponding **Dexie**
 *   (IndexedDB) table name via the configured table map.
 * - All write operations (create, update, delete, increment, batch) follow the
 *   same transactional pattern:
 *     1. Open a Dexie read-write transaction spanning the target table + syncQueue.
 *     2. Apply the mutation locally.
 *     3. Enqueue the corresponding sync operation for eventual push to Supabase.
 *     4. After commit, mark the entity as modified and schedule a sync push.
 * - All read operations query Dexie first, with an optional remote fallback that
 *   fetches from Supabase when the local store is empty and the device is online.
 *
 * This dual-layer design enables full offline-first functionality: the app works
 * against the local Dexie store, and the sync queue ensures changes propagate to
 * the server when connectivity is available.
 *
 * @see {@link ./config} for table map and column configuration
 * @see {@link ./database} for Dexie database instance management
 * @see {@link ./queue} for sync queue enqueueing operations
 * @see {@link ./engine} for sync push scheduling and entity modification tracking
 * @see {@link ./conflicts} for conflict resolution during sync pull
 */
/**
 * Create a new entity in the local store and enqueue it for remote sync.
 *
 * This is the primary entry point for all entity creation. It performs the
 * following steps atomically within a single Dexie transaction:
 *   1. Inserts the entity into the local Dexie table.
 *   2. Enqueues a `create` operation in the sync queue.
 *
 * After the transaction commits, it marks the entity as modified (for reactive
 * UI updates) and schedules a sync push to propagate the change to Supabase.
 *
 * The caller is responsible for providing all required fields (including
 * timestamps like `created_at` and `updated_at`). If `data.id` is omitted,
 * a new UUID is generated automatically.
 *
 * @param table - The Supabase table name (resolved internally to a Dexie table).
 * @param data  - The full entity payload. May include `id`; if absent, one is generated.
 * @returns The created entity payload (with `id` guaranteed to be present).
 *
 * @throws {Dexie.ConstraintError} If an entity with the same `id` already exists.
 *
 * @example
 * ```ts
 * const task = await engineCreate('tasks', {
 *   title: 'Write docs',
 *   user_id: currentUserId,
 *   created_at: now(),
 *   updated_at: now(),
 * });
 * console.log(task.id); // auto-generated UUID
 * ```
 *
 * @see {@link engineBatchWrite} for creating multiple entities atomically
 * @see {@link queueCreateOperation} for the sync queue entry format
 */
export declare function engineCreate(table: string, data: Record<string, unknown>): Promise<Record<string, unknown>>;
/**
 * Update specific fields on an existing entity.
 *
 * Automatically sets `updated_at` to the current timestamp, enqueues a `set`
 * sync operation, and notifies the engine of the modification. The update and
 * queue entry are wrapped in a single transaction for atomicity.
 *
 * If the entity does not exist (e.g., it was deleted between the caller's
 * check and this call), the sync operation is skipped and `undefined` is
 * returned -- no orphan queue entries are created.
 *
 * @param table  - The Supabase table name.
 * @param id     - The primary key of the entity to update.
 * @param fields - A partial record of fields to merge into the entity.
 * @returns The fully updated entity record, or `undefined` if the entity was not found.
 *
 * @example
 * ```ts
 * const updated = await engineUpdate('tasks', taskId, { title: 'New title' });
 * // updated.updated_at is automatically set
 * ```
 *
 * @see {@link engineIncrement} for numeric field increments with conflict-safe semantics
 * @see {@link queueSyncOperation} for the `set` operation queue format
 */
export declare function engineUpdate(table: string, id: string, fields: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
/**
 * Soft-delete an entity by setting `deleted: true`.
 *
 * The engine uses soft deletes rather than hard deletes so that the deletion
 * can be synced to other devices and to the server. The sync queue receives a
 * `delete` operation, which the push logic translates into a Supabase update
 * that sets `deleted = true` on the remote row.
 *
 * The entity remains in the local Dexie store (with `deleted: true`) until a
 * future compaction or full re-sync removes it.
 *
 * @param table - The Supabase table name.
 * @param id    - The primary key of the entity to soft-delete.
 * @returns Resolves when the local update and queue entry are committed.
 *
 * @example
 * ```ts
 * await engineDelete('tasks', taskId);
 * // The task still exists locally with deleted: true
 * // It will be synced as a deletion on the next push
 * ```
 *
 * @see {@link queueDeleteOperation} for the delete queue entry format
 */
export declare function engineDelete(table: string, id: string): Promise<void>;
/**
 * Discriminated union representing a single operation within a batch write.
 *
 * Each variant mirrors the corresponding single-entity function but is designed
 * to be executed as part of an atomic multi-operation transaction.
 *
 * @see {@link engineBatchWrite} for execution semantics
 */
export type BatchOperation = {
    /** Create a new entity in the specified table. */
    type: 'create';
    /** The Supabase table name. */
    table: string;
    /** The full entity payload (id is auto-generated if absent). */
    data: Record<string, unknown>;
} | {
    /** Update fields on an existing entity. */
    type: 'update';
    /** The Supabase table name. */
    table: string;
    /** The primary key of the entity to update. */
    id: string;
    /** Partial record of fields to merge. */
    fields: Record<string, unknown>;
} | {
    /** Soft-delete an existing entity. */
    type: 'delete';
    /** The Supabase table name. */
    table: string;
    /** The primary key of the entity to delete. */
    id: string;
};
/**
 * Execute multiple write operations in a single atomic Dexie transaction.
 *
 * This is the preferred way to perform related mutations that must succeed or
 * fail together (e.g., creating a parent entity and its children, or moving an
 * item from one list to another). All operations share a single `updated_at`
 * timestamp for consistency.
 *
 * Transaction scope is dynamically computed: only the Dexie tables referenced
 * by the operations (plus `syncQueue`) are locked, minimizing contention.
 *
 * After the transaction commits, all modified entity IDs are marked as modified
 * in a single pass, and a single sync push is scheduled (not one per operation).
 *
 * @param operations - An ordered array of create/update/delete operations.
 * @returns Resolves when all operations have been committed.
 *
 * @throws {Dexie.AbortError} If any operation fails, the entire batch is rolled back.
 *
 * @example
 * ```ts
 * await engineBatchWrite([
 *   { type: 'create', table: 'tasks', data: { title: 'Subtask 1', parent_id: parentId } },
 *   { type: 'create', table: 'tasks', data: { title: 'Subtask 2', parent_id: parentId } },
 *   { type: 'update', table: 'projects', id: projectId, fields: { task_count: newCount } },
 * ]);
 * ```
 *
 * @see {@link engineCreate} for single-entity create semantics
 * @see {@link engineUpdate} for single-entity update semantics
 * @see {@link engineDelete} for single-entity delete semantics
 */
export declare function engineBatchWrite(operations: BatchOperation[]): Promise<void>;
/**
 * Atomically increment a numeric field on an entity.
 *
 * Unlike a plain `engineUpdate` with a computed value, this function preserves
 * the **increment intent** in the sync queue (operationType: 'increment').
 * This is critical for correct multi-device conflict resolution: when two
 * devices each increment a counter by 1, the server can apply both increments
 * additively (+2) rather than last-write-wins (which would yield +1).
 *
 * The local Dexie value is updated immediately (read-modify-write inside a
 * transaction to prevent TOCTOU races). If additional fields need to be set
 * alongside the increment (e.g., a `completed` flag), they are queued as a
 * separate `set` operation so the increment and set semantics remain distinct.
 *
 * @param table            - The Supabase table name.
 * @param id               - The primary key of the entity to increment.
 * @param field            - The name of the numeric field to increment.
 * @param amount           - The increment delta (can be negative for decrements).
 * @param additionalFields - Optional extra fields to set alongside the increment
 *                           (e.g., `{ completed: true }`). These are queued as a
 *                           separate `set` operation.
 * @returns The fully updated entity record, or `undefined` if the entity was not found.
 *
 * @example
 * ```ts
 * // Increment a task's focus_count by 1 and mark it as touched
 * const updated = await engineIncrement('tasks', taskId, 'focus_count', 1, {
 *   last_focused_at: now(),
 * });
 * ```
 *
 * @see {@link engineUpdate} for non-increment field updates
 * @see {@link ./conflicts} for how increment operations are resolved during sync
 */
export declare function engineIncrement(table: string, id: string, field: string, amount: number, additionalFields?: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
/**
 * Retrieve a single entity by its primary key.
 *
 * Queries the local Dexie store first. If the entity is not found locally and
 * `remoteFallback` is enabled (and the device is online), a single-row fetch
 * is made from Supabase. The remote result is cached locally in Dexie for
 * subsequent offline access.
 *
 * The remote fallback filters out soft-deleted rows (`deleted IS NULL OR deleted = false`)
 * to avoid resurrecting deleted entities.
 *
 * @param table - The Supabase table name.
 * @param id    - The primary key of the entity to retrieve.
 * @param opts  - Optional configuration.
 * @param opts.remoteFallback - If `true`, fall back to a Supabase query when
 *                              the entity is not found locally. Defaults to `false`.
 * @returns The entity record, or `null` if not found (locally or remotely).
 *
 * @example
 * ```ts
 * // Local-only lookup (fast, offline-safe)
 * const task = await engineGet('tasks', taskId);
 *
 * // With remote fallback for cache misses
 * const task = await engineGet('tasks', taskId, { remoteFallback: true });
 * ```
 *
 * @see {@link engineGetAll} for retrieving all entities from a table
 * @see {@link engineQuery} for index-based filtered queries
 * @see {@link getTableColumns} for column projection on remote queries
 */
export declare function engineGet(table: string, id: string, opts?: {
    remoteFallback?: boolean;
}): Promise<Record<string, unknown> | null>;
/**
 * Retrieve all entities from a table, with optional ordering and remote fallback.
 *
 * Returns the full (non-filtered) contents of the local Dexie table. If the
 * local table is empty and `remoteFallback` is enabled, a bulk fetch from
 * Supabase is performed and results are cached locally via `bulkPut`.
 *
 * Note: This does NOT filter out soft-deleted entities locally. Callers that
 * need to exclude deleted records should filter the results themselves. The
 * remote fallback, however, does exclude deleted rows to avoid pulling down
 * tombstones.
 *
 * @param table - The Supabase table name.
 * @param opts  - Optional configuration.
 * @param opts.orderBy        - A Dexie-indexed field name to sort results by.
 * @param opts.remoteFallback - If `true`, fall back to Supabase when the local
 *                              table is empty. Defaults to `false`.
 * @returns An array of entity records (may be empty).
 *
 * @example
 * ```ts
 * // Get all tasks ordered by creation date
 * const tasks = await engineGetAll('tasks', { orderBy: 'created_at' });
 *
 * // Bootstrap from remote on first load
 * const tasks = await engineGetAll('tasks', { remoteFallback: true });
 * ```
 *
 * @see {@link engineGet} for single-entity retrieval
 * @see {@link engineQuery} for filtered queries by index
 */
export declare function engineGetAll(table: string, opts?: {
    orderBy?: string;
    remoteFallback?: boolean;
}): Promise<Record<string, unknown>[]>;
/**
 * Query entities by a single indexed field value (equivalent to `WHERE index = value`).
 *
 * Uses Dexie's indexed `where().equals()` for efficient local lookups. If no
 * results are found locally and `remoteFallback` is enabled, a filtered query
 * is made against Supabase and results are cached locally.
 *
 * @param table - The Supabase table name.
 * @param index - The name of the indexed field to filter on.
 * @param value - The value to match against the indexed field.
 * @param opts  - Optional configuration.
 * @param opts.remoteFallback - If `true`, fall back to Supabase when no local
 *                              results are found. Defaults to `false`.
 * @returns An array of matching entity records.
 *
 * @example
 * ```ts
 * // Get all tasks belonging to a specific project
 * const tasks = await engineQuery('tasks', 'project_id', projectId);
 *
 * // With remote fallback for initial sync scenarios
 * const tasks = await engineQuery('tasks', 'user_id', userId, { remoteFallback: true });
 * ```
 *
 * @see {@link engineQueryRange} for range-based queries (BETWEEN)
 * @see {@link engineGetAll} for unfiltered table scans
 */
export declare function engineQuery(table: string, index: string, value: unknown, opts?: {
    remoteFallback?: boolean;
}): Promise<Record<string, unknown>[]>;
/**
 * Query entities where an indexed field falls within an inclusive range.
 *
 * Equivalent to `WHERE index BETWEEN lower AND upper` (inclusive on both ends).
 * Useful for date-range queries (e.g., "all tasks due this week") or numeric
 * range filters.
 *
 * Like other query functions, supports an optional remote fallback for when the
 * local store has no matching results.
 *
 * @param table - The Supabase table name.
 * @param index - The name of the indexed field to filter on.
 * @param lower - The inclusive lower bound of the range.
 * @param upper - The inclusive upper bound of the range.
 * @param opts  - Optional configuration.
 * @param opts.remoteFallback - If `true`, fall back to Supabase when no local
 *                              results are found. Defaults to `false`.
 * @returns An array of matching entity records within the range.
 *
 * @example
 * ```ts
 * // Get all tasks due between Monday and Friday
 * const tasks = await engineQueryRange('tasks', 'due_date', mondayISO, fridayISO);
 *
 * // Get focus sessions within a score range
 * const sessions = await engineQueryRange('focus_sessions', 'score', 80, 100);
 * ```
 *
 * @see {@link engineQuery} for exact-match queries
 */
export declare function engineQueryRange(table: string, index: string, lower: unknown, upper: unknown, opts?: {
    remoteFallback?: boolean;
}): Promise<Record<string, unknown>[]>;
/**
 * Retrieve an existing entity by index, or create one with defaults if none exists.
 *
 * Implements the singleton/get-or-create pattern commonly used for per-user
 * settings records (e.g., `focus_settings`) where exactly one row per user
 * should exist. The lookup uses an indexed field (typically `user_id`) rather
 * than the primary key.
 *
 * Resolution order:
 *   1. **Local lookup** -- query Dexie by the given index. If a non-deleted
 *      match is found, return it immediately.
 *   2. **Remote check** (optional) -- if `checkRemote` is true and online,
 *      query Supabase for an existing record. If found, cache it locally and
 *      return it. This handles the case where the record exists on the server
 *      but hasn't been synced down to this device yet.
 *   3. **Local create** -- if neither local nor remote has a match, create a
 *      new entity with the provided defaults, queue it for sync, and return it.
 *
 * @param table    - The Supabase table name.
 * @param index    - The indexed field to search on (e.g., `'user_id'`).
 * @param value    - The value to match against the index (e.g., the current user's ID).
 * @param defaults - Default field values for the newly created entity (excluding
 *                   `id`, `created_at`, and `updated_at`, which are auto-generated).
 * @param opts     - Optional configuration.
 * @param opts.checkRemote - If `true`, check Supabase before creating locally.
 *                           Prevents duplicate creation when the record exists
 *                           on another device but hasn't synced down yet.
 *                           Defaults to `false`.
 * @returns The existing or newly created entity record.
 *
 * @example
 * ```ts
 * // Get or create user-specific focus settings
 * const settings = await engineGetOrCreate(
 *   'focus_settings',
 *   'user_id',
 *   currentUserId,
 *   { user_id: currentUserId, pomodoro_minutes: 25, break_minutes: 5 },
 *   { checkRemote: true }
 * );
 * ```
 *
 * @see {@link engineCreate} for the underlying create logic
 * @see {@link engineQuery} for index-based queries without auto-creation
 */
export declare function engineGetOrCreate(table: string, index: string, value: unknown, defaults: Record<string, unknown>, opts?: {
    checkRemote?: boolean;
}): Promise<Record<string, unknown>>;
/**
 * Fetch all non-deleted records from a table, sorted by `order`.
 *
 * A convenience wrapper around {@link engineGetAll} that applies the two most
 * common post-processing steps: filtering out soft-deleted records and sorting
 * by the `order` field. This eliminates the repetitive
 * `.filter(i => !i.deleted).sort(...)` pattern from every query function.
 *
 * @typeParam T - The entity type (must have at least `deleted` and `order` fields).
 * @param table - The Supabase table name.
 * @param opts  - Optional configuration.
 * @param opts.remoteFallback - If `true`, fall back to Supabase when the local
 *                              table is empty. Defaults to `false`.
 * @param opts.orderBy        - A Dexie-indexed field to pre-sort by before
 *                              filtering. Defaults to `undefined`.
 * @returns An array of non-deleted entity records sorted by `order`.
 *
 * @example
 * ```ts
 * import { queryAll } from 'stellar-drive/data';
 *
 * const categories = await queryAll<TaskCategory>('task_categories');
 * // Returns only non-deleted records, sorted by order ascending
 * ```
 *
 * @see {@link engineGetAll} for the underlying query
 */
export declare function queryAll<T extends Record<string, unknown>>(table: string, opts?: {
    remoteFallback?: boolean;
    orderBy?: string;
}): Promise<T[]>;
/**
 * Fetch a single non-deleted record by ID, or `null`.
 *
 * A convenience wrapper around {@link engineGet} that returns `null` if the
 * record exists but is soft-deleted. This prevents callers from accidentally
 * displaying tombstoned entities in detail views.
 *
 * @typeParam T - The entity type.
 * @param table - The Supabase table name.
 * @param id    - The primary key of the entity to retrieve.
 * @param opts  - Optional configuration.
 * @param opts.remoteFallback - If `true`, fall back to Supabase when the entity
 *                              is not found locally. Defaults to `false`.
 * @returns The entity record, or `null` if not found or soft-deleted.
 *
 * @example
 * ```ts
 * import { queryOne } from 'stellar-drive/data';
 *
 * const task = await queryOne<Task>('tasks', taskId);
 * if (!task) console.log('Not found or deleted');
 * ```
 *
 * @see {@link engineGet} for the underlying query
 */
export declare function queryOne<T extends Record<string, unknown>>(table: string, id: string, opts?: {
    remoteFallback?: boolean;
}): Promise<T | null>;
/**
 * Update just the `order` field on any entity.
 *
 * A thin wrapper around {@link engineUpdate} for the common reorder operation.
 * Consumer apps typically have identical `reorder` functions across every
 * repository; this generic version eliminates that duplication.
 *
 * @typeParam T - The entity type.
 * @param table    - The Supabase table name.
 * @param id       - The primary key of the entity to reorder.
 * @param newOrder - The new order value.
 * @returns The updated entity, or `undefined` if not found.
 *
 * @example
 * ```ts
 * import { reorderEntity } from 'stellar-drive/data';
 *
 * const updated = await reorderEntity<Task>('tasks', taskId, 2.5);
 * ```
 *
 * @see {@link engineUpdate} for the underlying update
 */
export declare function reorderEntity<T extends Record<string, unknown>>(table: string, id: string, newOrder: number): Promise<T | undefined>;
/**
 * Compute the next prepend-order value for inserting at the top of a list.
 *
 * Queries all non-deleted records matching the given index/value pair, finds
 * the minimum `order` value, and returns `min - 1`. If no records exist,
 * returns `0`. This is the standard pattern for "add to top" operations.
 *
 * @param table      - The Supabase table name.
 * @param indexField - The indexed field to filter on (e.g., `'user_id'`).
 * @param indexValue - The value to match against the index.
 * @returns The computed order value for prepending.
 *
 * @example
 * ```ts
 * import { prependOrder } from 'stellar-drive/data';
 *
 * const order = await prependOrder('tasks', 'user_id', currentUserId);
 * await engineCreate('tasks', { ..., order });
 * ```
 *
 * @see {@link engineQuery} for the underlying query
 */
export declare function prependOrder(table: string, indexField: string, indexValue: string): Promise<number>;
//# sourceMappingURL=data.d.ts.map