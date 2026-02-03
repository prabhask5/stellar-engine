/**
 * Single-User Auth Module
 *
 * Uses Supabase email/password auth where the PIN *is* the password (padded).
 * Replaces the previous anonymous auth + client-side SHA-256 hash approach.
 *
 * - Setup: signUp() with email + padded PIN
 * - Unlock: signInWithPassword() with email + padded PIN
 * - Device verification: signInWithOtp() for untrusted devices
 * - Offline fallback: cached credentials in IndexedDB
 */
import { getEngineConfig } from '../config';
import { supabase } from '../supabase/client';
import { hashValue } from './crypto';
import { cacheOfflineCredentials } from './offlineCredentials';
import { createOfflineSession } from './offlineSession';
import { isDeviceTrusted, trustCurrentDevice, touchTrustedDevice, sendDeviceVerification, maskEmail } from './deviceVerification';
import { authState } from '../stores/authState';
import { syncStatusStore } from '../stores/sync';
import { getSession } from '../supabase/auth';
import { debugLog, debugWarn, debugError } from '../debug';
const CONFIG_ID = 'config';
// ============================================================
// HELPERS
// ============================================================
function getDb() {
    const db = getEngineConfig().db;
    if (!db)
        throw new Error('Database not initialized.');
    return db;
}
/**
 * Pad a PIN to meet Supabase's minimum password length.
 * e.g. "1234" → "1234_stellar" (12 chars, well above the 6-char minimum)
 */
export function padPin(pin) {
    const prefix = getEngineConfig().prefix || 'app';
    return `${pin}_${prefix}`;
}
function getConfirmRedirectUrl() {
    if (typeof window !== 'undefined') {
        const path = getEngineConfig().auth?.confirmRedirectPath || '/confirm';
        return `${window.location.origin}${path}`;
    }
    return '/confirm';
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
        codeLength: config.codeLength,
        email: config.email,
        maskedEmail: config.email ? maskEmail(config.email) : undefined,
    };
}
/**
 * First-time setup: create Supabase user with email/password auth.
 *
 * Uses signUp() which sends a confirmation email if emailConfirmation is enabled.
 * The PIN is padded to meet Supabase's minimum password length.
 *
 * @returns confirmationRequired — true if the caller should show a "check your email" modal
 */
export async function setupSingleUser(gate, profile, email) {
    try {
        const engineConfig = getEngineConfig();
        const singleUserOpts = engineConfig.auth?.singleUser;
        const gateType = singleUserOpts?.gateType || 'code';
        const codeLength = singleUserOpts?.codeLength;
        const emailConfirmationEnabled = engineConfig.auth?.emailConfirmation?.enabled ?? false;
        const paddedPassword = padPin(gate);
        const gateHash = await hashValue(gate); // Keep hash for offline fallback
        const now = new Date().toISOString();
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        // Build profile metadata for Supabase user_metadata
        const profileToMetadata = engineConfig.auth?.profileToMetadata;
        const metadata = {
            ...(profileToMetadata ? profileToMetadata(profile) : profile),
            code_length: codeLength ?? 6,
        };
        if (!isOffline) {
            // --- ONLINE SETUP ---
            const { data, error } = await supabase.auth.signUp({
                email,
                password: paddedPassword,
                options: {
                    emailRedirectTo: getConfirmRedirectUrl(),
                    data: metadata,
                },
            });
            if (error) {
                debugError('[SingleUser] signUp failed:', error.message);
                return { error: `Setup failed: ${error.message}`, confirmationRequired: false };
            }
            const user = data.user;
            const session = data.session; // null if email confirmation required
            // Store config in IndexedDB
            const config = {
                id: CONFIG_ID,
                gateType,
                codeLength,
                gateHash,
                email,
                profile,
                supabaseUserId: user.id,
                setupAt: now,
                updatedAt: now,
            };
            await writeConfig(config);
            // If email confirmation is required, session will be null
            // The caller should show a "check your email" modal
            if (emailConfirmationEnabled && !session) {
                debugLog('[SingleUser] Setup initiated, awaiting email confirmation for:', email);
                return { error: null, confirmationRequired: true };
            }
            // No confirmation needed (or already confirmed) — proceed immediately
            if (session) {
                // Cache offline credentials
                try {
                    await cacheOfflineCredentials(email, gate, user, session);
                }
                catch (e) {
                    debugWarn('[SingleUser] Failed to cache offline credentials:', e);
                }
                // Create offline session
                try {
                    await createOfflineSession(user.id);
                }
                catch (e) {
                    debugWarn('[SingleUser] Failed to create offline session:', e);
                }
                // Auto-trust current device
                try {
                    await trustCurrentDevice(user.id);
                }
                catch (e) {
                    debugWarn('[SingleUser] Failed to trust device:', e);
                }
                authState.setSupabaseAuth(session);
                debugLog('[SingleUser] Setup complete (online, no confirmation needed), userId:', user.id);
            }
            return { error: null, confirmationRequired: false };
        }
        else {
            // --- OFFLINE SETUP ---
            const tempUserId = crypto.randomUUID();
            const config = {
                id: CONFIG_ID,
                gateType,
                codeLength,
                gateHash,
                email,
                profile,
                setupAt: now,
                updatedAt: now,
            };
            await writeConfig(config);
            await createOfflineSession(tempUserId);
            const offlineProfile = {
                id: 'current_user',
                userId: tempUserId,
                email,
                password: gateHash,
                profile,
                cachedAt: now,
            };
            authState.setOfflineAuth(offlineProfile);
            debugLog('[SingleUser] Setup complete (offline), temp userId:', tempUserId);
            return { error: null, confirmationRequired: false };
        }
    }
    catch (e) {
        debugError('[SingleUser] Setup error:', e);
        return { error: e instanceof Error ? e.message : 'Setup failed', confirmationRequired: false };
    }
}
/**
 * Complete setup after email confirmation succeeds.
 * Called when the original tab receives AUTH_CONFIRMED via BroadcastChannel.
 */
