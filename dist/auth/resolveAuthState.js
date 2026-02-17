/**
 * @fileoverview Auth State Resolution
 *
 * Determines the current authentication state for single-user mode by checking
 * Supabase session, offline session, and cached credentials. Used by app layouts
 * and route guards to determine whether the user is authenticated and in which
 * mode (online Supabase session vs. offline cached session).
 *
 * Architecture:
 * - Requires `auth.singleUser` to be configured in the engine config.
 *   If not configured, returns `authMode: 'none'` immediately.
 * - Checks local `singleUserConfig` in IndexedDB, handles legacy migration,
 *   PIN length migration, session refresh, and offline fallback.
 * - The resolver does NOT start the sync engine -- callers decide whether to
 *   start sync based on the returned `authMode`.
 * - On catastrophic failure (corrupted auth state), all Supabase localStorage
 *   keys (`sb-*`) are purged and `authMode: 'none'` is returned, ensuring the
 *   user can start fresh rather than being permanently locked out.
 *
 * Security considerations:
 * - In single-user mode, legacy configs without an email (from the anonymous
 *   auth era) are nuked entirely -- anonymous data is inaccessible under
 *   ownership-based RLS anyway.
 * - The `singleUserConfig` table has been moved to IndexedDB + Supabase
 *   `user_metadata`; there is no longer a Supabase `single_user_config` table.
 * - Session refresh is attempted for expired single-user sessions before
 *   falling back to the PIN gate, preventing unnecessary re-authentication
 *   when only the access token (not the refresh token) has expired.
 *
 * @module auth/resolveAuthState
 */
import { getSession, isSessionExpired } from '../supabase/auth';
import { getValidOfflineSession } from './offlineSession';
import { resetSingleUserRemote } from './singleUser';
import { getEngineConfig, waitForDb } from '../config';
import { supabase } from '../supabase/client';
import { debugLog, debugWarn, debugError } from '../debug';
import { isDemoMode } from '../demo';
// =============================================================================
// PUBLIC API
// =============================================================================
/**
 * Resolve the current authentication state.
 *
 * Requires `auth.singleUser` to be configured. Delegates to
 * {@link resolveSingleUserAuthState} for the full resolution flow.
 * If single-user mode is not configured, returns `authMode: 'none'`.
 *
 * Handles corrupted state cleanup by purging `sb-*` localStorage keys if
 * session retrieval throws.
 *
 * @returns A promise resolving to an {@link AuthStateResult} describing the
 *          current auth mode, session, and offline profile (if applicable).
 *
 * @example
 * ```ts
 * const { authMode, session } = await resolveAuthState();
 * if (authMode === 'supabase') {
 *   startSyncEngine(session);
 * } else if (authMode === 'offline') {
 *   enterOfflineMode();
 * } else {
 *   redirectToLogin();
 * }
 * ```
 *
 * @see {@link AuthStateResult} for the return type shape.
 */
export async function resolveAuthState() {
    /* Demo mode short-circuit: skip all real auth resolution. */
    if (isDemoMode()) {
        return { session: null, authMode: 'demo', offlineProfile: null };
    }
    try {
        /* Ensure DB is open and upgraded before any IndexedDB access.
           This is critical during cold start when the DB may still be initializing. */
        await waitForDb();
        const engineConfig = getEngineConfig();
        if (engineConfig.auth?.singleUser) {
            return resolveSingleUserAuthState();
        }
        /* Single-user mode not configured -- no auth available. */
        return { session: null, authMode: 'none', offlineProfile: null };
    }
    catch (e) {
        /* Catastrophic failure: session retrieval threw (corrupted auth state).
           Clear all Supabase auth data from localStorage so the user can start
           fresh rather than being permanently locked out. */
        debugError('[Auth] Failed to resolve auth state, clearing auth storage:', e);
        try {
            if (typeof localStorage !== 'undefined') {
                const keys = Object.keys(localStorage).filter((k) => k.startsWith('sb-'));
                keys.forEach((k) => localStorage.removeItem(k));
            }
        }
        catch {
            /* Ignore storage errors -- we are already in error recovery. */
        }
        return { session: null, authMode: 'none', offlineProfile: null };
    }
}
// =============================================================================
// INTERNAL -- Single-User Mode Resolution
// =============================================================================
/**
 * Resolve auth state for single-user mode.
 *
 * Handles the following scenarios in order:
 *
 * 1. **No local config**: User has not set up on this device.
 *    Returns `authMode: 'none'`.
 *
 * 2. **Legacy config without email**: Config from the anonymous auth era.
 *    Nukes all local auth artifacts and returns `authMode: 'none'`.
 *
 * 3. **Code-length migration**: The engine config specifies a different PIN
 *    length than what is stored locally. Resets remote and local state, forcing
 *    re-setup with the new PIN length.
 *
 * 4. **Valid Supabase session**: Returns `authMode: 'supabase'`.
 *
 * 5. **Expired session with valid refresh token**: Attempts token refresh.
 *    On success, returns `authMode: 'supabase'`. On failure, falls through.
 *
 * 6. **Offline with cached session**: Even an expired Supabase session is usable
 *    offline (RLS is not enforced client-side).
 *    Returns `authMode: 'supabase'`.
 *
 * 7. **Offline with offline session**: Falls back to offline credentials.
 *    Returns `authMode: 'offline'`.
 *
 * 8. **No valid session (locked)**: User must re-enter their PIN.
 *    Returns `authMode: 'none'`.
 *
 * @returns A promise resolving to an {@link AuthStateResult}.
 */
