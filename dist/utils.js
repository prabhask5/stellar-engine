/**
 * @fileoverview Common Utility Functions
 *
 * Small, pure helper functions used across the sync engine and exposed
 * to consumers via the `@prabhask5/stellar-engine/utils` subpath export.
 *
 * All functions in this module are side-effect-free and safe to call in
 * both browser and SSR contexts.
 */
// =============================================================================
// String Utilities
// =============================================================================
/**
 * Convert a `snake_case` string to a safe `camelCase` identifier.
 *
 * First strips any characters that are not alphanumeric or underscores,
 * then converts underscore-separated words to camelCase.
 *
 * Used internally to derive Dexie (IndexedDB) table names from Supabase
 * snake_case table names.
 *
 * @param s - The snake_case string to convert.
 * @returns The camelCase equivalent.
 *
 * @example
 * snakeToCamel('goal_lists');  // → 'goalLists'
 * snakeToCamel('goals');       // → 'goals'
 * snakeToCamel('my-table!');   // → 'mytable' (invalid chars stripped first)
 */
export function snakeToCamel(s) {
    return s.replace(/[^a-zA-Z0-9_]/g, '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
// =============================================================================
// ID Generation
// =============================================================================
/**
 * Generate a UUID v4 (random UUID) using the native Web Crypto API.
 *
 * Suitable for entity primary keys, device IDs, and any context where
 * a universally unique identifier is needed.
 *
 * @returns A lowercase UUID v4 string (e.g., `"550e8400-e29b-41d4-a716-446655440000"`).
 */
export function generateId() {
    return crypto.randomUUID();
}
// =============================================================================
// Timestamp Utilities
// =============================================================================
/**
 * Get the current timestamp as an ISO 8601 string.
 *
 * Convenience wrapper around `new Date().toISOString()` used as the
 * default value for `created_at`, `updated_at`, and sync operation
 * timestamps throughout the engine.
 *
 * @returns An ISO 8601 timestamp string (e.g., `"2025-01-15T12:30:00.000Z"`).
 */
export function now() {
    return new Date().toISOString();
}
// =============================================================================
// Ordering Utilities
// =============================================================================
/**
 * Calculate a new `order` value when moving an item to a different position.
 *
 * Uses **fractional ordering** so that only the moved item's `order` value
 * changes — no need to re-index the entire list. The new value is placed
 * at the midpoint between its new neighbours.
 *
 * Includes a guard against floating-point precision exhaustion: if the
 * midpoint collapses to either bound, a small epsilon nudge is applied
 * instead. In practice, precision issues only arise after ~50 consecutive
 * moves between the same two items.
 *
 * @typeParam T - Any object with a numeric `order` property.
 * @param items     - The sorted array of items (by `order`, ascending).
 * @param fromIndex - Current index of the item being moved.
 * @param toIndex   - Target index where the item should be placed.
 * @returns The new `order` value for the moved item.
 *
 * @example
 * const items = [{ order: 1 }, { order: 2 }, { order: 3 }];
 * calculateNewOrder(items, 2, 0); // → 0 (before the first item)
 * calculateNewOrder(items, 0, 1); // → 2.5 (between items[1] and items[2])
 */
// =============================================================================
// Formatting Utilities
// =============================================================================
/**
 * Format a byte count into a human-readable string (B, KB, or MB).
 *
 * @param bytes - Raw byte count
 * @returns Formatted string like `"1.23 KB"` or `"456 B"`
 *
 * @example
 * formatBytes(512);        // → '512 B'
 * formatBytes(2048);       // → '2.00 KB'
 * formatBytes(1572864);    // → '1.50 MB'
 */
export function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
// =============================================================================
// Ordering Utilities
// =============================================================================
export function calculateNewOrder(items, fromIndex, toIndex) {
    /* No movement — return the item's existing order. */
    if (fromIndex === toIndex) {
        return items[fromIndex].order;
    }
    /* Moving to the beginning — place 1 unit before the current first item. */
    if (toIndex === 0) {
        return items[0].order - 1;
    }
    /* Moving to the end — place 1 unit after the current last item. */
    if (toIndex === items.length - 1) {
        return items[items.length - 1].order + 1;
    }
    /*
     * Moving between two existing items.
     * Account for the index shift that occurs when the item is removed
     * from its original position before being re-inserted.
     */
    let prevIndex;
    let nextIndex;
    if (fromIndex < toIndex) {
        /* Moving down: the item lands between toIndex and toIndex + 1. */
        prevIndex = toIndex;
        nextIndex = toIndex + 1;
    }
    else {
        /* Moving up: the item lands between toIndex - 1 and toIndex. */
        prevIndex = toIndex - 1;
        nextIndex = toIndex;
    }
    const prevOrder = items[prevIndex].order;
    const nextOrder = items[nextIndex].order;
    const midpoint = (prevOrder + nextOrder) / 2;
    /*
     * Guard against floating-point precision exhaustion:
     * If the midpoint collapses to either bound (i.e., they're so close
     * that IEEE 754 can't represent a value between them), nudge by a
     * small epsilon instead.
     */
    if (midpoint === prevOrder || midpoint === nextOrder) {
        return prevOrder + Number.EPSILON * 100;
    }
    return midpoint;
}
//# sourceMappingURL=utils.js.map