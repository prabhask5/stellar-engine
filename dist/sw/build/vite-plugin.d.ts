/**
 * @fileoverview Vite plugin that generates the service worker and asset manifest
 * at build time. Projects import this instead of maintaining their own SW logic.
 *
 * The plugin hooks into two Vite/Rollup lifecycle events:
 *   - **`buildStart`** — reads the compiled SW template from the stellar-engine
 *     package, patches in app-specific tokens, and writes `static/sw.js`.
 *   - **`closeBundle`** — after Rollup finishes writing chunks, scans the
 *     immutable output directory and writes `asset-manifest.json` listing
 *     all JS/CSS files for the service worker to precache.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import { stellarPWA } from '@prabhask5/stellar-engine/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({
 *   plugins: [
 *     sveltekit(),
 *     stellarPWA({ prefix: 'myapp', name: 'My App' })
 *   ]
 * });
 * ```
 *
 * @see {@link stellarPWA} for the main plugin factory
 * @see {@link SWConfig} for configuration options
 */
/**
 * Configuration options for the stellarPWA Vite plugin.
 */
export interface SWConfig {
    /**
     * Cache name prefix used in the service worker (e.g., `'myapp'`).
     * Becomes part of cache names like `myapp-assets-v1` and `myapp-shell-<version>`.
     */
    prefix: string;
    /**
     * Human-readable application name. Used in the offline fallback page title
     * and any other user-facing SW output.
     */
    name: string;
}
/**
 * Vite plugin factory that generates `static/sw.js` and `asset-manifest.json`
 * at build time.
 *
 * **`buildStart` hook:**
 *   - Reads the compiled SW source from stellar-engine's `dist/sw/sw.js`.
 *   - Replaces placeholder tokens (`__SW_VERSION__`, `__SW_PREFIX__`, `__SW_NAME__`)
 *     with app-specific values and a unique version stamp (base-36 timestamp).
 *   - Strips the `export {};` that TypeScript adds (SW runs as a classic script).
 *   - Writes the final `static/sw.js`.
 *
 * **`closeBundle` hook:**
 *   - Scans SvelteKit's immutable output directory for JS and CSS files.
 *   - Writes `asset-manifest.json` to both `static/` and the build output
 *     directory so the service worker can precache all app chunks.
 *
 * @param config - The {@link SWConfig} with `prefix` and `name` values.
 * @returns A Vite plugin object with `name`, `buildStart`, and `closeBundle` hooks.
 *
 * @example
 * ```ts
 * stellarPWA({ prefix: 'myapp', name: 'My App' })
 * ```
 */
export declare function stellarPWA(config: SWConfig): {
    name: string;
    buildStart(): void;
    closeBundle(): void;
};
//# sourceMappingURL=vite-plugin.d.ts.map