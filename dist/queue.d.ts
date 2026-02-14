/**
 * @fileoverview Sync Queue & Operation Coalescing Engine
 *
 * This module manages the offline-first sync queue for stellar-engine. All local
 * mutations (creates, sets, increments, deletes) are enqueued as individual
 * intent-based operations in an IndexedDB-backed queue (`syncQueue` table via Dexie).
 * Before pushing to the remote server, the coalescing algorithm reduces redundant
 * operations to minimize network requests and payload size.
 *
 * ## Design Philosophy
 *
 * The queue stores **intent-based operations** (create, set, increment, delete)
 * rather than **state snapshots**. This is critical for two reasons:
 *
 * - **Coalescing:** Intent-based ops can be algebraically reduced. For example,
 *   two increments on the same field can be summed, and a create followed by
 *   a delete cancels out entirely. State snapshots cannot be reduced this way.
 * - **Conflict resolution:** When a conflict arises during sync, the conflict
 *   resolver can inspect the *intent* (e.g., "user incremented score by 3")
 *   rather than just the final value. This enables smarter merge strategies.
 *
 * ## Coalescing Algorithm (6-Step Pipeline)
 *
 * The {@link coalescePendingOps} function implements a multi-pass coalescing pipeline:
 *
 *   1. **Group by entity** -- Operations are bucketed by `table:entityId` composite key.
 *   2. **Entity-level reduction** -- Four mutually exclusive cases per entity group:
 *      - CREATE + DELETE = cancel everything (entity was born and died offline).
 *      - DELETE only     = drop preceding sets/increments (they are moot).
 *      - CREATE only     = fold subsequent sets/increments into the create payload.
 *      - Updates only    = delegate to field-level coalescing ({@link processFieldOperations}).
 *   3. **Increment coalescing** -- Surviving increment ops on the same field are summed.
 *   4. **Set coalescing**       -- Surviving set ops on the same entity are merged.
 *   5. **No-op pruning**        -- Zero-delta increments, empty sets, and `updated_at`-only
 *                                  sets are removed.
 *   6. **Batch persist**        -- All deletions and updates are flushed to IndexedDB in
 *                                  a single batch/transaction.
 *
 * ## Performance Characteristics
 *
 * - **O(n)** memory where n = queue length (single fetch, in-memory processing).
 * - **O(1)** IndexedDB reads regardless of queue size (one `toArray()` call).
 * - **O(k)** IndexedDB writes where k = number of changed rows (bulk delete + transaction).
 * - No re-fetching between phases; all intermediate state lives in `idsToDelete` / `itemUpdates`.
 *
 * ## Retry & Backoff
 *
 * Failed items are retried with exponential backoff (2^(retries-1) seconds) up to
 * {@link MAX_SYNC_RETRIES} attempts, after which {@link cleanupFailedItems} permanently
 * removes them and reports the affected tables for user notification.
 *
 * ## Data Integrity
 *
 * - Operations are never modified in-place during coalescing; all mutations are
 *   accumulated in `idsToDelete` and `itemUpdates` and flushed atomically at
 *   the end. If the process crashes mid-pipeline, the queue is untouched.
 * - The `timestamp` field on each operation is **immutable after creation**.
 *   It preserves enqueue order for deterministic sync and is not updated on
 *   retry (only `lastRetryAt` is updated). This ensures that coalescing and
 *   sync always process operations in the order the user intended.
 *
 * @see {@link SyncOperationItem} for the queue row schema.
 * @see {@link processFieldOperations} for field-level increment/set interaction logic.
 */
import type { SyncOperationItem } from './types';
/**
 * Coalesce multiple operations to the same entity into fewer operations.
 * This dramatically reduces the number of server requests and data transfer.
 *
 * The algorithm runs a 6-step pipeline entirely in memory after a single IndexedDB
 * read, then flushes all mutations (deletes + updates) back to the database in batch.
 *
 * **When to call:** Before each sync push cycle. The sync engine typically calls
 * this once, then calls {@link getPendingSync} to retrieve the reduced queue.
 *
 * **Idempotency:** Calling this multiple times is safe but wasteful -- after the
 * first call, subsequent calls will find nothing to coalesce and return 0.
 *
 * **Atomicity:** The pipeline accumulates all mutations in memory and flushes them
 * at the end. If the browser crashes mid-pipeline, no data is lost -- the queue
 * remains in its pre-coalescing state and will be coalesced on the next cycle.
 *
 * PERFORMANCE OPTIMIZED:
 * - Single DB fetch at start (no re-fetching between phases)
 * - All processing done in memory
 * - Batch deletes and updates at the end
 *
 * @returns The number of redundant operations that were removed from the queue.
 *
 * @example
 * ```ts
 * const removed = await coalescePendingOps();
 * console.log(`Coalesced away ${removed} redundant operations`);
 * ```
 *
 * @see {@link processFieldOperations} for the field-level reduction used in Step 2 Case 4.
 * @see {@link getPendingSync} which typically calls this before fetching items to push.
 */
