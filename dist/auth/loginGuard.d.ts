/**
 * @fileoverview Login Guard -- Local Credential Pre-Check & Rate Limiting
 *
 * Minimizes Supabase auth API requests by verifying credentials locally first.
 * Only calls Supabase when the local hash matches (correct password) or when no
 * local hash exists (with rate limiting).
 *
 * Architecture:
 * - Maintains **in-memory-only** state (resets on page refresh) for failure
 *   counters and rate-limit timers.
 * - Two operational strategies:
 *   1. `local-match`: A cached hash exists and the user's input matches it.
 *      Proceed to Supabase for authoritative verification.
 *   2. `no-cache`: No cached hash is available. Proceed to Supabase but apply
 *      exponential backoff on repeated failures.
 * - After a configurable number of consecutive local mismatches, the cached hash
 *   is invalidated (it may be stale from a server-side password change) and the
 *   guard falls back to rate-limited Supabase mode.
 *
 * Security considerations:
 * - The guard is a **client-side optimization**, not a security boundary. It
 *   reduces unnecessary network calls and provides a better UX (instant
 *   rejection for wrong passwords) but Supabase remains the authoritative
 *   verifier.
 * - Rate limiting is in-memory only and resets on page refresh; server-side rate
 *   limits in Supabase are still the primary defense against brute-force.
 * - Cached hashes are SHA-256 digests stored in IndexedDB. They are invalidated
 *   when stale-hash scenarios are detected (local match but Supabase rejects).
 *
 * @module auth/loginGuard
 */
/**
 * Strategy used when proceeding to the Supabase auth call.
 *
 * - `'local-match'` -- The user's input matched a locally cached hash.
 *   Supabase is called for authoritative confirmation.
 * - `'no-cache'` -- No local hash was available (or it was invalidated).
 *   Supabase is called directly, subject to rate limiting.
 */
export type PreCheckStrategy = 'local-match' | 'no-cache';
/**
 * Result of the local pre-check.
 *
 * - `proceed: true` -- The caller should continue with the Supabase auth call.
 * - `proceed: false` -- The attempt was rejected locally; `error` contains a
 *   user-facing message and `retryAfterMs` (if present) indicates how long
 *   the user should wait.
 */
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
 * For single-user mode: reads `singleUserConfig.gateHash`, hashes input, compares.
 * For multi-user mode: reads offline credentials, matches email + hashes password, compares.
 *
 * Returns `{ proceed: true, strategy }` to allow Supabase call,
 * or `{ proceed: false, error, retryAfterMs? }` to reject locally.
 *
 * @param input - The plaintext password or gate code entered by the user.
 * @param mode - The auth mode (`'single-user'` or `'multi-user'`), which
 *               determines which IndexedDB table holds the cached hash.
 * @param email - (Multi-user only) The email address to match against cached
 *                credentials. Ignored in single-user mode.
 * @returns A promise resolving to a {@link PreCheckResult}.
 *
 * @example
 * ```ts
 * const result = await preCheckLogin(password, 'multi-user', email);
 * if (result.proceed) {
 *   const { error } = await supabase.auth.signInWithPassword({ email, password });
 *   if (error) await onLoginFailure(result.strategy, 'multi-user');
 *   else onLoginSuccess();
 * } else {
 *   showError(result.error);
 * }
 * ```
 *
 * @see {@link onLoginSuccess} -- must be called after a successful Supabase login.
 * @see {@link onLoginFailure} -- must be called after a failed Supabase login.
 */
export declare function preCheckLogin(input: string, mode: 'single-user' | 'multi-user', email?: string): Promise<PreCheckResult>;
/**
 * Called after a successful Supabase login.
 *
 * Resets all login guard counters (local failure count, rate-limit attempts,
 * and the next-allowed-attempt timestamp) so the user starts fresh.
 *
 * @example
 * ```ts
 * const { error } = await supabase.auth.signInWithPassword({ email, password });
 * if (!error) onLoginSuccess();
 * ```
 */
export declare function onLoginSuccess(): void;
/**
 * Called after a failed Supabase login.
 *
 * Behavior depends on the strategy that was used:
 *
 * - `'local-match'`: Supabase rejected a locally-matched password, meaning the
 *   cached hash is **stale** (password changed server-side). The cached hash is
 *   invalidated so future attempts go through rate-limited Supabase mode.
 * - `'no-cache'`: Increment the rate-limit counter and apply exponential
 *   backoff (base * 2^(n-1), capped at MAX_DELAY_MS).
 *
 * @param strategy - The {@link PreCheckStrategy} that was returned by
 *                   {@link preCheckLogin} for this attempt.
 * @param mode - The auth mode, used to determine which IndexedDB table to
 *               invalidate if the hash is stale. Defaults to `'multi-user'`.
 *
 * @example
 * ```ts
 * const result = await preCheckLogin(password, 'multi-user', email);
 * if (result.proceed) {
 *   const { error } = await supabase.auth.signInWithPassword({ email, password });
 *   if (error) await onLoginFailure(result.strategy, 'multi-user');
 * }
 * ```
 */
export declare function onLoginFailure(strategy: PreCheckStrategy, mode?: 'single-user' | 'multi-user'): Promise<void>;
/**
 * Full reset of all login guard state.
 *
 * Call on sign-out or app reset to clear failure counters and rate-limit
 * timers so the next login attempt starts with a clean slate.
 *
 * @example
 * ```ts
 * await supabase.auth.signOut();
 * resetLoginGuard();
 * ```
 */
export declare function resetLoginGuard(): void;
//# sourceMappingURL=loginGuard.d.ts.map