/**
 * @fileoverview Supabase Authentication Module
 *
 * Provides a complete authentication layer on top of Supabase Auth, with
 * built-in support for:
 *
 * - **Offline credential caching**: On successful login, credentials are hashed
 *   and persisted locally so that users can re-authenticate even when the device
 *   is offline (airplane mode, poor connectivity, etc.).
 *
 * - **Login guard / brute-force protection**: Every sign-in attempt passes
 *   through a local pre-check (`loginGuard`) that enforces rate-limiting and
 *   multi-user strategy rules *before* hitting the Supabase API.
 *
 * - **Device verification (optional)**: When enabled in the engine config, an
 *   untrusted device will trigger an OTP flow and the user will not receive a
 *   session until the device is verified.
 *
 * - **Graceful session recovery**: `getSession()` falls back to localStorage
 *   when the device is offline, ensuring the app can still render authenticated
 *   views with stale-but-usable session data.
 *
 * Security considerations:
 *   - Passwords are hashed before being stored in the offline credential cache.
 *   - The `changePassword` flow verifies the current password locally (if a
 *     cached hash exists) or via a Supabase re-authentication call.
 *   - Corrupted sessions are detected and automatically cleared to prevent
 *     infinite error loops.
 *   - Sign-out follows a strict 10-step teardown sequence to ensure no stale
 *     data leaks across user boundaries.
 *
 * Integration patterns:
 *   - Consumed by UI auth screens (login, signup, profile, password change).
 *   - Works in tandem with `./client.ts` (lazy Supabase singleton) and
 *     `../engine.ts` (sync engine lifecycle).
 *   - Offline credential helpers live in `../auth/offlineCredentials.ts`.
 *
 * @module supabase/auth
 */
import { supabase } from './client';
import { cacheOfflineCredentials, clearOfflineCredentials, getOfflineCredentials, updateOfflineCredentialsPassword, updateOfflineCredentialsProfile } from '../auth/offlineCredentials';
import { clearOfflineSession } from '../auth/offlineSession';
import { preCheckLogin, onLoginSuccess, onLoginFailure, resetLoginGuard } from '../auth/loginGuard';
import { hashValue, isAlreadyHashed } from '../auth/crypto';
import { debugWarn, debugError } from '../debug';
import { getEngineConfig } from '../config';
import { syncStatusStore } from '../stores/sync';
import { authState } from '../stores/authState';
// =============================================================================
// SECTION: Helpers
// =============================================================================
/**
 * Get the email confirmation redirect URL.
 *
 * Points to the `/confirm` page (or the path configured via
 * `auth.confirmRedirectPath`) which handles the token verification flow
 * after a user clicks the link in their confirmation email.
 *
 * @returns The fully-qualified redirect URL, e.g. `https://app.example.com/confirm`.
 *          Falls back to a relative `/confirm` path in SSR environments where
 *          `window` is unavailable.
 *
 * @see {@link signUp} — uses this URL as `emailRedirectTo`
 * @see {@link resendConfirmationEmail} — also uses this URL
 */
function getConfirmRedirectUrl() {
    if (typeof window !== 'undefined') {
        const path = getEngineConfig().auth?.confirmRedirectPath || '/confirm';
        return `${window.location.origin}${path}`;
    }
    // Fallback for SSR (shouldn't be called, but just in case)
    return '/confirm';
}
// =============================================================================
// SECTION: Sign In
// =============================================================================
/**
 * Authenticate a user with email and password.
 *
 * Flow:
 * 1. Run `preCheckLogin` to enforce local brute-force / rate-limit rules.
 * 2. Call `supabase.auth.signInWithPassword`.
 * 3. On success, cache credentials for offline re-authentication.
 * 4. If device verification is enabled, check trust status and optionally
 *    trigger an OTP challenge instead of returning the session.
 *
 * @param email    - The user's email address.
 * @param password - The user's plaintext password (hashed before caching).
 * @returns An {@link AuthResponse} indicating success, failure, or a device
 *          verification challenge.
 *
 * @example
 * ```ts
 * const result = await signIn('user@example.com', 's3cret');
 * if (result.deviceVerificationRequired) {
 *   // Show OTP input, display result.maskedEmail
 * } else if (result.error) {
 *   // Show error
 * } else {
 *   // Logged in — result.session is available
 * }
 * ```
 *
 * @see {@link preCheckLogin} — local credential & rate-limit guard
 * @see {@link cacheOfflineCredentials} — offline credential persistence
 */
