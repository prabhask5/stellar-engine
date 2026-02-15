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

import { debugLog, debugWarn } from './debug';
import { isDebugMode } from './debug';
import { getEngineConfig } from './config';
import type { SyncOperationItem } from './types';
import { isDemoMode } from './demo';
import { syncStatusStore } from './stores/sync';

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum number of retry attempts before a sync item is considered permanently failed.
 *
 * **Why 5?** With exponential backoff (1s, 2s, 4s, 8s), 5 retries span ~15 seconds
 * of cumulative wait time. This covers transient network errors and brief server
 * outages without keeping doomed operations in the queue indefinitely.
 *
 * After exceeding this threshold, items are removed by {@link cleanupFailedItems}
 * and the affected tables are reported back to the caller for user notification.
 */
const MAX_SYNC_RETRIES = 5;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Retrieve the Dexie database instance from the global engine configuration.
 *
 * @returns The configured Dexie database. Assumes `getEngineConfig().db` is non-null
 *          (the engine must be initialized before any queue operations).
 *
 * @throws Will throw a TypeError if the engine has not been initialized
 *         (`db` is null/undefined). This is intentional -- queue operations
 *         before engine init indicate a programming error.
 *
 * @see {@link getEngineConfig} for the configuration provider.
 */
function getDb() {
  return getEngineConfig().db!;
}

