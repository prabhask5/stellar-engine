/**
 * @fileoverview Offline Login Orchestrator
 *
 * Provides high-level offline sign-in and credential info functions, serving as
 * the primary entry point for offline authentication. This module absorbs the
 * login page's direct use of offline auth internals, offering a clean API that
 * coordinates credential retrieval, verification, and session creation.
 *
 * Architecture:
 * - `signInOffline` is the main flow: fetch cached credentials, verify them,
 *   create an offline session, and validate it was persisted.
 * - `getOfflineLoginInfo` is a read-only helper that exposes non-sensitive
 *   display data (email, name) for pre-populating the offline login UI.
 * - Both functions are designed to never throw -- they return structured result
 *   objects with typed error reasons for the caller to handle.
 *
 * Security considerations:
 * - Offline login is inherently less secure than online Supabase authentication.
 *   It relies on SHA-256-hashed credentials stored in IndexedDB, which a
 *   sufficiently motivated attacker with device access could extract.
 * - The offline session token (`offlineToken`) is a random UUID that serves as
 *   a local-only proof of authentication. It is NOT a JWT and carries no claims.
 * - `getOfflineLoginInfo` intentionally excludes the password hash and userId
 *   from its return value to minimize exposure of sensitive data.
 *
 * @module auth/offlineLogin
 */
/**
 * Structured result returned by {@link signInOffline}.
 *
 * On success: `{ success: true }`.
 * On failure: `{ success: false, reason }` where `reason` identifies which
 * step of the offline login flow failed.
 */
interface OfflineLoginResult {
    /** Whether the offline login succeeded. */
    success: boolean;
    /** Human-readable error message (currently unused; `reason` is preferred). */
    error?: string;
    /**
     * Machine-readable failure reason, used by the login UI to display
     * context-appropriate error messages.
     *
     * - `'no_credentials'` -- No cached credentials exist on this device.
     * - `'no_stored_password'` -- Credentials exist but the password hash is missing.
     * - `'user_mismatch'` -- The cached userId does not match the expected user.
     * - `'email_mismatch'` -- The entered email does not match the cached email.
     * - `'password_mismatch'` -- The entered password does not match the cached hash.
     * - `'session_failed'` -- Credential verification passed but session creation
     *   or persistence failed.
     */
    reason?: 'no_credentials' | 'no_stored_password' | 'user_mismatch' | 'email_mismatch' | 'password_mismatch' | 'session_failed';
}
/**
 * Sign in offline using cached credentials.
 *
 * Executes the full offline authentication flow:
 * 1. Fetches cached offline credentials from IndexedDB.
 * 2. Verifies the provided email + password against cached credentials.
 * 3. Creates an offline session (random UUID token) in IndexedDB.
 * 4. Validates the session was actually persisted (read-back check).
 * 5. Returns a structured result with a typed error reason on failure.
 *
 * @param email    - The email address entered by the user.
 * @param password - The plaintext password entered by the user.
 * @returns A promise resolving to an {@link OfflineLoginResult}.
 *
 * @example
 * ```ts
 * const result = await signInOffline(email, password);
 * if (result.success) {
 *   router.push('/dashboard');
 * } else if (result.reason === 'no_credentials') {
 *   showError('You must log in online at least once before using offline mode.');
 * } else {
 *   showError('Incorrect email or password.');
 * }
 * ```
 *
 * @see {@link getOfflineLoginInfo} to check if offline credentials are available.
 * @see {@link verifyOfflineCredentials} for the underlying verification logic.
 * @see {@link createOfflineSession} for session creation details.
 */
export declare function signInOffline(email: string, password: string): Promise<OfflineLoginResult>;
/**
 * Get non-sensitive display info about cached offline credentials.
 *
 * Used by the login page to show an "offline mode" UI with the cached
 * user's name and email (e.g., "Sign in as jane@example.com").
 *
 * Returns `null` if no credentials are cached, meaning the user has never
 * logged in online on this device and offline login is unavailable.
 *
 * @returns An object containing `hasCredentials`, `email`, `firstName`, and
 *          `lastName`, or `null` if no credentials exist.
 *
 * @example
 * ```ts
 * const info = await getOfflineLoginInfo();
 * if (info?.hasCredentials) {
 *   showOfflineLoginUI(info.email, info.firstName);
 * } else {
 *   showOnlineOnlyMessage();
 * }
 * ```
 *
 * @see {@link signInOffline} to perform the actual offline login.
 */
export declare function getOfflineLoginInfo(): Promise<{
    /** Whether cached credentials exist on this device. */
    hasCredentials: boolean;
    /** The cached user's email address. */
    email?: string;
    /** The cached user's first name (from profile). */
    firstName?: string;
    /** The cached user's last name (from profile). */
    lastName?: string;
} | null>;
export {};
//# sourceMappingURL=offlineLogin.d.ts.map