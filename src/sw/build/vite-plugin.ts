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

  /**
   * Whether to include the `crdt_documents` table in auto-generated SQL.
   * Set to `true` if the app uses CRDT collaborative editing.
   * @default false
   */
  includeCRDT?: boolean;

  /**
   * Path(s) to custom `.sql` files that are appended to the generated schema
   * SQL and executed on every build alongside it. Useful for app-specific RPC
   * functions, views, or triggers that stellar-drive doesn't generate.
   *
   * Paths are resolved relative to the project root. The SQL should be
   * idempotent (`CREATE OR REPLACE`, `IF NOT EXISTS`, etc.) since it runs
   * on every build.
   *
   * @example
   * schema: { customSQL: 'src/lib/custom.sql' }
   * schema: { customSQL: ['src/lib/rpc.sql', 'src/lib/views.sql'] }
   */
  customSQL?: string | string[];
}

/** Resolved schema config with all defaults applied. */
type ResolvedSchemaConfig = Required<Omit<SchemaConfig, 'customSQL'>> &
  Pick<SchemaConfig, 'customSQL'>;

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
function resolveSchemaOpts(schema: boolean | SchemaConfig): ResolvedSchemaConfig {
  if (typeof schema === 'object') {
    return {
      path: schema.path || 'src/lib/schema.ts',
      typesOutput: schema.typesOutput || 'src/lib/types.generated.ts',
      autoMigrate: schema.autoMigrate !== false,
      includeCRDT: schema.includeCRDT === true,
      customSQL: schema.customSQL
    };
  }
  return {
    path: 'src/lib/schema.ts',
    typesOutput: 'src/lib/types.generated.ts',
    autoMigrate: true,
    includeCRDT: false,
    customSQL: undefined
  };
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
 * Core schema processing: generate types and push idempotent SQL to Supabase.
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
  prefix: string,
  schemaOpts: ResolvedSchemaConfig,
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

  const relTypesPath = relative(projectRoot, typesAbsPath);
  if (tsContent !== existingContent) {
    const typesDir = dirname(typesAbsPath);
    if (!existsSync(typesDir)) {
      mkdirSync(typesDir, { recursive: true });
    }
    writeFileSync(typesAbsPath, tsContent, 'utf-8');

    /* Log detailed diff of type changes. */
    const oldLines = existingContent.split('\n');
    const newLines = tsContent.split('\n');
    const added = newLines.filter((l) => !oldLines.includes(l) && l.trim());
    const removed = oldLines.filter((l) => !newLines.includes(l) && l.trim());
    console.log(`[stellar-drive] Types updated at ${relTypesPath}`);
    if (removed.length)
      console.log(
        `[stellar-drive]   Removed:\n${removed.map((l) => `    - ${l.trim()}`).join('\n')}`
      );
    if (added.length)
      console.log(`[stellar-drive]   Added:\n${added.map((l) => `    + ${l.trim()}`).join('\n')}`);
  } else {
    console.log(`[stellar-drive] Types unchanged at ${relTypesPath}`);
  }

  /* 2. Generate and push idempotent SQL to Supabase.
   *    The SQL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS everywhere,
   *    so it's safe to reapply the full schema on every build. */
  if (!schemaOpts.autoMigrate) {
    console.log('[stellar-drive] Auto-migrate disabled, skipping schema sync');
    return;
  }

  const { generateSupabaseSQL } = await import('../../schema.js');
  const tableNames = Object.keys(schema);

  if (tableNames.length === 0) {
    console.log('[stellar-drive] No tables in schema, skipping SQL generation');
    return;
  }

  console.log(`[stellar-drive] Syncing ${tableNames.length} tables: ${tableNames.join(', ')}`);
  let fullSQL = generateSupabaseSQL(schema as import('../../types').SchemaDefinition, {
    appName,
    prefix,
    includeHelperFunctions: true,
    includeCRDT: schemaOpts.includeCRDT
  });

  /* 3. Append custom SQL files (app-specific RPC functions, views, etc.). */
  if (schemaOpts.customSQL) {
    const sqlPaths = Array.isArray(schemaOpts.customSQL)
      ? schemaOpts.customSQL
      : [schemaOpts.customSQL];

    for (const sqlPath of sqlPaths) {
      const absPath = resolve(projectRoot, sqlPath);
      if (existsSync(absPath)) {
        const custom = readFileSync(absPath, 'utf-8').trim();
        if (custom) {
          fullSQL += `\n\n-- Custom SQL: ${sqlPath}\n${custom}\n`;
          console.log(
            `[stellar-drive] Appended custom SQL: ${sqlPath} (${custom.length} chars, first line: "${
              custom
                .split('\n')
                .find((l) => l.trim() && !l.trim().startsWith('--'))
                ?.trim() || ''
            }")`
          );
        }
      } else {
        console.warn(`[stellar-drive] Custom SQL file not found: ${sqlPath}`);
      }
    }
  }

  await pushSchema(fullSQL, schemaOpts, projectRoot);
}