export async function completeSingleUserSetup() {
    try {
        const config = await readConfig();
        if (!config) {
            return { error: 'Single-user config not found' };
        }
        // After email confirmation, the session should now be available
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !session) {
            debugError('[SingleUser] No session after confirmation:', sessionError?.message);
            return { error: 'Session not found after confirmation. Please try logging in.' };
        }
        const user = session.user;
        // Update config with user ID if needed
        if (!config.supabaseUserId) {
            config.supabaseUserId = user.id;
            config.updatedAt = new Date().toISOString();
            await writeConfig(config);
        }
        // Cache offline credentials
        try {
            await cacheOfflineCredentials(config.email || '', config.gateHash || '', user, session);
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to cache offline credentials after confirmation:', e);
        }
        // Create offline session
        try {
            await createOfflineSession(user.id);
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to create offline session after confirmation:', e);
        }
        // Auto-trust current device
        try {
            await trustCurrentDevice(user.id);
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to trust device after confirmation:', e);
        }
        authState.setSupabaseAuth(session);
        debugLog('[SingleUser] Setup completed after email confirmation, userId:', user.id);
        return { error: null };
    }
    catch (e) {
        debugError('[SingleUser] Complete setup error:', e);
        return { error: e instanceof Error ? e.message : 'Failed to complete setup' };
    }
}
/**
 * Unlock: verify PIN via signInWithPassword, handle device verification.
 *
 * Returns deviceVerificationRequired if the device is untrusted.
 */
