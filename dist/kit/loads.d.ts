/**
 * @fileoverview SvelteKit load function helpers.
 *
 * This module extracts orchestration logic from layout and page load functions
 * so that scaffolded routes can be thin wrappers around these helpers. Each
 * exported function encapsulates a specific load concern:
 *
 *   - `resolveRootLayout`      — full app initialization sequence (config,
 *                                 auth, sync engine startup)
 *   - `resolveSetupAccess`     — access control for the `/setup` wizard
 *
 * By centralizing this logic in the engine, consuming apps avoid duplicating
 * the initialization ordering and redirect logic across their route tree.
 *
 * @module kit/loads
 *
 * @example
 * ```ts
 * // In +layout.ts (root)
 * import { resolveRootLayout } from 'stellar-drive/kit/loads';
 * export async function load({ url }) {
 *   return resolveRootLayout(url);
 * }
 * ```
 *
 * @see {@link initConfig} for runtime configuration bootstrap
 * @see {@link resolveAuthState} for auth mode determination
 * @see {@link startSyncEngine} for offline-first sync initialization
 */
import type { AuthStateResult } from '../auth/resolveAuthState.js';
/**
 * Data returned by `resolveRootLayout`.
 *
 * Extends the base auth state with an optional `singleUserSetUp` flag
 * indicating whether the app has completed initial configuration.
 */
export interface RootLayoutData extends AuthStateResult {
    /**
     * Indicates whether the single-user setup wizard has been completed.
     * When `false` and no config exists, the app should redirect to `/setup`.
     */
    singleUserSetUp?: boolean;
}
/**
 * Data returned by `resolveSetupAccess`.
 *
 * Tells the setup page whether this is a first-time configuration
 * (public access) or a reconfiguration (authenticated users only).
 */
export interface SetupAccessData {
    /**
     * `true` when no configuration exists yet — the setup page should
     * render the full first-time wizard without requiring authentication.
     */
    isFirstSetup: boolean;
}
/**
 * Orchestrates the root layout load sequence, which is the critical
 * initialization path that runs on every page load:
 *
 *   1. Calls the app's `initEngine` function (for database schema setup)
 *   2. Runs `initConfig()` — loads runtime config from storage; if no
 *      config exists and the user is not already on `/setup`, returns a
 *      blank state so the layout can redirect to the setup wizard
 *   3. Resolves auth state — determines whether the user is authenticated
 *      via Supabase, offline credentials, or not at all
 *   4. Starts the sync engine if the user is authenticated, enabling
 *      offline-first data synchronization
 *
 * @param url          - The current page URL object. Only `pathname` is
 *                       inspected, to detect whether the user is already
 *                       on the `/setup` page.
 * @param _initEngineFn - (Optional) The app's `initEngine()` call, executed
 *                        before config init. Typically already called at
 *                        module scope in the browser; this parameter exists
 *                        for explicit invocation in SSR contexts.
 *
 * @returns Layout data containing session, auth mode, offline profile,
 *          and setup status. The consuming layout uses these to hydrate
 *          the auth store and conditionally render the app shell.
 *
 * @example
 * ```ts
 * // +layout.ts
 * export async function load({ url }) {
 *   return resolveRootLayout(url);
 * }
 * ```
 *
 * @see {@link RootLayoutData} for the return type shape
 * @see {@link initConfig} for config bootstrapping details
 * @see {@link resolveAuthState} for auth resolution logic
 */
export declare function resolveRootLayout(url: {
    pathname: string;
}, _initEngineFn?: () => void): Promise<RootLayoutData>;
/**
 * Setup page guard implementing a two-tier access model:
 *
 *   - **Unconfigured app** (first-time setup): public access, no auth required.
 *     Returns `{ isFirstSetup: true }`.
 *   - **Configured app** (reconfiguration): any authenticated user may access.
 *     Unauthenticated users are redirected to `/login`.
 *
 * @returns An object containing:
 *   - `data` — setup access info (`{ isFirstSetup }`)
 *   - `redirectUrl` — a redirect path if the user lacks access, or `null`
 *     if access is granted. When non-null, the caller should
 *     `throw redirect(302, redirectUrl)`.
 *
 * @example
 * ```ts
 * // /setup/+page.ts
 * import { redirect } from '@sveltejs/kit';
 * import { resolveSetupAccess } from 'stellar-drive/kit/loads';
 *
 * export async function load() {
 *   const { data, redirectUrl } = await resolveSetupAccess();
 *   if (redirectUrl) throw redirect(302, redirectUrl);
 *   return data;
 * }
 * ```
 *
 * @see {@link SetupAccessData} for the return data shape
 * @see {@link getConfig} for checking whether config exists
 */
export declare function resolveSetupAccess(): Promise<{
    data: SetupAccessData;
    redirectUrl: string | null;
}>;
//# sourceMappingURL=loads.d.ts.map