export async function signIn(email, password) {
    // Pre-check credentials locally before calling Supabase
    const preCheck = await preCheckLogin(password, 'multi-user', email);
    if (!preCheck.proceed) {
        return {
            user: null,
            session: null,
            error: preCheck.error,
            retryAfterMs: preCheck.retryAfterMs
        };
    }
    const strategy = preCheck.strategy;
    const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password
    });
    if (error) {
        await onLoginFailure(strategy, 'multi-user');
        return { user: data.user, session: data.session, error: error.message };
    }
    // Successful Supabase login
    onLoginSuccess();
    // Cache credentials for offline use on successful login
    if (data.session && data.user) {
        try {
            await cacheOfflineCredentials(email, password, data.user, data.session);
        }
        catch (e) {
            debugError('[Auth] Failed to cache offline credentials:', e);
        }
        // Check device verification for multi-user mode
        const config = getEngineConfig();
        if (config.auth?.deviceVerification?.enabled) {
            const { isDeviceTrusted, touchTrustedDevice, sendDeviceVerification, maskEmail } = await import('../auth/deviceVerification');
            const trusted = await isDeviceTrusted(data.user.id);
            if (!trusted) {
                /* Untrusted device — we intentionally do NOT return the session here.
                   The caller must complete the device-verification OTP flow first.
                   The session will be re-established after verification succeeds. */
                const maskedEmail = maskEmail(email);
                await sendDeviceVerification(email);
                return {
                    user: data.user,
                    session: null,
                    error: null,
                    deviceVerificationRequired: true,
                    maskedEmail
                };
            }
            await touchTrustedDevice(data.user.id);
        }
    }
    return {
        user: data.user,
        session: data.session,
        error: null
    };
}
// =============================================================================
// SECTION: Sign Up
// =============================================================================
/**
 * Register a new user account with Supabase.
 *
 * Profile data is transformed via the optional `auth.profileToMetadata`
 * config hook before being sent as `user_metadata` so that the host app
 * can normalize field names.
 *
 * @param email       - The new user's email address.
 * @param password    - The desired password (Supabase enforces its own strength rules).
 * @param profileData - Arbitrary profile fields (e.g. `{ display_name, avatar_url }`).
 * @returns An {@link AuthResponse}. Note: `session` may be `null` if email
 *          confirmation is required by the Supabase project settings.
 *
 * @example
 * ```ts
 * const result = await signUp('new@user.com', 'p@ssw0rd', { display_name: 'Ada' });
 * if (result.error) { ... }
 * ```
 *
 * @see {@link getConfirmRedirectUrl} — determines the email confirmation link target
 */
export async function signUp(email, password, profileData) {
    const config = getEngineConfig();
    const metadata = config.auth?.profileToMetadata
        ? config.auth.profileToMetadata(profileData)
        : profileData;
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            emailRedirectTo: getConfirmRedirectUrl(),
            data: metadata
        }
    });
    return {
        user: data.user,
        session: data.session,
        error: error?.message || null
    };
}
// =============================================================================
// SECTION: Sign Out
// =============================================================================
/**
 * Sign the current user out and perform a full teardown of local state.
 *
 * The teardown follows a strict **10-step sequence** to ensure no stale data
 * leaks between user sessions:
 *
 *   1. Stop the sync engine (dynamic import avoids circular deps).
 *   2. Clear the pending sync queue (unless `preserveLocalData` is set).
 *   3. Clear the local cache (unless `preserveLocalData` is set).
 *   4. Clear the offline session token.
 *   5. Clear offline credentials (only when online, to preserve offline re-login).
 *   6. Call `supabase.auth.signOut()`.
 *   7. Remove all `sb-*` keys from localStorage (Supabase internal storage).
 *   8. Reset the login guard (brute-force counters).
 *   9. Reset the sync status store.
 *  10. Reset the auth state store.
 *
 * Each step is wrapped in its own try/catch so that a failure in one step
 * does not prevent subsequent cleanup from running.
 *
 * @param options - Optional flags to control teardown behavior.
 * @param options.preserveOfflineCredentials - When `true`, offline credentials
 *        are kept so the user can re-authenticate without network access.
 * @param options.preserveLocalData - When `true`, pending sync queue and local
 *        cache are retained (useful for "switch account" scenarios).
 * @returns An object with an `error` field (`null` on success).
 *
 * @example
 * ```ts
 * await signOut(); // full teardown
 * await signOut({ preserveLocalData: true }); // keep cached data
 * ```
 */
