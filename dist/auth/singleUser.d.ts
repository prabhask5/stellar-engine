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
}>;
/**
 * Complete device verification after OTP email link is clicked.
 * Called when the original tab receives AUTH_CONFIRMED via BroadcastChannel.
 */
export declare function completeDeviceVerification(tokenHash?: string): Promise<{
    error: string | null;
}>;
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
 * Full reset: clear config, sign out of Supabase, clear all data.
 */
export declare function resetSingleUser(): Promise<{
    error: string | null;
}>;
//# sourceMappingURL=singleUser.d.ts.map