// =============================================================================
// Coalescing Pipeline (Public Entry Point)
// =============================================================================

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
export async function coalescePendingOps(): Promise<number> {
  const db = getDb();
  const allItems = (await db.table('syncQueue').toArray()) as unknown as SyncOperationItem[];
  /* Early exit: 0 or 1 items can never be coalesced. This avoids the overhead
     of creating the tracking structures for the common case of a small queue. */
  if (allItems.length <= 1) return 0;

  // ---------------------------------------------------------------------------
  // In-memory tracking structures
  // ---------------------------------------------------------------------------
  // We accumulate all intended mutations here so we can flush them in a single
  // batch at the end. This avoids interleaving IndexedDB I/O between phases,
  // which would be both slower and harder to reason about. It also provides
  // crash safety: if the process dies mid-pipeline, the queue is untouched.

  /** IDs of queue rows that should be deleted (redundant / cancelled). */
  const idsToDelete = new Set<number>();
  /** Pending partial updates to queue rows, keyed by row ID. */
  const itemUpdates = new Map<number, Partial<SyncOperationItem>>();

  /**
   * Check whether an item is still "alive" -- i.e., has a defined ID and has
   * not been marked for deletion by an earlier phase of the pipeline.
   *
   * This is used by later phases (Steps 3-5) to avoid operating on items
   * that were already eliminated by earlier phases (Steps 1-2).
   *
   * @param item - The sync operation item to check.
   * @returns `true` if the item should still be considered during subsequent phases.
   */
  const isAlive = (item: SyncOperationItem) => item.id !== undefined && !idsToDelete.has(item.id);

  /**
   * Mark an item for deletion at the end of the pipeline.
   *
   * Items are not immediately removed from the allItems array -- they are
   * simply flagged via `idsToDelete`. This avoids costly array mutations
   * and allows later phases to iterate the original array with `isAlive` checks.
   *
   * @param item - The sync operation item to remove.
   */
  const markDeleted = (item: SyncOperationItem) => {
    if (item.id !== undefined) idsToDelete.add(item.id);
  };

  /**
   * Mark an item for update at the end of the pipeline. Multiple calls for the
   * same item are merged (later updates win on a per-key basis).
   *
   * **Merge semantics:** Uses shallow spread, so nested objects are replaced
   * wholesale (not deep-merged). This is correct for our use case because
   * the `value` field is always replaced entirely, never partially updated.
   *
   * @param item    - The sync operation item to update.
   * @param updates - The partial fields to apply.
   */
  const markUpdated = (item: SyncOperationItem, updates: Partial<SyncOperationItem>) => {
    if (item.id !== undefined) {
      const existing = itemUpdates.get(item.id) || {};
      itemUpdates.set(item.id, { ...existing, ...updates });
    }
  };

  /**
   * Return the "effective" value of an item, accounting for any pending in-memory
   * updates that earlier phases may have applied. This is essential for Steps 3-5,
   * which operate on the results of Step 2.
   *
   * **Why not mutate items in place?** Because the items array is a snapshot from
   * IndexedDB. Mutating it would make the code harder to reason about (which
   * fields are "real" vs. "modified?") and would prevent crash-safe behavior.
   *
   * @param item - The sync operation item whose effective value is needed.
   * @returns The pending updated value if one exists, otherwise the original value.
   */
  const getEffectiveValue = (item: SyncOperationItem): unknown => {
    if (item.id !== undefined && itemUpdates.has(item.id)) {
      return itemUpdates.get(item.id)!.value ?? item.value;
    }
    return item.value;
  };

  // ===========================================================================
  // STEP 1: Group all operations by entity
  // ===========================================================================
  /* Composite key `table:entityId` ensures operations on different tables with
     the same entity UUID are never incorrectly merged. This matters when
     multiple tables reference the same ID scheme (e.g., UUIDs). */
  const entityGroups = new Map<string, SyncOperationItem[]>();
  for (const item of allItems) {
    const key = `${item.table}:${item.entityId}`;
    if (!entityGroups.has(key)) entityGroups.set(key, []);
    entityGroups.get(key)!.push(item);
  }

  // ===========================================================================
  // STEP 2: Process each entity group (entity-level reduction)
  // ===========================================================================
  for (const [, items] of entityGroups) {
    /* Chronological sort is critical: it lets us reason about "before" and
       "after" relationships between creates, updates, and deletes. The
       timestamp is the original enqueue time, which never changes. */
    items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const hasCreate = items.some((i) => i.operationType === 'create');
    const hasDelete = items.some((i) => i.operationType === 'delete');

    // ---- Case 1: CREATE + DELETE -> everything cancels out ----
    /* The entity was created and deleted within the same offline session.
       The server never knew about it, so we can discard every operation.
       This is the most aggressive optimization: N operations become 0. */
    if (hasCreate && hasDelete) {
      if (isDebugMode()) {
        debugLog(
          `[QUEUE] Create+delete cancellation: ${items.length} ops cancelled for ${items[0].table}/${items[0].entityId}`
        );
      }
      for (const item of items) {
        markDeleted(item);
      }
      continue;
    }

    // ---- Case 2: DELETE without CREATE -> only the delete survives ----
    /* The entity existed on the server before going offline. Intermediate
       sets/increments are pointless because the delete will wipe the row.
       We keep only the delete operation itself. */
    if (!hasCreate && hasDelete) {
      if (isDebugMode()) {
        const droppedCount = items.filter((i) => i.operationType !== 'delete').length;
        if (droppedCount > 0) {
          debugLog(
            `[QUEUE] Delete-only reduction: dropping ${droppedCount} intermediate ops for ${items[0].table}/${items[0].entityId}`
          );
        }
      }
      for (const item of items) {
        if (item.operationType !== 'delete') {
          markDeleted(item);
        }
      }
      continue;
    }

    // ---- Case 3: CREATE without DELETE -> fold updates into create payload ----
    /* Since the server hasn't seen the entity yet, we can build the final
       create payload by replaying all subsequent sets and increments into
       the original create value. This turns N operations into one.

       **Why replay in order?** Because a later set on the same field should
       overwrite an earlier one. Chronological ordering ensures the final
       payload reflects the user's last action. */
    if (hasCreate && !hasDelete) {
      const createItem = items.find((i) => i.operationType === 'create');
      const otherItems = items.filter((i) => i.operationType !== 'create');

      if (createItem && otherItems.length > 0) {
        let mergedPayload = { ...(createItem.value as Record<string, unknown>) };

        for (const item of otherItems) {
          if (item.operationType === 'set') {
            if (item.field) {
              /* Field-targeted set: overwrite a single key in the payload. */
              mergedPayload[item.field] = item.value;
            } else if (typeof item.value === 'object' && item.value !== null) {
              /* Whole-object set: shallow-merge into the payload. Later
                 fields overwrite earlier ones due to spread semantics. */
              mergedPayload = { ...mergedPayload, ...(item.value as Record<string, unknown>) };
            }
          } else if (item.operationType === 'increment' && item.field) {
            /* Increments are folded arithmetically into the current field value.
               If the field doesn't exist yet (or isn't a number), we treat it as 0.
               This is safe because the create payload is the entity's initial state;
               a missing numeric field logically starts at zero. */
            const currentVal =
              typeof mergedPayload[item.field] === 'number'
                ? (mergedPayload[item.field] as number)
                : 0;
            const delta = typeof item.value === 'number' ? item.value : 0;
            mergedPayload[item.field] = currentVal + delta;
          }
        }

        markUpdated(createItem, { value: mergedPayload });

        for (const item of otherItems) {
          markDeleted(item);
        }
      }
      continue;
    }

    // ---- Case 4: No create, no delete -> field-level coalescing ----
    /* This is the most nuanced case: the entity exists on the server and we
       have a mix of sets and increments targeting various fields. Delegate to
       the specialized field-operations processor which handles interactions
       between sets and increments on the same field. */
    processFieldOperations(items, markDeleted, markUpdated);
  }

  // ===========================================================================
  // STEP 3: Coalesce remaining INCREMENT operations (not yet deleted)
  // ===========================================================================
  /* After entity-level reduction, there may still be multiple surviving
     increment operations targeting the same field. We sum their deltas into
     the oldest operation and discard the rest. The oldest is kept because it
     preserves the original enqueue order (important for deterministic sync).

     **Example:** INC score+3, INC score+5 -> INC score+8 (on the oldest item) */
  const incrementGroups = new Map<string, SyncOperationItem[]>();
  for (const item of allItems) {
    if (item.operationType === 'increment' && item.field && isAlive(item)) {
      const key = `${item.table}:${item.entityId}:${item.field}`;
      if (!incrementGroups.has(key)) incrementGroups.set(key, []);
      incrementGroups.get(key)!.push(item);
    }
  }

  for (const [, items] of incrementGroups) {
    const aliveItems = items.filter(isAlive);
    if (aliveItems.length <= 1) continue;

    aliveItems.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let totalDelta = 0;
    for (const item of aliveItems) {
      const effectiveValue = getEffectiveValue(item);
      const delta = typeof effectiveValue === 'number' ? effectiveValue : 0;
      totalDelta += delta;
    }

    /* Keep the oldest item with the summed delta; delete the rest.
       Keeping the oldest preserves enqueue ordering for sync. */
    const oldestItem = aliveItems[0];
    markUpdated(oldestItem, { value: totalDelta });

    for (let i = 1; i < aliveItems.length; i++) {
      markDeleted(aliveItems[i]);
    }
  }

  // ===========================================================================
  // STEP 4: Coalesce remaining SET operations (not yet deleted)
  // ===========================================================================
  /* Multiple surviving set operations on the same entity are merged into a
     single whole-object set. Field-targeted sets contribute their field; whole-
     object sets are shallow-merged. The oldest item is kept as the carrier.

     **Why merge sets?** Consider a user who changes the title, then the
     description, then the title again -- all while offline. Without merging,
     the server would receive 3 separate set operations. With merging, it
     receives one set with both the final title and description. */
  const setGroups = new Map<string, SyncOperationItem[]>();
  for (const item of allItems) {
    if (item.operationType === 'set' && isAlive(item)) {
      const key = `${item.table}:${item.entityId}`;
      if (!setGroups.has(key)) setGroups.set(key, []);
      setGroups.get(key)!.push(item);
    }
  }

  for (const [, items] of setGroups) {
    const aliveItems = items.filter(isAlive);
    if (aliveItems.length <= 1) continue;

    aliveItems.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let mergedValue: Record<string, unknown> = {};
    for (const item of aliveItems) {
      const effectiveValue = getEffectiveValue(item);
      if (item.field) {
        /* Field-targeted set: slot into the merged object under its field name. */
        mergedValue[item.field] = effectiveValue;
      } else if (typeof effectiveValue === 'object' && effectiveValue !== null) {
        /* Whole-object set: shallow-merge (later values overwrite earlier ones).
           This ensures the user's most recent value wins when fields overlap. */
        mergedValue = { ...mergedValue, ...(effectiveValue as Record<string, unknown>) };
      }
    }

    /* Clear `field` on the carrier so it becomes a whole-object set containing
       all the merged fields. This transformation is necessary because the
       carrier might originally have been a field-targeted set (e.g., field='title'),
       but it now carries multiple fields. */
    const oldestItem = aliveItems[0];
    markUpdated(oldestItem, { value: mergedValue, field: undefined });

    for (let i = 1; i < aliveItems.length; i++) {
      markDeleted(aliveItems[i]);
    }
  }

  // ===========================================================================
  // STEP 5: Remove no-op operations
  // ===========================================================================
  /* Final cleanup pass: any operation that would have no server-side effect is
     pruned. This catches edge cases produced by the earlier merging phases
     (e.g., increments that sum to zero, or sets that only touch `updated_at`).

     **Why is this a separate pass?** Steps 2-4 can produce no-ops as a side
     effect of merging (e.g., INC +3 and INC -3 sum to 0). Detecting these
     inline would complicate those steps. A dedicated cleanup pass is cleaner. */
  for (const item of allItems) {
    if (!isAlive(item)) continue;

    let shouldDelete = false;
    const effectiveValue = getEffectiveValue(item);

    /* Zero-delta increments are no-ops -- incrementing by 0 is meaningless.
       These can arise when opposite increments cancel out in Step 3. */
    if (item.operationType === 'increment') {
      const delta = typeof effectiveValue === 'number' ? effectiveValue : 0;
      if (delta === 0) {
        if (isDebugMode()) {
          debugLog(
            `[QUEUE] Zero-delta pruning: increment on ${item.table}/${item.entityId}.${item.field} sums to 0`
          );
        }
        shouldDelete = true;
      }
    }

    /* Sets that carry no meaningful data are no-ops. We check three sub-cases:
       (a) field-targeted set where the field is just `updated_at`,
       (b) whole-object set where all keys are `updated_at`,
       (c) set with null/undefined value. */
    if (item.operationType === 'set') {
      const pendingUpdate = item.id !== undefined ? itemUpdates.get(item.id) : undefined;
      const effectiveField = pendingUpdate?.field !== undefined ? pendingUpdate.field : item.field;

      if (effectiveField) {
        /* (a) A single-field set targeting only `updated_at` -- the server
               manages this timestamp itself via triggers or the sync push
               handler, so pushing it from the client is wasteful. */
        if (effectiveField === 'updated_at') {
          shouldDelete = true;
        }
      } else if (typeof effectiveValue === 'object' && effectiveValue !== null) {
        /* (b) A whole-object set where the only remaining key is `updated_at`.
               This can happen when Step 4 merges multiple field-targeted sets
               and all meaningful fields were eliminated by other passes. */
        const payload = effectiveValue as Record<string, unknown>;
        const keys = Object.keys(payload).filter((k) => k !== 'updated_at');
        if (keys.length === 0) {
          shouldDelete = true;
        }
      } else if (effectiveValue === undefined || effectiveValue === null) {
        /* (c) A set with no value at all -- nothing to send. This is a
               degenerate case that shouldn't normally occur, but we handle
               it defensively. */
        shouldDelete = true;
      }
    }

    if (shouldDelete) {
      markDeleted(item);
    }
  }

  // ===========================================================================
  // STEP 6: Apply all changes in batch
  // ===========================================================================
  const deleteIds = Array.from(idsToDelete);

  /* Discard updates targeting rows we are about to delete -- applying them
     would be wasteful and could cause Dexie errors on missing keys. */
  const finalUpdates: Array<{ id: number; changes: Partial<SyncOperationItem> }> = [];
  for (const [id, changes] of itemUpdates) {
    if (!idsToDelete.has(id)) {
      finalUpdates.push({ id, changes });
    }
  }

  const syncQueue = db.table('syncQueue');

  /* Batch delete in one IndexedDB call. `bulkDelete` is significantly faster
     than individual `delete` calls because it batches into a single IDB
     transaction internally. */
  if (deleteIds.length > 0) {
    await syncQueue.bulkDelete(deleteIds);
  }

  /* Batch update via a Dexie transaction. Dexie doesn't have a `bulkUpdate`
     method, so we wrap individual updates in a single read-write transaction
     to avoid N separate implicit transactions. This reduces IDB overhead from
     O(N) transaction commits to O(1). */
  if (finalUpdates.length > 0) {
    await db.transaction('rw', syncQueue, async () => {
      for (const { id, changes } of finalUpdates) {
        await syncQueue.update(id, changes);
      }
    });
  }

  return deleteIds.length;
}

