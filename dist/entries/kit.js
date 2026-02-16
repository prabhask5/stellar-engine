/**
 * @fileoverview Kit subpath barrel — `stellar-drive/kit`
 *
 * SvelteKit-specific helpers for server routes, layout load functions, email
 * confirmation flows, service worker lifecycle management, and auth hydration.
 * These utilities bridge the stellar-drive core with SvelteKit's routing and
 * server conventions.
 *
 * This entry point is intended for use **only** within SvelteKit projects and
 * should not be imported from plain Svelte or non-Kit environments.
 */
// =============================================================================
//  Server Helpers — API Routes & Deployment
// =============================================================================
// Utilities for SvelteKit server routes (`+server.ts`):
// - `getServerConfig` — reads server-side environment configuration.
// - `deployToVercel` — triggers a Vercel deployment from a server action.
// - `createValidateHandler` — factory for a SvelteKit request handler that
//   validates Supabase credentials during initial app setup.
export { getServerConfig, deployToVercel, createValidateHandler } from '../kit/server.js';
// =============================================================================
//  Layout Load Functions — Route Data Resolution
// =============================================================================
// SvelteKit `load` function helpers for `+layout.ts` / `+layout.server.ts`:
// - `resolveRootLayout` — top-level layout loader; initializes the engine,
//   resolves auth state, and provides data to the root layout.
// - `resolveProtectedLayout` — guards protected routes; redirects unauthenticated
//   users to the login page.
// - `resolveSetupAccess` — checks whether the app has been set up and redirects
//   to the setup wizard if not.
export { resolveRootLayout, resolveProtectedLayout, resolveSetupAccess } from '../kit/loads.js';
// =============================================================================
//  Email Confirmation — Auth Callback Handling
// =============================================================================
// Handles the email confirmation callback route (e.g. `/auth/confirm`):
// - `handleEmailConfirmation` — processes the token from the confirmation URL,
//   exchanges it for a session, and returns the result.
// - `broadcastAuthConfirmed` — notifies other open tabs/windows that auth has
//   been confirmed (via BroadcastChannel).
export { handleEmailConfirmation, broadcastAuthConfirmed } from '../kit/confirm.js';
// =============================================================================
//  Service Worker Lifecycle — PWA Update Management
// =============================================================================
// Utilities for managing service worker updates in PWA deployments:
// - `pollForNewServiceWorker` — periodically checks for a new SW version.
// - `handleSwUpdate` — applies a pending SW update and reloads the page.
// - `monitorSwLifecycle` — attaches lifecycle event listeners for install,
//   activate, and controlling change events.
export { pollForNewServiceWorker, handleSwUpdate, monitorSwLifecycle } from '../kit/sw.js';
// =============================================================================
//  Auth Hydration — Client-Side Auth Bootstrap
// =============================================================================
// Hydrates the client-side auth state from server-provided layout data,
// populating the auth stores without an extra network round-trip.
// - `hydrateAuthState` — accepts serialized auth data from a layout load and
//   pushes it into the client-side auth stores.
export { hydrateAuthState } from '../kit/auth.js';
//# sourceMappingURL=kit.js.map