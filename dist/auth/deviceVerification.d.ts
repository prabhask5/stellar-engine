/**
 * Device Verification Module
 *
 * Manages trusted devices for single-user and multi-user modes.
 * Uses Supabase `trusted_devices` table and `signInWithOtp()` for email-based
 * device verification on untrusted devices.
 */
import type { TrustedDevice } from '../types';
/**
 * Generate a human-readable device label (e.g. "Chrome on macOS").
 */
export declare function getDeviceLabel(): string;
/**
 * Mask an email address for display (e.g. "pr••••@gmail.com").
 */
export declare function maskEmail(email: string): string;
/**
 * Check if the current device is trusted for a given user.
 * A device is trusted if it has a `trusted_devices` row with `last_used_at`
 * within the configured trust duration.
 */
export declare function isDeviceTrusted(userId: string): Promise<boolean>;
/**
 * Trust the current device for a user.
 * Uses upsert on (user_id, device_id) unique constraint.
 */
export declare function trustCurrentDevice(userId: string): Promise<void>;
/**
 * Update `last_used_at` for the current device (called on each successful login).
 */
export declare function touchTrustedDevice(userId: string): Promise<void>;
/**
 * Get all trusted devices for a user.
 */
export declare function getTrustedDevices(userId: string): Promise<TrustedDevice[]>;
/**
 * Remove a trusted device by ID.
 */
export declare function removeTrustedDevice(id: string): Promise<void>;
/**
 * Send a device verification OTP email.
 *
 * Keeps the session alive (needed for cross-device polling) and stores
 * this device's ID in user_metadata so the confirm page can trust it.
 */
export declare function sendDeviceVerification(email: string): Promise<{
    error: string | null;
}>;
/**
 * Trust the pending device stored in user_metadata.
 *
 * Called from the confirm page after a device OTP is verified. This trusts
 * the ORIGINATING device (the one that entered the PIN and triggered
 * verification), not the device opening the confirmation link.
 */
export declare function trustPendingDevice(): Promise<void>;
/**
 * Verify a device verification OTP token hash (from email link).
 */
export declare function verifyDeviceCode(tokenHash: string): Promise<{
    error: string | null;
}>;
/**
 * Get the current device ID (exposed for consumers).
 */
export declare function getCurrentDeviceId(): string;
//# sourceMappingURL=deviceVerification.d.ts.map