// =============================================================================
// Field-Level Operation Processor (Internal)
// =============================================================================

/**
 * Process increment/set interactions for the same field within an entity (in-memory).
 *
 * This is the workhorse for "Case 4" of the entity-level reduction: the entity has
 * no pending create or delete, so we must carefully reason about per-field interactions
 * between set and increment operations.
 *
 * The key insight is that a `set` on a field establishes a new absolute value, which
 * renders all *preceding* operations on that field irrelevant. If `increment` operations
 * follow the last `set`, their deltas can be folded into the set's value, turning
 * N operations into one.
 *
 * **Correctness invariant:** The resulting operations, when replayed in order against
 * the server's current state, must produce the same entity as replaying the original
 * operations. This is preserved because:
 * - We only eliminate operations that are provably superseded (before the last set)
 * - We only fold increments into a set when the set's base value is known
 *
 * @param items       - All sync operations for a single entity (already filtered to one
 *                      `table:entityId` group). May include operations without a `field`
 *                      (whole-object sets); those are ignored here and handled by Step 4.
 * @param markDeleted - Callback to schedule an item for deletion.
 * @param markUpdated - Callback to schedule a partial update on an item.
 *
 * @see {@link coalescePendingOps} Step 2, Case 4 -- the only call site.
 */
function processFieldOperations(
  items: SyncOperationItem[],
  markDeleted: (item: SyncOperationItem) => void,
  markUpdated: (item: SyncOperationItem, updates: Partial<SyncOperationItem>) => void
): void {
  /* Group by field name. Only field-targeted increments and sets participate;
     whole-object sets (field === undefined) are left for Step 4 because their
     effect spans multiple fields and cannot be reduced at the single-field level. */
  const fieldGroups = new Map<string, SyncOperationItem[]>();

  for (const item of items) {
    if (item.field && (item.operationType === 'increment' || item.operationType === 'set')) {
      const key = item.field;
      if (!fieldGroups.has(key)) fieldGroups.set(key, []);
      fieldGroups.get(key)!.push(item);
    }
  }

  for (const [, fieldItems] of fieldGroups) {
    /* Single operation on a field cannot be reduced further. */
    if (fieldItems.length <= 1) continue;

    /* Chronological sort to determine which operations come before/after others.
       This ordering is the foundation of the "last set wins" logic below. */
    fieldItems.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const hasIncrement = fieldItems.some((i) => i.operationType === 'increment');
    const hasSet = fieldItems.some((i) => i.operationType === 'set');

    if (hasIncrement && hasSet) {
      /* Mixed increment + set on the same field. The last `set` establishes a
         known absolute value, so everything before it is superseded.

         **Example:** INC score+3, SET score=10, INC score+5
         -> The INC+3 is moot (SET overwrites it).
         -> The INC+5 is folded into the SET: SET score=15.
         -> Final result: one SET score=15. */
      const lastSetIndex = fieldItems.map((i) => i.operationType).lastIndexOf('set');
      const lastSet = fieldItems[lastSetIndex];

      /* Increments AFTER the last set can be folded into the set's value
         because we know the base value the set establishes. */
      const incrementsAfterSet = fieldItems
        .slice(lastSetIndex + 1)
        .filter((i) => i.operationType === 'increment');

      if (incrementsAfterSet.length > 0) {
        /* Sum all post-set increment deltas and bake them into the set value.
           E.g., SET score=10, INC score+3, INC score+5 -> SET score=18. */
        let totalDelta = 0;
        for (const inc of incrementsAfterSet) {
          totalDelta += typeof inc.value === 'number' ? inc.value : 0;
        }

        const baseValue = typeof lastSet.value === 'number' ? lastSet.value : 0;
        const finalValue = baseValue + totalDelta;

        markUpdated(lastSet, { value: finalValue });

        for (const inc of incrementsAfterSet) {
          markDeleted(inc);
        }
      }

      /* Everything before the last set is moot -- the set overwrites whatever
         those operations would have produced. This includes both earlier sets
         and earlier increments on this field. */
      const itemsBeforeLastSet = fieldItems.slice(0, lastSetIndex);
      for (const item of itemsBeforeLastSet) {
        markDeleted(item);
      }
    }
    /* Note: Groups with only increments (no sets) or only sets (no increments)
       are handled by Steps 3 and 4 respectively. They are intentionally
       NOT processed here to keep this function focused on mixed interactions. */
  }
}

