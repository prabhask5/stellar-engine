/**
 * Common utility functions for sync engine consumers.
 */
/**
 * Generate a UUID v4 (random UUID).
 */
export declare function generateId(): string;
/**
 * Get the current timestamp as an ISO string.
 */
export declare function now(): string;
/**
 * Calculate new order value when moving an item to a new position.
 * Uses fractional ordering to minimize updates.
 *
 * @param items - The sorted array of items with order property
 * @param fromIndex - Current index of the item being moved
 * @param toIndex - Target index where the item should be placed
 * @returns The new order value for the moved item
 */
export declare function calculateNewOrder<T extends {
    order: number;
}>(items: T[], fromIndex: number, toIndex: number): number;
//# sourceMappingURL=utils.d.ts.map