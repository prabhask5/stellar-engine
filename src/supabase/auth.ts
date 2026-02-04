import { supabase } from './client';
import type { User, Session } from '@supabase/supabase-js';
import {
  cacheOfflineCredentials,
  clearOfflineCredentials,
  getOfflineCredentials,
  updateOfflineCredentialsPassword,
  updateOfflineCredentialsProfile
} from '../auth/offlineCredentials';
import { clearOfflineSession } from '../auth/offlineSession';
import { preCheckLogin, onLoginSuccess, onLoginFailure, resetLoginGuard } from '../auth/loginGuard';
import type { PreCheckStrategy } from '../auth/loginGuard';
import { hashValue, isAlreadyHashed } from '../auth/crypto';
import { debugWarn, debugError } from '../debug';
import { getEngineConfig } from '../config';
import { syncStatusStore } from '../stores/sync';
import { authState } from '../stores/authState';

/**
 * Get the email confirmation redirect URL
 * Points to /confirm page which handles the token verification
 */
function getConfirmRedirectUrl(): string {
  if (typeof window !== 'undefined') {
    const path = getEngineConfig().auth?.confirmRedirectPath || '/confirm';
    return `${window.location.origin}${path}`;
  }
  // Fallback for SSR (shouldn't be called, but just in case)
  return '/confirm';
}

export interface AuthResponse {
  user: User | null;
  session: Session | null;
  error: string | null;
  deviceVerificationRequired?: boolean;
  maskedEmail?: string;
  retryAfterMs?: number;
}

export async function signIn(email: string, password: string): Promise<AuthResponse> {
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

  const strategy: PreCheckStrategy = preCheck.strategy;

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
    } catch (e) {
      debugError('[Auth] Failed to cache offline credentials:', e);
    }

    // Check device verification for multi-user mode
    const config = getEngineConfig();
    if (config.auth?.deviceVerification?.enabled) {
      const { isDeviceTrusted, touchTrustedDevice, sendDeviceVerification, maskEmail } =
        await import('../auth/deviceVerification');
      const trusted = await isDeviceTrusted(data.user.id);

      if (!trusted) {
        // Untrusted device — sign out, send OTP
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

export async function signUp(
  email: string,
  password: string,
  profileData: Record<string, unknown>
): Promise<AuthResponse> {
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

export async function signOut(options?: {
  preserveOfflineCredentials?: boolean;
  preserveLocalData?: boolean;
}): Promise<{ error: string | null }> {
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
  } catch (e) {
    debugError('[Auth] Failed to stop engine/clear data:', e);
  }

  // 4. Clear offline session
  try {
    await clearOfflineSession();
  } catch (e) {
    debugError('[Auth] Failed to clear offline session:', e);
  }

  // 5. Clear offline credentials (only if online, for offline re-login preservation)
  try {
    if (!options?.preserveOfflineCredentials) {
      const isOnline = typeof navigator !== 'undefined' && navigator.onLine;
      if (isOnline) {
        await clearOfflineCredentials();
      }
    }
  } catch (e) {
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
  } catch {
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

/**
 * Get current Supabase session
 * When offline, returns the cached session from localStorage even if expired
 * (the caller should handle offline mode appropriately)
 */
export async function getSession(): Promise<Session | null> {
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

      // If session retrieval fails online, it might be corrupted - try to sign out to clear it
      if (error.message?.includes('hash') || error.message?.includes('undefined')) {
        debugWarn('[Auth] Detected corrupted session, attempting to clear');
        await supabase.auth.signOut();
      }
      return null;
    }

    return data.session;
  } catch (e) {
    debugError('[Auth] Unexpected error getting session:', e);

    // If offline, don't clear anything - try to get from storage
    if (isOffline) {
      debugWarn('[Auth] Offline - attempting to get session from storage');
      return getSessionFromStorage();
    }

    // Attempt to clear any corrupted state when online
    try {
      await supabase.auth.signOut();
    } catch {
      // Ignore signOut errors
    }
    return null;
  }
}

/**
 * Get session directly from localStorage (for offline scenarios)
 * This bypasses Supabase's token refresh logic
 */
function getSessionFromStorage(): Session | null {
  try {
    // Supabase stores session in localStorage with key pattern: sb-{project-ref}-auth-token
    const keys = Object.keys(localStorage);
    const sessionKey = keys.find((k) => k.includes('-auth-token'));
    if (!sessionKey) return null;

    const stored = localStorage.getItem(sessionKey);
    if (!stored) return null;

    const parsed = JSON.parse(stored);
    if (parsed?.currentSession) {
      return parsed.currentSession as Session;
    }
    // Newer Supabase versions use different structure
    if (parsed?.session) {
      return parsed.session as Session;
    }
    return null;
  } catch (e) {
    debugError('[Auth] Failed to get session from storage:', e);
    return null;
  }
}

/**
 * Check if a session's access token is expired
 */
export function isSessionExpired(session: Session | null): boolean {
  if (!session) return true;
  // expires_at is in seconds
  const expiresAt = session.expires_at;
  if (!expiresAt) return true;
  return Date.now() / 1000 > expiresAt;
}

export function getUserProfile(user: User | null): Record<string, unknown> {
  const config = getEngineConfig();
  if (config.auth?.profileExtractor && user) {
    return config.auth.profileExtractor(user.user_metadata || {});
  }
  return user?.user_metadata || {};
}

/**
 * Update user profile
 * Also updates cached offline credentials
 */
export async function updateProfile(
  profile: Record<string, unknown>
): Promise<{ error: string | null }> {
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
    } catch (e) {
      debugError('[Auth] Failed to update offline profile:', e);
    }
  }

  return { error: error?.message || null };
}

