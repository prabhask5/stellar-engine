/**
 * @fileoverview Login Guard -- Local Credential Pre-Check & Lockout
 *
 * Minimizes Supabase auth API requests by verifying credentials locally first.
 * Only calls Supabase when the local hash matches (correct password) or when no
 * local hash exists.
 *
 * Architecture:
 * - Maintains **in-memory** state for fast local-hash failure counters
 *   (resets on page refresh by design).
 * - Maintains **persistent** lockout state in IndexedDB (`singleUserConfig`
 *   table, key `'pin_lockout'`).  This survives page refreshes and tab
 *   closes, preventing brute-force attacks that rely on reloading to reset
 *   counters.
 * - Two operational strategies:
 *   1. `local-match`: A cached hash exists and the user's input matches it.
 *      Proceed to Supabase for authoritative verification.
 *   2. `no-cache`: No cached hash is available. Proceed to Supabase directly.
 * - After a configurable number of consecutive local mismatches, the cached hash
 *   is invalidated (it may be stale from a server-side password change) and the
 *   guard falls back to direct Supabase mode.
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

import { hashValue } from './crypto';
import { getEngineConfig, waitForDb } from '../config';
import { debugLog, debugWarn } from '../debug';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Number of consecutive local hash mismatches before the cached hash is
 * invalidated. Prevents a permanently stale hash from locking out the user.
 */
const LOCAL_FAILURE_THRESHOLD = 5;

/**
 * Progressive persistent-lockout tiers.
 *
 * After `failures` total failed Supabase login attempts (across page
 * refreshes), the user is locked out for `durationMs` milliseconds.
 * The tiers are checked in order — the **highest** matching tier wins.
 */
const PERSISTENT_LOCKOUT_TIERS: Array<{ failures: number; durationMs: number }> = [
  { failures: 5, durationMs: 5 * 60_000 }, //  5 min  after  5 failures
  { failures: 10, durationMs: 30 * 60_000 }, // 30 min  after 10 failures
  { failures: 15, durationMs: 2 * 60 * 60_000 }, //  2 hr   after 15 failures
  { failures: 20, durationMs: 24 * 60 * 60_000 } // 24 hr   after 20+ failures
];

/** IndexedDB record key for the persistent lockout state. */
const PIN_LOCKOUT_KEY = 'pin_lockout';

// =============================================================================
// IN-MEMORY STATE
// =============================================================================

/**
 * Tracks how many times the local hash comparison has failed consecutively.
 * Once this reaches `LOCAL_FAILURE_THRESHOLD`, the cached hash is invalidated.
 */
let consecutiveLocalFailures = 0;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Strategy used when proceeding to the Supabase auth call.
 *
 * - `'local-match'` -- The user's input matched a locally cached hash.
 *   Supabase is called for authoritative confirmation.
 * - `'no-cache'` -- No local hash was available (or it was invalidated).
 *   Supabase is called directly.
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
export type PreCheckResult =
  | { proceed: true; strategy: PreCheckStrategy }
  | { proceed: false; error: string; retryAfterMs?: number };

/**
 * Persistent lockout record stored in IndexedDB.
 */
interface PinLockoutRecord {
  /** Constant key (`'pin_lockout'`). */
  id: typeof PIN_LOCKOUT_KEY;
  /** Total failed Supabase login attempts since last success. */
  failureCount: number;
  /**
   * Epoch ms timestamp until which new attempts are blocked.
   * Zero means no active lockout.
   */
  lockoutUntil: number;
  /** ISO timestamp of the last write (for debugging). */
  updatedAt: string;
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Invalidate the locally cached gate hash in IndexedDB.
 *
 * Called when the guard determines the cached hash is stale (e.g., the user
 * changed their PIN on another device, or too many consecutive local
 * mismatches have occurred).
 *
 * @throws Never -- errors are caught and logged via `debugWarn`.
 */
async function invalidateCachedHash(): Promise<void> {
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
  } catch (e) {
    debugWarn('[LoginGuard] Failed to invalidate cached hash:', e);
  }
}

/**
 * Read the persistent lockout record from IndexedDB.
 *
 * Returns a zeroed default record when none exists or on any read error.
 */
async function readPersistentLockout(): Promise<PinLockoutRecord> {
  const zero: PinLockoutRecord = {
    id: PIN_LOCKOUT_KEY,
    failureCount: 0,
    lockoutUntil: 0,
    updatedAt: new Date().toISOString()
  };
  try {
    await waitForDb();
    const db = getEngineConfig().db;
    if (!db) return zero;
    const record = await db.table('singleUserConfig').get(PIN_LOCKOUT_KEY);
    return (record as PinLockoutRecord | undefined) ?? zero;
  } catch {
    return zero;
  }
}

/**
 * Write a persistent lockout record to IndexedDB.
 *
 * Errors are swallowed — a failed write degrades gracefully to in-memory-only
 * protection; Supabase server-side limits remain the primary defence.
 */
async function writePersistentLockout(record: PinLockoutRecord): Promise<void> {
  try {
    const db = getEngineConfig().db;
    if (db) {
      await db.table('singleUserConfig').put(record);
    }
  } catch (e) {
    debugWarn('[LoginGuard] Failed to write persistent lockout:', e);
  }
}

/**
 * Compute the lockout duration for a given failure count.
 *
 * Returns 0 when the count has not yet reached the first tier.
 */
