/**
 * @fileoverview Vite subpath barrel — `stellar-drive/vite`
 *
 * Provides the Vite plugin for building and configuring the service worker
 * required by stellar-drive's PWA functionality. This entry point is intended
 * for use in `vite.config.ts` only — it runs at build time, not in the browser.
 *
 * Usage:
 * ```ts
 * // vite.config.ts
 * import { stellarPWA } from 'stellar-drive/vite';
 *
 * export default defineConfig({
 *   plugins: [stellarPWA({ /* SWConfig options *\/ })]
 * });
 * ```
 */
export { stellarPWA } from '../sw/build/vite-plugin.js';
export type { SWConfig, SchemaConfig } from '../sw/build/vite-plugin.js';
//# sourceMappingURL=vite.d.ts.map