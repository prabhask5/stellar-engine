/**
 * @fileoverview Supabase Client — Lazy Initialization via ES Proxy
 *
 * This module exports a single `supabase` constant that looks and behaves
 * exactly like a `SupabaseClient` instance, but is actually an ES `Proxy`
 * that defers client creation until the **first property access**. This
 * "lazy singleton" pattern solves a critical bootstrapping problem:
 *
 *   The Supabase URL and anon key are loaded at **runtime** (via
 *   `getConfig()` from `../runtime/runtimeConfig`), not at build time.
 *   Modules that `import { supabase }` at the top level would otherwise
 *   crash because the config has not been initialized yet when the import
 *   executes.
 *
 * How the Proxy pattern works:
 *   1. `supabase` is exported as `new Proxy({} as SupabaseClient, handler)`.
 *   2. The handler's `get` trap intercepts every property access (e.g.
 *      `supabase.auth`, `supabase.from(...)`).
 *   3. On first access, `getOrCreateClient()` reads the runtime config and
 *      calls `createClient(url, key, options)` to build the real client.
 *   4. The real client is cached in a module-level `realClient` variable;
 *      subsequent accesses reuse it (standard singleton).
 *   5. Function values are `.bind(client)` to preserve `this` context.
 *
 * Additional responsibilities:
 *   - **Corrupted session cleanup**: Before the client is created, any
 *     malformed `sb-*` entries in localStorage are detected and removed to
 *     prevent "can't access property 'hash'" runtime errors.
 *   - **Unhandled rejection handler**: A global listener catches Supabase
 *     auth errors that escape normal error handling, clears storage, and
 *     performs a single guarded page reload to recover.
 *   - **iOS PWA detection**: The client sends a custom `x-client-info`
 *     header indicating whether it is running as a standalone PWA on iOS,
 *     which helps with server-side debugging of session eviction issues.
 *
 * Security considerations:
 *   - The anon key is a **public** key (safe to include in client bundles).
 *   - PKCE flow is used instead of the implicit flow for stronger OAuth
 *     security and better compatibility with PWA environments.
 *   - Session persistence uses localStorage; the module proactively scrubs
 *     corrupted entries to prevent denial-of-service via bad local state.
 *
 * @module supabase/client
 */
import { createClient } from '@supabase/supabase-js';
import { getConfig } from '../runtime/runtimeConfig';
import { debugLog, debugWarn, debugError } from '../debug';
import { isDemoMode } from '../demo';
// =============================================================================
// SECTION: Client Prefix Configuration
// =============================================================================
/**
 * Prefix used for the Supabase `storageKey` and custom headers.
 * Defaults to `'stellar'`; can be overridden by the host application
 * via {@link _setClientPrefix} before the client is first accessed.
 */
let _prefix = 'stellar';
/**
 * Override the storage key prefix used by the Supabase client.
 *
 * Must be called **before** the first access to the `supabase` export,
 * since the prefix is baked into the client options at creation time.
 *
 * @param prefix - The new prefix string (e.g. the app's name).
 *
 * @example
 * ```ts
 * _setClientPrefix('myapp');
 * // Later accesses will use storageKey 'myapp-auth'
 * ```
 */
export function _setClientPrefix(prefix) {
    _prefix = prefix;
}
// =============================================================================
// SECTION: Corrupted Session Cleanup
// =============================================================================
/**
 * Scan localStorage for corrupted Supabase auth entries and remove them.
 *
 * Supabase stores session data under keys prefixed with `sb-`. If the
 * browser was closed mid-write, or if a bug produced malformed JSON, these
 * entries can cause runtime errors like "can't access property 'hash' of
 * undefined" on the next page load.
 *
 * This function runs **once** at module evaluation time (before the client
 * is created) and acts as a defensive self-healing mechanism.
 *
 * @internal
 */
