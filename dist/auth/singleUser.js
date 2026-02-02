/**
 * Single-User Auth Module
 *
 * Implements a local gate (code or password) verified against a SHA-256 hash
 * stored in IndexedDB. Uses Supabase anonymous auth for session/token management
 * and RLS compliance. Falls back to offline auth when connectivity is unavailable.
 */
import { getEngineConfig } from '../config';
import { supabase } from '../supabase/client';
import { hashValue } from './crypto';
import { cacheOfflineCredentials } from './offlineCredentials';
import { createOfflineSession } from './offlineSession';
import { authState } from '../stores/authState';
import { syncStatusStore } from '../stores/sync';
import { getSession, isSessionExpired } from '../supabase/auth';
import { debugLog, debugWarn, debugError } from '../debug';
const CONFIG_ID = 'config';
const SINGLE_USER_EMAIL_DOMAIN = 'single-user.local';
// ============================================================
// HELPERS
// ============================================================
function getDb() {
    const db = getEngineConfig().db;
    if (!db)
        throw new Error('Database not initialized.');
    return db;
}
function getSingleUserEmail() {
    const config = getEngineConfig();
    return `single-user@${config.prefix || 'app'}.${SINGLE_USER_EMAIL_DOMAIN}`;
}
async function readConfig() {
    const db = getDb();
    const record = await db.table('singleUserConfig').get(CONFIG_ID);
    return record;
}
async function writeConfig(config) {
    const db = getDb();
    await db.table('singleUserConfig').put(config);
}
// ============================================================
// PUBLIC API
// ============================================================
/**
 * Check if single-user mode has been set up (config exists in IndexedDB).
 */
export async function isSingleUserSetUp() {
    try {
        const config = await readConfig();
        return config !== null;
    }
    catch {
        return false;
    }
}
/**
 * Get non-sensitive display info about the single user.
 * Returns null if not set up.
 */
export async function getSingleUserInfo() {
    const config = await readConfig();
    if (!config)
        return null;
    return {
        profile: config.profile,
        gateType: config.gateType,
        codeLength: config.codeLength
    };
}
/**
 * First-time setup: hash gate, create anonymous Supabase user (if online),
 * store config, and set auth state.
 */
export async function setupSingleUser(gate, profile) {
    try {
        const engineConfig = getEngineConfig();
        const singleUserOpts = engineConfig.auth?.singleUser;
        const gateType = singleUserOpts?.gateType || 'code';
        const codeLength = singleUserOpts?.codeLength;
        const gateHash = await hashValue(gate);
        const now = new Date().toISOString();
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        // Build profile metadata for Supabase user_metadata
        const profileToMetadata = engineConfig.auth?.profileToMetadata;
        const metadata = profileToMetadata ? profileToMetadata(profile) : profile;
        if (!isOffline) {
            // --- ONLINE SETUP ---
            const { data, error } = await supabase.auth.signInAnonymously();
            if (error) {
                debugError('[SingleUser] Anonymous sign-in failed:', error.message);
                return { error: `Setup failed: ${error.message}` };
            }
            const session = data.session;
            const user = data.user;
            // Store profile in user_metadata so userDisplayInfo works unchanged
            const { error: updateError } = await supabase.auth.updateUser({ data: metadata });
            if (updateError) {
                debugWarn('[SingleUser] Failed to set user_metadata:', updateError.message);
            }
            // Store config in IndexedDB
            const config = {
                id: CONFIG_ID,
                gateType,
                codeLength,
                gateHash,
                profile,
                supabaseUserId: user.id,
                setupAt: now,
                updatedAt: now
            };
            await writeConfig(config);
            // Cache offline credentials for offline fallback
            try {
                await cacheOfflineCredentials(getSingleUserEmail(), gate, user, session);
            }
            catch (e) {
                debugWarn('[SingleUser] Failed to cache offline credentials:', e);
            }
            // Create offline session for offline fallback
            try {
                await createOfflineSession(user.id);
            }
            catch (e) {
                debugWarn('[SingleUser] Failed to create offline session:', e);
            }
            // Set auth state
            authState.setSupabaseAuth(session);
            debugLog('[SingleUser] Setup complete (online), userId:', user.id);
        }
        else {
            // --- OFFLINE SETUP ---
            const tempUserId = crypto.randomUUID();
            const config = {
                id: CONFIG_ID,
                gateType,
                codeLength,
                gateHash,
                profile,
                // supabaseUserId deferred until online
                setupAt: now,
                updatedAt: now
            };
            await writeConfig(config);
            // Create offline session with temp ID
            await createOfflineSession(tempUserId);
            // Build offline profile for authState
            const offlineProfile = {
                id: 'current_user',
                userId: tempUserId,
                email: getSingleUserEmail(),
                password: gateHash,
                profile,
                cachedAt: now
            };
            authState.setOfflineAuth(offlineProfile);
            debugLog('[SingleUser] Setup complete (offline), temp userId:', tempUserId);
        }
        return { error: null };
    }
    catch (e) {
        debugError('[SingleUser] Setup error:', e);
        return { error: e instanceof Error ? e.message : 'Setup failed' };
    }
}
/**
 * Unlock: verify gate hash, restore Supabase session or fall back to offline auth.
 */
