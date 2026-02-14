/**
 * @fileoverview Stable Device Identifier Management
 *
 * Generates and persists a unique device identifier in localStorage. The ID
 * survives page reloads and browser restarts, providing a stable "fingerprint"
 * for the current browser profile.
 *
 * The device ID serves two critical roles in the sync engine:
 *   1. **Echo suppression** — Realtime subscription payloads include `device_id`,
 *      allowing the engine to skip changes that originated from this device.
 *   2. **Deterministic conflict tiebreaker** — When two operations have identical
 *      timestamps, the lexicographically lower `device_id` wins. This ensures
 *      all devices resolve the same conflict the same way.
 *
 * The localStorage key is prefixed (e.g., `myapp_device_id`) so multiple engine
 * instances on the same origin don't collide.
 *
 * @see {@link conflicts.ts#resolveByTimestamp} for the tiebreaker logic
 * @see {@link realtime.ts#isOwnDeviceChange} for echo suppression
 */
// =============================================================================
// Internal State
// =============================================================================
/** Configurable prefix for the localStorage key (default: `'stellar'`). */
let _deviceIdPrefix = 'stellar';
// =============================================================================
// Internal Helpers
// =============================================================================
/**
 * Set the prefix used for the localStorage device ID key.
 *
 * Called internally by {@link config.ts#initEngine} — not part of the
 * public API.
 *
 * @param prefix - Application-specific prefix (e.g., `'myapp'`).
 * @internal
 */
export function _setDeviceIdPrefix(prefix) {
    _deviceIdPrefix = prefix;
}
/**
 * Build the full localStorage key for the device ID.
 *
 * @returns The prefixed key string (e.g., `'myapp_device_id'`).
 */
function getDeviceIdKey() {
    return `${_deviceIdPrefix}_device_id`;
}
// =============================================================================
// Public API
// =============================================================================
/**
 * Get or create a stable device identifier for this browser/device.
 *
 * On the first call, generates a random UUID v4 and persists it to
 * localStorage. Subsequent calls return the cached value.
 *
 * Returns `'ssr-placeholder'` in SSR contexts (no localStorage) — the
 * placeholder is never used for real sync operations since the engine
 * only runs client-side.
 *
 * @returns A UUID v4 string identifying this device.
 *
 * @example
 * const id = getDeviceId(); // e.g., "a3f2b1c4-..."
 */
export function getDeviceId() {
    if (typeof localStorage === 'undefined') {
        /* SSR context — return a placeholder that won't be used for sync. */
        return 'ssr-placeholder';
    }
    let deviceId = localStorage.getItem(getDeviceIdKey());
    if (!deviceId) {
        deviceId = generateUUID();
        localStorage.setItem(getDeviceIdKey(), deviceId);
    }
    return deviceId;
}
// =============================================================================
// UUID Generation
// =============================================================================
/**
 * Generate a UUID v4 (random UUID).
 *
 * Prefers the native `crypto.randomUUID()` API (available in modern browsers
 * and Node 19+). Falls back to a manual implementation using `Math.random()`
 * for older environments.
 *
 * @returns A lowercase UUID v4 string (e.g., `"550e8400-e29b-41d4-a716-446655440000"`).
 */
function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    /*
     * Fallback for older browsers that lack crypto.randomUUID().
     * Replaces 'x' with a random hex digit and 'y' with a digit
     * constrained to the UUID v4 variant bits (8, 9, a, or b).
     */
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
//# sourceMappingURL=deviceId.js.map