function clearCorruptedAuthData() {
    if (typeof localStorage === 'undefined')
        return;
    try {
        // Supabase stores auth data with keys starting with 'sb-'
        const keysToCheck = Object.keys(localStorage).filter((key) => key.startsWith('sb-'));
        for (const key of keysToCheck) {
            const value = localStorage.getItem(key);
            if (value) {
                try {
                    const parsed = JSON.parse(value);
                    // Validate the parsed data has expected structure
                    if (parsed && typeof parsed === 'object') {
                        // Check for signs of corruption
                        const hasCorruptedSession = 
                        // currentSession exists but missing required fields
                        (parsed.currentSession && typeof parsed.currentSession !== 'object') ||
                            // access_token exists but is not a string
                            (parsed.access_token !== undefined && typeof parsed.access_token !== 'string') ||
                            // expires_at exists but is not a number
                            (parsed.expires_at !== undefined && typeof parsed.expires_at !== 'number');
                        if (hasCorruptedSession) {
                            debugWarn('[Auth] Clearing corrupted session data:', key);
                            localStorage.removeItem(key);
                        }
                    }
                }
                catch {
                    /* JSON.parse failed — the stored value is not valid JSON, which
                       means the data was partially written or otherwise corrupted.
                       Removing it is the safest recovery action. */
                    debugWarn('[Auth] Clearing malformed session data:', key);
                    localStorage.removeItem(key);
                }
            }
        }
    }
    catch (e) {
        debugError('[Auth] Error checking localStorage:', e);
    }
}
// =============================================================================
// SECTION: Global Error Recovery
// =============================================================================
/* Register a global unhandled-rejection handler that catches Supabase auth
   errors which escape normal try/catch boundaries. This is a last-resort
   recovery mechanism: clear the corrupted storage and reload once. A
   sessionStorage flag (`__stellar_auth_reload`) guards against reload loops. */
if (typeof window !== 'undefined') {
    // Clear reload guard on successful startup (app loaded without crashing)
    try {
        sessionStorage.removeItem('__stellar_auth_reload');
    }
    catch {
        // Ignore storage errors
    }
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        // Check if this is a Supabase auth error
        if (reason && typeof reason === 'object' && 'message' in reason) {
            const message = String(reason.message || '');
            if (message.includes('hash') || message.includes("can't access property")) {
                debugWarn('[Auth] Caught unhandled auth error, clearing storage');
                event.preventDefault(); // Prevent the error from showing in console
                // Clear Supabase storage
                try {
                    const keys = Object.keys(localStorage).filter((k) => k.startsWith('sb-'));
                    keys.forEach((k) => localStorage.removeItem(k));
                    /* Guard against reload loop: only reload once per browser session.
                       Without this guard, a persistent error could cause infinite reloads. */
                    if (!sessionStorage.getItem('__stellar_auth_reload')) {
                        sessionStorage.setItem('__stellar_auth_reload', '1');
                        window.location.reload();
                    }
                }
                catch {
                    // Ignore storage errors
                }
            }
        }
    });
}
// =============================================================================
// SECTION: Module-Level Initialization
// =============================================================================
/* Run the corruption cleanup synchronously at module load time, before any
   code can attempt to read the (potentially corrupted) session data. */
clearCorruptedAuthData();
/**
 * Detect if the app is running as an iOS PWA (standalone mode).
 *
 * iOS PWAs have unique session-persistence challenges: Safari's
 * Intelligent Tracking Prevention (ITP) and aggressive localStorage
 * eviction can cause sessions to disappear unexpectedly. Knowing we are
 * in this environment lets us log more aggressively and send a custom
 * header for server-side debugging.
 */
const isIOSPWA = typeof window !== 'undefined' &&
    // @ts-expect-error - navigator.standalone is iOS-specific
    (window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches);
if (isIOSPWA) {
    debugLog('[Auth] Running as iOS PWA - using enhanced auth persistence');
}
// =============================================================================
// SECTION: Lazy Singleton Client
// =============================================================================
/** The cached SupabaseClient instance, created on first access. */
let realClient = null;
/**
 * Create (or return the cached) SupabaseClient instance.
 *
 * On first invocation this reads the runtime config, constructs the client
 * with appropriate auth options, and wires up an `onAuthStateChange`
 * listener for debug logging. Subsequent calls return the cached instance.
 *
 * Client configuration highlights:
 * - `persistSession: true` — sessions survive page reloads via localStorage.
 * - `autoRefreshToken: true` — the SDK refreshes tokens before they expire.
 * - `flowType: 'pkce'` — PKCE is more secure than the implicit flow and
 *   works better with PWA and mobile browser environments.
 * - `storageKey: '{prefix}-auth'` — namespaced to avoid collisions when
 *   multiple Supabase-backed apps share the same origin.
 *
 * @returns The fully-initialized `SupabaseClient`.
 *
 * @internal Called exclusively by the Proxy `get` trap below.
 */
