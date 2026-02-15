#!/usr/bin/env node
/**
 * @fileoverview CLI script that scaffolds a PWA SvelteKit project using stellar-engine.
 *
 * Generates a complete project structure including:
 *   - Build configuration (Vite, TypeScript, SvelteKit, ESLint, Prettier, Knip)
 *   - PWA assets (manifest, offline page, placeholder icons)
 *   - SvelteKit routes (home, login, setup wizard, profile, error, confirm)
 *   - API endpoints (config, deploy, validate)
 *   - Supabase database schema
 *   - Git hooks via Husky
 *
 * Files are written non-destructively: existing files are skipped, not overwritten.
 *
 * Launches an interactive walkthrough when invoked as `stellar-engine install pwa`.
 *
 * @example
 * ```bash
 * stellar-engine install pwa
 * ```
 *
 * @see {@link main} for the entry point
 * @see {@link runInteractiveSetup} for the interactive walkthrough
 * @see {@link writeIfMissing} for the non-destructive file write strategy
 */
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
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
function writeIfMissing(filePath, content, createdFiles, skippedFiles, quiet = false) {
    const relPath = filePath.replace(process.cwd() + '/', '');
    if (existsSync(filePath)) {
        skippedFiles.push(relPath);
        if (!quiet)
            console.log(`  [skip] ${relPath} already exists`);
    }
    else {
        const dir = filePath.substring(0, filePath.lastIndexOf('/'));
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(filePath, content, 'utf-8');
        createdFiles.push(relPath);
        if (!quiet)
            console.log(`  [write] ${relPath}`);
    }
}
// =============================================================================
//                           ANSI STYLE HELPERS
// =============================================================================
/** Wrap text in ANSI bold. */
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
/** Wrap text in ANSI dim. */
const dim = (s) => `\x1b[2m${s}\x1b[22m`;
/** Wrap text in ANSI cyan. */
const cyan = (s) => `\x1b[36m${s}\x1b[39m`;
/** Wrap text in ANSI green. */
const green = (s) => `\x1b[32m${s}\x1b[39m`;
/** Wrap text in ANSI yellow. */
const yellow = (s) => `\x1b[33m${s}\x1b[39m`;
/** Wrap text in ANSI red. */
const red = (s) => `\x1b[31m${s}\x1b[39m`;
/**
 * Draw a box around lines of text using Unicode box-drawing characters.
 *
 * @param lines - The lines of text to display inside the box.
 * @param style - `"double"` for `╔═╗║╚═╝`, `"single"` for `┌─┐│└─┘`.
 * @param title - Optional title to display in the top border.
 * @returns The formatted box string with leading two-space indent.
 */
function box(lines, style, title) {
    const [tl, h, tr, v, bl, br] = style === 'double'
        ? ['\u2554', '\u2550', '\u2557', '\u2551', '\u255a', '\u255d']
        : ['\u250c', '\u2500', '\u2510', '\u2502', '\u2514', '\u2518'];
    const width = Math.max(...lines.map((l) => l.length), (title ?? '').length + 4, 50);
    let top;
    if (title) {
        const titleStr = `${h} ${title} `;
        top = `  ${tl}${titleStr}${h.repeat(width - titleStr.length)}${tr}`;
    }
    else {
        top = `  ${tl}${h.repeat(width)}${tr}`;
    }
    const mid = lines.map((l) => `  ${v} ${l.padEnd(width - 2)}${v}`).join('\n');
    const bot = `  ${bl}${h.repeat(width)}${br}`;
    return `${top}\n${mid}\n${bot}`;
}
/**
 * Draw a double-bordered box with a header and body separated by a mid-rule.
 *
 * @param header - The header line(s) to display above the divider.
 * @param body - The body lines to display below the divider.
 * @returns The formatted box string with leading two-space indent.
 */
function doubleBoxWithHeader(header, body) {
    const width = Math.max(...header.map((l) => l.length), ...body.map((l) => l.length), 50);
    const top = `  \u2554${'═'.repeat(width)}\u2557`;
    const headLines = header.map((l) => `  \u2551 ${l.padEnd(width - 2)}\u2551`).join('\n');
    const mid = `  \u2560${'═'.repeat(width)}\u2563`;
    const bodyLines = body.map((l) => `  \u2551 ${l.padEnd(width - 2)}\u2551`).join('\n');
    const bot = `  \u255a${'═'.repeat(width)}\u255d`;
    return `${top}\n${headLines}\n${mid}\n${bodyLines}\n${bot}`;
}
// =============================================================================
//                              SPINNER
// =============================================================================
/** Braille spinner frames for animated progress. */
const SPINNER_FRAMES = [
    '\u280b',
    '\u2819',
    '\u2839',
    '\u2838',
    '\u283c',
    '\u2834',
    '\u2826',
    '\u2827',
    '\u2807',
    '\u280f'
];
/**
 * Create a terminal spinner that updates a single line in-place.
 *
 * @param text - Initial text to display beside the spinner.
 * @returns An object with `update`, `succeed`, and `stop` methods.
 */
function createSpinner(text) {
    let frame = 0;
    let current = text;
    let timer = null;
    const render = () => {
        const spinner = cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
        process.stdout.write(`\r  ${spinner} ${current}`);
        frame++;
    };
    timer = setInterval(render, 80);
    render();
    return {
        update(newText) {
            current = newText;
        },
        succeed(finalText) {
            if (timer)
                clearInterval(timer);
            timer = null;
            process.stdout.write(`\r  ${green('\u2713')} ${finalText}\x1b[K\n`);
        },
        stop() {
            if (timer)
                clearInterval(timer);
            timer = null;
            process.stdout.write('\x1b[K');
        }
    };
}
// =============================================================================
//                         INTERACTIVE SETUP
// =============================================================================
/**
 * Promisified readline question helper.
 *
 * @param rl - The readline interface.
 * @param prompt - The prompt string to display.
 * @returns The user's input string.
 */
function ask(rl, prompt) {
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(answer));
    });
}
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
 * @throws {SystemExit} Exits with code 0 if the user declines to proceed.
 */
