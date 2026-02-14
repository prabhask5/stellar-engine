/**
 * @fileoverview Auth Display Utilities
 *
 * Pure helper functions that resolve user-facing display values (first name,
 * user ID, avatar initial) from the auth state. Each function handles the
 * full fallback chain across online (Supabase session) and offline (cached
 * credentials) modes, so consuming components don't need to duplicate the
 * resolution logic.
 *
 * Resolution strategy (consistent across all helpers):
 *   1. Check the Supabase session (`Session.user`) first.
 *   2. Fall back to the offline credential cache (`OfflineCredentials`).
 *   3. Return a caller-provided fallback or a sensible default.
 *
 * These functions are stateless and framework-agnostic — they accept plain
 * data and return plain values. Wrap them in `$derived` / `$derived.by` in
 * Svelte 5 components to make them reactive.
 *
 * @module auth/displayUtils
 */
import type { Session } from '@supabase/supabase-js';
import type { OfflineCredentials } from '../types';
/**
 * Resolve the user's first name for greeting / display purposes.
 *
 * Fallback chain:
 *   1. `firstName` / `first_name` from the Supabase session profile
 *      (extracted via `getUserProfile()`, which respects the app's
 *      `profileExtractor` config)
 *   2. Email username (everything before `@`) from the Supabase session
 *   3. `firstName` from the offline cached profile
 *   4. Email username from the offline cached profile
 *   5. The provided `fallback` string (default: `'Explorer'`)
 *
 * @param session - The current Supabase session, or `null`.
 * @param offlineProfile - The cached offline credentials, or `null`.
 * @param fallback - Value returned when no name can be resolved.
 *                   Defaults to `'Explorer'`.
 * @returns The resolved first name string.
 *
 * @example
 * ```ts
 * // In a Svelte 5 component:
 * const firstName = $derived(
 *   resolveFirstName($authState.session, $authState.offlineProfile)
 * );
 * ```
 *
 * @example
 * ```ts
 * // With a custom fallback:
 * const greeting = resolveFirstName(session, offline, 'there');
 * // → "Hey, there!" when no name is available
 * ```
 */
export declare function resolveFirstName(session: Session | null, offlineProfile: OfflineCredentials | null, fallback?: string): string;
/**
 * Resolve the current user's UUID from auth state.
 *
 * Checks the Supabase session first, then falls back to the offline
 * credential cache. Returns an empty string when no user is authenticated.
 *
 * @param session - The current Supabase session, or `null`.
 * @param offlineProfile - The cached offline credentials, or `null`.
 * @returns The user's UUID, or `''` if unauthenticated.
 *
 * @example
 * ```ts
 * const userId = resolveUserId(data.session, data.offlineProfile);
 * if (!userId) {
 *   error = 'Not authenticated';
 *   return;
 * }
 * ```
 */
export declare function resolveUserId(session: Session | null, offlineProfile: OfflineCredentials | null): string;
/**
 * Resolve a single uppercase initial letter for avatar display.
 *
 * Uses {@link resolveFirstName} to derive the name, then returns the
 * first character uppercased. If the resolved name is empty, returns
 * the `fallback` character.
 *
 * @param session - The current Supabase session, or `null`.
 * @param offlineProfile - The cached offline credentials, or `null`.
 * @param fallback - Character to use when no initial can be derived.
 *                   Defaults to `'?'`.
 * @returns A single uppercase character.
 *
 * @example
 * ```svelte
 * <span class="avatar">
 *   {resolveAvatarInitial($authState.session, $authState.offlineProfile)}
 * </span>
 * ```
 */
export declare function resolveAvatarInitial(session: Session | null, offlineProfile: OfflineCredentials | null, fallback?: string): string;
//# sourceMappingURL=displayUtils.d.ts.map