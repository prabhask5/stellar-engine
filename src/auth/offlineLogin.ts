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

import { getOfflineCredentials, verifyOfflineCredentials } from './offlineCredentials';
import { createOfflineSession, getValidOfflineSession } from './offlineSession';
import { debugLog, debugError } from '../debug';

// =============================================================================
// TYPES
// =============================================================================

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
  reason?:
    | 'no_credentials'
    | 'no_stored_password'
    | 'user_mismatch'
    | 'email_mismatch'
    | 'password_mismatch'
    | 'session_failed';
}

// =============================================================================
// PUBLIC API
// =============================================================================

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
export async function signInOffline(email: string, password: string): Promise<OfflineLoginResult> {
  try {
    /* Step 1: Get cached credentials */
    const credentials = await getOfflineCredentials();
    if (!credentials) {
      return { success: false, reason: 'no_credentials' };
    }

    if (!credentials.password) {
      return { success: false, reason: 'no_stored_password' };
    }

    /* Step 2: Verify credentials (email + password + userId match) */
    const verification = await verifyOfflineCredentials(email, password, credentials.userId);
    if (!verification.valid) {
      return {
        success: false,
        reason: verification.reason as OfflineLoginResult['reason']
      };
    }

    /* Step 3: Create offline session with a fresh random token */
    await createOfflineSession(credentials.userId);

    /* Step 4: Read-back validation -- ensure the session was actually persisted.
       Without this check, a silent IndexedDB failure would leave the user
       "logged in" with no session, causing confusing errors downstream. */
    const session = await getValidOfflineSession();
    if (!session) {
      return { success: false, reason: 'session_failed' };
    }

    debugLog('[Auth] Offline login successful');
    return { success: true };
  } catch (e) {
    debugError('[Auth] Offline login error:', e);
    return { success: false, reason: 'session_failed' };
  }
}

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
export async function getOfflineLoginInfo(): Promise<{
  /** Whether cached credentials exist on this device. */
  hasCredentials: boolean;
  /** The cached user's email address. */
  email?: string;
  /** The cached user's first name (from profile). */
  firstName?: string;
  /** The cached user's last name (from profile). */
  lastName?: string;
} | null> {
  try {
    const credentials = await getOfflineCredentials();
    if (!credentials) return null;

    /* Extract only non-sensitive display info from the profile blob.
       Intentionally omits userId, password hash, and other sensitive fields. */
    const profile = credentials.profile || {};

    return {
      hasCredentials: true,
      email: credentials.email,
      firstName: profile.firstName as string | undefined,
      lastName: profile.lastName as string | undefined
    };
  } catch {
    return null;
  }
}
