/**
 * @fileoverview Auth State Resolution
 *
 * Determines the current authentication state by checking Supabase session,
 * offline session, and cached credentials. Used by app layouts and route guards
 * to determine whether the user is authenticated and in which mode (online
 * Supabase session vs. offline cached session).
 *
 * Architecture:
 * - Two resolution paths based on engine config:
 *   1. **Multi-user mode** (default): checks online/offline status, Supabase
 *      session validity, and falls back to offline session + credential matching.
 *   2. **Single-user mode**: checks local `singleUserConfig` in IndexedDB,
 *      handles legacy migration, PIN length migration, session refresh, and
 *      offline fallback.
 * - The resolver does NOT start the sync engine -- callers decide whether to
 *   start sync based on the returned `authMode`.
 * - On catastrophic failure (corrupted auth state), all Supabase localStorage
 *   keys (`sb-*`) are purged and `authMode: 'none'` is returned, ensuring the
 *   user can start fresh rather than being permanently locked out.
 *
 * Security considerations:
 * - Offline sessions are cross-validated against cached credentials by userId
 *   to prevent stale or cross-user sessions from granting access.
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
import { getValidOfflineSession, clearOfflineSession } from './offlineSession';
import { getOfflineCredentials } from './offlineCredentials';
import { resetSingleUserRemote } from './singleUser';
import { getEngineConfig, waitForDb } from '../config';
import { supabase } from '../supabase/client';
import { debugLog, debugWarn, debugError } from '../debug';
// =============================================================================
// PUBLIC API
// =============================================================================
/**
 * Resolve the current authentication state.
 *
 * Inspects the engine config mode and delegates to the appropriate resolver:
 * - Single-user mode: {@link resolveSingleUserAuthState}
 * - Multi-user mode: inline resolution checking Supabase session, then offline session.
 *
 * Handles corrupted state cleanup by purging `sb-*` localStorage keys if
 * session retrieval throws.
 *
 * @returns A promise resolving to an {@link AuthStateResult} describing the
 *          current auth mode, session, and offline profile (if applicable).
 *
 * @example
 * ```ts
 * const { authMode, session, offlineProfile } = await resolveAuthState();
 * if (authMode === 'supabase') {
 *   startSyncEngine(session);
 * } else if (authMode === 'offline') {
 *   enterOfflineMode(offlineProfile);
 * } else {
 *   redirectToLogin();
 * }
 * ```
 *
 * @see {@link AuthStateResult} for the return type shape.
 */
