/**
 * Login Guard — Local Credential Pre-Check & Rate Limiting
 *
 * Minimizes Supabase auth requests by verifying credentials locally first.
 * Only calls Supabase when the local hash matches (correct password) or
 * when no local hash exists (with rate limiting).
 *
 * State is in-memory only (resets on page refresh).
 */
export type PreCheckStrategy = 'local-match' | 'no-cache';
export type PreCheckResult = {
    proceed: true;
    strategy: PreCheckStrategy;
} | {
    proceed: false;
    error: string;
    retryAfterMs?: number;
};
/**
 * Pre-check login credentials locally before calling Supabase.
 *
 * For single-user mode: reads singleUserConfig.gateHash, hashes input, compares.
 * For multi-user mode: reads offlineCredentials, matches email + hashes password, compares.
 *
 * Returns { proceed: true, strategy } to allow Supabase call,
 * or { proceed: false, error, retryAfterMs? } to reject locally.
 */
export declare function preCheckLogin(input: string, mode: 'single-user' | 'multi-user', email?: string): Promise<PreCheckResult>;
/**
 * Called after a successful Supabase login.
 * Resets all login guard counters.
 */
export declare function onLoginSuccess(): void;
/**
 * Called after a failed Supabase login.
 *
 * If strategy was 'local-match': Supabase rejected a locally-matched password
 *   → invalidate cached hash (stale hash scenario).
 * If strategy was 'no-cache': increment rate limit counters with exponential backoff.
 */
export declare function onLoginFailure(strategy: PreCheckStrategy, mode?: 'single-user' | 'multi-user'): Promise<void>;
/**
 * Full reset of all login guard state.
 * Call on sign-out or app reset.
 */
export declare function resetLoginGuard(): void;
//# sourceMappingURL=loginGuard.d.ts.map