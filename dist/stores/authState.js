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
import { writable, derived } from 'svelte/store';
// =============================================================================
// Store Factory
// =============================================================================
/**
 * Creates the singleton authentication state store.
 *
 * The store starts in a loading state (`mode: 'none', isLoading: true`) and
 * transitions to a concrete mode once the auth subsystem determines whether
 * a Supabase session, offline credentials, or neither are available.
 *
 * @returns A Svelte-compatible store with auth-specific mutation methods
 *
 * @example
 * ```ts
 * // In the auth initialization flow:
 * authState.setSupabaseAuth(session);
 *
 * // On logout or session expiry:
 * authState.setNoAuth('Your session has expired.');
 * ```
 */
function createAuthStateStore() {
    const { subscribe, set, update } = writable({
        mode: 'none',
        session: null,
        offlineProfile: null,
        isLoading: true,
        authKickedMessage: null
    });
    return {
        subscribe,
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
        setSupabaseAuth(session) {
            update((state) => ({
                ...state,
                mode: 'supabase',
                session,
                offlineProfile: null /* Clear offline data to avoid stale cross-mode references */,
                isLoading: false,
                authKickedMessage: null
            }));
        },
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
        setOfflineAuth(profile) {
            update((state) => ({
                ...state,
                mode: 'offline',
                session: null /* Clear Supabase session since we're operating offline */,
                offlineProfile: profile,
                isLoading: false,
                authKickedMessage: null
            }));
        },
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
        setNoAuth(kickedMessage) {
            update((state) => ({
                ...state,
                mode: 'none',
                session: null,
                offlineProfile: null,
                isLoading: false,
                authKickedMessage: kickedMessage || null
            }));
        },
        /**
         * Update only the loading flag without altering the auth mode or session.
         *
         * Useful during initialization when the auth subsystem needs to signal
         * that it is still resolving the session state.
         *
         * @param isLoading - Whether the auth subsystem is currently loading
         */
        setLoading(isLoading) {
            update((state) => ({ ...state, isLoading }));
        },
        /**
         * Dismiss the kicked message without changing auth mode.
         *
         * Typically called after the login UI has displayed the kicked banner
         * and the user has acknowledged it.
         */
        clearKickedMessage() {
            update((state) => ({ ...state, authKickedMessage: null }));
        },
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
        updateSession(session) {
            update((state) => {
                if (!session) {
                    /* Session was cleared - if online, set no auth
                     * If offline and was in supabase mode, we'll check offline session elsewhere */
                    return {
                        ...state,
                        session: null
                    };
                }
                return {
                    ...state,
                    session,
                    mode: 'supabase'
                };
            });
        },
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
        updateUserProfile(profile) {
            update((state) => {
                if (state.mode === 'supabase' && state.session) {
                    /* Deep-merge into Supabase's user_metadata so existing fields are preserved */
                    return {
                        ...state,
                        session: {
                            ...state.session,
                            user: {
                                ...state.session.user,
                                user_metadata: {
                                    ...state.session.user.user_metadata,
                                    ...profile
                                }
                            }
                        }
                    };
                }
                if (state.mode === 'offline' && state.offlineProfile) {
                    /* For offline mode, replace the profile object wholesale since
                     * offline credentials use a simpler profile structure */
                    return {
                        ...state,
                        offlineProfile: {
                            ...state.offlineProfile,
                            profile
                        }
                    };
                }
                return state;
            });
        },
        /**
         * Reset the store to its initial loading state.
         *
         * Called during app teardown or when reinitializing the auth subsystem.
         * The `isLoading: true` default ensures the UI shows a loading indicator
         * until the auth flow completes again.
         */
        reset() {
            set({
                mode: 'none',
                session: null,
                offlineProfile: null,
                isLoading: true,
                authKickedMessage: null
            });
        }
    };
}
// =============================================================================
// Singleton Store Instance
// =============================================================================
/** The singleton authentication state store used throughout the application. */
export const authState = createAuthStateStore();
// =============================================================================
// Derived Stores
// =============================================================================
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
export const isAuthenticated = derived(authState, ($authState) => $authState.mode !== 'none' && !$authState.isLoading);
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
export const userDisplayInfo = derived(authState, ($authState) => {
    if ($authState.mode === 'supabase' && $authState.session) {
        const user = $authState.session.user;
        return {
            profile: user.user_metadata || {},
            email: user.email || ''
        };
    }
    if ($authState.mode === 'offline' && $authState.offlineProfile) {
        return {
            profile: $authState.offlineProfile.profile || {},
            email: $authState.offlineProfile.email
        };
    }
    return null;
});
//# sourceMappingURL=authState.js.map