async function resolveSingleUserAuthState() {
    try {
        const db = getEngineConfig().db;
        if (!db) {
            return { session: null, authMode: 'none', offlineProfile: null };
        }
        const config = (await db.table('singleUserConfig').get('config'));
        if (!config) {
            /* No local config -- user has not set up on this device.
               With real email/password auth, new devices go through the login flow
               (email + PIN) which creates the local config after signInWithPassword. */
            return { session: null, authMode: 'none', offlineProfile: null };
        }
        if (!config.email) {
            /* Config without email is invalid — user needs to go through setup. */
            return { session: null, authMode: 'none', offlineProfile: null };
        }
        /* codeLength migration: if the engine config specifies a different PIN length
           than what is stored locally, the user must re-setup. This handles the case
           where the app developer changes the codeLength in their engine config. */
        const expectedCodeLength = getEngineConfig().auth?.singleUser?.codeLength;
        const storedCodeLength = config.codeLength;
        if (expectedCodeLength && storedCodeLength !== expectedCodeLength) {
            debugLog('[Auth] codeLength mismatch detected:', storedCodeLength, '→', expectedCodeLength);
            try {
                await resetSingleUserRemote();
            }
            catch (e) {
                debugWarn('[Auth] Failed to reset remote single user:', e);
            }
            /* Sign out to kill in-memory and persisted Supabase session. */
            try {
                await supabase.auth.signOut();
            }
            catch {
                /* Ignore -- session may already be cleared by resetSingleUserRemote. */
            }
            /* Clear local state so the setup flow starts fresh. */
            try {
                await db.table('singleUserConfig').delete('config');
                await db.table('offlineCredentials').delete('current_user');
                await db.table('offlineSession').delete('current_session');
            }
            catch (e) {
                debugWarn('[Auth] Failed to clear local auth state:', e);
            }
            return { session: null, authMode: 'none', offlineProfile: null };
        }
        /* Lock check: if the user explicitly locked the app, honour the lock
           even if a valid Supabase session still exists in localStorage. */
        const lockState = await db.table('singleUserConfig').get('lock_state');
        if (lockState?.locked) {
            return { session: null, authMode: 'none', offlineProfile: null };
        }
        // =========================================================================
        // Config exists -- check for an active session
        // =========================================================================
        let session = await getSession();
        /* If the access token is expired, try refreshing before giving up.
           Refresh tokens outlive the access token -- without this, users are forced
           to re-enter their PIN on every page load once the access token expires
           (default Supabase access token lifetime: 1 hour). */
        if (session && isSessionExpired(session)) {
            debugLog('[Auth] Single-user session expired, attempting refresh...');
            try {
                const { data, error } = await supabase.auth.refreshSession();
                if (!error && data.session) {
                    session = data.session;
                    debugLog('[Auth] Single-user session refreshed successfully');
                }
                else {
                    debugWarn('[Auth] Single-user session refresh failed:', error?.message);
                    session = null;
                }
            }
            catch {
                session = null;
            }
        }
        const hasValidSession = session && !isSessionExpired(session);
        if (hasValidSession) {
            return { session, authMode: 'supabase', offlineProfile: null };
        }
        // =========================================================================
        // No valid online session -- check offline fallbacks
        // =========================================================================
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        if (isOffline) {
            /* Even an expired cached Supabase session is usable offline because RLS
               is not enforced on the client side -- it only matters when syncing. */
            if (session) {
                return { session, authMode: 'supabase', offlineProfile: null };
            }
            const offlineSession = await getValidOfflineSession();
            if (offlineSession) {
                /* Construct an OfflineCredentials-shaped object from the local config
                   so the caller has profile data available for the offline UI. */
                const offlineProfile = {
                    id: 'current_user',
                    userId: offlineSession.userId,
                    email: config.email || '',
                    password: config.gateHash || '',
                    profile: config.profile,
                    cachedAt: new Date().toISOString()
                };
                return { session: null, authMode: 'offline', offlineProfile };
            }
        }
        /* No valid session -- the single-user app is "locked" and the user must
           re-enter their PIN to unlock. */
        return { session: null, authMode: 'none', offlineProfile: null };
    }
    catch (e) {
        debugError('[Auth] Failed to resolve single-user auth state:', e);
        return { session: null, authMode: 'none', offlineProfile: null };
    }
}
//# sourceMappingURL=resolveAuthState.js.map