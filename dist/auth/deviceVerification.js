/**
 * @fileoverview Device Verification Module
 *
 * Manages the trusted device registry and email-based OTP verification flow.
 * When device verification is
 * enabled, only devices present in the Supabase `trusted_devices` table (with
 * a recent `last_used_at` timestamp) are allowed to proceed after
 * authentication. Untrusted devices must complete an email OTP challenge.
 *
 * ## Architecture
 *
 * - **Device identification**: Each browser/device is assigned a persistent
 *   unique ID via {@link getDeviceId} (stored in localStorage). This ID is
 *   used as the key in the `trusted_devices` table.
 * - **Trust expiry**: Trusted devices expire after a configurable number of
 *   days (default: 90). The `last_used_at` column is refreshed on each
 *   successful login via {@link touchTrustedDevice}.
 * - **OTP flow**: Uses Supabase `signInWithOtp()` with `shouldCreateUser: false`
 *   to send a magic link email. The confirm page verifies the token and trusts
 *   both the originating device and the confirming device.
 * - **Cross-device verification**: The originating device's ID is stored in
 *   `user_metadata` as `pending_device_id` so the confirm page can trust it
 *   even when opened on a different device (e.g., phone).
 *
 * ## Database Schema
 *
 * The `trusted_devices` table has a unique constraint on `(user_id, device_id)`:
 *
 * | Column       | Type      | Description                           |
 * |-------------|-----------|---------------------------------------|
 * | id          | uuid      | Primary key                           |
 * | user_id     | uuid      | FK to auth.users                      |
 * | device_id   | text      | Persistent browser/device identifier  |
 * | device_label| text      | Human-readable label (e.g., "Chrome on macOS") |
 * | trusted_at  | timestamp | When the device was first trusted     |
 * | last_used_at| timestamp | Last successful login from this device |
 *
 * ## Security Considerations
 *
 * - **Device ID spoofing**: The device ID is stored in localStorage and can be
 *   copied. This provides convenience-level trust, not cryptographic assurance.
 *   An attacker who clones localStorage can impersonate a trusted device.
 * - **OTP security**: OTP tokens are single-use and time-limited (configured
 *   in Supabase). The `shouldCreateUser: false` flag prevents account creation
 *   via the OTP endpoint.
 * - **Trust duration**: The default 90-day trust window balances convenience
 *   and security. Reduce this for higher-security applications.
 * - **RLS**: The `trusted_devices` table should have Row Level Security
 *   policies ensuring users can only read/write their own device records.
 *
 * @module deviceVerification
 * @see {@link singleUser} for how device verification integrates into the auth flow
 */
import { getEngineConfig } from '../config';
import { supabase } from '../supabase/client';
import { getDeviceId } from '../deviceId';
import { debugLog, debugWarn, debugError } from '../debug';
import { isDemoMode } from '../demo';
/** Default number of days a device remains trusted before requiring re-verification. */
const DEFAULT_TRUST_DURATION_DAYS = 90;
// =============================================================================
// HELPERS
// =============================================================================
/**
 * Get the configured trust duration in days.
 *
 * Falls back to {@link DEFAULT_TRUST_DURATION_DAYS} (90) if not configured.
 *
 * @returns The number of days a device should remain trusted.
 */
function getTrustDurationDays() {
    return (getEngineConfig().auth?.deviceVerification?.trustDurationDays ?? DEFAULT_TRUST_DURATION_DAYS);
}
/**
 * Get the app prefix for multi-tenant device trust isolation.
 *
 * Each app in a shared Supabase project uses a different prefix so that
 * trusting a device on one app does not automatically trust it on another.
 *
 * @returns The configured app prefix, or `'default'` if none is set.
 */
function getAppPrefix() {
    return getEngineConfig().prefix || 'default';
}
/**
 * Convert a snake_case database row into a camelCase {@link TrustedDevice} object.
 *
 * Supabase returns rows with snake_case column names, but the TypeScript
 * interface uses camelCase. This function performs the field mapping.
 *
 * @param row - A raw database row from the `trusted_devices` table.
 * @returns A properly typed {@link TrustedDevice} object.
 */
