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

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  unlinkSync
} from 'fs';
import { resolve, join, dirname, relative } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

// =============================================================================
//                              TYPES
// =============================================================================

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

// =============================================================================
//                            CONSTANTS
// =============================================================================

/**
 * Debounce delay (ms) for schema change processing.
 *
 * Prevents Supabase RPC spam when the user saves rapidly (e.g., holding
 * Ctrl+S or using auto-save). Only the last save within the window triggers
 * processing.
 */
const SCHEMA_DEBOUNCE_MS = 500;

/**
 * Directory name for storing schema snapshots (relative to project root).
 * The snapshot file tracks the last-known schema state for migration diffing.
 */
const SNAPSHOT_DIR = '.stellar';

/**
 * Filename for the schema snapshot within {@link SNAPSHOT_DIR}.
 */
const SNAPSHOT_FILE = 'schema-snapshot.json';

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
function getAllFiles(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, files);
    } else {
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
function findSwSource(): string {
  /* Resolve relative to this file's location in dist/sw/build/vite-plugin.js */
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const swPath = join(thisDir, '..', 'sw.js');
  if (existsSync(swPath)) return swPath;

  /* Fallback: use createRequire to resolve from the package */
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve('stellar-drive/package.json'));
  return join(pkgDir, 'dist', 'sw', 'sw.js');
}

// =============================================================================
//                          SCHEMA HELPERS
// =============================================================================

/**
 * Resolve the boolean-or-object `schema` config into a fully-resolved
 * options object with all defaults applied.
 *
 * @param schema - The raw schema config from {@link SWConfig}.
 * @returns A fully-resolved schema options object.
 */
function resolveSchemaOpts(schema: boolean | SchemaConfig): Required<SchemaConfig> {
  if (typeof schema === 'object') {
    return {
      path: schema.path || 'src/lib/schema.ts',
      typesOutput: schema.typesOutput || 'src/lib/types.generated.ts',
      autoMigrate: schema.autoMigrate !== false
    };
  }
  return {
    path: 'src/lib/schema.ts',
    typesOutput: 'src/lib/types.generated.ts',
    autoMigrate: true
  };
}

/**
 * Strip non-serializable values (functions) from a schema object before
 * saving it as a JSON snapshot.
 *
 * Function values (e.g., `onRemoteChange` callbacks) cannot be serialized
 * and would cause JSON.stringify to drop them silently. This function
 * recursively strips them to produce a clean, deterministic snapshot.
 *
 * @param obj - The schema object to clean.
 * @returns A new object with all function values removed.
 */
function stripFunctions(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'function') continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = stripFunctions(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Load the schema snapshot from disk.
 *
 * @param projectRoot - The project root directory.
 * @returns The parsed snapshot, or `null` if no snapshot exists.
 */
function loadSnapshot(projectRoot: string): Record<string, unknown> | null {
  const snapshotPath = join(projectRoot, SNAPSHOT_DIR, SNAPSHOT_FILE);
  if (!existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save a schema snapshot to disk.
 *
 * Creates the `.stellar/` directory if it doesn't exist.
 *
 * @param projectRoot - The project root directory.
 * @param schema - The schema object to snapshot (functions will be stripped).
 */
function saveSnapshot(projectRoot: string, schema: Record<string, unknown>): void {
  const dir = join(projectRoot, SNAPSHOT_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const cleaned = stripFunctions(schema);
  writeFileSync(join(dir, SNAPSHOT_FILE), JSON.stringify(cleaned, null, 2) + '\n', 'utf-8');
}

/**
 * Load a TypeScript schema file by transpiling it with esbuild and
 * dynamically importing the result.
 *
 * Used during `buildStart` where Vite's `ssrLoadModule` is not available.
 * Esbuild is always present in the consumer's `node_modules` because Vite
 * depends on it. The schema file typically only contains type-only imports
 * (which esbuild strips) and a plain object export, so bundling is not needed.
 *
 * @param schemaPath - Absolute path to the `.ts` schema file.
 * @returns The exported `schema` object, or `null` if not found.
 */
async function loadSchemaFromFile(schemaPath: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(schemaPath)) return null;

  const source = readFileSync(schemaPath, 'utf-8');
  const { transform } = await import('esbuild');
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });

  /* Write transpiled JS to a temp file for dynamic import.
   * Use a unique name to avoid Node's module cache returning stale data. */
  const tmpPath = join(dirname(schemaPath), `.schema.tmp.${Date.now()}.mjs`);
  writeFileSync(tmpPath, code, 'utf-8');

  try {
    const mod = await import(pathToFileURL(tmpPath).href);
    return (mod.schema as Record<string, unknown>) || null;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* Best-effort cleanup — temp file in src/lib/ is harmless if left behind. */
    }
  }
}

