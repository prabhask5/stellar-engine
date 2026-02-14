/**
 * @fileoverview SvelteKit load function helpers.
 *
 * Extracts orchestration logic from layout/page load functions so
 * scaffolded routes can be thin wrappers around these helpers.
 */
import type { AuthStateResult } from '../auth/resolveAuthState.js';
/** Data returned by `resolveRootLayout`. */
export interface RootLayoutData extends AuthStateResult {
    singleUserSetUp?: boolean;
}
/** Data returned by `resolveProtectedLayout`. */
export interface ProtectedLayoutData {
    session: AuthStateResult['session'];
    authMode: AuthStateResult['authMode'];
    offlineProfile: AuthStateResult['offlineProfile'];
}
/** Data returned by `resolveSetupAccess`. */
export interface SetupAccessData {
    isFirstSetup: boolean;
}
/**
 * Orchestrates the root layout load sequence:
 *  1. Calls the app's `initEngine` function (for database schema setup)
 *  2. Runs `initConfig()` — redirects to `/setup` if unconfigured
 *  3. Resolves auth state
 *  4. Starts sync engine if authenticated
 *
 * @param initEngineFn - The app's `initEngine()` call (executed before config init).
 *                       Should already have been called at module scope in the browser.
 * @param url          - The current page URL (for setup redirect check).
 * @returns Layout data with session, auth mode, offline profile, and setup status.
 */
export declare function resolveRootLayout(url: {
    pathname: string;
}, _initEngineFn?: () => void): Promise<RootLayoutData>;
/**
 * Auth guard for protected routes. Resolves auth state and returns
 * redirect info if unauthenticated.
 *
 * @param url - The current page URL (for building redirect parameter).
 * @returns Auth data, or `null` if a redirect to `/login` is needed.
 *          When null, caller should `throw redirect(302, loginUrl)`.
 */
export declare function resolveProtectedLayout(url: {
    pathname: string;
    search: string;
}): Promise<{
    data: ProtectedLayoutData;
    redirectUrl: string | null;
}>;
/**
 * Setup page guard: if unconfigured → public access; if configured → admin-only.
 *
 * @returns `{ isFirstSetup }` with access info, or `null` with a redirectUrl
 *          if the user should be redirected away.
 */
export declare function resolveSetupAccess(): Promise<{
    data: SetupAccessData;
    redirectUrl: string | null;
}>;
//# sourceMappingURL=loads.d.ts.map