// =============================================================================
// Retry & Backoff Logic
// =============================================================================

/**
 * Determine whether a failed sync item is eligible for retry based on
 * exponential backoff timing.
 *
 * The backoff schedule is: 1s, 2s, 4s, 8s for retries 1-4. The first attempt
 * (retries === 0) is always immediate. Items that have reached
 * {@link MAX_SYNC_RETRIES} are never retried.
 *
 * **Why exponential backoff?** It prevents hammering a server that may be
 * temporarily overloaded or unreachable, while still retrying quickly for
 * transient errors (first retry after just 1 second).
 *
 * @param item - The sync operation item to evaluate.
 * @returns `true` if the item should be included in the next sync push.
 *
 * @see {@link getPendingSync} which uses this to filter the queue.
 * @see {@link incrementRetry} which advances the retry counter after a failure.
 * @see {@link cleanupFailedItems} which removes items past the max retry threshold.
 */
function shouldRetryItem(item: SyncOperationItem): boolean {
  if (item.retries >= MAX_SYNC_RETRIES) return false;

  /* First attempt (retries=0) is always immediate -- no backoff needed. */
  if (item.retries === 0) return true;

  /* Exponential backoff: 2^(retries-1) seconds -> 1s, 2s, 4s, 8s
     Uses `lastRetryAt` if available, otherwise falls back to the original
     `timestamp` for backward compatibility with items that predate the
     `lastRetryAt` field. */
  const backoffMs = Math.pow(2, item.retries - 1) * 1000;
  const lastAttempt = new Date(item.lastRetryAt || item.timestamp).getTime();
  const now = Date.now();

  return now - lastAttempt >= backoffMs;
}

