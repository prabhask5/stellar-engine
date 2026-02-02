/**
 * Auth State Resolution
 *
 * Determines the current authentication state by checking Supabase session,
 * offline session, and cached credentials. Used by app layouts to determine
 * whether user is authenticated and in which mode.
 */
import { getSession, isSessionExpired } from '../supabase/auth';
import { getValidOfflineSession, clearOfflineSession } from './offlineSession';
import { getOfflineCredentials } from './offlineCredentials';
import { getEngineConfig, waitForDb } from '../config';
import { supabase } from '../supabase/client';
import { debugLog, debugWarn, debugError } from '../debug';
/**
 * Resolve the current authentication state.
 *
 * - Online: check Supabase session validity
 * - Offline: check localStorage session, fallback to offline session + credential matching
 * - Handles corrupted state cleanup
 * - Does NOT start sync engine (caller decides)
 */
export async function resolveAuthState() {
    try {
        // Ensure DB is open and upgraded before any access
        await waitForDb();
        // ── SINGLE-USER MODE ──────────────────────────────────────────
        const engineConfig = getEngineConfig();
        if (engineConfig.auth?.mode === 'single-user') {
            return resolveSingleUserAuthState();
        }
        // ── MULTI-USER MODE (default) ─────────────────────────────────
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        // Get session once and reuse (egress optimization)
        const session = await getSession();
        const hasValidSession = session && !isSessionExpired(session);
        // ONLINE: Always use Supabase authentication
        if (!isOffline) {
            if (hasValidSession) {
                return { session, authMode: 'supabase', offlineProfile: null };
            }
            // No valid Supabase session while online - user needs to login
            return { session: null, authMode: 'none', offlineProfile: null };
        }
        // OFFLINE: Try Supabase session from localStorage first, then offline session
        if (hasValidSession) {
            return { session, authMode: 'supabase', offlineProfile: null };
        }
        // No valid Supabase session - check for offline session
        const offlineSession = await getValidOfflineSession();
        if (offlineSession) {
            // SECURITY: Verify offline session matches cached credentials
            const profile = await getOfflineCredentials();
            if (profile && profile.userId === offlineSession.userId) {
                return { session: null, authMode: 'offline', offlineProfile: profile };
            }
            // Mismatch: credentials changed after session created
            debugWarn('[Auth] Offline session userId does not match credentials - clearing session');
            await clearOfflineSession();
        }
        // No valid session while offline
        return { session: null, authMode: 'none', offlineProfile: null };
    }
    catch (e) {
        // If session retrieval fails completely (corrupted auth state),
        // clear all Supabase auth data and return no session
        debugError('[Auth] Failed to resolve auth state, clearing auth storage:', e);
        try {
            if (typeof localStorage !== 'undefined') {
                const keys = Object.keys(localStorage).filter((k) => k.startsWith('sb-'));
                keys.forEach((k) => localStorage.removeItem(k));
            }
        }
        catch {
            // Ignore storage errors
        }
        return { session: null, authMode: 'none', offlineProfile: null };
    }
}
/**
 * Resolve auth state for single-user mode.
 *
 * - If no config exists: user hasn't set up yet → authMode: 'none', singleUserSetUp: false
 * - If config exists and valid session: → authMode: 'supabase', singleUserSetUp: true
 * - If config exists, offline with cached session: → authMode: 'supabase', singleUserSetUp: true
 * - If config exists, offline with offline session: → authMode: 'offline', singleUserSetUp: true
 * - If config exists but no session: locked → authMode: 'none', singleUserSetUp: true
 */
async function resolveSingleUserAuthState() {
    try {
        const db = getEngineConfig().db;
        if (!db) {
            return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
        }
        const config = await db.table('singleUserConfig').get('config');
        if (!config) {
            // No local config — user hasn't set up on this device.
            // With real email/password auth, new devices go through the login flow
            // (email + PIN) which creates the local config after signInWithPassword.
            return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
        }
        // Config exists — check session
        let session = await getSession();
        // If session exists but access token is expired, try refreshing before giving up.
        // Refresh tokens outlive the access token — without this, users are forced to
        // re-enter the PIN on every page load once the access token expires (default: 1 hour).
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
        // Check for offline session
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        if (isOffline) {
            // Even expired cached Supabase session is usable offline
            if (session) {
                return { session, authMode: 'supabase', offlineProfile: null, singleUserSetUp: true };
            }
            const offlineSession = await getValidOfflineSession();
            if (offlineSession) {
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
        // No valid session — locked
        return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: true };
    }
    catch (e) {
        debugError('[Auth] Failed to resolve single-user auth state:', e);
        return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
    }
}
//# sourceMappingURL=resolveAuthState.js.map