export declare function coalescePendingOps(): Promise<number>;
/**
 * Retrieve all pending sync operations that are currently eligible for processing.
 *
 * Items are returned in enqueue order (`timestamp` ascending). Items that have
 * exceeded {@link MAX_SYNC_RETRIES} or are still within their backoff window
 * are excluded.
 *
 * **Ordering guarantee:** Results are sorted by `timestamp` (the original
 * enqueue time). This ensures operations are pushed to the server in the order
 * the user performed them, which is important for correctness (e.g., a create
 * must be pushed before subsequent updates to the same entity).
 *
 * @returns An array of sync operation items ready to be pushed to the server.
 *
 * @example
 * ```ts
 * const pending = await getPendingSync();
 * for (const op of pending) {
 *   await pushToServer(op);
 * }
 * ```
 *
 * @see {@link shouldRetryItem} for the retry eligibility logic.
 * @see {@link coalescePendingOps} which should be called before this to reduce the queue.
 */
export declare function getPendingSync(): Promise<SyncOperationItem[]>;
/**
 * Remove sync items that have permanently failed (exceeded {@link MAX_SYNC_RETRIES})
 * and return a summary for user notification.
 *
 * This is a garbage-collection function typically called periodically or after
 * a sync cycle completes. It logs a warning for each removed item via
 * {@link debugWarn}.
 *
 * **Why return affected tables?** The caller (usually the sync engine) can use
 * the table names to show targeted error messages to the user, e.g.,
 * "Some changes to your goals could not be synced."
 *
 * @returns An object containing the count of removed items and the list of
 *          affected table names (useful for showing targeted error messages).
 *
 * @example
 * ```ts
 * const { count, tables } = await cleanupFailedItems();
 * if (count > 0) {
 *   showToast(`${count} sync operations failed for: ${tables.join(', ')}`);
 * }
 * ```
 *
 * @see {@link MAX_SYNC_RETRIES} for the retry threshold.
 * @see {@link shouldRetryItem} for the backoff logic that precedes permanent failure.
 */
export declare function cleanupFailedItems(): Promise<{
    count: number;
    tables: string[];
}>;
/**
 * Remove a single sync operation from the queue by its primary key.
 *
 * Typically called after a successful server push to acknowledge the operation.
 * This is the "happy path" cleanup -- the operation was pushed successfully
 * and no longer needs to be tracked.
 *
 * @param id - The auto-increment primary key of the sync queue row to remove.
 *
 * @example
 * ```ts
 * await pushToServer(op);
 * await removeSyncItem(op.id!);
 * ```
 */
export declare function removeSyncItem(id: number): Promise<void>;
/**
 * Increment the retry counter and record the current time as the last retry
 * attempt for a sync operation that failed to push.
 *
 * The `timestamp` field is intentionally *not* modified -- it must be preserved
 * to maintain correct operation ordering during coalescing and sync. Only
 * `lastRetryAt` is updated, which is used exclusively by the backoff logic
 * in {@link shouldRetryItem}.
 *
 * @param id - The auto-increment primary key of the sync queue row.
 *
 * @example
 * ```ts
 * try {
 *   await pushToServer(op);
 * } catch {
 *   await incrementRetry(op.id!);
 * }
 * ```
 *
 * @see {@link shouldRetryItem} which reads `retries` and `lastRetryAt` for backoff.
 */