function snakeToCamelDevice(row) {
    return {
        /** Primary key (UUID). */
        id: row.id,
        /** The Supabase user ID that owns this device record. */
        userId: row.user_id,
        /** The persistent device identifier from localStorage. */
        deviceId: row.device_id,
        /** Human-readable label (e.g., "Chrome on macOS"). */
        deviceLabel: row.device_label,
        /** App prefix for multi-tenant isolation. */
        appPrefix: row.app_prefix,
        /** ISO timestamp of when the device was first trusted. */
        trustedAt: row.trusted_at,
        /** ISO timestamp of the most recent successful login from this device. */
        lastUsedAt: row.last_used_at
    };
}
// =============================================================================
// DEVICE LABEL
// =============================================================================
/**
 * Generate a human-readable device label from the browser's User-Agent string.
 *
 * Detects common browsers (Chrome, Firefox, Edge, Safari) and operating systems
 * (macOS, Windows, Linux, iOS, Android, ChromeOS). Returns a combined label
 * like "Chrome on macOS" for display in device management UIs.
 *
 * @returns A human-readable label describing the current browser and OS, or
 *   "Unknown device" in non-browser environments.
 *
 * @example
 * ```ts
 * getDeviceLabel(); // => "Chrome on macOS"
 * getDeviceLabel(); // => "Safari on iOS"
 * getDeviceLabel(); // => "Firefox on Linux"
 * ```
 */
export function getDeviceLabel() {
    if (typeof navigator === 'undefined')
        return 'Unknown device';
    const ua = navigator.userAgent;
    let browser = 'Browser';
    let os = '';
    /* Detect browser — order matters: Edge contains "Chrome" in its UA,
       so Edge must be checked before Chrome */
    if (ua.includes('Firefox'))
        browser = 'Firefox';
    else if (ua.includes('Edg/'))
        browser = 'Edge';
    else if (ua.includes('Chrome') && !ua.includes('Edg/'))
        browser = 'Chrome';
    else if (ua.includes('Safari') && !ua.includes('Chrome'))
        browser = 'Safari';
    /* Detect OS — mobile checks must come before desktop checks because
       mobile UA strings often contain desktop OS identifiers
       (e.g., iPhone UA contains "like Mac OS X", Android UA contains "Linux") */
    if (ua.includes('iPhone') || ua.includes('iPad') || ua.includes('iPod'))
        os = 'iOS';
    else if (ua.includes('Android'))
        os = 'Android';
    else if (ua.includes('Mac OS X'))
        os = 'macOS';
    else if (ua.includes('Windows'))
        os = 'Windows';
    else if (ua.includes('CrOS'))
        os = 'ChromeOS';
    else if (ua.includes('Linux'))
        os = 'Linux';
    return os ? `${browser} on ${os}` : browser;
}
// =============================================================================
// EMAIL MASKING
// =============================================================================
/**
 * Mask an email address for safe display in the UI.
 *
 * Shows the first 2 characters of the local part, replaces the rest with
 * bullet characters, and preserves the full domain. This prevents shoulder-
 * surfing while still letting the user confirm it's the right email.
 *
 * @param email - The full email address to mask.
 * @returns The masked email string (e.g., "pr\u2022\u2022\u2022\u2022@gmail.com").
 *
 * @example
 * ```ts
 * maskEmail('prabhask@gmail.com');  // => "pr••••••@gmail.com"
 * maskEmail('ab@example.com');      // => "ab@example.com"
 * maskEmail('a@test.io');           // => "a•@test.io"
 * ```
 *
 * @security This is a display-only mask. The original email should never be
 *   exposed in logs or error messages shown to untrusted contexts.
 */
export function maskEmail(email) {
    const [local, domain] = email.split('@');
    if (!domain)
        return email;
    /* Show at most 2 characters to provide enough recognition without
       revealing the full local part */
    const visible = Math.min(2, local.length);
    const masked = local.slice(0, visible) + '\u2022'.repeat(Math.max(1, local.length - visible));
    return `${masked}@${domain}`;
}
// =============================================================================
// DEVICE TRUST QUERIES
// =============================================================================
/**
 * Check if the current device is trusted for a given user.
 *
 * Queries the `trusted_devices` table for a record matching the current
 * device ID and user ID, with `last_used_at` within the configured trust
 * duration window. Returns `false` on any error (fail-closed).
 *
 * @param userId - The Supabase user ID to check trust for.
 * @returns `true` if the device is trusted and not expired, `false` otherwise.
 *
 * @example
 * ```ts
 * if (await isDeviceTrusted(user.id)) {
 *   grantAccess();
 * } else {
 *   challengeWithOtp();
 * }
 * ```
 *
 * @security Fails closed: any error (network, RLS, etc.) returns `false`,
 *   forcing the device verification flow rather than granting access.
 */
