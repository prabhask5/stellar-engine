/**
 * Runtime Configuration Module
 *
 * Replaces build-time $env/static/public with runtime config fetched from the server.
 * Config is cached in localStorage for instant subsequent loads and offline PWA support.
 */
let _prefix = 'stellar';
export function _setConfigPrefix(prefix) {
    _prefix = prefix;
}
function getCacheKey() {
    return `${_prefix}_config`;
}
let configCache = null;
let configPromise = null;
/**
 * Get cached config from localStorage (synchronous, instant)
 */
function loadFromCache() {
    if (typeof localStorage === 'undefined')
        return null;
    try {
        const stored = localStorage.getItem(getCacheKey());
        if (!stored)
            return null;
        const parsed = JSON.parse(stored);
        if (parsed.configured && parsed.supabaseUrl && parsed.supabaseAnonKey) {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Save config to localStorage cache
 */
function saveToCache(config) {
    if (typeof localStorage === 'undefined')
        return;
    try {
        localStorage.setItem(getCacheKey(), JSON.stringify(config));
    }
    catch {
        // Storage full or unavailable
    }
}
/**
 * Initialize config: tries localStorage first (instant), then validates against server.
 * Returns the config if configured, null if not.
 */
export async function initConfig() {
    // Return in-flight promise if already initializing
    if (configPromise)
        return configPromise;
    configPromise = (async () => {
        // Try localStorage first for instant load
        const cached = loadFromCache();
        if (cached) {
            configCache = cached;
        }
        // Fetch from server to validate/update
        try {
            const response = await fetch('/api/config');
            if (response.ok) {
                const serverConfig = await response.json();
                if (serverConfig.configured) {
                    const config = {
                        supabaseUrl: serverConfig.supabaseUrl,
                        supabaseAnonKey: serverConfig.supabaseAnonKey,
                        configured: true
                    };
                    configCache = config;
                    saveToCache(config);
                    return config;
                }
                else {
                    // Server says not configured — clear any stale cache
                    configCache = null;
                    clearConfigCache();
                    return null;
                }
            }
        }
        catch {
            // Network error — use cached config if available (offline PWA support)
            if (configCache) {
                return configCache;
            }
        }
        return configCache;
    })();
    const result = await configPromise;
    configPromise = null;
    return result;
}
/**
 * Get config synchronously. Returns cached config or null.
 * Call initConfig() first to ensure config is loaded.
 */
export function getConfig() {
    if (configCache)
        return configCache;
    // Try localStorage as fallback
    const cached = loadFromCache();
    if (cached) {
        configCache = cached;
    }
    return configCache;
}
/**
 * Set config directly (used after setup wizard completes)
 */
export function setConfig(config) {
    configCache = config;
    saveToCache(config);
}
/**
 * Clear cached config from localStorage
 */
function clearConfigCache() {
    configCache = null;
    if (typeof localStorage !== 'undefined') {
        try {
            localStorage.removeItem(getCacheKey());
        }
        catch {
            // Ignore
        }
    }
}
//# sourceMappingURL=runtimeConfig.js.map