export declare function incrementRetry(id: number): Promise<void>;
/**
 * Retrieve the set of all entity IDs that have at least one pending sync operation.
 *
 * This is useful for:
 * - **UI indicators:** Showing a "syncing" badge on entities that haven't been
 *   pushed to the server yet.
 * - **Conflict detection:** The realtime handler uses this to decide whether an
 *   incoming remote change needs conflict resolution (Branch 3) or can be
 *   accepted directly (Branch 2).
 *
 * @returns A `Set` of entity UUID strings with pending operations.
 *
 * @example
 * ```ts
 * const pendingIds = await getPendingEntityIds();
 * const isSyncing = pendingIds.has(goal.id);
 * ```
 *
 * @see {@link ./realtime.ts} which calls this during change processing
 */
export declare function getPendingEntityIds(): Promise<Set<string>>;
/**
 * Queue a sync operation using the intent-based format.
 *
 * This is the low-level enqueue function. It stamps the operation with the
 * current ISO 8601 timestamp and initializes the retry counter to 0, then
 * inserts it into the `syncQueue` IndexedDB table.
 *
 * **Auto-generated fields:** The `id` (auto-increment primary key),
 * `timestamp` (current time), and `retries` (0) are automatically set.
 * Callers must not provide these.
 *
 * **Durability:** The operation is persisted to IndexedDB immediately. Even
 * if the browser crashes or is closed before the next sync cycle, the
 * operation will be picked up when the app restarts.
 *
 * @param item - The operation to enqueue, excluding auto-generated fields
 *               (`id`, `timestamp`, `retries`).
 *
 * @example
 * ```ts
 * await queueSyncOperation({
 *   table: 'goals',
 *   entityId: 'abc-123',
 *   operationType: 'set',
 *   field: 'title',
 *   value: 'New Title'
 * });
 * ```
 *
 * @see {@link queueCreateOperation} for a convenience wrapper around create ops.
 * @see {@link queueDeleteOperation} for a convenience wrapper around delete ops.
 * @see {@link coalescePendingOps} which later reduces redundant queued operations.
 */
export declare function queueSyncOperation(item: Omit<SyncOperationItem, 'id' | 'timestamp' | 'retries'>): Promise<void>;
/**
 * Helper to queue a create operation.
 *
 * Convenience wrapper around {@link queueSyncOperation} for the common case of
 * creating a new entity. The entire entity payload is stored as the operation
 * value so it can be sent as-is (or merged with subsequent updates by the
 * coalescing pipeline).
 *
 * **Coalescing behavior:** If the user subsequently modifies fields of this
 * entity before sync, those set/increment operations will be folded into this
 * create payload by Step 2, Case 3 of the coalescing pipeline. If the user
 * subsequently deletes this entity, all operations (including this create)
 * will be cancelled entirely by Step 2, Case 1.
 *
 * @param table    - The target Supabase table name (e.g., `"goals"`).
 * @param entityId - The UUID of the new entity.
 * @param payload  - The full entity object to create on the server.
 *
 * @example
 * ```ts
 * await queueCreateOperation('goals', newGoal.id, {
 *   id: newGoal.id,
 *   title: 'Learn TypeScript',
 *   created_at: new Date().toISOString()
 * });
 * ```
 *
 * @see {@link queueSyncOperation} for the underlying enqueue mechanism.
 */
export declare function queueCreateOperation(table: string, entityId: string, payload: Record<string, unknown>): Promise<void>;
/**
 * Helper to queue a delete operation.
 *
 * Convenience wrapper around {@link queueSyncOperation} for deleting an entity.
 * No value is needed -- the operation type and entity ID are sufficient for the
 * server to process the deletion.
 *
 * **Coalescing behavior:**
 * - If this entity was created offline (has a pending create), both the create
 *   and this delete are cancelled entirely (Step 2, Case 1).
 * - If this entity existed on the server, all preceding set/increment operations
 *   are dropped and only this delete survives (Step 2, Case 2).
 *
 * @param table    - The target Supabase table name (e.g., `"goals"`).
 * @param entityId - The UUID of the entity to delete.
 *
 * @example
 * ```ts
 * await queueDeleteOperation('goals', goalToRemove.id);
 * ```
 *
 * @see {@link queueSyncOperation} for the underlying enqueue mechanism.
 * @see {@link coalescePendingOps} Step 2, Cases 1-2 for how deletes interact with
 *      other operations during coalescing.
 */
export declare function queueDeleteOperation(table: string, entityId: string): Promise<void>;
//# sourceMappingURL=queue.d.ts.map