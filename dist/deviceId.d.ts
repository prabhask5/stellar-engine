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
 * ## localStorage Clearing Resilience
 *
 * Some privacy-oriented browsers (e.g., Firefox with "Delete cookies and site
 * data when Firefox is closed") wipe localStorage on exit. To survive this, the
 * device ID is also backed up to a separate raw IndexedDB database named
 * `{prefix}_device_store`. On startup, `_initDeviceId()` checks both stores:
 *
 * - If localStorage has the ID → sync it to IndexedDB for backup.
 * - If localStorage was cleared but IndexedDB still has the ID → recover it
 *   back into localStorage so the device isn't treated as a new device.
 * - If neither has the ID → a fresh UUID is generated on the first
 *   {@link getDeviceId} call (same as before).
 *
 * Callers that make trust decisions (e.g., {@link isDeviceTrusted}) must
 * `await waitForDeviceId()` before calling {@link getDeviceId} to ensure
 * the recovery attempt has completed.
 *
 * @see {@link conflicts.ts#resolveByTimestamp} for the tiebreaker logic
 * @see {@link realtime.ts#isOwnDeviceChange} for echo suppression
 */
/**
 * Set the prefix used for the localStorage device ID key.
 *
 * Called internally by {@link config.ts#initEngine} — not part of the
 * public API. Kicks off the async IDB sync/recovery as a fire-and-forget
 * operation whose completion can be awaited via {@link waitForDeviceId}.
 *
 * @param prefix - Application-specific prefix (e.g., `'myapp'`).
 * @internal
 */
export declare function _setDeviceIdPrefix(prefix: string): void;
/**
 * Wait for the async device ID initialisation (IndexedDB sync/recovery) to
 * complete before reading the device ID.
 *
 * Must be awaited by any caller that makes a trust decision based on the
 * device ID, to ensure that a localStorage-cleared UUID is recovered from
 * IndexedDB before a new one is generated and persisted.
 *
 * Returns immediately (`Promise.resolve()`) if `_setDeviceIdPrefix` has not
 * been called yet (i.e., in SSR or before `initEngine()`).
 *
 * @returns A promise that resolves once recovery has completed or been skipped.
 */
export declare function waitForDeviceId(): Promise<void>;
/**
 * Get or create a stable device identifier for this browser/device.
 *
 * Returns the in-memory cached value if available. Otherwise reads from
 * localStorage, generating and persisting a new UUID v4 if none exists.
 * Newly generated IDs are also written to IndexedDB asynchronously so they
 * can be recovered if localStorage is later cleared.
 *
 * Returns `'ssr-placeholder'` in SSR contexts (no localStorage) — the
 * placeholder is never used for real sync operations since the engine
 * only runs client-side.
 *
 * **Callers that make trust decisions** should `await waitForDeviceId()`
 * before calling this function.
 *
 * @returns A UUID v4 string identifying this device.
 *
 * @example
 * const id = getDeviceId(); // e.g., "a3f2b1c4-..."
 */
export declare function getDeviceId(): string;
//# sourceMappingURL=deviceId.d.ts.map