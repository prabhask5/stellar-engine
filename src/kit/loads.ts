/**
 * @fileoverview SvelteKit load function helpers.
 *
 * Extracts orchestration logic from layout/page load functions so
 * scaffolded routes can be thin wrappers around these helpers.
 */

import { initConfig, getConfig } from '../runtime/runtimeConfig.js';
import { resolveAuthState } from '../auth/resolveAuthState.js';
import { startSyncEngine } from '../engine.js';
import { getValidSession } from '../supabase/auth.js';
import { isAdmin } from '../auth/admin.js';
import type { AuthStateResult } from '../auth/resolveAuthState.js';

// =============================================================================
//  TYPES
// =============================================================================

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

// =============================================================================
//  ROOT LAYOUT
// =============================================================================

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
export async function resolveRootLayout(
  url: { pathname: string },
  _initEngineFn?: () => void
): Promise<RootLayoutData> {
  const config = await initConfig();

  // No config yet → first-time user, redirect to setup wizard
  if (!config && url.pathname !== '/setup') {
    return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
  }

  // Still on setup page with no config — return blank state
  if (!config) {
    return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
  }

  // Resolve auth — determines Supabase / offline / none
  const result = await resolveAuthState();

  // Start sync engine only when the user is actually authenticated
  if (result.authMode !== 'none') {
    await startSyncEngine();
  }

  return result;
}

// =============================================================================
//  PROTECTED LAYOUT
// =============================================================================

/**
 * Auth guard for protected routes. Resolves auth state and returns
 * redirect info if unauthenticated.
 *
 * @param url - The current page URL (for building redirect parameter).
 * @returns Auth data, or `null` if a redirect to `/login` is needed.
 *          When null, caller should `throw redirect(302, loginUrl)`.
 */
export async function resolveProtectedLayout(url: {
  pathname: string;
  search: string;
}): Promise<{ data: ProtectedLayoutData; redirectUrl: string | null }> {
  const result = await resolveAuthState();

  if (result.authMode === 'none') {
    const returnUrl = url.pathname + url.search;
    const loginUrl =
      returnUrl && returnUrl !== '/'
        ? `/login?redirect=${encodeURIComponent(returnUrl)}`
        : '/login';
    return { data: result, redirectUrl: loginUrl };
  }

  return { data: result, redirectUrl: null };
}

// =============================================================================
//  SETUP ACCESS
// =============================================================================

/**
 * Setup page guard: if unconfigured → public access; if configured → admin-only.
 *
 * @returns `{ isFirstSetup }` with access info, or `null` with a redirectUrl
 *          if the user should be redirected away.
 */
export async function resolveSetupAccess(): Promise<{
  data: SetupAccessData;
  redirectUrl: string | null;
}> {
  if (!getConfig()) {
    return { data: { isFirstSetup: true }, redirectUrl: null };
  }

  const session = await getValidSession();

  if (!session?.user) {
    return { data: { isFirstSetup: false }, redirectUrl: '/login' };
  }

  if (!isAdmin(session.user)) {
    return { data: { isFirstSetup: false }, redirectUrl: '/' };
  }

  return { data: { isFirstSetup: false }, redirectUrl: null };
}
