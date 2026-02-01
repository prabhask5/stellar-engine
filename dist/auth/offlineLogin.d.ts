/**
 * Offline Login
 *
 * Provides high-level offline sign-in and credential info functions,
 * absorbing the login page's direct use of offline auth internals.
 */
interface OfflineLoginResult {
    success: boolean;
    error?: string;
    reason?: 'no_credentials' | 'no_stored_password' | 'user_mismatch' | 'email_mismatch' | 'password_mismatch' | 'session_failed';
}
/**
 * Sign in offline using cached credentials.
 *
 * 1. Fetches cached offline credentials
 * 2. Verifies email + password against cached credentials
 * 3. Creates offline session
 * 4. Validates session was persisted
 * 5. Returns structured result with typed error reasons
 */
export declare function signInOffline(email: string, password: string): Promise<OfflineLoginResult>;
/**
 * Get non-sensitive display info about cached offline credentials.
 * Returns null if no credentials cached.
 * Used by login page to show "Sign in as X" offline UI.
 */
export declare function getOfflineLoginInfo(): Promise<{
    hasCredentials: boolean;
    email?: string;
    firstName?: string;
    lastName?: string;
} | null>;
export {};
//# sourceMappingURL=offlineLogin.d.ts.map