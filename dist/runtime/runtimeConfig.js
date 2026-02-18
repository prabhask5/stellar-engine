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
// =============================================================================
//                        CACHE KEY PREFIX
// =============================================================================
/**
 * Prefix used for the localStorage cache key. Defaults to `'stellar'` but can
 * be overridden per-app via {@link _setConfigPrefix} so multiple stellar-drive
 * apps on the same origin don't collide.
 */
let _prefix = 'stellar';
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
export function _setConfigPrefix(prefix) {
    _prefix = prefix;
}
/**
 * Build the localStorage key for the cached config.
 *
 * @returns The fully-qualified cache key (e.g., `"stellar_config"`).
 */
function getCacheKey() {
    return `${_prefix}_config`;
}
// =============================================================================
//                       IN-MEMORY CACHE STATE
// =============================================================================
/**
 * In-memory config singleton — populated by `initConfig()` or `setConfig()`.
 * Avoids repeated JSON parsing from localStorage on every `getConfig()` call.
 */
let configCache = null;
/**
 * De-duplication guard for `initConfig()`. Stores the in-flight promise so
 * concurrent callers share a single network request instead of racing.
 */
let configPromise = null;
// =============================================================================
//                     LOCAL STORAGE HELPERS
// =============================================================================
/**
 * Load config from localStorage (synchronous, instant).
 *
 * Performs basic validation to reject malformed or incomplete entries —
 * the stored value must have `configured: true` and both Supabase fields
 * populated.
 *
 * @returns The cached `AppConfig` if valid, or `null` if missing / invalid.
 */
function loadFromCache() {
    /* Guard for SSR / environments without localStorage */
    if (typeof localStorage === 'undefined')
        return null;
    try {
        const stored = localStorage.getItem(getCacheKey());
        if (!stored)
            return null;
        const parsed = JSON.parse(stored);
        if (parsed.configured &&
            parsed.supabaseUrl &&
            parsed.supabasePublishableKey &&
            parsed.appDomain) {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Persist config to localStorage for instant access on next page load.
 *
 * Silently swallows errors (e.g., storage quota exceeded, private browsing
 * restrictions) because localStorage is a convenience cache, not a
 * requirement.
 *
 * @param config - The `AppConfig` to persist.
 */
function saveToCache(config) {
    if (typeof localStorage === 'undefined')
        return;
    try {
        localStorage.setItem(getCacheKey(), JSON.stringify(config));
    }
    catch {
        /* Storage full or unavailable — non-critical */
    }
}
// =============================================================================
//                      INITIALISATION (ASYNC)
// =============================================================================
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
export async function initConfig() {
    /* Return in-flight promise if already initializing */
    if (configPromise)
        return configPromise;
    configPromise = (async () => {
        /* Try localStorage first for instant load */
        const cached = loadFromCache();
        if (cached) {
            configCache = cached;
        }
        /* Fetch from server to validate/update */
        try {
            const response = await fetch('/api/config');
            if (response.ok) {
                const serverConfig = await response.json();
                if (serverConfig.configured) {
                    const config = {
                        supabaseUrl: serverConfig.supabaseUrl,
                        supabasePublishableKey: serverConfig.supabasePublishableKey,
                        appDomain: serverConfig.appDomain,
                        configured: true
                    };
                    configCache = config;
                    saveToCache(config);
                    return config;
                }
                else {
                    /* Server says not configured — clear any stale cache */
                    configCache = null;
                    clearConfigCache();
                    return null;
                }
            }
        }
        catch {
            /* Network error — use cached config if available (offline PWA support) */
            if (configCache) {
                return configCache;
            }
        }
        return configCache;
    })();
    const result = await configPromise;
    /* Reset the guard so future calls can re-fetch if needed */
    configPromise = null;
    return result;
}
// =============================================================================
//                     SYNCHRONOUS ACCESS
// =============================================================================
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
export function getConfig() {
    if (configCache)
        return configCache;
    /* Try localStorage as fallback */
    const cached = loadFromCache();
    if (cached) {
        configCache = cached;
    }
    return configCache;
}
// =============================================================================
//                     PROGRAMMATIC UPDATE
// =============================================================================
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
export function setConfig(config) {
    configCache = config;
    saveToCache(config);
}
// =============================================================================
//                        CACHE INVALIDATION
// =============================================================================
/**
 * Clear the cached config from both in-memory state and localStorage.
 *
 * Called internally when the server reports `configured: false` to ensure
 * stale credentials are not reused on next load.
 */
function clearConfigCache() {
    configCache = null;
    if (typeof localStorage !== 'undefined') {
        try {
            localStorage.removeItem(getCacheKey());
        }
        catch {
            /* Ignore — non-critical */
        }
    }
}
//# sourceMappingURL=runtimeConfig.js.map