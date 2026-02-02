/**
 * Auth State Resolution
 *
 * Determines the current authentication state by checking Supabase session,
 * offline session, and cached credentials. Used by app layouts to determine
 * whether user is authenticated and in which mode.
 */
import type { Session } from '@supabase/supabase-js';
import type { OfflineCredentials } from '../types';
export interface AuthStateResult {
    session: Session | null;
    authMode: 'supabase' | 'offline' | 'none';
    offlineProfile: OfflineCredentials | null;
    /** Whether single-user mode has been set up (only present when mode === 'single-user') */
    singleUserSetUp?: boolean;
}
/**
 * Resolve the current authentication state.
 *
 * - Online: check Supabase session validity
 * - Offline: check localStorage session, fallback to offline session + credential matching
 * - Handles corrupted state cleanup
 * - Does NOT start sync engine (caller decides)
 */
export declare function resolveAuthState(): Promise<AuthStateResult>;
//# sourceMappingURL=resolveAuthState.d.ts.map