export async function unlockSingleUser(gate) {
    try {
        const config = await readConfig();
        if (!config) {
            return { error: 'Single-user mode is not set up' };
        }
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        const engineConfig = getEngineConfig();
        if (!isOffline && config.email) {
            // --- ONLINE UNLOCK via Supabase signInWithPassword ---
            const paddedPassword = padPin(gate);
            const { data, error } = await supabase.auth.signInWithPassword({
                email: config.email,
                password: paddedPassword,
            });
            if (error) {
                debugWarn('[SingleUser] signInWithPassword failed:', error.message);
                return { error: 'Incorrect code' };
            }
            const session = data.session;
            const user = data.user;
            // Update supabaseUserId if needed
            if (config.supabaseUserId !== user.id) {
                config.supabaseUserId = user.id;
                config.updatedAt = new Date().toISOString();
                await writeConfig(config);
            }
            // Check device verification
            const deviceVerificationEnabled = engineConfig.auth?.deviceVerification?.enabled ?? false;
            if (deviceVerificationEnabled) {
                const trusted = await isDeviceTrusted(user.id);
                if (!trusted) {
                    // Untrusted device — sign out, send OTP
                    debugLog('[SingleUser] Untrusted device detected, sending OTP');
                    const { error: otpError } = await sendDeviceVerification(config.email);
                    if (otpError) {
                        debugError('[SingleUser] Failed to send device verification:', otpError);
                    }
                    return {
                        error: null,
                        deviceVerificationRequired: true,
                        maskedEmail: maskEmail(config.email),
                    };
                }
                // Trusted — touch device
                await touchTrustedDevice(user.id);
            }
            // Re-apply profile to user_metadata
            const profileToMetadata = engineConfig.auth?.profileToMetadata;
            const metadata = profileToMetadata ? profileToMetadata(config.profile) : config.profile;
            await supabase.auth.updateUser({ data: metadata }).catch((e) => {
                debugWarn('[SingleUser] Failed to update user_metadata on unlock:', e);
            });
            // Cache offline credentials
            try {
                await cacheOfflineCredentials(config.email, gate, user, session);
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
            // Update local gateHash for offline fallback
            const newHash = await hashValue(gate);
            if (config.gateHash !== newHash) {
                config.gateHash = newHash;
                config.updatedAt = new Date().toISOString();
                await writeConfig(config);
            }
            authState.setSupabaseAuth(session);
            debugLog('[SingleUser] Unlocked online, userId:', user.id);
            return { error: null };
        }
        else {
            // --- OFFLINE UNLOCK (or no email — legacy migration) ---
            // Fall back to local hash verification
            const inputHash = await hashValue(gate);
            if (config.gateHash && inputHash !== config.gateHash) {
                return { error: 'Incorrect code' };
            }
            // Try cached Supabase session
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
                email: config.email || '',
                password: config.gateHash || inputHash,
                profile: config.profile,
                cachedAt: new Date().toISOString(),
            };
            authState.setOfflineAuth(offlineProfile);
            debugLog('[SingleUser] Unlocked offline with offline session');
            return { error: null };
        }
    }
    catch (e) {
        debugError('[SingleUser] Unlock error:', e);
        return { error: e instanceof Error ? e.message : 'Unlock failed' };
    }
}
/**
 * Complete device verification after OTP email link is clicked.
 * Called when the original tab receives AUTH_CONFIRMED via BroadcastChannel.
 */
export async function completeDeviceVerification(tokenHash) {
    try {
        // If tokenHash is provided, verify it (called from confirm page)
        if (tokenHash) {
            const { verifyDeviceCode } = await import('./deviceVerification');
            const { error } = await verifyDeviceCode(tokenHash);
            if (error)
                return { error };
        }
        // After OTP verification, session should be available
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !session) {
            return { error: 'Session not found after verification' };
        }
        const user = session.user;
        // Trust the device
        await trustCurrentDevice(user.id);
        // Cache credentials
        const config = await readConfig();
        if (config?.email) {
            try {
                await cacheOfflineCredentials(config.email, config.gateHash || '', user, session);
            }
            catch (e) {
                debugWarn('[SingleUser] Failed to cache credentials after device verification:', e);
            }
        }
        // Create offline session
        try {
            await createOfflineSession(user.id);
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to create offline session after device verification:', e);
        }
        authState.setSupabaseAuth(session);
        debugLog('[SingleUser] Device verification complete, userId:', user.id);
        return { error: null };
    }
    catch (e) {
        debugError('[SingleUser] Device verification error:', e);
        return { error: e instanceof Error ? e.message : 'Device verification failed' };
    }
}
/**
 * Poll whether this device has been trusted (e.g. after OTP verified on another device).
 *
 * Requires an active session (sendDeviceVerification keeps the session alive).
 * The confirm page calls trustPendingDevice() which trusts the originating device,
 * so this check will pass once verification is complete on any device.
 */
export async function pollDeviceVerification() {
    try {
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user)
            return false;
        return isDeviceTrusted(user.id);
    }
    catch {
        return false;
    }
}
/**
 * Lock: stop sync engine, reset auth state to 'none'.
 * Does NOT destroy session, data, or sign out of Supabase.
 */