export async function signOut(options) {
    // 1. Stop sync engine (import dynamically to avoid circular deps)
    try {
        const { stopSyncEngine, clearLocalCache, clearPendingSyncQueue } = await import('../engine');
        await stopSyncEngine();
        if (!options?.preserveLocalData) {
            // 2. Clear pending sync queue
            await clearPendingSyncQueue();
            // 3. Clear local cache
            await clearLocalCache();
        }
    }
    catch (e) {
        debugError('[Auth] Failed to stop engine/clear data:', e);
    }
    // 4. Clear offline session
    try {
        await clearOfflineSession();
    }
    catch (e) {
        debugError('[Auth] Failed to clear offline session:', e);
    }
    // 5. Clear offline credentials (only if online, for offline re-login preservation)
    try {
        if (!options?.preserveOfflineCredentials) {
            /* Only clear when online — if the user is offline, we want to keep
               the cached credentials so they can still sign back in without
               network access. This is a deliberate security trade-off favouring
               availability over strict credential erasure. */
            const isOnline = typeof navigator !== 'undefined' && navigator.onLine;
            if (isOnline) {
                await clearOfflineCredentials();
            }
        }
    }
    catch (e) {
        debugError('[Auth] Failed to clear offline credentials:', e);
    }
    // 6. Supabase auth signOut
    const { error } = await supabase.auth.signOut();
    // 7. Clear sb-* localStorage keys
    try {
        if (typeof localStorage !== 'undefined') {
            const keys = Object.keys(localStorage).filter((k) => k.startsWith('sb-'));
            keys.forEach((k) => localStorage.removeItem(k));
        }
    }
    catch {
        // Ignore storage errors
    }
    // 8. Reset login guard state
    resetLoginGuard();
    // 9. Reset sync status store
    syncStatusStore.reset();
    // 10. Reset auth state store
    authState.reset();
    return { error: error?.message || null };
}
// =============================================================================
// SECTION: Session Management
// =============================================================================
/**
 * Get the current Supabase session.
 *
 * When the device is **online**, this delegates to `supabase.auth.getSession()`
 * which may trigger a token refresh if the access token is close to expiry.
 *
 * When the device is **offline**, or if the Supabase call fails with a
 * corrupted-session error, this falls back to reading the session directly
 * from localStorage via {@link getSessionFromStorage}. The returned session
 * may be expired, but callers can use {@link isSessionExpired} to check and
 * should handle offline mode appropriately (e.g. show cached data, queue
 * mutations for later sync).
 *
 * @returns The current `Session` object, or `null` if no valid session exists.
 *
 * @example
 * ```ts
 * const session = await getSession();
 * if (session && !isSessionExpired(session)) {
 *   // Fully authenticated
 * }
 * ```
 *
 * @see {@link getSessionFromStorage} — direct localStorage fallback
 * @see {@link isSessionExpired} — expiry check helper
 * @see {@link getValidSession} — combined convenience wrapper
 */
