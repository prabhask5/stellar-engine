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
/**
 * Set the prefix used for the localStorage device ID key.
 *
 * Called internally by {@link config.ts#initEngine} — not part of the
 * public API.
 *
 * @param prefix - Application-specific prefix (e.g., `'myapp'`).
 * @internal
 */
export declare function _setDeviceIdPrefix(prefix: string): void;
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
export declare function getDeviceId(): string;
//# sourceMappingURL=deviceId.d.ts.map