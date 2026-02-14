/**
 * @fileoverview Auth hydration helper for the root layout component.
 *
 * Reads layout load data and calls the appropriate `authState.set*()`
 * method so child components get reactive access to auth state.
 */
import type { AuthMode, OfflineCredentials } from '../types.js';
import type { Session } from '@supabase/supabase-js';
/** Shape of the layout data expected by `hydrateAuthState`. */
export interface AuthLayoutData {
    authMode: AuthMode;
    session: Session | null;
    offlineProfile: OfflineCredentials | null;
}
/**
 * Reads layout load data (`{ authMode, session, offlineProfile }`) and calls
 * the appropriate `authState.set*()` method.
 *
 * Call this from a Svelte 5 `$effect()` in your root `+layout.svelte`:
 * ```ts
 * $effect(() => { hydrateAuthState(data); });
 * ```
 */
export declare function hydrateAuthState(layoutData: AuthLayoutData): void;
//# sourceMappingURL=auth.d.ts.map