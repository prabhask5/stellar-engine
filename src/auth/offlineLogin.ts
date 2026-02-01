/**
 * Offline Login
 *
 * Provides high-level offline sign-in and credential info functions,
 * absorbing the login page's direct use of offline auth internals.
 */

import { getOfflineCredentials, verifyOfflineCredentials } from './offlineCredentials';
import { createOfflineSession, getValidOfflineSession } from './offlineSession';
import { debugLog, debugError } from '../debug';

interface OfflineLoginResult {
  success: boolean;
  error?: string;
  reason?: 'no_credentials' | 'no_stored_password' | 'user_mismatch' | 'email_mismatch' | 'password_mismatch' | 'session_failed';
}

/**
 * Sign in offline using cached credentials.
 *
 * 1. Fetches cached offline credentials
 * 2. Verifies email + password against cached credentials
 * 3. Creates offline session
 * 4. Validates session was persisted
 * 5. Returns structured result with typed error reasons
 */
export async function signInOffline(
  email: string,
  password: string
): Promise<OfflineLoginResult> {
  try {
    // 1. Get cached credentials
    const credentials = await getOfflineCredentials();
    if (!credentials) {
      return { success: false, reason: 'no_credentials' };
    }

    if (!credentials.password) {
      return { success: false, reason: 'no_stored_password' };
    }

    // 2. Verify credentials
    const verification = await verifyOfflineCredentials(email, password, credentials.userId);
    if (!verification.valid) {
      return {
        success: false,
        reason: verification.reason as OfflineLoginResult['reason']
      };
    }

    // 3. Create offline session
    await createOfflineSession(credentials.userId);

    // 4. Validate session was persisted
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
 * Returns null if no credentials cached.
 * Used by login page to show "Sign in as X" offline UI.
 */
export async function getOfflineLoginInfo(): Promise<{
  hasCredentials: boolean;
  email?: string;
  firstName?: string;
  lastName?: string;
} | null> {
  try {
    const credentials = await getOfflineCredentials();
    if (!credentials) return null;

    // Extract display info from profile
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