/**
 * Push schema SQL to Supabase via a direct Postgres connection.
 *
 * Reads `DATABASE_URL` from `process.env` first, then falls back to `.env`
 * files in the project root (Vite plugins don't get `.env` loaded into
 * `process.env` automatically). Use a Supabase pooler URL to avoid IPv6
 * issues on CI environments like Vercel.
 *
 * @param sql - The idempotent schema SQL to execute.
 * @param opts - The resolved schema options.
 * @param root - The project root directory.
 * @returns `true` if the push succeeded, `false` otherwise.
 */
async function pushSchema(sql: string, opts: ResolvedSchemaConfig, root: string): Promise<boolean> {
  let databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    for (const envFile of ['.env.local', '.env']) {
      const envPath = join(root, envFile);
      if (existsSync(envPath)) {
        const match = readFileSync(envPath, 'utf-8').match(/^DATABASE_URL\s*=\s*(.+)$/m);
        if (match) {
          databaseUrl = match[1].trim();
          break;
        }
      }
    }
  }

  if (!databaseUrl) {
    const relTypes = relative(root, resolve(opts.typesOutput));
    console.warn(
      `[stellar-drive] \u26a0 Schema push skipped \u2014 DATABASE_URL not found.\n` +
        `  Set it in .env to enable automatic schema sync.\n` +
        `  Find it: Supabase Dashboard \u2192 Settings \u2192 Database \u2192 Connection string (URI)\n` +
        `  Types were still generated at ${relTypes}`
    );
    return false;
  }

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  let postgres: any;
  try {
    /* Dynamic import — `postgres` is an optional dependency only needed when
     * autoMigrate is enabled. The string indirection prevents TypeScript and
     * bundlers from resolving it at compile time. */
    const depName = 'postgres';
    const mod = await import(depName);
    postgres = mod.default;
  } catch {
    console.error(
      '[stellar-drive] \u274c Missing dependency: `postgres`\n' +
        '  Install it with: npm install postgres\n' +
        '  This package is required for automatic schema sync.'
    );
    return false;
  }

  /* Log Postgres NOTICEs (e.g. "relation already exists, skipping") as
     concise one-liners instead of full JSON objects. */
  const onnotice = (notice: { message?: string }) => {
    if (notice.message) console.log(`[stellar-drive] ${notice.message}`);
  };

  const sql_client = postgres(databaseUrl, { max: 1, idle_timeout: 5, onnotice });

  try {
    const stmtCount = sql.split(';').filter((s) => s.trim()).length;
    console.log(`[stellar-drive] Pushing schema (${stmtCount} statements, ${sql.length} chars)...`);
    await sql_client.unsafe(sql);
    console.log('[stellar-drive] \u2705 Schema pushed successfully');
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[stellar-drive] \u274c Schema push failed: ${message}`);
    return false;
  } finally {
    await sql_client.end();
  }
}

// =============================================================================
//                           VITE PLUGIN
// =============================================================================

/**
 * Vite plugin factory that generates `static/sw.js`, `asset-manifest.json`,
 * and optionally auto-generates types + pushes schema SQL to Supabase.
 *
 * **`buildStart` hook (dev + production builds):**
 *   - Generates `static/sw.js` from the compiled SW template.
 *   - When `schema` is enabled: loads the schema file via esbuild, generates
 *     TypeScript types, and pushes the full idempotent schema SQL to Supabase
 *     via direct Postgres connection (`DATABASE_URL`).
 *
 * **`closeBundle` hook:**
 *   - Scans SvelteKit's immutable output directory for JS and CSS files.
 *   - Writes `asset-manifest.json` to both `static/` and the build output
 *     directory so the service worker can precache all app chunks.
 *
 * **`configureServer` hook (dev only, when `schema` is enabled):**
 *   - On server start, processes the schema file once via Vite's SSR loader.
 *   - Watches the schema file for changes with 500ms debounce.
 *   - Each change re-generates types and pushes schema SQL.
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
/*
 * SvelteKit's `vite build` evaluates the config twice (SSR + client passes),
 * so the plugin factory runs twice. Module-level flags ensure SW generation,
 * schema processing, and asset manifest generation only happen once per build.
 */
let buildStartRan = false;
let closeBundleRan = false;

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
      if (buildStartRan) return;
      buildStartRan = true;

      console.log(`[stellar-drive] buildStart — ${config.name} (prefix: ${config.prefix})`);

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
      console.log(`[stellar-drive] Generated sw.js (version: ${version})`);

      /* ---- Schema Processing (production builds only) ---- */

      /*
       * Skip if schema is not enabled, or if configureServer already ran
       * (dev mode handles schema via ssrLoadModule + file watcher instead).
       */
      if (!config.schema) {
        console.log(
          '[stellar-drive] Schema auto-generation: disabled (pass `schema: true` to enable)'
        );
        return;
      }
      if (isDevServer) {
        console.log('[stellar-drive] Schema processing deferred to dev server (configureServer)');
        return;
      }

      const schemaOpts = resolveSchemaOpts(config.schema);
      const projectRoot = resolve('.');
      const schemaAbsPath = resolve(schemaOpts.path);

      console.log(`[stellar-drive] Schema processing — loading ${schemaOpts.path}`);

      try {
        const schema = await loadSchemaFromFile(schemaAbsPath);
        if (!schema || typeof schema !== 'object') {
          console.warn('[stellar-drive] Schema file does not export a `schema` object — skipping.');
          return;
        }
        await processLoadedSchema(schema, config.name, config.prefix, schemaOpts, projectRoot);
      } catch (err) {
        console.error('[stellar-drive] Error processing schema during build:', err);
      }
    },

    /* ── closeBundle — generate asset manifest ───────────────────── */
    closeBundle() {
      if (closeBundleRan) return;
      closeBundleRan = true;
      console.log('[stellar-drive] closeBundle — generating asset manifest');

      const buildDir = resolve('.svelte-kit/output/client/_app/immutable');
      if (!existsSync(buildDir)) {
        console.warn('[stellar-drive] Build directory not found, skipping manifest generation');
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

        console.log(`[stellar-drive] Generated asset manifest with ${assets.length} files`);
      } catch (e) {
        console.warn('[stellar-drive] Could not generate asset manifest:', e);
      }
    },

    /* ── configureServer — schema watching + auto-sync ──────────── */
    configureServer(server: {
      ssrLoadModule: (id: string) => Promise<Record<string, unknown>>;
      watcher: { on: (event: string, cb: (path: string) => void) => void };
    }) {
      /* Mark as dev server so buildStart skips schema processing. */
      isDevServer = true;

      if (!config.schema) {
        console.log('[stellar-drive] Dev server started — schema auto-generation: disabled');
        return;
      }

      const schemaOpts = resolveSchemaOpts(config.schema);
      const projectRoot = resolve('.');
      const schemaAbsPath = resolve(schemaOpts.path);

      console.log(
        `[stellar-drive] Dev server started — watching ${schemaOpts.path} for schema changes`
      );

      /*
       * Mutex flag to prevent concurrent processSchema executions.
       * Without this, the initial call + a rapid file change could overlap,
       * causing duplicate schema pushes.
       */
      let processing = false;
      let pendingReprocess = false;

      /**
       * Process the schema file using Vite's SSR module loader.
       * This gives us the live, transpiled module without needing
       * esbuild or any external transpiler.
       */
      async function processSchema(): Promise<void> {
        if (processing) {
          pendingReprocess = true;
          return;
        }
        processing = true;

        try {
          const mod = await server.ssrLoadModule(schemaAbsPath);
          const schema = mod.schema as Record<string, unknown> | undefined;

          if (!schema || typeof schema !== 'object') {
            console.warn(
              '[stellar-drive] Schema file does not export a `schema` object — skipping.'
            );
            return;
          }

          await processLoadedSchema(schema, config.name, config.prefix, schemaOpts, projectRoot);
        } catch (err) {
          console.error('[stellar-drive] Error processing schema:', err);
        } finally {
          processing = false;
          /* If a change came in while we were processing, run again. */
          if (pendingReprocess) {
            pendingReprocess = false;
            processSchema();
          }
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