/**
 * Core schema processing: generate types, diff against snapshot, push migration.
 *
 * Shared by both `buildStart` (one-shot during builds) and `configureServer`
 * (on each schema file change during dev). The only difference is how the
 * schema module is loaded — the caller provides the loaded schema object.
 *
 * @param schema - The loaded schema object (from `ssrLoadModule` or `loadSchemaFromFile`).
 * @param appName - The application name (for SQL generation headers).
 * @param schemaOpts - Resolved schema options (paths, autoMigrate flag).
 * @param projectRoot - Absolute path to the project root.
 */
async function processLoadedSchema(
  schema: Record<string, unknown>,
  appName: string,
  schemaOpts: Required<SchemaConfig>,
  projectRoot: string
): Promise<void> {
  const typesAbsPath = resolve(schemaOpts.typesOutput);

  /* 1. Generate TypeScript types (only write if content changed). */
  const { generateTypeScript } = await import('../../schema.js');
  const tsContent = generateTypeScript(schema as import('../../types').SchemaDefinition);

  let existingContent = '';
  if (existsSync(typesAbsPath)) {
    existingContent = readFileSync(typesAbsPath, 'utf-8');
  }

  if (tsContent !== existingContent) {
    const typesDir = dirname(typesAbsPath);
    if (!existsSync(typesDir)) {
      mkdirSync(typesDir, { recursive: true });
    }
    writeFileSync(typesAbsPath, tsContent, 'utf-8');
    const relPath = relative(projectRoot, typesAbsPath);
    console.log(`[stellar] Types generated at ${relPath}`);
  }

  /* 2. Load the previous schema snapshot for migration diffing. */
  const snapshot = loadSnapshot(projectRoot);

  if (snapshot && schemaOpts.autoMigrate) {
    /* Diff the old and new schemas. */
    const { generateMigrationSQL } = await import('../../schema.js');
    const cleanedSchema = stripFunctions(schema);

    /* Only diff if the schema actually changed. */
    const oldJson = JSON.stringify(snapshot);
    const newJson = JSON.stringify(cleanedSchema);

    if (oldJson !== newJson) {
      const migrationSQL = generateMigrationSQL(
        snapshot as import('../../types').SchemaDefinition,
        cleanedSchema as import('../../types').SchemaDefinition
      );

      if (migrationSQL) {
        await pushMigration(migrationSQL, schemaOpts, projectRoot);
      }
    }
  } else if (!snapshot && schemaOpts.autoMigrate) {
    /*
     * First run with no snapshot — generate the FULL initial SQL
     * and push it to Supabase. This replaces the old `stellar-drive setup`
     * command entirely.
     */
    const { generateSupabaseSQL } = await import('../../schema.js');
    const cleanedSchema = stripFunctions(schema);
    const hasAnyTables = Object.keys(cleanedSchema).length > 0;

    if (hasAnyTables) {
      const fullSQL = generateSupabaseSQL(cleanedSchema as import('../../types').SchemaDefinition, {
        appName,
        includeHelperFunctions: true
      });
      await pushMigration(fullSQL, schemaOpts, projectRoot);
    }
  }

  /* 3. Save the new snapshot (strip functions before serialization). */
  saveSnapshot(projectRoot, schema);
}

/**
 * Push migration SQL to Supabase via the `stellar_engine_migrate` RPC function.
 *
 * Checks for required env vars before attempting the RPC call. If env vars
 * are missing, logs a clear warning with the exact variable names and skips
 * the migration (types are still generated).
 *
 * @param sql - The migration SQL to execute.
 * @param opts - The resolved schema options.
 * @param root - The project root directory.
 */
