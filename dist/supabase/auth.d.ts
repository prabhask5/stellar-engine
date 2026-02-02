import type { User, Session } from '@supabase/supabase-js';
export interface AuthResponse {
    user: User | null;
    session: Session | null;
    error: string | null;
    deviceVerificationRequired?: boolean;
    maskedEmail?: string;
}
export declare function signIn(email: string, password: string): Promise<AuthResponse>;
export declare function signUp(email: string, password: string, profileData: Record<string, unknown>): Promise<AuthResponse>;
export declare function signOut(options?: {
    preserveOfflineCredentials?: boolean;
    preserveLocalData?: boolean;
}): Promise<{
    error: string | null;
}>;
/**
 * Get current Supabase session
 * When offline, returns the cached session from localStorage even if expired
 * (the caller should handle offline mode appropriately)
 */
export declare function getSession(): Promise<Session | null>;
/**
 * Check if a session's access token is expired
 */
export declare function isSessionExpired(session: Session | null): boolean;
export declare function getUserProfile(user: User | null): Record<string, unknown>;
/**
 * Update user profile
 * Also updates cached offline credentials
 */
export declare function updateProfile(profile: Record<string, unknown>): Promise<{
    error: string | null;
}>;
/**
 * Change user password
 * Verifies current password first, then updates
 * Also updates cached offline credentials
 */
export declare function changePassword(currentPassword: string, newPassword: string): Promise<{
    error: string | null;
}>;
/**
 * Resend confirmation email for signup
 * Should be rate-limited on the client side (30 second cooldown)
 */
export declare function resendConfirmationEmail(email: string): Promise<{
    error: string | null;
}>;
/**
 * Verify OTP token (for email confirmation).
 * Absorbs confirm page's direct Supabase call.
 */
export declare function verifyOtp(tokenHash: string, type: 'signup' | 'email'): Promise<{
    error: string | null;
}>;
/**
 * Get a valid (non-expired) session, or null.
 * Merges getSession() + isSessionExpired() into a single call.
 */
export declare function getValidSession(): Promise<Session | null>;
//# sourceMappingURL=auth.d.ts.map