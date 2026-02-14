/**
 * @fileoverview Auth State Resolution
 *
 * Determines the current authentication state by checking Supabase session,
 * offline session, and cached credentials. Used by app layouts and route guards
 * to determine whether the user is authenticated and in which mode (online
 * Supabase session vs. offline cached session).
 *
 * Architecture:
 * - Two resolution paths based on engine config:
 *   1. **Multi-user mode** (default): checks online/offline status, Supabase
 *      session validity, and falls back to offline session + credential matching.
 *   2. **Single-user mode**: checks local `singleUserConfig` in IndexedDB,
 *      handles legacy migration, PIN length migration, session refresh, and
 *      offline fallback.
 * - The resolver does NOT start the sync engine -- callers decide whether to
 *   start sync based on the returned `authMode`.
 * - On catastrophic failure (corrupted auth state), all Supabase localStorage
 *   keys (`sb-*`) are purged and `authMode: 'none'` is returned, ensuring the
 *   user can start fresh rather than being permanently locked out.
 *
 * Security considerations:
 * - Offline sessions are cross-validated against cached credentials by userId
 *   to prevent stale or cross-user sessions from granting access.
 * - In single-user mode, legacy configs without an email (from the anonymous
 *   auth era) are nuked entirely -- anonymous data is inaccessible under
 *   ownership-based RLS anyway.
 * - The `singleUserConfig` table has been moved to IndexedDB + Supabase
 *   `user_metadata`; there is no longer a Supabase `single_user_config` table.
 * - Session refresh is attempted for expired single-user sessions before
 *   falling back to the PIN gate, preventing unnecessary re-authentication
 *   when only the access token (not the refresh token) has expired.
 *
 * @module auth/resolveAuthState
 */
import type { Session } from '@supabase/supabase-js';
import type { OfflineCredentials } from '../types';
/**
 * Result of auth state resolution, consumed by app layouts and route guards.
 */
export interface AuthStateResult {
    /** The Supabase session if one is active, or `null` if unauthenticated / offline-only. */
    session: Session | null;
    /**
     * The resolved authentication mode:
     * - `'supabase'` -- Active Supabase session (online or cached in localStorage).
     * - `'offline'` -- Offline session with locally cached credentials.
     * - `'none'` -- No valid authentication; user must log in.
     */
    authMode: 'supabase' | 'offline' | 'none';
    /** Offline credentials profile data, populated only when `authMode === 'offline'`. */
    offlineProfile: OfflineCredentials | null;
    /**
     * Whether single-user mode has been set up on this device.
     * Only present when the engine is configured for `mode === 'single-user'`.
     * `false` means the user needs to go through the initial setup flow.
     */
    singleUserSetUp?: boolean;
}
/**
 * Resolve the current authentication state.
 *
 * Inspects the engine config mode and delegates to the appropriate resolver:
 * - Single-user mode: {@link resolveSingleUserAuthState}
 * - Multi-user mode: inline resolution checking Supabase session, then offline session.
 *
 * Handles corrupted state cleanup by purging `sb-*` localStorage keys if
 * session retrieval throws.
 *
 * @returns A promise resolving to an {@link AuthStateResult} describing the
 *          current auth mode, session, and offline profile (if applicable).
 *
 * @example
 * ```ts
 * const { authMode, session, offlineProfile } = await resolveAuthState();
 * if (authMode === 'supabase') {
 *   startSyncEngine(session);
 * } else if (authMode === 'offline') {
 *   enterOfflineMode(offlineProfile);
 * } else {
 *   redirectToLogin();
 * }
 * ```
 *
 * @see {@link AuthStateResult} for the return type shape.
 */
export declare function resolveAuthState(): Promise<AuthStateResult>;
//# sourceMappingURL=resolveAuthState.d.ts.map