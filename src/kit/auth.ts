/**
 * @fileoverview Auth hydration helper for the root layout component.
 *
 * Reads layout load data and calls the appropriate `authState.set*()`
 * method so child components get reactive access to auth state.
 */

import { authState } from '../stores/authState.js';
import type { AuthMode, OfflineCredentials } from '../types.js';
import type { Session } from '@supabase/supabase-js';

// =============================================================================
//  TYPES
// =============================================================================

/** Shape of the layout data expected by `hydrateAuthState`. */
export interface AuthLayoutData {
  authMode: AuthMode;
  session: Session | null;
  offlineProfile: OfflineCredentials | null;
}

// =============================================================================
//  PUBLIC API
// =============================================================================

/**
 * Reads layout load data (`{ authMode, session, offlineProfile }`) and calls
 * the appropriate `authState.set*()` method.
 *
 * Call this from a Svelte 5 `$effect()` in your root `+layout.svelte`:
 * ```ts
 * $effect(() => { hydrateAuthState(data); });
 * ```
 */
export function hydrateAuthState(layoutData: AuthLayoutData): void {
  if (layoutData.authMode === 'supabase' && layoutData.session) {
    authState.setSupabaseAuth(layoutData.session);
  } else if (layoutData.authMode === 'offline' && layoutData.offlineProfile) {
    authState.setOfflineAuth(layoutData.offlineProfile);
  } else {
    authState.setNoAuth();
  }
}
