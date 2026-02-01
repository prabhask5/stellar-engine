/**
 * Common utility functions for sync engine consumers.
 */

/**
 * Generate a UUID v4 (random UUID).
 */
export function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Get the current timestamp as an ISO string.
 */
export function now(): string {
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
export function calculateNewOrder<T extends { order: number }>(
  items: T[],
  fromIndex: number,
  toIndex: number
): number {
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
  let prevIndex: number;
  let nextIndex: number;

  if (fromIndex < toIndex) {
    // Moving down: the item will be placed between toIndex and toIndex + 1
    prevIndex = toIndex;
    nextIndex = toIndex + 1;
  } else {
    // Moving up: the item will be placed between toIndex - 1 and toIndex
    prevIndex = toIndex - 1;
    nextIndex = toIndex;
  }

  const prevOrder = items[prevIndex].order;
  const nextOrder = items[nextIndex].order;

  return (prevOrder + nextOrder) / 2;
}
