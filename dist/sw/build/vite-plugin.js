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
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
// =============================================================================
//                            FILESYSTEM HELPERS
// =============================================================================
/**
 * Recursively collects every file path under `dir`.
 *
 * Used after the build to enumerate all immutable assets so they can be written
 * into the asset manifest consumed by the service worker.
 *
 * @param dir - The root directory to scan.
 * @param files - Accumulator array (used internally for recursion).
 * @returns A flat array of absolute file paths found under `dir`.
 *
 * @example
 * ```ts
 * const allFiles = getAllFiles('/path/to/_app/immutable');
 * // => ['/path/to/_app/immutable/chunks/foo.abc123.js', ...]
 * ```
 */
function getAllFiles(dir, files = []) {
    if (!existsSync(dir))
        return files;
    const entries = readdirSync(dir);
    for (const entry of entries) {
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
            getAllFiles(fullPath, files);
        }
        else {
            files.push(fullPath);
        }
    }
    return files;
}
/**
 * Locates the compiled SW source (`dist/sw/sw.js`) within the installed package.
 *
 * Uses two resolution strategies:
 *   1. **Relative resolution** — resolves relative to this file's compiled
 *      location in `dist/sw/build/vite-plugin.js`, navigating up to `dist/sw/sw.js`.
 *      Works for both installed packages and locally-linked development.
 *   2. **`createRequire` fallback** — uses Node's module resolution to find
 *      the package root via `package.json`, then appends the known dist path.
 *
 * @returns The absolute path to the compiled `sw.js` source file.
 *
 * @throws {Error} If the SW source cannot be found via either strategy
 *         (will throw from the `readFileSync` call in the consumer).
 */
function findSwSource() {
    /* Resolve relative to this file's location in dist/sw/build/vite-plugin.js */
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const swPath = join(thisDir, '..', 'sw.js');
    if (existsSync(swPath))
        return swPath;
    /* Fallback: use createRequire to resolve from the package */
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(require.resolve('@prabhask5/stellar-engine/package.json'));
    return join(pkgDir, 'dist', 'sw', 'sw.js');
}
// =============================================================================
//                           VITE PLUGIN
// =============================================================================
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
export function stellarPWA(config) {
    return {
        name: 'stellar-pwa',
        /* ── buildStart — generate sw.js from compiled source ────────── */
        buildStart() {
            /* Generate a unique version stamp using base-36 timestamp */
            const version = Date.now().toString(36);
            const swSourcePath = findSwSource();
            let swContent = readFileSync(swSourcePath, 'utf-8');
            /* Replace placeholder tokens with app-specific values */
            swContent = swContent
                .replace(/__SW_VERSION__/g, version)
                .replace(/__SW_PREFIX__/g, config.prefix)
                .replace(/__SW_NAME__/g, config.name);
            /* Strip the `export {};` that tsc adds (SW runs as a script, not a module) */
            swContent = swContent.replace(/^export\s*\{\s*\}\s*;\s*$/m, '');
            /* Ensure static/ directory exists */
            const staticDir = resolve('static');
            if (!existsSync(staticDir)) {
                mkdirSync(staticDir, { recursive: true });
            }
            const swPath = resolve('static/sw.js');
            writeFileSync(swPath, swContent);
            console.log(`[stellar-pwa] Generated sw.js (version: ${version})`);
        },
        /* ── closeBundle — generate asset manifest ───────────────────── */
        closeBundle() {
            const buildDir = resolve('.svelte-kit/output/client/_app/immutable');
            if (!existsSync(buildDir)) {
                console.warn('[stellar-pwa] Build directory not found, skipping manifest generation');
                return;
            }
            try {
                const allFiles = getAllFiles(buildDir);
                /**
                 * Only JS and CSS are worth precaching — images/fonts are better
                 * served on-demand via the SW's cache-first strategy, keeping the
                 * manifest small and the initial precache fast.
                 */
                const assets = allFiles
                    .map((f) => f.replace(resolve('.svelte-kit/output/client'), ''))
                    .filter((f) => f.endsWith('.js') || f.endsWith('.css'));
                const manifest = {
                    version: Date.now().toString(36),
                    assets
                };
                const manifestContent = JSON.stringify(manifest, null, 2);
                /* Write to `static/` — available to the dev server and future builds */
                writeFileSync(resolve('static/asset-manifest.json'), manifestContent);
                /* Write to build output — static files are already copied before
                 * `closeBundle` runs, so the manifest must also land in the output
                 * directory for it to be served from the production build. */
                const buildOutputPath = resolve('.svelte-kit/output/client/asset-manifest.json');
                writeFileSync(buildOutputPath, manifestContent);
                console.log(`[stellar-pwa] Generated asset manifest with ${assets.length} files`);
            }
            catch (e) {
                console.warn('[stellar-pwa] Could not generate asset manifest:', e);
            }
        }
    };
}
//# sourceMappingURL=vite-plugin.js.map