export async function unlockSingleUser(gate) {
    try {
        const config = await readConfig();
        if (!config) {
            return { error: 'Single-user mode is not set up' };
        }
        // Verify gate
        const inputHash = await hashValue(gate);
        if (inputHash !== config.gateHash) {
            return { error: 'Incorrect code' };
        }
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        const engineConfig = getEngineConfig();
        if (!isOffline) {
            // --- ONLINE UNLOCK ---
            // Try existing session first
            const existingSession = await getSession();
            if (existingSession && !isSessionExpired(existingSession)) {
                authState.setSupabaseAuth(existingSession);
                debugLog('[SingleUser] Unlocked with existing session');
                return { error: null };
            }
            // No valid session — sign in anonymously again
            const { data, error } = await supabase.auth.signInAnonymously();
            if (error) {
                debugError('[SingleUser] Anonymous sign-in failed on unlock:', error.message);
                return { error: `Unlock failed: ${error.message}` };
            }
            const session = data.session;
            const user = data.user;
            // If user ID changed (new anonymous user), update config
            if (config.supabaseUserId && user.id !== config.supabaseUserId) {
                debugWarn('[SingleUser] New anonymous user ID, updating config');
                config.supabaseUserId = user.id;
                config.updatedAt = new Date().toISOString();
                await writeConfig(config);
                // Reset sync cursor for new user (dynamic import to avoid circular deps)
                try {
                    if (typeof localStorage !== 'undefined') {
                        // Clear old user cursor
                        const keys = Object.keys(localStorage).filter(k => k.startsWith('lastSyncCursor_'));
                        keys.forEach(k => localStorage.removeItem(k));
                    }
                }
                catch {
                    // Ignore storage errors
                }
            }
            else if (!config.supabaseUserId) {
                // First time online after offline setup
                config.supabaseUserId = user.id;
                config.updatedAt = new Date().toISOString();
                await writeConfig(config);
            }
            // Re-apply profile to user_metadata
            const profileToMetadata = engineConfig.auth?.profileToMetadata;
            const metadata = profileToMetadata ? profileToMetadata(config.profile) : config.profile;
            await supabase.auth.updateUser({ data: metadata }).catch((e) => {
                debugWarn('[SingleUser] Failed to update user_metadata on unlock:', e);
            });
            // Update offline credentials cache
            try {
                await cacheOfflineCredentials(getSingleUserEmail(), gate, user, session);
            }
            catch (e) {
                debugWarn('[SingleUser] Failed to update offline credentials:', e);
            }
            // Update offline session
            try {
                await createOfflineSession(user.id);
            }
            catch (e) {
                debugWarn('[SingleUser] Failed to update offline session:', e);
            }
            authState.setSupabaseAuth(session);
            debugLog('[SingleUser] Unlocked online, userId:', user.id);
        }
        else {
            // --- OFFLINE UNLOCK ---
            // Try cached Supabase session from localStorage
            const cachedSession = await getSession();
            if (cachedSession) {
                authState.setSupabaseAuth(cachedSession);
                debugLog('[SingleUser] Unlocked offline with cached Supabase session');
                return { error: null };
            }
            // No cached session — fall back to offline auth
            const userId = config.supabaseUserId || crypto.randomUUID();
            await createOfflineSession(userId);
            const offlineProfile = {
                id: 'current_user',
                userId,
                email: getSingleUserEmail(),
                password: config.gateHash,
                profile: config.profile,
                cachedAt: new Date().toISOString()
            };
            authState.setOfflineAuth(offlineProfile);
            debugLog('[SingleUser] Unlocked offline with offline session');
        }
        return { error: null };
    }
    catch (e) {
        debugError('[SingleUser] Unlock error:', e);
        return { error: e instanceof Error ? e.message : 'Unlock failed' };
    }
}
/**
 * Lock: stop sync engine, reset auth state to 'none'.
 * Does NOT destroy session, data, or sign out of Supabase.
 */
