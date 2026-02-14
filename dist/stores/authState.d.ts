/**
 * @fileoverview Authentication State Store
 *
 * Manages the current authentication mode and session data for the application.
 * Supports three distinct authentication modes:
 *   - **supabase**: Online authentication via Supabase with a full session object
 *   - **offline**: Local/cached authentication using stored credentials
 *   - **none**: Unauthenticated state (login screen)
 *
 * **Svelte Store Pattern:**
 * Uses a custom writable store created via the factory function `createAuthStateStore()`.
 * The store exposes the standard `subscribe` method for reactivity, plus imperative
 * mutation methods (e.g., `setSupabaseAuth`, `setOfflineAuth`) that internally call
 * `update()` to ensure immutable state transitions.
 *
 * **Reactive Architecture:**
 * Two derived stores (`isAuthenticated`, `userDisplayInfo`) project slices of the
 * auth state for UI consumption, keeping components decoupled from the raw state shape.
 * Components subscribe to these derived stores rather than inspecting the full auth
 * state, which simplifies rendering logic and reduces unnecessary re-renders.
 *
 * @see {@link ../types} for AuthMode and OfflineCredentials type definitions
 * @see {@link @supabase/supabase-js} for the Session type
 */
import { type Readable } from 'svelte/store';
import type { AuthMode, OfflineCredentials } from '../types';
import type { Session } from '@supabase/supabase-js';
/**
 * Internal state shape for the authentication store.
 * Represents a single, consistent snapshot of the user's auth status.
 */
interface AuthState {
    /** The current authentication strategy in use */
    mode: AuthMode;
    /** Active Supabase session; only populated when `mode` is 'supabase' */
    session: Session | null;
    /** Cached offline credentials; only populated when `mode` is 'offline' */
    offlineProfile: OfflineCredentials | null;
    /** Whether the auth subsystem is still resolving the initial session */
    isLoading: boolean;
    /**
     * Message to display when the user is forcibly signed out.
     * Set by `setNoAuth()` when a kicked reason is provided (e.g., session
     * expiry, admin revocation). Cleared on next successful auth transition.
     */
    authKickedMessage: string | null;
}
/** The singleton authentication state store used throughout the application. */
export declare const authState: {
    subscribe: (this: void, run: import("svelte/store").Subscriber<AuthState>, invalidate?: () => void) => import("svelte/store").Unsubscriber;
    /**
     * Transition to Supabase-authenticated mode.
     *
     * Clears any offline profile and kicked message, sets loading to false,
     * and stores the provided Supabase session.
     *
     * @param session - The active Supabase session object from sign-in or token refresh
     *
     * @example
     * ```ts
     * const { data } = await supabase.auth.signInWithPassword({ email, password });
     * if (data.session) authState.setSupabaseAuth(data.session);
     * ```
     */
    setSupabaseAuth(session: Session): void;
    /**
     * Transition to offline-authenticated mode.
     *
     * Used when the app detects valid cached credentials but no network
     * connectivity for Supabase verification.
     *
     * @param profile - The locally-cached offline credentials
     *
     * @example
     * ```ts
     * const cached = await loadCachedCredentials();
     * if (cached) authState.setOfflineAuth(cached);
     * ```
     */
    setOfflineAuth(profile: OfflineCredentials): void;
    /**
     * Transition to unauthenticated mode.
     *
     * Clears all session and profile data. Optionally stores a human-readable
     * message explaining why the user was signed out, which the login UI can
     * display as a banner or toast.
     *
     * @param kickedMessage - Optional explanation for the forced sign-out
     *
     * @example
     * ```ts
     * // Voluntary logout
     * authState.setNoAuth();
     *
     * // Forced sign-out with reason
     * authState.setNoAuth('Your account was deactivated by an administrator.');
     * ```
     */
    setNoAuth(kickedMessage?: string): void;
    /**
     * Update only the loading flag without altering the auth mode or session.
     *
     * Useful during initialization when the auth subsystem needs to signal
     * that it is still resolving the session state.
     *
     * @param isLoading - Whether the auth subsystem is currently loading
     */
    setLoading(isLoading: boolean): void;
    /**
     * Dismiss the kicked message without changing auth mode.
     *
     * Typically called after the login UI has displayed the kicked banner
     * and the user has acknowledged it.
     */
    clearKickedMessage(): void;
    /**
     * Update the Supabase session in-place (e.g., after a token refresh).
     *
     * If the new session is `null`, the session field is cleared but the mode
     * is **not** changed here. The caller (typically the auth listener) is
     * responsible for deciding whether to fall back to offline or no-auth mode.
     *
     * @param session - The refreshed Supabase session, or null if invalidated
     *
     * @see setNoAuth for transitioning to unauthenticated mode
     * @see setOfflineAuth for falling back to offline mode
     */
    updateSession(session: Session | null): void;
    /**
     * Merge updated profile fields into the current user metadata.
     *
     * Handles both Supabase and offline modes so UI components that display
     * user profile info (avatar, display name, etc.) update immediately
     * without waiting for a round-trip.
     *
     * @param profile - Key-value pairs to merge into the existing profile metadata
     *
     * @example
     * ```ts
     * // After saving profile changes to the server:
     * authState.updateUserProfile({ display_name: 'New Name', avatar_url: newUrl });
     * ```
     */
    updateUserProfile(profile: Record<string, unknown>): void;
    /**
     * Reset the store to its initial loading state.
     *
     * Called during app teardown or when reinitializing the auth subsystem.
     * The `isLoading: true` default ensures the UI shows a loading indicator
     * until the auth flow completes again.
     */
    reset(): void;
};
/**
 * Derived store that resolves to `true` when the user is authenticated
 * in any mode (Supabase or offline) and the auth subsystem has finished loading.
 *
 * Use this for route guards and conditional rendering of authenticated content.
 *
 * @example
 * ```svelte
 * {#if $isAuthenticated}
 *   <Dashboard />
 * {:else}
 *   <LoginScreen />
 * {/if}
 * ```
 *
 * @see authState for the underlying state
 */
export declare const isAuthenticated: Readable<boolean>;
/**
 * Derived store that projects the user's display-friendly profile info
 * (email and metadata) regardless of the current auth mode.
 *
 * Returns `null` when unauthenticated, allowing components to use a simple
 * null check rather than inspecting the auth mode directly.
 *
 * @example
 * ```svelte
 * {#if $userDisplayInfo}
 *   <Avatar profile={$userDisplayInfo.profile} />
 *   <span>{$userDisplayInfo.email}</span>
 * {/if}
 * ```
 *
 * @see authState for the underlying state
 */
export declare const userDisplayInfo: Readable<{
    /** User metadata (display_name, avatar_url, etc.) */
    profile: Record<string, unknown>;
    /** User's email address */
    email: string;
} | null>;
export {};
//# sourceMappingURL=authState.d.ts.map