// =============================================================================
// Queue Query Functions
// =============================================================================

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
export async function getPendingSync(): Promise<SyncOperationItem[]> {
  const db = getDb();
  const allItems = (await db
    .table('syncQueue')
    .orderBy('timestamp')
    .toArray()) as unknown as SyncOperationItem[];
  /* Filter to only items that should be retried (haven't exceeded max retries
     and their backoff window has elapsed). Items still in backoff are left in
     the queue for the next sync cycle. */
  return allItems.filter((item) => shouldRetryItem(item));
}

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
export async function cleanupFailedItems(): Promise<{ count: number; tables: string[] }> {
  const db = getDb();
  const allItems = (await db.table('syncQueue').toArray()) as unknown as SyncOperationItem[];
  const failedItems = allItems.filter((item) => item.retries >= MAX_SYNC_RETRIES);

  const affectedTables = new Set<string>();

  for (const item of failedItems) {
    affectedTables.add(item.table);
    if (item.id) {
      debugWarn(`[QUEUE] Permanent failure after ${MAX_SYNC_RETRIES} retries — discarding:`, {
        table: item.table,
        operationType: item.operationType,
        entityId: item.entityId,
        field: item.field || null,
        lastRetryAt: item.lastRetryAt || item.timestamp
      });
      await db.table('syncQueue').delete(item.id);
    }
  }

  return {
    count: failedItems.length,
    tables: Array.from(affectedTables)
  };
}