async function runInteractiveSetup() {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    /* ── Welcome banner ── */
    console.log();
    console.log(doubleBoxWithHeader([`       ${bold('\u2726 stellar-engine \u00b7 PWA scaffolder \u2726')}`], [
        'Creates a complete offline-first SvelteKit PWA ',
        'with auth, sync, and service worker support.   '
    ]));
    console.log();
    /* ── App Name ── */
    let name = '';
    while (!name) {
        console.log(box([
            'The full name of your application.             ',
            'Used in the page title, README, and manifest.  ',
            `Example: ${dim('"Stellar Planner"')}                       `
        ], 'single', 'App Name'));
        const input = (await ask(rl, `  ${yellow('\u2192')} App name: `)).trim();
        if (!input) {
            console.log(red('  App name is required.\n'));
        }
        else {
            name = input;
        }
    }
    console.log();
    /* ── Short Name ── */
    let shortName = '';
    while (!shortName) {
        console.log(box([
            'A short label for the home screen and app bar. ',
            'Must be under 12 characters.                   ',
            `Example: ${dim('"Stellar"')}                               `
        ], 'single', 'Short Name'));
        const input = (await ask(rl, `  ${yellow('\u2192')} Short name: `)).trim();
        if (!input) {
            console.log(red('  Short name is required.\n'));
        }
        else if (input.length >= 12) {
            console.log(red('  Short name must be under 12 characters.\n'));
        }
        else {
            shortName = input;
        }
    }
    console.log();
    /* ── Prefix ── */
    const suggestedPrefix = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    let prefix = '';
    while (!prefix) {
        console.log(box([
            'Lowercase key used for localStorage, caches,   ',
            'and the service worker scope.                   ',
            'No spaces. Letters and numbers only.            ',
            `Suggested: ${dim(`"${suggestedPrefix}"`)}${' '.repeat(Math.max(0, 36 - suggestedPrefix.length - 3))}`
        ], 'single', 'Prefix'));
        const input = (await ask(rl, `  ${yellow('\u2192')} Prefix ${dim(`(${suggestedPrefix})`)}: `)).trim();
        const value = input || suggestedPrefix;
        if (!/^[a-z][a-z0-9]*$/.test(value)) {
            console.log(red('  Prefix must be lowercase, start with a letter, no spaces.\n'));
        }
        else {
            prefix = value;
        }
    }
    console.log();
    /* ── Description ── */
    const defaultDesc = 'A self-hosted offline-first PWA';
    console.log(box([
        'A brief description for meta tags and manifest. ',
        `Press Enter to use the default.                 `,
        `Default: ${dim(`"${defaultDesc}"`)}`
    ], 'single', 'Description'));
    const descInput = (await ask(rl, `  ${yellow('\u2192')} Description ${dim('(optional)')}: `)).trim();
    const description = descInput || defaultDesc;
    console.log();
    /* Derive kebab-case name for package.json from the full name */
    const kebabName = name.toLowerCase().replace(/\s+/g, '-');
    const opts = { name, shortName, prefix, description, kebabName };
    /* ── Confirmation summary ── */
    console.log(box([
        `${bold('Name:')}         ${opts.name}${' '.repeat(Math.max(0, 38 - opts.name.length))}`,
        `${bold('Short name:')}   ${opts.shortName}${' '.repeat(Math.max(0, 38 - opts.shortName.length))}`,
        `${bold('Prefix:')}       ${opts.prefix}${' '.repeat(Math.max(0, 38 - opts.prefix.length))}`,
        `${bold('Description:')}  ${opts.description}${' '.repeat(Math.max(0, 38 - opts.description.length))}`
    ], 'single', 'Configuration'));
    const proceed = (await ask(rl, `  Proceed? ${dim('(Y/n)')}: `)).trim().toLowerCase();
    if (proceed === 'n' || proceed === 'no') {
        console.log(dim('\n  Setup cancelled.\n'));
        rl.close();
        process.exit(0);
    }
    rl.close();
    console.log();
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
 * for a stellar-engine PWA project.
 *
 * Includes dev tooling (ESLint, Prettier, Knip, Husky, svelte-check) and
 * the `@prabhask5/stellar-engine` runtime dependency.
 *
 * @param opts - The install options containing the kebab-cased project name.
 * @returns The JSON string for `package.json`.
 */
function generatePackageJson(opts) {
    return (JSON.stringify({
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
            '@prabhask5/stellar-engine': '^1.1.6'
        },
        type: 'module'
    }, null, 2) + '\n');
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
function generateViteConfig(opts) {
    return `/**
 * @fileoverview Vite build configuration for the ${opts.shortName} PWA.
 *
 * This config handles three key concerns:
 *   1. SvelteKit integration — via the official \`sveltekit()\` plugin
 *   2. Service worker + asset manifest — via the \`stellarPWA()\` plugin from
 *      stellar-engine, which generates \`static/sw.js\` and \`asset-manifest.json\`
 *      at build time
 *   3. Chunk-splitting — isolates heavy vendor libs (\`@supabase\`, \`dexie\`)
 *      into their own bundles for long-term caching
 */

// =============================================================================
//                                  IMPORTS
// =============================================================================

import { sveltekit } from '@sveltejs/kit/vite';
import { stellarPWA } from '@prabhask5/stellar-engine/vite';
import { defineConfig } from 'vite';

// =============================================================================
//                            VITE CONFIGURATION
// =============================================================================

export default defineConfig({
  plugins: [
    sveltekit(),
    stellarPWA({ prefix: '${opts.prefix}', name: '${opts.name}' })
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
function generateTsconfig() {
    return (JSON.stringify({
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
    }, null, 2) + '\n');
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
function generateSvelteConfig(opts) {
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
function generateManifest(opts) {
    return (JSON.stringify({
        name: opts.name,
        short_name: opts.shortName,
        description: opts.description,
        start_url: '/?pwa=true',
        scope: '/',
        id: '/',
        display: 'standalone',
        background_color: '#0f0f1a',
        theme_color: '#1a1a2e',
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
    }, null, 2) + '\n');
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
function generateAppDts(opts) {
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
function generateAppHtml(opts) {
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

    <!-- Theme color matches \`--color-void\` for seamless safe-area blending -->
    <meta name="theme-color" content="#050510" />
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

    <!-- SvelteKit injects component-level <head> content here -->
    %sveltekit.head%
  </head>
  <body data-sveltekit-preload-data="hover">
    <!-- ================================================================= -->
    <!--               LANDSCAPE ORIENTATION BLOCKER                       -->
    <!-- ================================================================= -->
    <!-- TODO: Add landscape blocker UI. The #landscape-blocker
         div is shown via the @media query below when a phone is in landscape. -->
    <div id="landscape-blocker">
      <!-- TODO: Add your landscape blocker content here -->
    </div>

    <!-- ================================================================= -->
    <!--              LANDSCAPE BLOCKER STYLES                             -->
    <!-- ================================================================= -->
    <style>
      /* TODO: Add #landscape-blocker styling (hidden by default, shown by query below) */

      /* ── Visibility Trigger ─────────────────────────────────────────── */
      /*
       * Show the blocker ONLY on phones in landscape:
       *   - max-height: 500px   → landscape phone viewports
       *   - orientation          → landscape
       *   - hover: none          → excludes desktop/laptop (they have hover)
       *   - pointer: coarse      → excludes stylus / mouse devices
       */
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
function generateReadme(opts) {
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
npm run dev
\`\`\`

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
function generateArchitecture(opts) {
    return `# Architecture

## Overview

${opts.name} is an offline-first PWA built with SvelteKit 2 and Svelte 5, powered by \`@prabhask5/stellar-engine\` for data sync and authentication.

## Stack

- **Framework**: SvelteKit 2 + Svelte 5
- **Sync Engine**: \`@prabhask5/stellar-engine\` (IndexedDB + Supabase)
- **Backend**: Supabase (auth, Postgres, realtime)
- **PWA**: Custom service worker with smart caching

## Project Structure

\`\`\`
src/
  routes/          # SvelteKit routes
  lib/             # Shared code
    components/    # Svelte components
    stores/        # Svelte stores
    types/         # TypeScript types
static/
  sw.js            # Service worker (generated by stellarPWA plugin)
  manifest.json    # PWA manifest
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
function generateFrameworks() {
    return `# Framework Decisions

## SvelteKit 2 + Svelte 5

Svelte 5 introduces runes (\`$state\`, \`$derived\`, \`$effect\`, \`$props\`) for fine-grained reactivity. SvelteKit provides file-based routing, SSR, and the adapter system.

## stellar-engine

\`@prabhask5/stellar-engine\` handles:
- **Offline-first data**: IndexedDB via Dexie with automatic sync to Supabase
- **Authentication**: Supabase Auth with offline mode support
- **Real-time sync**: Supabase Realtime subscriptions

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
function generateGitignore() {
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
static/sw.js
static/asset-manifest.json
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
function generateOfflineHtml(opts) {
    return `<!-- TODO: Customize this offline fallback page with your app's branding.
     This page is served by the service worker when the app is offline and
     no cached HTML is available. -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Offline - ${opts.name}</title>
  <!-- TODO: Add your offline page styling here -->
</head>
<body>
  <!-- TODO: Add your offline page content here -->
  <h1>You're Offline</h1>
  <p>Please check your internet connection and try again.</p>
  <button onclick="location.reload()">Try Again</button>
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
function generatePlaceholderSvg(color, label, fontSize = 64) {
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
function generateMonochromeSvg(label) {
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
function generateSplashSvg(label) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="#0f0f1a"/>
  <text x="256" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="48" font-weight="700" fill="white">${label}</text>
</svg>
`;
}
// ---------------------------------------------------------------------------
//                  EMAIL TEMPLATE PLACEHOLDER
// ---------------------------------------------------------------------------
/**
 * Generate a placeholder HTML email template with a TODO comment.
 *
 * @param title - The email template title (e.g., `"Change Email"`).
 * @returns The HTML source for the email placeholder.
 */
function generateEmailPlaceholder(title) {
    return `<!-- TODO: ${title} email template -->
<!-- See stellar-engine EMAIL_TEMPLATES.md for the full template format -->
<!DOCTYPE html>
<html><head><title>${title}</title></head>
<body><p>TODO: Implement ${title} email template</p></body>
</html>
`;
}
// ---------------------------------------------------------------------------
//                  SUPABASE SCHEMA GENERATOR
// ---------------------------------------------------------------------------
/**
 * Generate the Supabase database schema SQL including helper functions,
 * the `trusted_devices` table, and commented-out example table patterns.
 *
 * @param opts - The install options containing `name`.
 * @returns The SQL source for `supabase-schema.sql`.
 */
function generateSupabaseSchema(opts) {
    return `-- ${opts.name} Database Schema for Supabase
-- Copy and paste this entire file into your Supabase SQL Editor

-- ============================================================
-- EXTENSIONS
-- ============================================================

create extension if not exists "uuid-ossp";

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Function to automatically set user_id on insert
create or replace function set_user_id()
returns trigger as $$
begin
  new.user_id := auth.uid();
  return new;
end;
$$ language plpgsql security definer set search_path = '';

-- Function to automatically update updated_at timestamp
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$ language plpgsql set search_path = '';

-- ============================================================
-- YOUR TABLES HERE
-- ============================================================
-- Example table showing the required column pattern:
--
-- create table items (
--   id uuid default uuid_generate_v4() primary key,
--   user_id uuid references auth.users(id) on delete cascade,
--   name text not null,
--   completed boolean default false not null,
--   "order" double precision default 0 not null,
--   created_at timestamp with time zone default timezone('utc'::text, now()) not null,
--   updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
--   deleted boolean default false not null,
--   _version integer default 1 not null,
--   device_id text
-- );
--
-- alter table items enable row level security;
-- create policy "Users can manage own items" on items for all using (auth.uid() = user_id);
--
-- create trigger set_user_id_items before insert on items for each row execute function set_user_id();
-- create trigger update_items_updated_at before update on items for each row execute function update_updated_at_column();
--
-- create index idx_items_user_id on items(user_id);
-- create index idx_items_order on items("order");
-- create index idx_items_updated_at on items(updated_at);
-- create index idx_items_deleted on items(deleted) where deleted = false;

-- ============================================================
-- TRUSTED DEVICES (required for device verification)
-- ============================================================

create table trusted_devices (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  device_id text not null,
  device_label text,
  trusted_at timestamptz default now() not null,
  last_used_at timestamptz default now() not null,
  unique(user_id, device_id)
);

alter table trusted_devices enable row level security;
create policy "Users can manage own devices" on trusted_devices for all using (auth.uid() = user_id);

create trigger set_user_id_trusted_devices before insert on trusted_devices for each row execute function set_user_id();
create trigger update_trusted_devices_updated_at before update on trusted_devices for each row execute function update_updated_at_column();

create index idx_trusted_devices_user_id on trusted_devices(user_id);

-- ============================================================
-- REALTIME: Enable real-time subscriptions for all tables
-- ============================================================
-- Enable realtime for your tables:
-- alter publication supabase_realtime add table items;

alter publication supabase_realtime add table trusted_devices;
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
function generateEslintConfig() {
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
function generatePrettierrc() {
    return (JSON.stringify({
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
    }, null, 2) + '\n');
}
/**
 * Generate a `.prettierignore` excluding build artifacts and generated files.
 *
 * @returns The prettierignore content string.
 */
function generatePrettierignore() {
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
function generateKnipJson() {
    return (JSON.stringify({
        $schema: 'https://unpkg.com/knip@latest/schema.json',
        entry: ['src/routes/**/*.{svelte,ts,js}', 'src/lib/**/*.{svelte,ts,js}'],
        project: ['src/**/*.{svelte,ts,js}'],
        ignore: ['src/app.d.ts', '**/*.test.ts', '**/*.spec.ts'],
        sveltekit: {
            config: 'svelte.config.js'
        }
    }, null, 2) + '\n');
}
// ---------------------------------------------------------------------------
//                    HUSKY PRE-COMMIT GENERATOR
// ---------------------------------------------------------------------------
/**
 * Generate the Husky pre-commit hook script that runs cleanup and validation.
 *
 * @returns The shell script content for `.husky/pre-commit`.
 */
function generateHuskyPreCommit() {
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
function generateRootLayoutTs(opts) {
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
import { initEngine, startSyncEngine, supabase } from '@prabhask5/stellar-engine';
import { initConfig } from '@prabhask5/stellar-engine/config';
import { resolveAuthState, lockSingleUser } from '@prabhask5/stellar-engine/auth';
import { resolveRootLayout } from '@prabhask5/stellar-engine/kit';
import type { AuthMode, OfflineCredentials, Session } from '@prabhask5/stellar-engine/types';
import type { LayoutLoad } from './$types';

// =============================================================================
//                          SVELTEKIT ROUTE CONFIG
// =============================================================================

/** Allow server-side rendering for initial page load performance. */
export const ssr = true;
/** Disable prerendering — pages depend on runtime auth state. */
export const prerender = false;

// =============================================================================
//                          ENGINE BOOTSTRAP
// =============================================================================

// TODO: Configure initEngine() with your app-specific database schema.
// Call initEngine({...}) at module scope (guarded by \`if (browser)\`).
// See the stellar-engine documentation for the full config interface.
//
// Example:
// if (browser) {
//   initEngine({
//     tables: [
//       { supabaseName: 'items', columns: 'id,user_id,name,...' }
//     ],
//     database: {
//       name: '${opts.name.replace(/[^a-zA-Z0-9]/g, '')}DB',
//       versions: [
//         { version: 1, stores: { items: 'id, user_id, created_at, updated_at' } }
//       ]
//     },
//     supabase,
//     prefix: '${opts.prefix}',
//     auth: { singleUser: { gateType: 'code', codeLength: 6 } },
//     onAuthStateChange: (event, session) => { /* handle auth events */ },
//     onAuthKicked: async () => { await lockSingleUser(); goto('/login'); }
//   });
// }

// =============================================================================
//                           LAYOUT DATA TYPE
// =============================================================================

/**
 * Data returned by the root layout load function.
 */
export interface LayoutData {
  /** Active Supabase session, or \`null\` when offline / unauthenticated. */
  session: Session | null;
  /** Current authentication mode (\`'online'\`, \`'offline'\`, or \`'none'\`). */
  authMode: AuthMode;
  /** Cached offline credentials (display name, avatar) when auth is offline. */
  offlineProfile: OfflineCredentials | null;
  /** Whether the single-user account has completed initial setup. */
  singleUserSetUp?: boolean;
}

// =============================================================================
//                            LOAD FUNCTION
// =============================================================================

/**
 * Root layout load — initialises config, resolves auth, and starts sync.
 *
 * @param params - SvelteKit load params (provides the current URL).
 * @returns Layout data with session and auth state.
 */
export const load: LayoutLoad = async ({ url }): Promise<LayoutData> => {
  if (browser) {
    /* Fetch runtime config from /api/config (cached after first call) */
    const config = await initConfig();
    if (!config && url.pathname !== '/setup') {
      redirect(307, '/setup');
    }
    if (!config) {
      return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
    }
    /* Determine whether the user is online-authenticated, offline, or none */
    const result = await resolveAuthState();
    if (result.authMode !== 'none') {
      /* Kick off background sync (Supabase realtime + IndexedDB) */
      await startSyncEngine();
    }
    return result;
  }
  /* SSR fallback — no auth info available on the server */
  return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
};
`;
}
/**
 * Generate the root `+layout.svelte` with auth state hydration and TODO stubs.
 *
 * @returns The Svelte component source for `src/routes/+layout.svelte`.
 */
function generateRootLayoutSvelte(opts) {
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

  /* ── Svelte Lifecycle & Transitions ── */
  import { onMount, onDestroy } from 'svelte';

  /* ── SvelteKit Utilities ── */
  import { page } from '$app/stores';
  import { browser } from '$app/environment';

  /* ── Stellar Engine — Auth & Stores ── */
  import { lockSingleUser } from '@prabhask5/stellar-engine/auth';
  import { debug } from '@prabhask5/stellar-engine/utils';
  import { hydrateAuthState } from '@prabhask5/stellar-engine/kit';

  /* ── Types ── */
  import type { LayoutData } from './+layout';

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

  /* ── Toast Notification ── */
  /** Whether the toast notification is currently visible. */
  let showToast = $state(false);

  /** The text content of the current toast notification. */
  let toastMessage = $state('');

  /** The visual style of the toast — \`'info'\` (purple) or \`'error'\` (pink). */
  let toastType = $state<'info' | 'error'>('info');

  /* ── Sign-Out ── */
  /** When \`true\`, a full-screen overlay is shown to mask the sign-out transition. */
  let isSigningOut = $state(false);

  /* ── Cleanup References ── */
  /** Stored reference to the chunk error handler so we can remove it on destroy. */
  let chunkErrorHandler: ((event: PromiseRejectionEvent) => void) | null = null;

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

  // =============================================================================
  //  Lifecycle — Mount
  // =============================================================================

  onMount(() => {
    // ── Chunk Error Handler ────────────────────────────────────────────────
    // When navigating offline to a page whose JS chunks aren't cached,
    // the dynamic import fails and shows a cryptic error. Catch and show a friendly message.
    chunkErrorHandler = (event: PromiseRejectionEvent) => {
      const error = event.reason;
      // Check if this is a chunk loading error (fetch failed or syntax error from 503 response)
      const isChunkError =
        error?.message?.includes('Failed to fetch dynamically imported module') ||
        error?.message?.includes('error loading dynamically imported module') ||
        error?.message?.includes('Importing a module script failed') ||
        error?.name === 'ChunkLoadError' ||
        (error?.message?.includes('Loading chunk') && error?.message?.includes('failed'));

      if (isChunkError && !navigator.onLine) {
        event.preventDefault(); // Prevent default error handling
        // Show offline navigation toast
        toastMessage = "This page isn't available offline. Please reconnect or go back.";
        toastType = 'info';
        showToast = true;
        setTimeout(() => {
          showToast = false;
        }, 5000);
      }
    };

    window.addEventListener('unhandledrejection', chunkErrorHandler);

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
  });

  // =============================================================================
  //  Lifecycle — Destroy
  // =============================================================================

  onDestroy(() => {
    if (browser) {
      // Cleanup chunk error handler
      if (chunkErrorHandler) {
        window.removeEventListener('unhandledrejection', chunkErrorHandler);
      }
      // Cleanup sign out listener
      window.removeEventListener('${opts.prefix}:signout', handleSignOut);
    }
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
    // Show full-screen overlay immediately
    isSigningOut = true;

    // Wait for overlay to fully appear
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Lock the single-user session (stops engine, resets auth state, does NOT destroy data)
    await lockSingleUser();

    // Navigate to login
    window.location.href = '/login';
  }

  /**
   * Checks whether a given route \`href\` matches the current page path.
   * Used to highlight the active nav item.
   *
   * @param href - The route path to check (e.g. \`'/agenda'\`)
   * @returns \`true\` if the current path starts with \`href\`
   */
  function isActive(href: string): boolean {
    return $page.url.pathname.startsWith(href);
  }

  /**
   * Dismisses the currently visible toast notification.
   */
  function dismissToast() {
    showToast = false;
  }
</script>

<!-- TODO: Add your app shell template (navbar, tab bar, page transitions, etc.) -->
{@render children?.()}
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
function generateHomePage(opts) {
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

  /* ── Stellar Engine — Auth & Stores ── */
  import { resolveFirstName } from '@prabhask5/stellar-engine/auth';
  import { onSyncComplete, authState } from '@prabhask5/stellar-engine/stores';

  /* ── SvelteKit ── */
  import { goto } from '$app/navigation';

  // ==========================================================================
  //                           COMPONENT STATE
  // ==========================================================================

  /**
   * Derive the user's first name for the greeting display.
   * Falls back through session profile → email username → offline profile → 'Explorer'.
   */
  const firstName = $derived(resolveFirstName($authState.session, $authState.offlineProfile));

  // =============================================================================
  //  Reactive Effects
  // =============================================================================

  /**
   * Effect: auth redirect guard.
   *
   * Once the auth store finishes loading and resolves to \`'none'\` (no session),
   * redirect to \`/login\` with a \`redirect\` query param so the login page knows
   * this was an automatic redirect rather than direct navigation.
   */
  $effect(() => {
    if (!$authState.isLoading && $authState.mode === 'none') {
      // Include redirect param so login page knows this was a redirect, not direct navigation
      goto('/login?redirect=%2F', { replaceState: true });
    }
  });

  // TODO: Add home page state and logic
</script>

<svelte:head>
  <title>Home - ${opts.name}</title>
</svelte:head>

<!-- TODO: Add home page template -->
`;
}
/**
 * Generate a minimal error page component.
 *
 * @returns The Svelte component source for `src/routes/+error.svelte`.
 */
function generateErrorPage(opts) {
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

<!-- TODO: Add error page template (status code display, retry button, go home button) -->
`;
}
/**
 * Generate the setup page load function with first-setup / auth guard.
 *
 * @returns The TypeScript source for `src/routes/setup/+page.ts`.
 */
function generateSetupPageTs() {
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
import { getConfig } from '@prabhask5/stellar-engine/config';
import { getValidSession } from '@prabhask5/stellar-engine/auth';
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
 * Generate the setup wizard page component with TODO stubs.
 *
 * @returns The Svelte component source for `src/routes/setup/+page.svelte`.
 */
function generateSetupPageSvelte(opts) {
    return `<!--
  @fileoverview Five-step Supabase configuration wizard.

  Guides the user through entering Supabase credentials, validating them
  against the server, optionally deploying environment variables to Vercel,
  and reloading the app with the new config active.
-->
<script lang="ts">
  /**
   * @fileoverview Setup wizard page — first-time Supabase configuration.
   *
   * Guides the user through a five-step process to connect their own
   * Supabase backend to ${opts.name}:
   *
   * 1. Create a Supabase project (instructions only).
   * 2. Configure authentication (enable anonymous sign-ins).
   * 3. Initialize the database by running the schema SQL.
   * 4. Enter and validate Supabase credentials (URL + anon key).
   * 5. Persist configuration via Vercel API (set env vars + redeploy).
   *
   * After a successful deploy the page polls for a new service-worker
   * version — once detected the user is prompted to refresh.
   *
   * Access is controlled by the companion \`+page.ts\` load function:
   * - Unconfigured → anyone can reach this page (\`isFirstSetup: true\`).
   * - Configured → authenticated users only (\`isFirstSetup: false\`).
   */

  import { page } from '$app/stores';
  import { setConfig } from '@prabhask5/stellar-engine/config';
  import { isOnline } from '@prabhask5/stellar-engine/stores';
  import { pollForNewServiceWorker } from '@prabhask5/stellar-engine/kit';

  // =============================================================================
  //  Form State — Supabase + Vercel credentials
  // =============================================================================

  /** Supabase project URL entered by the user */
  let supabaseUrl = $state('');

  /** Supabase public anon key entered by the user */
  let supabaseAnonKey = $state('');

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

  /** \`true\` after credentials have been successfully validated */
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

  /**
   * Snapshot of the credentials at validation time — used to detect
   * if the user edits the inputs *after* a successful validation.
   */
  let validatedUrl = $state('');
  let validatedKey = $state('');

  /**
   * \`true\` when the user changes credentials after a successful
   * validation — the "Continue" button should be re-disabled.
   */
  const credentialsChanged = $derived(
    validateSuccess && (supabaseUrl !== validatedUrl || supabaseAnonKey !== validatedKey)
  );

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
   * Send the entered Supabase credentials to \`/api/setup/validate\`
   * and update UI state based on the result. On success, also
   * cache the config locally via \`setConfig\` so the app is usable
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
        body: JSON.stringify({ supabaseUrl, supabaseAnonKey })
      });

      const data = await res.json();

      if (data.valid) {
        validateSuccess = true;
        validatedUrl = supabaseUrl;
        validatedKey = supabaseAnonKey;
        /* Cache config locally so the app works immediately after deploy */
        setConfig({
          supabaseUrl,
          supabaseAnonKey,
          configured: true
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
   * redeployment has finished. Uses the engine's \`pollForNewServiceWorker\`
   * helper which checks \`registration.update()\` at regular intervals.
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
   * Send credentials and the Vercel token to \`/api/setup/deploy\`,
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
        body: JSON.stringify({ supabaseUrl, supabaseAnonKey, vercelToken })
      });

      const data = await res.json();

      if (data.success) {
        deployStage = 'deploying';
        _deploymentUrl = data.deploymentUrl || '';
        /* Poll for the new SW version → marks \`deployStage = 'ready'\` */
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

<!-- TODO: Add setup wizard template (Supabase credentials form, validation, Vercel deployment) -->
`;
}
/**
 * Generate a minimal privacy policy page component.
 *
 * @returns The Svelte component source for `src/routes/policy/+page.svelte`.
 */
function generatePolicyPage(opts) {
    return `<!--
  @fileoverview Privacy policy page.

  Static content page that displays the application's privacy policy.
  Required by app stores and good practice for any app handling user data.
-->
<script lang="ts">
  // TODO: Add any needed imports
</script>

<svelte:head>
  <title>Privacy Policy - ${opts.name}</title>
</svelte:head>

<!-- TODO: Add privacy policy page content -->
`;
}
/**
 * Generate the login page component with single-user auth, device
 * verification, and PIN input TODO stubs.
 *
 * @returns The Svelte component source for `src/routes/login/+page.svelte`.
 */
function generateLoginPage(opts) {
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
    linkSingleUserDevice
  } from '@prabhask5/stellar-engine/auth';
  import { sendDeviceVerification } from '@prabhask5/stellar-engine';

  // ==========================================================================
  //                        LAYOUT / PAGE DATA
  // ==========================================================================

  /** Whether the single-user account has already been set up on this device */
  const singleUserSetUp = $derived($page.data.singleUserSetUp);

  /** Post-login redirect URL extracted from \`?redirect=\` query param */
  const redirectUrl = $derived($page.url.searchParams.get('redirect') || '/');

  // ==========================================================================
  //                          SHARED UI STATE
  // ==========================================================================

  /** \`true\` while any async auth operation is in-flight */
  let loading = $state(false);

  /** Current error message shown to the user (null = no error) */
  let error = $state<string | null>(null);

  /** Triggers the CSS shake animation on the login card */
  let shaking = $state(false);

  /** Set to \`true\` after the component mounts — enables entrance animation */
  let mounted = $state(false);

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

    /* ── Existing local account → fetch user info for the welcome card ──── */
    if (singleUserSetUp) {
      const info = await getSingleUserInfo();
      if (info) {
        userInfo = {
          firstName: (info.profile.firstName as string) || '',
          lastName: (info.profile.lastName as string) || ''
        };
      }
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
    retryCountdown = Math.ceil(ms / 1000);
    if (retryTimer) clearInterval(retryTimer);
    retryTimer = setInterval(() => {
      retryCountdown--;
      if (retryCountdown <= 0) {
        retryCountdown = 0;
        error = null;
        if (retryTimer) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
      }
    }, 1000);
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
      const { resendConfirmationEmail } = await import('@prabhask5/stellar-engine');
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
      /* No confirmation needed → go straight to the app */
      await invalidateAll();
      goto('/');
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Setup failed. Please try again.';
      shaking = true;
      setTimeout(() => {
        shaking = false;
      }, 500);
      codeDigits = ['', '', '', '', '', ''];
      confirmDigits = ['', '', '', '', '', ''];
      if (codeInputs[0]) codeInputs[0].focus();
    } finally {
      loading = false;
    }
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
        }
        shaking = true;
        setTimeout(() => {
          shaking = false;
        }, 500);
        unlockDigits = ['', '', '', '', '', ''];
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
      /* Success → navigate to the redirect target */
      await invalidateAll();
      goto(redirectUrl);
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Incorrect code';
      shaking = true;
      setTimeout(() => {
        shaking = false;
      }, 500);
      unlockDigits = ['', '', '', '', '', ''];
    } finally {
      loading = false;
      if (error) {
        await tick();
        if (unlockInputs[0]) unlockInputs[0].focus();
      }
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
        }
        shaking = true;
        setTimeout(() => {
          shaking = false;
        }, 500);
        linkDigits = Array(remoteUser.codeLength).fill('');
        return;
      }
      if (result.deviceVerificationRequired) {
        maskedEmail = result.maskedEmail || '';
        showDeviceVerificationModal = true;
        startResendCooldown();
        startVerificationPolling();
        return;
      }
      /* Success → navigate to the redirect target */
      await invalidateAll();
      goto(redirectUrl);
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : 'Incorrect code';
      shaking = true;
      setTimeout(() => {
        shaking = false;
      }, 500);
      linkDigits = Array(remoteUser.codeLength).fill('');
    } finally {
      linkLoading = false;
      if (error) {
        await tick();
        if (linkInputs[0]) linkInputs[0].focus();
      }
    }
  }
</script>

<svelte:head>
  <title>Login - ${opts.name}</title>
</svelte:head>

<!-- TODO: Add login page template (PIN inputs, setup wizard, device verification modal) -->
`;
}
/**
 * Generate the email confirmation page component that handles token
 * verification and cross-tab broadcast.
 *
 * @returns The Svelte component source for `src/routes/confirm/+page.svelte`.
 */
function generateConfirmPage(opts) {
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
  import { handleEmailConfirmation, broadcastAuthConfirmed } from '@prabhask5/stellar-engine/kit';

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
    /* ── Read Supabase callback params ── */
    const tokenHash = $page.url.searchParams.get('token_hash');
    const type = $page.url.searchParams.get('type');

    /* ── Token present → verify it ── */
    if (tokenHash && type) {
      const result = await handleEmailConfirmation(
        tokenHash,
        type as 'signup' | 'email' | 'email_change' | 'magiclink'
      );

      if (!result.success) {
        status = 'error';
        errorMessage = result.error || 'Unknown error';
        return;
      }

      status = 'success';
      /* Brief pause so the user sees the success state */
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    /* ── Notify the originating tab and decide next action ── */
    const tabResult = await broadcastAuthConfirmed(CHANNEL_NAME, type || 'signup');
    if (tabResult === 'can_close') {
      status = 'can_close';
    } else if (tabResult === 'no_broadcast') {
      focusOrRedirect();
    }
  });

  // ==========================================================================
  //                              HELPERS
  // ==========================================================================

  /**
   * Broadcast a confirmation event to any listening login tab, then
   * attempt to close this browser tab. Falls back to a static
   * "you can close this tab" message when \`window.close()\` is denied.
   */
  async function focusOrRedirect() {
    status = 'redirecting';

    const type = $page.url.searchParams.get('type') || 'signup';

    const result = await broadcastAuthConfirmed(CHANNEL_NAME, type);

    if (result === 'no_broadcast') {
      /* BroadcastChannel unsupported — redirect to home directly */
      goto('/', { replaceState: true });
    } else {
      /* 'can_close' — window.close() was blocked by browser */
      setTimeout(() => {
        status = 'can_close';
      }, 200);
    }
  }
</script>

<svelte:head>
  <title>Confirming... - ${opts.name}</title>
</svelte:head>

<!-- TODO: Add confirmation page template (verifying/success/error/can_close states) -->
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
function generateConfigServer() {
    return `/**
 * Config API Endpoint — \`GET /api/config\`
 *
 * Returns the runtime configuration object (Supabase URL, anon key, app
 * settings) that the client fetches on first load via \`initConfig()\`.
 */

import { json } from '@sveltejs/kit';
import { getServerConfig } from '@prabhask5/stellar-engine/kit';
import type { RequestHandler } from './$types';

/**
 * Serve the runtime config as JSON.
 *
 * @returns A JSON response containing the server-side config object.
 */
export const GET: RequestHandler = async () => {
  return json(getServerConfig());
};
`;
}
/**
 * Generate the `/api/setup/deploy` server endpoint for Vercel deployment.
 *
 * @returns The TypeScript source for `src/routes/api/setup/deploy/+server.ts`.
 */
function generateDeployServer() {
    return `/**
 * Vercel Deploy API Endpoint — \`POST /api/setup/deploy\`
 *
 * Accepts Supabase credentials and a Vercel token, then sets the
 * corresponding environment variables on the Vercel project and triggers
 * a redeployment so the new config takes effect.
 */

import { json } from '@sveltejs/kit';
import { deployToVercel } from '@prabhask5/stellar-engine/kit';
import type { RequestHandler } from './$types';

/**
 * Deploy Supabase credentials to Vercel environment variables.
 *
 * @param params - SvelteKit request event.
 * @returns JSON result with success/failure and optional error message.
 */
export const POST: RequestHandler = async ({ request }) => {
  /* ── Parse and validate request body ── */
  const { supabaseUrl, supabaseAnonKey, vercelToken } = await request.json();

  if (!supabaseUrl || !supabaseAnonKey || !vercelToken) {
    return json(
      { success: false, error: 'Supabase URL, Anon Key, and Vercel Token are required' },
      { status: 400 }
    );
  }

  /* ── Ensure we're running on Vercel ── */
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!projectId) {
    return json(
      { success: false, error: 'VERCEL_PROJECT_ID not found. This endpoint only works on Vercel.' },
      { status: 400 }
    );
  }

  /* ── Delegate to engine ── */
  const result = await deployToVercel({ vercelToken, projectId, supabaseUrl, supabaseAnonKey });
  return json(result);
};
`;
}
/**
 * Generate the `/api/setup/validate` server endpoint for Supabase credential validation.
 *
 * @returns The TypeScript source for `src/routes/api/setup/validate/+server.ts`.
 */
function generateValidateServer() {
    return `/**
 * Supabase Credential Validation Endpoint — \`POST /api/setup/validate\`
 *
 * Accepts a Supabase URL and anon key, attempts a lightweight query
 * against the project, and returns whether the credentials are valid.
 * Used by the setup wizard before saving config.
 */

import { createValidateHandler } from '@prabhask5/stellar-engine/kit';
import type { RequestHandler } from './$types';

/** Validate Supabase credentials — delegates to stellar-engine's handler factory. */
export const POST: RequestHandler = createValidateHandler();
`;
}
// ---------------------------------------------------------------------------
//                  CATCHALL & PROTECTED LAYOUT GENERATORS
// ---------------------------------------------------------------------------
/**
 * Generate a catch-all route that redirects unknown paths to the home page.
 *
 * @returns The TypeScript source for `src/routes/[...catchall]/+page.ts`.
 */
function generateCatchallPage() {
    return `/**
 * Catch-All Route Handler — \`[...catchall]/+page.ts\`
 *
 * Matches any URL that doesn't correspond to a defined route and
 * redirects the user back to the home page. Prevents 404 errors
 * for deep links that no longer exist.
 */

import { redirect } from '@sveltejs/kit';

/**
 * Redirect unknown paths to the app root.
 */
export function load() {
  redirect(302, '/');
}
`;
}
/**
 * Generate the protected route group's `+layout.ts` with auth guards
 * that redirect unauthenticated users to `/login`.
 *
 * @returns The TypeScript source for `src/routes/(protected)/+layout.ts`.
 */
function generateProtectedLayoutTs() {
    return `/**
 * @fileoverview Protected Layout Load Function — Auth Guard
 *
 * Runs on every navigation into the \`(protected)\` route group.
 * Resolves the current authentication state via \`stellar-engine\` and
 * redirects unauthenticated users to \`/login\` (preserving the intended
 * destination as a \`?redirect=\` query parameter).
 *
 * On the server (SSR), returns a neutral "unauthenticated" payload so
 * that the actual auth check happens exclusively in the browser where
 * cookies / local storage are available.
 */

import { redirect } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { resolveProtectedLayout } from '@prabhask5/stellar-engine/kit';
import type { ProtectedLayoutData } from '@prabhask5/stellar-engine/kit';
import type { LayoutLoad } from './$types';

export type { ProtectedLayoutData };

/**
 * SvelteKit universal \`load\` function for the \`(protected)\` layout.
 *
 * - **Browser**: resolves the auth state; redirects to \`/login\` if \`authMode\` is \`'none'\`.
 * - **Server**: short-circuits with a neutral payload (auth is client-side only).
 *
 * @param url — The current page URL, used to build the redirect target.
 * @returns Resolved \`ProtectedLayoutData\` for downstream pages and layouts.
 */
export const load: LayoutLoad = async ({ url }): Promise<ProtectedLayoutData> => {
  if (browser) {
    const { data, redirectUrl } = await resolveProtectedLayout(url);

    if (redirectUrl) {
      throw redirect(302, redirectUrl);
    }

    return data;
  }

  /* SSR fallback — no auth info available on the server */
  return { session: null, authMode: 'none', offlineProfile: null };
};
`;
}
/**
 * Generate the protected route group's `+layout.svelte` pass-through component.
 *
 * @returns The Svelte component source for `src/routes/(protected)/+layout.svelte`.
 */
function generateProtectedLayoutSvelte() {
    return `<!--
  @fileoverview Protected Layout Component — wraps the \`(protected)\` route group.

  Every page inside \`src/routes/(protected)/\` inherits this layout. The auth
  guard lives in \`+layout.ts\`; this component is a pass-through that renders
  the child page and provides a hook for protected-area chrome (backgrounds,
  breadcrumbs, etc.).
-->
<script lang="ts">
  // ==========================================================================
  //                                IMPORTS
  // ==========================================================================

  // (no additional imports needed for the pass-through layout)

  // ==========================================================================
  //                                 PROPS
  // ==========================================================================

  interface Props {
    /** Default slot content (the routed page component). */
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  // TODO: Add conditional page backgrounds or other protected-area chrome
</script>

<!-- Render child route content -->
{@render children?.()}
`;
}
/**
 * Generate the profile page component with TODO stubs for user settings,
 * device management, and debug tools.
 *
 * @returns The Svelte component source for `src/routes/(protected)/profile/+page.svelte`.
 */
function generateProfilePage(opts) {
    return `<!--
  @fileoverview Profile & settings page.

  Capabilities:
    - View / edit display name and avatar
    - Change email address (with re-verification)
    - Change unlock gate type (PIN length, pattern, etc.)
    - Manage trusted devices (view, revoke)
    - Toggle debug mode
    - Reset local database (destructive — requires confirmation)
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
  } from '@prabhask5/stellar-engine/auth';
  import { authState } from '@prabhask5/stellar-engine/stores';
  import { isDebugMode, setDebugMode } from '@prabhask5/stellar-engine/utils';
  import {
    resetDatabase,
    getTrustedDevices,
    removeTrustedDevice,
    getCurrentDeviceId
  } from '@prabhask5/stellar-engine';
  import type { TrustedDevice } from '@prabhask5/stellar-engine';
  import { onMount } from 'svelte';

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

  let viewingTombstones = $state(false);
  let cleaningTombstones = $state(false);

  /* ── Trusted devices ──── */
  let trustedDevices = $state<TrustedDevice[]>([]);
  let currentDeviceId = $state('');
  let devicesLoading = $state(true);
  /** ID of the device currently being removed — shows spinner on that row */
  let removingDeviceId = $state<string | null>(null);

  // =============================================================================
  //                           LIFECYCLE
  // =============================================================================

  /** Populate form fields from the engine and load trusted devices on mount. */
  onMount(async () => {
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
    profileLoading = true;
    profileError = null;
    profileSuccess = null;

    try {
      await updateSingleUserProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim()
      });
      // Update auth state to immediately reflect changes in navbar
      authState.updateUserProfile({ first_name: firstName.trim(), last_name: lastName.trim() });
      profileSuccess = 'Profile updated successfully';
      setTimeout(() => (profileSuccess = null), 3000);
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
      await changeSingleUserGate(oldCode, newCode);
      codeSuccess = 'Code changed successfully';
      oldCodeDigits = ['', '', '', '', '', ''];
      newCodeDigits = ['', '', '', '', '', ''];
      confirmCodeDigits = ['', '', '', '', '', ''];
      setTimeout(() => (codeSuccess = null), 3000);
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

  /** Close the email confirmation modal without completing the change. */
  function dismissEmailModal() {
    showEmailConfirmationModal = false;
  }

  // =============================================================================
  //                     ADMINISTRATION HANDLERS
  // =============================================================================

  /** Toggle debug mode on/off — requires a page refresh to take full effect. */
  function toggleDebugMode() {
    debugMode = !debugMode;
    setDebugMode(debugMode);
  }

  /** Navigate back to the main tasks view. */
  function goBack() {
    goto('/tasks');
  }

  /**
   * Delete and recreate the local IndexedDB, then reload the page.
   * Session is preserved in localStorage so the app will re-hydrate.
   */
  async function handleResetDatabase() {
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

  /** Dispatch a custom event that the app shell listens for to sign out on mobile. */
  function handleMobileSignOut() {
    window.dispatchEvent(new CustomEvent('${opts.prefix}:signout'));
  }
</script>

<svelte:head>
  <title>Profile - ${opts.name}</title>
</svelte:head>

<!-- TODO: Add profile page template (forms, cards, device list, debug tools) -->
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
function generateUpdatePromptComponent() {
    return `<script lang="ts">
  /**
   * @fileoverview UpdatePrompt — service-worker update notification.
   *
   * Detects when a new service worker version is waiting to activate and
   * shows an "update available" prompt. Detection relies on six signals:
   *   1. \`statechange\` on the installing SW → catches updates during the visit
   *   2. \`updatefound\` on the registration → catches background installs
   *   3. \`visibilitychange\` → re-checks when the tab becomes visible
   *   4. \`online\` event → re-checks when connectivity is restored
   *   5. Periodic interval → fallback for iOS standalone mode
   *   6. Initial check on mount → catches SWs that installed before this component
   *
   * Uses \`monitorSwLifecycle()\` from stellar-engine to wire up all six, and
   * \`handleSwUpdate()\` to send SKIP_WAITING + reload on user confirmation.
   */

  // ==========================================================================
  //                                IMPORTS
  // ==========================================================================

  import { onMount, onDestroy } from 'svelte';
  import { monitorSwLifecycle, handleSwUpdate } from '@prabhask5/stellar-engine/kit';

  // ==========================================================================
  //                           COMPONENT STATE
  // ==========================================================================

  /** Whether the update prompt is visible */
  let showPrompt = $state(false);

  /** Guard flag to prevent double-reload */
  let reloading = false;

  /** Cleanup function returned by monitorSwLifecycle */
  let cleanup: (() => void) | null = null;

  // ==========================================================================
  //                      SERVICE WORKER MONITORING
  // ==========================================================================

  onMount(() => {
    cleanup = monitorSwLifecycle({
      onUpdateAvailable: () => {
        showPrompt = true;
      }
    });
  });

  onDestroy(() => {
    cleanup?.();
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

<!-- TODO: Add your update prompt UI here.
     Use showPrompt to conditionally render the toast/banner.
     Call handleRefresh() for the "Refresh" action.
     Call handleDismiss() for the "Later" / dismiss action.

     Example structure:
     {#if showPrompt}
       <div class="update-toast">
         <span>A new version is available</span>
         <button onclick={handleDismiss}>Later</button>
         <button onclick={handleRefresh}>Refresh</button>
       </div>
     {/if}
-->
`;
}
// ---------------------------------------------------------------------------
//                   TYPE RE-EXPORT GENERATOR
// ---------------------------------------------------------------------------
/**
 * Generate the app types barrel file that re-exports stellar-engine types
 * and provides a location for app-specific type definitions.
 *
 * @returns The TypeScript source for `src/lib/types.ts`.
 */
function generateAppTypes() {
    return `/**
 * @fileoverview Type barrel — re-exports from stellar-engine plus app-specific types.
 *
 * Conventions used by stellar-engine tables:
 *   - \`deleted\`    — soft-delete flag (boolean, default \`false\`)
 *   - \`_version\`   — optimistic concurrency counter (integer, starts at 1)
 *   - \`device_id\`  — originating device identifier for conflict resolution
 */
export type { SyncStatus, AuthMode, OfflineCredentials } from '@prabhask5/stellar-engine/types';

// TODO: Add app-specific type definitions below
`;
}
// =============================================================================
//                           COMMAND ROUTING
// =============================================================================
/**
 * Available CLI commands. Add new entries here to register additional commands.
 */
const COMMANDS = [
    {
        name: 'install pwa',
        usage: 'stellar-engine install pwa',
        description: 'Scaffold a complete offline-first SvelteKit PWA project'
    }
];
/**
 * Print the help screen listing all available commands.
 */
function printHelp() {
    console.log();
    console.log(doubleBoxWithHeader([`          ${bold('\u2726 stellar-engine CLI \u2726')}            `], ['Available commands:                              ']));
    console.log();
    for (const cmd of COMMANDS) {
        console.log(`  ${cyan(cmd.usage)}`);
        console.log(`  ${dim(cmd.description)}`);
        console.log();
    }
    console.log(`  Run a command to get started.\n`);
}
/**
 * Route CLI arguments to the appropriate command handler.
 * Prints help and exits if the command is not recognised.
 */
function routeCommand() {
    const args = process.argv.slice(2);
    const command = args.slice(0, 2).join(' ');
    if (command === 'install pwa') {
        main().catch((err) => {
            console.error('Error:', err);
            process.exit(1);
        });
        return;
    }
    /* Unrecognised command or no args — show help */
    printHelp();
    process.exit(args.length === 0 ? 0 : 1);
}
// =============================================================================
//                              MAIN FUNCTION
// =============================================================================
/**
 * Write a group of files quietly and return the count written.
 *
 * @param entries - Array of `[relativePath, content]` pairs.
 * @param cwd - The current working directory.
 * @param createdFiles - Accumulator for newly-created file paths.
 * @param skippedFiles - Accumulator for skipped file paths.
 * @returns The number of files in the group.
 */
function writeGroup(entries, cwd, createdFiles, skippedFiles) {
    for (const [rel, content] of entries) {
        writeIfMissing(join(cwd, rel), content, createdFiles, skippedFiles, true);
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
async function main() {
    const opts = await runInteractiveSetup();
    const cwd = process.cwd();
    const createdFiles = [];
    const skippedFiles = [];
    // 1. Write package.json
    let sp = createSpinner('Writing package.json');
    writeIfMissing(join(cwd, 'package.json'), generatePackageJson(opts), createdFiles, skippedFiles, true);
    sp.succeed('Writing package.json');
    // 2. Run npm install
    sp = createSpinner('Installing dependencies...');
    sp.stop();
    console.log(`  ${cyan(SPINNER_FRAMES[0])} Installing dependencies...\n`);
    execSync('npm install', { stdio: 'inherit', cwd });
    console.log(`\n  ${green('\u2713')} Installing dependencies`);
    // 3. Write all template files by category
    const firstLetter = opts.shortName.charAt(0).toUpperCase();
    /* ── Config files ── */
    const configFiles = [
        ['vite.config.ts', generateViteConfig(opts)],
        ['tsconfig.json', generateTsconfig()],
        ['svelte.config.js', generateSvelteConfig(opts)],
        ['eslint.config.js', generateEslintConfig()],
        ['.prettierrc', generatePrettierrc()],
        ['.prettierignore', generatePrettierignore()],
        ['knip.json', generateKnipJson()],
        ['.gitignore', generateGitignore()]
    ];
    sp = createSpinner('Config files');
    const configCount = writeGroup(configFiles, cwd, createdFiles, skippedFiles);
    sp.succeed(`Config files               ${dim(`${configCount} files`)}`);
    /* ── Documentation ── */
    const docFiles = [
        ['README.md', generateReadme(opts)],
        ['ARCHITECTURE.md', generateArchitecture(opts)],
        ['FRAMEWORKS.md', generateFrameworks()]
    ];
    sp = createSpinner('Documentation');
    const docCount = writeGroup(docFiles, cwd, createdFiles, skippedFiles);
    sp.succeed(`Documentation              ${dim(`${docCount} files`)}`);
    /* ── Static assets ── */
    const staticFiles = [
        ['static/manifest.json', generateManifest(opts)],
        ['static/offline.html', generateOfflineHtml(opts)],
        ['static/icons/app.svg', generatePlaceholderSvg('#6c5ce7', firstLetter)],
        ['static/icons/app-dark.svg', generatePlaceholderSvg('#1a1a2e', firstLetter)],
        ['static/icons/maskable.svg', generatePlaceholderSvg('#6c5ce7', firstLetter)],
        ['static/icons/favicon.svg', generatePlaceholderSvg('#6c5ce7', firstLetter)],
        ['static/icons/monochrome.svg', generateMonochromeSvg(firstLetter)],
        ['static/icons/splash.svg', generateSplashSvg(opts.shortName)],
        ['static/icons/apple-touch.svg', generatePlaceholderSvg('#6c5ce7', firstLetter)],
        ['static/change-email.html', generateEmailPlaceholder('Change Email')],
        ['static/device-verification-email.html', generateEmailPlaceholder('Device Verification')],
        ['static/signup-email.html', generateEmailPlaceholder('Signup Email')],
        ['supabase-schema.sql', generateSupabaseSchema(opts)]
    ];
    sp = createSpinner('Static assets');
    const staticCount = writeGroup(staticFiles, cwd, createdFiles, skippedFiles);
    sp.succeed(`Static assets             ${dim(`${staticCount} files`)}`);
    /* ── Source files ── */
    const sourceFiles = [
        ['src/app.html', generateAppHtml(opts)],
        ['src/app.d.ts', generateAppDts(opts)]
    ];
    sp = createSpinner('Source files');
    const sourceCount = writeGroup(sourceFiles, cwd, createdFiles, skippedFiles);
    sp.succeed(`Source files               ${dim(`${sourceCount} files`)}`);
    /* ── Route files ── */
    const routeFiles = [
        ['src/routes/+layout.ts', generateRootLayoutTs(opts)],
        ['src/routes/+layout.svelte', generateRootLayoutSvelte(opts)],
        ['src/routes/+page.svelte', generateHomePage(opts)],
        ['src/routes/+error.svelte', generateErrorPage(opts)],
        ['src/routes/setup/+page.ts', generateSetupPageTs()],
        ['src/routes/setup/+page.svelte', generateSetupPageSvelte(opts)],
        ['src/routes/policy/+page.svelte', generatePolicyPage(opts)],
        ['src/routes/login/+page.svelte', generateLoginPage(opts)],
        ['src/routes/confirm/+page.svelte', generateConfirmPage(opts)],
        ['src/routes/api/config/+server.ts', generateConfigServer()],
        ['src/routes/api/setup/deploy/+server.ts', generateDeployServer()],
        ['src/routes/api/setup/validate/+server.ts', generateValidateServer()],
        ['src/routes/[...catchall]/+page.ts', generateCatchallPage()],
        ['src/routes/(protected)/+layout.ts', generateProtectedLayoutTs()],
        ['src/routes/(protected)/+layout.svelte', generateProtectedLayoutSvelte()],
        ['src/routes/(protected)/profile/+page.svelte', generateProfilePage(opts)]
    ];
    sp = createSpinner('Route files');
    const routeCount = writeGroup(routeFiles, cwd, createdFiles, skippedFiles);
    sp.succeed(`Route files               ${dim(`${routeCount} files`)}`);
    /* ── Library & components ── */
    const libFiles = [
        ['src/lib/types.ts', generateAppTypes()],
        ['src/lib/components/UpdatePrompt.svelte', generateUpdatePromptComponent()]
    ];
    sp = createSpinner('Library & components');
    const libCount = writeGroup(libFiles, cwd, createdFiles, skippedFiles);
    sp.succeed(`Library & components       ${dim(`${libCount} files`)}`);
    // 4. Set up husky
    sp = createSpinner('Git hooks');
    execSync('npx husky init', { stdio: 'pipe', cwd });
    const preCommitPath = join(cwd, '.husky/pre-commit');
    writeFileSync(preCommitPath, generateHuskyPreCommit(), 'utf-8');
    createdFiles.push('.husky/pre-commit');
    sp.succeed(`Git hooks                  ${dim('1 file')}`);
    // 5. Print final summary
    console.log();
    console.log(doubleBoxWithHeader([`             ${green(bold('\u2713 Setup complete!'))}                  `], [
        `Created: ${bold(String(createdFiles.length))} files${' '.repeat(34 - String(createdFiles.length).length)}`,
        `Skipped: ${bold(String(skippedFiles.length))} files${' '.repeat(34 - String(skippedFiles.length).length)}`
    ]));
    console.log(`
  ${bold('Next steps:')}
    1. Set up Supabase and add .env with your keys
    2. Run supabase-schema.sql in Supabase SQL Editor
    3. Add app icons in static/icons/
    4. Start building: ${cyan('npm run dev')}
`);
}
// =============================================================================
//                                 RUN
// =============================================================================
routeCommand();
//# sourceMappingURL=install-pwa.js.map