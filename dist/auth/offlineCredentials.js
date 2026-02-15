/**
 * @fileoverview Offline Credentials Management
 *
 * Handles caching, retrieval, and update of user credentials in IndexedDB
 * for offline fallback support. When the user successfully authenticates
 * online via Supabase, their credentials are cached locally (with the
 * password SHA-256-hashed) so profile data is available while offline.
 *
 * Architecture:
 * - Credentials are stored as a singleton record (key: `'current_user'`) in the
 *   `offlineCredentials` IndexedDB table.
 * - Only one set of credentials is cached at a time.
 * - The profile blob is extracted via the host app's `profileExtractor` config
 *   callback, or falls back to raw Supabase `user_metadata`.
 *
 * Security considerations:
 * - Passwords are **always** hashed with SHA-256 before storage. The plaintext
 *   password is never persisted.
 * - New writes always hash the password before storage.
 * - A paranoid read-back verification is performed after `cacheOfflineCredentials`
 *   to ensure the password was actually persisted (guards against silent
 *   IndexedDB write failures).
 * - Credentials are cleared on logout via `clearOfflineCredentials`.
 *
 * @module auth/offlineCredentials
 */
import { getEngineConfig } from '../config';
import { debugError } from '../debug';
import { hashValue } from './crypto';
// =============================================================================
// CONSTANTS
// =============================================================================
/**
 * Singleton key used to store and retrieve the cached credentials record
 * in the `offlineCredentials` IndexedDB table. Only one credential set is
 * cached at any time.
 */
const CREDENTIALS_ID = 'current_user';
// =============================================================================
// PUBLIC API -- Cache & Retrieve
// =============================================================================
/**
 * Cache user credentials for offline login.
 *
 * Called after a successful Supabase login to persist a hashed copy of the
 * user's credentials in IndexedDB. Subsequent offline logins will verify
 * against these cached credentials.
 *
 * @param email    - The user's email address (used for offline identity matching).
 * @param password - The user's plaintext password. Will be SHA-256-hashed before storage.
 * @param user     - The Supabase `User` object, used to extract `userId` and profile data.
 * @param _session - The Supabase `Session` object. Currently unused but accepted for
 *                   API symmetry with the online auth flow (reserved for future use).
 *
 * @throws {Error} If `email` or `password` is empty (prevents storing incomplete credentials).
 * @throws {Error} If the write-back verification fails (password not persisted in IndexedDB).
 *
 * @example
 * ```ts
 * const { data } = await supabase.auth.signInWithPassword({ email, password });
 * if (data.user && data.session) {
 *   await cacheOfflineCredentials(email, password, data.user, data.session);
 * }
 * ```
 *
 * @see {@link getOfflineCredentials} to retrieve the cached credentials.
 * @see {@link clearOfflineCredentials} to remove them on logout.
 */
export async function cacheOfflineCredentials(email, password, user, _session) {
    /* Validate inputs to prevent storing incomplete credentials that would
       cause confusing verification failures later. */
    if (!email || !password) {
        debugError('[Auth] Cannot cache credentials: email or password is empty');
        throw new Error('Cannot cache credentials: email or password is empty');
    }
    const config = getEngineConfig();
    const db = config.db;
    /* Extract a normalized profile using the host app's profileExtractor,
       or fall back to raw Supabase user_metadata. This allows the host app
       to control which fields are available offline (e.g., firstName, role). */
    const profile = config.auth?.profileExtractor
        ? config.auth.profileExtractor(user.user_metadata || {})
        : user.user_metadata || {};
    const hashedPassword = await hashValue(password);
    const credentials = {
        id: CREDENTIALS_ID,
        userId: user.id,
        email: email,
        password: hashedPassword,
        profile,
        cachedAt: new Date().toISOString()
    };
    /* Use put (upsert) to insert or update the singleton record. */
    await db.table('offlineCredentials').put(credentials);
    /* Paranoid read-back: verify the credentials were stored correctly.
       IndexedDB writes can silently fail in quota-exceeded or private-browsing
       scenarios; catching this early gives a clear error instead of a mysterious
       "wrong password" on the next offline login. */
    const stored = await db.table('offlineCredentials').get(CREDENTIALS_ID);
    if (!stored || !stored.password) {
        debugError('[Auth] Credentials were not stored correctly - password missing');
        throw new Error('Failed to store credentials: password not persisted');
    }
}
/**
 * Get cached offline credentials from IndexedDB.
 *
 * Returns the singleton `OfflineCredentials` record, or `null` if no
 * credentials have been cached (e.g., user has never logged in online
 * on this device).
 *
 * @returns The cached credentials, or `null` if none exist.
 *
 * @example
 * ```ts
 * const creds = await getOfflineCredentials();
 * if (creds) {
 *   console.log('Cached user:', creds.email);
 * }
 * ```
 */
export async function getOfflineCredentials() {
    const db = getEngineConfig().db;
    const credentials = await db.table('offlineCredentials').get(CREDENTIALS_ID);
    if (!credentials) {
        return null;
    }
    return credentials;
}
// =============================================================================
// PUBLIC API -- Update & Clear
// =============================================================================
/**
 * Update the user profile in cached credentials after an online profile update.
 *
 * Replaces the entire `profile` blob with the provided object and updates
 * the `cachedAt` timestamp.
 *
 * @param profile - The new profile data to cache (e.g., `{ firstName, lastName, avatar }`).
 *
 * @example
 * ```ts
 * await supabase.auth.updateUser({ data: { firstName: 'Jane' } });
 * await updateOfflineCredentialsProfile({ firstName: 'Jane', lastName: 'Doe' });
 * ```
 */
export async function updateOfflineCredentialsProfile(profile) {
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
 * Clear all cached offline credentials from IndexedDB.
 *
 * Must be called on logout to ensure no stale credentials remain on the
 * device that could be used for unauthorized offline access.
 *
 * @example
 * ```ts
 * await supabase.auth.signOut();
 * await clearOfflineCredentials();
 * ```
 *
 * @see {@link cacheOfflineCredentials} for storing credentials on login.
 */
export async function clearOfflineCredentials() {
    const db = getEngineConfig().db;
    await db.table('offlineCredentials').delete(CREDENTIALS_ID);
}
//# sourceMappingURL=offlineCredentials.js.map