export async function isDeviceTrusted(userId) {
    if (isDemoMode())
        return true;
    try {
        const deviceId = getDeviceId();
        const trustDays = getTrustDurationDays();
        /* Calculate the cutoff date — devices not used within this window
           are considered expired and must re-verify */
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - trustDays);
        const { data, error } = await supabase
            .from('trusted_devices')
            .select('id, last_used_at')
            .eq('user_id', userId)
            .eq('device_id', deviceId)
            .eq('app_prefix', getAppPrefix())
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
 *
 * Creates or updates a record in the `trusted_devices` table using upsert on
 * the `(user_id, device_id)` unique constraint. Both `trusted_at` and
 * `last_used_at` are set to the current time.
 *
 * @param userId - The Supabase user ID to associate the trust record with.
 *
 * @example
 * ```ts
 * // After successful OTP verification:
 * await trustCurrentDevice(user.id);
 * ```
 *
 * @see {@link trustPendingDevice} for trusting a remote device via user_metadata
 */
export async function trustCurrentDevice(userId) {
    if (isDemoMode())
        return;
    try {
        const deviceId = getDeviceId();
        const label = getDeviceLabel();
        const now = new Date().toISOString();
        const { error } = await supabase.from('trusted_devices').upsert({
            user_id: userId,
            device_id: deviceId,
            device_label: label,
            app_prefix: getAppPrefix(),
            trusted_at: now,
            last_used_at: now
        }, { onConflict: 'user_id,device_id,app_prefix' });
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
 *
 * This extends the trust window so that frequently-used devices do not expire.
 * Also refreshes the device label in case the browser or OS was updated.
 *
 * @param userId - The Supabase user ID whose device record to update.
 *
 * @see {@link isDeviceTrusted} which checks the `last_used_at` timestamp
 */
export async function touchTrustedDevice(userId) {
    if (isDemoMode())
        return;
    try {
        const deviceId = getDeviceId();
        const { error } = await supabase
            .from('trusted_devices')
            .update({ last_used_at: new Date().toISOString(), device_label: getDeviceLabel() })
            .eq('user_id', userId)
            .eq('device_id', deviceId)
            .eq('app_prefix', getAppPrefix());
        if (error) {
            debugWarn('[DeviceVerification] Touch device failed:', error.message);
        }
    }
    catch (e) {
        debugWarn('[DeviceVerification] Touch device error:', e);
    }
}
/**
 * Get all trusted devices for a user, ordered by most recently used first.
 *
 * Used by device management UIs to display a list of trusted devices with
 * options to revoke trust.
 *
 * @param userId - The Supabase user ID to fetch devices for.
 * @returns An array of {@link TrustedDevice} objects, or an empty array on error.
 *
 * @example
 * ```ts
 * const devices = await getTrustedDevices(user.id);
 * devices.forEach(d => {
 *   console.log(`${d.deviceLabel} — last used ${d.lastUsedAt}`);
 * });
 * ```
 *
 * @see {@link removeTrustedDevice} for revoking trust on a specific device
 */
export async function getTrustedDevices(userId) {
    if (isDemoMode())
        return [];
    try {
        const { data, error } = await supabase
            .from('trusted_devices')
            .select('id, user_id, device_id, device_label, app_prefix, trusted_at, last_used_at')
            .eq('user_id', userId)
            .eq('app_prefix', getAppPrefix())
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
 * Remove a trusted device by its primary key ID.
 *
 * Used by the device management UI to allow users to revoke trust on devices
 * they no longer control (e.g., lost phone, sold laptop). After removal, the
 * device will be challenged with OTP verification on its next login.
 *
 * @param id - The UUID primary key of the `trusted_devices` row to delete.
 *
 * @example
 * ```ts
 * // Revoke trust on a specific device:
 * await removeTrustedDevice('550e8400-e29b-41d4-a716-446655440000');
 * ```
 *
 * @security Ensure RLS policies restrict deletion to the owning user.
 */
export async function removeTrustedDevice(id) {
    if (isDemoMode())
        return;
    try {
        const { error } = await supabase.from('trusted_devices').delete().eq('id', id);
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
// =============================================================================
// OTP VERIFICATION FLOW
// =============================================================================
/**
 * Send a device verification OTP email to the user.
 *
 * This function performs two actions:
 * 1. **Stores pending device info** in Supabase `user_metadata` so that the
 *    confirm page can trust the originating device even if the link is opened
 *    on a different device.
 * 2. **Sends an OTP email** via `signInWithOtp()` with `shouldCreateUser: false`
 *    to prevent account creation through this endpoint.
 *
 * The existing session is intentionally kept alive so that
 * {@link pollDeviceVerification} can continue checking trust status.
 *
 * @param email - The user's email address to send the OTP to.
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @security The `shouldCreateUser: false` flag prevents this endpoint from
 *   being abused to create new accounts. The OTP is time-limited and
 *   single-use (configured in Supabase dashboard).
 *
 * @see {@link verifyDeviceCode} for verifying the OTP token
 * @see {@link trustPendingDevice} for trusting the originating device from the confirm page
 */
export async function sendDeviceVerification(email) {
    if (isDemoMode())
        return { error: null };
    try {
        /* Store the pending device info in user_metadata so the confirm page
           can trust THIS device even if the link is opened on a different one.
           This enables the cross-device verification pattern. */
        const deviceId = getDeviceId();
        const deviceLabel = getDeviceLabel();
        const prefix = getEngineConfig().prefix;
        await supabase.auth.updateUser({
            data: {
                [`pending_${prefix}_device_id`]: deviceId,
                [`pending_${prefix}_device_label`]: deviceLabel
            }
        });
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: false }
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
 * Trust the pending device stored in `user_metadata`.
 *
 * Called from the confirm page after a device OTP is verified. This function
 * trusts the ORIGINATING device (the one that entered the PIN and triggered
 * verification), not necessarily the device opening the confirmation link.
 *
 * ## Cross-Device Flow
 *
 * 1. Device A enters the PIN -> untrusted -> OTP sent, device A's ID stored
 *    in `user_metadata.pending_device_id`.
 * 2. User opens the OTP link on Device B (or Device A).
 * 3. This function reads `pending_device_id` from metadata and trusts Device A.
 * 4. Device A polls via {@link pollDeviceVerification} and discovers it's now trusted.
 * 5. Both Device A and the confirming device (B) are trusted.
 *
 * If no `pending_device_id` is found in metadata (same-browser case where the
 * link was opened in the same browser), falls back to trusting the current
 * device only.
 *
 * @example
 * ```ts
 * // Called from the /confirm page after OTP verification:
 * await trustPendingDevice();
 * ```
 *
 * @see {@link sendDeviceVerification} which stores the pending device ID
 */
export async function trustPendingDevice() {
    if (isDemoMode())
        return;
    try {
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            debugWarn('[DeviceVerification] trustPendingDevice: no user');
            return;
        }
        const prefix = getEngineConfig().prefix;
        const pendingDeviceId = user.user_metadata?.[`pending_${prefix}_device_id`];
        const pendingDeviceLabel = user.user_metadata?.[`pending_${prefix}_device_label`];
        if (!pendingDeviceId) {
            /* No pending device — fall back to trusting the current device.
               This handles the same-browser case where the OTP link is opened
               in the same browser that initiated verification. */
            await trustCurrentDevice(user.id);
            return;
        }
        const now = new Date().toISOString();
        /* Trust the originating device (the one that entered the PIN) by
           upserting its device ID into the trusted_devices table */
        const { error: upsertError } = await supabase.from('trusted_devices').upsert({
            user_id: user.id,
            device_id: pendingDeviceId,
            device_label: pendingDeviceLabel || 'Unknown device',
            app_prefix: getAppPrefix(),
            trusted_at: now,
            last_used_at: now
        }, { onConflict: 'user_id,device_id,app_prefix' });
        if (upsertError) {
            debugError('[DeviceVerification] trustPendingDevice upsert failed:', upsertError.message);
        }
        else {
            debugLog('[DeviceVerification] Pending device trusted:', pendingDeviceLabel);
        }
        /* Also trust the current device (the one opening the confirmation link),
           since the user has demonstrated control of the email on this device too */
        await trustCurrentDevice(user.id);
        /* Clear pending device from metadata to prevent stale references.
           Setting to null removes the keys from user_metadata. */
        await supabase.auth.updateUser({
            data: {
                [`pending_${prefix}_device_id`]: null,
                [`pending_${prefix}_device_label`]: null
            }
        });
    }
    catch (e) {
        debugError('[DeviceVerification] trustPendingDevice error:', e);
    }
}
/**
 * Verify a device verification OTP token hash from an email link.
 *
 * Called from the confirm page with the `token_hash` query parameter extracted
 * from the magic link URL. On success, Supabase establishes a session for the
 * user, which enables subsequent calls to trust devices.
 *
 * @param tokenHash - The token hash from the email link's URL query parameters.
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @example
 * ```ts
 * // On the /confirm page:
 * const params = new URLSearchParams(window.location.search);
 * const tokenHash = params.get('token_hash');
 * if (tokenHash) {
 *   const result = await verifyDeviceCode(tokenHash);
 *   if (!result.error) {
 *     await trustPendingDevice();
 *   }
 * }
 * ```
 *
 * @see {@link sendDeviceVerification} which sends the OTP email
 * @see {@link trustPendingDevice} which should be called after successful verification
 */
export async function verifyDeviceCode(tokenHash) {
    if (isDemoMode())
        return { error: null };
    try {
        const { error } = await supabase.auth.verifyOtp({
            token_hash: tokenHash,
            type: 'email'
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
// =============================================================================
// PUBLIC UTILITIES
// =============================================================================
/**
 * Get the current device's persistent unique identifier.
 *
 * Exposed as a convenience for consumers who need to reference the device ID
 * (e.g., for display in a device management UI or for debugging).
 *
 * @returns The persistent device ID string from localStorage.
 *
 * @see {@link getDeviceId} from the `deviceId` module for the underlying implementation
 */
export function getCurrentDeviceId() {
    return getDeviceId();
}
//# sourceMappingURL=deviceVerification.js.map