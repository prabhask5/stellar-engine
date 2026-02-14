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
import type { User, Session } from '@supabase/supabase-js';
/**
 * Standardized response shape returned by all authentication operations.
 *
 * Every auth function in this module returns this interface so that callers
 * can rely on a single, predictable contract for success/failure handling.
 */
export interface AuthResponse {
    /** The authenticated Supabase user, or `null` if authentication failed. */
    user: User | null;
    /** The active session, or `null` if not yet established (e.g. device verification pending). */
    session: Session | null;
    /** A human-readable error message, or `null` on success. */
    error: string | null;
    /**
     * When `true`, the device has not been verified and the caller must
     * present a device-verification OTP input before granting access.
     * Only set when `auth.deviceVerification.enabled` is `true` in the engine config.
     */
    deviceVerificationRequired?: boolean;
    /**
     * A partially-masked version of the user's email (e.g. `j***@example.com`)
     * shown during device verification so the user knows where to look for the OTP.
     */
    maskedEmail?: string;
    /**
     * If the login guard rejected the attempt due to rate-limiting, this value
     * indicates how many milliseconds the caller should wait before retrying.
     */
    retryAfterMs?: number;
}
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
export declare function signIn(email: string, password: string): Promise<AuthResponse>;
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
export declare function signUp(email: string, password: string, profileData: Record<string, unknown>): Promise<AuthResponse>;
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
export declare function signOut(options?: {
    preserveOfflineCredentials?: boolean;
    preserveLocalData?: boolean;
}): Promise<{
    error: string | null;
}>;
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
export declare function getSession(): Promise<Session | null>;
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
export declare function isSessionExpired(session: Session | null): boolean;
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
export declare function getUserProfile(user: User | null): Record<string, unknown>;
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
export declare function updateProfile(profile: Record<string, unknown>): Promise<{
    error: string | null;
}>;
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
export declare function changePassword(currentPassword: string, newPassword: string): Promise<{
    error: string | null;
}>;
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
export declare function changeEmail(newEmail: string): Promise<{
    error: string | null;
    confirmationRequired: boolean;
}>;
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
export declare function completeEmailChange(): Promise<{
    error: string | null;
    newEmail: string | null;
}>;
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
export declare function resendConfirmationEmail(email: string): Promise<{
    error: string | null;
}>;
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
export declare function verifyOtp(tokenHash: string, type: 'signup' | 'email' | 'email_change'): Promise<{
    error: string | null;
}>;
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
export declare function getValidSession(): Promise<Session | null>;
//# sourceMappingURL=auth.d.ts.map