export async function lockSingleUser() {
    try {
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
 * Change the gate (code/password). Verifies old gate via signInWithPassword.
 */
export async function changeSingleUserGate(oldGate, newGate) {
    try {
        const config = await readConfig();
        if (!config) {
            return { error: 'Single-user mode is not set up' };
        }
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        if (!isOffline && config.email) {
            // Online: verify old gate via Supabase, then update password
            const { error: verifyError } = await supabase.auth.signInWithPassword({
                email: config.email,
                password: padPin(oldGate),
            });
            if (verifyError) {
                return { error: 'Current code is incorrect' };
            }
            // Update password in Supabase
            const { error: updateError } = await supabase.auth.updateUser({
                password: padPin(newGate),
            });
            if (updateError) {
                return { error: `Failed to update code: ${updateError.message}` };
            }
        }
        else {
            // Offline: verify against local hash
            const oldHash = await hashValue(oldGate);
            if (config.gateHash && oldHash !== config.gateHash) {
                return { error: 'Current code is incorrect' };
            }
        }
        // Update local hash
        const newHash = await hashValue(newGate);
        config.gateHash = newHash;
        config.updatedAt = new Date().toISOString();
        await writeConfig(config);
        // Update offline credentials cache
        try {
            const db = getDb();
            const creds = await db.table('offlineCredentials').get('current_user');
            if (creds) {
                await db.table('offlineCredentials').update('current_user', {
                    password: newHash,
                    cachedAt: new Date().toISOString(),
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
        config.profile = profile;
        config.updatedAt = new Date().toISOString();
        await writeConfig(config);
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
                    cachedAt: new Date().toISOString(),
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
 * Initiate an email change. Requires online state.
 * Supabase sends a confirmation email to the new address.
 */
export async function changeSingleUserEmail(newEmail) {
    try {
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        if (isOffline) {
            return { error: 'Email change requires an internet connection', confirmationRequired: false };
        }
        const config = await readConfig();
        if (!config) {
            return { error: 'Single-user mode is not set up', confirmationRequired: false };
        }
        const { error } = await supabase.auth.updateUser({ email: newEmail });
        if (error) {
            debugError('[SingleUser] Email change failed:', error.message);
            return { error: `Email change failed: ${error.message}`, confirmationRequired: false };
        }
        debugLog('[SingleUser] Email change initiated, confirmation required for:', newEmail);
        return { error: null, confirmationRequired: true };
    }
    catch (e) {
        debugError('[SingleUser] Email change error:', e);
        return { error: e instanceof Error ? e.message : 'Email change failed', confirmationRequired: false };
    }
}
/**
 * Complete email change after the user confirms via the email link.
 * Called when the original tab receives AUTH_CONFIRMED with type 'email_change'.
 */
export async function completeSingleUserEmailChange() {
    try {
        // Refresh session to get updated user data
        const { data, error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError || !data.session) {
            debugError('[SingleUser] Failed to refresh session after email change:', refreshError?.message);
            return { error: 'Failed to refresh session after email change', newEmail: null };
        }
        const session = data.session;
        const newEmail = session.user.email;
        if (!newEmail) {
            return { error: 'No email found in updated session', newEmail: null };
        }
        // Update local IndexedDB config
        const config = await readConfig();
        if (config) {
            config.email = newEmail;
            config.updatedAt = new Date().toISOString();
            await writeConfig(config);
        }
        // Update offline credentials cache
        try {
            const db = getDb();
            const creds = await db.table('offlineCredentials').get('current_user');
            if (creds) {
                await db.table('offlineCredentials').update('current_user', {
                    email: newEmail,
                    cachedAt: new Date().toISOString(),
                });
            }
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to update offline credentials after email change:', e);
        }
        authState.setSupabaseAuth(session);
        debugLog('[SingleUser] Email change completed, new email:', newEmail);
        return { error: null, newEmail };
    }
    catch (e) {
        debugError('[SingleUser] Complete email change error:', e);
        return { error: e instanceof Error ? e.message : 'Failed to complete email change', newEmail: null };
    }
}
/**
 * Full reset: clear config, sign out of Supabase, clear all data.
 */
export async function resetSingleUser() {
    try {
        const { signOut } = await import('../supabase/auth');
        const result = await signOut();
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
// ============================================================
// MULTI-DEVICE + EXTENSION SUPPORT
// ============================================================
/**
 * Fetch remote gate config via the get_extension_config() RPC.
 * Returns user info if a user exists in Supabase, null otherwise.
 * Works without authentication (uses anon key).
 */
export async function fetchRemoteGateConfig() {
    try {
        const { data, error } = await supabase.rpc('get_extension_config');
        if (error) {
            debugWarn('[SingleUser] fetchRemoteGateConfig RPC error:', error.message);
            return null;
        }
        if (!data || !data.email) {
            return null;
        }
        return {
            email: data.email,
            gateType: data.gateType || 'code',
            codeLength: data.codeLength || 6,
            profile: data.profile || {},
        };
    }
    catch (e) {
        debugError('[SingleUser] fetchRemoteGateConfig error:', e);
        return null;
    }
}
/**
 * Link a new device to an existing single-user account.
 * Signs in with email + padded PIN, builds local config from user_metadata.
 */
export async function linkSingleUserDevice(email, pin) {
    try {
        const engineConfig = getEngineConfig();
        const singleUserOpts = engineConfig.auth?.singleUser;
        const gateType = singleUserOpts?.gateType || 'code';
        const codeLength = singleUserOpts?.codeLength;
        const paddedPassword = padPin(pin);
        const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password: paddedPassword,
        });
        if (error) {
            debugWarn('[SingleUser] linkSingleUserDevice signIn failed:', error.message);
            return { error: 'Incorrect code' };
        }
        const session = data.session;
        const user = data.user;
        // Build profile from user_metadata (reverse of profileToMetadata)
        const profileExtractor = engineConfig.auth?.profileExtractor;
        const userMeta = user.user_metadata || {};
        const profile = profileExtractor ? profileExtractor(userMeta) : userMeta;
        // Build and write local config
        const gateHash = await hashValue(pin);
        const now = new Date().toISOString();
        const config = {
            id: CONFIG_ID,
            gateType,
            codeLength,
            gateHash,
            email,
            profile,
            supabaseUserId: user.id,
            setupAt: now,
            updatedAt: now,
        };
        await writeConfig(config);
        // Check device verification
        const deviceVerificationEnabled = engineConfig.auth?.deviceVerification?.enabled ?? false;
        if (deviceVerificationEnabled) {
            const trusted = await isDeviceTrusted(user.id);
            if (!trusted) {
                debugLog('[SingleUser] linkSingleUserDevice: untrusted device, sending OTP');
                const { error: otpError } = await sendDeviceVerification(email);
                if (otpError) {
                    debugError('[SingleUser] Failed to send device verification:', otpError);
                }
                return {
                    error: null,
                    deviceVerificationRequired: true,
                    maskedEmail: maskEmail(email),
                };
            }
            await touchTrustedDevice(user.id);
        }
        // Cache offline credentials
        try {
            await cacheOfflineCredentials(email, pin, user, session);
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to cache offline credentials on link:', e);
        }
        // Create offline session
        try {
            await createOfflineSession(user.id);
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to create offline session on link:', e);
        }
        authState.setSupabaseAuth(session);
        debugLog('[SingleUser] Device linked successfully, userId:', user.id);
        return { error: null };
    }
    catch (e) {
        debugError('[SingleUser] linkSingleUserDevice error:', e);
        return { error: e instanceof Error ? e.message : 'Failed to link device' };
    }
}
/**
 * Reset the remote single user via the reset_single_user() RPC.
 * Also clears all local auth state (IndexedDB + localStorage).
 */
export async function resetSingleUserRemote() {
    try {
        const { error } = await supabase.rpc('reset_single_user');
        if (error) {
            debugError('[SingleUser] resetSingleUserRemote RPC error:', error.message);
            return { error: error.message };
        }
        // Sign out to clear in-memory session and persisted auth tokens
        try {
            await supabase.auth.signOut();
        }
        catch {
            // Ignore — session may already be invalid
        }
        // Clear local IndexedDB state
        try {
            const db = getDb();
            await db.table('singleUserConfig').delete(CONFIG_ID);
            await db.table('offlineCredentials').delete('current_user');
            await db.table('offlineSession').delete('current_session');
        }
        catch (e) {
            debugWarn('[SingleUser] Failed to clear local state on remote reset:', e);
        }
        // Clear any remaining Supabase session from localStorage
        try {
            if (typeof localStorage !== 'undefined') {
                const keys = Object.keys(localStorage).filter((k) => k.startsWith('sb-'));
                keys.forEach((k) => localStorage.removeItem(k));
            }
        }
        catch {
            // Ignore storage errors
        }
        debugLog('[SingleUser] Remote reset complete');
        return { error: null };
    }
    catch (e) {
        debugError('[SingleUser] resetSingleUserRemote error:', e);
        return { error: e instanceof Error ? e.message : 'Remote reset failed' };
    }
}
//# sourceMappingURL=singleUser.js.map