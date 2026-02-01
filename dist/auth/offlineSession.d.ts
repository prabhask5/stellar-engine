/**
 * Offline Session Management
 * Handles creation, validation, and cleanup of offline sessions
 */
import type { OfflineSession } from '../types';
/**
 * Create a new offline session
 * @param userId - The Supabase user ID
 * @returns The created session
 */
export declare function createOfflineSession(userId: string): Promise<OfflineSession>;
/**
 * Get a valid offline session
 * Returns null if no session exists
 * Note: Sessions don't expire - they're only revoked on re-auth or logout
 */
export declare function getValidOfflineSession(): Promise<OfflineSession | null>;
/**
 * Clear the offline session (on logout or session invalidation)
 */
export declare function clearOfflineSession(): Promise<void>;
//# sourceMappingURL=offlineSession.d.ts.map