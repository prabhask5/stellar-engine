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
/**
 * Module-level offline flag. Set by {@link probeNetworkReachability} or by the
 * service worker via the `window.__stellarOffline` bridge. Read by
 * {@link isOffline}. Reset to `false` when a probe succeeds or the browser
 * fires an `online` event.
 */
let _offline = false;
// =============================================================================
//                     OFFLINE DETECTION
// =============================================================================
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
export function isOffline() {
    if (_offline)
        return true;
    if (typeof navigator !== 'undefined' && !navigator.onLine)
        return true;
    /* Bridge: an inline script in app.html listens for the service worker's
       NETWORK_UNREACHABLE message and sets this global before JS bundles load.
       Promote it to the module flag so we don't re-check the global. */
    if (typeof window !== 'undefined' && window.__stellarOffline) {
        _offline = true;
        return true;
    }
    return false;
}
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
export function setOfflineFlag(value) {
    _offline = value;
}
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
 * If the service worker has already detected a network timeout, the probe
 * returns instantly without making a request. The SW signals this via two
 * mechanisms: a Cache API entry (`stellar-network/__status`) for cold starts,
 * and a `postMessage` → `window.__stellarOffline` bridge for warm reloads.
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
export async function probeNetworkReachability() {
    /* Fast path: navigator.onLine says we're offline */
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        _offline = true;
        return false;
    }
    /* If already known offline (set by SW message bridge or prior probe),
       skip the HEAD request. The flag is reset when a probe succeeds or
       when the browser fires an 'online' event. */
    if (_offline) {
        return false;
    }
    /* Check the SW bridge global (inline script in app.html may have set
       this before our JS bundle loaded — works for warm reloads). */
    if (typeof window !== 'undefined' && window.__stellarOffline) {
        _offline = true;
        return false;
    }
    /* Check the Cache API for a recent SW network status entry.
       On cold starts, postMessage doesn't work because the page doesn't
       exist as a client yet when the SW sends the message. So the SW also
       writes a timestamp entry to the Cache API, which IS accessible from
       both the SW and main thread regardless of timing. */
    try {
        if (typeof caches !== 'undefined') {
            const cache = await caches.open('stellar-network');
            const entry = await cache.match('/__status');
            if (entry) {
                const ts = parseInt(entry.headers.get('x-ts') || '0');
                /* Trust the entry if it was written within the last 10 seconds
                   (i.e., the SW's navigation fetch just timed out moments ago). */
                if (Date.now() - ts < 10000) {
                    _offline = true;
                    await cache.delete('/__status');
                    return false;
                }
                /* Stale entry — clean it up */
                await cache.delete('/__status');
            }
        }
    }
    catch {
        /* Cache API unavailable or error — fall through to probe */
    }
    /* Probe: send a lightweight HEAD request to /api/config which bypasses
       the service worker (SW skips /api/* routes), giving a true network check.
       1.5s timeout avoids false positives on slow connections. */
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        await fetch('/api/config', { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeoutId);
        _offline = false;
        return true;
    }
    catch {
        _offline = true;
        return false;
    }
}
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
        if (parsed.configured && parsed.supabaseUrl && parsed.supabasePublishableKey) {
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
        /* Check the offline flag (set by probeNetworkReachability() which the
           consumer calls before resolveRootLayout(), or by the SW message bridge).
           When offline, return the cached config without attempting a fetch. */
        if (isOffline()) {
            return configCache;
        }
        /* Network is reachable — fetch from server to validate/update.
           3-second timeout prevents hanging on iOS in airplane mode: iOS often
           reports navigator.onLine=true even in airplane mode, so the probe may
           not catch the offline state. Without a timeout this fetch would hang
           for ~25 seconds (OS TCP timeout) before failing. */
        try {
            const configController = new AbortController();
            const configTimeoutId = setTimeout(() => configController.abort(), 3000);
            const response = await fetch('/api/config', { signal: configController.signal });
            clearTimeout(configTimeoutId);
            if (response.ok) {
                const serverConfig = await response.json();
                if (serverConfig.configured) {
                    const config = {
                        supabaseUrl: serverConfig.supabaseUrl,
                        supabasePublishableKey: serverConfig.supabasePublishableKey,
                        configured: true,
                        ...(serverConfig.extra ? { extra: serverConfig.extra } : {})
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
            /* Network error or timeout — mark offline so downstream code skips
               further network calls, then fall back to cached config. */
            _offline = true;
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