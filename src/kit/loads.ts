/**
 * @fileoverview SvelteKit load function helpers.
 *
 * This module extracts orchestration logic from layout and page load functions
 * so that scaffolded routes can be thin wrappers around these helpers. Each
 * exported function encapsulates a specific load concern:
 *
 *   - `resolveRootLayout`      — full app initialization sequence (config,
 *                                 auth, sync engine startup)
 *   - `resolveProtectedLayout` — auth guard for protected route groups
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

import { initConfig, getConfig } from '../runtime/runtimeConfig.js';
import { resolveAuthState } from '../auth/resolveAuthState.js';
import { startSyncEngine } from '../engine.js';
import { getValidSession } from '../supabase/auth.js';
import { isDemoMode, seedDemoData } from '../demo.js';
import type { AuthStateResult } from '../auth/resolveAuthState.js';

// =============================================================================
//  TYPES
// =============================================================================

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
 * Data returned by `resolveProtectedLayout`.
 *
 * A narrowed subset of auth state fields needed by protected route groups
 * to render authenticated content.
 */
export interface ProtectedLayoutData {
  /** The Supabase session, or `null` if using offline/no auth. */
  session: AuthStateResult['session'];

  /** The active authentication mode discriminator. */
  authMode: AuthStateResult['authMode'];

  /** The offline profile credentials, if in offline mode. */
  offlineProfile: AuthStateResult['offlineProfile'];
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

// =============================================================================
//  ROOT LAYOUT
// =============================================================================

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
export async function resolveRootLayout(
  url: { pathname: string },
  _initEngineFn?: () => void
): Promise<RootLayoutData> {
  const config = await initConfig();

  /* No config yet — this is a first-time user. Return blank state so the
     layout can detect `singleUserSetUp === false` and redirect to /setup.
     We skip the redirect if already on /setup to avoid an infinite loop.
     Exception: demo mode works without runtime config (no Supabase needed). */
  if (!config && !isDemoMode() && url.pathname !== '/setup') {
    return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
  }

  /* Still on setup page with no config — return blank state without
     redirecting, allowing the setup wizard to render normally. */
  if (!config && !isDemoMode()) {
    return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
  }

  /* Resolve auth — determines Supabase / offline / demo / none based on the
     stored runtime config and available credentials. */
  const result = await resolveAuthState();

  /* Demo mode: seed mock data (idempotent per page load) and skip sync. */
  if (result.authMode === 'demo') {
    await seedDemoData();
    return result;
  }

  /* Start sync engine only when the user is actually authenticated;
     the engine requires auth context to connect to the remote database
     or initialize the local-first storage layer. */
  if (result.authMode !== 'none') {
    await startSyncEngine();
  }

  return result;
}

// =============================================================================
//  PROTECTED LAYOUT
// =============================================================================

/**
 * Auth guard for protected routes. Resolves auth state and, if the user
 * is unauthenticated, computes a redirect URL to the login page with a
 * `redirect` query parameter so the user can be sent back after login.
 *
 * The caller is responsible for performing the actual redirect (typically
 * via SvelteKit's `throw redirect(302, redirectUrl)`), since this helper
 * is framework-agnostic in its return value.
 *
 * @param url - The current page URL object with `pathname` and `search`
 *              properties, used to construct the post-login return URL.
 *
 * @returns An object containing:
 *   - `data` — the auth state payload for the layout
 *   - `redirectUrl` — a login URL string if unauthenticated, or `null`
 *     if the user is authenticated and should proceed normally.
 *     When non-null, the caller should `throw redirect(302, redirectUrl)`.
 *
 * @example
 * ```ts
 * // /(protected)/+layout.ts
 * import { redirect } from '@sveltejs/kit';
 * import { resolveProtectedLayout } from 'stellar-drive/kit/loads';
 *
 * export async function load({ url }) {
 *   const { data, redirectUrl } = await resolveProtectedLayout(url);
 *   if (redirectUrl) throw redirect(302, redirectUrl);
 *   return data;
 * }
 * ```
 *
 * @see {@link ProtectedLayoutData} for the return data shape
 * @see {@link resolveAuthState} for the underlying auth resolution
 */
export async function resolveProtectedLayout(url: {
  pathname: string;
  search: string;
}): Promise<{ data: ProtectedLayoutData; redirectUrl: string | null }> {
  const result = await resolveAuthState();

  if (result.authMode === 'none') {
    /* Build a return URL so the login page can redirect back after
       successful authentication. Skip the redirect param if the user
       is at the root — there's no meaningful "return to" destination. */
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
export async function resolveSetupAccess(): Promise<{
  data: SetupAccessData;
  redirectUrl: string | null;
}> {
  /* Demo mode — grant access without auth checks. */
  if (isDemoMode()) {
    return { data: { isFirstSetup: false }, redirectUrl: null };
  }

  /* No config exists — this is the first-time setup, grant public access
     so the wizard can run without requiring authentication. */
  if (!getConfig()) {
    return { data: { isFirstSetup: true }, redirectUrl: null };
  }

  /* Config exists — this is a reconfiguration. Require a valid session. */
  const session = await getValidSession();

  if (!session?.user) {
    /* No session — redirect to login so the user can authenticate first. */
    return { data: { isFirstSetup: false }, redirectUrl: '/login' };
  }

  return { data: { isFirstSetup: false }, redirectUrl: null };
}
