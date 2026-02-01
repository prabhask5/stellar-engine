/**
 * Offline Credentials Management
 * Handles caching, retrieval, and verification of user credentials for offline login
 */

import { getEngineConfig } from '../config';
import type { OfflineCredentials } from '../types';
import type { User, Session } from '@supabase/supabase-js';
import { debugLog, debugWarn, debugError } from '../debug';

const CREDENTIALS_ID = 'current_user';

/**
 * Cache user credentials for offline login
 * Called after successful Supabase login
 */
export async function cacheOfflineCredentials(
  email: string,
  password: string,
  user: User,
  _session: Session
): Promise<void> {
  // Validate inputs to prevent storing incomplete credentials
  if (!email || !password) {
    debugError('[Auth] Cannot cache credentials: email or password is empty');
    throw new Error('Cannot cache credentials: email or password is empty');
  }

  const config = getEngineConfig();
  const db = config.db;

  // Extract profile using config's profileExtractor, or use raw metadata
  const profile = config.auth?.profileExtractor
    ? config.auth.profileExtractor(user.user_metadata || {})
    : (user.user_metadata || {});

  const credentials: OfflineCredentials = {
    id: CREDENTIALS_ID,
    userId: user.id,
    email: email,
    password: password,
    profile,
    cachedAt: new Date().toISOString()
  };

  // Use put to insert or update the singleton record
  await db.table('offlineCredentials').put(credentials);

  // Verify the credentials were stored correctly (paranoid check)
  const stored = await db.table('offlineCredentials').get(CREDENTIALS_ID);
  if (!stored || !stored.password) {
    debugError('[Auth] Credentials were not stored correctly - password missing');
    throw new Error('Failed to store credentials: password not persisted');
  }
}

/**
 * Get cached offline credentials
 * Returns null if no credentials are cached or if credentials are in old format
 */
export async function getOfflineCredentials(): Promise<OfflineCredentials | null> {
  const db = getEngineConfig().db;
  const credentials = await db.table('offlineCredentials').get(CREDENTIALS_ID);
  if (!credentials) {
    return null;
  }

  return credentials as OfflineCredentials;
}

/**
 * Verify email and password against cached credentials
 * @param email - The email to verify
 * @param password - The password to verify
 * @param expectedUserId - The userId that the credentials should belong to
 * @returns Object with valid boolean and optional reason for failure
 */
export async function verifyOfflineCredentials(
  email: string,
  password: string,
  expectedUserId: string
): Promise<{ valid: boolean; reason?: string }> {
  const credentials = await getOfflineCredentials();
  if (!credentials) {
    debugWarn('[Auth] No credentials found in database');
    return { valid: false, reason: 'no_credentials' };
  }

  // SECURITY: Verify all fields match
  if (credentials.userId !== expectedUserId) {
    debugWarn('[Auth] Credential userId mismatch:', credentials.userId, '!==', expectedUserId);
    return { valid: false, reason: 'user_mismatch' };
  }

  if (credentials.email !== email) {
    debugWarn('[Auth] Credential email mismatch:', credentials.email, '!==', email);
    return { valid: false, reason: 'email_mismatch' };
  }

  if (!credentials.password) {
    debugWarn('[Auth] No password stored in credentials');
    return { valid: false, reason: 'no_stored_password' };
  }

  if (credentials.password !== password) {
    debugWarn(
      '[Auth] Password mismatch (stored length:',
      credentials.password.length,
      ', entered length:',
      password.length,
      ')'
    );
    return { valid: false, reason: 'password_mismatch' };
  }

  return { valid: true };
}

/**
 * Update the cached password (after online password change)
 * @param newPassword - The new password to cache
 */
export async function updateOfflineCredentialsPassword(newPassword: string): Promise<void> {
  const credentials = await getOfflineCredentials();
  if (!credentials) {
    return;
  }

  const db = getEngineConfig().db;
  await db.table('offlineCredentials').update(CREDENTIALS_ID, {
    password: newPassword,
    cachedAt: new Date().toISOString()
  });
}

/**
 * Update user profile in cached credentials (after online profile update)
 */
export async function updateOfflineCredentialsProfile(
  profile: Record<string, unknown>
): Promise<void> {
  const credentials = await getOfflineCredentials();
  if (!credentials) {
    return;
  }

  const db = getEngineConfig().db;
  await db.table('offlineCredentials').update(CREDENTIALS_ID, {
    profile,
    cachedAt: new Date().toISOString()
  });
}

/**
 * Clear all cached offline credentials (on logout)
 */
export async function clearOfflineCredentials(): Promise<void> {
  const db = getEngineConfig().db;
  await db.table('offlineCredentials').delete(CREDENTIALS_ID);
}
