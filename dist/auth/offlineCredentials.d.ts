/**
 * Offline Credentials Management
 * Handles caching, retrieval, and verification of user credentials for offline login
 */
import type { OfflineCredentials } from '../types';
import type { User, Session } from '@supabase/supabase-js';
/**
 * Cache user credentials for offline login
 * Called after successful Supabase login
 */
export declare function cacheOfflineCredentials(email: string, password: string, user: User, _session: Session): Promise<void>;
/**
 * Get cached offline credentials
 * Returns null if no credentials are cached or if credentials are in old format
 */
export declare function getOfflineCredentials(): Promise<OfflineCredentials | null>;
/**
 * Verify email and password against cached credentials
 * @param email - The email to verify
 * @param password - The password to verify
 * @param expectedUserId - The userId that the credentials should belong to
 * @returns Object with valid boolean and optional reason for failure
 */
export declare function verifyOfflineCredentials(email: string, password: string, expectedUserId: string): Promise<{
    valid: boolean;
    reason?: string;
}>;
/**
 * Update the cached password (after online password change)
 * @param newPassword - The new password to cache
 */
export declare function updateOfflineCredentialsPassword(newPassword: string): Promise<void>;
/**
 * Update user profile in cached credentials (after online profile update)
 */
export declare function updateOfflineCredentialsProfile(profile: Record<string, unknown>): Promise<void>;
/**
 * Clear all cached offline credentials (on logout)
 */
export declare function clearOfflineCredentials(): Promise<void>;
//# sourceMappingURL=offlineCredentials.d.ts.map