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
import type { SingleUserConfig } from '../types';
/**
 * Pad a PIN to meet Supabase's minimum password length.
 * e.g. "1234" → "1234_stellar" (12 chars, well above the 6-char minimum)
 */
export declare function padPin(pin: string): string;
/**
 * Check if single-user mode has been set up (config exists in IndexedDB).
 */
export declare function isSingleUserSetUp(): Promise<boolean>;
/**
 * Get non-sensitive display info about the single user.
 * Returns null if not set up.
 */
export declare function getSingleUserInfo(): Promise<{
    profile: Record<string, unknown>;
    gateType: SingleUserConfig['gateType'];
    codeLength?: 4 | 6;
    email?: string;
    maskedEmail?: string;
} | null>;
/**
 * First-time setup: create Supabase user with email/password auth.
 *
 * Uses signUp() which sends a confirmation email if emailConfirmation is enabled.
 * The PIN is padded to meet Supabase's minimum password length.
 *
 * @returns confirmationRequired — true if the caller should show a "check your email" modal
 */
export declare function setupSingleUser(gate: string, profile: Record<string, unknown>, email: string): Promise<{
    error: string | null;
    confirmationRequired: boolean;
}>;
/**
 * Complete setup after email confirmation succeeds.
 * Called when the original tab receives AUTH_CONFIRMED via BroadcastChannel.
 */
export declare function completeSingleUserSetup(): Promise<{
    error: string | null;
}>;
/**
 * Unlock: verify PIN via signInWithPassword, handle device verification.
 *
 * Returns deviceVerificationRequired if the device is untrusted.
 */
export declare function unlockSingleUser(gate: string): Promise<{
    error: string | null;
    deviceVerificationRequired?: boolean;
    maskedEmail?: string;
    retryAfterMs?: number;
}>;
/**
 * Complete device verification after OTP email link is clicked.
 * Called when the original tab receives AUTH_CONFIRMED via BroadcastChannel.
 */
export declare function completeDeviceVerification(tokenHash?: string): Promise<{
    error: string | null;
}>;
/**
 * Poll whether this device has been trusted (e.g. after OTP verified on another device).
 *
 * Requires an active session (sendDeviceVerification keeps the session alive).
 * The confirm page calls trustPendingDevice() which trusts the originating device,
 * so this check will pass once verification is complete on any device.
 */
export declare function pollDeviceVerification(): Promise<boolean>;
/**
 * Lock: stop sync engine, reset auth state to 'none'.
 * Does NOT destroy session, data, or sign out of Supabase.
 */
export declare function lockSingleUser(): Promise<void>;
/**
 * Change the gate (code/password). Verifies old gate via signInWithPassword.
 */
export declare function changeSingleUserGate(oldGate: string, newGate: string): Promise<{
    error: string | null;
}>;
/**
 * Update profile in IndexedDB and Supabase user_metadata.
 */
export declare function updateSingleUserProfile(profile: Record<string, unknown>): Promise<{
    error: string | null;
}>;
/**
 * Initiate an email change. Requires online state.
 * Supabase sends a confirmation email to the new address.
 */
export declare function changeSingleUserEmail(newEmail: string): Promise<{
    error: string | null;
    confirmationRequired: boolean;
}>;
/**
 * Complete email change after the user confirms via the email link.
 * Called when the original tab receives AUTH_CONFIRMED with type 'email_change'.
 */
export declare function completeSingleUserEmailChange(): Promise<{
    error: string | null;
    newEmail: string | null;
}>;
/**
 * Full reset: clear config, sign out of Supabase, clear all data.
 */
export declare function resetSingleUser(): Promise<{
    error: string | null;
}>;
/**
 * Fetch remote gate config via the get_extension_config() RPC.
 * Returns user info if a user exists in Supabase, null otherwise.
 * Works without authentication (uses anon key).
 */
export declare function fetchRemoteGateConfig(): Promise<{
    email: string;
    gateType: string;
    codeLength: number;
    profile: Record<string, unknown>;
} | null>;
/**
 * Link a new device to an existing single-user account.
 * Signs in with email + padded PIN, builds local config from user_metadata.
 */
export declare function linkSingleUserDevice(email: string, pin: string): Promise<{
    error: string | null;
    deviceVerificationRequired?: boolean;
    maskedEmail?: string;
    retryAfterMs?: number;
}>;
/**
 * Reset the remote single user via the reset_single_user() RPC.
 * Also clears all local auth state (IndexedDB + localStorage).
 */
export declare function resetSingleUserRemote(): Promise<{
    error: string | null;
}>;
//# sourceMappingURL=singleUser.d.ts.map