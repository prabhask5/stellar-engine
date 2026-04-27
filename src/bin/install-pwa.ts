/**
 * @fileoverview CLI command that scaffolds a PWA SvelteKit project using stellar-drive.
 *
 * Generates a complete project structure including:
 *   - Build configuration (Vite, TypeScript, SvelteKit, ESLint, Prettier, Knip)
 *   - PWA assets (manifest, offline page, placeholder icons)
 *   - SvelteKit routes (home, login, setup wizard, profile, error, confirm)
 *   - API endpoints (config, deploy, validate)
 *   - Shared schema definition (single source of truth for Dexie + SQL + types)
 *   - Git hooks via Husky
 *
 * Files are written non-destructively: existing files are skipped, not overwritten.
 *
 * Invoked via `stellar-drive install pwa` (routed by {@link commands.ts}).
 *
 * @example
 * ```bash
 * stellar-drive install pwa
 * ```
 *
 * @see {@link run} for the entry point
 * @see {@link runInteractiveSetup} for the interactive walkthrough
 * @see {@link writeIfMissing} for the non-destructive file write strategy
 */

import { writeFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import * as p from '@clack/prompts';
import color from 'picocolors';

// =============================================================================
//                                  TYPES
// =============================================================================

/**
 * Parsed CLI options used throughout the scaffold generators.
 */
interface InstallOptions {
  /** Full application name (e.g., `"My Cool App"`). */
  name: string;

  /** Short name for home screen / PWA title (e.g., `"Cool"`). */
  shortName: string;

  /** Cache and storage key prefix (e.g., `"coolapp"`). */
  prefix: string;

  /** Application description for meta tags and manifest. */
  description: string;

  /** Kebab-cased name derived from `name`, used for `package.json`. */
  kebabName: string;
}

// =============================================================================
//                                 HELPERS
// =============================================================================

/**
 * Writes a file only if it doesn't already exist (non-destructive).
 *
 * Creates parent directories as needed. Tracks created and skipped files
 * in the provided arrays for the final summary output.
 *
 * @param filePath - Absolute path to the target file.
 * @param content - The file content to write.
 * @param createdFiles - Accumulator for newly-created file paths (relative).
 * @param skippedFiles - Accumulator for skipped file paths (relative).
 * @param quiet - When `true`, suppresses per-file console output (used during animated progress).
 */
function writeIfMissing(
  filePath: string,
  content: string,
  createdFiles: string[],
  skippedFiles: string[],
  quiet = false
): void {
  const relPath = filePath.replace(process.cwd() + '/', '');
  if (existsSync(filePath)) {
    skippedFiles.push(relPath);
    if (!quiet) console.log(`  [skip] ${relPath} already exists`);
  } else {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content, 'utf-8');
    createdFiles.push(relPath);
    if (!quiet) console.log(`  [write] ${relPath}`);
  }
}

// =============================================================================
//                         INTERACTIVE SETUP
// =============================================================================

/**
 * Run the interactive setup walkthrough, collecting all required options
 * from the user via sequential prompts.
 *
 * Displays a welcome banner, then prompts for App Name, Short Name, Prefix,
 * and Description with inline validation. Shows a confirmation summary and
 * asks the user to proceed before returning.
 *
 * @returns A promise that resolves with the validated {@link InstallOptions}.
 *
 * @throws {SystemExit} Exits with code 0 if the user cancels or declines to proceed.
 */
