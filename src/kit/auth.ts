/**
 * @fileoverview Auth hydration helper for the root layout component.
 *
 * This module bridges the gap between SvelteKit's server-side load data and
 * the client-side reactive auth store (`authState`). When the root layout
 * receives auth-related data from a load function, this helper inspects the
 * `authMode` discriminator and calls the corresponding `authState.set*()`
 * setter so that every downstream component gets reactive access to the
 * current authentication state without needing to know the hydration details.
 *
 * @module kit/auth
 *
 * @example
 * ```svelte
 * <!-- +layout.svelte -->
 * <script lang="ts">
 *   import { hydrateAuthState } from 'stellar-engine/kit/auth';
 *   let { data } = $props();
 *   $effect(() => { hydrateAuthState(data); });
 * </script>
 * ```
 *
 * @see {@link authState} for the reactive store being hydrated
 * @see {@link resolveAuthState} in `auth/resolveAuthState.ts` for how auth
 *      state is determined on the server/load side
 */

import { authState } from '../stores/authState.js';
import type { AuthMode, OfflineCredentials } from '../types.js';
import type { Session } from '@supabase/supabase-js';

// =============================================================================
//  TYPES
// =============================================================================

/**
 * Shape of the layout data expected by `hydrateAuthState`.
 *
 * This interface mirrors the return type of the root layout load function,
 * containing the three fields needed to fully reconstruct auth state on the
 * client side.
 */
export interface AuthLayoutData {
  /**
   * Discriminator indicating which authentication strategy is active.
   * - `'supabase'` — cloud-hosted auth via Supabase
   * - `'offline'`  — local/offline credentials (single-user mode)
   * - `'none'`     — no active authentication
   */
  authMode: AuthMode;

  /**
   * The Supabase session object, present only when `authMode === 'supabase'`.
   * Contains the access token, refresh token, and user metadata.
   */
  session: Session | null;

  /**
   * The offline profile credentials, present only when `authMode === 'offline'`.
   * Contains locally-stored user identity information for single-user setups.
   */
  offlineProfile: OfflineCredentials | null;
}

// =============================================================================
//  PUBLIC API
// =============================================================================

/**
 * Reads layout load data (`{ authMode, session, offlineProfile }`) and calls
 * the appropriate `authState.set*()` method to hydrate the client-side
 * reactive auth store.
 *
 * The function acts as a switchboard: it inspects `authMode` and delegates to
 * the matching setter on the `authState` store. This keeps the root layout
 * component free of branching logic and ensures a single source of truth for
 * how layout data maps to reactive state.
 *
 * Call this from a Svelte 5 `$effect()` in your root `+layout.svelte` so it
 * re-runs whenever the layout data changes (e.g. after a login or logout):
 *
 * @param layoutData - The auth-related subset of root layout load data.
 *
 * @example
 * ```ts
 * // In +layout.svelte
 * $effect(() => { hydrateAuthState(data); });
 * ```
 *
 * @see {@link AuthLayoutData} for the expected shape of `layoutData`
 * @see {@link authState} for the store methods being invoked
 */
export function hydrateAuthState(layoutData: AuthLayoutData): void {
  /* Supabase mode requires both the mode flag AND a valid session object;
     if the session is null the user has been logged out server-side. */
  if (layoutData.authMode === 'demo') {
    authState.setDemoAuth();
  } else if (layoutData.authMode === 'supabase' && layoutData.session) {
    authState.setSupabaseAuth(layoutData.session);
  } else if (layoutData.authMode === 'offline' && layoutData.offlineProfile) {
    /* Offline mode requires a locally-stored profile to be present;
       without it we fall through to the unauthenticated state. */
    authState.setOfflineAuth(layoutData.offlineProfile);
  } else {
    /* Catch-all: covers 'none' mode as well as edge cases where the mode
       flag is set but the corresponding payload is missing. */
    authState.setNoAuth();
  }
}