export async function getSession() {
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    try {
        const { data, error } = await supabase.auth.getSession();
        if (error) {
            debugError('[Auth] getSession error:', error.message);
            // If offline and we got an error, don't clear session - it might just be a network issue
            if (isOffline) {
                debugWarn('[Auth] Offline - keeping session despite error');
                // Try to get session from localStorage directly
                return getSessionFromStorage();
            }
            /* Detect corrupted session data (e.g. "can't access property 'hash'
               of undefined") which can occur when localStorage is partially written.
               Signing out clears the corrupt state so subsequent calls succeed. */
            if (error.message?.includes('hash') || error.message?.includes('undefined')) {
                debugWarn('[Auth] Detected corrupted session, attempting to clear');
                await supabase.auth.signOut();
            }
            return null;
        }
        return data.session;
    }
    catch (e) {
        debugError('[Auth] Unexpected error getting session:', e);
        // If offline, don't clear anything - try to get from storage
        if (isOffline) {
            debugWarn('[Auth] Offline - attempting to get session from storage');
            return getSessionFromStorage();
        }
        // Attempt to clear any corrupted state when online
        try {
            await supabase.auth.signOut();
        }
        catch {
            // Ignore signOut errors
        }
        return null;
    }
}
/**
 * Read the session directly from localStorage, bypassing Supabase's
 * built-in token refresh logic.
 *
 * This is used as a **fallback** when the device is offline and the normal
 * `supabase.auth.getSession()` call fails. The returned session may be
 * expired, but it still contains the user identity, which is sufficient for
 * rendering cached offline views.
 *
 * Supabase stores its auth token in localStorage under a key matching the
 * pattern `sb-{project-ref}-auth-token`. The internal structure has changed
 * between Supabase versions, so we check for both `currentSession` (older)
 * and `session` (newer) shapes.
 *
 * @returns The cached `Session`, or `null` if nothing usable is found.
 */
function getSessionFromStorage() {
    try {
        // Supabase stores session in localStorage with key pattern: sb-{project-ref}-auth-token
        const keys = Object.keys(localStorage);
        const sessionKey = keys.find((k) => k.includes('-auth-token'));
        if (!sessionKey)
            return null;
        const stored = localStorage.getItem(sessionKey);
        if (!stored)
            return null;
        const parsed = JSON.parse(stored);
        if (parsed?.currentSession) {
            return parsed.currentSession;
        }
        // Newer Supabase versions use different structure
        if (parsed?.session) {
            return parsed.session;
        }
        return null;
    }
    catch (e) {
        debugError('[Auth] Failed to get session from storage:', e);
        return null;
    }
}
/**
 * Check whether a session's access token has expired.
 *
 * The `expires_at` field on a Supabase session is a **Unix timestamp in
 * seconds**. We compare it against `Date.now() / 1000` (which is in
 * milliseconds, hence the division).
 *
 * @param session - The session to check, or `null`.
 * @returns `true` if the session is `null`, missing `expires_at`, or past
 *          its expiry time; `false` otherwise.
 *
 * @example
 * ```ts
 * if (isSessionExpired(session)) {
 *   // Prompt re-authentication or attempt token refresh
 * }
 * ```
 */
export function isSessionExpired(session) {
    if (!session)
        return true;
    // expires_at is in seconds
    const expiresAt = session.expires_at;
    if (!expiresAt)
        return true;
    return Date.now() / 1000 > expiresAt;
}
// =============================================================================
// SECTION: User Profile
// =============================================================================
/**
 * Extract the user's profile from their Supabase `user_metadata`.
 *
 * If the engine config provides a custom `auth.profileExtractor`, it is
 * invoked to transform the raw metadata into the app's profile shape.
 * Otherwise the raw `user_metadata` object is returned as-is.
 *
 * @param user - The Supabase `User` object (may be `null`).
 * @returns A key-value record representing the user's profile fields.
 *
 * @example
 * ```ts
 * const profile = getUserProfile(session.user);
 * console.log(profile.display_name);
 * ```
 */
