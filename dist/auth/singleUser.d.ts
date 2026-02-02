/**
 * Single-User Auth Module
 *
 * Implements a local gate (code or password) verified against a SHA-256 hash
 * stored in IndexedDB. Uses Supabase anonymous auth for session/token management
 * and RLS compliance. Falls back to offline auth when connectivity is unavailable.
 */
import type { SingleUserConfig } from '../types';
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
} | null>;
/**
 * First-time setup: hash gate, create anonymous Supabase user (if online),
 * store config, and set auth state.
 */
export declare function setupSingleUser(gate: string, profile: Record<string, unknown>): Promise<{
    error: string | null;
}>;
/**
 * Unlock: verify gate hash, restore Supabase session or fall back to offline auth.
 */
export declare function unlockSingleUser(gate: string): Promise<{
    error: string | null;
}>;
/**
 * Lock: stop sync engine, reset auth state to 'none'.
 * Does NOT destroy session, data, or sign out of Supabase.
 */
export declare function lockSingleUser(): Promise<void>;
/**
 * Change the gate (code/password). Verifies old gate first.
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