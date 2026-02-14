/**
 * @fileoverview Offline Session Management
 *
 * Handles creation, validation, retrieval, and cleanup of offline sessions
 * in IndexedDB. An offline session represents a locally authenticated state
 * when the device has no network connectivity and Supabase is unreachable.
 *
 * Architecture:
 * - Sessions are stored as a singleton record (key: `'current_session'`) in the
 *   `offlineSession` IndexedDB table.
 * - Each session contains a `userId` (Supabase user ID) and an `offlineToken`
 *   (random UUID) for local identification.
 * - Sessions do **not** expire on their own -- they are only revoked explicitly
 *   on re-authentication or logout. This design choice avoids locking users out
 *   of their own data during extended offline periods.
 *
 * Security considerations:
 * - The `offlineToken` is a `crypto.randomUUID()` value that serves as a local
 *   proof-of-authentication. It is NOT a JWT, carries no claims, and is never
 *   sent to a server.
 * - Anyone with access to the device's IndexedDB can read the offline session.
 *   This is an accepted trade-off for offline-capable apps.
 * - A write-back verification (read after write) is performed in
 *   `createOfflineSession` to catch silent IndexedDB persistence failures.
 * - On logout or session invalidation, `clearOfflineSession` deletes the
 *   singleton record entirely (not just nulling fields).
 *
 * @module auth/offlineSession
 */
import { getEngineConfig } from '../config';
// =============================================================================
// CONSTANTS
// =============================================================================
/**
 * Singleton key for the offline session record in IndexedDB.
 * Only one offline session exists at any given time.
 */
const SESSION_ID = 'current_session';
// =============================================================================
// PUBLIC API
// =============================================================================
/**
 * Create a new offline session in IndexedDB.
 *
 * Generates a fresh random UUID as the `offlineToken` and persists the session
 * as a singleton record. If a previous session exists, it is overwritten (upsert).
 *
 * A read-back verification is performed after the write to ensure the session
 * was actually persisted (guards against silent IndexedDB failures in
 * quota-exceeded or private-browsing scenarios).
 *
 * @param userId - The Supabase user ID to associate with the offline session.
 *                 This is later cross-referenced against cached credentials
 *                 during auth state resolution.
 * @returns The newly created {@link OfflineSession} object.
 *
 * @throws {Error} If the session could not be persisted (read-back verification failed).
 *
 * @example
 * ```ts
 * const session = await createOfflineSession(user.id);
 * console.log('Offline token:', session.offlineToken);
 * ```
 *
 * @see {@link getValidOfflineSession} to retrieve the current session.
 * @see {@link clearOfflineSession} to revoke the session on logout.
 */
export async function createOfflineSession(userId) {
    const now = new Date();
    const db = getEngineConfig().db;
    const session = {
        id: SESSION_ID,
        userId: userId,
        offlineToken: crypto.randomUUID(),
        createdAt: now.toISOString()
    };
    /* Use put (upsert) to insert or update the singleton record. */
    await db.table('offlineSession').put(session);
    /* Verify the session was persisted by reading it back. Without this check,
       a silent write failure would leave the user in a "logged in" state with
       no session record, causing downstream auth checks to fail. */
    const verified = await db.table('offlineSession').get(SESSION_ID);
    if (!verified) {
        throw new Error('Failed to persist offline session');
    }
    return session;
}
/**
 * Get the current offline session from IndexedDB.
 *
 * This is an internal helper -- external callers should use
 * {@link getValidOfflineSession} instead, which may include additional
 * validation in the future (e.g., expiration checks).
 *
 * @returns The current offline session, or `null` if none exists.
 */
async function getOfflineSession() {
    const db = getEngineConfig().db;
    const session = await db.table('offlineSession').get(SESSION_ID);
    return session || null;
}
/**
 * Get a valid offline session.
 *
 * Currently equivalent to `getOfflineSession()` (sessions do not expire),
 * but exists as a separate function to serve as the future hook for
 * adding expiration, rotation, or other validation logic without changing
 * the public API contract.
 *
 * @returns The current valid offline session, or `null` if no session exists.
 *
 * @example
 * ```ts
 * const session = await getValidOfflineSession();
 * if (session) {
 *   console.log('User is authenticated offline:', session.userId);
 * }
 * ```
 *
 * @see {@link createOfflineSession} to create a new session after verification.
 */
export async function getValidOfflineSession() {
    return await getOfflineSession();
}
/**
 * Clear the offline session from IndexedDB.
 *
 * Must be called on logout or session invalidation to revoke the user's
 * offline authentication state. Deletes the entire singleton record rather
 * than nulling individual fields, ensuring no remnant data remains.
 *
 * @example
 * ```ts
 * await supabase.auth.signOut();
 * await clearOfflineSession();
 * await clearOfflineCredentials();
 * ```
 *
 * @see {@link createOfflineSession} for session creation.
 */
export async function clearOfflineSession() {
    const db = getEngineConfig().db;
    await db.table('offlineSession').delete(SESSION_ID);
}
//# sourceMappingURL=offlineSession.js.map