export async function resolveAuthState() {
    try {
        /* Ensure DB is open and upgraded before any IndexedDB access.
           This is critical during cold start when the DB may still be initializing. */
        await waitForDb();
        // =========================================================================
        // SINGLE-USER MODE
        // =========================================================================
        const engineConfig = getEngineConfig();
        if (engineConfig.auth?.mode === 'single-user') {
            return resolveSingleUserAuthState();
        }
        // =========================================================================
        // MULTI-USER MODE (default)
        // =========================================================================
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        /* Get session once and reuse throughout this function to avoid multiple
           Supabase getSession() calls (egress/latency optimization). */
        const session = await getSession();
        const hasValidSession = session && !isSessionExpired(session);
        // -- ONLINE: Always use Supabase authentication --
        if (!isOffline) {
            if (hasValidSession) {
                return { session, authMode: 'supabase', offlineProfile: null };
            }
            /* No valid Supabase session while online -- user needs to login. */
            return { session: null, authMode: 'none', offlineProfile: null };
        }
        // -- OFFLINE: Try Supabase session from localStorage first, then offline session --
        if (hasValidSession) {
            return { session, authMode: 'supabase', offlineProfile: null };
        }
        /* No valid Supabase session -- check for offline session. */
        const offlineSession = await getValidOfflineSession();
        if (offlineSession) {
            /* SECURITY: Verify offline session matches cached credentials by userId.
               This prevents a scenario where credentials were updated (different user
               logged in) but the old session record remains. */
            const profile = await getOfflineCredentials();
            if (profile && profile.userId === offlineSession.userId) {
                return { session: null, authMode: 'offline', offlineProfile: profile };
            }
            /* Mismatch: credentials changed after session created -- clear the stale session. */
            debugWarn('[Auth] Offline session userId does not match credentials - clearing session');
            await clearOfflineSession();
        }
        /* No valid session while offline. */
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
 *    Returns `authMode: 'none'`, `singleUserSetUp: false`.
 *
 * 2. **Legacy config without email**: Config from the anonymous auth era.
 *    Nukes all local auth artifacts and returns `singleUserSetUp: false`.
 *
 * 3. **Code-length migration**: The engine config specifies a different PIN
 *    length than what is stored locally. Resets remote and local state, forcing
 *    re-setup with the new PIN length.
 *
 * 4. **Valid Supabase session**: Returns `authMode: 'supabase'`, `singleUserSetUp: true`.
 *
 * 5. **Expired session with valid refresh token**: Attempts token refresh.
 *    On success, returns `authMode: 'supabase'`. On failure, falls through.
 *
 * 6. **Offline with cached session**: Even an expired Supabase session is usable
 *    offline (RLS is not enforced client-side).
 *    Returns `authMode: 'supabase'`, `singleUserSetUp: true`.
 *
 * 7. **Offline with offline session**: Falls back to offline credentials.
 *    Returns `authMode: 'offline'`, `singleUserSetUp: true`.
 *
 * 8. **No valid session (locked)**: User must re-enter their PIN.
 *    Returns `authMode: 'none'`, `singleUserSetUp: true`.
 *
 * @returns A promise resolving to an {@link AuthStateResult} with the
 *          `singleUserSetUp` field populated.
 */
async function resolveSingleUserAuthState() {
    try {
        const db = getEngineConfig().db;
        if (!db) {
            return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
        }
        const config = (await db.table('singleUserConfig').get('config'));
        if (!config) {
            /* No local config -- user has not set up on this device.
               With real email/password auth, new devices go through the login flow
               (email + PIN) which creates the local config after signInWithPassword. */
            return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
        }
        if (!config.email) {
            /* Legacy config from anonymous auth era -- no email means user needs to
               go through the new setup flow (email + PIN). Old anonymous data will not
               be accessible under ownership-based RLS anyway.
               Nuke all legacy auth artifacts so the user gets a clean slate. */
            debugLog('[Auth] Legacy config without email detected, clearing old auth state');
            try {
                await db.table('singleUserConfig').delete('config');
                await db.table('offlineCredentials').delete('current_user');
                await db.table('offlineSession').delete('current_session');
            }
            catch (e) {
                debugWarn('[Auth] Failed to clear legacy auth state:', e);
            }
            return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
        }
        /* codeLength migration: if the engine config specifies a different PIN length
           than what is stored locally, the user must re-setup. This handles the case
           where the app developer changes the codeLength in their engine config.
           Existing configs from before codeLength was stored default to 4. */
        const expectedCodeLength = getEngineConfig().auth?.singleUser?.codeLength;
        const storedCodeLength = config.codeLength ?? 4;
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
            return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
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
            return { session, authMode: 'supabase', offlineProfile: null, singleUserSetUp: true };
        }
        // =========================================================================
        // No valid online session -- check offline fallbacks
        // =========================================================================
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        if (isOffline) {
            /* Even an expired cached Supabase session is usable offline because RLS
               is not enforced on the client side -- it only matters when syncing. */
            if (session) {
                return { session, authMode: 'supabase', offlineProfile: null, singleUserSetUp: true };
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
                return { session: null, authMode: 'offline', offlineProfile, singleUserSetUp: true };
            }
        }
        /* No valid session -- the single-user app is "locked" and the user must
           re-enter their PIN to unlock. */
        return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: true };
    }
    catch (e) {
        debugError('[Auth] Failed to resolve single-user auth state:', e);
        return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
    }
}
//# sourceMappingURL=resolveAuthState.js.map