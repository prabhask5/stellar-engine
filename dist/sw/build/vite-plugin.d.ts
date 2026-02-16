/**
 * @fileoverview Vite plugin that generates the service worker, asset manifest,
 * and (optionally) auto-generates TypeScript types and pushes schema migrations
 * to Supabase.
 *
 * The plugin hooks into three Vite/Rollup lifecycle events:
 *   - **`buildStart`** — generates `static/sw.js` from the compiled SW template.
 *     When `schema` is enabled, also runs a one-shot schema processing pass
 *     (types generation + migration push). This ensures CI builds that never
 *     run `npm run dev` still auto-migrate Supabase.
 *   - **`closeBundle`** — after Rollup finishes writing chunks, scans the
 *     immutable output directory and writes `asset-manifest.json` listing
 *     all JS/CSS files for the service worker to precache.
 *   - **`configureServer`** (dev only) — watches the schema file and
 *     auto-generates TypeScript types + auto-pushes Supabase migrations
 *     on every save, with 500ms debounce to prevent RPC spam.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { sveltekit } from '@sveltejs/kit/vite';
 * import { stellarPWA } from 'stellar-drive/vite';
 * import { defineConfig } from 'vite';
 *
 * export default defineConfig({
 *   plugins: [
 *     sveltekit(),
 *     stellarPWA({ prefix: 'myapp', name: 'My App', schema: true })
 *   ]
 * });
 * ```
 *
 * @see {@link stellarPWA} for the main plugin factory
 * @see {@link SWConfig} for configuration options
 * @see {@link SchemaConfig} for schema auto-generation options
 */
/**
 * Schema auto-generation configuration.
 *
 * Controls how the Vite plugin watches the schema file, generates TypeScript
 * types, and optionally pushes migrations to Supabase during development.
 *
 * Pass `true` as shorthand for `{}` (all defaults).
 *
 * @example
 * // All defaults:
 * stellarPWA({ prefix: 'myapp', name: 'My App', schema: true })
 *
 * // Custom paths:
 * stellarPWA({
 *   prefix: 'myapp',
 *   name: 'My App',
 *   schema: {
 *     path: 'src/lib/schema.ts',
 *     typesOutput: 'src/lib/types.generated.ts',
 *     autoMigrate: true,
 *   }
 * })
 */
export interface SchemaConfig {
    /**
     * Path to the schema file (relative to project root).
     * @default 'src/lib/schema.ts'
     */
    path?: string;
    /**
     * Path where generated TypeScript types are written (relative to project root).
     * @default 'src/lib/types.generated.ts'
     */
    typesOutput?: string;
    /**
     * Whether to auto-push migration SQL to Supabase via RPC.
     * When `true`, requires `PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
     * in the environment. Falls back to a warning if env vars are missing.
     * @default true
     */
    autoMigrate?: boolean;
}
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
    /**
     * Enable schema-driven auto-generation of TypeScript types and Supabase
     * migration SQL.
     *
     * Pass `true` for all defaults, or a {@link SchemaConfig} object for
     * full control over paths and behavior.
     *
     * When enabled, the plugin:
     *   1. On every build (dev or production): generates types + pushes migrations
     *   2. During dev: also watches for changes with debounced re-processing
     *
     * @default undefined (disabled)
     */
    schema?: boolean | SchemaConfig;
}
/**
 * Vite plugin factory that generates `static/sw.js`, `asset-manifest.json`,
 * and optionally auto-generates types + auto-pushes schema migrations.
 *
 * **`buildStart` hook (dev + production builds):**
 *   - Generates `static/sw.js` from the compiled SW template.
 *   - When `schema` is enabled: loads the schema file via esbuild, generates
 *     TypeScript types, diffs against the snapshot, and pushes migration SQL
 *     to Supabase. This ensures CI/CD builds that skip `npm run dev` still
 *     auto-migrate the database.
 *
 * **`closeBundle` hook:**
 *   - Scans SvelteKit's immutable output directory for JS and CSS files.
 *   - Writes `asset-manifest.json` to both `static/` and the build output
 *     directory so the service worker can precache all app chunks.
 *
 * **`configureServer` hook (dev only, when `schema` is enabled):**
 *   - On server start, processes the schema file once via Vite's SSR loader.
 *   - Watches the schema file for changes with 500ms debounce.
 *   - Each change re-generates types and pushes migration SQL.
 *
 * @param config - The {@link SWConfig} with `prefix`, `name`, and optional `schema`.
 * @returns A Vite plugin object with `name`, `buildStart`, `closeBundle`, and
 *          optionally `configureServer` hooks.
 *
 * @example
 * ```ts
 * stellarPWA({ prefix: 'myapp', name: 'My App', schema: true })
 * ```
 */
export declare function stellarPWA(config: SWConfig): {
    name: string;
    buildStart(): Promise<void>;
    closeBundle(): void;
    configureServer(server: {
        ssrLoadModule: (id: string) => Promise<Record<string, unknown>>;
        watcher: {
            on: (event: string, cb: (path: string) => void) => void;
        };
    }): void;
};
//# sourceMappingURL=vite-plugin.d.ts.map