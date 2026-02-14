#!/usr/bin/env node

/**
 * @fileoverview CLI script that scaffolds a PWA SvelteKit project using stellar-engine.
 *
 * Usage:
 *   stellar-engine install pwa --name "App Name" --short_name "Short" --prefix "myprefix" [--description "..."]
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// =============================================================================
//                                  TYPES
// =============================================================================

interface InstallOptions {
  name: string;
  shortName: string;
  prefix: string;
  description: string;
  kebabName: string;
}

// =============================================================================
//                                 HELPERS
// =============================================================================

/**
 * Writes a file only if it doesn't already exist. Returns whether the file was created.
 */
function writeIfMissing(
  filePath: string,
  content: string,
  createdFiles: string[],
  skippedFiles: string[]
): void {
  const relPath = filePath.replace(process.cwd() + '/', '');
  if (existsSync(filePath)) {
    skippedFiles.push(relPath);
    console.log(`  [skip] ${relPath} already exists`);
  } else {
    const dir = filePath.substring(0, filePath.lastIndexOf('/'));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, content, 'utf-8');
    createdFiles.push(relPath);
    console.log(`  [write] ${relPath}`);
  }
}

// =============================================================================
//                              ARG PARSING
// =============================================================================

function parseArgs(argv: string[]): InstallOptions {
  const args = argv.slice(2);

  if (args[0] !== 'install' || args[1] !== 'pwa') {
    console.error(
      'Usage: stellar-engine install pwa --name "App Name" --short_name "Short" --prefix "myprefix" [--description "..."]'
    );
    process.exit(1);
  }

  let name = '';
  let shortName = '';
  let prefix = '';
  let description = 'A self-hosted offline-first PWA';

  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case '--name':
        name = args[++i];
        break;
      case '--short_name':
        shortName = args[++i];
        break;
      case '--prefix':
        prefix = args[++i];
        break;
      case '--description':
        description = args[++i];
        break;
    }
  }

  if (!name || !shortName || !prefix) {
    console.error(
      'Error: --name, --short_name, and --prefix are required.\n' +
        'Usage: stellar-engine install pwa --name "App Name" --short_name "Short" --prefix "myprefix" [--description "..."]'
    );
    process.exit(1);
  }

  const kebabName = name.toLowerCase().replace(/\s+/g, '-');

  return { name, shortName, prefix, description, kebabName };
}

// =============================================================================
//                          TEMPLATE GENERATORS
// =============================================================================

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
          '@prabhask5/stellar-engine': '^1.1.6'
        },
        type: 'module'
      },
      null,
      2
    ) + '\n'
  );
}

function generateViteConfig(opts: InstallOptions): string {
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

import { sveltekit } from '@sveltejs/kit/vite';
import { stellarPWA } from '@prabhask5/stellar-engine/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit(),
    stellarPWA({ prefix: '${opts.prefix}', name: '${opts.name}' })
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            if (id.includes('@supabase')) return 'vendor-supabase';
            if (id.includes('dexie')) return 'vendor-dexie';
          }
        }
      }
    },
    chunkSizeWarningLimit: 500,
    minify: 'esbuild',
    target: 'es2020'
  }
});
`;
}

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
      },
      null,
      2
    ) + '\n'
  );
}

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

    <!-- Theme color matches \`--color-void\` for seamless safe-area blending -->
    <meta name="theme-color" content="#050510" />
    <meta
      name="description"
      content="${opts.name} - ${opts.description}"
    />
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
    <meta
      property="og:description"
      content="${opts.description}"
    />
    <meta property="og:image" content="%sveltekit.assets%/icon-512.png" />

    <!-- ================================================================= -->
    <!--                         TWITTER CARD                              -->
    <!-- ================================================================= -->

    <!-- "summary" card type → square image + title + description -->
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${opts.name}" />
    <meta
      name="twitter:description"
      content="${opts.description}"
    />

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
    <!-- TODO: Add landscape blocker UI. See stellar/src/app.html for a
         full implementation with space-themed animations. The #landscape-blocker
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

function generateReadme(opts: InstallOptions): string {
  return `# ${opts.name}

> See [ARCHITECTURE.md](./ARCHITECTURE.md) for project structure.
> See [FRAMEWORKS.md](./FRAMEWORKS.md) for framework decisions.

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

