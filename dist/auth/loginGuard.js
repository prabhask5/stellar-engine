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
import { hashValue } from './crypto';
import { getEngineConfig } from '../config';
import { debugLog, debugWarn } from '../debug';
// =============================================================================
// CONSTANTS
// =============================================================================
/**
 * Number of consecutive local hash mismatches before the cached hash is
 * invalidated. Prevents a permanently stale hash from locking out the user.
 */
const LOCAL_FAILURE_THRESHOLD = 5;
/** Base delay (in milliseconds) for the first rate-limited retry. */
const BASE_DELAY_MS = 1000;
/** Maximum delay cap (in milliseconds) to prevent absurdly long waits. */
const MAX_DELAY_MS = 30000;
/** Multiplier for exponential backoff between rate-limited attempts. */
const BACKOFF_MULTIPLIER = 2;
// =============================================================================
// IN-MEMORY STATE
// =============================================================================
/**
 * Tracks how many times the local hash comparison has failed consecutively.
 * Once this reaches `LOCAL_FAILURE_THRESHOLD`, the cached hash is invalidated.
 */
let consecutiveLocalFailures = 0;
/**
 * Number of failed Supabase login attempts in no-cache mode. Used to compute
 * the exponential backoff delay.
 */
let rateLimitAttempts = 0;
/**
 * Timestamp (ms since epoch) before which the next login attempt is blocked.
 * Zero means no rate limit is active.
 */
let nextAllowedAttempt = 0;
// =============================================================================
// INTERNAL HELPERS
// =============================================================================
/**
 * Check whether the current rate-limit window allows a new attempt.
 *
 * @returns An object indicating whether the attempt is allowed, and if not,
 *          how many milliseconds remain until the next allowed attempt.
 */
function checkRateLimit() {
    const now = Date.now();
    if (nextAllowedAttempt > now) {
        return { allowed: false, retryAfterMs: nextAllowedAttempt - now };
    }
    return { allowed: true };
}
/**
 * Invalidate the locally cached gate hash in IndexedDB.
 *
 * Called when the guard determines the cached hash is stale (e.g., the user
 * changed their PIN on another device, or too many consecutive local
 * mismatches have occurred).
 *
 * @throws Never -- errors are caught and logged via `debugWarn`.
 */
async function invalidateCachedHash() {
    try {
        const config = getEngineConfig();
        const db = config.db;
        if (db) {
            const record = await db.table('singleUserConfig').get('config');
            if (record && record.gateHash) {
                await db.table('singleUserConfig').update('config', {
                    gateHash: undefined,
                    updatedAt: new Date().toISOString()
                });
                debugLog('[LoginGuard] Invalidated single-user gateHash');
            }
        }
    }
    catch (e) {
        debugWarn('[LoginGuard] Failed to invalidate cached hash:', e);
    }
}
// =============================================================================
// PUBLIC API
// =============================================================================
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
export async function preCheckLogin(input) {
    try {
        let cachedHash;
        const config = getEngineConfig();
        const db = config.db;
        if (db) {
            const record = await db.table('singleUserConfig').get('config');
            cachedHash = record?.gateHash;
        }
        if (cachedHash) {
            /* We have a cached hash -- compare locally before touching the network. */
            const inputHash = await hashValue(input);
            if (inputHash === cachedHash) {
                /* Local match -- proceed to Supabase for authoritative verification.
                   We never trust the local hash alone because it could be stale. */
                debugLog('[LoginGuard] Local hash match, proceeding to Supabase');
                return { proceed: true, strategy: 'local-match' };
            }
            /* Mismatch -- reject locally to avoid a needless Supabase round-trip. */
            consecutiveLocalFailures++;
            debugWarn(`[LoginGuard] Local hash mismatch (${consecutiveLocalFailures}/${LOCAL_FAILURE_THRESHOLD})`);
            if (consecutiveLocalFailures >= LOCAL_FAILURE_THRESHOLD) {
                /* Threshold exceeded -- the cached hash may be stale (password changed
                   on another device). Invalidate it so subsequent attempts go directly
                   to Supabase in rate-limited mode. */
                debugWarn('[LoginGuard] Threshold exceeded, invalidating cached hash');
                await invalidateCachedHash();
                consecutiveLocalFailures = 0;
                /* Fall through to rate-limited Supabase mode */
                const rateCheck = checkRateLimit();
                if (!rateCheck.allowed) {
                    return {
                        proceed: false,
                        error: 'Too many attempts. Please wait before trying again.',
                        retryAfterMs: rateCheck.retryAfterMs
                    };
                }
                return { proceed: true, strategy: 'no-cache' };
            }
            return { proceed: false, error: 'Incorrect password or code' };
        }
        /* No cached hash -- rate-limited Supabase mode */
        const rateCheck = checkRateLimit();
        if (!rateCheck.allowed) {
            return {
                proceed: false,
                error: 'Too many attempts. Please wait before trying again.',
                retryAfterMs: rateCheck.retryAfterMs
            };
        }
        debugLog('[LoginGuard] No cached hash, proceeding to Supabase (rate-limited mode)');
        return { proceed: true, strategy: 'no-cache' };
    }
    catch (e) {
        /* On any error, allow Supabase call (fail open for auth). A strict
           "fail closed" policy here would lock users out of their own app
           due to an IndexedDB read error. */
        debugWarn('[LoginGuard] Pre-check error, falling through to Supabase:', e);
        return { proceed: true, strategy: 'no-cache' };
    }
}
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
export function onLoginSuccess() {
    consecutiveLocalFailures = 0;
    rateLimitAttempts = 0;
    nextAllowedAttempt = 0;
    debugLog('[LoginGuard] Login success, counters reset');
}
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
export async function onLoginFailure(strategy) {
    if (strategy === 'local-match') {
        /* Stale hash: local match but Supabase rejected -- invalidate the cache
           so the user is not stuck in a loop of false local matches. */
        debugWarn('[LoginGuard] Stale hash detected, invalidating cached hash');
        await invalidateCachedHash();
    }
    else {
        /* No-cache mode: apply exponential backoff to throttle brute-force
           attempts that bypass the local pre-check. */
        rateLimitAttempts++;
        const delay = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, rateLimitAttempts - 1), MAX_DELAY_MS);
        nextAllowedAttempt = Date.now() + delay;
        debugWarn(`[LoginGuard] Rate limit applied: ${delay}ms delay (attempt ${rateLimitAttempts})`);
    }
}
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
export function resetLoginGuard() {
    consecutiveLocalFailures = 0;
    rateLimitAttempts = 0;
    nextAllowedAttempt = 0;
    debugLog('[LoginGuard] Guard reset');
}
//# sourceMappingURL=loginGuard.js.map