async function pushMigration(
  sql: string,
  opts: Required<SchemaConfig>,
  root: string
): Promise<void> {
  const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    const missing: string[] = [];
    if (!supabaseUrl) missing.push('PUBLIC_SUPABASE_URL');
    if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

    const relTypes = relative(root, resolve(opts.typesOutput));
    console.warn(
      `[stellar] \u26a0 Supabase auto-migration skipped \u2014 missing env vars:\n` +
        missing.map((v) => `  ${v}`).join('\n') +
        `\n  Set these in .env to enable automatic schema sync.\n` +
        `  Types were still generated at ${relTypes}`
    );
    return;
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { error } = await supabase.rpc('stellar_engine_migrate', { sql_text: sql });

    if (error) {
      console.error(`[stellar] \u274c Migration failed: ${error.message}`);
    } else {
      console.log('[stellar] \u2705 Schema migrated successfully');
    }
  } catch (err) {
    console.error('[stellar] \u274c Migration RPC error:', err);
  }
}

// =============================================================================
//                           VITE PLUGIN
// =============================================================================

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
export function stellarPWA(config: SWConfig) {
  /*
   * Track whether `configureServer` has run. If it has, skip the schema
   * processing in `buildStart` to avoid running it twice during dev.
   * During production builds, `configureServer` never fires, so `buildStart`
   * handles schema processing.
   */
  let isDevServer = false;

  return {
    name: 'stellar-pwa',

    /* ── buildStart — generate sw.js + one-shot schema processing ── */
    async buildStart() {
      /* ---- Service Worker Generation ---- */

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

      /* ---- Schema Processing (production builds only) ---- */

      /*
       * Skip if schema is not enabled, or if configureServer already ran
       * (dev mode handles schema via ssrLoadModule + file watcher instead).
       */
      if (!config.schema || isDevServer) return;

      const schemaOpts = resolveSchemaOpts(config.schema);
      const projectRoot = resolve('.');
      const schemaAbsPath = resolve(schemaOpts.path);

      try {
        const schema = await loadSchemaFromFile(schemaAbsPath);
        if (!schema || typeof schema !== 'object') {
          console.warn('[stellar] Schema file does not export a `schema` object — skipping.');
          return;
        }
        await processLoadedSchema(schema, config.name, schemaOpts, projectRoot);
      } catch (err) {
        console.error('[stellar] Error processing schema during build:', err);
      }
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
      } catch (e) {
        console.warn('[stellar-pwa] Could not generate asset manifest:', e);
      }
    },

    /* ── configureServer — schema watching + auto-migration ──────── */
    configureServer(server: {
      ssrLoadModule: (id: string) => Promise<Record<string, unknown>>;
      watcher: { on: (event: string, cb: (path: string) => void) => void };
    }) {
      /* Mark as dev server so buildStart skips schema processing. */
      isDevServer = true;

      if (!config.schema) return;

      const schemaOpts = resolveSchemaOpts(config.schema);
      const projectRoot = resolve('.');
      const schemaAbsPath = resolve(schemaOpts.path);

      /**
       * Process the schema file using Vite's SSR module loader.
       * This gives us the live, transpiled module without needing
       * esbuild or any external transpiler.
       */
      async function processSchema(): Promise<void> {
        try {
          const mod = await server.ssrLoadModule(schemaAbsPath);
          const schema = mod.schema as Record<string, unknown> | undefined;

          if (!schema || typeof schema !== 'object') {
            console.warn('[stellar] Schema file does not export a `schema` object — skipping.');
            return;
          }

          await processLoadedSchema(schema, config.name, schemaOpts, projectRoot);
        } catch (err) {
          console.error('[stellar] Error processing schema:', err);
        }
      }

      /* Run processSchema() once on dev server start. */
      processSchema();

      /* Watch the schema file with debounced handler.
       * The 500ms debounce prevents Supabase RPC spam when the user saves
       * rapidly (e.g., auto-save or holding Ctrl+S). */
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      server.watcher.on('change', (changedPath: string) => {
        /* Normalize path comparison — Vite's watcher may use different separators. */
        if (!changedPath.endsWith(schemaOpts.path.replace(/\//g, '/'))) return;
        if (resolve(changedPath) !== schemaAbsPath && changedPath !== schemaAbsPath) return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          processSchema();
        }, SCHEMA_DEBOUNCE_MS);
      });
    }
  };
}
