/**
 * @fileoverview Login Guard -- Local Credential Pre-Check & Rate Limiting
 *
 * Minimizes Supabase auth API requests by verifying credentials locally first.
 * Only calls Supabase when the local hash matches (correct password) or when no
 * local hash exists (with rate limiting).
 *
 * Architecture:
 * - Maintains **in-memory** state for fast local-hash failure counters and
 *   ephemeral backoff timers (resets on page refresh by design — these are
 *   UX-level optimisations, not security boundaries).
 * - Maintains **persistent** lockout state in IndexedDB (`singleUserConfig`
 *   table, key `'pin_lockout'`).  This survives page refreshes and tab
 *   closes, preventing brute-force attacks that rely on reloading to reset
 *   counters.
 * - Two operational strategies:
 *   1. `local-match`: A cached hash exists and the user's input matches it.
 *      Proceed to Supabase for authoritative verification.
 *   2. `no-cache`: No cached hash is available. Proceed to Supabase but apply
 *      exponential backoff on repeated failures.
 * - After a configurable number of consecutive local mismatches, the cached hash
 *   is invalidated (it may be stale from a server-side password change) and the
 *   guard falls back to rate-limited Supabase mode.
 *
 * ## Lockout Tiers (persistent, survives page refresh)
 *
 * | Total failures | Lockout duration |
 * |---------------|-----------------|
 * |  5            |  5 minutes      |
 * | 10            | 30 minutes      |
 * | 15            |  2 hours        |
 * | 20+           | 24 hours        |
 *
 * Counters reset to zero after any successful Supabase authentication.
 *
 * Security considerations:
 * - The guard is a **client-side optimisation**, not a security boundary. It
 *   reduces unnecessary network calls and provides a better UX (instant
 *   rejection for wrong passwords) but Supabase remains the authoritative
 *   verifier.
 * - Persistent lockout counters are stored in IndexedDB. An attacker with
 *   physical device access can clear IndexedDB, but Supabase's own server-side
 *   rate limiting is then the next line of defence.
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
 * Check whether a persistent PIN lockout is currently active, without
 * requiring the user to submit a PIN attempt.
 *
 * Call this on page/component mount to pre-populate the retry countdown so
 * the UI immediately shows how long the user must wait rather than waiting
 * for a failed submit to reveal the lockout.
 *
 * @returns Milliseconds remaining in the active lockout, or `0` if there is
 *   no active lockout.
 *
 * @example
 * ```ts
 * onMount(async () => {
 *   const remainingMs = await checkPersistentLockout();
 *   if (remainingMs > 0) startRetryCountdown(remainingMs);
 * });
 * ```
 */
export declare function checkPersistentLockout(): Promise<number>;
/**
 * Pre-check login credentials locally before calling Supabase.
 *
 * Reads `singleUserConfig.gateHash`, hashes input, and compares.
 *
 * Returns `{ proceed: true, strategy }` to allow Supabase call,
 * or `{ proceed: false, error, retryAfterMs? }` to reject locally.
 *
 * @param input - The plaintext password or gate code entered by the user.
 * @returns A promise resolving to a {@link PreCheckResult}.
 *
 * @example
 * ```ts
 * const result = await preCheckLogin(password);
 * if (result.proceed) {
 *   const { error } = await supabase.auth.signInWithPassword({ email, password });
 *   if (error) await onLoginFailure(result.strategy);
 *   else onLoginSuccess();
 * } else {
 *   showError(result.error);
 * }
 * ```
 *
 * @see {@link onLoginSuccess} -- must be called after a successful Supabase login.
 * @see {@link onLoginFailure} -- must be called after a failed Supabase login.
 */
export declare function preCheckLogin(input: string): Promise<PreCheckResult>;
/**
 * Called after a successful Supabase login.
 *
 * Resets all login guard counters (local failure count, rate-limit attempts,
 * and the next-allowed-attempt timestamp) and clears the persistent lockout
 * record from IndexedDB so the user starts fresh.
 *
 * @example
 * ```ts
 * const { error } = await supabase.auth.signInWithPassword({ email, password });
 * if (!error) onLoginSuccess();
 * ```
 */
export declare function onLoginSuccess(): Promise<void>;
/**
 * Called after a failed Supabase login.
 *
 * Behavior depends on the strategy that was used:
 *
 * - `'local-match'`: Supabase rejected a locally-matched password, meaning the
 *   cached hash is **stale** (password changed server-side). The cached hash is
 *   invalidated so future attempts go through rate-limited Supabase mode.
 * - `'no-cache'`: Increment the rate-limit counter and apply exponential
 *   backoff (base * 2^(n-1), capped at MAX_DELAY_MS).  Also increments the
 *   persistent failure counter and applies a tier-based lockout if the
 *   threshold is reached.
 *
 * @param strategy - The {@link PreCheckStrategy} that was returned by
 *                   {@link preCheckLogin} for this attempt.
 *
 * @example
 * ```ts
 * const result = await preCheckLogin(password);
 * if (result.proceed) {
 *   const { error } = await supabase.auth.signInWithPassword({ email, password });
 *   if (error) await onLoginFailure(result.strategy);
 * }
 * ```
 */
export declare function onLoginFailure(strategy: PreCheckStrategy): Promise<void>;
/**
 * Full reset of all login guard state.
 *
 * Call on sign-out or app reset to clear failure counters and rate-limit
 * timers so the next login attempt starts with a clean slate.
 *
 * @example
 * ```ts
 * await supabase.auth.signOut();
 * await resetLoginGuard();
 * ```
 */
export declare function resetLoginGuard(): Promise<void>;
//# sourceMappingURL=loginGuard.d.ts.map