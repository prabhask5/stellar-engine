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
import { getUserProfile } from '../supabase/auth';
// =============================================================================
// PUBLIC API
// =============================================================================
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
export function resolveFirstName(session, offlineProfile, fallback = 'Explorer') {
    /* ── Online: check session profile fields ── */
    if (session?.user) {
        const profile = getUserProfile(session.user);
        if (profile.firstName || profile.first_name) {
            return (profile.firstName || profile.first_name);
        }
        if (session.user.email) {
            return session.user.email.split('@')[0];
        }
    }
    /* ── Offline: check cached credential profile ── */
    if (offlineProfile?.profile?.firstName) {
        return offlineProfile.profile.firstName;
    }
    if (offlineProfile?.email) {
        return offlineProfile.email.split('@')[0];
    }
    return fallback;
}
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
export function resolveUserId(session, offlineProfile) {
    if (session?.user?.id) {
        return session.user.id;
    }
    if (offlineProfile?.userId) {
        return offlineProfile.userId;
    }
    return '';
}
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
export function resolveAvatarInitial(session, offlineProfile, fallback = '?') {
    const name = resolveFirstName(session, offlineProfile, '');
    if (name) {
        return name.charAt(0).toUpperCase();
    }
    return fallback;
}
//# sourceMappingURL=displayUtils.js.map