function getOrCreateClient() {
    if (realClient)
        return realClient;
    /* In demo mode, create a placeholder client that won't make real API calls.
       The sync engine, queue, and realtime guards prevent any actual Supabase
       usage, but some code paths may still access the client proxy. */
    if (isDemoMode()) {
        debugLog('[Auth] Demo mode active — creating placeholder Supabase client (no real connections)');
        realClient = createClient('https://placeholder.supabase.co', 'placeholder', {
            auth: { persistSession: false, autoRefreshToken: false }
        });
        return realClient;
    }
    const config = getConfig();
    const url = config?.supabaseUrl || 'https://placeholder.supabase.co';
    const key = config?.supabaseAnonKey || 'placeholder';
    if (!config) {
        debugWarn('Supabase config not loaded yet. Call initConfig() before using supabase client.');
    }
    realClient = createClient(url, key, {
        auth: {
            // Use localStorage for persistence (default, but explicit for clarity)
            persistSession: true,
            // Auto-refresh tokens before they expire
            autoRefreshToken: true,
            // Detect session from URL (for OAuth redirects)
            detectSessionInUrl: true,
            // Storage key prefix
            storageKey: `${_prefix}-auth`,
            // Flow type - PKCE is more secure and works better with PWAs
            flowType: 'pkce'
        },
        global: {
            // Add custom headers to help debug PWA issues
            headers: {
                'x-client-info': isIOSPWA ? `${_prefix}-ios-pwa` : `${_prefix}-web`
            }
        }
    });
    // Set up auth state change listener to log auth events (helps debug PWA issues)
    if (typeof window !== 'undefined') {
        realClient.auth.onAuthStateChange((event, session) => {
            debugLog(`[Auth] State change: ${event}`, session ? `User: ${session.user?.id}` : 'No session');
            /* iOS PWAs can lose sessions silently when Safari evicts localStorage.
               Logging SIGNED_OUT events specifically for PWAs makes this visible
               in remote debugging tools. */
            if (event === 'SIGNED_OUT' && isIOSPWA) {
                debugWarn('[Auth] Signed out on iOS PWA - session may have been evicted');
            }
            if (event === 'TOKEN_REFRESHED') {
                debugLog('[Auth] Token refreshed successfully');
            }
        });
    }
    return realClient;
}
// =============================================================================
// SECTION: Proxy Export
// =============================================================================
/**
 * The public Supabase client — a Proxy-based lazy singleton.
 *
 * **Why a Proxy?**
 * The Supabase URL and anon key are not available at import time (they come
 * from a runtime config that is loaded asynchronously). A Proxy lets every
 * module `import { supabase }` at the top level without worrying about
 * initialization order. The real client is created transparently on first
 * property access.
 *
 * **How it works:**
 * - The `get` trap intercepts every property read (e.g. `supabase.auth`,
 *   `supabase.from`).
 * - It calls `getOrCreateClient()` to ensure the real client exists.
 * - It forwards the property access via `Reflect.get`.
 * - Function values are `.bind(client)` to keep `this` correct when the
 *   caller destructures methods (e.g. `const { from } = supabase`).
 *
 * @example
 * ```ts
 * import { supabase } from './client';
 *
 * // Works immediately — the Proxy defers creation until this line runs:
 * const { data } = await supabase.from('users').select('*');
 * ```
 */
export const supabase = new Proxy({}, {
    get(_target, prop, receiver) {
        const client = getOrCreateClient();
        const value = Reflect.get(client, prop, receiver);
        if (typeof value === 'function') {
            return value.bind(client);
        }
        return value;
    }
});
//# sourceMappingURL=client.js.map