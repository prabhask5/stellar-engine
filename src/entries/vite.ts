/**
 * @fileoverview Vite subpath barrel — `@prabhask5/stellar-engine/vite`
 *
 * Provides the Vite plugin for building and configuring the service worker
 * required by stellar-engine's PWA functionality. This entry point is intended
 * for use in `vite.config.ts` only — it runs at build time, not in the browser.
 *
 * Usage:
 * ```ts
 * // vite.config.ts
 * import { stellarPWA } from '@prabhask5/stellar-engine/vite';
 *
 * export default defineConfig({
 *   plugins: [stellarPWA({ /* SWConfig options *\/ })]
 * });
 * ```
 */

// =============================================================================
//  Stellar PWA Vite Plugin
// =============================================================================
// - `stellarPWA` — Vite plugin factory that generates and injects a service
//   worker with precaching, runtime caching strategies, and offline support.
// - `SWConfig` — configuration interface for customizing cache strategies,
//   precache globs, network-first vs cache-first routes, and SW behaviour.

export { stellarPWA } from '../sw/build/vite-plugin.js';
export type { SWConfig } from '../sw/build/vite-plugin.js';