/**
 * Change user password
 * Verifies current password first, then updates
 * Also updates cached offline credentials
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<{ error: string | null }> {
  // Get current user email from session
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const user = session?.user;
  if (!user?.email) {
    return { error: 'No authenticated user found' };
  }

  // Verify current password: prefer local hash check, fall back to Supabase
  const creds = await getOfflineCredentials();
  if (creds && creds.password && creds.email === user.email) {
    // Local verification against cached hash
    let passwordMatch: boolean;
    if (isAlreadyHashed(creds.password)) {
      const hashedInput = await hashValue(currentPassword);
      passwordMatch = creds.password === hashedInput;
    } else {
      passwordMatch = creds.password === currentPassword;
    }
    if (!passwordMatch) {
      return { error: 'Current password is incorrect' };
    }
  } else {
    // No cached credentials — fall back to Supabase verification
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
    } catch (e) {
      debugError('[Auth] Failed to update offline password:', e);
    }
  }

  return { error: error?.message || null };
}

/**
 * Initiate an email change for the current user.
 * Supabase sends a confirmation email to the new address.
 */
export async function changeEmail(
  newEmail: string
): Promise<{ error: string | null; confirmationRequired: boolean }> {
  const { error } = await supabase.auth.updateUser({ email: newEmail });

  if (error) {
    return { error: error.message, confirmationRequired: false };
  }

  return { error: null, confirmationRequired: true };
}

/**
 * Complete email change after the user confirms via the email link.
 * Refreshes session to pick up the new email and updates offline credentials.
 */
export async function completeEmailChange(): Promise<{
  error: string | null;
  newEmail: string | null;
}> {
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
  } catch (e) {
    debugError('[Auth] Failed to update offline credentials after email change:', e);
  }

  return { error: null, newEmail };
}

/**
 * Resend confirmation email for signup
 * Should be rate-limited on the client side (30 second cooldown)
 */
export async function resendConfirmationEmail(email: string): Promise<{ error: string | null }> {
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
 * Verify OTP token (for email confirmation).
 * Absorbs confirm page's direct Supabase call.
 */
export async function verifyOtp(
  tokenHash: string,
  type: 'signup' | 'email' | 'email_change' | 'magiclink'
): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type
  });

  return { error: error?.message || null };
}

/**
 * Get a valid (non-expired) session, or null.
 * Merges getSession() + isSessionExpired() into a single call.
 */
export async function getValidSession(): Promise<Session | null> {
  const session = await getSession();
  if (!session) return null;
  if (isSessionExpired(session)) return null;
  return session;
}