function generateArchitecture(opts: InstallOptions): string {
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

function generateFrameworks(): string {
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
static/sw.js
static/asset-manifest.json
`;
}

function generateOfflineHtml(opts: InstallOptions): string {
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

function generatePlaceholderSvg(color: string, label: string, fontSize: number = 64): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="${color}"/>
  <text x="256" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="${fontSize}" font-weight="700" fill="white">${label}</text>
</svg>
`;
}

function generateMonochromeSvg(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="#ffffff"/>
  <text x="256" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="64" font-weight="700" fill="black">${label}</text>
</svg>
`;
}

function generateSplashSvg(label: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="64" fill="#0f0f1a"/>
  <text x="256" y="280" text-anchor="middle" font-family="system-ui, sans-serif" font-size="48" font-weight="700" fill="white">${label}</text>
</svg>
`;
}

function generateEmailPlaceholder(title: string): string {
  return `<!-- TODO: ${title} email template -->
<!-- See stellar-engine EMAIL_TEMPLATES.md for the full template format -->
<!DOCTYPE html>
<html><head><title>${title}</title></head>
<body><p>TODO: Implement ${title} email template</p></body>
</html>
`;
}

function generateSupabaseSchema(opts: InstallOptions): string {
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

function generateKnipJson(): string {
  return (
    JSON.stringify(
      {
        $schema: 'https://unpkg.com/knip@latest/schema.json',
        entry: ['src/routes/**/*.{svelte,ts,js}', 'src/lib/**/*.{svelte,ts,js}'],
        project: ['src/**/*.{svelte,ts,js}'],
        ignore: ['src/app.d.ts', '**/*.test.ts', '**/*.spec.ts'],
        sveltekit: {
          config: 'svelte.config.js'
        }
      },
      null,
      2
    ) + '\n'
  );
}

function generateHuskyPreCommit(): string {
  return `npm run cleanup && npm run validate && git add -u
`;
}

function generateRootLayoutTs(opts: InstallOptions): string {
  return `import { browser } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { goto } from '$app/navigation';
import { initEngine, startSyncEngine, supabase } from '@prabhask5/stellar-engine';
import { initConfig } from '@prabhask5/stellar-engine/config';
import { resolveAuthState, lockSingleUser } from '@prabhask5/stellar-engine/auth';
import { resolveRootLayout } from '@prabhask5/stellar-engine/kit';
import type { AuthMode, OfflineCredentials, Session } from '@prabhask5/stellar-engine/types';
import type { LayoutLoad } from './$types';

export const ssr = true;
export const prerender = false;

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
//     auth: { mode: 'single-user', singleUser: { gateType: 'code', codeLength: 6 } },
//     onAuthStateChange: (event, session) => { /* handle auth events */ },
//     onAuthKicked: async () => { await lockSingleUser(); goto('/login'); }
//   });
// }

export interface LayoutData {
  session: Session | null;
  authMode: AuthMode;
  offlineProfile: OfflineCredentials | null;
  singleUserSetUp?: boolean;
}

export const load: LayoutLoad = async ({ url }): Promise<LayoutData> => {
  if (browser) {
    const config = await initConfig();
    if (!config && url.pathname !== '/setup') {
      redirect(307, '/setup');
    }
    if (!config) {
      return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
    }
    const result = await resolveAuthState();
    if (result.authMode !== 'none') {
      await startSyncEngine();
    }
    return result;
  }
  return { session: null, authMode: 'none', offlineProfile: null, singleUserSetUp: false };
};
`;
}

function generateRootLayoutSvelte(): string {
  return `<script lang="ts">
  import { hydrateAuthState } from '@prabhask5/stellar-engine/kit';
  import { authState } from '@prabhask5/stellar-engine/stores';
  import type { LayoutData } from './+layout';

  interface Props {
    children?: import('svelte').Snippet;
    data: LayoutData;
  }

  let { children, data }: Props = $props();

  $effect(() => {
    hydrateAuthState(data);
  });

  // TODO: Add app shell (navbar, tab bar, overlays, sign-out logic, etc.)
  // TODO: Import and use UpdatePrompt from '$lib/components/UpdatePrompt.svelte'
  // TODO: Import and use SyncStatus from '@prabhask5/stellar-engine/components/SyncStatus'
</script>

<!-- TODO: Add your app shell template (navbar, tab bar, page transitions, etc.) -->
{@render children?.()}
`;
}

function generateHomePage(): string {
  return `<script lang="ts">
  import { getUserProfile } from '@prabhask5/stellar-engine/auth';
  import { onSyncComplete, authState } from '@prabhask5/stellar-engine/stores';

  // TODO: Add home page state and logic
</script>

<!-- TODO: Add home page template -->
`;
}

function generateErrorPage(): string {
  return `<script lang="ts">
  import { page } from '$app/stores';

  // TODO: Add error page logic (offline detection, retry handlers, etc.)
</script>

<!-- TODO: Add error page template (status code display, retry button, go home button) -->
`;
}

function generateSetupPageTs(): string {
  return `import { browser } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { getConfig } from '@prabhask5/stellar-engine/config';
import { getValidSession, isAdmin } from '@prabhask5/stellar-engine/auth';
import type { PageLoad } from './$types';

export const load: PageLoad = async () => {
  if (!browser) return {};
  if (!getConfig()) {
    return { isFirstSetup: true };
  }
  const session = await getValidSession();
  if (!session?.user) {
    redirect(307, '/login');
  }
  if (!isAdmin(session.user)) {
    redirect(307, '/');
  }
  return { isFirstSetup: false };
};
`;
}

function generateSetupPageSvelte(): string {
  return `<script lang="ts">
  import { setConfig } from '@prabhask5/stellar-engine/config';
  import { isOnline } from '@prabhask5/stellar-engine/stores';
  import { pollForNewServiceWorker } from '@prabhask5/stellar-engine/kit';

  // TODO: Add setup wizard state (steps, form fields, validation, deployment)
</script>

<!-- TODO: Add setup wizard template (Supabase credentials form, validation, Vercel deployment) -->
`;
}

function generatePolicyPage(): string {
  return `<script lang="ts">
  // TODO: Add any needed imports
</script>

<!-- TODO: Add privacy policy page content -->
`;
}

function generateLoginPage(): string {
  return `<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
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

  // TODO: Add login page state (setup/unlock/link-device modes, PIN inputs, modals)
  // TODO: Add BroadcastChannel listener for auth-confirmed events from /confirm
</script>

<!-- TODO: Add login page template (PIN inputs, setup wizard, device verification modal) -->
`;
}

function generateConfirmPage(): string {
  return `<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { handleEmailConfirmation, broadcastAuthConfirmed } from '@prabhask5/stellar-engine/kit';

  let status: 'verifying' | 'success' | 'error' | 'redirecting' | 'can_close' = 'verifying';
  let errorMessage = '';

  const CHANNEL_NAME = 'auth-channel'; // TODO: Customize channel name

  onMount(async () => {
    const tokenHash = $page.url.searchParams.get('token_hash');
    const type = $page.url.searchParams.get('type');

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
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    const tabResult = await broadcastAuthConfirmed(CHANNEL_NAME, type || 'signup');
    if (tabResult === 'can_close') {
      status = 'can_close';
    } else if (tabResult === 'no_broadcast') {
      goto('/', { replaceState: true });
    }
  });
</script>

<!-- TODO: Add confirmation page template (verifying/success/error/can_close states) -->
`;
}

function generateConfigServer(): string {
  return `import { json } from '@sveltejs/kit';
import { getServerConfig } from '@prabhask5/stellar-engine/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
  return json(getServerConfig());
};
`;
}

function generateDeployServer(): string {
  return `import { json } from '@sveltejs/kit';
import { deployToVercel } from '@prabhask5/stellar-engine/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  const { supabaseUrl, supabaseAnonKey, vercelToken } = await request.json();

  if (!supabaseUrl || !supabaseAnonKey || !vercelToken) {
    return json(
      { success: false, error: 'Supabase URL, Anon Key, and Vercel Token are required' },
      { status: 400 }
    );
  }

  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!projectId) {
    return json(
      { success: false, error: 'VERCEL_PROJECT_ID not found. This endpoint only works on Vercel.' },
      { status: 400 }
    );
  }

  const result = await deployToVercel({ vercelToken, projectId, supabaseUrl, supabaseAnonKey });
  return json(result);
};
`;
}

function generateValidateServer(): string {
  return `import { createValidateHandler } from '@prabhask5/stellar-engine/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = createValidateHandler();
`;
}

function generateCatchallPage(): string {
  return `import { redirect } from '@sveltejs/kit';

export function load() {
  redirect(302, '/');
}
`;
}

function generateProtectedLayoutTs(): string {
  return `import { redirect } from '@sveltejs/kit';
import { browser } from '$app/environment';
import { resolveAuthState } from '@prabhask5/stellar-engine/auth';
import type { AuthMode, OfflineCredentials, Session } from '@prabhask5/stellar-engine/types';
import type { LayoutLoad } from './$types';

export interface ProtectedLayoutData {
  session: Session | null;
  authMode: AuthMode;
  offlineProfile: OfflineCredentials | null;
}

export const load: LayoutLoad = async ({ url }): Promise<ProtectedLayoutData> => {
  if (browser) {
    const result = await resolveAuthState();
    if (result.authMode === 'none') {
      const returnUrl = url.pathname + url.search;
      const loginUrl =
        returnUrl && returnUrl !== '/'
          ? \`/login?redirect=\${encodeURIComponent(returnUrl)}\`
          : '/login';
      throw redirect(302, loginUrl);
    }
    return result;
  }
  return { session: null, authMode: 'none', offlineProfile: null };
};
`;
}

function generateProtectedLayoutSvelte(): string {
  return `<script lang="ts">
  interface Props {
    children?: import('svelte').Snippet;
  }

  let { children }: Props = $props();

  // TODO: Add conditional page backgrounds or other protected-area chrome
</script>

{@render children?.()}
`;
}

function generateProfilePage(): string {
  return `<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    changeSingleUserGate,
    updateSingleUserProfile,
    getSingleUserInfo,
    changeSingleUserEmail,
    completeSingleUserEmailChange
  } from '@prabhask5/stellar-engine/auth';
  import { authState } from '@prabhask5/stellar-engine/stores';
  import { isDebugMode, setDebugMode } from '@prabhask5/stellar-engine/utils';
  import {
    resetDatabase,
    getTrustedDevices,
    removeTrustedDevice,
    getCurrentDeviceId
  } from '@prabhask5/stellar-engine';

  // TODO: Add profile page state (form fields, device management, debug tools)
</script>

<!-- TODO: Add profile page template (forms, cards, device list, debug tools) -->
`;
}

function generateUpdatePromptComponent(): string {
  return `<script lang="ts">
  /**
   * @fileoverview UpdatePrompt — service-worker update notification.
   *
   * Uses monitorSwLifecycle() from stellar-engine to detect when a new
   * version is waiting to activate, and handleSwUpdate() to apply it.
   */

  import { onMount, onDestroy } from 'svelte';
  import { monitorSwLifecycle, handleSwUpdate } from '@prabhask5/stellar-engine/kit';

  /** Whether the update prompt is visible */
  let showPrompt = $state(false);

  /** Guard flag to prevent double-reload */
  let reloading = false;

  let cleanup: (() => void) | null = null;

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

function generateAppTypes(): string {
  return `// App types barrel — re-exports from stellar-engine plus app-specific types
export type { SyncStatus, AuthMode, OfflineCredentials } from '@prabhask5/stellar-engine/types';

// TODO: Add app-specific type definitions below
`;
}

// =============================================================================
//                              MAIN FUNCTION
// =============================================================================

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const cwd = process.cwd();

  console.log(`\n\u2728 stellar-engine install pwa\n   Creating ${opts.name}...\n`);

  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  // 1. Write package.json
  writeIfMissing(join(cwd, 'package.json'), generatePackageJson(opts), createdFiles, skippedFiles);

  // 2. Run npm install
  console.log('Installing dependencies...');
  execSync('npm install', { stdio: 'inherit', cwd });

  // 3. Write all template files
  const firstLetter = opts.shortName.charAt(0).toUpperCase();

  const files: [string, string][] = [
    // Config files
    ['vite.config.ts', generateViteConfig(opts)],
    ['tsconfig.json', generateTsconfig()],
    ['svelte.config.js', generateSvelteConfig(opts)],
    ['eslint.config.js', generateEslintConfig()],
    ['.prettierrc', generatePrettierrc()],
    ['.prettierignore', generatePrettierignore()],
    ['knip.json', generateKnipJson()],
    ['.gitignore', generateGitignore()],

    // Documentation
    ['README.md', generateReadme(opts)],
    ['ARCHITECTURE.md', generateArchitecture(opts)],
    ['FRAMEWORKS.md', generateFrameworks()],

    // Static assets
    ['static/manifest.json', generateManifest(opts)],
    ['static/offline.html', generateOfflineHtml(opts)],
    // Placeholder icons
    ['static/icons/app.svg', generatePlaceholderSvg('#6c5ce7', firstLetter)],
    ['static/icons/app-dark.svg', generatePlaceholderSvg('#1a1a2e', firstLetter)],
    ['static/icons/maskable.svg', generatePlaceholderSvg('#6c5ce7', firstLetter)],
    ['static/icons/favicon.svg', generatePlaceholderSvg('#6c5ce7', firstLetter)],
    ['static/icons/monochrome.svg', generateMonochromeSvg(firstLetter)],
    ['static/icons/splash.svg', generateSplashSvg(opts.shortName)],
    ['static/icons/apple-touch.svg', generatePlaceholderSvg('#6c5ce7', firstLetter)],

    // Email placeholders
    ['static/change-email.html', generateEmailPlaceholder('Change Email')],
    ['static/device-verification-email.html', generateEmailPlaceholder('Device Verification')],
    ['static/signup-email.html', generateEmailPlaceholder('Signup Email')],

    // Supabase schema
    ['supabase-schema.sql', generateSupabaseSchema(opts)],

    // Source files
    ['src/app.html', generateAppHtml(opts)],
    ['src/app.d.ts', generateAppDts(opts)],

    // Route files
    ['src/routes/+layout.ts', generateRootLayoutTs(opts)],
    ['src/routes/+layout.svelte', generateRootLayoutSvelte()],
    ['src/routes/+page.svelte', generateHomePage()],
    ['src/routes/+error.svelte', generateErrorPage()],
    ['src/routes/setup/+page.ts', generateSetupPageTs()],
    ['src/routes/setup/+page.svelte', generateSetupPageSvelte()],
    ['src/routes/policy/+page.svelte', generatePolicyPage()],
    ['src/routes/login/+page.svelte', generateLoginPage()],
    ['src/routes/confirm/+page.svelte', generateConfirmPage()],
    ['src/routes/api/config/+server.ts', generateConfigServer()],
    ['src/routes/api/setup/deploy/+server.ts', generateDeployServer()],
    ['src/routes/api/setup/validate/+server.ts', generateValidateServer()],
    ['src/routes/[...catchall]/+page.ts', generateCatchallPage()],
    ['src/routes/(protected)/+layout.ts', generateProtectedLayoutTs()],
    ['src/routes/(protected)/+layout.svelte', generateProtectedLayoutSvelte()],
    ['src/routes/(protected)/profile/+page.svelte', generateProfilePage()],
    ['src/lib/types.ts', generateAppTypes()],

    // Component files
    ['src/lib/components/UpdatePrompt.svelte', generateUpdatePromptComponent()]
  ];

  for (const [relativePath, content] of files) {
    writeIfMissing(join(cwd, relativePath), content, createdFiles, skippedFiles);
  }

  // 4. Set up husky
  console.log('Setting up husky...');
  execSync('npx husky init', { stdio: 'inherit', cwd });
  // Overwrite the default pre-commit (husky init creates one with "npm test")
  const preCommitPath = join(cwd, '.husky/pre-commit');
  writeFileSync(preCommitPath, generateHuskyPreCommit(), 'utf-8');
  createdFiles.push('.husky/pre-commit');
  console.log('  [write] .husky/pre-commit');

  // 5. Print summary
  console.log(`\n\u2705 Done! Created ${createdFiles.length} files.`);
  if (skippedFiles.length > 0) {
    console.log(`   Skipped ${skippedFiles.length} existing files.`);
  }
  console.log(`
Next steps:
  1. Set up Supabase and add .env with PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY and PUBLIC_SUPABASE_URL
  2. Run supabase-schema.sql in the Supabase SQL Editor
  3. Add your app icons: static/favicon.png, static/icon-192.png, static/icon-512.png
  4. Start building: npm run dev`);
}

// =============================================================================
//                                 RUN
// =============================================================================

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