async function runInteractiveSetup(): Promise<InstallOptions> {
  p.intro(color.bold('\u2726 stellar-drive \u00b7 PWA scaffolder'));

  const name = await p.text({
    message: 'App name',
    placeholder: 'e.g. Stellar Planner',
    validate(value) {
      if (!value || !value.trim()) return 'App name is required.';
    }
  });
  if (p.isCancel(name)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const shortName = await p.text({
    message: 'Short name',
    placeholder: 'e.g. Stellar (under 12 chars)',
    validate(value) {
      if (!value || !value.trim()) return 'Short name is required.';
      if (value.trim().length >= 12) return 'Short name must be under 12 characters.';
    }
  });
  if (p.isCancel(shortName)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const suggestedPrefix = (name as string).toLowerCase().replace(/[^a-z0-9]/g, '');
  const prefix = await p.text({
    message: 'Prefix',
    placeholder: suggestedPrefix,
    defaultValue: suggestedPrefix,
    validate(value) {
      const v = (value ?? '').trim() || suggestedPrefix;
      if (!/^[a-z][a-z0-9]*$/.test(v))
        return 'Prefix must be lowercase, start with a letter, no spaces.';
    }
  });
  if (p.isCancel(prefix)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const defaultDesc = 'A self-hosted offline-first PWA';
  const description = await p.text({
    message: 'Description',
    placeholder: defaultDesc,
    defaultValue: defaultDesc
  });
  if (p.isCancel(description)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const kebabName = (name as string).toLowerCase().replace(/\s+/g, '-');
  const opts: InstallOptions = {
    name: (name as string).trim(),
    shortName: (shortName as string).trim(),
    prefix: (prefix as string).trim() || suggestedPrefix,
    description: (description as string).trim() || defaultDesc,
    kebabName
  };

  p.note(
    [
      `${color.bold('Name:')}         ${opts.name}`,
      `${color.bold('Short name:')}   ${opts.shortName}`,
      `${color.bold('Prefix:')}       ${opts.prefix}`,
      `${color.bold('Description:')}  ${opts.description}`
    ].join('\n'),
    'Configuration'
  );

  const confirmed = await p.confirm({ message: 'Proceed with this configuration?' });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  return opts;
}

// =============================================================================
//                          TEMPLATE GENERATORS
// =============================================================================

// ---------------------------------------------------------------------------
//                     PACKAGE.JSON GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `package.json` with all dependencies and scripts pre-configured
 * for a stellar-drive PWA project.
 *
 * Includes dev tooling (ESLint, Prettier, Knip, Husky, svelte-check) and
 * the `stellar-drive` runtime dependency.
 *
 * @param opts - The install options containing the kebab-cased project name.
 * @returns The JSON string for `package.json`.
 */
function generatePackageJson(opts: InstallOptions): string {
  return (
    JSON.stringify(
      {
        name: opts.kebabName,
        version: '1.0.0',
        private: true,
        scripts: {
          dev: 'vite dev',
          build: 'vite build',
          preview: 'vite preview',
          check: 'svelte-check --tsconfig ./tsconfig.json',
          'check:watch': 'svelte-check --tsconfig ./tsconfig.json --watch',
          lint: 'eslint src',
          'lint:fix': 'eslint src --fix',
          format: 'prettier --write "src/**/*.{js,ts,svelte,css,html}"',
          'format:check': 'prettier --check "src/**/*.{js,ts,svelte,css,html}"',
          'dead-code': 'knip',
          'dead-code:fix': 'knip --fix',
          cleanup: 'npm run lint:fix && npm run format',
          validate: 'npm run check && npm run lint && npm run dead-code',
          prepare: 'husky'
        },
        devDependencies: {
          '@eslint/js': '^9.39.2',
          '@sveltejs/adapter-auto': '^4.0.0',
          '@sveltejs/kit': '^2.21.0',
          '@sveltejs/vite-plugin-svelte': '^5.0.0',
          eslint: '^9.39.2',
          'eslint-plugin-svelte': '^3.14.0',
          globals: '^17.2.0',
          husky: '^9.1.7',
          knip: '^5.82.1',
          prettier: '^3.8.1',
          'prettier-plugin-svelte': '^3.4.1',
          svelte: '^5.0.0',
          'svelte-check': '^4.3.5',
          typescript: '^5.0.0',
          'typescript-eslint': '^8.54.0',
          vite: '^6.0.0'
        },
        dependencies: {
          postgres: '^3.4.0',
          'stellar-drive': '^1.2.30'
        },
        type: 'module'
      },
      null,
      2
    ) + '\n'
  );
}

// ---------------------------------------------------------------------------
//                      VITE CONFIG GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a Vite config with SvelteKit and stellarPWA plugins, plus
 * manual chunk-splitting for heavy vendor libraries.
 *
 * @param opts - The install options containing `prefix` and `name`.
 * @returns The TypeScript source for `vite.config.ts`.
 */
function generateViteConfig(opts: InstallOptions): string {
  return `/**
 * @fileoverview Vite build configuration for the ${opts.shortName} PWA.
 *
 * This config handles three key concerns:
 *   1. SvelteKit integration — via the official \`sveltekit()\` plugin
 *   2. Service worker + asset manifest — via the \`stellarPWA()\` plugin from
 *      stellar-drive, which generates \`static/sw.js\` and \`asset-manifest.json\`
 *      at build time
 *   3. Chunk-splitting — isolates heavy vendor libs (\`@supabase\`, \`dexie\`)
 *      into their own bundles for long-term caching
 *
 * ## Service Worker caching strategy (generated by stellarPWA)
 *
 * The service worker (\`static/sw.js\`) uses three strategies automatically:
 *
 *   - **Immutable assets** (\`/_app/immutable/*\`) — cache-first, never
 *     revalidated. Content-hashed filenames mean a changed file always gets
 *     a new URL, so these are safe to cache forever. Persists across deploys.
 *
 *   - **App shell / static assets** — cache-first, versioned per deploy.
 *     Old shell caches are deleted when the new SW activates, so only one
 *     version is ever on disk.
 *
 *   - **Navigation requests (HTML pages)** — network-first with a 1.5-second
 *     timeout. Falls back to the cached root \`/\` document when offline. On
 *     timeout the SW broadcasts \`NETWORK_UNREACHABLE\` so the app can show an
 *     offline indicator without issuing its own HEAD request.
 *
 *   - **Background precaching** — after first load the app triggers a
 *     \`PRECACHE_ALL\` message, which downloads every chunk in
 *     \`asset-manifest.json\` in the background. This makes all pages
 *     available offline even before the user has visited them.
 *
 * ## Customisation
 *
 *   - \`schema: true\` — enables auto-generation of TypeScript types from
 *     \`src/lib/schema.ts\` and live Supabase migration during \`npm run dev\`.
 *     Pass an object for custom paths: \`{ path, typesOutput, autoMigrate }\`.
 *
 *   - \`syncIntervalMs\` in \`initEngine()\` (in \`+layout.ts\`) — controls how
 *     often the engine polls Supabase when realtime is unhealthy.
 *     Default: 900 000 ms (15 min). Only fires when realtime is down.
 */

// =============================================================================
//                                  IMPORTS
// =============================================================================

import { sveltekit } from '@sveltejs/kit/vite';
import { stellarPWA } from 'stellar-drive/vite';
import { defineConfig } from 'vite';

// =============================================================================
//                            VITE CONFIGURATION
// =============================================================================

export default defineConfig({
  plugins: [
    sveltekit(),
    stellarPWA({ prefix: '${opts.prefix}', name: '${opts.name}', schema: true })
  ],
  build: {
    rollupOptions: {
      output: {
        /* ── Vendor chunk isolation ── */
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            /** Supabase auth + realtime — ~100 KB gzipped */
            if (id.includes('@supabase')) return 'vendor-supabase';
            /** Dexie (IndexedDB wrapper) — offline-first storage layer */
            if (id.includes('dexie')) return 'vendor-dexie';
          }
        }
      }
    },
    /** Reduce noise — only warn for chunks above 500 KB */
    chunkSizeWarningLimit: 500,
    /** esbuild is faster than terser and produces comparable output */
    minify: 'esbuild',
    /** Target modern browsers → enables smaller output (no legacy polyfills) */
    target: 'es2020'
  }
});
`;
}

// ---------------------------------------------------------------------------
//                      TSCONFIG GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `tsconfig.json` extending SvelteKit's generated config.
 *
 * @returns The JSON string for `tsconfig.json`.
 */
function generateTsconfig(): string {
  return (
    JSON.stringify(
      {
        extends: './.svelte-kit/tsconfig.json',
        compilerOptions: {
          allowJs: true,
          checkJs: true,
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          sourceMap: true,
          strict: true,
          moduleResolution: 'bundler'
        }
      },
      null,
      2
    ) + '\n'
  );
}

// ---------------------------------------------------------------------------
//                    SVELTE CONFIG GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `svelte.config.js` with adapter-auto and vitePreprocess.
 *
 * @param opts - The install options containing `shortName`.
 * @returns The JavaScript source for `svelte.config.js`.
 */
function generateSvelteConfig(opts: InstallOptions): string {
  return `/**
 * @fileoverview SvelteKit project configuration for ${opts.shortName}.
 *
 * Keeps things minimal:
 *   - **Adapter** — \`adapter-auto\` automatically selects the right deployment
 *     adapter (Vercel, Netlify, Cloudflare, Node, etc.) based on the detected
 *     environment, so the config stays portable across hosting providers.
 *   - **Preprocessor** — \`vitePreprocess\` handles \`<style lang="...">\` and
 *     \`<script lang="ts">\` blocks using the Vite pipeline, keeping tooling
 *     consistent between Svelte components and the rest of the build.
 */

// =============================================================================
//                                  IMPORTS
// =============================================================================

import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// =============================================================================
//                           SVELTEKIT CONFIGURATION
// =============================================================================

/** @type {import('@sveltejs/kit').Config} */
const config = {
  /** Use Vite's built-in transform pipeline for TypeScript, PostCSS, etc. */
  preprocess: vitePreprocess(),

  kit: {
    /**
     * \`adapter-auto\` inspects the deploy target at build time and picks
     * the appropriate adapter automatically — no manual switching needed
     * when moving between local dev, Vercel, or other platforms.
     */
    adapter: adapter()
  }
};

export default config;
`;
}

// ---------------------------------------------------------------------------
//                     MANIFEST GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a PWA `manifest.json` with icons, theme colours, and display settings.
 *
 * @param opts - The install options containing `name`, `shortName`, and `description`.
 * @returns The JSON string for `static/manifest.json`.
 */
function generateManifest(opts: InstallOptions): string {
  return (
    JSON.stringify(
      {
        name: opts.name,
        short_name: opts.shortName,
        description: opts.description,
        start_url: '/?pwa=true',
        scope: '/',
        id: '/',
        display: 'standalone',
        background_color: '#111116',
        theme_color: '#111116',
        orientation: 'portrait-primary',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable'
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ],
        categories: ['productivity', 'utilities'],
        prefer_related_applications: false
      },
      null,
      2
    ) + '\n'
  );
}

// ---------------------------------------------------------------------------
//                      APP.D.TS GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate the SvelteKit ambient type declarations file (`src/app.d.ts`).
 *
 * @param opts - The install options containing `shortName`.
 * @returns The TypeScript source for `src/app.d.ts`.
 */
function generateAppDts(opts: InstallOptions): string {
  return `/**
 * @fileoverview Ambient type declarations for the ${opts.shortName} SvelteKit application.
 *
 * This file extends the global \`App\` namespace used by SvelteKit to provide
 * type safety for framework-level hooks (\`locals\`, \`pageData\`, \`error\`, etc.).
 *
 * Currently, no custom interfaces are needed — the defaults provided by
 * \`@sveltejs/kit\` are sufficient. Uncomment and populate the stubs below
 * when server-side locals or shared page data types are introduced.
 *
 * @see https://kit.svelte.dev/docs/types#app — SvelteKit \`App\` namespace docs
 */

// =============================================================================
//                         SVELTEKIT TYPE REFERENCES
// =============================================================================

/// <reference types="@sveltejs/kit" />

// =============================================================================
//                        GLOBAL APP TYPE DECLARATIONS
// =============================================================================

declare global {
  namespace App {
    /**
     * Extend \`App.Locals\` to type data attached to \`event.locals\` inside
     * SvelteKit hooks (e.g., authenticated user objects, request metadata).
     */
    // interface Locals {}
    /**
     * Extend \`App.PageData\` to type shared data returned from all
     * \`+layout.server.ts\` / \`+page.server.ts\` load functions.
     */
    // interface PageData {}
  }
}

/**
 * Ensures this file is treated as an **ES module** (required for ambient
 * \`declare global\` blocks to work correctly in TypeScript).
 */
export {};
`;
}

// ---------------------------------------------------------------------------
//                      APP.HTML GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate the root HTML shell (`src/app.html`) with PWA meta tags, iOS
 * configuration, landscape blocker, gesture prevention, and deferred
 * service worker registration.
 *
 * @param opts - The install options containing `name`, `shortName`, and `description`.
 * @returns The HTML source for `src/app.html`.
 */
function generateAppHtml(opts: InstallOptions): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <!-- ================================================================= -->
    <!--                     CORE DOCUMENT META                            -->
    <!-- ================================================================= -->
    <meta charset="utf-8" />
    <title>${opts.name}</title>
    <link rel="icon" href="%sveltekit.assets%/favicon.png" />

    <!--
      Viewport configuration:
        - \`initial-scale=1\`          → no zoom on load
        - \`viewport-fit=cover\`       → extend into safe-area insets (notch, home bar)
        - \`width=device-width\`       → responsive width
        - \`interactive-widget=overlays-content\` → keyboard overlays rather than
          resizing the viewport (prevents layout shift on mobile)
    -->
    <meta
      name="viewport"
      content="initial-scale=1, viewport-fit=cover, width=device-width, interactive-widget=overlays-content"
    />

    <!-- ================================================================= -->
    <!--                         SEO META TAGS                             -->
    <!-- ================================================================= -->

    <!-- Theme color matches the app's dark background for seamless safe-area blending -->
    <meta name="theme-color" content="#111116" />
    <meta name="description" content="${opts.name} - ${opts.description}" />
    <meta
      name="keywords"
      content="pwa, offline-first, productivity, utilities, svelte, sveltekit"
    />
    <meta name="author" content="${opts.shortName}" />
    <meta name="robots" content="index, follow" />

    <!-- ================================================================= -->
    <!--                    OPEN GRAPH / SOCIAL MEDIA                      -->
    <!-- ================================================================= -->

    <!-- Used by Facebook, LinkedIn, Discord, Slack, etc. for link previews -->
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${opts.name}" />
    <meta property="og:description" content="${opts.description}" />
    <meta property="og:image" content="%sveltekit.assets%/icon-512.png" />

    <!-- ================================================================= -->
    <!--                         TWITTER CARD                              -->
    <!-- ================================================================= -->

    <!-- "summary" card type → square image + title + description -->
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${opts.name}" />
    <meta name="twitter:description" content="${opts.description}" />

    <!-- ================================================================= -->
    <!--                      PWA / MANIFEST CONFIG                        -->
    <!-- ================================================================= -->

    <!-- Web App Manifest — defines name, icons, theme, display mode -->
    <link rel="manifest" href="%sveltekit.assets%/manifest.json" />

    <!-- ================================================================= -->
    <!--                       iOS PWA META TAGS                           -->
    <!-- ================================================================= -->

    <!--
      iOS-specific PWA configuration:
        - \`apple-mobile-web-app-capable\`            → enables standalone PWA mode
        - \`apple-mobile-web-app-status-bar-style\`   → \`black-translucent\` lets
          content extend behind the status bar for a true full-screen feel
        - \`apple-mobile-web-app-title\`              → name shown on home screen
        - \`apple-touch-icon\`                        → icon used when "Add to Home Screen"
    -->
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="${opts.shortName}" />
    <link rel="apple-touch-icon" href="%sveltekit.assets%/icon-192.png" />

    <!-- Prevent iOS from auto-detecting and styling phone numbers as links -->
    <meta name="format-detection" content="telephone=no" />

    <!-- ================================================================= -->
    <!--           DESIGN SYSTEM — global CSS variables & resets           -->
    <!-- ================================================================= -->
    <style>
      /* ── Design tokens — dark/green theme from ${opts.name} ── */
      :root {
        /* Backgrounds */
        --color-bg:       #111116;
        --color-surface:  #0f0f1e;
        --color-surface-2: #1a1a22;

        /* Borders */
        --color-border:   #3d5a3d;

        /* Accent colors */
        --color-green:    #6B9E6B;
        --color-gold:     #D4A853;

        /* Text */
        --color-text:     #f0f0ff;
        --color-text-body: #c8c8e0;
        --color-text-muted: #7878a0;

        /* Status */
        --color-error:    #e07070;
        --color-success:  #6B9E6B;

        /* Typography */
        --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;

        /* Spacing & radius */
        --radius-sm: 8px;
        --radius-md: 12px;
        --radius-lg: 16px;
        --radius-xl: 20px;
      }

      /* ── Base reset ── */
      *, *::before, *::after { box-sizing: border-box; }

      html {
        height: 100%;
        overflow: hidden;
        -webkit-text-size-adjust: 100%;
      }

      body {
        margin: 0;
        height: 100%;
        overflow-y: auto;
        overflow-x: hidden;
        -webkit-overflow-scrolling: touch;
        background: var(--color-bg);
        color: var(--color-text-body);
        font-family: var(--font-sans);
        font-size: 16px;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
      }

      /* Selection */
      ::selection {
        background: rgba(107, 158, 107, 0.25);
        color: var(--color-text);
      }

      /* Focus visible — keyboard nav only */
      :focus-visible {
        outline: 2px solid var(--color-green);
        outline-offset: 2px;
      }

      /* Scrollbar (webkit) */
      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #3d5a3d; border-radius: 3px; }
      ::-webkit-scrollbar-thumb:hover { background: #6B9E6B; }
    </style>

    <!-- SvelteKit injects component-level <head> content here -->
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <!-- ================================================================= -->
    <!--               LANDSCAPE ORIENTATION BLOCKER                       -->
    <!-- ================================================================= -->
    <!-- Landscape orientation blocker — shown only on phones in landscape via the media query below -->
    <div id="landscape-blocker">
      <div id="landscape-blocker-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#6B9E6B" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <!-- Phone rotated to portrait -->
          <rect x="7" y="2" width="10" height="18" rx="2" />
          <path d="M11 19h2" />
          <!-- Rotation arrow -->
          <path d="M3 8a9 9 0 0 1 9-9" opacity="0.4" />
          <polyline points="3 3 3 8 8 8" opacity="0.4" />
        </svg>
      </div>
      <p id="landscape-blocker-title">${opts.name}</p>
      <p id="landscape-blocker-text">Rotate your device to portrait mode to continue</p>
    </div>

    <!-- ================================================================= -->
    <!--              LANDSCAPE BLOCKER STYLES                             -->
    <!-- ================================================================= -->
    <style>
      /* Hidden by default — shown only on phones in landscape (see query below) */
      #landscape-blocker {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 99999;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1rem;
        background: #111116;
        padding: 2rem;
        text-align: center;
      }

      #landscape-blocker-icon {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        background: #1a2e1a;
        border: 2px solid #3d5a3d;
        display: flex;
        align-items: center;
        justify-content: center;
        animation: rotate-hint 2s ease-in-out infinite;
      }

      @keyframes rotate-hint {
        0%, 80%, 100% { transform: rotate(0deg); }
        40%           { transform: rotate(-15deg); }
      }

      #landscape-blocker-title {
        margin: 0;
        font-size: 1.125rem;
        font-weight: 800;
        color: #6B9E6B;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        letter-spacing: -0.3px;
      }

      #landscape-blocker-text {
        margin: 0;
        font-size: 0.9375rem;
        color: #c8c8e0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        line-height: 1.5;
        max-width: 260px;
      }

      /* Show ONLY on phones in landscape:
         - max-height: 500px  → landscape phone viewports
         - hover: none        → excludes desktop/laptop
         - pointer: coarse    → excludes mouse/stylus */
      @media (max-height: 500px) and (orientation: landscape) and (hover: none) and (pointer: coarse) {
        #landscape-blocker {
          display: flex;
        }
      }
    </style>

    <!-- ================================================================= -->
    <!--                      SVELTEKIT APP MOUNT                          -->
    <!-- ================================================================= -->
    <!-- \`display: contents\` makes the wrapper invisible to CSS layout     -->
    <div style="display: contents">%sveltekit.body%</div>

    <!-- ================================================================= -->
    <!--              iOS GESTURE / ZOOM PREVENTION SCRIPT                 -->
    <!-- ================================================================= -->
    <!--
      Prevents unwanted zoom gestures in the iOS PWA:
        1. \`gesturestart/change/end\` → blocks pinch-to-zoom (Safari-specific)
        2. \`touchend\` debounce       → blocks double-tap zoom (300 ms window)
        3. \`touchmove\` multi-touch   → blocks two-finger zoom/scroll

      All listeners use \`{ passive: false }\` so \`preventDefault()\` works.
      Wrapped in an IIFE to avoid polluting the global scope.
    -->
    <script>
      (function () {
        // Prevent pinch-to-zoom
        document.addEventListener(
          'gesturestart',
          function (e) {
            e.preventDefault();
          },
          { passive: false }
        );

        document.addEventListener(
          'gesturechange',
          function (e) {
            e.preventDefault();
          },
          { passive: false }
        );

        document.addEventListener(
          'gestureend',
          function (e) {
            e.preventDefault();
          },
          { passive: false }
        );

        // Prevent double-tap zoom — if two taps land within 300 ms, cancel the second
        var lastTouchEnd = 0;
        document.addEventListener(
          'touchend',
          function (e) {
            var now = Date.now();
            if (now - lastTouchEnd <= 300) {
              e.preventDefault();
            }
            lastTouchEnd = now;
          },
          { passive: false }
        );

        // Prevent multi-touch zoom — block touchmove when more than one finger is down
        document.addEventListener(
          'touchmove',
          function (e) {
            if (e.touches.length > 1) {
              e.preventDefault();
            }
          },
          { passive: false }
        );
      })();
    </script>

    <!-- ================================================================= -->
    <!--              SW OFFLINE BRIDGE (runs before bundles load)          -->
    <!-- ================================================================= -->
    <!--
      Listens for the service worker's NETWORK_UNREACHABLE message, which is
      sent when the SW's navigation fetch times out (1.5s). Sets a global
      flag that probeNetworkReachability() reads so it can skip its own HEAD
      request. The 'online' handler resets the flag when connectivity returns.
    -->
    <script>
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', function (e) {
          if (e.data && e.data.type === 'NETWORK_UNREACHABLE') {
            window.__stellarOffline = true;
          }
        });
      }
      window.addEventListener('online', function () {
        window.__stellarOffline = false;
      });
    </script>

    <!-- ================================================================= -->
    <!--                SERVICE WORKER REGISTRATION                        -->
    <!-- ================================================================= -->
    <!--
      Deferred registration strategy:
        - Uses \`requestIdleCallback\` (with \`setTimeout\` fallback) so the SW
          doesn't compete with first-paint work on the main thread.
        - After registration, sets up three update-check triggers:
            1. \`visibilitychange\` → check when tab becomes visible again
            2. \`setInterval\`      → every 5 minutes (iOS fallback — it doesn't
               reliably fire visibilitychange in standalone PWA mode)
            3. \`online\`           → check when connectivity is restored
    -->
    <script>
      if ('serviceWorker' in navigator) {
        // Use requestIdleCallback to defer SW registration until browser is idle
        var registerSW = function () {
          navigator.serviceWorker
            .register('/sw.js')
            .then(function (registration) {
              // Primary: check for updates when tab becomes visible
              document.addEventListener('visibilitychange', function () {
                if (document.visibilityState === 'visible') {
                  registration.update();
                }
              });
              // Fallback: periodic update check (iOS PWA doesn't fire visibilitychange reliably)
              setInterval(
                function () {
                  registration.update();
                },
                5 * 60 * 1000
              );
              // Also check when device comes back online
              window.addEventListener('online', function () {
                registration.update();
              });
            })
            .catch(function () {});
        };
        if ('requestIdleCallback' in window) {
          requestIdleCallback(registerSW);
        } else {
          setTimeout(registerSW, 1);
        }
      }
    </script>
  </body>
</html>
`;
}

// ---------------------------------------------------------------------------
//                     README GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a minimal `README.md` with project name, links to architecture
 * docs, and a quick-reference script table.
 *
 * @param opts - The install options containing `name`.
 * @returns The Markdown source for `README.md`.
 */
function generateReadme(opts: InstallOptions): string {
  return `# ${opts.name}

> See [ARCHITECTURE.md](./ARCHITECTURE.md) for project structure.
> See [FRAMEWORKS.md](./FRAMEWORKS.md) for framework decisions.

## Install as an App

This is a PWA (Progressive Web App) — install it on any device for quick access and an app-like experience.

### iOS (Safari)

1. Open the app in **Safari**.
2. Tap the **Share** button (square with arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**.

### Android (Chrome)

1. Open the app in **Chrome**.
2. Tap the **three-dot menu** (top right).
3. Tap **Add to Home screen** or **Install app**.
4. Confirm the installation.

### Desktop (Chrome / Edge)

1. Open the app in your browser.
2. Click the **install icon** in the address bar (or look for an install prompt).
3. Click **Install**.

Once installed, the app runs as a standalone window with full offline support.

---

## Getting Started

\`\`\`bash
cp .env.example .env   # Add your Supabase credentials
npm run dev             # Types auto-generate, Supabase auto-migrates
\`\`\`

## Environment Variables

Copy \`.env.example\` to \`.env\` and fill in:

| Variable | Where to find it | Required for |
|----------|-----------------|--------------|
| \`PUBLIC_SUPABASE_URL\` | Supabase Dashboard → Settings → API → Project URL | Client auth + data access |
| \`PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY\` | Supabase Dashboard → Settings → API → \`publishable\` key | Client auth + data access |
| \`DATABASE_URL\` | Supabase Dashboard → Settings → Database → Connection string (URI) | Auto schema sync (dev/build) |

> **Note:** \`DATABASE_URL\` is optional for local development. Without it, types still auto-generate but Supabase schema sync is skipped.

## Schema Workflow

\`src/lib/schema.ts\` is the single source of truth. When you edit it and save:

1. **TypeScript types** auto-generate at \`src/lib/types.generated.ts\`
2. **Supabase schema** auto-syncs via direct Postgres connection (when \`DATABASE_URL\` is set)
3. **IndexedDB (Dexie)** auto-upgrades on next page load (version hash changes)

The full idempotent schema SQL is pushed on every build — \`CREATE TABLE IF NOT EXISTS\`, \`ALTER TABLE ADD COLUMN IF NOT EXISTS\`, etc. This works in both \`npm run dev\` (file watcher) and \`npm run build\` (one-shot). No manual SQL is ever needed.

## Deploying to Vercel

The schema sync runs automatically during every \`vite build\`. To enable it on Vercel:

1. **Set environment variables** in Vercel (Settings > Environment Variables):

   | Variable | Type | Required |
   |----------|------|----------|
   | \`PUBLIC_SUPABASE_URL\` | Plain | Yes |
   | \`PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY\` | Plain | Yes |
   | \`DATABASE_URL\` | Secret | Yes — auto schema sync |

> **Security:** \`DATABASE_URL\` is only used server-side during the build. It is never bundled into client code. \`PUBLIC_SUPABASE_URL\` and \`PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY\` are served at runtime from \`/api/config\` — these are public keys protected by Supabase RLS.

## Scripts

| Command | Description |
|---------|-------------|
| \`npm run dev\` | Start development server |
| \`npm run build\` | Production build |
| \`npm run check\` | Type-check with svelte-check |
| \`npm run lint\` | Lint with ESLint |
| \`npm run format\` | Format with Prettier |
| \`npm run dead-code\` | Dead code detection with Knip |
| \`npm run cleanup\` | Auto-fix lint + format |
| \`npm run validate\` | Full validation (check + lint + dead-code) |

## Demo Mode

Visit \`/demo\` to try the app without creating an account. Demo mode runs in a completely isolated sandbox:

- Separate IndexedDB database — your real data is never touched
- No Supabase connections — zero network requests to the backend
- Data resets on page refresh — mock data is re-seeded each time

### Customizing Demo Data

Edit \`src/lib/demo/mockData.ts\` to populate the demo database with your app-specific mock data.
Edit \`src/lib/demo/config.ts\` to customize the mock user profile and trusted devices.
`;
}

// ---------------------------------------------------------------------------
//                   ARCHITECTURE DOC GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate an `ARCHITECTURE.md` describing the project stack and directory layout.
 *
 * @param opts - The install options containing `name`.
 * @returns The Markdown source for `ARCHITECTURE.md`.
 */
function generateArchitecture(opts: InstallOptions): string {
  return `# Architecture

## Overview

${opts.name} is an offline-first PWA built with SvelteKit 2 and Svelte 5, powered by \`stellar-drive\` for data sync and authentication.

## Stack

- **Framework**: SvelteKit 2 + Svelte 5
- **Sync Engine**: \`stellar-drive\` (IndexedDB + Supabase)
- **Backend**: Supabase (auth, Postgres, realtime)
- **PWA**: Custom service worker with smart caching

## Project Structure

\`\`\`
src/
  routes/              # SvelteKit routes
  lib/
    schema.ts          # Schema definition (single source of truth)
    types.ts           # App types (re-exports + narrowings from generated)
    types.generated.ts # Auto-generated entity types (do not edit)
    components/        # Svelte components
    stores/            # Svelte stores
    demo/              # Demo mode configuration and mock data
static/
  sw.js                # Service worker (generated by stellarPWA plugin)
  manifest.json        # PWA manifest
.env.example           # Environment variable template
\`\`\`

## Schema-Driven Workflow

\`src/lib/schema.ts\` is the single source of truth for the database. It drives three systems:

1. **TypeScript types** — auto-generated at \`src/lib/types.generated.ts\` on every dev save / build
2. **Supabase schema** — auto-synced via direct Postgres connection when \`DATABASE_URL\` is set in \`.env\`
3. **IndexedDB (Dexie)** — auto-versioned at runtime via hash-based version detection

### How it works

The full idempotent schema SQL (\`CREATE TABLE IF NOT EXISTS\`, \`ALTER TABLE ADD COLUMN IF NOT EXISTS\`, RLS, triggers, indexes) is pushed on every build. This is safe to run repeatedly — Postgres skips anything that already exists.

- **Dev mode** (\`npm run dev\`): The \`stellarPWA\` Vite plugin watches \`schema.ts\` for changes with 500ms debounce. Each save re-generates types and pushes the full schema SQL.
- **Production build** (\`npm run build\`): Same process runs once during \`buildStart\`. CI builds auto-sync Supabase without needing \`npm run dev\`.

### Environment variables

| Variable | Where to find it | Required for |
|----------|-----------------|--------------|
| \`PUBLIC_SUPABASE_URL\` | Supabase Dashboard → Settings → API → Project URL | Client auth + data |
| \`PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY\` | Supabase Dashboard → Settings → API → \`publishable\` key | Client auth + data |
| \`DATABASE_URL\` | Supabase Dashboard → Settings → Database → Connection string (URI) | Auto schema sync |

> \`DATABASE_URL\` is only used server-side during builds. It is never bundled into client code. Without it, types still auto-generate but Supabase schema sync is skipped.

### Deploying to Vercel

Set the env vars above in your Vercel project settings. The Vite plugin pushes the full idempotent schema SQL during every \`buildStart\` — no snapshots or state tracking needed.

## Demo Mode

Demo mode provides a completely isolated sandbox for trying the app:

- **Separate database**: Uses \`\${name}_demo\` IndexedDB — the real DB is never opened
- **No Supabase**: Zero network requests to the backend; no real session or API access
- **Mock auth**: \`authMode === 'demo'\` — protected routes work but only mock data is accessible
- **Auto-seeded**: Consumer's \`seedData(db)\` callback populates the demo DB on each page load
- **Full isolation**: \`setDemoMode()\` callers trigger a page reload for complete engine teardown

### Data flow

\`\`\`
User visits /demo → clicks "Start Demo"
  → setDemoMode(true) + window.location.href = '/'
  → initEngine() detects demo mode → creates \${name}_demo DB
  → resolveAuthState() returns authMode: 'demo'
  → seedDemoData() populates mock data
  → CRUD operations work against demo DB
  → Sync/queue/realtime guards prevent any Supabase traffic
\`\`\`
`;
}

// ---------------------------------------------------------------------------
//                   FRAMEWORKS DOC GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `FRAMEWORKS.md` documenting technology choices and rationale.
 *
 * @returns The Markdown source for `FRAMEWORKS.md`.
 */
function generateFrameworks(): string {
  return `# Framework Decisions

## SvelteKit 2 + Svelte 5

Svelte 5 introduces runes (\`$state\`, \`$derived\`, \`$effect\`, \`$props\`) for fine-grained reactivity. SvelteKit provides file-based routing, SSR, and the adapter system.

## stellar-drive

\`stellar-drive\` handles:
- **Offline-first data**: IndexedDB via Dexie with automatic sync to Supabase
- **Authentication**: Supabase Auth with offline mode support
- **Real-time sync**: Supabase Realtime subscriptions
- **Schema-driven workflow**: Single schema file drives TypeScript types, Supabase DDL, and IndexedDB versioning

## Schema Auto-Generation

The \`stellarPWA\` Vite plugin (\`schema: true\`) watches \`src/lib/schema.ts\` and:

1. **Generates TypeScript types** at \`src/lib/types.generated.ts\` — one interface per table with system columns (\`id\`, \`created_at\`, \`updated_at\`, \`deleted\`, \`_version\`, \`device_id\`)
2. **Pushes the full idempotent schema SQL to Supabase** via direct Postgres connection (requires \`DATABASE_URL\`)

This runs on every save in dev mode (500ms debounce) and once during production builds (including Vercel). Set \`DATABASE_URL\` in your CI/CD environment variables to enable auto schema sync on deploy.

### Field types

| Schema type | TypeScript | SQL |
|-------------|-----------|-----|
| \`'string'\` | \`string\` | \`text\` |
| \`'number'\` | \`number\` | \`double precision\` |
| \`'boolean'\` | \`boolean\` | \`boolean\` |
| \`'uuid'\` | \`string\` | \`uuid\` |
| \`'date'\` | \`string\` | \`date\` |
| \`'timestamp'\` | \`string\` | \`timestamptz\` |
| \`'json'\` | \`unknown\` | \`jsonb\` |
| \`'string?'\` | \`string \\| null\` | \`text\` (nullable) |
| \`['a', 'b']\` | \`'a' \\| 'b'\` | enum type |

### Type narrowing

Generated types use wide types (\`string\`, \`unknown\`). To narrow them in your app, use the \`Omit\` + extend pattern in \`src/lib/types.ts\`:

\`\`\`ts
import type { Task as GenTask } from './types.generated';
export type TaskStatus = 'active' | 'done';
export interface Task extends Omit<GenTask, 'status'> {
  status: TaskStatus;
}
\`\`\`

## Service Worker

Service worker (generated by \`stellarPWA\` Vite plugin) with:
- Immutable asset caching (content-hashed SvelteKit chunks)
- Versioned shell caching (HTML, manifest, icons)
- Network-first navigation with offline fallback
- Background precaching from asset manifest

## Dev Tools

- **ESLint** — flat config with TypeScript + Svelte support
- **Prettier** — with svelte plugin
- **Knip** — dead code detection
- **Husky** — pre-commit hooks

## Demo Mode

Demo mode uses stellar-drive's built-in demo system. Key files:

- \`src/lib/demo/config.ts\` — \`DemoConfig\` object passed to \`initEngine({ demo })\`
- \`src/lib/demo/mockData.ts\` — \`seedData(db)\` callback that populates the demo database
- \`src/routes/demo/+page.svelte\` — Landing page with Start/Exit Demo buttons

### Mock Data Seeding

The \`seedData(db)\` function receives the sandboxed Dexie instance. Use \`db.table('name').bulkPut([...])\` to populate each table. The function runs once per page load (idempotent).

### Generated Files

The \`stellar-drive install pwa\` scaffolding generates these demo-related files:

| File | Purpose |
|------|---------|
| \`src/lib/demo/config.ts\` | Demo config with mock profile |
| \`src/lib/demo/mockData.ts\` | Seed function (customize with your data) |
| \`src/routes/demo/+page.svelte\` | Demo landing page |
`;
}

// ---------------------------------------------------------------------------
//                     GITIGNORE GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `.gitignore` tailored for SvelteKit PWA projects.
 * Excludes build artifacts, generated SW files, and environment secrets.
 *
 * @returns The gitignore content string.
 */
function generateGitignore(): string {
  return `node_modules
.DS_Store
/build
/.svelte-kit
/package
.env
.env.*
!.env.example
vite.config.js.timestamp-*
vite.config.ts.timestamp-*

# Generated by stellarPWA vite plugin
static/sw.js
static/asset-manifest.json
src/lib/types.generated.ts
`;
}

// ---------------------------------------------------------------------------
//                   OFFLINE HTML GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a placeholder offline fallback page (`static/offline.html`).
 * The service worker serves this when no cached HTML is available.
 *
 * @param opts - The install options containing `name`.
 * @returns The HTML source for `static/offline.html`.
 */
function generateOfflineHtml(opts: InstallOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Offline — ${opts.name}</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background-color: #111116;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      color: #eeeef0;
      padding: 24px;
    }
    .card {
      max-width: 480px;
      width: 100%;
      background-color: #1a1a22;
      border: 1px solid #2a2a35;
      border-radius: 8px;
      overflow: hidden;
    }
    .card-accent {
      height: 3px;
      background: linear-gradient(90deg, #6B9E6B, #7ab87a);
    }
    .card-body {
      padding: 44px 40px 40px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .app-name {
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 1.8px;
      text-transform: uppercase;
      color: #6b6b78;
      margin-bottom: 32px;
    }
    .icon {
      width: 48px;
      height: 48px;
      color: #6B9E6B;
      margin-bottom: 24px;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.3px;
      color: #eeeef0;
      margin-bottom: 12px;
    }
    p {
      font-size: 15px;
      line-height: 1.6;
      color: #9494a3;
      margin-bottom: 32px;
    }
    button {
      padding: 14px 36px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.3px;
      color: #fff;
      background: #6B9E6B;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: opacity 0.15s, transform 0.15s;
    }
    button:hover { opacity: 0.88; transform: translateY(-1px); }
    button:active { transform: translateY(0); }
    @media (max-width: 480px) {
      .card { border-radius: 0; border-left: none; border-right: none; }
      .card-body { padding: 36px 24px 32px; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-accent"></div>
    <div class="card-body">
      <p class="app-name">${opts.name}</p>
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
        <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
        <circle cx="12" cy="20" r="1"/>
      </svg>
      <h1>You're Offline</h1>
      <p>Check your connection and try again.</p>
      <button onclick="location.reload()">Try Again</button>
    </div>
  </div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
//                  PLACEHOLDER SVG GENERATORS
// ---------------------------------------------------------------------------

/**
 * Generate a placeholder app icon SVG with a coloured background and
 * a centred text label (typically a single letter).
 *
 * @param color - The background fill colour (e.g., `'#6c5ce7'`).
 * @param label - The text to display (e.g., `'M'` for "My App").
 * @param fontSize - The font size for the label (default: 64).
 * @returns The SVG markup string.
 */
function generatePlaceholderSvg(color: string, label: string, fontSize: number = 64): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="${color}"/>
  <text x="256" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="700" fill="white">${label}</text>
</svg>
`;
}

/**
 * Generate a monochrome (white background, black text) icon SVG.
 * Used for the `monochrome` icon variant in the PWA manifest.
 *
 * @param label - The text to display.
 * @returns The SVG markup string.
 */
function generateMonochromeSvg(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="#ffffff"/>
  <text x="256" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="64" font-weight="700" fill="black">${label}</text>
</svg>
`;
}

/**
 * Generate a splash screen SVG with a dark background and the app's short name.
 *
 * @param label - The text to display (typically `shortName`).
 * @returns The SVG markup string.
 */
function generateSplashSvg(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="#0f0f1a"/>
  <text x="256" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="48" font-weight="700" fill="white">${label}</text>
</svg>
`;
}

// ---------------------------------------------------------------------------
//                       APP CSS GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate shared app.css with common UI component styles.
 *
 * @returns The CSS source for `src/app.css`.
 */
function generateAppCss(): string {
  return `/* Buttons */
.btn-primary {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0.875rem 1.5rem; font-size: 0.9375rem; font-weight: 600;
  background-color: #6B9E6B; color: #ffffff; border: none;
  border-radius: 10px; cursor: pointer; transition: opacity 0.15s, background-color 0.15s;
  text-decoration: none; width: 100%;
}
.btn-primary:hover { background-color: #5a8f5a; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0.875rem 1.5rem; font-size: 0.9375rem; font-weight: 600;
  background: transparent; color: #c8c8e0;
  border: 1.5px solid #3d5a3d; border-radius: 10px;
  cursor: pointer; transition: opacity 0.15s, border-color 0.15s;
  text-decoration: none; width: 100%;
}
.btn-secondary:hover { border-color: #6B9E6B; }
.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-danger {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0.875rem 1.5rem; font-size: 0.9375rem; font-weight: 600;
  background: transparent; color: #e07070;
  border: 1.5px solid #7a3d3d; border-radius: 10px;
  cursor: pointer; transition: opacity 0.15s, border-color 0.15s;
  text-decoration: none; width: 100%;
}
.btn-danger:hover { border-color: #e07070; }
.btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }

/* Form fields */
.form-group { display: flex; flex-direction: column; gap: 0.375rem; }
.form-group label {
  font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.08em;
  color: #7878a0; font-weight: 600;
}
.form-group input {
  width: 100%; padding: 0.75rem 1rem; box-sizing: border-box;
  background-color: #1a1a22; color: #f0f0ff;
  border: 1.5px solid #3d5a3d; border-radius: 10px;
  font-size: 0.9375rem; outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.form-group input:focus {
  border-color: #6B9E6B;
  box-shadow: 0 0 0 3px rgba(107, 158, 107, 0.25);
}
.form-group input::placeholder { color: #4a4a68; }
.form-group input:disabled { opacity: 0.5; cursor: not-allowed; }

/* PIN inputs */
.pin-row {
  display: flex; gap: 0.5rem;
  justify-content: center; align-items: center;
}
.pin-digit {
  width: 48px; height: 56px;
  text-align: center; font-size: 1.375rem; font-weight: 600;
  background-color: #1a1a22; color: #f0f0ff;
  border: 1.5px solid #3d5a3d; border-radius: 10px;
  outline: none; transition: border-color 0.15s, box-shadow 0.15s;
  -webkit-appearance: none; -moz-appearance: textfield;
}
.pin-digit::-webkit-outer-spin-button,
.pin-digit::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.pin-digit:focus {
  border-color: #6B9E6B;
  box-shadow: 0 0 0 3px rgba(107, 158, 107, 0.25);
}
.pin-digit:disabled { opacity: 0.5; cursor: not-allowed; }

/* Spinner */
.spinner {
  width: 20px; height: 20px;
  border: 2px solid rgba(107, 158, 107, 0.2);
  border-top-color: #6B9E6B;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Modal */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  padding: 1rem;
}
.modal-card {
  width: 100%; max-width: 400px;
  background: #0f0f1e; border: 1px solid #3d5a3d;
  border-radius: 20px; padding: 1.75rem;
  display: flex; flex-direction: column; gap: 0.75rem;
}
.modal-title { font-size: 1.125rem; font-weight: 700; color: #f0f0ff; }
.modal-text { font-size: 0.9375rem; color: #c8c8e0; line-height: 1.6; }
.modal-hint { font-size: 0.8125rem; color: #7878a0; }

/* Status messages */
.msg-error {
  padding: 0.75rem 1rem; border-radius: 10px;
  background-color: #2e1a1a; border: 1px solid #7a3d3d;
  color: #e07070; font-size: 0.875rem;
}
.msg-success {
  padding: 0.75rem 1rem; border-radius: 10px;
  background-color: #1a2e1a; border: 1px solid #3d5a3d;
  color: #6B9E6B; font-size: 0.875rem;
}
`;
}

// ---------------------------------------------------------------------------
//                       EMAIL TEMPLATE GENERATORS
// ---------------------------------------------------------------------------

/**
 * Generate the signup confirmation email HTML template.
 *
 * Uses `{{ .Data.app_name }}` and `{{ .Data.app_domain }}` (from Supabase
 * user_metadata) so the template works without any Supabase dashboard
 * configuration — important for self-hosted deployments.
 *
 * @returns The HTML source for the signup confirmation email.
 */
function generateSignupEmail(): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Confirm Your Email</title>
  <style>
    @media (prefers-color-scheme: dark) {
      body, .email-wrapper { background-color: #111116 !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background-color: #111116; color: #eeeef0;">
  <table class="email-wrapper" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #111116;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px; width: 100%;">
          <tr>
            <td align="center" style="padding-bottom: 24px; font-size: 13px; font-weight: 600; color: #6b6b78; text-transform: uppercase; letter-spacing: 1.8px;">
              {{ .Data.app_name }}
            </td>
          </tr>
          <tr>
            <td style="background-color: #1a1a22; border: 1px solid #2a2a35; border-radius: 8px; overflow: hidden;">
              <div style="height: 3px; background: linear-gradient(90deg, #D4A853, #c49a45);"></div>
              <div style="padding: 36px 40px 40px;">
                <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #eeeef0; text-align: center;">Confirm Your Email</h1>
                <p style="margin: 0 0 28px 0; font-size: 15px; line-height: 1.6; color: #9494a3; text-align: center;">Welcome to {{ .Data.app_name }}! Click the button below to verify your email address and get started.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="padding-bottom: 28px;">
                      <a href="{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&type=signup" target="_blank" style="display: inline-block; padding: 14px 36px; font-size: 15px; font-weight: 600; color: #ffffff; background-color: #D4A853; text-decoration: none; border-radius: 8px;">Verify Email Address</a>
                    </td>
                  </tr>
                </table>
                <hr style="border: none; border-top: 1px solid #2a2a35; margin: 0 0 20px 0;">
                <p style="margin: 0 0 8px 0; font-size: 12px; color: #4e4e5c; text-align: center;">Or copy and paste this link into your browser:</p>
                <p style="margin: 0; font-size: 11px; word-break: break-all; text-align: center; font-family: monospace;"><a href="{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&type=signup" style="color: #D4A853;">{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&amp;type=signup</a></p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding-top: 24px; text-align: center;">
              <p style="margin: 0 0 6px 0; font-size: 12px; color: #4e4e5c;">This link will expire in 24 hours.</p>
              <p style="margin: 0 0 12px 0; font-size: 12px; color: #4e4e5c;">If you didn't create an account, you can safely ignore this email.</p>
              <p style="margin: 0; font-size: 11px; color: #3a3a47;">&copy; {{ .Data.app_name }}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

function generateChangeEmail(): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Confirm Your New Email</title>
  <style>
    @media (prefers-color-scheme: dark) {
      body, .email-wrapper { background-color: #111116 !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background-color: #111116; color: #eeeef0;">
  <table class="email-wrapper" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #111116;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px; width: 100%;">
          <tr>
            <td align="center" style="padding-bottom: 24px; font-size: 13px; font-weight: 600; color: #6b6b78; text-transform: uppercase; letter-spacing: 1.8px;">
              {{ .Data.app_name }}
            </td>
          </tr>
          <tr>
            <td style="background-color: #1a1a22; border: 1px solid #2a2a35; border-radius: 8px; overflow: hidden;">
              <div style="height: 3px; background: linear-gradient(90deg, #D4A853, #c49a45);"></div>
              <div style="padding: 36px 40px 40px;">
                <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #eeeef0; text-align: center;">Confirm Your New Email</h1>
                <p style="margin: 0 0 28px 0; font-size: 15px; line-height: 1.6; color: #9494a3; text-align: center;">You requested to change your email address. Click the button below to confirm this new email for your {{ .Data.app_name }} account.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="padding-bottom: 28px;">
                      <a href="{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&type=email_change" target="_blank" style="display: inline-block; padding: 14px 36px; font-size: 15px; font-weight: 600; color: #ffffff; background-color: #D4A853; text-decoration: none; border-radius: 8px;">Confirm New Email</a>
                    </td>
                  </tr>
                </table>
                <hr style="border: none; border-top: 1px solid #2a2a35; margin: 0 0 20px 0;">
                <p style="margin: 0 0 8px 0; font-size: 12px; color: #4e4e5c; text-align: center;">Or copy and paste this link into your browser:</p>
                <p style="margin: 0; font-size: 11px; word-break: break-all; text-align: center; font-family: monospace;"><a href="{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&type=email_change" style="color: #D4A853;">{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&amp;type=email_change</a></p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding-top: 24px; text-align: center;">
              <p style="margin: 0 0 6px 0; font-size: 12px; color: #4e4e5c;">This link will expire in 24 hours.</p>
              <p style="margin: 0 0 12px 0; font-size: 12px; color: #4e4e5c;">If you didn't request this change, you can safely ignore this email.</p>
              <p style="margin: 0; font-size: 11px; color: #3a3a47;">&copy; {{ .Data.app_name }}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

function generateDeviceVerificationEmail(): string {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>Verify Your Device</title>
  <style>
    @media (prefers-color-scheme: dark) {
      body, .email-wrapper { background-color: #111116 !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background-color: #111116; color: #eeeef0;">
  <table class="email-wrapper" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #111116;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="max-width: 520px; width: 100%;">
          <tr>
            <td align="center" style="padding-bottom: 24px; font-size: 28px; font-weight: 800; color: #6B9E6B;">
              {{ .Data.app_name }}
            </td>
          </tr>
          <tr>
            <td style="background-color: #1a1a22; border: 1px solid #2a2a35; border-radius: 8px; overflow: hidden;">
              <div style="height: 3px; background-color: #6B9E6B;"></div>
              <div style="padding: 36px 40px 40px;">
                <h1 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 700; color: #eeeef0; text-align: center;">Verify Your Device</h1>
                <p style="margin: 0 0 28px 0; font-size: 15px; line-height: 1.6; color: #9494a3; text-align: center;">A sign-in attempt was made from a new device. Click the button below to verify this device and grant it access to your {{ .Data.app_name }} account.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="padding-bottom: 28px;">
                      <a href="{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&type=email" target="_blank" style="display: inline-block; padding: 14px 36px; font-size: 15px; font-weight: 600; color: #ffffff; background-color: #6B9E6B; text-decoration: none; border-radius: 8px;">Verify This Device</a>
                    </td>
                  </tr>
                </table>
                <hr style="border: none; border-top: 1px solid #2a2a35; margin: 0 0 20px 0;">
                <p style="margin: 0 0 8px 0; font-size: 12px; color: #4e4e5c; text-align: center;">Or copy and paste this link into your browser:</p>
                <p style="margin: 0; font-size: 11px; word-break: break-all; text-align: center; font-family: monospace;"><a href="{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&type=email" style="color: #D4A853;">{{ .Data.app_domain }}/confirm?token_hash={{ .TokenHash }}&amp;type=email</a></p>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding-top: 24px; text-align: center;">
              <p style="margin: 0 0 6px 0; font-size: 12px; color: #4e4e5c;">This link will expire in 24 hours.</p>
              <p style="margin: 0 0 12px 0; font-size: 12px; color: #4e4e5c;">If you didn't attempt to sign in, someone may have your code. Consider changing it immediately.</p>
              <p style="margin: 0; font-size: 11px; color: #3a3a47;">&copy; {{ .Data.app_name }}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
//                   ESLINT CONFIG GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate an ESLint flat config with TypeScript and Svelte support.
 *
 * @returns The JavaScript source for `eslint.config.js`.
 */
function generateEslintConfig(): string {
  return `import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: ts.parser
      }
    },
    rules: {
      // Svelte 5 uses let for $props() destructuring by convention
      'prefer-const': 'off'
    }
  },
  {
    files: ['**/*.ts', '**/*.js'],
    rules: {
      'prefer-const': 'error'
    }
  },
  {
    rules: {
      // TypeScript
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }],
      '@typescript-eslint/no-explicit-any': 'warn',

      // General - allow console.log for debugging, only flag in production builds
      'no-console': 'off',
      'no-var': 'error',

      // Svelte - relax some rules for flexibility
      'svelte/no-at-html-tags': 'warn',
      'svelte/valid-compile': ['error', { ignoreWarnings: true }],
      'svelte/require-each-key': 'warn',
      'svelte/no-navigation-without-resolve': 'off',  // Too strict for app navigation patterns
      'svelte/prefer-svelte-reactivity': 'off',  // SvelteDate/SvelteSet/SvelteMap not always needed
      'svelte/no-unused-svelte-ignore': 'warn'  // Downgrade to warning
    }
  },
  {
    ignores: [
      '.svelte-kit/**',
      'build/**',
      'dist/**',
      'node_modules/**',
      'static/**',
      '*.config.js',
      '*.config.ts'
    ]
  }
];
`;
}

// ---------------------------------------------------------------------------
//                   PRETTIER CONFIG GENERATORS
// ---------------------------------------------------------------------------

/**
 * Generate a `.prettierrc` with SvelteKit-friendly defaults.
 *
 * @returns The JSON string for `.prettierrc`.
 */
function generatePrettierrc(): string {
  return (
    JSON.stringify(
      {
        useTabs: false,
        tabWidth: 2,
        singleQuote: true,
        trailingComma: 'none',
        printWidth: 100,
        plugins: ['prettier-plugin-svelte'],
        overrides: [
          {
            files: '*.svelte',
            options: {
              parser: 'svelte'
            }
          }
        ]
      },
      null,
      2
    ) + '\n'
  );
}

/**
 * Generate a `.prettierignore` excluding build artifacts and generated files.
 *
 * @returns The prettierignore content string.
 */
function generatePrettierignore(): string {
  return `.svelte-kit
build
dist
node_modules
static
*.md
package-lock.json
`;
}

// ---------------------------------------------------------------------------
//                     KNIP CONFIG GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `knip.json` for dead code detection in a SvelteKit project.
 *
 * @returns The JSON string for `knip.json`.
 */
function generateKnipJson(): string {
  return (
    JSON.stringify(
      {
        $schema: 'https://unpkg.com/knip@latest/schema.json',
        entry: ['src/routes/**/*.{svelte,ts,js}', 'src/lib/**/*.{svelte,ts,js}'],
        project: ['src/**/*.{svelte,ts,js}'],
        sveltekit: {
          config: 'svelte.config.js'
        },
        ignoreDependencies: ['stellar-drive', 'postgres', 'dexie']
      },
      null,
      2
    ) + '\n'
  );
}

// ---------------------------------------------------------------------------
//                    HUSKY PRE-COMMIT GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate the Husky pre-commit hook script that runs cleanup and validation.
 *
 * @returns The shell script content for `.husky/pre-commit`.
 */
function generateHuskyPreCommit(): string {
  return `npm run cleanup && npm run validate && git add -u
`;
}

// ---------------------------------------------------------------------------
//                    ROOT LAYOUT GENERATORS
// ---------------------------------------------------------------------------

/**
 * Generate the root `+layout.ts` with runtime config initialisation,
 * auth state resolution, and sync engine startup.
 *
 * @param opts - The install options containing `name` and `prefix`.
 * @returns The TypeScript source for `src/routes/+layout.ts`.
 */
function generateRootLayoutTs(opts: InstallOptions): string {
  return `/**
 * @fileoverview Root layout loader — engine bootstrap + auth resolution.
 *
 * Runs on every navigation. In the browser it initialises runtime config,
 * resolves the current auth state (online session or offline credentials),
 * and starts the sync engine when the user is authenticated.
 */

// =============================================================================
//                                  IMPORTS
// =============================================================================

import { browser } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { goto } from '$app/navigation';
import { initEngine, probeNetworkReachability } from 'stellar-drive';
import { resolveRootLayout } from 'stellar-drive/kit';
import { isSafeRedirect } from 'stellar-drive/utils';
import { schema } from '$lib/schema';
import { demoConfig } from '$lib/demo/config';
import { ROUTES } from '$lib/routes';
import type { RootLayoutData } from 'stellar-drive/kit';
import type { LayoutLoad } from './$types';

// =============================================================================
//                          SVELTEKIT ROUTE CONFIG
// =============================================================================

/** Allow server-side rendering for initial page load performance. */
export const ssr = true;
/** Disable prerendering — pages depend on runtime auth state. */
export const prerender = false;

// =============================================================================
//                             TYPE RE-EXPORTS
// =============================================================================

/** Re-export the root layout data type so \`+layout.svelte\` can import it. */
export type { RootLayoutData as LayoutData };

// =============================================================================
//                          ENGINE BOOTSTRAP
// =============================================================================

/**
 * Initialize the sync engine at module scope (runs once on first navigation).
 * The schema in $lib/schema.ts is the single source of truth — it drives:
 *   - Dexie (IndexedDB) stores and versioning
 *   - TypeScript types auto-generated at src/lib/types.generated.ts
 *   - Supabase schema auto-migrated during \`npm run dev\`
 */
if (browser) {
  initEngine({
    prefix: '${opts.prefix}',
    name: '${opts.name}',
    domain: window.location.origin,
    schema,
    auth: { gateType: 'code' },
    demo: demoConfig,
    onAuthStateChange: (event, session) => {
      if (event === 'SIGNED_IN' && session) {
        const path = window.location.pathname;
        /* Skip ROUTES.LOGIN (handles its own post-auth flow) and ROUTES.CONFIRM
           (verifyOtp fires SIGNED_IN inside the confirm tab — navigating
           away would interrupt the broadcast-then-close flow mid-flight). */
        if (!path.startsWith(ROUTES.LOGIN) && !path.startsWith(ROUTES.CONFIRM)) {
          goto(path, { invalidateAll: true });
        }
      }
    },
    onAuthKicked: async () => {
      const { signOut } = await import('stellar-drive/auth');
      await signOut();
      goto(ROUTES.LOGIN);
    }
  });
}

// =============================================================================
//                         PUBLIC ROUTES
// =============================================================================

/** Routes accessible without authentication. */
const PUBLIC_ROUTES = [ROUTES.POLICY, ROUTES.LOGIN, ROUTES.DEMO, ROUTES.CONFIRM, ROUTES.SETUP];

// =============================================================================
//                            LOAD FUNCTION
// =============================================================================

/**
 * Root layout load — initialises config, resolves auth, and starts sync.
 *
 * @param params - SvelteKit load params (provides the current URL).
 * @returns Layout data with session and auth state.
 */
export const load: LayoutLoad = async ({ url }): Promise<RootLayoutData> => {
  if (browser) {
    /* Probe actual network reachability ONCE before any startup code.
       Sets the offline flag so initConfig(), resolveAuthState(), and
       getSession() can skip network calls synchronously. If the SW has
       already set the flag via NETWORK_UNREACHABLE postMessage, the probe
       returns immediately without a network request. */
    await probeNetworkReachability();
    const result = await resolveRootLayout();

    if (result.authMode === 'none') {
      if (!result.serverConfigured && !url.pathname.startsWith(ROUTES.SETUP) && !url.pathname.startsWith(ROUTES.POLICY)) {
        redirect(307, ROUTES.SETUP);
      } else if (result.serverConfigured) {
        const isPublicRoute = PUBLIC_ROUTES.some(r => url.pathname.startsWith(r));
        if (!isPublicRoute) {
          const returnUrl = url.pathname + url.search;
          const loginUrl = returnUrl && returnUrl !== ROUTES.HOME && isSafeRedirect(returnUrl)
            ? \`\${ROUTES.LOGIN}?redirect=\${encodeURIComponent(returnUrl)}\`
            : ROUTES.LOGIN;
          redirect(307, loginUrl);
        }
      }
    }

    return result;
  }

  /* SSR fallback — no auth info available on the server */
  return { session: null, authMode: 'none', offlineProfile: null, serverConfigured: false };
};
`;
}

/**
 * Generate the root `+layout.svelte` with auth state hydration and TODO stubs.
 *
 * @returns The Svelte component source for `src/routes/+layout.svelte`.
 */
function generateRootLayoutSvelte(opts: InstallOptions): string {
  return `<!--
  @fileoverview Root layout component — app shell, auth hydration,
  navigation chrome, overlays, and PWA lifecycle.

  This is the outermost Svelte component. It wraps every page and is
  responsible for hydrating auth state from the load function, rendering
  the navigation bar / tab bar, and mounting global overlays like the
  service-worker update prompt.
-->
<script lang="ts">
  /**
   * @fileoverview Root layout script — auth state management, navigation logic,
   * service worker communication, and global event handlers.
   */

  // =============================================================================
  //  Imports
  // =============================================================================

  /* ── Global Styles ── */
  import '../app.css';

  /* ── SvelteKit Utilities ── */
  import { page } from '$app/stores';
  import { goto, afterNavigate } from '$app/navigation';

  /* ── Stellar Engine — Auth & Stores ── */
  import { lockSingleUser, resolveFirstName, resolveAvatarInitial } from 'stellar-drive/auth';
  import { authState } from 'stellar-drive/stores';
  import { debug } from 'stellar-drive/utils';
  import { hydrateAuthState } from 'stellar-drive/kit';
  import { isDemoMode, showDemoBlocked } from 'stellar-drive/demo';
  import { scrollGuard } from 'stellar-drive/actions';
  import SyncStatus from 'stellar-drive/components/SyncStatus';
  import OfflineToast from 'stellar-drive/components/OfflineToast';
  import DemoBanner from 'stellar-drive/components/DemoBanner';
  import DemoBlockedMessage from 'stellar-drive/components/DemoBlockedMessage';
  import OfflineBanner from 'stellar-drive/components/OfflineBanner';
  import GlobalToast from 'stellar-drive/components/GlobalToast';
  import UpdatePrompt from '$lib/components/UpdatePrompt.svelte';

  /* ── Types ── */
  import type { LayoutData } from './+layout';

  /* ── Route Constants ── */
  import { ROUTES } from '$lib/routes';

  // =============================================================================
  //  Props
  // =============================================================================

  interface Props {
    /** Default slot content — the matched page component. */
    children?: import('svelte').Snippet;

    /** Layout data from \`+layout.ts\` — session, auth mode, offline profile. */
    data: LayoutData;
  }

  let { children, data }: Props = $props();

  // =============================================================================
  //  Component State
  // =============================================================================

  /* ── Sign-Out ── */
  /** When \`true\`, a full-screen overlay is shown to mask the sign-out transition. */
  let isSigningOut = $state(false);

  /* ── Data Bootstrap ── */
  /** Flips to \`true\` once all collection stores are loaded from IndexedDB. */
  let dataReady = $state(false);

  // =============================================================================
  //  App Bootstrap
  // =============================================================================

  /**
   * Preloads all collection stores from IndexedDB in parallel.
   * Returns a cached promise so subsequent calls are no-ops.
   *
   * After adding stores to src/lib/stores/data.ts, import preloadAllStores
   * and replace the empty Promise.all below:
   *
   *   import { preloadAllStores } from '$lib/stores/data';
   *   // then replace the function body with:
   *   if (initPromise) return initPromise;
   *   initPromise = preloadAllStores();
   *   return initPromise;
   *
   * See src/lib/stores/data.ts for the full store factory pattern including
   * onSyncComplete + onRealtimeDataUpdate wiring.
   */
  let initPromise: Promise<void> | null = null;
  function initializeApp(): Promise<void> {
    if (initPromise) return initPromise;
    initPromise = Promise.all([
      // TODO: Add your collection store .load() calls here, e.g.:
      // itemsStore.load(),
      // categoriesStore.load(),
      // Or use preloadAllStores() from '$lib/stores/data' (see comment above)
    ]).then(() => {
      debug('log', '[INIT] Stores loaded from IndexedDB — page ready');
    });
    return initPromise;
  }

  // =============================================================================
  //  Reactive Effects
  // =============================================================================

  /**
   * Effect: hydrate the global \`authState\` store from layout load data.
   *
   * Runs whenever \`data\` changes (e.g. after navigation or revalidation).
   * Maps the three possible auth modes to the corresponding store setter:
   * - \`'supabase'\` + session → \`setSupabaseAuth\`
   * - \`'offline'\` + cached profile → \`setOfflineAuth\`
   * - anything else → \`setNoAuth\`
   */
  $effect(() => {
    hydrateAuthState(data);
  });

  // Scroll to top on NEW page navigation. Skip same-pathname navigations (data
  // revalidations, focus events) so the page doesn't jump on tab/window focus.
  // Must target document.body directly — html has overflow:hidden so window.scrollTo
  // targets document.documentElement which cannot scroll and is a guaranteed no-op.
  afterNavigate((nav) => {
    if (nav.from?.url.pathname !== nav.to?.url.pathname) {
      document.body.scrollTop = 0;
    }
  });

  /**
   * Effect: once authenticated, preload all collection stores from IndexedDB
   * so nav pages render with data immediately (no per-page loading spinners).
   */
  $effect(() => {
    if (data.authMode !== 'none') {
      initializeApp().then(() => {
        dataReady = true;
      });
    }
  });

  // =============================================================================
  //  Lifecycle — Event Listeners & Service Worker
  // =============================================================================

  $effect(() => {
    // ── Sign-Out Event Listener ───────────────────────────────────────────
    // Listen for sign out requests from child pages (e.g. mobile profile page)
    window.addEventListener('${opts.prefix}:signout', handleSignOut);

    // ── Service Worker — Background Precaching ────────────────────────────
    // Proactively cache all app chunks for full offline support.
    // This runs in the background after page load, so it doesn't affect Lighthouse scores.
    if ('serviceWorker' in navigator) {
      // Listen for precache completion messages from service worker
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'PRECACHE_COMPLETE') {
          const { cached, total } = event.data;
          debug('log', \`[PWA] Background precaching complete: \${cached}/\${total} assets cached\`);
          if (cached === total) {
            debug('log', '[PWA] Full offline support ready - all pages accessible offline');
          } else {
            debug('warn', \`[PWA] Some assets failed to cache: \${total - cached} missing\`);
          }
        }
      });

      // Wait for service worker to be ready (handles first load case)
      navigator.serviceWorker.ready.then((registration) => {
        debug('log', '[PWA] Service worker ready, scheduling background precache...');

        // Give the page time to fully load, then trigger background precaching
        setTimeout(() => {
          const controller = navigator.serviceWorker.controller || registration.active;
          if (!controller) {
            debug('warn', '[PWA] No service worker controller available');
            return;
          }

          // First, cache current page's assets (scripts + stylesheets)
          const scripts = Array.from(document.querySelectorAll('script[src]'))
            .map((el) => (el as HTMLScriptElement).src)
            .filter((src) => src.startsWith(location.origin));

          const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
            .map((el) => (el as HTMLLinkElement).href)
            .filter((href) => href.startsWith(location.origin));

          const urls = [...scripts, ...styles];

          if (urls.length > 0) {
            debug('log', \`[PWA] Caching \${urls.length} current page assets...\`);
            controller.postMessage({
              type: 'CACHE_URLS',
              urls
            });
          }

          // Then trigger full background precaching for all app chunks.
          // This ensures offline support for all pages, not just visited ones.
          debug('log', '[PWA] Triggering background precache of all app chunks...');
          controller.postMessage({
            type: 'PRECACHE_ALL'
          });
        }, 500); // Cache assets quickly to reduce window for uncached refreshes
      });
    }

    return () => {
      window.removeEventListener('${opts.prefix}:signout', handleSignOut);
    };
  });

  // =============================================================================
  //  Event Handlers
  // =============================================================================

  /**
   * Handles the sign-out flow with a visual transition.
   *
   * 1. Shows a full-screen "Locking..." overlay immediately.
   * 2. Waits 250ms for the overlay fade-in to complete.
   * 3. Calls \`lockSingleUser()\` to stop the engine and clear the session
   *    (but NOT destroy user data).
   * 4. Hard-navigates to \`/login\` (full page reload to reset all state).
   */
  async function handleSignOut() {
    if (isDemoMode()) {
      showDemoBlocked('Sign out is not available in demo mode');
      return;
    }

    // Show full-screen overlay immediately
    isSigningOut = true;

    // Wait for overlay to fully appear
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Lock the single-user session (stops engine, resets auth state, does NOT destroy data)
    await lockSingleUser();

    // Client-side navigate to login — keeps the layout mounted so the
    // sign-out overlay persists seamlessly (no flicker between pages).
    await goto(ROUTES.LOGIN, { invalidateAll: true });

    // Dismiss the overlay now that the login page has rendered underneath
    await new Promise((resolve) => setTimeout(resolve, 100));
    isSigningOut = false;
  }

  // =============================================================================
  //  Derived State
  // =============================================================================

  /**
   * Public/auth pages that should hide the authenticated app shell.
   * Keep this separate from nav-route preloading.
   */
  const isOnLoginPage = $derived($page.url.pathname.startsWith('/login'));
  const isOnSetupPage = $derived($page.url.pathname.startsWith('/setup'));
  const isOnDemoPage = $derived($page.url.pathname === '/demo');
  const isOnPolicyPage = $derived($page.url.pathname.startsWith('/policy'));
  const isOnConfirmPage = $derived($page.url.pathname.startsWith('/confirm'));
  const isSetupNoAuth = $derived(isOnSetupPage && data.authMode === 'none');
  const isAuthPage = $derived(
    isOnLoginPage || isSetupNoAuth || isOnDemoPage || isOnPolicyPage || isOnConfirmPage
  );
  const isAuthenticated = $derived(
    data.authMode !== 'none' && !isAuthPage && !$authState.isLoading
  );

  /**
   * Nav routes whose rendering depends on collection stores being loaded.
   * Add your app's nav route prefixes here.
   */
  const NAV_ROUTES = ['/'];
  const isNavPage = $derived(
    NAV_ROUTES.some((r) =>
      r === '/' ? $page.url.pathname === '/' : $page.url.pathname.startsWith(r)
    )
  );

  /** Show the loading overlay while auth resolves OR while stores load for nav pages. */
  const showLoader = $derived(
    $authState.isLoading || (data.authMode !== 'none' && isNavPage && !dataReady)
  );

  /** User's first name for the greeting. */
  const greeting = $derived(resolveFirstName(data.session, data.offlineProfile, 'there'));

  /** Single uppercase initial for avatar circles. */
  const avatarInitial = $derived(resolveAvatarInitial(data.session, data.offlineProfile, '?'));

  /**
   * Checks whether a given route \`href\` matches the current page path.
   * Used to highlight the active nav item.
   *
   * @param href - The route path to check (e.g. \`'/agenda'\`)
   * @returns \`true\` if the current path starts with \`href\`
   */
  function isActive(href: string): boolean {
    if (href === '/') return $page.url.pathname === '/';
    return $page.url.pathname.startsWith(href);
  }

  /**
   * Navigation items shared between the desktop top nav and mobile tab bar.
   * Add your app's routes here — both navs render from this single array.
   * TODO: Replace with your app's actual nav routes and icons.
   */
  const navItems: { href: string; label: string; icon: string }[] = [
    // TODO: Add your app's nav routes here. Both desktop and mobile navs render from this array.
    // Example: { href: '/dashboard', label: 'Dashboard', icon: 'dashboard' }
  ];

</script>

<!-- Loading Overlay -->
{#if showLoader}
  <div class="app-loader">
    <div class="loader-content">
      <span class="loader-spinner"></span>
      <span class="loader-name">${opts.name}</span>
    </div>
  </div>
{/if}

<!-- Sign-out transition overlay -->
{#if isSigningOut}
  <div class="signout-overlay">
    <div class="loader-content">
      <span class="loader-spinner"></span>
      <span class="loader-name">Locking...</span>
    </div>
  </div>
{/if}

<!-- App shell: only shown on authenticated non-auth pages -->
{#if isAuthenticated}
  <!-- Desktop: top navbar -->
  <nav class="top-nav" aria-label="Main navigation">
    <div class="top-nav-inner">
      <a href="/" class="nav-brand">${opts.shortName}</a>
      <div class="top-nav-links">
        {#each navItems as item (item.href)}
          <a href={item.href} class="nav-link" class:active={isActive(item.href)}>{item.label}</a>
        {/each}
      </div>
      <div class="top-nav-actions">
        <a href={ROUTES.DEMO} class="nav-link nav-link-demo" class:active={isActive(ROUTES.DEMO)}>Demo</a>
        <a href={ROUTES.PROFILE} class="user-menu user-menu-link" class:active={isActive(ROUTES.PROFILE)}>
          <span class="user-avatar">{avatarInitial}</span>
          <span class="user-greeting">Hey, {greeting}!</span>
        </a>
        <button class="logout-btn" onclick={handleSignOut} aria-label="Sign out">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  </nav>

  <!-- Mobile: bottom tab bar -->
  <nav class="bottom-nav" aria-label="Tab bar">
    {#each navItems as item (item.href)}
      <a href={item.href} class="tab-item" class:active={isActive(item.href)}>
        {#if item.icon === 'home'}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        {:else}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
          </svg>
        {/if}
        <span>{item.label}</span>
      </a>
    {/each}
    <a href={ROUTES.PROFILE} class="tab-item" class:active={isActive(ROUTES.PROFILE)}>
      <span class="mobile-avatar">{avatarInitial}</span>
      <span>Profile</span>
    </a>
  </nav>

  <!-- Mobile: Dynamic Island header (hidden on desktop via CSS) -->
  <header class="island-header" aria-label="App header">
    <a href="/" class="island-brand">${opts.shortName}</a>
    <!-- Centre gap — keeps content clear of the Dynamic Island pill -->
    <div class="island-gap" aria-hidden="true"></div>
    <div class="island-right">
      <SyncStatus />
    </div>
  </header>
{/if}

<!-- Page content -->
<div class="page-wrapper" class:authenticated={isAuthenticated} use:scrollGuard>
  {@render children?.()}
</div>

<OfflineToast />
<GlobalToast />
<DemoBanner />
<OfflineBanner />
<DemoBlockedMessage />
<UpdatePrompt />

<style>
  /* ── Loading / signout overlay ── */
  .app-loader, .signout-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #111116;
  }

  .loader-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .loader-spinner {
    display: inline-block;
    width: 32px;
    height: 32px;
    border: 2.5px solid rgba(107, 158, 107, 0.2);
    border-top-color: #6B9E6B;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  .loader-name {
    font-size: 0.9375rem;
    font-weight: 600;
    color: #7878a0;
    letter-spacing: 0.02em;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Desktop top navbar ── */
  .top-nav {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    height: 56px;
    background: rgba(15, 15, 30, 0.9);
    border-bottom: 1px solid #3d5a3d;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .top-nav-inner {
    max-width: 1200px;
    margin: 0 auto;
    height: 100%;
    display: flex;
    align-items: center;
    padding: 0 1.5rem;
    gap: 1.5rem;
  }

  .nav-brand {
    font-size: 1rem;
    font-weight: 800;
    color: #6B9E6B;
    text-decoration: none;
    letter-spacing: -0.3px;
    flex-shrink: 0;
  }

  .top-nav-links {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex: 1;
  }

  .top-nav-actions {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
  }

  .nav-link {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #7878a0;
    text-decoration: none;
    border-radius: 8px;
    transition: color 0.15s, background 0.15s;
  }

  .nav-link:hover { color: #c8c8e0; background: rgba(255,255,255,0.04); }

  .nav-link.active { color: #6B9E6B; }

  .nav-link-demo { color: #D4A853; }
  .nav-link-demo:hover { color: #D4A853; opacity: 0.8; }
  .nav-link-demo.active { color: #D4A853; }

  /* ── Mobile bottom tab bar ── */
  .bottom-nav {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 100;
    height: calc(56px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    background: rgba(15, 15, 30, 0.95);
    border-top: 1px solid #3d5a3d;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    /* Account for Dynamic Island on notched iPhones */
    padding-bottom: max(env(safe-area-inset-bottom), 0px);
  }

  .tab-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    padding-bottom: calc(env(safe-area-inset-bottom) * 0.5);
    text-decoration: none;
    color: #7878a0;
    font-size: 0.6875rem;
    font-weight: 600;
    transition: color 0.15s;
    -webkit-tap-highlight-color: transparent;
  }

  .tab-item.active { color: #6B9E6B; }

  /* ── Mobile Dynamic Island header ── */
  .island-header {
    display: none; /* shown only on mobile via media query below */
    position: fixed;
    top: calc(-1 * env(safe-area-inset-top, 0px));
    left: 0;
    right: 0;
    z-index: 200;
    /* Total height: inset + 2× inset (pill clearance) + icon row */
    height: calc(env(safe-area-inset-top, 47px) * 2 + 24px);
    padding-top: calc(env(safe-area-inset-top, 47px) * 2);
    padding-left: 1.25rem;
    padding-right: 0.75rem;
    align-items: center;
    justify-content: space-between;
    background: rgba(15, 15, 30, 0.85);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid #3d5a3d;
  }

  .island-brand {
    font-size: 1rem;
    font-weight: 800;
    color: #6B9E6B;
    text-decoration: none;
    letter-spacing: -0.3px;
    flex-shrink: 0;
  }

  /* Centre gap — clears the Dynamic Island pill (≈130px wide on Pro models) */
  .island-gap {
    flex: 0 0 140px;
  }

  .island-right {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  /* ── Page wrapper — adds top/bottom padding when nav bars are visible ── */
  .page-wrapper {
    min-height: 100vh;
  }

  .page-wrapper.authenticated {
    /* Desktop: pad for top nav */
    padding-top: 0;
  }

  /* ── User menu (desktop nav right-actions) ── */
  .user-menu {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.75rem;
    border-radius: 8px;
    text-decoration: none;
    transition: background 0.15s;
  }

  .user-menu:hover { background: rgba(255,255,255,0.04); }

  .user-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: rgba(107, 158, 107, 0.2);
    border: 1px solid rgba(107, 158, 107, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 700;
    color: #6B9E6B;
    flex-shrink: 0;
  }

  .user-greeting {
    font-size: 0.875rem;
    font-weight: 500;
    color: #c8c8e0;
  }

  .logout-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.375rem;
    background: none;
    border: none;
    border-radius: 8px;
    color: #7878a0;
    cursor: pointer;
    transition: color 0.15s, background 0.15s;
  }

  .logout-btn:hover { color: #e07070; background: rgba(255,255,255,0.04); }

  /* ── Mobile avatar in tab bar ── */
  .mobile-avatar {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: rgba(107, 158, 107, 0.2);
    border: 1px solid rgba(107, 158, 107, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.625rem;
    font-weight: 700;
    color: #6B9E6B;
  }

  /* ── Responsive: show top nav on desktop, island header + bottom tab on mobile ── */
  @media (min-width: 768px) {
    .top-nav { display: flex; }
    .bottom-nav { display: none; }
    .island-header { display: none !important; }
    .page-wrapper.authenticated { padding-top: 56px; }
  }

  @media (max-width: 767px) {
    .island-header { display: flex; }
    /* Page wrapper: top padding = island header height so content isn't obscured */
    .page-wrapper.authenticated {
      padding-top: calc(env(safe-area-inset-top, 47px) * 2 + 24px);
      padding-bottom: calc(56px + env(safe-area-inset-bottom));
    }
    /* Raise DemoBanner above mobile tab bar */
    :global(:root) { --demo-banner-bottom: calc(56px + env(safe-area-inset-bottom) + 0.5rem); }
  }

</style>
`;
}

// ---------------------------------------------------------------------------
//                      PAGE GENERATORS
// ---------------------------------------------------------------------------

/**
 * Generate a minimal home page component with TODO stubs.
 *
 * @returns The Svelte component source for `src/routes/+page.svelte`.
 */
function generateHomePage(opts: InstallOptions): string {
  return `<!--
  @fileoverview Home / landing page — welcome screen and primary content.

  This is the default route (\`/\`). It renders the main content area
  the user sees after authentication.
-->
<script lang="ts">
  /**
   * @fileoverview Home page script — data access and component state.
   */

  // ==========================================================================
  //                                IMPORTS
  // ==========================================================================

  // TODO: Add home page state and data loading.
  //
  // After adding a table to src/lib/schema.ts, create a store in
  // src/lib/stores/ and wire it up to refresh after each sync cycle:
  //
  //   1. Add to imports:  { onSyncComplete } from 'stellar-drive/stores'
  //   2. Add to imports:  { myStore } from '$lib/stores/myStore.svelte'
  //   3. At module init:  onSyncComplete(() => myStore.refresh());
</script>

<svelte:head>
  <title>Home - ${opts.name}</title>
</svelte:head>

<div class="home-page">
  <!-- TODO: Add home page content (dashboard, data overview, etc.) -->
</div>

<style>
  .home-page {
    padding: 2rem 1.5rem;
    min-height: 100%;
  }
</style>
`;
}

/**
 * Generate a minimal error page component.
 *
 * @returns The Svelte component source for `src/routes/+error.svelte`.
 */
function generateErrorPage(opts: InstallOptions): string {
  return `<!--
  @fileoverview Error boundary — handles three scenarios:
    1. **Offline** — device has no connectivity, show a friendly offline message
    2. **404**     — page not found, offer navigation back to home
    3. **Generic** — unexpected error, display status code and retry option
-->
<script lang="ts">
  /**
   * @fileoverview Error page script — status detection and recovery actions.
   */

  // ==========================================================================
  //                                IMPORTS
  // ==========================================================================

  import { page } from '$app/stores';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';

  // ==========================================================================
  //                                 STATE
  // ==========================================================================

  /** Whether the user is currently offline — drives which error variant is shown. */
  let isOffline = $state(false);

  // ==========================================================================
  //                          REACTIVE EFFECTS
  // ==========================================================================

  /**
   * Effect: tracks the browser's online/offline status in real time.
   * Sets \`isOffline\` on mount and attaches \`online\` / \`offline\` event listeners.
   * Returns a cleanup function that removes the listeners on destroy.
   */
  $effect(() => {
    if (browser) {
      isOffline = !navigator.onLine;

      const handleOnline = () => {
        isOffline = false;
      };
      const handleOffline = () => {
        isOffline = true;
      };

      window.addEventListener('online', handleOnline);
      window.addEventListener('offline', handleOffline);

      return () => {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
      };
    }
  });

  // ==========================================================================
  //                          EVENT HANDLERS
  // ==========================================================================

  /**
   * Reload the current page — useful when the user regains connectivity or
   * wants to retry after a transient server error.
   */
  function handleRetry() {
    window.location.reload();
  }

  /**
   * Navigate back to the home page via SvelteKit client-side routing.
   */
  function handleGoHome() {
    goto('/');
  }
</script>

<svelte:head>
  <title>Error - ${opts.name}</title>
</svelte:head>

<div class="error-page">
  <div class="error-card">
    {#if isOffline}
      <div class="error-icon offline">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.56 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </svg>
      </div>
      <h2 class="error-title">You're offline</h2>
      <p class="error-message">Check your connection and try again.</p>
      <button class="error-btn" onclick={handleRetry}>Try again</button>

    {:else if $page.status === 404}
      <div class="error-icon notfound">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </div>
      <h2 class="error-title">Page not found</h2>
      <p class="error-message">This page doesn't exist.</p>
      <button class="error-btn" onclick={handleGoHome}>Go home</button>

    {:else}
      <div class="error-icon generic">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <h2 class="error-title">Something went wrong</h2>
      <p class="error-message">{$page.error?.message || 'An unexpected error occurred.'}</p>
      <div class="error-actions">
        <button class="error-btn" onclick={handleRetry}>Retry</button>
        <button class="error-btn-secondary" onclick={handleGoHome}>Go home</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .error-page {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: #111116;
  }

  .error-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 2.5rem 2rem;
    border-radius: 24px;
    width: 100%;
    max-width: 360px;
    text-align: center;
    background: #0f0f1e;
    border: 1px solid #3d5a3d;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .error-icon {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 2px solid;
  }

  .error-icon.offline, .error-icon.notfound {
    background: #1a2e1a;
    border-color: #3d5a3d;
    color: #6B9E6B;
  }

  .error-icon.generic {
    background: #2e1a1a;
    border-color: #7a3d3d;
    color: #e07070;
  }

  .error-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    color: #f0f0ff;
  }

  .error-message {
    margin: 0;
    font-size: 0.9rem;
    color: #c8c8e0;
    line-height: 1.6;
  }

  .error-actions {
    display: flex;
    gap: 0.75rem;
  }

  .error-btn {
    padding: 0.75rem 1.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: #fff;
    background: #6B9E6B;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    font-family: inherit;
    transition: opacity 0.15s;
  }

  .error-btn:hover { opacity: 0.9; }

  .error-btn-secondary {
    padding: 0.75rem 1.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: #c8c8e0;
    background: transparent;
    border: 1.5px solid #3d5a3d;
    border-radius: 10px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s;
  }

  .error-btn-secondary:hover { border-color: #6B9E6B; color: #f0f0ff; }
</style>
`;
}

/**
 * Generate the setup page load function with first-setup / auth guard.
 *
 * @returns The TypeScript source for `src/routes/setup/+page.ts`.
 */
function generateSetupPageTs(): string {
  return `/**
 * @fileoverview Setup page access control gate.
 *
 * Two modes:
 *   - **Unconfigured** — no runtime config exists yet; anyone can access the
 *     setup wizard to perform first-time Supabase configuration.
 *   - **Configured** — config already saved; only authenticated users may
 *     revisit the setup page to update credentials or redeploy.
 */

import { browser } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { getConfig } from 'stellar-drive/config';
import { getValidSession } from 'stellar-drive/auth';
import type { PageLoad } from './$types';

/**
 * Guard the setup route — allow first-time setup or authenticated access.
 *
 * @returns Page data with an \`isFirstSetup\` flag.
 */
export const load: PageLoad = async () => {
  /* Config and session helpers rely on browser APIs */
  if (!browser) return {};
  if (!getConfig()) {
    return { isFirstSetup: true };
  }
  const session = await getValidSession();
  if (!session?.user) {
    redirect(307, '/login');
  }
  return { isFirstSetup: false };
};
`;
}

/**
 * Generate the setup wizard page component with a full 4-step UI.
 *
 * @returns The Svelte component source for `src/routes/setup/+page.svelte`.
 */
function generateSetupPageSvelte(opts: InstallOptions): string {
  return `<!--
  @fileoverview Four-step Supabase configuration wizard.

  Guides the user through entering Supabase credentials, validating them
  against the server, optionally deploying environment variables to Vercel,
  and reloading the app with the new config active.
-->
<script lang="ts">
  /**
   * @fileoverview Setup wizard page — first-time Supabase configuration.
   *
   * Guides the user through a four-step process to connect their own
   * Supabase backend to ${opts.name}:
   *
   * 1. Create a Supabase project (instructions only).
   * 2. Initialize the database (automatic — informational step).
   * 3. Enter and validate Supabase credentials (URL + publishable key).
   * 4. Persist configuration via Vercel API (set env vars + redeploy).
   *
   * After a successful deploy the page polls for a new service-worker
   * version — once detected the user is prompted to refresh.
   *
   * Access is controlled by the companion \\\`+page.ts\\\` load function:
   * - Unconfigured → anyone can reach this page (\\\`isFirstSetup: true\\\`).
   * - Configured → authenticated users only (\\\`isFirstSetup: false\\\`).
   */

  import { page } from '$app/stores';
  import { setConfig } from 'stellar-drive/config';
  import { pollForNewServiceWorker } from 'stellar-drive/kit';
  import { isOffline } from 'stellar-drive';
  import Reconfigure from './Reconfigure.svelte';

  // =============================================================================
  //  Wizard State
  // =============================================================================

  /** Current step (1-4) */
  let currentStep = $state(1);

  // =============================================================================
  //  Form State — Supabase + Vercel credentials
  // =============================================================================

  /** Supabase project URL entered by the user */
  let supabaseUrl = $state('');

  /** Supabase publishable key entered by the user */
  let supabasePublishableKey = $state('');

  /** One-time Vercel API token for setting env vars */
  let vercelToken = $state('');

  // =============================================================================
  //  UI State — Validation & Deployment feedback
  // =============================================================================

  /** Whether the "Test Connection" request is in-flight */
  let validating = $state(false);

  /** Whether the deploy/redeploy flow is in-flight */
  let deploying = $state(false);

  /** Error from credential validation, if any */
  let validateError = $state<string | null>(null);

  /** \\\`true\\\` after credentials have been successfully validated */
  let validateSuccess = $state(false);

  /** Error from the deployment step, if any */
  let deployError = $state<string | null>(null);

  /** Current deployment pipeline stage — drives the progress UI */
  let deployStage = $state<'idle' | 'setting-env' | 'deploying' | 'ready'>('idle');

  /** URL returned by Vercel for the triggered deployment (informational) */
  let _deploymentUrl = $state('');

  // =============================================================================
  //  Derived State
  // =============================================================================

  /** Whether this is a first-time setup (public) or reconfiguration */
  const isFirstSetup = $derived(($page.data as { isFirstSetup?: boolean }).isFirstSetup ?? false);

  /** Whether the app is currently offline — disables network-dependent actions. */
  const offline = $derived(isOffline());

  /**
   * Snapshot of the credentials at validation time — used to detect
   * if the user edits the inputs *after* a successful validation.
   */
  let validatedUrl = $state('');
  let validatedKey = $state('');

  /**
   * \\\`true\\\` when the user changes credentials after a successful
   * validation — the "Continue" button should be re-disabled.
   */
  const credentialsChanged = $derived(
    validateSuccess && (supabaseUrl !== validatedUrl || supabasePublishableKey !== validatedKey)
  );

  /** Whether the Continue button on step 3 should be enabled */
  const canContinueStep3 = $derived(validateSuccess && !credentialsChanged);

  // =============================================================================
  //  Effects
  // =============================================================================

  /**
   * Auto-reset validation state when the user modifies credentials
   * after they were already validated — forces re-validation.
   */
  $effect(() => {
    if (credentialsChanged) {
      validateSuccess = false;
      validateError = null;
    }
  });

  // =============================================================================
  //  Validation — "Test Connection"
  // =============================================================================

  /**
   * Send the entered Supabase credentials to \\\`/api/setup/validate\\\`
   * and update UI state based on the result. On success, also
   * cache the config locally via \\\`setConfig\\\` so the app is usable
   * immediately after the deployment finishes.
   */
  async function handleValidate() {
    validateError = null;
    validateSuccess = false;
    validating = true;

    try {
      const res = await fetch('/api/setup/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supabaseUrl, supabasePublishableKey })
      });

      const data = await res.json();

      if (data.valid) {
        validateSuccess = true;
        validatedUrl = supabaseUrl;
        validatedKey = supabasePublishableKey;
        /* Cache config locally so the app works immediately after deploy */
        setConfig({
          supabaseUrl,
          supabasePublishableKey,
          configured: true,
        });
      } else {
        validateError = data.error || 'Validation failed';
      }
    } catch (e) {
      validateError = e instanceof Error ? e.message : 'Network error';
    }

    validating = false;
  }

  // =============================================================================
  //  Deployment Polling
  // =============================================================================

  /**
   * Poll for a new service-worker version to detect when the Vercel
   * redeployment has finished. Uses the engine's \\\`pollForNewServiceWorker\\\`
   * helper which checks \\\`registration.update()\\\` at regular intervals.
   *
   * Resolves a Promise when a new SW is detected in the waiting state.
   */
  function pollForDeployment(): Promise<void> {
    return new Promise((resolve) => {
      pollForNewServiceWorker({
        intervalMs: 3000,
        maxAttempts: 200,
        onFound: () => {
          deployStage = 'ready';
          resolve();
        }
      });
    });
  }

  // =============================================================================
  //  Deployment — Set env vars + trigger Vercel redeploy
  // =============================================================================

  /**
   * Send credentials and the Vercel token to \\\`/api/setup/deploy\\\`,
   * which sets the environment variables on the Vercel project and
   * triggers a fresh deployment. Then poll until the new build is live.
   */
  async function handleDeploy() {
    deployError = null;
    deploying = true;
    deployStage = 'setting-env';

    try {
      const res = await fetch('/api/setup/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supabaseUrl, supabasePublishableKey, vercelToken })
      });

      const data = await res.json();

      if (data.success) {
        deployStage = 'deploying';
        _deploymentUrl = data.deploymentUrl || '';
        /* Poll for the new SW version → marks \\\`deployStage = 'ready'\\\` */
        await pollForDeployment();
      } else {
        deployError = data.error || 'Deployment failed';
        deployStage = 'idle';
      }
    } catch (e) {
      deployError = e instanceof Error ? e.message : 'Network error';
      deployStage = 'idle';
    }

    deploying = false;
  }
</script>

<svelte:head>
  <title>Setup - ${opts.name}</title>
</svelte:head>

<div class="setup-page">
  <div class="setup-container">
    {#if isFirstSetup}
    <!-- Public page banner -->
    <div class="public-banner">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      Public setup page — no authentication required
    </div>

    <!-- Header -->
    <h1>Set Up ${opts.name}</h1>
    <p class="subtitle">Connect ${opts.name} to your own Supabase backend</p>

    <!-- Step indicator -->
    <div class="step-indicator">
      {#each [1, 2, 3, 4] as step (step)}
        {#if step > 1}
          <div class="step-line" class:completed={currentStep > step - 1}></div>
        {/if}
        <div
          class="step-dot"
          class:active={currentStep === step}
          class:completed={currentStep > step}
        >
          {#if currentStep > step}
            <span class="checkmark">&#10003;</span>
          {:else}
            {step}
          {/if}
        </div>
      {/each}
    </div>

    <!-- Step cards -->
    <div class="step-card">
      {#if currentStep === 1}
        <h2>Step 1: Create a Supabase Project</h2>
        <p>
          ${opts.name} stores data in your own Supabase project.
          Create one if you don't have one already — the free tier is more than enough.
        </p>
        <ol>
          <li>Go to <a href="https://supabase.com/dashboard" target="_blank" rel="noopener noreferrer">supabase.com/dashboard</a></li>
          <li>Click <strong>New Project</strong>, choose a name and database password, then click <strong>Create new project</strong>.</li>
          <li>Wait for provisioning to finish (usually under a minute).</li>
        </ol>
        <p class="info-note">
          <strong>Note:</strong> Supabase's built-in SMTP works for development. For production
          you may want to configure a custom SMTP provider under Authentication &gt; Settings.
        </p>

      {:else if currentStep === 2}
        <h2>Step 2: Initialize the Database</h2>
        <p>
          The required tables and RLS policies are created automatically during the build process.
          When your app deploys to Vercel, the schema is pushed to your Supabase database &mdash; no
          manual SQL is needed.
        </p>

      {:else if currentStep === 3}
        <h2>Step 3: Connect Your Supabase Project</h2>
        <p>Find these values in your Supabase dashboard under <strong>Settings &gt; API</strong>.</p>

        <div class="form-group">
          <label for="supabase-url">Project URL</label>
          <input
            id="supabase-url"
            type="url"
            placeholder="https://your-project.supabase.co"
            bind:value={supabaseUrl}
          />
        </div>

        <div class="form-group">
          <label for="supabase-key">Publishable Key (anon / public)</label>
          <input
            id="supabase-key"
            type="text"
            placeholder="eyJhbGciOiJIUzI1NiIs..."
            bind:value={supabasePublishableKey}
          />
          <span class="hint">This is the \`anon\` key — safe to expose in the browser.</span>
        </div>

        <button
          class="btn btn-secondary"
          onclick={handleValidate}
          disabled={validating || !supabaseUrl || !supabasePublishableKey || offline}
        >
          {#if validating}Testing...{:else}Test Connection{/if}
        </button>

        {#if validateError}
          <div class="message msg-error">{validateError}</div>
        {/if}
        {#if validateSuccess}
          <div class="message msg-success">Connection successful! Credentials are valid.</div>
        {/if}

      {:else if currentStep === 4}
        <h2>Step 4: Deploy to Vercel</h2>
        <p>
          Provide a one-time Vercel API token so ${opts.name} can set the environment
          variables on your project and trigger a redeployment.
        </p>
        <div class="form-group">
          <label for="vercel-token">Vercel API Token</label>
          <input
            id="vercel-token"
            type="password"
            placeholder="Paste your Vercel token"
            bind:value={vercelToken}
          />
        </div>

        <button
          class="btn btn-primary"
          onclick={handleDeploy}
          disabled={deploying || !vercelToken || offline}
        >
          {#if deploying}Deploying...{:else}Deploy{/if}
        </button>

        {#if deployError}
          <div class="message msg-error">{deployError}</div>
        {/if}

        <!-- Deployment pipeline stages -->
        {#if deployStage !== 'idle'}
          <div class="deploy-stages">
            <div class="deploy-stage" class:active={deployStage === 'setting-env'} class:done={deployStage === 'deploying' || deployStage === 'ready'}>
              <span class="stage-icon">{#if deployStage === 'setting-env'}&#9675;{:else}&#10003;{/if}</span>
              Setting environment variables
            </div>
            <div class="deploy-stage" class:active={deployStage === 'deploying'} class:done={deployStage === 'ready'}>
              <span class="stage-icon">{#if deployStage === 'deploying'}&#9675;{:else if deployStage === 'ready'}&#10003;{:else}&#8226;{/if}</span>
              Deploying to Vercel... (might take a minute)
            </div>
            <div class="deploy-stage" class:active={deployStage === 'ready'}>
              <span class="stage-icon">{#if deployStage === 'ready'}&#10003;{:else}&#8226;{/if}</span>
              Ready
            </div>
          </div>
        {/if}

        {#if deployStage === 'ready'}
          <div class="message msg-success">
            Deployment complete! Use the update prompt at the bottom of the screen to refresh.
            If it doesn't appear, click below.
          </div>
          <button
            class="btn btn-secondary"
            onclick={() => (window.location.href = '/')}
            style="margin-top: 0.75rem;"
          >
            Manually refresh &amp; go home
          </button>
        {/if}
      {/if}
    </div>

    <!-- Step navigation -->
    <div class="step-nav">
      {#if currentStep > 1}
        <button class="btn btn-back" onclick={() => currentStep--}>Back</button>
      {:else}
        <div></div>
      {/if}

      {#if currentStep < 3}
        <button class="btn btn-primary" onclick={() => currentStep++}>Continue</button>
      {:else if currentStep === 3}
        <button
          class="btn btn-primary"
          onclick={() => currentStep++}
          disabled={!canContinueStep3}
        >Continue</button>
      {/if}
    </div>

    <!-- Security notice (first-time setup only) -->
      <div class="security-notice">
        <strong>Security:</strong> Your Supabase credentials are stored as environment variables
        on Vercel and are never sent to any third-party service. The Vercel token is used once
        and is not persisted.
      </div>
    {:else}
    <!-- Reconfigure view for returning users -->
    <h1>Reconfigure ${opts.name}</h1>
    <p class="subtitle">Update your credentials and redeploy</p>
    <Reconfigure />
    {/if}
  </div>
</div>

<style>
  .setup-page {
    display: flex;
    justify-content: center;
    padding: 2rem 1rem;
    min-height: 100vh;
    background: #111116;
  }

  .setup-container {
    max-width: 640px;
    width: 100%;
  }

  h1 {
    margin: 0 0 0.25rem;
    font-size: 1.75rem;
    color: #f0f0ff;
    font-weight: 800;
  }

  .subtitle {
    margin: 0 0 1.5rem;
    color: #7878a0;
    font-size: 0.9375rem;
  }

  /* Public-page banner (first setup only) */
  .public-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    background: rgba(212, 168, 83, 0.1);
    border: 1px solid rgba(212, 168, 83, 0.3);
    border-radius: 10px;
    font-size: 0.8125rem;
    color: #D4A853;
    font-weight: 600;
    margin-bottom: 1.5rem;
  }

  /* Step indicator */
  .step-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    margin-bottom: 2rem;
  }

  .step-dot {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 2px solid #3d5a3d;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.875rem;
    font-weight: 600;
    color: #7878a0;
    background: #0f0f1e;
    flex-shrink: 0;
  }

  .step-dot.active {
    border-color: #6B9E6B;
    color: #6B9E6B;
    background: rgba(107, 158, 107, 0.12);
  }

  .step-dot.completed {
    border-color: #6B9E6B;
    background: #6B9E6B;
    color: #fff;
  }

  .checkmark {
    font-size: 0.875rem;
  }

  .step-line {
    width: 40px;
    height: 2px;
    background: #3d5a3d;
    flex-shrink: 0;
  }

  .step-line.completed {
    background: #6B9E6B;
  }

  /* Step card */
  .step-card {
    padding: 1.5rem;
    border: 1px solid #3d5a3d;
    border-radius: 16px;
    background: #0f0f1e;
    margin-bottom: 1.5rem;
    color: #c8c8e0;
  }

  .step-card h2 {
    margin: 0 0 0.75rem;
    font-size: 1.125rem;
    color: #f0f0ff;
    font-weight: 700;
  }

  .step-card p {
    margin: 0 0 1rem;
    line-height: 1.6;
    font-size: 0.9rem;
  }

  .step-card ol {
    margin: 0 0 1rem;
    padding-left: 1.25rem;
    line-height: 1.8;
    font-size: 0.9rem;
  }

  .step-card a {
    color: #6B9E6B;
    text-decoration: none;
    border-bottom: 1px solid rgba(107, 158, 107, 0.3);
  }

  .step-card strong { color: #f0f0ff; }

  .info-note {
    padding: 0.75rem 1rem;
    background: rgba(107, 158, 107, 0.08);
    border: 1px solid rgba(107, 158, 107, 0.2);
    border-radius: 8px;
    font-size: 0.8125rem;
    color: #c8c8e0;
  }

  .hint {
    display: block;
    margin-top: 0.375rem;
    font-size: 0.75rem;
    color: #7878a0;
  }

  /* Buttons */
  .btn {
    padding: 0.75rem 1.25rem;
    border: none;
    border-radius: 10px;
    font-size: 0.9375rem;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: opacity 0.15s;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .btn-back {
    background: transparent;
    color: #7878a0;
    border: 1.5px solid #3d5a3d;
  }

  .btn-back:hover:not(:disabled) { border-color: #6B9E6B; color: #c8c8e0; }

  /* Messages */
  .message {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    margin-top: 0.75rem;
    font-size: 0.875rem;
  }

  .msg-error {
    background: rgba(224, 112, 112, 0.1);
    color: #e07070;
    border: 1px solid rgba(224, 112, 112, 0.25);
  }

  .msg-success {
    background: rgba(107, 158, 107, 0.1);
    color: #6B9E6B;
    border: 1px solid rgba(107, 158, 107, 0.25);
  }

  /* Deploy stages */
  .deploy-stages {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .deploy-stage {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: #7878a0;
  }

  .deploy-stage.active {
    color: #6B9E6B;
    font-weight: 600;
  }

  .deploy-stage.done {
    color: #6B9E6B;
    opacity: 0.7;
  }

  .stage-icon {
    width: 1.25rem;
    text-align: center;
  }

  /* Step navigation */
  .step-nav {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  /* Security notice */
  .security-notice {
    padding: 0.75rem 1rem;
    background: rgba(107, 158, 107, 0.06);
    border: 1px solid rgba(107, 158, 107, 0.2);
    border-radius: 8px;
    font-size: 0.8rem;
    color: #7878a0;
    line-height: 1.5;
  }

  /* Responsive */
  @media (max-width: 480px) {
    .setup-page {
      padding: 1rem 0.5rem;
    }

    .step-card {
      padding: 1rem;
    }

    .step-line {
      width: 24px;
    }
  }
</style>
`;
}

/**
 * Generate the Reconfigure component for the setup page.
 *
 * Shown when `isFirstSetup: false` — a flat settings page where the
 * user can update Supabase credentials and redeploy without stepping
 * through the full wizard.
 *
 * @returns The Svelte component source for `src/routes/setup/Reconfigure.svelte`.
 */
function generateReconfigureSvelte(opts: InstallOptions): string {
  return `<!--
  @fileoverview Reconfigure settings page for ${opts.name}.

  Shown when \\\`isFirstSetup: false\\\` — a flat settings page where the
  user can update Supabase credentials and redeploy without stepping
  through the full wizard.
-->
<script lang="ts">
  import { getConfig, setConfig } from 'stellar-drive/config';
  import { isOnline } from 'stellar-drive/stores';
  import { pollForNewServiceWorker, monitorSwLifecycle } from 'stellar-drive/kit';
  import { isOffline } from 'stellar-drive';
  import { browser } from '$app/environment';

  // ===========================================================================
  //  Form State
  // ===========================================================================

  let supabaseUrl = $state('');
  let supabasePublishableKey = $state('');
  let vercelToken = $state('');

  // Initial values for change detection
  let initialSupabaseUrl = $state('');
  let initialSupabaseKey = $state('');

  // ===========================================================================
  //  UI State
  // ===========================================================================

  let loading = $state(true);
  let validating = $state(false);
  let validateError = $state<string | null>(null);
  let validateSuccess = $state(false);
  let validatedUrl = $state('');
  let validatedKey = $state('');
  let deploying = $state(false);
  let deployError = $state<string | null>(null);
  let deployStage = $state<'idle' | 'setting-env' | 'deploying' | 'ready'>('idle');

  // ===========================================================================
  //  Derived State
  // ===========================================================================

  const supabaseChanged = $derived(
    supabaseUrl !== initialSupabaseUrl || supabasePublishableKey !== initialSupabaseKey
  );

  const credentialsChanged = $derived(
    validateSuccess && (supabaseUrl !== validatedUrl || supabasePublishableKey !== validatedKey)
  );

  const supabaseNeedsValidation = $derived(supabaseChanged && !validateSuccess);

  /** Whether the app is currently offline — disables network-dependent actions. */
  const offline = $derived(isOffline());

  const canDeploy = $derived(
    supabaseChanged &&
      !supabaseNeedsValidation &&
      !credentialsChanged &&
      !!vercelToken &&
      !deploying &&
      deployStage === 'idle' &&
      !offline
  );

  // ===========================================================================
  //  Effects
  // ===========================================================================

  $effect(() => {
    if (credentialsChanged) {
      validateSuccess = false;
      validateError = null;
    }
  });

  // ===========================================================================
  //  Lifecycle
  // ===========================================================================

  /**
   * Effect: load existing config from the engine on mount.
   * Runs once — no reactive deps beyond the initial execution.
   */
  $effect(() => {
    if (!browser) return;

    const config = getConfig();
    if (config) {
      supabaseUrl = config.supabaseUrl || '';
      supabasePublishableKey = config.supabasePublishableKey || '';
      initialSupabaseUrl = supabaseUrl;
      initialSupabaseKey = supabasePublishableKey;
    }

    loading = false;
  });

  // ===========================================================================
  //  Validation
  // ===========================================================================

  async function handleValidate() {
    validateError = null;
    validateSuccess = false;
    validating = true;

    try {
      const res = await fetch('/api/setup/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supabaseUrl, supabasePublishableKey })
      });

      const data = await res.json();

      if (data.valid) {
        validateSuccess = true;
        validatedUrl = supabaseUrl;
        validatedKey = supabasePublishableKey;
        setConfig({ supabaseUrl, supabasePublishableKey, configured: true });
      } else {
        validateError = data.error || 'Validation failed';
      }
    } catch (e) {
      validateError = e instanceof Error ? e.message : 'Network error';
    }

    validating = false;
  }

  // ===========================================================================
  //  Deployment
  // ===========================================================================

  function pollForDeployment(): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;

      const done = () => {
        if (resolved) return;
        resolved = true;
        stopPoll();
        stopMonitor();
        deployStage = 'ready';
        resolve();
      };

      const stopMonitor = monitorSwLifecycle({ onUpdateAvailable: done });

      const stopPoll = pollForNewServiceWorker({
        intervalMs: 3000,
        maxAttempts: 200,
        onFound: done
      });

      if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
        navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
      }

      setTimeout(() => {
        if (!resolved) done();
      }, 180_000);
    });
  }

  async function handleDeploy() {
    deployError = null;
    deploying = true;
    deployStage = 'setting-env';

    try {
      const res = await fetch('/api/setup/deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supabaseUrl, supabasePublishableKey, vercelToken })
      });

      const data = await res.json();

      if (data.success) {
        deployStage = 'deploying';
        await pollForDeployment();
      } else {
        deployError = data.error || 'Deployment failed';
        deployStage = 'idle';
      }
    } catch (e) {
      deployError = e instanceof Error ? e.message : 'Network error';
      deployStage = 'idle';
    }

    deploying = false;
  }
</script>

<div class="reconfigure-page">
  {#if loading}
    <div class="loading-state">
      <span class="spinner"></span>
      Loading configuration...
    </div>
  {:else}
    <!-- Supabase Connection Card -->
    <section class="config-card">
      <div class="card-header">
        <h2>Supabase Connection</h2>
        {#if !supabaseChanged && initialSupabaseUrl}
          <span class="status-badge status-connected">Connected</span>
        {/if}
      </div>

      <p class="card-description">
        Find these values in your Supabase dashboard under <strong>Settings &gt; API</strong>.
      </p>

      <div class="form-group">
        <label for="reconfig-supabase-url">Supabase URL</label>
        <input
          id="reconfig-supabase-url"
          type="url"
          placeholder="https://your-project.supabase.co"
          bind:value={supabaseUrl}
          autocomplete="off"
          spellcheck="false"
        />
      </div>

      <div class="form-group">
        <label for="reconfig-supabase-key">Supabase Publishable Key</label>
        <input
          id="reconfig-supabase-key"
          type="text"
          placeholder="eyJhbGciOiJIUzI1NiIs..."
          bind:value={supabasePublishableKey}
          autocomplete="off"
          spellcheck="false"
        />
        <span class="input-hint"
          >This is your public (anon) key. Row-Level Security policies enforce access control.</span
        >
      </div>

      <button
        class="btn btn-secondary"
        onclick={handleValidate}
        disabled={!supabaseUrl || !supabasePublishableKey || validating || offline}
      >
        {#if validating}
          <span class="spinner small"></span>
          Testing connection...
        {:else}
          Test Connection
        {/if}
      </button>

      {#if validateError}
        <div class="msg-error">{validateError}</div>
      {/if}
      {#if validateSuccess && !credentialsChanged}
        <div class="msg-success">Connection successful — credentials are valid.</div>
      {/if}
    </section>

    <!-- Deploy Section -->
    <section class="config-card">
      <div class="card-header">
        <h2>Deploy Changes</h2>
      </div>

      {#if !$isOnline}
        <div class="msg-error">
          You are currently offline. Deployment requires an internet connection.
        </div>
      {/if}

      <div class="form-group">
        <label for="reconfig-vercel-token">Vercel API Token</label>
        <input
          id="reconfig-vercel-token"
          type="password"
          placeholder="Paste your Vercel token"
          bind:value={vercelToken}
          autocomplete="off"
          disabled={deploying || deployStage !== 'idle'}
        />
        <span class="input-hint">
          Create a token at
          <a href="https://vercel.com/account/tokens" target="_blank" rel="noopener noreferrer">
            vercel.com/account/tokens</a
          >. It is used once and never stored.
        </span>
      </div>

      {#if deployStage === 'idle'}
        <button class="btn btn-primary" onclick={handleDeploy} disabled={!canDeploy}>
          {#if deploying}
            <span class="spinner small"></span>
            Deploying...
          {:else}
            Deploy Changes
          {/if}
        </button>
      {/if}

      {#if deployError}
        <div class="msg-error">{deployError}</div>
      {/if}

      {#if deployStage !== 'idle'}
        <div class="deploy-steps">
          <div
            class="deploy-step"
            class:active={deployStage === 'setting-env'}
            class:complete={deployStage === 'deploying' || deployStage === 'ready'}
          >
            <div class="deploy-step-indicator">
              {#if deployStage === 'setting-env'}
                <span class="spinner small"></span>
              {:else}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              {/if}
            </div>
            <span>Setting environment variables...</span>
          </div>

          <div
            class="deploy-step"
            class:active={deployStage === 'deploying'}
            class:complete={deployStage === 'ready'}
          >
            <div class="deploy-step-indicator">
              {#if deployStage === 'deploying'}
                <span class="spinner small"></span>
              {:else if deployStage === 'ready'}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              {:else}
                <div class="deploy-dot"></div>
              {/if}
            </div>
            <span>Deploying... (might take a bit)</span>
          </div>

          <div class="deploy-step" class:active={deployStage === 'ready'}>
            <div class="deploy-step-indicator">
              {#if deployStage === 'ready'}
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              {:else}
                <div class="deploy-dot"></div>
              {/if}
            </div>
            <span>Ready</span>
          </div>
        </div>

        {#if deployStage === 'ready'}
          <div class="msg-success">
            Deployment complete! Use the update prompt at the bottom of the screen to refresh. If it
            doesn't appear, click below.
          </div>
          <button
            class="btn btn-secondary"
            onclick={() => (window.location.href = '/')}
            style="margin-top: 0.75rem;"
          >
            Manually refresh &amp; go home
          </button>
        {/if}
      {/if}
    </section>
  {/if}
</div>

<style>
  /* ===========================================================================
     Layout
     =========================================================================== */

  .reconfigure-page {
    max-width: 640px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 3rem;
    font-size: 0.9375rem;
    color: #7878a0;
  }

  /* ===========================================================================
     Config Card
     =========================================================================== */

  .config-card {
    padding: 1.5rem;
    background: #0f0f1e;
    border: 1px solid #3d5a3d;
    border-radius: 16px;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .card-header h2 {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 700;
    color: #f0f0ff;
  }

  .card-description {
    margin: 0 0 1rem;
    font-size: 0.875rem;
    color: #c8c8e0;
    line-height: 1.6;
  }

  .card-description strong {
    color: #f0f0ff;
    font-weight: 600;
  }

  /* ===========================================================================
     Status Badges
     =========================================================================== */

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.5rem;
    font-size: 0.6875rem;
    font-weight: 600;
    border-radius: 4px;
    letter-spacing: 0.02em;
  }

  .status-connected {
    background: rgba(107, 158, 107, 0.15);
    color: #6B9E6B;
    border: 1px solid rgba(107, 158, 107, 0.3);
  }

  /* ===========================================================================
     Form Elements
     =========================================================================== */

  .input-hint {
    font-size: 0.75rem;
    color: #7878a0;
    line-height: 1.4;
  }

  .input-hint a {
    color: #6B9E6B;
    text-decoration: none;
    border-bottom: 1px solid rgba(107, 158, 107, 0.3);
  }

  .input-hint a:hover {
    border-bottom-color: #6B9E6B;
  }

  /* ===========================================================================
     Messages
     =========================================================================== */

  .msg-error {
    padding: 0.875rem 1rem;
    border-radius: 8px;
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.5;
    margin-top: 0.75rem;
    background: rgba(224, 112, 112, 0.1);
    color: #e07070;
    border: 1px solid rgba(224, 112, 112, 0.25);
  }

  .msg-success {
    padding: 0.875rem 1rem;
    border-radius: 8px;
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.5;
    margin-top: 0.75rem;
    background: rgba(107, 158, 107, 0.1);
    color: #6B9E6B;
    border: 1px solid rgba(107, 158, 107, 0.25);
  }

  /* ===========================================================================
     Buttons
     =========================================================================== */

  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    font-size: 0.9375rem;
    font-weight: 600;
    border-radius: 10px;
    cursor: pointer;
    transition: opacity 0.15s;
    border: none;
    font-family: inherit;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ===========================================================================
     Loading Spinner
     =========================================================================== */

  .spinner.small {
    width: 14px;
    height: 14px;
    border-width: 2px;
  }

  /* ===========================================================================
     Deploy Steps
     =========================================================================== */

  .deploy-steps {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .deploy-step {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.875rem;
    color: #7878a0;
    opacity: 0.5;
    transition: all 0.3s;
  }

  .deploy-step.active {
    opacity: 1;
    color: #6B9E6B;
  }

  .deploy-step.complete {
    opacity: 1;
    color: #6B9E6B;
  }

  .deploy-step-indicator {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .deploy-dot {
    width: 8px;
    height: 8px;
    background: #3d5a3d;
    border-radius: 50%;
  }

  /* ===========================================================================
     Responsive
     =========================================================================== */

  @media (max-width: 640px) {
    .config-card {
      padding: 1.25rem;
    }

    .form-group input {
      font-size: 16px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }

    .btn {
      transition: none;
    }

    .deploy-step {
      transition: none;
    }
  }
</style>
`;
}

/**
 * Generate a minimal privacy policy page component.
 *
 * @returns The Svelte component source for `src/routes/policy/+page.svelte`.
 */
function generatePolicyPage(opts: InstallOptions): string {
  return `<!--
  @fileoverview Privacy policy page.

  Static content page displaying the application's privacy policy.
  Uses the app's design theme via CSS custom properties.
-->

<svelte:head>
  <title>Privacy Policy - ${opts.name}</title>
</svelte:head>

<div class="policy-page">
  <div class="policy-card">
    <header class="policy-header">
      <h1 class="policy-title">${opts.name} Privacy Policy</h1>
      <p class="policy-meta">Self-hosted · Your data stays on your infrastructure</p>
    </header>

    <div class="policy-body">
      <section>
        <h2>Overview</h2>
        <p>
          ${opts.name} is a self-hosted application. When you deploy ${opts.name}, you connect it to
          your own Supabase project. All your data is stored in that Supabase instance — which lives
          on infrastructure you control.
        </p>
        <p>
          ${opts.name} does not operate any central servers, collect analytics, or have access
          to your personal data.
        </p>
      </section>

      <section>
        <h2>Data Storage</h2>
        <p>All application data is stored in two places, both under your control:</p>
        <ul>
          <li><strong>Your Supabase database</strong> — cloud backup and cross-device sync</li>
          <li><strong>Your device's IndexedDB</strong> — local offline-first storage</li>
        </ul>
        <p>No data is ever sent to third parties or the ${opts.name} developer.</p>
      </section>

      <section>
        <h2>Authentication</h2>
        <p>
          ${opts.name} uses a single-user PIN-based authentication model. Your PIN is never stored
          in plaintext — it is used to derive an encryption key for local credentials. Email
          verification is handled by your own Supabase project's auth system.
        </p>
      </section>

      <section>
        <h2>Device Verification</h2>
        <p>
          When linking a new device, ${opts.name} sends a verification email via your Supabase
          project's email service. This email comes from your Supabase SMTP configuration, not
          from any ${opts.name} servers.
        </p>
      </section>

      <section>
        <h2>Analytics &amp; Tracking</h2>
        <p>
          ${opts.name} contains no analytics, tracking pixels, third-party SDKs, or telemetry of
          any kind. No usage data is collected.
        </p>
      </section>

      <section>
        <h2>Open Source</h2>
        <p>
          ${opts.name} is built on open-source components. You can inspect the full source code
          to verify these privacy commitments.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about this privacy policy? Contact the person who deployed this instance of
          ${opts.name} — they control the data and infrastructure.
        </p>
      </section>
    </div>
  </div>
</div>

<style>
  .policy-page {
    min-height: 100vh;
    background: #111116;
    display: flex;
    justify-content: center;
    padding: 2rem 1rem;
  }

  .policy-card {
    max-width: 680px;
    width: 100%;
  }

  .policy-header {
    margin-bottom: 2rem;
  }

  .policy-title {
    margin: 0 0 0.5rem;
    font-size: clamp(1.5rem, 5vw, 2rem);
    font-weight: 800;
    color: #f0f0ff;
    letter-spacing: -0.5px;
  }

  .policy-meta {
    margin: 0;
    font-size: 0.875rem;
    color: #6B9E6B;
    font-weight: 600;
  }

  .policy-body {
    background: #0f0f1e;
    border: 1px solid #3d5a3d;
    border-radius: 20px;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
  }

  .policy-body section h2 {
    margin: 0 0 0.75rem;
    font-size: 1rem;
    font-weight: 700;
    color: #6B9E6B;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.8125rem;
  }

  .policy-body p, .policy-body li {
    font-size: 0.9375rem;
    color: #c8c8e0;
    line-height: 1.7;
    margin: 0 0 0.75rem;
  }

  .policy-body li:last-child, .policy-body p:last-child { margin-bottom: 0; }

  .policy-body ul {
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }

  .policy-body strong {
    color: #f0f0ff;
    font-weight: 600;
  }

  @media (max-width: 640px) {
    .policy-body { padding: 1.25rem; }
    .policy-page { padding: 1rem 0.75rem; }
  }
</style>
`;
}

/**
 * Generate the login page component with single-user auth, device
 * verification, and PIN input TODO stubs.
 *
 * @returns The Svelte component source for `src/routes/login/+page.svelte`.
 */
function generateLoginPage(opts: InstallOptions): string {
  return `<!--
  @fileoverview Login page — three modes:
    1. **Setup**       — first-time account creation (email + PIN)
    2. **Unlock**      — returning user enters PIN to unlock
    3. **Link Device** — new device links to an existing account via email verification

  Uses BroadcastChannel (\`auth-channel\`) for cross-tab communication with
  the /confirm page so email verification results propagate instantly.
-->
<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/stores';
  import {
    setupSingleUser,
    unlockSingleUser,
    getSingleUserInfo,
    completeSingleUserSetup,
    completeDeviceVerification,
    pollDeviceVerification,
    fetchRemoteGateConfig,
    linkSingleUserDevice,
    checkPersistentLockout
  } from 'stellar-drive/auth';
  import { sendDeviceVerification, isDemoMode, isOffline } from 'stellar-drive';
  import { isSafeRedirect } from 'stellar-drive/utils';

  // ==========================================================================
  //                        LAYOUT / PAGE DATA
  // ==========================================================================

  /** Whether this device has a linked single-user account (derived from IndexedDB, not layout data) */
  let deviceLinked = $state(false);

  /** Post-login redirect URL — validated to prevent open-redirect attacks */
  const redirectUrl = $derived.by(() => {
    const param = $page.url.searchParams.get('redirect');
    if (param && isSafeRedirect(param)) return param;
    return '/';
  });

  /** Whether the app is currently offline — disables network-dependent actions. */
  const offline = $derived(isOffline());

  // ==========================================================================
  //                          SHARED UI STATE
  // ==========================================================================

  /** \`true\` while any async auth operation is in-flight */
  let loading = $state(false);

  /** Current error message shown to the user (null = no error) */
  let error = $state<string | null>(null);

  /** Triggers the CSS shake animation on the login card */
  let shaking = $state(false);

  /** Pulsed true for one tick when lockout ends — $effect uses this to focus the first PIN input */
  let lockoutEnded = $state(false);

  $effect(() => {
    if (lockoutEnded) {
      lockoutEnded = false;
      if (deviceLinked) unlockInputs[0]?.focus();
      else if (linkMode) linkInputs[0]?.focus();
    }
  });

  /** Set to \`true\` after the component mounts — enables entrance animation */
  let mounted = $state(false);

  /** \`true\` while the initial auth state is being resolved (prevents card flash) */
  let resolving = $state(true);

  // =============================================================================
  //  Setup Mode State (step 1 → email/name, step 2 → PIN creation)
  // =============================================================================

  /** User's email address for account creation */
  let email = $state('');

  /** User's first name */
  let firstName = $state('');

  /** User's last name (optional) */
  let lastName = $state('');

  /** Individual digit values for the 6-digit PIN code */
  let codeDigits = $state(['', '', '', '', '', '']);

  /** Individual digit values for the PIN confirmation */
  let confirmDigits = $state(['', '', '', '', '', '']);

  /** Concatenated PIN code — derived from \`codeDigits\` */
  const code = $derived(codeDigits.join(''));

  /** Concatenated confirmation code — derived from \`confirmDigits\` */
  const confirmCode = $derived(confirmDigits.join(''));

  /** Current setup wizard step: 1 = email + name, 2 = PIN creation */
  let setupStep = $state(1); // 1 = email + name, 2 = code

  // =============================================================================
  //  Unlock Mode State (returning user on this device)
  // =============================================================================

  /** Individual digit values for the unlock PIN */
  let unlockDigits = $state(['', '', '', '', '', '']);

  /** Concatenated unlock code — derived from \`unlockDigits\` */
  const unlockCode = $derived(unlockDigits.join(''));

  /** Cached user profile info (first/last name) for the welcome message */
  let userInfo = $state<{ firstName: string; lastName: string } | null>(null);

  // =============================================================================
  //  Link Device Mode State (new device, existing remote user)
  // =============================================================================

  /** Individual digit values for the device-linking PIN */
  let linkDigits = $state(['', '', '', '', '', '']);

  /** Concatenated link code — derived from \`linkDigits\` */
  const linkCode = $derived(linkDigits.join(''));

  /**
   * Remote user info fetched from the gate config — contains email,
   * gate type, code length, and profile data for the welcome message.
   */
  let remoteUser = $state<{
    email: string;
    gateType: string;
    codeLength: number;
    profile: Record<string, unknown>;
  } | null>(null);

  /** \`true\` when we detected a remote user and entered link-device mode */
  let linkMode = $state(false);

  /** Loading state specific to the link-device flow */
  let linkLoading = $state(false);

  /** \`true\` when offline and no local setup exists — shows offline card */
  let offlineNoSetup = $state(false);

  // =============================================================================
  //  Rate-Limit Countdown State
  // =============================================================================

  /** Seconds remaining before the user can retry after a rate-limit */
  let retryCountdown = $state(0);

  /** Interval handle for the retry countdown timer */
  let retryTimer: ReturnType<typeof setInterval> | null = null;

  // =============================================================================
  //  Modal State — Email Confirmation & Device Verification
  // =============================================================================

  /** Show the "check your email" modal after initial signup */
  let showConfirmationModal = $state(false);

  /** Show the "new device detected" verification modal */
  let showDeviceVerificationModal = $state(false);

  /** Masked email address displayed in the device-verification modal */
  let maskedEmail = $state('');

  /** Seconds remaining before the "resend" button re-enables */
  let resendCooldown = $state(0);

  /** Interval handle for the resend cooldown timer */
  let resendTimer: ReturnType<typeof setInterval> | null = null;

  /** Interval handle for polling device verification status */
  let verificationPollTimer: ReturnType<typeof setInterval> | null = null;

  /** Guard flag to prevent double-execution of verification completion */
  let verificationCompleting = false; // guard against double execution

  // =============================================================================
  //  Input Refs — DOM references for focus management
  // =============================================================================

  /** References to the 6 setup-code \`<input>\` elements */
  let codeInputs: HTMLInputElement[] = $state([]);

  /** References to the 6 confirm-code \`<input>\` elements */
  let confirmInputs: HTMLInputElement[] = $state([]);

  /** References to the 6 unlock-code \`<input>\` elements */
  let unlockInputs: HTMLInputElement[] = $state([]);

  /** References to the link-code \`<input>\` elements */
  let linkInputs: HTMLInputElement[] = $state([]);

  // =============================================================================
  //  Cross-Tab Communication
  // =============================================================================

  /** BroadcastChannel instance for receiving \`AUTH_CONFIRMED\` from \`/confirm\` */
  let authChannel: BroadcastChannel | null = null;

  // =============================================================================
  //  Lifecycle — onMount
  // =============================================================================

  onMount(async () => {
    mounted = true;

    /* ── Demo mode → redirect to home ──── */
    if (isDemoMode()) {
      goto('/', { replaceState: true });
      return;
    }

    /* ── Check if this device has a local account ──── */
    const info = await getSingleUserInfo();
    if (info) {
      userInfo = {
        firstName: (info.profile.firstName as string) || '',
        lastName: (info.profile.lastName as string) || ''
      };
      deviceLinked = true;
    } else {
      /* ── No local setup → check for a remote user to link to ──── */
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      if (isOffline) {
        offlineNoSetup = true;
      } else {
        try {
          const remote = await fetchRemoteGateConfig();
          if (remote) {
            remoteUser = remote;
            linkMode = true;
          }
        } catch {
          /* No remote user found — fall through to normal setup */
        }
      }
    }

    /* ── Initial resolution complete — show the appropriate card ──── */
    resolving = false;

    /* ── Check for a persistent PIN lockout from a previous session ──── */
    const lockoutMs = await checkPersistentLockout();
    if (lockoutMs > 0) {
      startRetryCountdown(lockoutMs);
    }

    /* ── Listen for auth confirmation from the \`/confirm\` page ──── */
    try {
      authChannel = new BroadcastChannel('${opts.prefix}-auth-channel');
      authChannel.onmessage = async (event) => {
        if (event.data?.type === 'AUTH_CONFIRMED') {
          /* Bring this tab to the foreground before the confirm tab closes */
          window.focus();
          if (showConfirmationModal) {
            /* Setup confirmation complete → finalize account */
            const result = await completeSingleUserSetup();
            if (!result.error) {
              showConfirmationModal = false;
              await invalidateAll();
              goto('/');
            } else {
              error = result.error;
              showConfirmationModal = false;
            }
          } else if (showDeviceVerificationModal) {
            /* Device verification complete (same-browser broadcast) */
            await handleVerificationComplete();
          }
        }
      };
    } catch {
      /* BroadcastChannel not supported — user must manually refresh */
    }
  });

  // =============================================================================
  //  Lifecycle — onDestroy (cleanup timers & channels)
  // =============================================================================

  onDestroy(() => {
    authChannel?.close();
    if (resendTimer) clearInterval(resendTimer);
    if (retryTimer) clearInterval(retryTimer);
    stopVerificationPolling();
  });

  // =============================================================================
  //  Device Verification Polling
  // =============================================================================

  /**
   * Start polling the engine every 3 seconds to check whether the
   * device has been trusted (the user clicked the email link on
   * another device/browser).
   */
  function startVerificationPolling() {
    stopVerificationPolling();
    verificationPollTimer = setInterval(async () => {
      if (verificationCompleting) return;
      const trusted = await pollDeviceVerification();
      if (trusted) {
        await handleVerificationComplete();
      }
    }, 3000);
  }

  /**
   * Stop the verification polling interval and clear the handle.
   */
  function stopVerificationPolling() {
    if (verificationPollTimer) {
      clearInterval(verificationPollTimer);
      verificationPollTimer = null;
    }
  }

  /**
   * Finalize device verification — calls \`completeDeviceVerification\`
   * and redirects on success. Guarded by \`verificationCompleting\` to
   * prevent double-execution from both polling and BroadcastChannel.
   */
  async function handleVerificationComplete() {
    if (verificationCompleting) return;
    verificationCompleting = true;
    stopVerificationPolling();

    const result = await completeDeviceVerification();
    if (!result.error) {
      showDeviceVerificationModal = false;
      await invalidateAll();
      goto(redirectUrl);
    } else {
      error = result.error;
      showDeviceVerificationModal = false;
      verificationCompleting = false;
    }
  }

  // =============================================================================
  //  Resend & Retry Cooldowns
  // =============================================================================

  /**
   * Start a 30-second cooldown on the "Resend email" button to
   * prevent spamming the email service.
   */
  function startResendCooldown() {
    resendCooldown = 30;
    if (resendTimer) clearInterval(resendTimer);
    resendTimer = setInterval(() => {
      resendCooldown--;
      if (resendCooldown <= 0 && resendTimer) {
        clearInterval(resendTimer);
        resendTimer = null;
      }
    }, 1000);
  }

  /**
   * Start a countdown after receiving a rate-limit response from the
   * server. Disables the code inputs and auto-clears the error when
   * the countdown reaches zero.
   *
   * @param ms - The \`retryAfterMs\` value from the server response
   */
  function startRetryCountdown(ms: number) {
    if (retryTimer) clearInterval(retryTimer);
    retryCountdown = Math.ceil(ms / 1000);
    retryTimer = setInterval(() => {
      retryCountdown--;
      if (retryCountdown <= 0) {
        retryCountdown = 0;
        error = null;
        if (retryTimer) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
        lockoutEnded = true;
      }
    }, 1000);
  }

  /**
   * Format a lockout countdown in seconds as a human-readable string.
   * Short lockouts show seconds only; longer ones show minutes/hours.
   *
   * @param totalSeconds - Remaining seconds to display
   * @returns e.g. "45s", "2m 5s", "1h 4m 3s"
   */
  function formatCountdown(totalSeconds: number): string {
    if (totalSeconds < 60) return \`\${totalSeconds}s\`;
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return s > 0 ? \`\${h}h \${m}m \${s}s\` : \`\${h}h \${m}m\`;
    return \`\${m}m \${s}s\`;
  }

  // =============================================================================
  //  Email Resend Handler
  // =============================================================================

  /**
   * Resend the confirmation or verification email depending on
   * which modal is currently visible. Respects the resend cooldown.
   */
  async function handleResendEmail() {
    if (resendCooldown > 0) return;
    startResendCooldown();
    /* For setup confirmation → resend the signup email */
    if (showConfirmationModal) {
      const { resendConfirmationEmail } = await import('stellar-drive');
      await resendConfirmationEmail(email);
    }
    /* For device verification → resend the OTP email */
    if (showDeviceVerificationModal) {
      const info = await getSingleUserInfo();
      if (info?.email) {
        await sendDeviceVerification(info.email);
      }
    }
  }

  // =============================================================================
  //  Digit Input Handlers — Shared across all PIN-code fields
  // =============================================================================

  /**
   * Handle a single digit being typed into a PIN input box. Filters
   * non-numeric characters, auto-advances focus, and triggers
   * \`onComplete\` when the last digit is filled.
   *
   * @param digits    - The reactive digit array being edited
   * @param index     - Which position in the array this input represents
   * @param event     - The native \`input\` DOM event
   * @param inputs    - Array of \`HTMLInputElement\` refs for focus management
   * @param onComplete - Optional callback invoked when all digits are filled
   */
  function handleDigitInput(
    digits: string[],
    index: number,
    event: Event,
    inputs: HTMLInputElement[],
    onComplete?: () => void
  ) {
    const input = event.target as HTMLInputElement;
    const value = input.value.replace(/[^0-9]/g, '');

    if (value.length > 0) {
      digits[index] = value.charAt(value.length - 1);
      input.value = digits[index];
      /* Auto-focus the next input box */
      if (index < digits.length - 1 && inputs[index + 1]) {
        inputs[index + 1].focus();
      }
      /* Auto-submit when the last digit is entered (brief delay for UX) */
      if (index === digits.length - 1 && onComplete && digits.every((d) => d !== '')) {
        setTimeout(() => onComplete(), 300);
      }
    } else {
      digits[index] = '';
    }
  }

  /**
   * Handle backspace in a PIN input — moves focus to the previous
   * input when the current one is already empty.
   *
   * @param digits - The reactive digit array
   * @param index  - Current position index
   * @param event  - The native \`keydown\` event
   * @param inputs - Array of \`HTMLInputElement\` refs
   */
  function handleDigitKeydown(
    digits: string[],
    index: number,
    event: KeyboardEvent,
    inputs: HTMLInputElement[]
  ) {
    if (event.key === 'Backspace') {
      if (digits[index] === '' && index > 0 && inputs[index - 1]) {
        inputs[index - 1].focus();
        digits[index - 1] = '';
      } else {
        digits[index] = '';
      }
    }
  }

  /**
   * Handle paste into a PIN input — distributes pasted digits across
   * all input boxes and auto-submits if the full code was pasted.
   *
   * @param digits     - The reactive digit array
   * @param event      - The native \`paste\` clipboard event
   * @param inputs     - Array of \`HTMLInputElement\` refs
   * @param onComplete - Optional callback invoked when all digits are filled
   */
  function handleDigitPaste(
    digits: string[],
    event: ClipboardEvent,
    inputs: HTMLInputElement[],
    onComplete?: () => void
  ) {
    event.preventDefault();
    const pasted = (event.clipboardData?.getData('text') || '').replace(/[^0-9]/g, '');
    for (let i = 0; i < digits.length && i < pasted.length; i++) {
      digits[i] = pasted[i];
      if (inputs[i]) inputs[i].value = pasted[i];
    }
    const focusIndex = Math.min(pasted.length, digits.length - 1);
    if (inputs[focusIndex]) inputs[focusIndex].focus();
    /* Auto-submit if the full code was pasted at once */
    if (pasted.length >= digits.length && onComplete && digits.every((d) => d !== '')) {
      onComplete();
    }
  }

  // =============================================================================
  //  Setup Mode — Step Navigation
  // =============================================================================

  /**
   * Validate email and first name, then advance to the PIN-creation
   * step (step 2). Shows an error if validation fails.
   */
  function goToCodeStep() {
    if (!email.trim() || !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email.trim())) {
      error = 'Please enter a valid email address';
      return;
    }
    if (!firstName.trim()) {
      error = 'First name is required';
      return;
    }
    error = null;
    setupStep = 2;
  }

  /**
   * Navigate back from step 2 (PIN creation) to step 1 (email/name).
   */
  function goBackToNameStep() {
    setupStep = 1;
    error = null;
  }

  /**
   * Auto-focus the first confirm-code input when the primary code
   * is fully entered.
   */
  function autoFocusConfirm() {
    if (confirmInputs[0]) confirmInputs[0].focus();
  }

  /**
   * Trigger setup submission when the confirm-code auto-completes.
   */
  function autoSubmitSetup() {
    if (confirmDigits.every((d) => d !== '')) {
      handleSetup();
    }
  }

  /**
   * Trigger unlock submission when the unlock-code auto-completes.
   */
  function autoSubmitUnlock() {
    handleUnlock();
  }

  // =============================================================================
  //  Setup Mode — Account Creation
  // =============================================================================

  /**
   * Handle the full setup flow: validate the code matches its
   * confirmation, call \`setupSingleUser\`, and handle the response
   * (which may require email confirmation or succeed immediately).
   */
  async function handleSetup() {
    if (loading) return;

    error = null;

    if (code.length !== 6) {
      error = 'Please enter a 6-digit code';
      return;
    }

    /* Verify code and confirmation match */
    if (code !== confirmCode) {
      error = 'Codes do not match';
      shaking = true;
      setTimeout(() => {
        shaking = false;
      }, 500);
      /* Clear confirm digits and refocus the first confirm input */
      confirmDigits = ['', '', '', '', '', ''];
      if (confirmInputs[0]) confirmInputs[0].focus();
      return;
    }

    loading = true;

    try {
      const result = await setupSingleUser(
        code,
        {
          firstName: firstName.trim(),
          lastName: lastName.trim()
        },
        email.trim()
      );
      if (result.error) {
        error = result.error;
        shaking = true;
        setTimeout(() => {
          shaking = false;
        }, 500);
        codeDigits = ['', '', '', '', '', ''];
        confirmDigits = ['', '', '', '', '', ''];
        if (codeInputs[0]) codeInputs[0].focus();
        return;
      }
      if (result.confirmationRequired) {
        /* Email confirmation needed → show the "check your email" modal */
        showConfirmationModal = true;
        startResendCooldown();
        return;
      }
      /* No confirmation needed → go straight to the app (keep loading=true to avoid flash) */
      await invalidateAll();
      goto('/');
      return;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Setup failed. Please try again.';
      shaking = true;
      setTimeout(() => {
        shaking = false;
      }, 500);
      codeDigits = ['', '', '', '', '', ''];
      confirmDigits = ['', '', '', '', '', ''];
      if (codeInputs[0]) codeInputs[0].focus();
    }
    loading = false;
  }

  // =============================================================================
  //  Unlock Mode — PIN Entry for Returning Users
  // =============================================================================

  /**
   * Attempt to unlock the local account with the entered 6-digit PIN.
   * Handles rate-limiting, device verification requirements, and
   * error feedback with shake animation.
   */
  async function handleUnlock() {
    if (loading || retryCountdown > 0) return;

    error = null;

    if (unlockCode.length !== 6) {
      error = 'Please enter your 6-digit code';
      return;
    }

    loading = true;

    try {
      const result = await unlockSingleUser(unlockCode);
      if (result.error) {
        error = result.error;
        if (result.retryAfterMs) {
          startRetryCountdown(result.retryAfterMs);
        } else {
          setTimeout(() => { if (retryCountdown === 0) error = null; }, 2500);
        }
        shaking = true;
        setTimeout(() => { shaking = false; }, 500);
        unlockDigits = ['', '', '', '', '', ''];
        loading = false;
        await tick();
        if (unlockInputs[0]) unlockInputs[0].focus();
        return;
      }
      if (result.deviceVerificationRequired) {
        /* Untrusted device → show verification modal + start polling */
        maskedEmail = result.maskedEmail || '';
        showDeviceVerificationModal = true;
        startResendCooldown();
        startVerificationPolling();
        return;
      }
      /* Success → navigate to the redirect target (keep loading=true to avoid PIN flash) */
      await invalidateAll();
      goto(redirectUrl);
      return;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Incorrect code';
      setTimeout(() => { if (retryCountdown === 0) error = null; }, 2500);
      shaking = true;
      setTimeout(() => { shaking = false; }, 500);
      unlockDigits = ['', '', '', '', '', ''];
    }
    loading = false;
    if (error) {
      await tick();
      if (unlockInputs[0]) unlockInputs[0].focus();
    }
  }

  // =============================================================================
  //  Link Device Mode — Connect a New Device to an Existing Account
  // =============================================================================

  /**
   * Trigger link submission when the link-code auto-completes.
   */
  function autoSubmitLink() {
    if (linkDigits.every((d) => d !== '')) {
      handleLink();
    }
  }

  /**
   * Attempt to link this device to the remote user account by
   * submitting the PIN. Similar flow to unlock — may require device
   * verification or trigger rate-limiting.
   */
  async function handleLink() {
    if (linkLoading || !remoteUser || retryCountdown > 0) return;

    error = null;

    if (linkCode.length !== remoteUser.codeLength) {
      error = \`Please enter a \${remoteUser.codeLength}-digit code\`;
      return;
    }

    linkLoading = true;
    try {
      const result = await linkSingleUserDevice(remoteUser.email, linkCode);
      if (result.error) {
        error = result.error;
        if (result.retryAfterMs) {
          startRetryCountdown(result.retryAfterMs);
        } else {
          setTimeout(() => { if (retryCountdown === 0) error = null; }, 2500);
        }
        shaking = true;
        setTimeout(() => { shaking = false; }, 500);
        linkDigits = Array(remoteUser.codeLength).fill('');
        linkInputs.forEach(inp => { if (inp) inp.value = ''; });
        linkLoading = false;
        await tick();
        if (linkInputs[0]) linkInputs[0].focus();
        return;
      }
      if (result.deviceVerificationRequired) {
        maskedEmail = result.maskedEmail || '';
        showDeviceVerificationModal = true;
        startResendCooldown();
        startVerificationPolling();
        return;
      }
      /* Success → navigate to the redirect target (keep linkLoading=true to avoid flash) */
      await invalidateAll();
      goto(redirectUrl);
      return;
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Incorrect code';
      setTimeout(() => { if (retryCountdown === 0) error = null; }, 2500);
      shaking = true;
      setTimeout(() => { shaking = false; }, 500);
      linkDigits = Array(remoteUser.codeLength).fill('');
      linkInputs.forEach(inp => { if (inp) inp.value = ''; });
    }
    linkLoading = false;
    if (error) {
      await tick();
      if (linkInputs[0]) linkInputs[0].focus();
    }
  }
</script>

<svelte:head>
  <title>Login - ${opts.name}</title>
</svelte:head>

<div class="login-page" class:mounted>

  {#if resolving}
    <!-- Loading / resolving initial auth state -->
    <div class="login-card">
      <p class="app-name">${opts.name}</p>
      <p class="resolving-text">Loading...</p>
    </div>

  {:else if offlineNoSetup}
    <!-- Offline with no local account — can't set up without internet -->
    <div class="login-card">
      <p class="app-name">${opts.name}</p>
      <h2 class="card-title">Setup Required</h2>
      <p class="card-subtitle">An internet connection is required to set up this device</p>
    </div>

  {:else if deviceLinked}
    <!-- ── Unlock Mode — returning user on this device ── -->
    <div class="login-card" class:shaking>
      <div class="avatar">
        {(userInfo?.firstName || 'U').charAt(0).toUpperCase()}
      </div>
      <h2 class="card-title">
        Welcome back{#if userInfo?.firstName}, {userInfo.firstName}{/if}
      </h2>
      <p class="card-subtitle">Enter your code to continue</p>

      {#if loading}
        <div class="pin-loading"><span class="spinner"></span></div>
      {:else}
        <div class="pin-row">
          {#each unlockDigits as digit, i (i)}
            <input
              type="tel"
              inputmode="numeric"
              maxlength="1"
              class="pin-digit"
              bind:this={unlockInputs[i]}
              value={digit}
              oninput={(e) => handleDigitInput(unlockDigits, i, e, unlockInputs, autoSubmitUnlock)}
              onkeydown={(e) => handleDigitKeydown(unlockDigits, i, e, unlockInputs)}
              onpaste={(e) => handleDigitPaste(unlockDigits, e, unlockInputs, autoSubmitUnlock)}
              disabled={loading || retryCountdown > 0}
              autocomplete="off"
            />
          {/each}
        </div>
      {/if}
    </div>

  {:else if linkMode && remoteUser}
    <!-- ── Link Device Mode — new device, existing remote user ── -->
    <div class="login-card" class:shaking>
      <div class="avatar">
        {((remoteUser.profile?.firstName as string) || 'U').charAt(0).toUpperCase()}
      </div>
      <h2 class="card-title">
        Welcome back{remoteUser.profile?.firstName ? \`, \${remoteUser.profile.firstName as string}\` : ''}
      </h2>
      <p class="card-subtitle">Enter your code to link this device</p>

      {#if linkLoading}
        <div class="pin-loading"><span class="spinner"></span></div>
      {:else}
        <div class="pin-row">
          {#each linkDigits as digit, i (i)}
            <input
              type="tel"
              inputmode="numeric"
              maxlength="1"
              class="pin-digit"
              bind:this={linkInputs[i]}
              value={digit}
              oninput={(e) => handleDigitInput(linkDigits, i, e, linkInputs, autoSubmitLink)}
              onkeydown={(e) => handleDigitKeydown(linkDigits, i, e, linkInputs)}
              onpaste={(e) => handleDigitPaste(linkDigits, e, linkInputs, autoSubmitLink)}
              disabled={linkLoading || retryCountdown > 0 || offline}
              autocomplete="off"
            />
          {/each}
        </div>
      {/if}
    </div>

  {:else}
    <!-- ── Setup Mode — first-time account creation ── -->
    <div class="login-card" class:shaking>
      {#if setupStep === 1}
        <!-- Step 1: Email + name -->
        <p class="app-name">${opts.name}</p>
        <h2 class="card-title">Create your account</h2>

        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" bind:value={email} disabled={loading} placeholder="you@example.com" />
        </div>
        <div class="name-row">
          <div class="form-group">
            <label for="firstName">First Name</label>
            <input type="text" id="firstName" bind:value={firstName} disabled={loading} placeholder="Jane" />
          </div>
          <div class="form-group">
            <label for="lastName">Last Name</label>
            <input type="text" id="lastName" bind:value={lastName} disabled={loading} placeholder="Smith" />
          </div>
        </div>
        <button class="btn-primary" onclick={goToCodeStep} disabled={loading || offline}>
          Continue
        </button>

      {:else}
        <!-- Step 2: PIN creation + confirmation -->
        <h2 class="card-title">Create your PIN</h2>
        <p class="card-subtitle">Choose a 6-digit code</p>

        <div class="pin-row">
          {#each codeDigits as digit, i (i)}
            <input
              type="tel"
              inputmode="numeric"
              maxlength="1"
              class="pin-digit"
              bind:this={codeInputs[i]}
              value={digit}
              oninput={(e) => handleDigitInput(codeDigits, i, e, codeInputs, autoFocusConfirm)}
              onkeydown={(e) => handleDigitKeydown(codeDigits, i, e, codeInputs)}
              onpaste={(e) => handleDigitPaste(codeDigits, e, codeInputs, autoFocusConfirm)}
              disabled={loading || offline}
              autocomplete="off"
            />
          {/each}
        </div>

        <p class="card-subtitle">Confirm your code</p>
        <div class="pin-row">
          {#each confirmDigits as digit, i (i)}
            <input
              type="tel"
              inputmode="numeric"
              maxlength="1"
              class="pin-digit"
              bind:this={confirmInputs[i]}
              value={digit}
              oninput={(e) => handleDigitInput(confirmDigits, i, e, confirmInputs, autoSubmitSetup)}
              onkeydown={(e) => handleDigitKeydown(confirmDigits, i, e, confirmInputs)}
              onpaste={(e) => handleDigitPaste(confirmDigits, e, confirmInputs, autoSubmitSetup)}
              disabled={loading || offline}
              autocomplete="off"
            />
          {/each}
        </div>

        <button class="btn-secondary" onclick={goBackToNameStep} disabled={loading}>
          Back
        </button>
      {/if}
    </div>
  {/if}

  <!-- ── Bottom Status Banner ──────────────────────────────────────── -->
  <!--  Lockout: stays visible the entire countdown duration.          -->
  <!--  Error:   auto-dismissed after 2.5s by the handlers above.      -->
  {#if retryCountdown > 0}
    <div class="bottom-banner lockout-banner" transition:fade={{ duration: 250 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      <span>Too many attempts — try again in {formatCountdown(retryCountdown)}</span>
    </div>
  {:else if error}
    <div class="bottom-banner error-banner" transition:fade={{ duration: 250 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{error}</span>
    </div>
  {/if}

  <!-- Privacy Policy link -->
  <a href="/policy" class="policy-link">Privacy Policy</a>
</div>

<!-- ── Email Confirmation Modal ──────────────────────────────────── -->
{#if showConfirmationModal}
  <div class="modal-backdrop">
    <div class="modal-card">
      <h3 class="modal-title">Check your email</h3>
      <p class="modal-text">
        We sent a confirmation link to <strong>{email}</strong>. Click it to activate your account.
      </p>
      <button class="btn-primary" onclick={handleResendEmail} disabled={resendCooldown > 0 || offline}>
        {#if resendCooldown > 0}Resend in {resendCooldown}s{:else}Resend email{/if}
      </button>
    </div>
  </div>
{/if}

<!-- ── Device Verification Modal ─────────────────────────────────── -->
{#if showDeviceVerificationModal}
  <div class="modal-backdrop">
    <div class="modal-card">
      <h3 class="modal-title">New device detected</h3>
      <p class="modal-text">
        We sent a verification link to <strong>{maskedEmail}</strong>. Click it to trust this device.
      </p>
      <p class="modal-hint">This page will update automatically once verified.</p>
      <button class="btn-primary" onclick={handleResendEmail} disabled={resendCooldown > 0 || offline}>
        {#if resendCooldown > 0}Resend in {resendCooldown}s{:else}Resend email{/if}
      </button>
    </div>
  </div>
{/if}

<style>
  /* ── Page ── */
  .login-page {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: #111116;
    opacity: 0;
    transform: translateY(8px);
    transition: opacity 0.4s ease, transform 0.4s ease;
  }

  .login-page.mounted {
    opacity: 1;
    transform: translateY(0);
  }

  /* ── Card ── */
  .login-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 2rem;
    border-radius: 20px;
    width: 100%;
    max-width: 360px;
    text-align: center;
    background: #0f0f1e;
    border: 1px solid #3d5a3d;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  /* ── App name / brand ── */
  .app-name {
    font-size: 1.375rem;
    font-weight: 800;
    color: #6B9E6B;
    letter-spacing: -0.5px;
    margin: 0;
  }

  /* ── Avatar circle ── */
  .avatar {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    font-weight: 700;
    background: #1a2e1a;
    color: #6B9E6B;
    border: 2px solid #3d5a3d;
  }

  /* ── Card text ── */
  .card-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    color: #f0f0ff;
  }

  .card-subtitle {
    margin: 0;
    font-size: 0.875rem;
    color: #7878a0;
  }

  .resolving-text {
    font-size: 0.9375rem;
    color: #7878a0;
    margin: 0;
  }

  /* ── Spinner ── */
  .pin-loading {
    height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .name-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    width: 100%;
  }

  /* ── Policy link ── */
  .policy-link {
    font-size: 0.75rem;
    color: #7878a0;
    text-decoration: none;
    border-bottom: 1px solid rgba(120, 120, 160, 0.3);
    transition: color 0.15s;
  }
  .policy-link:hover { color: #D4A853; border-bottom-color: rgba(212, 168, 83, 0.4); }

  /* ── Shake animation ── */
  .shaking { animation: shake 0.5s ease-in-out; }

  @keyframes shake {
    0%,  100% { transform: translateX(0); }
    15%       { transform: translateX(-8px); }
    30%       { transform: translateX(7px); }
    45%       { transform: translateX(-6px); }
    60%       { transform: translateX(4px); }
    75%       { transform: translateX(-2px); }
  }

  /* ── Bottom status banner ── */
  .bottom-banner {
    position: fixed;
    bottom: max(32px, calc(env(safe-area-inset-bottom) + 20px));
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.625rem 1.125rem;
    border-radius: 100px;
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
    z-index: 200;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .lockout-banner {
    background: rgba(30, 20, 20, 0.9);
    border: 1px solid rgba(224, 90, 90, 0.4);
    color: #e05a5a;
  }

  .error-banner {
    background: rgba(30, 20, 20, 0.9);
    border: 1px solid rgba(224, 90, 90, 0.3);
    color: #e07070;
  }

</style>
`;
}

/**
 * Generate the email confirmation page component that handles token
 * verification and cross-tab broadcast.
 *
 * @returns The Svelte component source for `src/routes/confirm/+page.svelte`.
 */
function generateConfirmPage(opts: InstallOptions): string {
  return `<!--
  @fileoverview Email confirmation page — token verification, BroadcastChannel
  relay, and close/redirect flow.

  Supabase email links land here with \`?token_hash=...&type=...\` query
  params. The page verifies the token, broadcasts the result to the
  originating tab via BroadcastChannel, and either tells the user they
  can close the tab or redirects them to the app root.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { handleEmailConfirmation, broadcastAuthConfirmed } from 'stellar-drive/kit';
  import { isDemoMode } from 'stellar-drive/demo';

  // ==========================================================================
  //                                 STATE
  // ==========================================================================

  /** Current page state — drives which UI variant is rendered. */
  let status: 'verifying' | 'success' | 'error' | 'redirecting' | 'can_close' = 'verifying';

  /** Human-readable error message when verification fails. */
  let errorMessage = '';

  // ==========================================================================
  //                              CONSTANTS
  // ==========================================================================

  /** BroadcastChannel name shared with the login page. */
  const CHANNEL_NAME = '${opts.prefix}-auth-channel';

  // ==========================================================================
  //                              LIFECYCLE
  // ==========================================================================

  onMount(async () => {
    /* ── Demo mode or missing params → redirect home silently ── */
    if (isDemoMode()) {
      goto('/', { replaceState: true });
      return;
    }

    /* ── Read Supabase callback params ── */
    const tokenHash = $page.url.searchParams.get('token_hash');
    const type = $page.url.searchParams.get('type');
    const pendingDeviceId = $page.url.searchParams.get('pending_device_id') ?? undefined;
    const pendingDeviceLabel = $page.url.searchParams.get('pending_device_label') ?? undefined;

    if (!tokenHash || !type) {
      goto('/', { replaceState: true });
      return;
    }

    /* ── Verify the token ── */
    const result = await handleEmailConfirmation(
      tokenHash,
      type as 'signup' | 'email' | 'email_change' | 'magiclink',
      pendingDeviceId,
      pendingDeviceLabel
    );

    if (!result.success) {
      status = 'error';
      errorMessage = result.error || 'Unknown error';
      return;
    }

    status = 'success';

    /* ── Notify the originating tab — only reached on successful verification ── */
    const tabResult = await broadcastAuthConfirmed(CHANNEL_NAME, type);
    if (tabResult === 'can_close') {
      status = 'can_close';
    } else {
      /* BroadcastChannel unsupported — redirect to home directly */
      goto('/', { replaceState: true });
    }
  });
</script>

<svelte:head>
  <title>Confirming... - ${opts.name}</title>
</svelte:head>

<div class="confirm-page">
  <div class="confirm-card">
    <p class="app-name">${opts.name}</p>

    {#if status === 'verifying'}
      <div class="icon-circle">
        <span class="spinner"></span>
      </div>
      <h2 class="confirm-title">Verifying…</h2>
      <p class="confirm-text">Confirming your email link. This only takes a moment.</p>

    {:else if status === 'success' || status === 'redirecting'}
      <div class="icon-circle success">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <h2 class="confirm-title">Confirmed!</h2>
      <p class="confirm-text">Your email has been verified. You can close this tab.</p>

    {:else if status === 'can_close'}
      <div class="icon-circle success">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <h2 class="confirm-title">All done!</h2>
      <p class="confirm-text">You can close this tab and return to the app.</p>

    {:else if status === 'error'}
      <div class="icon-circle error">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <h2 class="confirm-title">Link expired</h2>
      <p class="confirm-text">{errorMessage || 'This confirmation link is no longer valid.'}</p>
      <a href="/login" class="confirm-btn">Back to login</a>
    {/if}
  </div>
</div>

<style>
  .confirm-page {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: #111116;
  }

  .confirm-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 2.5rem 2rem;
    border-radius: 24px;
    width: 100%;
    max-width: 360px;
    text-align: center;
    background: #0f0f1e;
    border: 1px solid #3d5a3d;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .app-name {
    font-size: 1.25rem;
    font-weight: 800;
    color: #6B9E6B;
    letter-spacing: -0.5px;
    margin: 0;
  }

  .icon-circle {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1a2e1a;
    border: 2px solid #3d5a3d;
    color: #6B9E6B;
  }

  .icon-circle.success {
    background: #1a2e1a;
    border-color: #6B9E6B;
    color: #6B9E6B;
  }

  .icon-circle.error {
    background: #2e1a1a;
    border-color: #7a3d3d;
    color: #e07070;
  }

  .confirm-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 700;
    color: #f0f0ff;
  }

  .confirm-text {
    margin: 0;
    font-size: 0.9rem;
    color: #c8c8e0;
    line-height: 1.6;
  }

  .confirm-btn {
    display: inline-block;
    padding: 0.75rem 1.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: #fff;
    background: #6B9E6B;
    border-radius: 10px;
    text-decoration: none;
    transition: opacity 0.15s;
  }

  .confirm-btn:hover { opacity: 0.9; }
</style>
`;
}

// ---------------------------------------------------------------------------
//                   API ENDPOINT GENERATORS
// ---------------------------------------------------------------------------

/**
 * Generate the `/api/config` server endpoint that returns runtime config.
 *
 * @returns The TypeScript source for `src/routes/api/config/+server.ts`.
 */
function generateConfigServer(): string {
  return `/**
 * @fileoverview Config API endpoint.
 *
 * Delegates entirely to stellar-drive's \`createConfigHandler()\` which
 * reads Supabase env vars and returns them with security headers
 * (Cache-Control, X-Content-Type-Options).
 */

import { createConfigHandler } from 'stellar-drive/kit';
import type { RequestHandler } from './$types';

/** GET /api/config — Retrieve the current Supabase configuration. */
export const GET: RequestHandler = createConfigHandler();
`;
}

/**
 * Generate the `/api/setup/deploy` server endpoint for Vercel deployment.
 *
 * @returns The TypeScript source for `src/routes/api/setup/deploy/+server.ts`.
 */
function generateDeployServer(opts: InstallOptions): string {
  return `/**
 * @fileoverview Vercel deploy endpoint.
 *
 * Delegates entirely to stellar-drive's \`createDeployHandler()\` which
 * deploys Supabase credentials to Vercel and includes built-in security
 * guards (already-configured check + CSRF origin validation).
 */

import { createDeployHandler } from 'stellar-drive/kit';
import type { RequestHandler } from './$types';

/** POST /api/setup/deploy — Deploy Supabase config to Vercel. */
export const POST: RequestHandler = createDeployHandler({ prefix: '${opts.prefix}' });
`;
}

/**
 * Generate the `/api/setup/validate` server endpoint for Supabase credential validation.
 *
 * @returns The TypeScript source for `src/routes/api/setup/validate/+server.ts`.
 */
function generateValidateServer(): string {
  return `/**
 * Supabase Credential Validation Endpoint — \`POST /api/setup/validate\`
 *
 * Accepts a Supabase URL and publishable key, attempts a lightweight query
 * against the project, and returns whether the credentials are valid.
 * Used by the setup wizard before saving config.
 */

import { createValidateHandler } from 'stellar-drive/kit';
import type { RequestHandler } from './$types';

/** Validate Supabase credentials — delegates to stellar-drive's handler factory. */
export const POST: RequestHandler = createValidateHandler();
`;
}

// ---------------------------------------------------------------------------
//                  CATCHALL & PROTECTED LAYOUT GENERATORS
// ---------------------------------------------------------------------------

/**
 * Generate a server-only catch-all route that redirects unknown paths to the
 * home page before any bad-route UI mounts.
 *
 * @returns The TypeScript source for `src/routes/[...catchall]/+page.server.ts`.
 */
function generateCatchallPage(): string {
  return `/**
 * Catch-All Route Handler — \`[...catchall]/+page.server.ts\`
 *
 * Unknown URLs should redirect to \`/\` before any bad-route page renders.
 * A server-only redirect keeps the app shell out of the invalid route,
 * avoiding stale UI state and intermediate-screen flicker.
 */

import { redirect } from '@sveltejs/kit';

export function load() {
  redirect(302, '/');
}
`;
}

/**
 * Generate the profile page component with TODO stubs for user settings,
 * device management, and debug tools.
 *
 * @returns The Svelte component source for `src/routes/profile/+page.svelte`.
 */
function generateProfilePage(opts: InstallOptions): string {
  return `<!--
  @fileoverview Profile & settings page.

  Capabilities:
    - View / edit display name and avatar
    - Change email address (with re-verification)
    - Change unlock gate type (PIN length, pattern, etc.)
    - Manage trusted devices (view, revoke)
    - Toggle debug mode
    - Reset local database (destructive — requires confirmation)

  Diagnostics surface (available via \`getDiagnostics()\` from stellar-drive):
    - \`sync.status\` — 'idle' | 'syncing' | 'error'
    - \`sync.progress\` — \`{ total, completed, failed, currentTable }\` | null
        Populated during high-volume batch pushes so the UI can render a
        determinate progress bar ("Catching up 1,200 / 2,500"). The
        \`<SyncStatus>\` component already renders this as a 'catching-up'
        state with progress ring — no extra wiring needed.
    - \`realtime.batchSuspended\` — true while the realtime channel is
        intentionally torn down during a large batch push (egress
        optimization — not a failure). Surface this in any "connection
        state" UI so users don't mistake it for a disconnect.
    - \`queue.pendingOperations\` / \`queue.itemsInBackoff\` — live queue depth.
    - \`egress.totalFormatted\` — human-readable session bandwidth usage.
    - \`errors.recentErrors\` — rolling per-entity sync error history.
-->
<script lang="ts">
  // =============================================================================
  //                               IMPORTS
  // =============================================================================

  import { goto } from '$app/navigation';
  import {
    changeSingleUserGate,
    updateSingleUserProfile,
    getSingleUserInfo,
    changeSingleUserEmail,
    completeSingleUserEmailChange,
    resolveUserId,
    resolveAvatarInitial
  } from 'stellar-drive/auth';
  import { authState } from 'stellar-drive/stores';
  import { isDebugMode, setDebugMode, getDiagnostics } from 'stellar-drive/utils';
  import type { DiagnosticsSnapshot } from 'stellar-drive';
  import {
    resetDatabase,
    getTrustedDevices,
    removeTrustedDevice,
    getCurrentDeviceId,
    isDemoMode
  } from 'stellar-drive';
  import { repairSyncQueue } from 'stellar-drive/engine';
  import type { TrustedDevice } from 'stellar-drive';
  import { getDemoConfig } from 'stellar-drive';
  import { showDemoBlocked } from 'stellar-drive/demo';
  import { isOffline } from 'stellar-drive';
  import { onMount } from 'svelte';

  /** Whether the app is in demo mode — shows a simplified read-only profile. */
  const inDemoMode = $derived(isDemoMode());

  /** Whether the app is currently offline — disables network-dependent actions. */
  const offline = $derived(isOffline());

  // =============================================================================
  //                         COMPONENT STATE
  // =============================================================================

  /* ── Profile form fields ──── */
  let firstName = $state('');
  let lastName = $state('');

  /* ── Gate (6-digit code) change — digit-array approach ──── */
  let oldCodeDigits = $state(['', '', '', '', '', '']);
  let newCodeDigits = $state(['', '', '', '', '', '']);
  let confirmCodeDigits = $state(['', '', '', '', '', '']);

  /** Concatenated old code string → derived from individual digit inputs */
  const oldCode = $derived(oldCodeDigits.join(''));
  /** Concatenated new code string → derived from individual digit inputs */
  const newCode = $derived(newCodeDigits.join(''));
  /** Concatenated confirm code string — must match \`newCode\` */
  const confirmNewCode = $derived(confirmCodeDigits.join(''));

  /* ── Input element refs for auto-focus advancement ──── */
  let oldCodeInputs: HTMLInputElement[] = $state([]);
  let newCodeInputs: HTMLInputElement[] = $state([]);
  let confirmCodeInputs: HTMLInputElement[] = $state([]);

  /* ── Email change fields ──── */
  let currentEmail = $state('');
  let newEmail = $state('');
  let emailLoading = $state(false);
  let emailError = $state<string | null>(null);
  let emailSuccess = $state<string | null>(null);
  /** Whether the email confirmation modal overlay is visible */
  let showEmailConfirmationModal = $state(false);
  /** Seconds remaining before the user can re-send the confirmation email */
  let emailResendCooldown = $state(0);

  /* ── General UI / feedback state ──── */
  let profileLoading = $state(false);
  let codeLoading = $state(false);
  let profileError = $state<string | null>(null);
  let profileSuccess = $state<string | null>(null);
  let codeError = $state<string | null>(null);
  let codeSuccess = $state<string | null>(null);
  let debugMode = $state(isDebugMode());
  let resetting = $state(false);

  /* ── Debug tools loading flags ──── */
  let forceSyncing = $state(false);
  let triggeringSyncManual = $state(false);
  let resettingCursor = $state(false);
  let repairingSyncQueue = $state(false);

  let viewingTombstones = $state(false);
  let cleaningTombstones = $state(false);

  /* ── Trusted devices ──── */
  let trustedDevices = $state<TrustedDevice[]>([]);
  let currentDeviceId = $state('');
  let devicesLoading = $state(true);
  /** ID of the device currently being removed — shows spinner on that row */
  let removingDeviceId = $state<string | null>(null);

  /* ── Diagnostics ──── */
  let diagnostics = $state<DiagnosticsSnapshot | null>(null);
  let diagnosticsInterval: ReturnType<typeof setInterval> | null = null;

  /** Start polling diagnostics when debug mode is active. */
  async function refreshDiagnostics() {
    try {
      diagnostics = await getDiagnostics();
    } catch {
      // Non-fatal — diagnostics are best-effort
    }
  }

  $effect(() => {
    if (debugMode) {
      refreshDiagnostics();
      diagnosticsInterval = setInterval(refreshDiagnostics, 3000);
    } else {
      if (diagnosticsInterval) {
        clearInterval(diagnosticsInterval);
        diagnosticsInterval = null;
      }
      diagnostics = null;
    }
    return () => {
      if (diagnosticsInterval) {
        clearInterval(diagnosticsInterval);
        diagnosticsInterval = null;
      }
    };
  });

  // =============================================================================
  //                           LIFECYCLE
  // =============================================================================

  /** Populate form fields from the engine and load trusted devices on mount. */
  onMount(async () => {
    /* In demo mode, populate from mock profile instead of real data */
    if (inDemoMode) {
      const demoConfig = getDemoConfig();
      if (demoConfig) {
        firstName = demoConfig.mockProfile.firstName;
        lastName = demoConfig.mockProfile.lastName;
        currentEmail = demoConfig.mockProfile.email;
      }

      // Mock trusted devices — from demoConfig so they stay in sync with config
      currentDeviceId = 'demo-device';
      trustedDevices = (demoConfig?.mockDevices ?? []) as TrustedDevice[];

      // Mock diagnostics — reflect disconnected/unsynced state
      diagnostics = {
        timestamp: new Date().toISOString(),
        prefix: '${opts.prefix}',
        deviceId: 'demo-device',
        sync: {
          status: 'idle' as const,
          totalCycles: 0,
          lastSyncTime: null,
          lastSuccessfulSyncTimestamp: null,
          syncMessage: null,
          recentCycles: [],
          cyclesLastMinute: 0,
          hasHydrated: false,
          schemaValidated: false,
          pendingCount: 0
        },
        egress: {
          sessionStart: new Date().toISOString(),
          totalBytes: 0,
          totalFormatted: '0 B',
          totalRecords: 0,
          byTable: {}
        },
        queue: {
          pendingOperations: 0,
          pendingEntityIds: [],
          byTable: {},
          byOperationType: {},
          oldestPendingTimestamp: null,
          itemsInBackoff: 0
        },
        realtime: {
          connectionState: 'disconnected' as const,
          healthy: false,
          reconnectAttempts: 0,
          lastError: null,
          userId: null,
          deviceId: 'demo-device',
          recentlyProcessedCount: 0,
          operationInProgress: false,
          reconnectScheduled: false,
          batchSuspended: false
        },
        network: { online: true },
        engine: {
          isTabVisible: true,
          tabHiddenAt: null,
          lockHeld: false,
          lockHeldForMs: null,
          recentlyModifiedCount: 0,
          wasOffline: false,
          authValidatedAfterReconnect: false
        },
        conflicts: { recentHistory: [], totalCount: 0 },
        errors: { lastError: null, lastErrorDetails: null, recentErrors: [] },
        config: {
          tableCount: 0,
          tableNames: [],
          syncDebounceMs: 500,
          syncIntervalMs: 30000,
          tombstoneMaxAgeDays: 30
        }
      } as DiagnosticsSnapshot;

      devicesLoading = false;
      return;
    }

    const info = await getSingleUserInfo();
    if (info) {
      firstName = (info.profile.firstName as string) || '';
      lastName = (info.profile.lastName as string) || '';
      currentEmail = info.email || '';
    }

    // Load trusted devices
    currentDeviceId = getCurrentDeviceId();
    try {
      const userId = resolveUserId($authState?.session, $authState?.offlineProfile);
      if (userId) {
        trustedDevices = await getTrustedDevices(userId);
      }
    } catch {
      // Ignore errors loading devices
    }
    devicesLoading = false;
  });

  // =============================================================================
  //                     DIGIT INPUT HELPERS
  // =============================================================================

  /**
   * Handle single-digit input in a code field.
   * Auto-advances focus to the next input when a digit is entered.
   * @param digits  - Reactive digit array to mutate
   * @param index   - Position in the 6-digit code (0–5)
   * @param event   - Native input event
   * @param inputs  - Array of \`<input>\` refs for focus management
   */
  function handleDigitInput(
    digits: string[],
    index: number,
    event: Event,
    inputs: HTMLInputElement[]
  ) {
    const input = event.target as HTMLInputElement;
    const value = input.value.replace(/[^0-9]/g, '');
    if (value.length > 0) {
      digits[index] = value.charAt(value.length - 1);
      input.value = digits[index];
      if (index < 5 && inputs[index + 1]) {
        inputs[index + 1].focus();
      }
    } else {
      digits[index] = '';
    }
  }

  /**
   * Handle Backspace in a digit field — moves focus backward when the current
   * digit is already empty.
   * @param digits  - Reactive digit array to mutate
   * @param index   - Position in the 6-digit code (0–5)
   * @param event   - Native keyboard event
   * @param inputs  - Array of \`<input>\` refs for focus management
   */
  function handleDigitKeydown(
    digits: string[],
    index: number,
    event: KeyboardEvent,
    inputs: HTMLInputElement[]
  ) {
    if (event.key === 'Backspace') {
      if (digits[index] === '' && index > 0 && inputs[index - 1]) {
        inputs[index - 1].focus();
        digits[index - 1] = '';
      } else {
        digits[index] = '';
      }
    }
  }

  /**
   * Handle paste into a digit field — distributes pasted digits across all 6 inputs.
   * @param digits  - Reactive digit array to mutate
   * @param event   - Native clipboard event
   * @param inputs  - Array of \`<input>\` refs for focus management
   */
  function handleDigitPaste(digits: string[], event: ClipboardEvent, inputs: HTMLInputElement[]) {
    event.preventDefault();
    const pasted = (event.clipboardData?.getData('text') || '').replace(/[^0-9]/g, '');
    for (let i = 0; i < 6 && i < pasted.length; i++) {
      digits[i] = pasted[i];
      if (inputs[i]) inputs[i].value = pasted[i];
    }
    const focusIndex = Math.min(pasted.length, 5);
    if (inputs[focusIndex]) inputs[focusIndex].focus();
  }

  // =============================================================================
  //                      FORM SUBMISSION HANDLERS
  // =============================================================================

  /**
   * Submit profile name changes to the engine and update the auth store
   * so the navbar reflects changes immediately.
   * @param e - Form submit event
   */
  async function handleProfileSubmit(e: Event) {
    e.preventDefault();
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    profileLoading = true;
    profileError = null;
    profileSuccess = null;

    try {
      const result = await updateSingleUserProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim()
      });
      if (result.error) {
        profileError = result.error;
      } else {
        // Update auth state to immediately reflect changes in navbar
        authState.updateUserProfile({ first_name: firstName.trim(), last_name: lastName.trim() });
        profileSuccess = 'Profile updated successfully';
        setTimeout(() => (profileSuccess = null), 3000);
      }
    } catch (err: unknown) {
      profileError = err instanceof Error ? err.message : 'Failed to update profile';
    }

    profileLoading = false;
  }

  /**
   * Validate and submit a 6-digit gate code change.
   * Resets all digit arrays on success.
   * @param e - Form submit event
   */
  async function handleCodeSubmit(e: Event) {
    e.preventDefault();
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }

    if (oldCode.length !== 6) {
      codeError = 'Please enter your current 6-digit code';
      return;
    }

    if (newCode.length !== 6) {
      codeError = 'Please enter a new 6-digit code';
      return;
    }

    if (newCode !== confirmNewCode) {
      codeError = 'New codes do not match';
      return;
    }

    codeLoading = true;
    codeError = null;
    codeSuccess = null;

    try {
      const result = await changeSingleUserGate(oldCode, newCode);
      if (result.error) {
        codeError = result.error;
      } else {
        codeSuccess = 'Code changed successfully';
        oldCodeDigits = ['', '', '', '', '', ''];
        newCodeDigits = ['', '', '', '', '', ''];
        confirmCodeDigits = ['', '', '', '', '', ''];
        setTimeout(() => (codeSuccess = null), 3000);
      }
    } catch (err: unknown) {
      codeError = err instanceof Error ? err.message : 'Failed to change code';
    }

    codeLoading = false;
  }

  // =============================================================================
  //                      EMAIL CHANGE FLOW
  // =============================================================================

  /**
   * Initiate an email change — sends a confirmation link to the new address.
   * Opens the confirmation modal and starts listening for the cross-tab
   * \`BroadcastChannel\` auth event.
   * @param e - Form submit event
   */
  async function handleEmailSubmit(e: Event) {
    e.preventDefault();
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    emailError = null;
    emailSuccess = null;

    if (!newEmail.trim()) {
      emailError = 'Please enter a new email address';
      return;
    }

    if (newEmail.trim() === currentEmail) {
      emailError = 'New email is the same as your current email';
      return;
    }

    emailLoading = true;

    try {
      const result = await changeSingleUserEmail(newEmail.trim());
      if (result.error) {
        emailError = result.error;
      } else if (result.confirmationRequired) {
        showEmailConfirmationModal = true;
        startResendCooldown();
        listenForEmailConfirmation();
      }
    } catch (err: unknown) {
      emailError = err instanceof Error ? err.message : 'Failed to change email';
    }

    emailLoading = false;
  }

  /** Start a 30-second countdown preventing repeated confirmation emails. */
  function startResendCooldown() {
    emailResendCooldown = 30;
    const interval = setInterval(() => {
      emailResendCooldown--;
      if (emailResendCooldown <= 0) clearInterval(interval);
    }, 1000);
  }

  /** Re-send the email change confirmation (guarded by cooldown). */
  async function handleResendEmailChange() {
    if (emailResendCooldown > 0) return;
    try {
      await changeSingleUserEmail(newEmail.trim());
      startResendCooldown();
    } catch {
      // Ignore resend errors
    }
  }

  /**
   * Listen on a \`BroadcastChannel\` for the confirmation tab to signal
   * that the user clicked the email-change link. Once received, complete
   * the email change server-side and update local state.
   */
  function listenForEmailConfirmation() {
    if (!('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel('${opts.prefix}-auth-channel');
    channel.onmessage = async (event) => {
      if (
        event.data?.type === 'AUTH_CONFIRMED' &&
        event.data?.verificationType === 'email_change'
      ) {
        // Bring this tab to the foreground before the confirm tab closes
        window.focus();
        const result = await completeSingleUserEmailChange();
        if (!result.error && result.newEmail) {
          currentEmail = result.newEmail;
          emailSuccess = 'Email changed successfully';
          newEmail = '';
          setTimeout(() => (emailSuccess = null), 5000);
        } else {
          emailError = result.error || 'Failed to complete email change';
        }
        showEmailConfirmationModal = false;
        channel.close();
      }
    };
  }

  // =============================================================================
  //                     ADMINISTRATION HANDLERS
  // =============================================================================

  /** Navigate back to the home view. */
  function goBack() {
    goto('/');
  }

  /**
   * Delete and recreate the local IndexedDB, then reload the page.
   * Session is preserved in localStorage so the app will re-hydrate.
   */
  async function handleResetDatabase() {
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    if (
      !confirm(
        'This will delete all local data and reload. Your data will be re-synced from the server. Continue?'
      )
    ) {
      return;
    }
    resetting = true;
    try {
      await resetDatabase();
      // Reload the page — session is preserved in localStorage, so the app
      // will re-create the DB, fetch config from Supabase, and re-hydrate.
      window.location.reload();
    } catch (err) {
      alert('Reset failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
      resetting = false;
    }
  }

  /**
   * Remove a trusted device by ID and update the local list.
   * @param id - Database ID of the trusted device row
   */
  async function handleRemoveDevice(id: string) {
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    removingDeviceId = id;
    try {
      await removeTrustedDevice(id);
      trustedDevices = trustedDevices.filter((d) => d.id !== id);
    } catch {
      // Ignore errors
    }
    removingDeviceId = null;
  }

  // =============================================================================
  //                     DEBUG TOOL HANDLERS
  // =============================================================================

  /**
   * Cast \`window\` to an untyped record for accessing runtime-injected
   * debug helpers (e.g., \`__${opts.prefix}Sync\`, \`__${opts.prefix}Diagnostics\`).
   * @returns The global \`window\` as a loose \`Record\`
   */
  function getDebugWindow(): Record<string, unknown> {
    return window as unknown as Record<string, unknown>;
  }

  /** Resets the sync cursor and re-downloads all data from Supabase. */
  async function handleForceFullSync() {
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    if (
      !confirm(
        'This will reset the sync cursor and re-download all data from the server. Continue?'
      )
    )
      return;
    forceSyncing = true;
    try {
      const fn = getDebugWindow().__${opts.prefix}Sync as { forceFullSync: () => Promise<void> } | undefined;
      if (fn?.forceFullSync) {
        await fn.forceFullSync();
        alert('Force full sync complete.');
      } else {
        alert('Debug mode must be enabled and the page refreshed to use this tool.');
      }
    } catch (err) {
      alert('Force full sync failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
    forceSyncing = false;
  }

  /** Manually trigger a single push/pull sync cycle. */
  async function handleTriggerSync() {
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    triggeringSyncManual = true;
    try {
      const fn = getDebugWindow().__${opts.prefix}Sync as { sync: () => Promise<void> } | undefined;
      if (fn?.sync) {
        await fn.sync();
        alert('Sync cycle complete.');
      } else {
        alert('Debug mode must be enabled and the page refreshed to use this tool.');
      }
    } catch (err) {
      alert('Sync failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
    triggeringSyncManual = false;
  }

  /** Reset the sync cursor so the next cycle pulls all remote data. */
  async function handleResetSyncCursor() {
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    resettingCursor = true;
    try {
      const fn = getDebugWindow().__${opts.prefix}Sync as { resetSyncCursor: () => Promise<void> } | undefined;
      if (fn?.resetSyncCursor) {
        await fn.resetSyncCursor();
        alert('Sync cursor reset. The next sync will pull all data.');
      } else {
        alert('Debug mode must be enabled and the page refreshed to use this tool.');
      }
    } catch (err) {
      alert('Reset cursor failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
    resettingCursor = false;
  }

  /** Log soft-deleted record counts per table to the browser console. */
  async function handleViewTombstones() {
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    viewingTombstones = true;
    try {
      const fn = getDebugWindow().__${opts.prefix}Tombstones as
        | ((opts?: { cleanup?: boolean; force?: boolean }) => Promise<void>)
        | undefined;
      if (fn) {
        await fn();
        alert('Tombstone details logged to console. Open DevTools to view.');
      } else {
        alert('Debug mode must be enabled and the page refreshed to use this tool.');
      }
    } catch (err) {
      alert('View tombstones failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
    viewingTombstones = false;
  }

  /** Permanently remove old soft-deleted records from local + remote DBs. */
  async function handleCleanupTombstones() {
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    if (
      !confirm(
        'This will permanently remove old soft-deleted records from local and server databases. Continue?'
      )
    )
      return;
    cleaningTombstones = true;
    try {
      const fn = getDebugWindow().__${opts.prefix}Tombstones as
        | ((opts?: { cleanup?: boolean; force?: boolean }) => Promise<void>)
        | undefined;
      if (fn) {
        await fn({ cleanup: true });
        alert('Tombstone cleanup complete. Details logged to console.');
      } else {
        alert('Debug mode must be enabled and the page refreshed to use this tool.');
      }
    } catch (err) {
      alert('Tombstone cleanup failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
    cleaningTombstones = false;
  }

  /** Repair the local sync queue — resolves stuck or malformed pending operations. */
  async function handleRepairSyncQueue() {
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    repairingSyncQueue = true;
    try {
      const count = await repairSyncQueue();
      alert(\`Sync queue repaired. \${count} operation\${count !== 1 ? 's' : ''} removed.\`);
    } catch (err) {
      alert('Repair failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
    }
    repairingSyncQueue = false;
  }

  /** Dispatch a custom event that the app shell listens for to sign out on mobile. */
  function handleMobileSignOut() {
    if (inDemoMode) {
      showDemoBlocked('Not available in demo mode');
      return;
    }
    window.dispatchEvent(new CustomEvent('${opts.prefix}:signout'));
  }
</script>

<svelte:head>
  <title>Profile - ${opts.name}</title>
</svelte:head>

<div class="profile-page">

  <!-- ── Page header ──────────────────────────────────────────── -->
  <header class="profile-header">
    <button class="back-btn" onclick={goBack} type="button" aria-label="Go back">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M19 12H5" />
        <path d="M12 19l-7-7 7-7" />
      </svg>
      <span>Back</span>
    </button>
    <h1 class="profile-heading">Profile</h1>
    <div class="header-spacer"></div>
  </header>

  <!-- ── Profile ──────────────────────────────────────────────── -->
  <section class="profile-card">
    <div class="section-header">
      <div class="avatar-circle">
        {resolveAvatarInitial($authState.session, $authState.offlineProfile)}
      </div>
      <div>
        <h2 class="section-title">Your Profile</h2>
        <p class="section-sub">{currentEmail || 'No email'}</p>
      </div>
    </div>

    {#if !inDemoMode}
      <form class="profile-form" onsubmit={handleProfileSubmit}>
        <div class="form-row">
          <div class="form-group">
            <label for="firstName">First name</label>
            <input id="firstName" type="text" bind:value={firstName} disabled={profileLoading || offline} autocomplete="given-name" />
          </div>
          <div class="form-group">
            <label for="lastName">Last name</label>
            <input id="lastName" type="text" bind:value={lastName} disabled={profileLoading || offline} autocomplete="family-name" />
          </div>
        </div>
        {#if profileError}<p class="msg msg-error">{profileError}</p>{/if}
        {#if profileSuccess}<p class="msg msg-success">{profileSuccess}</p>{/if}
        <button class="btn-primary" type="submit" disabled={profileLoading || offline}>
          {profileLoading ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    {:else}
      <p class="demo-note">Profile editing is disabled in demo mode.</p>
    {/if}
  </section>

  <!-- ── Change PIN ─────────────────────────────────────────────── -->
  <section class="profile-card">
    <h2 class="section-title">Change PIN</h2>
    <p class="section-sub">Update your 6-digit access code</p>

    <div class="pin-section">
      <p class="pin-label" aria-hidden="true">Current code</p>
      <div class="pin-row" role="group" aria-label="Current code">
        {#each oldCodeDigits as digit, i (i)}
          <input type="tel" inputmode="numeric" maxlength="1" class="pin-digit"
            bind:this={oldCodeInputs[i]} value={digit}
            oninput={(e) => handleDigitInput(oldCodeDigits, i, e, oldCodeInputs)}
            onkeydown={(e) => handleDigitKeydown(oldCodeDigits, i, e, oldCodeInputs)}
            onpaste={(e) => handleDigitPaste(oldCodeDigits, e, oldCodeInputs)}
            disabled={codeLoading || inDemoMode || offline} autocomplete="off" />
        {/each}
      </div>

      <p class="pin-label" aria-hidden="true">New code</p>
      <div class="pin-row" role="group" aria-label="New code">
        {#each newCodeDigits as digit, i (i)}
          <input type="tel" inputmode="numeric" maxlength="1" class="pin-digit"
            bind:this={newCodeInputs[i]} value={digit}
            oninput={(e) => handleDigitInput(newCodeDigits, i, e, newCodeInputs)}
            onkeydown={(e) => handleDigitKeydown(newCodeDigits, i, e, newCodeInputs)}
            onpaste={(e) => handleDigitPaste(newCodeDigits, e, newCodeInputs)}
            disabled={codeLoading || inDemoMode || offline} autocomplete="off" />
        {/each}
      </div>

      <p class="pin-label" aria-hidden="true">Confirm new code</p>
      <div class="pin-row" role="group" aria-label="Confirm new code">
        {#each confirmCodeDigits as digit, i (i)}
          <input type="tel" inputmode="numeric" maxlength="1" class="pin-digit"
            bind:this={confirmCodeInputs[i]} value={digit}
            oninput={(e) => handleDigitInput(confirmCodeDigits, i, e, confirmCodeInputs)}
            onkeydown={(e) => handleDigitKeydown(confirmCodeDigits, i, e, confirmCodeInputs)}
            onpaste={(e) => handleDigitPaste(confirmCodeDigits, e, confirmCodeInputs)}
            disabled={codeLoading || inDemoMode || offline} autocomplete="off" />
        {/each}
      </div>
    </div>

    {#if codeError}<p class="msg msg-error">{codeError}</p>{/if}
    {#if codeSuccess}<p class="msg msg-success">{codeSuccess}</p>{/if}
    <button class="btn-primary" onclick={handleCodeSubmit} disabled={codeLoading || inDemoMode || offline}>
      {codeLoading ? 'Updating…' : 'Update PIN'}
    </button>
  </section>

  <!-- ── Change Email ───────────────────────────────────────────── -->
  <section class="profile-card">
    <h2 class="section-title">Change Email</h2>
    <p class="section-sub">A confirmation link will be sent to the new address</p>

    <div class="form-group">
      <label for="newEmail">New email address</label>
      <input id="newEmail" type="email" bind:value={newEmail}
        placeholder={currentEmail} disabled={emailLoading || inDemoMode || offline}
        autocomplete="email" />
    </div>
    {#if emailError}<p class="msg msg-error">{emailError}</p>{/if}
    {#if emailSuccess}<p class="msg msg-success">{emailSuccess}</p>{/if}
    <button class="btn-primary" onclick={handleEmailSubmit} disabled={emailLoading || !newEmail || inDemoMode || offline}>
      {emailLoading ? 'Sending…' : 'Send confirmation'}
    </button>
  </section>

  <!-- ── Trusted Devices ───────────────────────────────────────── -->
  <section class="profile-card">
    <h2 class="section-title">Trusted Devices</h2>
    <p class="section-sub">Devices linked to your account</p>

    {#if devicesLoading}
      <p class="loading-text">Loading devices…</p>
    {:else if trustedDevices.length === 0}
      <p class="empty-text">No trusted devices found.</p>
    {:else}
      <div class="devices-list">
        {#each trustedDevices as device (device.id)}
          <div class="device-row">
            <div class="device-info">
              <div class="device-name">
                {device.deviceLabel || 'Unknown device'}
                {#if device.deviceId === currentDeviceId}
                  <span class="badge-current">This device</span>
                {/if}
              </div>
              <div class="device-meta">
                Last used {new Date(device.lastUsedAt).toLocaleDateString()}
              </div>
            </div>
            <button
              class="btn-remove"
              onclick={() => handleRemoveDevice(device.id)}
              disabled={removingDeviceId === device.id || inDemoMode || offline}
              aria-label="Remove device"
            >
              {#if removingDeviceId === device.id}
                <span class="spinner-small"></span>
              {:else}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14H6L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4h6v2" />
                </svg>
              {/if}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <!-- ── Settings ──────────────────────────────────────────────── -->
  <section class="profile-card">
    <h2 class="section-title">Settings</h2>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-label">Supabase Setup</span>
        <span class="setting-desc">Update credentials or redeploy</span>
      </div>
      <a href="/setup" class="btn-secondary-sm">Configure</a>
    </div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-label">Debug mode</span>
        <span class="setting-desc">Enables verbose console logging</span>
      </div>
      <label class="toggle" aria-label="Toggle debug mode">
        <input type="checkbox" bind:checked={debugMode} onchange={() => setDebugMode(debugMode)} />
        <span class="toggle-track"></span>
      </label>
    </div>

    <div class="setting-row">
      <div class="setting-info">
        <span class="setting-label">Demo mode</span>
        <span class="setting-desc">Explore the app with mock data</span>
      </div>
      <a href="/demo" class="btn-secondary-sm">Open</a>
    </div>
  </section>

  <!-- ── Diagnostics ───────────────────────────────────────────── -->
  {#if debugMode}
  <section class="profile-card">
    <div class="diag-header">
      <h2 class="section-title">Diagnostics</h2>
      <span class="diag-pulse"></span>
    </div>
    <p class="section-sub">Live engine status — refreshes every 3 s</p>

    {#if diagnostics}
      <!-- Sync -->
      <div class="diag-group">
        <div class="diag-row">
          <span class="diag-label">Sync</span>
          <span class="diag-badge" class:diag-ok={diagnostics.sync.status === 'idle'} class:diag-warn={diagnostics.sync.status === 'syncing'} class:diag-err={diagnostics.sync.status === 'error'}>
            {diagnostics.sync.status}
          </span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Last sync</span>
          <span class="diag-val">{diagnostics.sync.lastSyncTime ? new Date(diagnostics.sync.lastSyncTime).toLocaleTimeString() : '—'}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Cycles (total)</span>
          <span class="diag-val">{diagnostics.sync.totalCycles}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Pending</span>
          <span class="diag-val">{diagnostics.sync.pendingCount}</span>
        </div>
        {#if diagnostics.sync.syncMessage}
        <div class="diag-row">
          <span class="diag-label">Message</span>
          <span class="diag-val diag-mono">{diagnostics.sync.syncMessage}</span>
        </div>
        {/if}
      </div>

      <!-- Queue -->
      <div class="diag-group">
        <div class="diag-row">
          <span class="diag-label">Queue depth</span>
          <span class="diag-val">{diagnostics.queue.pendingOperations}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">In backoff</span>
          <span class="diag-val">{diagnostics.queue.itemsInBackoff}</span>
        </div>
      </div>

      <!-- Realtime -->
      <div class="diag-group">
        <div class="diag-row">
          <span class="diag-label">Realtime</span>
          <span class="diag-badge" class:diag-ok={diagnostics.realtime.healthy} class:diag-warn={diagnostics.realtime.batchSuspended} class:diag-err={!diagnostics.realtime.healthy && !diagnostics.realtime.batchSuspended}>
            {diagnostics.realtime.batchSuspended ? 'batch-suspended' : diagnostics.realtime.connectionState}
          </span>
        </div>
        {#if diagnostics.realtime.reconnectAttempts > 0}
        <div class="diag-row">
          <span class="diag-label">Reconnects</span>
          <span class="diag-val">{diagnostics.realtime.reconnectAttempts}</span>
        </div>
        {/if}
        {#if diagnostics.realtime.lastError}
        <div class="diag-row">
          <span class="diag-label">Last error</span>
          <span class="diag-val diag-err-text diag-mono">{diagnostics.realtime.lastError}</span>
        </div>
        {/if}
      </div>

      <!-- Egress -->
      <div class="diag-group">
        <div class="diag-row">
          <span class="diag-label">Session egress</span>
          <span class="diag-val">{diagnostics.egress.totalFormatted}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Records synced</span>
          <span class="diag-val">{diagnostics.egress.totalRecords}</span>
        </div>
      </div>

      <!-- Engine -->
      <div class="diag-group">
        <div class="diag-row">
          <span class="diag-label">Lock held</span>
          <span class="diag-val">{diagnostics.engine.lockHeld ? (diagnostics.engine.lockHeldForMs != null ? \`\${diagnostics.engine.lockHeldForMs} ms\` : 'yes') : 'no'}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Tab visible</span>
          <span class="diag-val">{diagnostics.engine.isTabVisible ? 'yes' : 'no'}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Hydrated</span>
          <span class="diag-val">{diagnostics.sync.hasHydrated ? 'yes' : 'no'}</span>
        </div>
      </div>

      <!-- Recent sync cycles -->
      {#if diagnostics.sync.recentCycles.length > 0}
      <div class="diag-group">
        <div class="diag-label" style="margin-bottom: 0.5rem;">Recent cycles (last 5)</div>
        {#each diagnostics.sync.recentCycles.slice(-5).reverse() as cycle (cycle.timestamp)}
        <div class="cycle-row">
          <div class="cycle-meta">
            <span class="cycle-trigger">{cycle.trigger}</span>
            <span class="cycle-time">{new Date(cycle.timestamp).toLocaleTimeString()}</span>
          </div>
          <div class="cycle-stats">
            <span class="cycle-stat">
              <span class="cycle-stat-val">{cycle.durationMs}ms</span>
            </span>
            <span class="cycle-stat">
              <span class="cycle-stat-label">↑</span>
              <span class="cycle-stat-val">{cycle.pushedItems}</span>
            </span>
            <span class="cycle-stat">
              <span class="cycle-stat-label">↓</span>
              <span class="cycle-stat-val">{cycle.pulledRecords}</span>
            </span>
            <span class="cycle-stat">
              <span class="cycle-stat-label">~</span>
              <span class="cycle-stat-val">{cycle.egressBytes > 0 ? (cycle.egressBytes / 1024).toFixed(1) + 'KB' : '0B'}</span>
            </span>
          </div>
        </div>
        {/each}
      </div>
      {/if}

      <!-- Recent errors -->
      {#if diagnostics.errors.recentErrors.length > 0}
      <div class="diag-group">
        <div class="diag-label" style="margin-bottom: 0.375rem;">Recent errors</div>
        {#each diagnostics.errors.recentErrors.slice(0, 3) as err (err.entityId + err.timestamp)}
        <div class="diag-error-row">
          <span class="diag-mono">{err.entityId ?? '—'}</span>
          <span class="diag-err-text">{err.message}</span>
        </div>
        {/each}
      </div>
      {/if}

    {:else}
      <p class="section-sub">Loading…</p>
    {/if}
  </section>
  {/if}

  <!-- ── Debug Tools ───────────────────────────────────────────── -->
  {#if debugMode}
  <section class="profile-card danger-card">
    <h2 class="section-title danger-title">Debug Tools</h2>
    <p class="section-sub">Destructive operations — use with care</p>

    <div class="debug-grid">
      <button class="btn-debug" onclick={handleForceFullSync} disabled={forceSyncing || inDemoMode}>
        {forceSyncing ? 'Running…' : 'Force Full Sync'}
      </button>
      <button class="btn-debug" onclick={handleTriggerSync} disabled={triggeringSyncManual || inDemoMode}>
        {triggeringSyncManual ? 'Running…' : 'Trigger Sync'}
      </button>
      <button class="btn-debug" onclick={handleResetSyncCursor} disabled={resettingCursor || inDemoMode}>
        {resettingCursor ? 'Running…' : 'Reset Sync Cursor'}
      </button>
      <button class="btn-debug" onclick={handleRepairSyncQueue} disabled={repairingSyncQueue || inDemoMode}>
        {repairingSyncQueue ? 'Running…' : 'Repair Sync Queue'}
      </button>
      <button class="btn-debug" onclick={handleViewTombstones} disabled={viewingTombstones || inDemoMode}>
        {viewingTombstones ? 'Running…' : 'View Tombstones'}
      </button>
      <button class="btn-debug" onclick={handleCleanupTombstones} disabled={cleaningTombstones || inDemoMode}>
        {cleaningTombstones ? 'Running…' : 'Cleanup Tombstones'}
      </button>
      <button class="btn-debug btn-danger" onclick={handleResetDatabase} disabled={resetting || inDemoMode}>
        {resetting ? 'Resetting…' : 'Reset Local Database'}
      </button>
    </div>
  </section>
  {/if}

  <!-- ── Sign out (mobile only) ──────────────────────────────── -->
  <div class="mobile-signout">
    <button class="btn-signout" onclick={handleMobileSignOut}>Sign out</button>
  </div>

</div>

<!-- Email change confirmation modal -->
{#if showEmailConfirmationModal}
  <div class="modal-backdrop">
    <div class="modal-card">
      <h3 class="modal-title">Check your email</h3>
      <p class="modal-text">
        A confirmation link was sent to <strong>{newEmail}</strong>. Click it to complete the email change.
      </p>
      <p class="modal-hint">The link expires in 24 hours.</p>
      <button class="btn-secondary-sm" onclick={handleResendEmailChange} disabled={emailResendCooldown > 0}>
        {#if emailResendCooldown > 0}Resend in {emailResendCooldown}s{:else}Resend email{/if}
      </button>
      <button class="btn-primary" onclick={() => showEmailConfirmationModal = false}>Got it</button>
    </div>
  </div>
{/if}

<style>
  /* ── Page ── */
  .profile-page {
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem 1rem 6rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  /* ── Page header ── */
  .profile-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .back-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-lg, 16px);
    color: #7878a0;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: color 0.2s ease, background 0.2s ease, border-color 0.2s ease;
  }

  .back-btn:hover {
    color: #f0f0ff;
    background: rgba(107, 158, 107, 0.12);
    border-color: #3d5a3d;
  }

  .profile-heading {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 700;
    color: #f0f0ff;
  }

  .header-spacer {
    flex: 1;
  }

  /* ── Card ── */
  .profile-card {
    background: #0f0f1e;
    border: 1px solid #3d5a3d;
    border-radius: 16px;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .danger-card { border-color: #7a3d3d; }

  /* ── Section header ── */
  .section-header {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .avatar-circle {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    background: #1a2e1a;
    border: 2px solid #3d5a3d;
    color: #6B9E6B;
    font-size: 1.375rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .section-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    color: #f0f0ff;
  }

  .danger-title { color: #e07070; }

  .section-sub {
    margin: 0;
    font-size: 0.8125rem;
    color: #7878a0;
  }

  /* ── Forms ── */
  .profile-form {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .form-group label {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #7878a0;
  }

  .form-group input {
    width: 100%;
    padding: 0.75rem 0.875rem;
    font-size: 0.9375rem;
    color: #f0f0ff;
    background: #1a1a22;
    border: 1.5px solid #3d5a3d;
    border-radius: 10px;
    font-family: inherit;
    box-sizing: border-box;
    transition: border-color 0.15s;
  }

  .form-group input::placeholder { color: #7878a0; opacity: 0.6; }
  .form-group input:focus { outline: none; border-color: #6B9E6B; box-shadow: 0 0 0 2px rgba(107, 158, 107, 0.2); }
  .form-group input:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── PIN ── */
  .pin-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .pin-label {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #7878a0;
  }

  /* ── Buttons ── */
  .btn-primary {
    width: 100%;
    padding: 0.875rem 1.5rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: #fff;
    background: #6B9E6B;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    font-family: inherit;
    transition: opacity 0.15s;
  }

  .btn-primary:hover:not(:disabled) { opacity: 0.9; }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-secondary-sm {
    padding: 0.5rem 1rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #6B9E6B;
    background: rgba(107, 158, 107, 0.1);
    border: 1px solid #3d5a3d;
    border-radius: 8px;
    text-decoration: none;
    transition: background 0.15s;
    white-space: nowrap;
    cursor: pointer;
    font-family: inherit;
  }

  .btn-secondary-sm:hover { background: rgba(107, 158, 107, 0.18); }

  .btn-remove {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid #7a3d3d;
    border-radius: 8px;
    color: #e07070;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 0.15s;
  }

  .btn-remove:hover:not(:disabled) { background: rgba(224, 112, 112, 0.1); }
  .btn-remove:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-debug {
    padding: 0.6rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #c8c8e0;
    background: #1a1a22;
    border: 1px solid #3d5a3d;
    border-radius: 8px;
    cursor: pointer;
    font-family: inherit;
    transition: border-color 0.15s;
    text-align: left;
  }

  .btn-debug:hover:not(:disabled) { border-color: #6B9E6B; color: #f0f0ff; }
  .btn-debug:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-debug.btn-danger { border-color: #7a3d3d; color: #e07070; }
  .btn-debug.btn-danger:hover:not(:disabled) { background: rgba(224, 112, 112, 0.08); }

  .debug-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.625rem;
  }

  /* ── Devices ── */
  .devices-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .device-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.875rem;
    background: #1a1a22;
    border: 1px solid #3d5a3d;
    border-radius: 10px;
  }

  .device-info { flex: 1; }

  .device-name {
    font-size: 0.9rem;
    font-weight: 600;
    color: #f0f0ff;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .device-meta {
    font-size: 0.75rem;
    color: #7878a0;
    margin-top: 0.2rem;
  }

  .badge-current {
    font-size: 0.625rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.15rem 0.5rem;
    background: rgba(107, 158, 107, 0.15);
    color: #6B9E6B;
    border-radius: 4px;
    border: 1px solid rgba(107, 158, 107, 0.3);
  }

  /* ── Settings toggle ── */
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid rgba(61, 90, 61, 0.4);
  }

  .setting-row:last-child { border-bottom: none; }

  .setting-info { display: flex; flex-direction: column; gap: 0.125rem; }

  .setting-label {
    font-size: 0.9rem;
    font-weight: 600;
    color: #f0f0ff;
  }

  .setting-desc {
    font-size: 0.75rem;
    color: #7878a0;
  }

  .toggle { position: relative; display: inline-flex; cursor: pointer; }
  .toggle input { position: absolute; opacity: 0; width: 0; height: 0; }

  .toggle-track {
    width: 40px;
    height: 24px;
    background: #1a1a22;
    border: 1.5px solid #3d5a3d;
    border-radius: 12px;
    transition: background 0.2s, border-color 0.2s;
  }

  .toggle-track::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 16px;
    height: 16px;
    background: #7878a0;
    border-radius: 50%;
    transition: transform 0.2s, background 0.2s;
  }

  .toggle input:checked ~ .toggle-track {
    background: rgba(107, 158, 107, 0.2);
    border-color: #6B9E6B;
  }

  .toggle input:checked ~ .toggle-track::after {
    transform: translateX(16px);
    background: #6B9E6B;
  }

  /* ── Feedback messages ── */
  .msg {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.5;
    padding: 0.625rem 0.875rem;
    border-radius: 8px;
  }

  .msg-error {
    color: #e07070;
    background: rgba(224, 112, 112, 0.1);
    border: 1px solid rgba(224, 112, 112, 0.25);
  }

  .msg-success {
    color: #6B9E6B;
    background: rgba(107, 158, 107, 0.1);
    border: 1px solid rgba(107, 158, 107, 0.25);
  }

  .loading-text, .empty-text {
    font-size: 0.875rem;
    color: #7878a0;
    margin: 0;
  }

  .demo-note {
    font-size: 0.875rem;
    color: #7878a0;
    font-style: italic;
    margin: 0;
  }

  /* ── Diagnostics dashboard ── */
  .diag-header {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .diag-pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #6B9E6B;
    animation: pulse 2s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.3; }
  }

  .diag-group {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem;
    background: #111116;
    border: 1px solid #3d5a3d;
    border-radius: 10px;
    font-size: 0.8125rem;
  }

  .diag-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }

  .diag-label {
    color: #7878a0;
    font-weight: 600;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }

  .diag-val {
    color: #c8c8e0;
    text-align: right;
  }

  .diag-mono {
    font-family: ui-monospace, 'SF Mono', monospace;
    font-size: 0.75rem;
    word-break: break-all;
    text-align: right;
  }

  .diag-badge {
    display: inline-flex;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .diag-ok  { background: rgba(107,158,107,0.15); color: #6B9E6B; }
  .diag-warn { background: rgba(212,168,83,0.15); color: #D4A853; }
  .diag-err  { background: rgba(224,112,112,0.15); color: #e07070; }
  .diag-err-text { color: #e07070; }

  .diag-error-row {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.375rem 0.5rem;
    background: rgba(224,112,112,0.06);
    border-radius: 6px;
    border-left: 2px solid #e07070;
  }

  /* ── Sync cycle rows ── */
  .cycle-row {
    padding: 0.375rem 0.5rem;
    background: #111116;
    border-radius: 6px;
    margin-bottom: 0.25rem;
    border-left: 2px solid #3d5a3d;
  }

  .cycle-meta {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.2rem;
  }

  .cycle-trigger {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6B9E6B;
  }

  .cycle-time {
    font-size: 0.6875rem;
    color: #5a5a80;
    font-family: ui-monospace, 'SF Mono', monospace;
  }

  .cycle-stats {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .cycle-stat {
    display: flex;
    align-items: baseline;
    gap: 0.2rem;
    font-size: 0.75rem;
  }

  .cycle-stat-label {
    color: #5a5a80;
    font-size: 0.7rem;
  }

  .cycle-stat-val {
    color: #c8c8e0;
    font-family: ui-monospace, 'SF Mono', monospace;
  }

  .spinner-small {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(107, 158, 107, 0.2);
    border-top-color: #6B9E6B;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Mobile sign out ── */
  .mobile-signout {
    display: none;
    padding: 0 0 1rem;
  }

  .btn-signout {
    width: 100%;
    padding: 0.875rem;
    font-size: 0.9375rem;
    font-weight: 600;
    color: #e07070;
    background: transparent;
    border: 1.5px solid #7a3d3d;
    border-radius: 12px;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s;
  }

  .btn-signout:hover { background: rgba(224, 112, 112, 0.08); }

  /* ── Responsive ── */
  @media (max-width: 640px) {
    .form-row { grid-template-columns: 1fr; }
    .debug-grid { grid-template-columns: 1fr; }
    .mobile-signout { display: block; }
    .profile-page { padding-bottom: calc(56px + env(safe-area-inset-bottom) + 1.5rem); }
  }
</style>
`;
}

// ---------------------------------------------------------------------------
//                  COMPONENT GENERATORS
// ---------------------------------------------------------------------------

/**
 * Generate the UpdatePrompt component that monitors the service worker
 * lifecycle and shows an "update available" notification.
 *
 * @returns The Svelte component source for `src/lib/components/UpdatePrompt.svelte`.
 */
function generateUpdatePromptComponent(): string {
  return `<script lang="ts">
  /**
   * @fileoverview UpdatePrompt — service-worker update notification.
   *
   * Detects when a new service worker version is waiting to activate and
   * shows an "update available" prompt. Detection relies on six signals:
   *   1. \`statechange\` on the installing SW → catches updates during the visit
   *   2. \`updatefound\` on the registration → catches background installs
   *   3. \`visibilitychange\` → re-checks when the tab becomes visible
   *   4. \`focus\` / \`pageshow\` → catches deployments that land while the
   *      browser window is merely unfocused
   *   5. Periodic interval → fallback for long-running sessions
   *   6. Initial check on mount → catches SWs that installed before this component
   *
   * Uses \`monitorSwLifecycle()\` from stellar-drive to wire up all six, and
   * \`handleSwUpdate()\` to send SKIP_WAITING + reload on user confirmation.
   */

  // ==========================================================================
  //                                IMPORTS
  // ==========================================================================

  import { monitorSwLifecycle, handleSwUpdate } from 'stellar-drive/kit';

  // ==========================================================================
  //                           COMPONENT STATE
  // ==========================================================================

  /** Whether the update prompt is visible */
  let showPrompt = $state(false);

  /** Guard flag to prevent double-reload */
  let reloading = false;

  // ==========================================================================
  //                      SERVICE WORKER MONITORING
  // ==========================================================================

  /**
   * Effect: wire up service worker lifecycle monitoring.
   * Returns the cleanup function so it runs automatically on destroy.
   */
  $effect(() => {
    const cleanup = monitorSwLifecycle({
      onUpdateAvailable: () => {
        showPrompt = true;
      }
    });
    return () => cleanup?.();
  });

  // ==========================================================================
  //                          ACTION HANDLERS
  // ==========================================================================

  /**
   * Apply the update: sends SKIP_WAITING to the waiting SW,
   * waits for controllerchange, then reloads the page.
   */
  async function handleRefresh() {
    if (reloading) return;
    reloading = true;
    showPrompt = false;
    await handleSwUpdate();
  }

  /**
   * Dismiss the prompt. The update will apply on the next visit.
   */
  function handleDismiss() {
    showPrompt = false;
  }
</script>

{#if showPrompt}
  <div class="update-toast" role="alert" aria-live="polite">
    <div class="update-content">
      <span class="update-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 11-6.219-8.56" />
          <path d="M21 3v6h-6" />
        </svg>
      </span>
      <span class="update-text">A new version is available</span>
    </div>
    <div class="update-actions">
      <button class="btn-dismiss" onclick={handleDismiss}>Later</button>
      <button class="btn-refresh" onclick={handleRefresh}>Refresh</button>
    </div>
  </div>
{/if}

<style>
  .update-toast {
    position: fixed;
    bottom: calc(1.25rem + env(safe-area-inset-bottom, 0px));
    left: 50%;
    transform: translateX(-50%);
    z-index: 10000;
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1rem 0.75rem 1.125rem;
    background: #1a1a2e;
    border: 1px solid #3d5a3d;
    border-radius: 12px;
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.5),
      0 0 20px rgba(107, 158, 107, 0.12);
    max-width: calc(100vw - 2rem);
    animation: toastSlideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  @keyframes toastSlideUp {
    from { opacity: 0; transform: translateX(-50%) translateY(16px); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0);    }
  }

  .update-content {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }

  .update-icon {
    color: #6b9e6b;
    display: flex;
    flex-shrink: 0;
    animation: spin 1.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .update-text {
    font-size: 0.875rem;
    font-weight: 500;
    color: #e0e0e6;
    white-space: nowrap;
  }

  .update-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
    margin-left: 0.25rem;
  }

  .btn-dismiss,
  .btn-refresh {
    padding: 0.375rem 0.75rem;
    border: none;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
  }

  .btn-dismiss {
    background: transparent;
    color: #8888a0;
  }

  .btn-dismiss:hover {
    color: #e0e0e6;
  }

  .btn-refresh {
    background: #6b9e6b;
    color: #111116;
  }

  .btn-refresh:hover {
    background: #7db87d;
    box-shadow: 0 0 12px rgba(107, 158, 107, 0.35);
  }

  @media (max-width: 480px) {
    .update-toast {
      left: 0;
      right: 0;
      bottom: calc(4.5rem + env(safe-area-inset-bottom, 0px));
      transform: none;
      max-width: 100%;
      border-radius: 0;
      border-left: none;
      border-right: none;
      border-top: 1px solid #3d5a3d;
      border-bottom: 1px solid #3d5a3d;
      animation: toastSlideUpMobile 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
    }

    @keyframes toastSlideUpMobile {
      from { opacity: 0; transform: translateY(16px); }
      to   { opacity: 1; transform: translateY(0);    }
    }

    .update-text {
      white-space: normal;
      font-size: 0.8125rem;
    }
  }
</style>
`;
}

// ---------------------------------------------------------------------------
//                    DATA STORES EXAMPLE GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `src/lib/stores/data.ts` stub showing the collection-store
 * factory pattern with onSyncComplete + onRealtimeDataUpdate wiring.
 *
 * Also documents the memoized preloadAllStores() bootstrap pattern
 * that the layout's initializeApp() should call.
 *
 * @returns The TypeScript source for `src/lib/stores/data.ts`.
 */
function generateDataStores(): string {
  return `/**
 * @fileoverview App collection stores — local-first data access layer.
 *
 * PATTERN: Wrap \`createCollectionStore\` (or \`createDetailStore\`) with semantic
 * CRUD methods and two refresh hooks:
 *
 *   \`onSyncComplete\`        — fires after every background push/pull cycle.
 *   \`onRealtimeDataUpdate\`  — fires immediately when another device pushes a
 *                              change via the Supabase Realtime WebSocket.
 *                              Without this hook, a second device's writes can
 *                              take up to 15 minutes to appear. Always add BOTH
 *                              hooks for multi-device support.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXAMPLE — add after defining tables in src/lib/schema.ts:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * import { createCollectionStore } from 'stellar-drive/stores';
 * import { onSyncComplete, onRealtimeDataUpdate } from 'stellar-drive/stores';
 * import { engineWrite, engineDelete } from 'stellar-drive';
 * import { generateId } from 'stellar-drive/utils';
 * import type { Item } from './types.generated';
 *
 * function createItemsStore() {
 *   const store = createCollectionStore<Item>({ table: 'items' });
 *   onSyncComplete(() => store.refresh());
 *   onRealtimeDataUpdate('items', () => store.refresh()); // instant multi-device sync
 *   return {
 *     ...store,
 *     create: async (data: Partial<Item>) => {
 *       const item = { id: generateId(), ...data };
 *       await engineWrite('items', item);
 *       store.mutate((items) => [...items, item]);
 *     },
 *     update: async (id: string, changes: Partial<Item>) => {
 *       await engineWrite('items', { id, ...changes });
 *       store.mutate((items) => items.map((i) => (i.id === id ? { ...i, ...changes } : i)));
 *     },
 *     remove: async (id: string) => {
 *       await engineDelete('items', id);
 *       store.mutate((items) => items.filter((i) => i.id !== id));
 *     }
 *   };
 * }
 *
 * export const itemsStore = createItemsStore();
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MEMOIZED BOOTSTRAP (wire into +layout.svelte initializeApp)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Export a memoized \`preloadAllStores\` so the layout's \`initializeApp\` can
 * call it without re-loading on each navigation:
 *
 * function createPreload() {
 *   let promise: Promise<void> | null = null;
 *   return () => {
 *     if (promise) return promise;
 *     promise = Promise.all([
 *       itemsStore.load(),
 *       // add more stores here
 *     ]).then(() => undefined);
 *     return promise;
 *   };
 * }
 * export const preloadAllStores = createPreload();
 *
 * Then in +layout.svelte:
 *   import { preloadAllStores } from '$lib/stores/data';
 *   // Replace the initPromise body with:
 *   initPromise = preloadAllStores();
 */

// TODO: Add your app's stores here (see pattern above).
// This file must export at least one value once you add tables; until then,
// the scaffold wires initializeApp() directly in +layout.svelte.
`;
}

// ---------------------------------------------------------------------------
//                    QUERY LAYER EXAMPLE GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `src/lib/db/queries.ts` stub showing batch-load + Map join
 * pattern to prevent N+1 reads against IndexedDB.
 *
 * @returns The TypeScript source for `src/lib/db/queries.ts`.
 */
function generateQueriesTs(): string {
  return `/**
 * @fileoverview Query layer — batch data loading with N+1 prevention.
 *
 * When loading parent-child relationships, ALWAYS use batch-load + in-memory
 * grouping, NOT per-parent queries. Each \`queryAll\` opens an IndexedDB cursor
 * which costs ~1ms; N parents × 1ms = noticeable jank at scale.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WRONG — N+1 pattern (one queryAll per parent):
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   for (const parent of parents) {
 *     parent.children = await queryAll('children', { parent_id: parent.id });
 *   }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RIGHT — batch-load + Map join (two queries total):
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   import { queryAll } from 'stellar-drive';
 *   import type { Parent, Child } from '$lib/types.generated';
 *
 *   export interface ParentWithChildren extends Parent {
 *     children: Child[];
 *   }
 *
 *   export async function getParentsWithChildren(): Promise<ParentWithChildren[]> {
 *     const [parents, allChildren] = await Promise.all([
 *       queryAll<Parent>('parents'),
 *       queryAll<Child>('children'),
 *     ]);
 *
 *     // Group children by parent_id in one O(n) pass
 *     const byParent = new Map<string, Child[]>();
 *     for (const child of allChildren) {
 *       if (child.deleted) continue;
 *       const list = byParent.get(child.parent_id) ?? [];
 *       list.push(child);
 *       byParent.set(child.parent_id, list);
 *     }
 *
 *     return parents
 *       .filter((p) => !p.deleted)
 *       .map((p) => ({ ...p, children: byParent.get(p.id) ?? [] }));
 *   }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Add query functions for your own tables below.
 * Import: import { queryAll } from 'stellar-drive';
 */

// TODO: Add query functions for your tables (see pattern above).
`;
}

// ---------------------------------------------------------------------------
//                   REPOSITORY EXAMPLE GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `src/lib/db/repositories/items.ts` stub demonstrating the
 * engineWrite / engineDelete / engineBatchWrite cascade-delete pattern.
 *
 * @returns The TypeScript source for `src/lib/db/repositories/items.ts`.
 */
function generateRepositoryItems(): string {
  return `/**
 * @fileoverview Items repository — CRUD via the stellar-drive engine.
 *
 * All writes go through the engine (engineWrite / engineDelete / engineBatchWrite).
 * This ensures automatic sync queue entries, proper conflict-resolution metadata,
 * and keeps IndexedDB and Supabase in sync.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CASCADE DELETES — use engineBatchWrite, NOT a loop of individual deletes
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A loop of \`engineDelete\` calls queues separate sync operations and can
 * partially succeed on error. \`engineBatchWrite\` sends the full set atomically.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXAMPLE — replace 'items' / 'child_items' with your real table names:
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * import { engineWrite, engineDelete, engineBatchWrite } from 'stellar-drive';
 * import { generateId } from 'stellar-drive/utils';
 * import type { BatchWriteOp } from 'stellar-drive/types';
 * // import type { Item } from '$lib/types.generated';
 *
 * export async function createItem(data: Record<string, unknown>): Promise<Record<string, unknown>> {
 *   const item = { id: generateId(), ...data };
 *   await engineWrite('items', item);
 *   return item;
 * }
 *
 * export async function updateItem(id: string, changes: Record<string, unknown>): Promise<void> {
 *   await engineWrite('items', { id, ...changes });
 * }
 *
 * export async function deleteItem(id: string): Promise<void> {
 *   await engineDelete('items', id);
 * }
 *
 * // CASCADE DELETE — deletes child rows before the parent (reverse dep order)
 * export async function deleteItemWithChildren(
 *   id: string,
 *   childIds: string[]
 * ): Promise<void> {
 *   const ops: BatchWriteOp[] = [
 *     ...childIds.map((cid) => ({ type: 'delete' as const, table: 'child_items', id: cid })),
 *     { type: 'delete' as const, table: 'items', id },
 *   ];
 *   await engineBatchWrite(ops);
 * }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Remove this file and replace with your real repositories after defining
 * tables in src/lib/schema.ts. One file per top-level entity is recommended.
 */

// TODO: Replace with your real repository functions (see pattern above).
// import { engineWrite, engineDelete, engineBatchWrite } from 'stellar-drive';
// import { generateId } from 'stellar-drive/utils';
`;
}

// ---------------------------------------------------------------------------
//                     ROUTES CONSTANT GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate a `src/lib/routes.ts` file with route path constants.
 *
 * Provides a single source of truth for all route paths used across the
 * application. Import `ROUTES` from `$lib/routes` instead of hardcoding
 * path strings to prevent typos and make refactoring easier.
 *
 * @returns The TypeScript source for `src/lib/routes.ts`.
 */
function generateRoutesTs(): string {
  return `/**
 * @fileoverview Route path constants — single source of truth for all routes.
 *
 * Import \`ROUTES\` wherever a path string is needed instead of hardcoding
 * path literals. This prevents typos and makes route renaming a one-line change.
 *
 * @example
 * \`\`\`ts
 * import { ROUTES } from '$lib/routes';
 * goto(ROUTES.HOME);
 * redirect(307, ROUTES.LOGIN);
 * \`\`\`
 */

export const ROUTES = {
  HOME: '/',
  LOGIN: '/login',
  CONFIRM: '/confirm',
  SETUP: '/setup',
  POLICY: '/policy',
  DEMO: '/demo',
  PROFILE: '/profile',
} as const;
`;
}

// ---------------------------------------------------------------------------
//                   TYPE RE-EXPORT GENERATOR
// ---------------------------------------------------------------------------

/**
 * Generate the app types barrel file that re-exports stellar-drive types
 * and provides a location for app-specific type definitions.
 *
 * @returns The TypeScript source for `src/lib/types.ts`.
 */
// ---------------------------------------------------------------------------
//                    DEMO MODE FILE GENERATORS
// ---------------------------------------------------------------------------

/**
 * Generate the demo landing page.
 *
 * @returns The Svelte component source for `src/routes/demo/+page.svelte`.
 */
function generateDemoPage(opts: InstallOptions): string {
  return `<!--
  @fileoverview Demo landing page — try ${opts.name} without an account.

  Provides a sandboxed demo environment with mock data. All changes
  reset on page refresh. No account, email, or setup required.
-->
<script lang="ts">
  import { isDemoMode, setDemoMode, cleanupDemoDatabase } from 'stellar-drive';

  let demoActive = $state(isDemoMode());
  let toggling = $state(false);
  let fading = $state(false);

  function handleToggle() {
    if (toggling) return;
    toggling = true;
    const turningOn = !demoActive;
    demoActive = turningOn;

    if (turningOn) {
      setTimeout(() => { fading = true; }, 1200);
      setTimeout(() => {
        setDemoMode(true);
        window.location.href = '/';
      }, 1800);
    } else {
      setTimeout(() => { fading = true; }, 800);
      setTimeout(() => {
        setDemoMode(false);
        cleanupDemoDatabase('${opts.prefix}_demo');
        window.location.href = '/';
      }, 1400);
    }
  }
</script>

<svelte:head>
  <title>Demo Mode — ${opts.name}</title>
</svelte:head>

<div class="page" class:active={demoActive} class:fading>
  <!-- App name -->
  <p class="app-name">${opts.name}</p>

  <h1 class="title">Demo Mode</h1>
  <p class="sub">Explore with sample data — no account required</p>

  <!-- Toggle -->
  <div class="tz">
    <button
      class="tog"
      class:on={demoActive}
      onclick={handleToggle}
      disabled={toggling}
      aria-label={demoActive ? 'Disable demo mode' : 'Enable demo mode'}
    >
      <span class="track">
        <span class="knob"></span>
      </span>
    </button>
    <span class="state-label" class:on={demoActive}>{demoActive ? 'ACTIVE' : 'INACTIVE'}</span>
  </div>

  <!-- Info card -->
  <section class="info">
    <div class="col ok">
      <h3>Available</h3>
      <ul>
        <li>Browse all pages</li>
        <li>Create &amp; edit items</li>
        <li>Full app functionality</li>
      </ul>
    </div>
    <div class="divider"></div>
    <div class="col cap">
      <h3>Limited</h3>
      <ul>
        <li>Cloud sync</li>
        <li>Account settings</li>
        <li>Device management</li>
      </ul>
    </div>
  </section>

  <p class="foot">Data resets each session</p>

</div>

<style>
  /* ═══ PAGE ═══ */

  .page {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    padding-top: max(1.5rem, env(safe-area-inset-top, 0px));
    padding-bottom: max(1.5rem, env(safe-area-inset-bottom, 0px));
    padding-left: max(1.5rem, env(safe-area-inset-left, 0px));
    padding-right: max(1.5rem, env(safe-area-inset-right, 0px));
    gap: clamp(0.75rem, 2vh, 1.5rem);
    overflow: hidden;
    background: #111116;
    color: #c8c8e0;
    font-family: inherit;
    transition: opacity 0.7s ease, filter 0.7s ease, transform 0.7s ease;
  }

  /* ═══ EXIT ANIMATION ═══ */

  .page.fading {
    opacity: 0;
    filter: blur(16px);
    transform: scale(1.06);
  }

  /* ═══ APP NAME ═══ */

  .app-name {
    margin: 0;
    font-size: 1rem;
    font-weight: 800;
    color: #6B9E6B;
    letter-spacing: -0.3px;
    opacity: 0;
    animation: fadeSlideIn 0.6s 0.1s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  /* ═══ TITLE ═══ */

  .title {
    font-size: clamp(2.5rem, 8vw, 5rem);
    font-weight: 800;
    letter-spacing: -0.03em;
    line-height: 1;
    margin: 0;
    text-align: center;
    color: #f0f0ff;
    opacity: 0;
    animation: titleIn 1s 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes titleIn {
    from { opacity: 0; transform: translateY(-40px); filter: blur(16px); }
    to   { opacity: 1; transform: translateY(0);     filter: blur(0); }
  }

  .sub {
    font-size: clamp(0.85rem, 2vw, 1.05rem);
    color: #7878a0;
    max-width: 380px;
    margin: -0.25rem auto 0;
    text-align: center;
    line-height: 1.5;
    opacity: 0;
    animation: fadeSlideIn 0.8s 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(12px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ═══ TOGGLE ZONE ═══ */

  .tz {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    opacity: 0;
    animation: toggleBirth 1.4s 1.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  @keyframes toggleBirth {
    0%   { opacity: 0; transform: scale(0.5);  filter: blur(20px); }
    50%  { opacity: 1; transform: scale(1.08); filter: blur(2px); }
    75%  {             transform: scale(0.97); filter: blur(0); }
    100% { opacity: 1; transform: scale(1);    filter: blur(0); }
  }

  .tog {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    outline: none;
    -webkit-tap-highlight-color: transparent;
  }

  .tog:focus-visible .track {
    outline: 2px solid #6B9E6B;
    outline-offset: 6px;
  }

  .tog:disabled { cursor: default; }

  /* ═══ TRACK ═══ */

  .track {
    position: relative;
    display: block;
    width: 200px;
    height: 68px;
    border-radius: 34px;
    background: #1a1a22;
    border: 2px solid #3d5a3d;
    transition: background 0.4s, border-color 0.4s, box-shadow 0.4s;
  }

  .tog.on .track {
    background: rgba(107, 158, 107, 0.15);
    border-color: rgba(107, 158, 107, 0.5);
    box-shadow: 0 0 30px rgba(107, 158, 107, 0.12);
  }

  .tog:hover:not(:disabled) .track {
    border-color: rgba(107, 158, 107, 0.4);
  }

  /* ═══ KNOB ═══ */

  .knob {
    position: absolute;
    top: 6px;
    left: 6px;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    transition: transform 0.5s cubic-bezier(0.68, -0.15, 0.27, 1.15),
                background 0.4s, box-shadow 0.4s;
  }

  .tog.on .knob {
    transform: translateX(132px);
    background: #6B9E6B;
    box-shadow: 0 0 20px rgba(107, 158, 107, 0.4);
  }

  /* ═══ STATE LABEL ═══ */

  .state-label {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    color: #5a5a80;
    user-select: none;
    transition: color 0.4s;
  }

  .state-label.on { color: #6B9E6B; }

  /* ═══ INFO CARD ═══ */

  .info {
    display: flex;
    gap: 1.5rem;
    max-width: 440px;
    width: 100%;
    background: #0f0f1e;
    border: 1px solid #3d5a3d;
    border-radius: 16px;
    padding: clamp(0.75rem, 2vh, 1.25rem) clamp(1rem, 3vw, 1.5rem);
    opacity: 0;
    animation: fadeSlideIn 0.8s 2.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  .col { flex: 1; }

  .col h3 {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0 0 0.5rem;
  }

  .ok h3  { color: #c8c8e0; }
  .cap h3 { color: #7878a0; }

  .col ul {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .col li {
    font-size: 0.78rem;
    line-height: 1.5;
    padding-left: 1.2rem;
    position: relative;
    color: #7878a0;
  }

  .ok li::before {
    content: '\\2713';
    position: absolute;
    left: 0;
    color: #6B9E6B;
    font-weight: 700;
    font-size: 0.75rem;
  }

  .cap li::before {
    content: '\\2014';
    position: absolute;
    left: 0;
    color: #5a5a80;
  }

  .divider {
    width: 1px;
    background: #3d5a3d;
    align-self: stretch;
  }

  /* ═══ FOOTER ═══ */

  .foot {
    font-size: 0.7rem;
    color: #5a5a80;
    margin: 0;
    letter-spacing: 0.04em;
    opacity: 0;
    animation: fadeSlideIn 0.6s 3.2s ease forwards;
  }

  /* ═══ REDUCED MOTION ═══ */

  @media (prefers-reduced-motion: reduce) {
    .app-name, .title, .sub, .tz, .info, .foot {
      animation: none;
      opacity: 1;
      filter: none;
      transform: none;
    }
    .page { transition-duration: 0.15s; }
    .knob, .track, .state-label { transition-duration: 0.15s; }
  }

  /* ═══ RESPONSIVE ═══ */

  @media (max-width: 640px) {
    .page {
      padding: 1rem;
      padding-top: max(1rem, calc(env(safe-area-inset-top, 0px) + 0.5rem));
      padding-bottom: max(1rem, calc(env(safe-area-inset-bottom, 0px) + 0.5rem));
      gap: clamp(0.5rem, 1.5vh, 1rem);
    }
    .title { font-size: clamp(2rem, 10vw, 3rem); }
    .track { width: 170px; height: 58px; border-radius: 29px; }
    .knob  { width: 48px; height: 48px; top: 5px; left: 5px; }
    .tog.on .knob { transform: translateX(112px); }
    .info { flex-direction: column; gap: 0.6rem; }
    .divider { width: 100%; height: 1px; }
  }

  @media (max-width: 380px) {
    .page {
      padding: 0.75rem;
      padding-top: max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.25rem));
      padding-bottom: max(0.75rem, calc(env(safe-area-inset-bottom, 0px) + 0.25rem));
      gap: clamp(0.5rem, 1.2vh, 0.75rem);
    }
    .title { font-size: 1.8rem; }
    .track { width: 150px; height: 52px; border-radius: 26px; }
    .knob  { width: 42px; height: 42px; top: 5px; left: 5px; }
    .tog.on .knob { transform: translateX(98px); }
    .info { padding: 0.75rem; }
  }

  @media (max-height: 600px) {
    .page { gap: 0.5rem; padding: 0.5rem 1rem; }
    .title { font-size: clamp(1.5rem, 6vw, 2.5rem); }
    .info { flex-direction: row; padding: 0.6rem 0.75rem; gap: 0.75rem; }
    .col li { font-size: 0.72rem; }
    .foot { display: none; }
  }
</style>
`;
}

/**
 * Generate the demo mock data stub.
 *
 * @returns The TypeScript source for `src/lib/demo/mockData.ts`.
 */
function generateDemoMockData(): string {
  return `import type Dexie from 'dexie';

/**
 * Populate the demo Dexie database with mock data.
 *
 * This function is called once per page load when demo mode is active.
 * Add your app-specific mock data here using \`db.table('name').bulkPut([...])\`.
 *
 * @param db - The sandboxed Dexie database instance.
 *
 * @example
 * \`\`\`ts
 * await db.table('items').bulkPut([
 *   { id: '1', name: 'Sample Item', deleted: false, ... },
 *   { id: '2', name: 'Another Item', deleted: false, ... },
 * ]);
 * \`\`\`
 */
export async function seedDemoData(_db: Dexie): Promise<void> {
  // TODO: Populate your Dexie tables with mock data
  // Example:
  // await _db.table('myTable').bulkPut([{ id: '1', name: 'Sample', ... }]);
}
`;
}

/**
 * Generate the demo config stub.
 *
 * @returns The TypeScript source for `src/lib/demo/config.ts`.
 */
function generateDemoConfig(): string {
  return `import type { DemoConfig } from 'stellar-drive/demo';
import { seedDemoData } from './mockData';

/**
 * Demo mode configuration.
 *
 * Pass this to \`initEngine({ demo: demoConfig })\` to enable the demo system.
 * Customize the mock profile and seed data to match your app.
 * Mock trusted devices are auto-generated by the engine from the app prefix.
 */
export const demoConfig: DemoConfig = {
  seedData: seedDemoData,
  mockProfile: {
    email: 'demo@example.com',
    firstName: 'Demo',
    lastName: 'User',
  },
};
`;
}

/**
 * Generate the shared schema definition file.
 *
 * This is the single source of truth for the app's database schema:
 *   - `initEngine({ schema })` reads it at runtime for Dexie stores
 *   - The Vite plugin auto-generates TypeScript types on save
 *   - The Vite plugin auto-migrates Supabase when .env has DATABASE_URL
 *
 * @returns The TypeScript source for `src/lib/schema.ts`.
 */
function generateSchemaFile(_opts: InstallOptions): string {
  return `/**
 * @fileoverview Schema definition — single source of truth.
 *
 * Edit this file and save. During \`npm run dev\`:
 *   - TypeScript types auto-generate at src/lib/types.generated.ts
 *   - Supabase schema auto-migrates (when .env has DATABASE_URL)
 *   - Dexie (IndexedDB) auto-upgrades on next page load
 *
 * Each key is a Supabase table name (snake_case). Values are either:
 *   - A string of Dexie indexes (system indexes are auto-appended)
 *   - An object with full config (indexes, singleton, fields, etc.)
 *
 * @see FRAMEWORKS.md for field type reference and type narrowing patterns
 */

import type { SchemaDefinition } from 'stellar-drive/types';

/**
 * App schema — add your tables here.
 *
 * Examples:
 *   items: 'category_id, order'
 *   settings: { singleton: true }
 *   tasks: {
 *     indexes: 'project_id, order',
 *     fields: {
 *       title: 'string',
 *       completed: 'boolean',
 *       project_id: 'uuid',
 *       order: 'number',
 *     },
 *   }
 */
export const schema: SchemaDefinition = {
  // TODO: Add your tables here
  // example_items: 'order',
};
`;
}

/**
 * Generate the `.env.example` file with placeholder Supabase credentials.
 *
 * @param opts - The install options containing `name`.
 * @returns The `.env.example` file content with commented placeholders.
 */
function generateEnvExample(opts: InstallOptions): string {
  return `# =============================================================================
# ${opts.name} — Environment Variables
# =============================================================================
# Copy this file to \`.env\` and fill in the values.
#
#   cp .env.example .env
#
# Variables prefixed with PUBLIC_ are exposed to the client bundle;
# all others are server-only.
# =============================================================================

# -----------------------------------------------------------------------------
# Supabase — Client (public, safe to expose in the browser)
# -----------------------------------------------------------------------------

# Your Supabase project URL (e.g. https://abcdefghij.supabase.co)
# Find it: Supabase Dashboard → Settings → API → Project URL
PUBLIC_SUPABASE_URL=

# The publishable (public) API key — used for client-side auth and data access.
# This key is safe to include in client bundles; RLS policies protect data.
# Find it: Supabase Dashboard → Settings → API → Project API keys → publishable
PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=

# -----------------------------------------------------------------------------
# Database — Migrations (secret, never expose to the client)
# -----------------------------------------------------------------------------

# The Postgres connection string for your Supabase database.
# Used by the stellar-drive Vite plugin to push schema SQL to Supabase
# during dev and build via a direct Postgres connection.
# If not set, schema sync is skipped (types still auto-generate).
# Find it: Supabase Dashboard → Settings → Database → Connection string (URI)
#
# IMPORTANT: When deploying to Vercel, set this as a Secret environment
# variable in your Vercel project settings. It is only used server-side
# during the build and is NEVER bundled into client code.
DATABASE_URL=
`;
}

/**
 * Generate the initial `types.generated.ts` placeholder so imports don't
 * break before the first dev server run auto-generates the real file.
 *
 * @returns The TypeScript source for `src/lib/types.generated.ts`.
 */
function generateTypesPlaceholder(): string {
  return `/** AUTO-GENERATED by stellar-drive — do not edit manually. */
// Run \`npm run dev\` to auto-generate types from src/lib/schema.ts
`;
}

function generateAppTypes(): string {
  return `/**
 * @fileoverview App type definitions.
 *
 * Entity types (database row shapes) are auto-generated by stellar-drive
 * from the schema definition in \`src/lib/schema.ts\`. This file re-exports
 * them and adds app-specific narrowings and composite types.
 *
 * To update entity types, edit \`src/lib/schema.ts\` and save — the Vite
 * plugin regenerates \`types.generated.ts\` automatically.
 *
 * If a generated type uses \`string\` where your app needs a narrower union
 * (e.g. \`'active' | 'archived'\`), use the Omit + extend pattern:
 *
 *   import type { Item as GenItem } from './types.generated';
 *   export type ItemStatus = 'active' | 'archived';
 *   export interface Item extends Omit<GenItem, 'status'> {
 *     status: ItemStatus;
 *   }
 *
 * Similarly for \`json\` fields (\`unknown\` in generated types):
 *
 *   export interface Item extends Omit<GenItem, 'metadata'> {
 *     metadata: { tags: string[] } | null;
 *   }
 */

// Re-export stellar-drive utility types
export type { SyncStatus, AuthMode, OfflineCredentials } from 'stellar-drive/types';

// Re-export all generated entity types (override individual ones below as needed)
// export type { MyTable } from './types.generated';

// TODO: Add app-specific type definitions and narrowings here
`;
}

// =============================================================================
//                              MAIN FUNCTION
// =============================================================================

/**
 * Write a group of files quietly, updating the spinner with per-file progress.
 *
 * @param entries - Array of `[relativePath, content]` pairs.
 * @param cwd - The current working directory.
 * @param createdFiles - Accumulator for newly-created file paths.
 * @param skippedFiles - Accumulator for skipped file paths.
 * @param label - The category label shown in the spinner (e.g. "Config files").
 * @param spinner - The clack spinner instance to update per-file.
 * @param runningTotal - The total files written so far across all groups.
 * @returns The number of files in the group.
 */
function writeGroup(
  entries: [string, string][],
  cwd: string,
  createdFiles: string[],
  skippedFiles: string[],
  label: string,
  spinner: ReturnType<typeof p.spinner>,
  runningTotal: number
): number {
  for (let i = 0; i < entries.length; i++) {
    const [rel, content] = entries[i];
    const existed = existsSync(join(cwd, rel));
    writeIfMissing(join(cwd, rel), content, createdFiles, skippedFiles, true);
    const status = existed ? color.dim('skip') : color.green('write');
    const current = runningTotal + i + 1;
    spinner.message(
      `${label} [${i + 1}/${entries.length}] ${status} ${color.dim(rel)}  ${color.dim(`(${current} total)`)}`
    );
  }
  return entries.length;
}

/**
 * Main entry point for the CLI scaffolding tool.
 *
 * **Execution flow:**
 *   1. Run interactive walkthrough to collect {@link InstallOptions}.
 *   2. Write `package.json` (if missing).
 *   3. Run `npm install` to fetch dependencies.
 *   4. Write all template files by category with animated progress.
 *   5. Initialise Husky and write the pre-commit hook.
 *   6. Print a styled summary of created/skipped files and next steps.
 *
 * @returns A promise that resolves when scaffolding is complete.
 *
 * @throws {Error} If `npm install` or `npx husky init` fails.
 */
export async function run(): Promise<void> {
  const opts = await runInteractiveSetup();
  const cwd = process.cwd();

  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  const s = p.spinner();

  // 1. Write package.json
  s.start('Writing package.json...');
  writeIfMissing(
    join(cwd, 'package.json'),
    generatePackageJson(opts),
    createdFiles,
    skippedFiles,
    true
  );
  s.stop('package.json ready');

  // 2. Run npm install
  s.start('Installing dependencies...');
  s.stop('Installing dependencies (npm output below)');
  execSync('npm install', { stdio: 'inherit', cwd });
  p.log.success('Dependencies installed');

  // 2b. Symlink stellar-drive to local package for development
  const stellarDrivePkg = join(cwd, 'node_modules', 'stellar-drive');
  const stellarDriveLocal = join(cwd, '..', 'stellar-drive');
  try {
    if (existsSync(stellarDriveLocal)) {
      if (existsSync(stellarDrivePkg)) {
        rmSync(stellarDrivePkg, { recursive: true });
      }
      symlinkSync(stellarDriveLocal, stellarDrivePkg);
      p.log.success('Symlinked stellar-drive to local package');
    }
  } catch {
    /* Non-fatal — user can symlink manually */
  }

  // 3. Write all template files by category
  const firstLetter = opts.shortName.charAt(0).toUpperCase();
  let filesWritten = 0;

  const groups: { label: string; entries: [string, string][] }[] = [
    {
      label: 'Config files',
      entries: [
        ['vite.config.ts', generateViteConfig(opts)],
        ['tsconfig.json', generateTsconfig()],
        ['svelte.config.js', generateSvelteConfig(opts)],
        ['eslint.config.js', generateEslintConfig()],
        ['.prettierrc', generatePrettierrc()],
        ['.prettierignore', generatePrettierignore()],
        ['knip.json', generateKnipJson()],
        ['.gitignore', generateGitignore()],
        ['.env.example', generateEnvExample(opts)]
      ]
    },
    {
      label: 'Documentation',
      entries: [
        ['README.md', generateReadme(opts)],
        ['ARCHITECTURE.md', generateArchitecture(opts)],
        ['FRAMEWORKS.md', generateFrameworks()]
      ]
    },
    {
      label: 'Static assets',
      entries: [
        ['static/manifest.json', generateManifest(opts)],
        ['static/offline.html', generateOfflineHtml(opts)],
        ['static/icons/app.svg', generatePlaceholderSvg('#6B9E6B', firstLetter)],
        ['static/icons/app-dark.svg', generatePlaceholderSvg('#0f0f1e', firstLetter)],
        ['static/icons/maskable.svg', generatePlaceholderSvg('#6B9E6B', firstLetter)],
        ['static/icons/favicon.svg', generatePlaceholderSvg('#6B9E6B', firstLetter)],
        ['static/icons/monochrome.svg', generateMonochromeSvg(firstLetter)],
        ['static/icons/splash.svg', generateSplashSvg(opts.shortName)],
        ['static/icons/apple-touch.svg', generatePlaceholderSvg('#6c5ce7', firstLetter)],
        ['static/change-email.html', generateChangeEmail()],
        ['static/device-verification-email.html', generateDeviceVerificationEmail()],
        ['static/signup-email.html', generateSignupEmail()]
      ]
    },
    {
      label: 'Source files',
      entries: [
        ['src/app.css', generateAppCss()],
        ['src/app.html', generateAppHtml(opts)],
        ['src/app.d.ts', generateAppDts(opts)]
      ]
    },
    {
      label: 'Route files',
      entries: [
        ['src/routes/+layout.ts', generateRootLayoutTs(opts)],
        ['src/routes/+layout.svelte', generateRootLayoutSvelte(opts)],
        ['src/routes/+page.svelte', generateHomePage(opts)],
        ['src/routes/+error.svelte', generateErrorPage(opts)],
        ['src/routes/setup/+page.ts', generateSetupPageTs()],
        ['src/routes/setup/+page.svelte', generateSetupPageSvelte(opts)],
        ['src/routes/setup/Reconfigure.svelte', generateReconfigureSvelte(opts)],
        ['src/routes/policy/+page.svelte', generatePolicyPage(opts)],
        ['src/routes/login/+page.svelte', generateLoginPage(opts)],
        ['src/routes/confirm/+page.svelte', generateConfirmPage(opts)],
        ['src/routes/api/config/+server.ts', generateConfigServer()],
        ['src/routes/api/setup/deploy/+server.ts', generateDeployServer(opts)],
        ['src/routes/api/setup/validate/+server.ts', generateValidateServer()],
        ['src/routes/[...catchall]/+page.server.ts', generateCatchallPage()],
        ['src/routes/profile/+page.svelte', generateProfilePage(opts)],
        ['src/routes/demo/+page.svelte', generateDemoPage(opts)]
      ]
    },
    {
      label: 'Library & components',
      entries: [
        ['src/lib/routes.ts', generateRoutesTs()],
        ['src/lib/schema.ts', generateSchemaFile(opts)],
        ['src/lib/types.generated.ts', generateTypesPlaceholder()],
        ['src/lib/types.ts', generateAppTypes()],
        ['src/lib/stores/data.ts', generateDataStores()],
        ['src/lib/db/queries.ts', generateQueriesTs()],
        ['src/lib/db/repositories/items.ts', generateRepositoryItems()],
        ['src/lib/components/UpdatePrompt.svelte', generateUpdatePromptComponent()],
        ['src/lib/demo/mockData.ts', generateDemoMockData()],
        ['src/lib/demo/config.ts', generateDemoConfig()]
      ]
    }
  ];

  for (const group of groups) {
    s.start(`${group.label} [0/${group.entries.length}]...`);
    filesWritten += writeGroup(
      group.entries,
      cwd,
      createdFiles,
      skippedFiles,
      group.label,
      s,
      filesWritten
    );
    s.stop(`${group.label} ${color.dim(`\u2014 ${group.entries.length} files`)}`);
  }

  // 4. Set up husky
  s.start('Setting up git hooks...');
  execSync('npx husky init', { stdio: 'pipe', cwd });
  const preCommitPath = join(cwd, '.husky/pre-commit');
  writeFileSync(preCommitPath, generateHuskyPreCommit(), 'utf-8');
  createdFiles.push('.husky/pre-commit');
  filesWritten++;
  s.stop(`Git hooks ${color.dim('\u2014 1 file')}`);

  p.log.success(`All project files generated ${color.dim(`(${filesWritten} total)`)}`);

  // 5. Print final summary
  p.note(
    [
      `${color.green('Created:')} ${color.bold(String(createdFiles.length))} files`,
      `${color.dim('Skipped:')} ${color.bold(String(skippedFiles.length))} files`
    ].join('\n'),
    'Setup complete!'
  );

  p.log.step(
    [
      color.bold('Next steps:'),
      `  1. Copy ${color.cyan('.env.example')} to ${color.cyan('.env')} and add your Supabase credentials`,
      `  2. Define your tables in ${color.cyan('src/lib/schema.ts')}`,
      `  3. Run ${color.cyan('npm run dev')} \u2014 types and Supabase schema update automatically`,
      '  4. Add app icons in static/icons/'
    ].join('\n')
  );

  p.outro('Happy building!');
}
