/**
 * Login Guard — Local Credential Pre-Check & Rate Limiting
 *
 * Minimizes Supabase auth requests by verifying credentials locally first.
 * Only calls Supabase when the local hash matches (correct password) or
 * when no local hash exists (with rate limiting).
 *
 * State is in-memory only (resets on page refresh).
 */
import { hashValue } from './crypto';
import { getOfflineCredentials } from './offlineCredentials';
import { getEngineConfig } from '../config';
import { debugLog, debugWarn } from '../debug';
// ============================================================
// CONSTANTS
// ============================================================
const LOCAL_FAILURE_THRESHOLD = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const BACKOFF_MULTIPLIER = 2;
// ============================================================
// IN-MEMORY STATE
// ============================================================
let consecutiveLocalFailures = 0;
let rateLimitAttempts = 0;
let nextAllowedAttempt = 0;
// ============================================================
// INTERNAL HELPERS
// ============================================================
function checkRateLimit() {
    const now = Date.now();
    if (nextAllowedAttempt > now) {
        return { allowed: false, retryAfterMs: nextAllowedAttempt - now };
    }
    return { allowed: true };
}
async function invalidateCachedHash(mode) {
    try {
        if (mode === 'single-user') {
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
        else {
            const config = getEngineConfig();
            const db = config.db;
            if (db) {
                const record = await db.table('offlineCredentials').get('current_user');
                if (record && record.password) {
                    await db.table('offlineCredentials').update('current_user', {
                        password: undefined,
                        cachedAt: new Date().toISOString()
                    });
                    debugLog('[LoginGuard] Invalidated offline credentials password hash');
                }
            }
        }
    }
    catch (e) {
        debugWarn('[LoginGuard] Failed to invalidate cached hash:', e);
    }
}
// ============================================================
// PUBLIC API
// ============================================================
/**
 * Pre-check login credentials locally before calling Supabase.
 *
 * For single-user mode: reads singleUserConfig.gateHash, hashes input, compares.
 * For multi-user mode: reads offlineCredentials, matches email + hashes password, compares.
 *
 * Returns { proceed: true, strategy } to allow Supabase call,
 * or { proceed: false, error, retryAfterMs? } to reject locally.
 */
export async function preCheckLogin(input, mode, email) {
    try {
        let cachedHash;
        if (mode === 'single-user') {
            const config = getEngineConfig();
            const db = config.db;
            if (db) {
                const record = await db.table('singleUserConfig').get('config');
                cachedHash = record?.gateHash;
            }
        }
        else {
            const creds = await getOfflineCredentials();
            if (creds && email && creds.email === email && creds.password) {
                cachedHash = creds.password;
            }
        }
        if (cachedHash) {
            // We have a cached hash — compare locally
            const inputHash = await hashValue(input);
            if (inputHash === cachedHash) {
                // Local match — proceed to Supabase for authoritative verification
                debugLog('[LoginGuard] Local hash match, proceeding to Supabase');
                return { proceed: true, strategy: 'local-match' };
            }
            // Mismatch — reject locally
            consecutiveLocalFailures++;
            debugWarn(`[LoginGuard] Local hash mismatch (${consecutiveLocalFailures}/${LOCAL_FAILURE_THRESHOLD})`);
            if (consecutiveLocalFailures >= LOCAL_FAILURE_THRESHOLD) {
                // Threshold exceeded — invalidate cached hash and fall through to no-cache mode
                debugWarn('[LoginGuard] Threshold exceeded, invalidating cached hash');
                await invalidateCachedHash(mode);
                consecutiveLocalFailures = 0;
                // Fall through to rate-limited Supabase mode
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
        // No cached hash — rate-limited Supabase mode
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
        // On any error, allow Supabase call (fail open for auth)
        debugWarn('[LoginGuard] Pre-check error, falling through to Supabase:', e);
        return { proceed: true, strategy: 'no-cache' };
    }
}
/**
 * Called after a successful Supabase login.
 * Resets all login guard counters.
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
 * If strategy was 'local-match': Supabase rejected a locally-matched password
 *   → invalidate cached hash (stale hash scenario).
 * If strategy was 'no-cache': increment rate limit counters with exponential backoff.
 */
export async function onLoginFailure(strategy, mode = 'multi-user') {
    if (strategy === 'local-match') {
        // Stale hash: local match but Supabase rejected → invalidate cache
        debugWarn('[LoginGuard] Stale hash detected, invalidating cached hash');
        await invalidateCachedHash(mode);
    }
    else {
        // No-cache mode: apply exponential backoff
        rateLimitAttempts++;
        const delay = Math.min(BASE_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, rateLimitAttempts - 1), MAX_DELAY_MS);
        nextAllowedAttempt = Date.now() + delay;
        debugWarn(`[LoginGuard] Rate limit applied: ${delay}ms delay (attempt ${rateLimitAttempts})`);
    }
}
/**
 * Full reset of all login guard state.
 * Call on sign-out or app reset.
 */
export function resetLoginGuard() {
    consecutiveLocalFailures = 0;
    rateLimitAttempts = 0;
    nextAllowedAttempt = 0;
    debugLog('[LoginGuard] Guard reset');
}
//# sourceMappingURL=loginGuard.js.map