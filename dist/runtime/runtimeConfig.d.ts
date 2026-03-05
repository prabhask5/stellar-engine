/**
 * @fileoverview Runtime Configuration Module
 *
 * Replaces build-time `$env/static/public` with runtime config fetched from the
 * server. Config is cached in `localStorage` for instant subsequent loads and
 * offline PWA support.
 *
 * **Lifecycle:**
 *   1. On first visit, `initConfig()` fetches `/api/config` from the server.
 *   2. A valid response is persisted to `localStorage` under a prefixed key.
 *   3. On subsequent visits the cached config is returned synchronously via
 *      `getConfig()`, while a background fetch validates it against the server.
 *   4. If the network is unreachable (offline PWA), the cached config is used
 *      as-is — ensuring the app can boot without connectivity.
 *
 * **Offline detection:**
 *   The module provides a unified `isOffline()` check that combines the
 *   browser's `navigator.onLine` flag with a network reachability probe
 *   result (`probeNetworkReachability()`). The consumer app calls the probe
 *   once before `resolveRootLayout()`, and all downstream code uses
 *   `isOffline()` synchronously. The service worker can also set the offline
 *   flag early via `postMessage` → `window.__stellarOffline` bridge, so the
 *   probe returns instantly when the SW already detected a network timeout.
 *
 * @see {@link initConfig} for the async initialisation flow
 * @see {@link getConfig} for synchronous access after initialisation
 * @see {@link setConfig} for programmatic updates (e.g., after a setup wizard)
 */
declare global {
    interface Window {
        __stellarOffline?: boolean;
    }
}
/**
 * Shape of the application configuration object returned by `/api/config`.
 *
 * Contains the minimum credentials needed to initialise Supabase on the client
 * and a flag indicating whether the app has been configured at all.
 */
export interface AppConfig {
    /** The full URL of the Supabase project (e.g., `https://xyz.supabase.co`). */
    supabaseUrl: string;
    /** The public publishable key for the Supabase project. */
    supabasePublishableKey: string;
    /**
     * Whether the application has completed initial setup.
     * `false` when `/api/config` returns a "not yet configured" response.
     */
    configured: boolean;
}
/**
 * Override the localStorage key prefix used for caching config.
 *
 * Call this **before** `initConfig()` if your app uses a custom prefix
 * (e.g., `_setConfigPrefix('myapp')`).
 *
 * @param prefix - The new prefix string (e.g., `'myapp'`).
 *
 * @example
 * ```ts
 * _setConfigPrefix('myapp');
 * // localStorage key will now be "myapp_config"
 * ```
 */
export declare function _setConfigPrefix(prefix: string): void;
/**
 * Whether the app should treat itself as offline.
 *
 * Returns `true` if any of the following are true:
 *   - The last {@link probeNetworkReachability} probe failed (timeout / error).
 *   - The service worker reported a navigation timeout via `postMessage`
 *     (bridged through `window.__stellarOffline`).
 *   - `navigator.onLine` is `false`.
 *
 * This is a **synchronous** check — no network request is made. All
 * startup-path code should use this instead of raw `navigator.onLine`
 * checks or the old `isNetworkUnreachable()`.
 *
 * @returns `true` if the device is effectively offline.
 *
 * @example
 * ```ts
 * import { isOffline } from 'stellar-drive';
 *
 * if (isOffline()) {
 *   // Skip network calls, use cached data
 * }
 * ```
 *
 * @see {@link probeNetworkReachability} — async probe that sets the flag
 * @see {@link setOfflineFlag} — manual flag control (internal)
 */
export declare function isOffline(): boolean;
/**
 * Manually set the offline flag.
 *
 * Used internally by the `online` event handler and the service worker
 * message bridge. Consumer apps should not need to call this directly —
 * use {@link probeNetworkReachability} instead.
 *
 * @param value - `true` to mark offline, `false` to mark online.
 * @internal
 */
export declare function setOfflineFlag(value: boolean): void;
/**
 * Probe whether the network is actually reachable.
 *
 * `navigator.onLine` is unreliable on iOS PWA — it often reports `true` even
 * in airplane mode. This function performs a real network probe by sending a
 * `HEAD` request to `/api/config` (which bypasses the service worker, since
 * the SW skips `/api/*` routes) with a **500 ms timeout**.
 *
 * The result is stored in the module-level `_offline` flag, readable
 * synchronously via {@link isOffline}. The consumer app should call this
 * **once** before `resolveRootLayout()` so all downstream code can use
 * `isOffline()` without any network calls.
 *
 * If the service worker has already detected a network timeout (via the
 * `window.__stellarOffline` bridge), the probe returns instantly without
 * making a request.
 *
 * **Behaviour:**
 * - If `navigator.onLine` is `false`, returns `false` immediately (no probe).
 * - If already known offline (flag set), returns `false` immediately.
 * - If the `HEAD` request succeeds within 1.5s, returns `true`.
 * - If the request times out or fails, returns `false`.
 *
 * @returns `true` if the network is reachable, `false` otherwise.
 *
 * @example
 * ```ts
 * // In your root layout load function — call once before startup:
 * await probeNetworkReachability();
 * const result = await resolveRootLayout();
 * ```
 *
 * @see {@link isOffline} — synchronous check of the offline flag
 */
export declare function probeNetworkReachability(): Promise<boolean>;
/**
 * Initialise the runtime config.
 *
 * **Strategy:**
 *   1. Return the in-flight promise if already initialising (de-duplication).
 *   2. Try localStorage first for an instant, synchronous result.
 *   3. Check {@link isOffline} — if the offline flag is set (by the probe or
 *      the SW message bridge), return the cached config immediately.
 *   4. Fetch `/api/config` from the server to validate / update the cache.
 *   5. If the server says "not configured", clear any stale cache and return `null`.
 *   6. If the fetch fails, fall back to the cached config (offline PWA).
 *
 * **Important:** The consumer app must call {@link probeNetworkReachability}
 * before `resolveRootLayout()` (which calls `initConfig()`). This ensures the
 * offline flag is already set by the time we reach step 3.
 *
 * @returns A promise resolving to the `AppConfig` if the app is configured,
 *          or `null` if not yet configured / unreachable.
 *
 * @example
 * ```ts
 * const config = await initConfig();
 * if (!config) {
 *   // Redirect to setup wizard
 * }
 * ```
 */
export declare function initConfig(): Promise<AppConfig | null>;
/**
 * Get config synchronously. Returns the cached config or `null`.
 *
 * **Important:** Call {@link initConfig} first to ensure the config has been
 * loaded. This function will attempt a localStorage fallback if the in-memory
 * cache is empty, but it will *never* make a network request.
 *
 * @returns The current `AppConfig`, or `null` if not yet initialised.
 *
 * @example
 * ```ts
 * const config = getConfig();
 * if (config) {
 *   console.log(config.supabaseUrl);
 * }
 * ```
 */
export declare function getConfig(): AppConfig | null;
/**
 * Set config directly (used after the setup wizard completes).
 *
 * Updates both the in-memory cache and localStorage in a single call,
 * so subsequent `getConfig()` calls return the new value immediately.
 *
 * @param config - The new `AppConfig` to store.
 *
 * @example
 * ```ts
 * setConfig({
 *   supabaseUrl: 'https://xyz.supabase.co',
 *   supabasePublishableKey: 'eyJ...',
 *   configured: true
 * });
 * ```
 */
export declare function setConfig(config: AppConfig): void;
//# sourceMappingURL=runtimeConfig.d.ts.map