function getLockoutDurationMs(failureCount: number): number {
  let duration = 0;
  for (const tier of PERSISTENT_LOCKOUT_TIERS) {
    if (failureCount >= tier.failures) {
      duration = tier.durationMs;
    }
  }
  return duration;
}

// =============================================================================
// PUBLIC API
// =============================================================================

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
export async function checkPersistentLockout(): Promise<number> {
  try {
    const record = await readPersistentLockout();
    const remaining = record.lockoutUntil - Date.now();
    return remaining > 0 ? remaining : 0;
  } catch {
    return 0;
  }
}

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
export async function preCheckLogin(input: string): Promise<PreCheckResult> {
  try {
    /* ── Persistent lockout check (survives page refresh) ── */
    const lockoutRecord = await readPersistentLockout();
    const persistentRemaining = lockoutRecord.lockoutUntil - Date.now();
    if (persistentRemaining > 0) {
      const mins = Math.ceil(persistentRemaining / 60_000);
      const timeDesc =
        persistentRemaining >= 60 * 60_000
          ? `${Math.ceil(persistentRemaining / (60 * 60_000))} hour${Math.ceil(persistentRemaining / (60 * 60_000)) !== 1 ? 's' : ''}`
          : `${mins} minute${mins !== 1 ? 's' : ''}`;
      return {
        proceed: false,
        error: `Too many failed attempts. Please wait ${timeDesc} before trying again.`,
        retryAfterMs: persistentRemaining
      };
    }

    let cachedHash: string | undefined;

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
      debugWarn(
        `[LoginGuard] Local hash mismatch (${consecutiveLocalFailures}/${LOCAL_FAILURE_THRESHOLD})`
      );

      if (consecutiveLocalFailures >= LOCAL_FAILURE_THRESHOLD) {
        /* Threshold exceeded -- the cached hash may be stale (password changed
           on another device). Invalidate it so subsequent attempts go directly
           to Supabase. */
        debugWarn('[LoginGuard] Threshold exceeded, invalidating cached hash');
        await invalidateCachedHash();
        consecutiveLocalFailures = 0;
        return { proceed: true, strategy: 'no-cache' };
      }

      return { proceed: false, error: 'Incorrect password or code' };
    }

    /* No cached hash -- proceed to Supabase directly. */
    debugLog('[LoginGuard] No cached hash, proceeding to Supabase');
    return { proceed: true, strategy: 'no-cache' };
  } catch (e) {
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
 * Resets the local failure counter and clears the persistent lockout record
 * from IndexedDB so the user starts fresh.
 *
 * @example
 * ```ts
 * const { error } = await supabase.auth.signInWithPassword({ email, password });
 * if (!error) onLoginSuccess();
 * ```
 */
export async function onLoginSuccess(): Promise<void> {
  consecutiveLocalFailures = 0;
  /* Clear persistent failure counter and lockout */
  await writePersistentLockout({
    id: PIN_LOCKOUT_KEY,
    failureCount: 0,
    lockoutUntil: 0,
    updatedAt: new Date().toISOString()
  });
  debugLog('[LoginGuard] Login success, counters reset');
}

/**
 * Called after a failed Supabase login.
 *
 * Behavior depends on the strategy that was used:
 *
 * - `'local-match'`: Supabase rejected a locally-matched password, meaning the
 *   cached hash is **stale** (password changed server-side). The cached hash is
 *   invalidated so future attempts go through direct Supabase mode.
 * - `'no-cache'`: Increments the persistent failure counter and applies a
 *   tier-based lockout if the threshold is reached.
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
export async function onLoginFailure(strategy: PreCheckStrategy): Promise<void> {
  if (strategy === 'local-match') {
    /* Stale hash: local match but Supabase rejected -- invalidate the cache
       so the user is not stuck in a loop of false local matches. */
    debugWarn('[LoginGuard] Stale hash detected, invalidating cached hash');
    await invalidateCachedHash();
  } else {
    /* No-cache mode: increment persistent failure counter and apply
       tier-based lockout if the threshold is reached. */
    try {
      const record = await readPersistentLockout();
      const newCount = record.failureCount + 1;
      const lockoutDuration = getLockoutDurationMs(newCount);
      const lockoutUntil = lockoutDuration > 0 ? Date.now() + lockoutDuration : 0;

      if (lockoutUntil > 0) {
        const mins = Math.ceil(lockoutDuration / 60_000);
        debugWarn(
          `[LoginGuard] Persistent lockout applied: ${mins} min (${newCount} total failures)`
        );
      }

      await writePersistentLockout({
        id: PIN_LOCKOUT_KEY,
        failureCount: newCount,
        lockoutUntil,
        updatedAt: new Date().toISOString()
      });
    } catch (e) {
      debugWarn('[LoginGuard] Failed to update persistent lockout:', e);
    }
  }
}

/**
 * Full reset of all login guard state.
 *
 * Call on sign-out or app reset to clear failure counters so the next login
 * attempt starts with a clean slate.
 *
 * @example
 * ```ts
 * await supabase.auth.signOut();
 * await resetLoginGuard();
 * ```
 */
export async function resetLoginGuard(): Promise<void> {
  consecutiveLocalFailures = 0;
  await writePersistentLockout({
    id: PIN_LOCKOUT_KEY,
    failureCount: 0,
    lockoutUntil: 0,
    updatedAt: new Date().toISOString()
  });
  debugLog('[LoginGuard] Guard reset');
}
