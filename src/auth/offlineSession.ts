/**
 * Offline Session Management
 * Handles creation, validation, and cleanup of offline sessions
 */

import { getEngineConfig } from '../config';
import type { OfflineSession } from '../types';

const SESSION_ID = 'current_session';

/**
 * Create a new offline session
 * @param userId - The Supabase user ID
 * @returns The created session
 */
export async function createOfflineSession(userId: string): Promise<OfflineSession> {
  const now = new Date();
  const db = getEngineConfig().db!;

  const session: OfflineSession = {
    id: SESSION_ID,
    userId: userId,
    offlineToken: crypto.randomUUID(),
    createdAt: now.toISOString()
  };

  // Use put to insert or update the singleton record
  await db.table('offlineSession').put(session);

  // Verify the session was persisted by reading it back
  const verified = await db.table('offlineSession').get(SESSION_ID);
  if (!verified) {
    throw new Error('Failed to persist offline session');
  }

  return session;
}

/**
 * Get the current offline session
 * Returns null if no session exists
 */
async function getOfflineSession(): Promise<OfflineSession | null> {
  const db = getEngineConfig().db!;
  const session = await db.table('offlineSession').get(SESSION_ID);
  return session || null;
}

/**
 * Get a valid offline session
 * Returns null if no session exists
 * Note: Sessions don't expire - they're only revoked on re-auth or logout
 */
export async function getValidOfflineSession(): Promise<OfflineSession | null> {
  return await getOfflineSession();
}

/**
 * Clear the offline session (on logout or session invalidation)
 */
export async function clearOfflineSession(): Promise<void> {
  const db = getEngineConfig().db!;
  await db.table('offlineSession').delete(SESSION_ID);
}

