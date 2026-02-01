/**
 * Auth State Store
 * Tracks the current authentication mode (supabase/offline/none)
 */
import { type Readable } from 'svelte/store';
import type { AuthMode, OfflineCredentials } from '../types';
import type { Session } from '@supabase/supabase-js';
interface AuthState {
    mode: AuthMode;
    session: Session | null;
    offlineProfile: OfflineCredentials | null;
    isLoading: boolean;
    authKickedMessage: string | null;
}
export declare const authState: {
    subscribe: (this: void, run: import("svelte/store").Subscriber<AuthState>, invalidate?: () => void) => import("svelte/store").Unsubscriber;
    /**
     * Set auth mode to Supabase with session
     */
    setSupabaseAuth(session: Session): void;
    /**
     * Set auth mode to offline with cached profile
     */
    setOfflineAuth(profile: OfflineCredentials): void;
    /**
     * Set auth mode to none (no session)
     */
    setNoAuth(kickedMessage?: string): void;
    /**
     * Set loading state
     */
    setLoading(isLoading: boolean): void;
    /**
     * Clear the auth kicked message
     */
    clearKickedMessage(): void;
    /**
     * Update the Supabase session (for token refresh)
     */
    updateSession(session: Session | null): void;
    /**
     * Update user profile info in the session
     * Used when profile is updated to immediately reflect changes in UI
     */
    updateUserProfile(profile: Record<string, unknown>): void;
    /**
     * Reset to initial state
     */
    reset(): void;
};
export declare const isAuthenticated: Readable<boolean>;
export declare const userDisplayInfo: Readable<{
    profile: Record<string, unknown>;
    email: string;
} | null>;
export {};
//# sourceMappingURL=authState.d.ts.map