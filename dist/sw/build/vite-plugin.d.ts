/**
 * @fileoverview Vite plugin that generates the service worker, asset manifest,
 * and (optionally) auto-generates TypeScript types and pushes the schema to
 * Supabase.
 *
 * The plugin hooks into three Vite/Rollup lifecycle events:
 *   - **`buildStart`** — generates `static/sw.js` from the compiled SW template.
 *     When `schema` is enabled, also generates TypeScript types and pushes the
 *     full idempotent schema SQL to Supabase via direct Postgres connection.
 *   - **`closeBundle`** — after Rollup finishes writing chunks, scans the
 *     immutable output directory and writes `asset-manifest.json` listing
 *     all JS/CSS files for the service worker to precache.
 *   - **`configureServer`** (dev only) — watches the schema file and
 *     auto-generates TypeScript types + pushes schema to Supabase
 *     on every save, with 500ms debounce.
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
 * types, and optionally pushes schema SQL to Supabase.
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
     * Whether to auto-push schema SQL to Supabase via direct Postgres connection.
     * When `true`, requires `DATABASE_URL` in `.env` and the `postgres`
     * npm package installed. Falls back to a warning if either is missing.
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
     * schema SQL.
     *
     * Pass `true` for all defaults, or a {@link SchemaConfig} object for
     * full control over paths and behavior.
     *
     * When enabled, the plugin:
     *   1. On every build (dev or production): generates types + pushes schema SQL
     *   2. During dev: also watches for changes with debounced re-processing
     *
     * @default undefined (disabled)
     */
    schema?: boolean | SchemaConfig;
}
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