export function getUserProfile(user) {
    const config = getEngineConfig();
    if (config.auth?.profileExtractor && user) {
        return config.auth.profileExtractor(user.user_metadata || {});
    }
    return user?.user_metadata || {};
}
/**
 * Update the current user's profile metadata on Supabase.
 *
 * The profile data is transformed through `auth.profileToMetadata` (if
 * configured) before being sent. On success the offline credential cache
 * is also updated so that the profile stays consistent across online and
 * offline modes.
 *
 * @param profile - The updated profile fields to persist.
 * @returns An object with an `error` field (`null` on success).
 *
 * @example
 * ```ts
 * const { error } = await updateProfile({ display_name: 'New Name' });
 * ```
 *
 * @see {@link updateOfflineCredentialsProfile} — keeps the offline cache in sync
 */
export async function updateProfile(profile) {
    const config = getEngineConfig();
    const metadata = config.auth?.profileToMetadata
        ? config.auth.profileToMetadata(profile)
        : profile;
    const { error } = await supabase.auth.updateUser({
        data: metadata
    });
    if (!error) {
        // Update offline cache
        try {
            await updateOfflineCredentialsProfile(profile);
        }
        catch (e) {
            debugError('[Auth] Failed to update offline profile:', e);
        }
    }
    return { error: error?.message || null };
}
// =============================================================================
// SECTION: Password Management
// =============================================================================
/**
 * Change the current user's password.
 *
 * Security flow:
 * 1. Retrieve the current session to obtain the user's email.
 * 2. **Verify the current password** — two strategies:
 *    a. If an offline credential cache exists and the email matches, compare
 *       hashes locally (avoids a network round-trip and an extra Supabase call).
 *    b. Otherwise, fall back to `supabase.auth.signInWithPassword` to verify
 *       against the server.
 * 3. Call `supabase.auth.updateUser({ password })` to set the new password.
 * 4. Update the offline credential cache with the new password hash.
 *
 * @param currentPassword - The user's current password (for verification).
 * @param newPassword     - The desired new password.
 * @returns An object with an `error` field (`null` on success).
 *
 * @throws Never throws — all errors are returned in the `error` field.
 *
 * @example
 * ```ts
 * const { error } = await changePassword('oldPass', 'newPass');
 * if (error) { alert(error); }
 * ```
 *
 * @see {@link hashValue} — used for local password comparison
 * @see {@link updateOfflineCredentialsPassword} — keeps the offline cache in sync
 */
export async function changePassword(currentPassword, newPassword) {
    // Get current user email from session
    const { data: { session } } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user?.email) {
        return { error: 'No authenticated user found' };
    }
    // Verify current password: prefer local hash check, fall back to Supabase
    const creds = await getOfflineCredentials();
    if (creds && creds.password && creds.email === user.email) {
        /* Local verification path — compare against the cached credential hash.
           This avoids an extra network call and works even in degraded-connectivity
           scenarios. We must handle both hashed and (legacy) plaintext caches. */
        let passwordMatch;
        if (isAlreadyHashed(creds.password)) {
            const hashedInput = await hashValue(currentPassword);
            passwordMatch = creds.password === hashedInput;
        }
        else {
            passwordMatch = creds.password === currentPassword;
        }
        if (!passwordMatch) {
            return { error: 'Current password is incorrect' };
        }
    }
    else {
        /* No usable cached credentials — fall back to a full Supabase
           re-authentication call to verify the current password. */
        const { error: verifyError } = await supabase.auth.signInWithPassword({
            email: user.email,
            password: currentPassword
        });
        if (verifyError) {
            return { error: 'Current password is incorrect' };
        }
    }
    // Update password
    const { error } = await supabase.auth.updateUser({
        password: newPassword
    });
    if (!error) {
        // Update offline cache with new password
        try {
            await updateOfflineCredentialsPassword(newPassword);
        }
        catch (e) {
            debugError('[Auth] Failed to update offline password:', e);
        }
    }
    return { error: error?.message || null };
}
// =============================================================================
// SECTION: Email Management
// =============================================================================
/**
 * Initiate an email change for the current user.
 *
 * Supabase sends a confirmation link to the **new** email address. The
 * change is not applied until the user clicks that link and the app calls
 * {@link completeEmailChange}.
 *
 * @param newEmail - The desired new email address.
 * @returns An object indicating whether a confirmation email was sent, plus
 *          any error that occurred.
 *
 * @example
 * ```ts
 * const { error, confirmationRequired } = await changeEmail('new@example.com');
 * if (confirmationRequired) {
 *   // Tell the user to check their inbox
 * }
 * ```
 *
 * @see {@link completeEmailChange} — finishes the flow after confirmation
 */
