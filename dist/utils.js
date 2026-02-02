/**
 * Common utility functions for sync engine consumers.
 */
/**
 * Convert a snake_case string to a safe camelCase identifier.
 * Strips invalid characters (keeps only alphanumeric and underscores),
 * then converts snake_case to camelCase.
 * e.g. 'goal_lists' → 'goalLists', 'goals' → 'goals', 'my-table!' → 'mytable'
 */
export function snakeToCamel(s) {
    return s.replace(/[^a-zA-Z0-9_]/g, '').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
/**
 * Generate a UUID v4 (random UUID).
 */
export function generateId() {
    return crypto.randomUUID();
}
/**
 * Get the current timestamp as an ISO string.
 */
export function now() {
    return new Date().toISOString();
}
/**
 * Calculate new order value when moving an item to a new position.
 * Uses fractional ordering to minimize updates.
 *
 * @param items - The sorted array of items with order property
 * @param fromIndex - Current index of the item being moved
 * @param toIndex - Target index where the item should be placed
 * @returns The new order value for the moved item
 */
export function calculateNewOrder(items, fromIndex, toIndex) {
    // No movement
    if (fromIndex === toIndex) {
        return items[fromIndex].order;
    }
    // Moving to the beginning
    if (toIndex === 0) {
        return items[0].order - 1;
    }
    // Moving to the end
    if (toIndex === items.length - 1) {
        return items[items.length - 1].order + 1;
    }
    // Moving between two items
    // Account for the shift that happens when removing the item from its original position
    let prevIndex;
    let nextIndex;
    if (fromIndex < toIndex) {
        // Moving down: the item will be placed between toIndex and toIndex + 1
        prevIndex = toIndex;
        nextIndex = toIndex + 1;
    }
    else {
        // Moving up: the item will be placed between toIndex - 1 and toIndex
        prevIndex = toIndex - 1;
        nextIndex = toIndex;
    }
    const prevOrder = items[prevIndex].order;
    const nextOrder = items[nextIndex].order;
    const midpoint = (prevOrder + nextOrder) / 2;
    // Guard against floating-point precision exhaustion:
    // if the midpoint collapses to either bound, nudge by a small epsilon
    if (midpoint === prevOrder || midpoint === nextOrder) {
        return prevOrder + Number.EPSILON * 100;
    }
    return midpoint;
}
//# sourceMappingURL=utils.js.map