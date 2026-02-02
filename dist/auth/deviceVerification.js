/**
 * Device Verification Module
 *
 * Manages trusted devices for single-user and multi-user modes.
 * Uses Supabase `trusted_devices` table and `signInWithOtp()` for email-based
 * device verification on untrusted devices.
 */
import { getEngineConfig } from '../config';
import { supabase } from '../supabase/client';
import { getDeviceId } from '../deviceId';
import { debugLog, debugWarn, debugError } from '../debug';
const DEFAULT_TRUST_DURATION_DAYS = 90;
// ============================================================
// HELPERS
// ============================================================
function getDb() {
    const db = getEngineConfig().db;
    if (!db)
        throw new Error('Database not initialized.');
    return db;
}
function getTrustDurationDays() {
    return getEngineConfig().auth?.deviceVerification?.trustDurationDays ?? DEFAULT_TRUST_DURATION_DAYS;
}
function snakeToCamelDevice(row) {
    return {
        id: row.id,
        userId: row.user_id,
        deviceId: row.device_id,
        deviceLabel: row.device_label,
        trustedAt: row.trusted_at,
        lastUsedAt: row.last_used_at,
    };
}
// ============================================================
// DEVICE LABEL
// ============================================================
/**
 * Generate a human-readable device label (e.g. "Chrome on macOS").
 */
export function getDeviceLabel() {
    if (typeof navigator === 'undefined')
        return 'Unknown device';
    const ua = navigator.userAgent;
    let browser = 'Browser';
    let os = '';
    // Detect browser
    if (ua.includes('Firefox'))
        browser = 'Firefox';
    else if (ua.includes('Edg/'))
        browser = 'Edge';
    else if (ua.includes('Chrome') && !ua.includes('Edg/'))
        browser = 'Chrome';
    else if (ua.includes('Safari') && !ua.includes('Chrome'))
        browser = 'Safari';
    // Detect OS
    if (ua.includes('Mac OS X'))
        os = 'macOS';
    else if (ua.includes('Windows'))
        os = 'Windows';
    else if (ua.includes('Linux'))
        os = 'Linux';
    else if (ua.includes('Android'))
        os = 'Android';
    else if (ua.includes('iPhone') || ua.includes('iPad'))
        os = 'iOS';
    return os ? `${browser} on ${os}` : browser;
}
// ============================================================
// EMAIL MASKING
// ============================================================
/**
 * Mask an email address for display (e.g. "pr••••@gmail.com").
 */
export function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (!domain)
        return email;
    const visible = Math.min(2, local.length);
    const masked = local.slice(0, visible) + '\u2022'.repeat(Math.max(1, local.length - visible));
    return `${masked}@${domain}`;
}
// ============================================================
// DEVICE TRUST QUERIES
// ============================================================
/**
 * Check if the current device is trusted for a given user.
 * A device is trusted if it has a `trusted_devices` row with `last_used_at`
 * within the configured trust duration.
 */
export async function isDeviceTrusted(userId) {
    try {
        const deviceId = getDeviceId();
        const trustDays = getTrustDurationDays();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - trustDays);
        const { data, error } = await supabase
            .from('trusted_devices')
            .select('id, last_used_at')
            .eq('user_id', userId)
            .eq('device_id', deviceId)
            .gte('last_used_at', cutoff.toISOString())
            .limit(1);
        if (error) {
            debugWarn('[DeviceVerification] Trust check failed:', error.message);
            return false;
        }
        return (data?.length ?? 0) > 0;
    }
    catch (e) {
        debugError('[DeviceVerification] Trust check error:', e);
        return false;
    }
}
/**
 * Trust the current device for a user.
 * Uses upsert on (user_id, device_id) unique constraint.
 */
export async function trustCurrentDevice(userId) {
    try {
        const deviceId = getDeviceId();
        const label = getDeviceLabel();
        const now = new Date().toISOString();
        const { error } = await supabase
            .from('trusted_devices')
            .upsert({
            user_id: userId,
            device_id: deviceId,
            device_label: label,
            trusted_at: now,
            last_used_at: now,
        }, { onConflict: 'user_id,device_id' });
        if (error) {
            debugError('[DeviceVerification] Trust device failed:', error.message);
        }
        else {
            debugLog('[DeviceVerification] Device trusted:', label);
        }
    }
    catch (e) {
        debugError('[DeviceVerification] Trust device error:', e);
    }
}
/**
 * Update `last_used_at` for the current device (called on each successful login).
 */
export async function touchTrustedDevice(userId) {
    try {
        const deviceId = getDeviceId();
        const { error } = await supabase
            .from('trusted_devices')
            .update({ last_used_at: new Date().toISOString() })
            .eq('user_id', userId)
            .eq('device_id', deviceId);
        if (error) {
            debugWarn('[DeviceVerification] Touch device failed:', error.message);
        }
    }
    catch (e) {
        debugWarn('[DeviceVerification] Touch device error:', e);
    }
}
/**
 * Get all trusted devices for a user.
 */
export async function getTrustedDevices(userId) {
    try {
        const { data, error } = await supabase
            .from('trusted_devices')
            .select('id, user_id, device_id, device_label, trusted_at, last_used_at')
            .eq('user_id', userId)
            .order('last_used_at', { ascending: false });
        if (error) {
            debugError('[DeviceVerification] Get devices failed:', error.message);
            return [];
        }
        return (data || []).map(snakeToCamelDevice);
    }
    catch (e) {
        debugError('[DeviceVerification] Get devices error:', e);
        return [];
    }
}
/**
 * Remove a trusted device by ID.
 */
export async function removeTrustedDevice(id) {
    try {
        const { error } = await supabase
            .from('trusted_devices')
            .delete()
            .eq('id', id);
        if (error) {
            debugError('[DeviceVerification] Remove device failed:', error.message);
        }
        else {
            debugLog('[DeviceVerification] Device removed:', id);
        }
    }
    catch (e) {
        debugError('[DeviceVerification] Remove device error:', e);
    }
}
// ============================================================
// OTP VERIFICATION FLOW
// ============================================================
/**
 * Send a device verification OTP email.
 * Signs out first (untrusted device flow), then sends OTP.
 */
export async function sendDeviceVerification(email) {
    try {
        // Sign out first — untrusted device should not retain a session
        await supabase.auth.signOut();
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: false },
        });
        if (error) {
            debugError('[DeviceVerification] Send OTP failed:', error.message);
            return { error: error.message };
        }
        debugLog('[DeviceVerification] OTP sent to:', maskEmail(email));
        return { error: null };
    }
    catch (e) {
        debugError('[DeviceVerification] Send OTP error:', e);
        return { error: e instanceof Error ? e.message : 'Failed to send verification email' };
    }
}
/**
 * Verify a device verification OTP token hash (from email link).
 */
export async function verifyDeviceCode(tokenHash) {
    try {
        const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: 'email',
        });
        if (error) {
            debugError('[DeviceVerification] Verify OTP failed:', error.message);
            return { error: error.message };
        }
        debugLog('[DeviceVerification] OTP verified successfully');
        return { error: null };
    }
    catch (e) {
        debugError('[DeviceVerification] Verify OTP error:', e);
        return { error: e instanceof Error ? e.message : 'Verification failed' };
    }
}
/**
 * Get the current device ID (exposed for consumers).
 */
export function getCurrentDeviceId() {
    return getDeviceId();
}
//# sourceMappingURL=deviceVerification.js.map