export async function lockSingleUser() {
    try {
        // Dynamic import to avoid circular deps
        const { stopSyncEngine } = await import('../engine');
        await stopSyncEngine();
    }
    catch (e) {
        debugError('[SingleUser] Failed to stop sync engine on lock:', e);
    }
    syncStatusStore.reset();
    authState.setNoAuth();
    debugLog('[SingleUser] Locked');
}
/**
 * Change the gate (code/password). Verifies old gate first.
 */
export async function changeSingleUserGate(oldGate, newGate) {
    try {
        const config = await readConfig();
        if (!config) {
            return { error: 'Single-user mode is not set up' };
        }
        // Verify old gate
        const oldHash = await hashValue(oldGate);
        if (oldHash !== config.gateHash) {
            return { error: 'Current code is incorrect' };
        }
        // Update hash
        const newHash = await hashValue(newGate);
        config.gateHash = newHash;
        config.updatedAt = new Date().toISOString();
        await writeConfig(config);
        // Update offline credentials cache if it exists
        try {
            const db = getDb();
            const creds = await db.table('offlineCredentials').get('current_user');
            if (creds) {
                await db.table('offlineCredentials').update('current_user', {
                    password: newHash,
                    cachedAt: new Date().toISOString()
                });
            }
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to update offline credentials after gate change:', e);
        }
        debugLog('[SingleUser] Gate changed successfully');
        return { error: null };
    }
    catch (e) {
        debugError('[SingleUser] Gate change error:', e);
        return { error: e instanceof Error ? e.message : 'Failed to change code' };
    }
}
/**
 * Update profile in IndexedDB and Supabase user_metadata.
 */
export async function updateSingleUserProfile(profile) {
    try {
        const config = await readConfig();
        if (!config) {
            return { error: 'Single-user mode is not set up' };
        }
        // Update IndexedDB
        config.profile = profile;
        config.updatedAt = new Date().toISOString();
        await writeConfig(config);
        // Update Supabase user_metadata if online
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        if (!isOffline) {
            const engineConfig = getEngineConfig();
            const profileToMetadata = engineConfig.auth?.profileToMetadata;
            const metadata = profileToMetadata ? profileToMetadata(profile) : profile;
            const { error } = await supabase.auth.updateUser({ data: metadata });
            if (error) {
                debugWarn('[SingleUser] Failed to update Supabase profile:', error.message);
            }
            else {
                // Update auth state to reflect changes in UI
                authState.updateUserProfile(metadata);
            }
        }
        // Update offline credentials cache
        try {
            const db = getDb();
            const creds = await db.table('offlineCredentials').get('current_user');
            if (creds) {
                await db.table('offlineCredentials').update('current_user', {
                    profile,
                    cachedAt: new Date().toISOString()
                });
            }
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to update offline credentials profile:', e);
        }
        debugLog('[SingleUser] Profile updated');
        return { error: null };
    }
    catch (e) {
        debugError('[SingleUser] Profile update error:', e);
        return { error: e instanceof Error ? e.message : 'Failed to update profile' };
    }
}
/**
 * Full reset: clear config, sign out of Supabase, clear all data.
 */
export async function resetSingleUser() {
    try {
        // Import signOut which handles full cleanup
        const { signOut } = await import('../supabase/auth');
        const result = await signOut();
        // Clear single-user config
        try {
            const db = getDb();
            await db.table('singleUserConfig').delete(CONFIG_ID);
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to clear config on reset:', e);
        }
        debugLog('[SingleUser] Reset complete');
        return { error: result.error };
    }
    catch (e) {
        debugError('[SingleUser] Reset error:', e);
        return { error: e instanceof Error ? e.message : 'Reset failed' };
    }
}
//# sourceMappingURL=singleUser.js.map