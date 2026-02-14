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
 * @see {@link initConfig} for the async initialisation flow
 * @see {@link getConfig} for synchronous access after initialisation
 * @see {@link setConfig} for programmatic updates (e.g., after a setup wizard)
 */
/**
 * Shape of the application configuration object returned by `/api/config`.
 *
 * Contains the minimum credentials needed to initialise Supabase on the client
 * and a flag indicating whether the app has been configured at all.
 */
export interface AppConfig {
    /** The full URL of the Supabase project (e.g., `https://xyz.supabase.co`). */
    supabaseUrl: string;
    /** The public anonymous key for the Supabase project. */
    supabaseAnonKey: string;
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
 * Initialise the runtime config.
 *
 * **Strategy:**
 *   1. Return the in-flight promise if already initialising (de-duplication).
 *   2. Try localStorage first for an instant, synchronous result.
 *   3. Fetch `/api/config` to validate / update the cached value.
 *   4. If the server says "not configured", clear any stale cache and return `null`.
 *   5. If the network is unreachable, fall back to the cached config (offline PWA).
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
 *   supabaseAnonKey: 'eyJ...',
 *   configured: true
 * });
 * ```
 */
export declare function setConfig(config: AppConfig): void;
//# sourceMappingURL=runtimeConfig.d.ts.map