// =============================================================================
// Queue Mutation Functions
// =============================================================================

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
export async function removeSyncItem(id: number): Promise<void> {
  const db = getDb();
  await db.table('syncQueue').delete(id);
}

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
export async function incrementRetry(id: number): Promise<void> {
  const db = getDb();
  const item = await db.table('syncQueue').get(id);
  if (item) {
    /* Update retry count and lastRetryAt for exponential backoff calculation.
       Note: timestamp is preserved to maintain operation ordering.
       lastRetryAt is always set to the current time so the backoff delay
       is measured from the most recent failed attempt. */
    await db.table('syncQueue').update(id, {
      retries: item.retries + 1,
      lastRetryAt: new Date().toISOString()
    });
  }
}

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
export async function getPendingEntityIds(): Promise<Set<string>> {
  const db = getDb();
  const pending = (await db.table('syncQueue').toArray()) as unknown as SyncOperationItem[];
  return new Set(pending.map((item) => item.entityId));
}

// =============================================================================
// Queue Enqueue Functions
// =============================================================================

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
export async function queueSyncOperation(
  item: Omit<SyncOperationItem, 'id' | 'timestamp' | 'retries'>
): Promise<void> {
  if (isDemoMode()) return;
  const db = getDb();
  const fullItem: SyncOperationItem = {
    ...item,
    timestamp: new Date().toISOString(),
    retries: 0
  };

  await db.table('syncQueue').add(fullItem);

  // Eagerly update pending count for instant UI feedback — the SyncStatus
  // component can immediately show the "pending" badge instead of waiting
  // until the next sync cycle completes.
  const count = await db.table('syncQueue').count();
  syncStatusStore.setPendingCount(count);
}

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
export async function queueCreateOperation(
  table: string,
  entityId: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (isDemoMode()) return;
  await queueSyncOperation({
    table,
    entityId,
    operationType: 'create',
    value: payload
  });
}

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
export async function queueDeleteOperation(table: string, entityId: string): Promise<void> {
  if (isDemoMode()) return;
  await queueSyncOperation({
    table,
    entityId,
    operationType: 'delete'
  });
}
