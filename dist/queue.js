import { debugWarn } from './debug';
import { getEngineConfig } from './config';
// Max retries before giving up on a sync item
const MAX_SYNC_RETRIES = 5;
function getDb() {
    return getEngineConfig().db;
}
/**
 * Coalesce multiple operations to the same entity into fewer operations.
 * This dramatically reduces the number of server requests and data transfer.
 *
 * PERFORMANCE OPTIMIZED:
 * - Single DB fetch at start (no re-fetching between phases)
 * - All processing done in memory
 * - Batch deletes and updates at the end
 */
export async function coalescePendingOps() {
    const db = getDb();
    const allItems = (await db.table('syncQueue').toArray());
    if (allItems.length <= 1)
        return 0;
    // Track changes in memory - apply in batch at the end
    const idsToDelete = new Set();
    const itemUpdates = new Map();
    // Track which items are still "alive" (not marked for deletion)
    const isAlive = (item) => item.id !== undefined && !idsToDelete.has(item.id);
    // Helper to mark item for deletion
    const markDeleted = (item) => {
        if (item.id !== undefined)
            idsToDelete.add(item.id);
    };
    // Helper to mark item for update
    const markUpdated = (item, updates) => {
        if (item.id !== undefined) {
            const existing = itemUpdates.get(item.id) || {};
            itemUpdates.set(item.id, { ...existing, ...updates });
        }
    };
    // Helper to get effective value (considering pending updates)
    const getEffectiveValue = (item) => {
        if (item.id !== undefined && itemUpdates.has(item.id)) {
            return itemUpdates.get(item.id).value ?? item.value;
        }
        return item.value;
    };
    // === STEP 1: Group all operations by entity ===
    const entityGroups = new Map();
    for (const item of allItems) {
        const key = `${item.table}:${item.entityId}`;
        if (!entityGroups.has(key))
            entityGroups.set(key, []);
        entityGroups.get(key).push(item);
    }
    // === STEP 2: Process each entity group ===
    for (const [, items] of entityGroups) {
        // Sort by timestamp to understand the sequence
        items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const hasCreate = items.some((i) => i.operationType === 'create');
        const hasDelete = items.some((i) => i.operationType === 'delete');
        // Case 1: CREATE followed eventually by DELETE -> cancel everything for this entity
        if (hasCreate && hasDelete) {
            for (const item of items) {
                markDeleted(item);
            }
            continue;
        }
        // Case 2: No CREATE but has DELETE -> remove all non-delete operations
        if (!hasCreate && hasDelete) {
            for (const item of items) {
                if (item.operationType !== 'delete') {
                    markDeleted(item);
                }
            }
            continue;
        }
        // Case 3: Has CREATE but no DELETE -> merge all updates/sets into create
        if (hasCreate && !hasDelete) {
            const createItem = items.find((i) => i.operationType === 'create');
            const otherItems = items.filter((i) => i.operationType !== 'create');
            if (createItem && otherItems.length > 0) {
                let mergedPayload = { ...createItem.value };
                for (const item of otherItems) {
                    if (item.operationType === 'set') {
                        if (item.field) {
                            mergedPayload[item.field] = item.value;
                        }
                        else if (typeof item.value === 'object' && item.value !== null) {
                            mergedPayload = { ...mergedPayload, ...item.value };
                        }
                    }
                    else if (item.operationType === 'increment' && item.field) {
                        const currentVal = typeof mergedPayload[item.field] === 'number'
                            ? mergedPayload[item.field]
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
        // Case 4: No create, no delete - handle increment/set interactions and same-type coalescing
        processFieldOperations(items, markDeleted, markUpdated);
    }
    // === STEP 3: Coalesce remaining INCREMENT operations (not yet deleted) ===
    const incrementGroups = new Map();
    for (const item of allItems) {
        if (item.operationType === 'increment' && item.field && isAlive(item)) {
            const key = `${item.table}:${item.entityId}:${item.field}`;
            if (!incrementGroups.has(key))
                incrementGroups.set(key, []);
            incrementGroups.get(key).push(item);
        }
    }
    for (const [, items] of incrementGroups) {
        const aliveItems = items.filter(isAlive);
        if (aliveItems.length <= 1)
            continue;
        aliveItems.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        let totalDelta = 0;
        for (const item of aliveItems) {
            const effectiveValue = getEffectiveValue(item);
            const delta = typeof effectiveValue === 'number' ? effectiveValue : 0;
            totalDelta += delta;
        }
        const oldestItem = aliveItems[0];
        markUpdated(oldestItem, { value: totalDelta });
        for (let i = 1; i < aliveItems.length; i++) {
            markDeleted(aliveItems[i]);
        }
    }
    // === STEP 4: Coalesce remaining SET operations (not yet deleted) ===
    const setGroups = new Map();
    for (const item of allItems) {
        if (item.operationType === 'set' && isAlive(item)) {
            const key = `${item.table}:${item.entityId}`;
            if (!setGroups.has(key))
                setGroups.set(key, []);
            setGroups.get(key).push(item);
        }
    }
    for (const [, items] of setGroups) {
        const aliveItems = items.filter(isAlive);
        if (aliveItems.length <= 1)
            continue;
        aliveItems.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        let mergedValue = {};
        for (const item of aliveItems) {
            const effectiveValue = getEffectiveValue(item);
            if (item.field) {
                mergedValue[item.field] = effectiveValue;
            }
            else if (typeof effectiveValue === 'object' && effectiveValue !== null) {
                mergedValue = { ...mergedValue, ...effectiveValue };
            }
        }
        const oldestItem = aliveItems[0];
        markUpdated(oldestItem, { value: mergedValue, field: undefined });
        for (let i = 1; i < aliveItems.length; i++) {
            markDeleted(aliveItems[i]);
        }
    }
    // === STEP 5: Remove no-op operations ===
    for (const item of allItems) {
        if (!isAlive(item))
            continue;
        let shouldDelete = false;
        const effectiveValue = getEffectiveValue(item);
        // Zero-delta increments are no-ops
        if (item.operationType === 'increment') {
            const delta = typeof effectiveValue === 'number' ? effectiveValue : 0;
            if (delta === 0) {
                shouldDelete = true;
            }
        }
        // Empty sets or sets with only updated_at are no-ops
        if (item.operationType === 'set') {
            const pendingUpdate = item.id !== undefined ? itemUpdates.get(item.id) : undefined;
            const effectiveField = pendingUpdate?.field !== undefined ? pendingUpdate.field : item.field;
            if (effectiveField) {
                if (effectiveField === 'updated_at') {
                    shouldDelete = true;
                }
            }
            else if (typeof effectiveValue === 'object' && effectiveValue !== null) {
                const payload = effectiveValue;
                const keys = Object.keys(payload).filter((k) => k !== 'updated_at');
                if (keys.length === 0) {
                    shouldDelete = true;
                }
            }
            else if (effectiveValue === undefined || effectiveValue === null) {
                shouldDelete = true;
            }
        }
        if (shouldDelete) {
            markDeleted(item);
        }
    }
    // === STEP 6: Apply all changes in batch ===
    const deleteIds = Array.from(idsToDelete);
    // Filter out updates for items we're deleting
    const finalUpdates = [];
    for (const [id, changes] of itemUpdates) {
        if (!idsToDelete.has(id)) {
            finalUpdates.push({ id, changes });
        }
    }
    const syncQueue = db.table('syncQueue');
    // Batch delete
    if (deleteIds.length > 0) {
        await syncQueue.bulkDelete(deleteIds);
    }
    // Batch update (Dexie doesn't have bulkUpdate, so we use a transaction)
    if (finalUpdates.length > 0) {
        await db.transaction('rw', syncQueue, async () => {
            for (const { id, changes } of finalUpdates) {
                await syncQueue.update(id, changes);
            }
        });
    }
    return deleteIds.length;
}
/**
 * Process increment/set interactions for the same field within an entity (in-memory).
 */
function processFieldOperations(items, markDeleted, markUpdated) {
    // Group by field
    const fieldGroups = new Map();
    for (const item of items) {
        if (item.field && (item.operationType === 'increment' || item.operationType === 'set')) {
            const key = item.field;
            if (!fieldGroups.has(key))
                fieldGroups.set(key, []);
            fieldGroups.get(key).push(item);
        }
    }
    for (const [, fieldItems] of fieldGroups) {
        if (fieldItems.length <= 1)
            continue;
        // Sort by timestamp
        fieldItems.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        const hasIncrement = fieldItems.some((i) => i.operationType === 'increment');
        const hasSet = fieldItems.some((i) => i.operationType === 'set');
        if (hasIncrement && hasSet) {
            // Find the last set operation
            const lastSetIndex = fieldItems.map((i) => i.operationType).lastIndexOf('set');
            const lastSet = fieldItems[lastSetIndex];
            // Check if there are increments AFTER the last set
            const incrementsAfterSet = fieldItems
                .slice(lastSetIndex + 1)
                .filter((i) => i.operationType === 'increment');
            if (incrementsAfterSet.length > 0) {
                // SET followed by INCREMENT(s): sum increments and add to set value
                let totalDelta = 0;
                for (const inc of incrementsAfterSet) {
                    totalDelta += typeof inc.value === 'number' ? inc.value : 0;
                }
                const baseValue = typeof lastSet.value === 'number' ? lastSet.value : 0;
                const finalValue = baseValue + totalDelta;
                markUpdated(lastSet, { value: finalValue });
                // Delete all increments after the set
                for (const inc of incrementsAfterSet) {
                    markDeleted(inc);
                }
            }
            // Delete all operations BEFORE the last set (they're overwritten anyway)
            const itemsBeforeLastSet = fieldItems.slice(0, lastSetIndex);
            for (const item of itemsBeforeLastSet) {
                markDeleted(item);
            }
        }
    }
}
// Exponential backoff: check if item should be retried based on retry count
// Returns true if enough time has passed since last attempt
function shouldRetryItem(item) {
    if (item.retries >= MAX_SYNC_RETRIES)
        return false;
    // First attempt (retries=0) is always immediate
    if (item.retries === 0)
        return true;
    // Exponential backoff for retries: 2^(retries-1) seconds (1s, 2s, 4s, 8s)
    const backoffMs = Math.pow(2, item.retries - 1) * 1000;
    const lastAttempt = new Date(item.lastRetryAt || item.timestamp).getTime();
    const now = Date.now();
    return now - lastAttempt >= backoffMs;
}
export async function getPendingSync() {
    const db = getDb();
    const allItems = (await db.table('syncQueue')
        .orderBy('timestamp')
        .toArray());
    // Filter to only items that should be retried (haven't exceeded max retries and backoff has passed)
    return allItems.filter((item) => shouldRetryItem(item));
}
// Remove items that have exceeded max retries and return details for notification
export async function cleanupFailedItems() {
    const db = getDb();
    const allItems = (await db.table('syncQueue').toArray());
    const failedItems = allItems.filter((item) => item.retries >= MAX_SYNC_RETRIES);
    const affectedTables = new Set();
    for (const item of failedItems) {
        affectedTables.add(item.table);
        if (item.id) {
            debugWarn(`Sync item permanently failed after ${MAX_SYNC_RETRIES} retries:`, {
                table: item.table,
                operationType: item.operationType,
                entityId: item.entityId
            });
            await db.table('syncQueue').delete(item.id);
        }
    }
    return {
        count: failedItems.length,
        tables: Array.from(affectedTables)
    };
}
export async function removeSyncItem(id) {
    const db = getDb();
    await db.table('syncQueue').delete(id);
}
export async function incrementRetry(id) {
    const db = getDb();
    const item = await db.table('syncQueue').get(id);
    if (item) {
        // Update retry count and lastRetryAt for exponential backoff calculation
        // Note: timestamp is preserved to maintain operation ordering
        await db.table('syncQueue').update(id, {
            retries: item.retries + 1,
            lastRetryAt: new Date().toISOString()
        });
    }
}
// Get entity IDs that have pending sync operations
export async function getPendingEntityIds() {
    const db = getDb();
    const pending = (await db.table('syncQueue').toArray());
    return new Set(pending.map((item) => item.entityId));
}
/**
 * Queue a sync operation using the intent-based format.
 */
export async function queueSyncOperation(item) {
    const db = getDb();
    const fullItem = {
        ...item,
        timestamp: new Date().toISOString(),
        retries: 0
    };
    await db.table('syncQueue').add(fullItem);
}
/**
 * Helper to queue a create operation.
 */
export async function queueCreateOperation(table, entityId, payload) {
    await queueSyncOperation({
        table,
        entityId,
        operationType: 'create',
        value: payload
    });
}
/**
 * Helper to queue a delete operation.
 */
export async function queueDeleteOperation(table, entityId) {
    await queueSyncOperation({
        table,
        entityId,
        operationType: 'delete'
    });
}
//# sourceMappingURL=queue.js.map