export async function changeEmail(newEmail) {
    const { error } = await supabase.auth.updateUser({ email: newEmail });
    if (error) {
        return { error: error.message, confirmationRequired: false };
    }
    return { error: null, confirmationRequired: true };
}
/**
 * Complete an email change after the user confirms via the email link.
 *
 * Refreshes the Supabase session to pick up the updated email address,
 * then updates the offline credential cache so that offline login uses
 * the new email.
 *
 * @returns An object containing the new email and/or an error message.
 *
 * @example
 * ```ts
 * const { error, newEmail } = await completeEmailChange();
 * if (!error) {
 *   console.log(`Email changed to ${newEmail}`);
 * }
 * ```
 *
 * @see {@link changeEmail} — initiates the flow
 */
export async function completeEmailChange() {
    const { data, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !data.session) {
        return { error: refreshError?.message || 'Failed to refresh session', newEmail: null };
    }
    const newEmail = data.session.user.email;
    if (!newEmail) {
        return { error: 'No email found in updated session', newEmail: null };
    }
    // Update offline credentials cache
    try {
        const db = getEngineConfig().db;
        if (db) {
            const existing = await db.table('offlineCredentials').get('current_user');
            if (existing) {
                await db.table('offlineCredentials').update('current_user', {
                    email: newEmail,
                    cachedAt: new Date().toISOString()
                });
            }
        }
    }
    catch (e) {
        debugError('[Auth] Failed to update offline credentials after email change:', e);
    }
    return { error: null, newEmail };
}
// =============================================================================
// SECTION: Email Confirmation & OTP
// =============================================================================
/**
 * Resend the signup confirmation email for a given address.
 *
 * The caller should enforce a client-side cooldown (recommended: 30 seconds)
 * to prevent abuse, since Supabase may not always rate-limit resends on its
 * own.
 *
 * @param email - The email address that needs a new confirmation link.
 * @returns An object with an `error` field (`null` on success).
 *
 * @example
 * ```ts
 * const { error } = await resendConfirmationEmail('user@example.com');
 * ```
 */
export async function resendConfirmationEmail(email) {
    const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: {
            emailRedirectTo: getConfirmRedirectUrl()
        }
    });
    return { error: error?.message || null };
}
/**
 * Verify an OTP token hash received from a confirmation email link.
 *
 * This absorbs the direct Supabase call that would otherwise live in the
 * confirm page component, keeping all auth logic centralised in this module.
 *
 * @param tokenHash - The `token_hash` query parameter from the confirmation URL.
 * @param type      - The type of OTP: `'signup'`, `'email'`, or `'email_change'`.
 * @returns An object with an `error` field (`null` on success).
 *
 * @example
 * ```ts
 * // On the /confirm page:
 * const hash = new URL(location.href).searchParams.get('token_hash');
 * const { error } = await verifyOtp(hash, 'signup');
 * ```
 */
export async function verifyOtp(tokenHash, type) {
    const { error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type
    });
    return { error: error?.message || null };
}
// =============================================================================
// SECTION: Convenience Wrappers
// =============================================================================
/**
 * Get a valid (non-expired) session, or `null`.
 *
 * This is a convenience wrapper that combines {@link getSession} and
 * {@link isSessionExpired} into a single call, useful when the caller only
 * cares about sessions that can still be used for API requests.
 *
 * @returns A non-expired `Session`, or `null`.
 *
 * @example
 * ```ts
 * const session = await getValidSession();
 * if (!session) {
 *   redirectToLogin();
 * }
 * ```
 *
 * @see {@link getSession}
 * @see {@link isSessionExpired}
 */
export async function getValidSession() {
    const session = await getSession();
    if (!session)
        return null;
    if (isSessionExpired(session))
        return null;
    return session;
}
//# sourceMappingURL=auth.js.map