/**
 * @fileoverview Supabase Authentication Module
 *
 * Provides core authentication utilities on top of Supabase Auth for the
 * single-user PIN/password gate system:
 *
 * - **Sign-out & teardown**: Full 10-step teardown sequence to ensure no stale
 *   data leaks across sessions.
 *
 * - **Session management**: `getSession()` falls back to localStorage when the
 *   device is offline, ensuring the app can still render authenticated views
 *   with stale-but-usable session data.
 *
 * - **Profile CRUD**: Read and update user profile metadata on Supabase and
 *   in the offline credential cache.
 *
 * - **Email confirmation & OTP**: Resend confirmation emails and verify OTP
 *   token hashes from confirmation links.
 *
 * Security considerations:
 *   - Corrupted sessions are detected and automatically cleared to prevent
 *     infinite error loops.
 *   - Sign-out follows a strict 10-step teardown sequence to ensure no stale
 *     data leaks across user boundaries.
 *
 * Integration patterns:
 *   - Used internally by single-user auth (`../auth/singleUser.ts`) and the
 *     scaffolded confirm page (`../kit/confirm.ts`).
 *   - Works in tandem with `./client.ts` (lazy Supabase singleton) and
 *     `../engine.ts` (sync engine lifecycle).
 *   - Offline credential helpers live in `../auth/offlineCredentials.ts`.
 *
 * @module supabase/auth
 */
import type { User, Session } from '@supabase/supabase-js';
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
 *        cache are retained.
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