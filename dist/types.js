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
 * Type guard to check if an item is a SyncOperationItem
 */
export function isOperationItem(item) {
    return (typeof item === 'object' &&
        item !== null &&
        'operationType' in item &&
        ['increment', 'set', 'create', 'delete'].includes(item.operationType));
}
//# sourceMappingURL=types.js.map