# stellar-drive

[![npm version](https://img.shields.io/npm/v/stellar-drive.svg?style=flat)](https://www.npmjs.com/package/stellar-drive) [![Made with Supabase](https://supabase.com/badge-made-with-supabase-dark.svg)](https://supabase.com)

**stellar-drive** is an offline-first sync engine for applications built on [Supabase](https://supabase.com) and [Dexie.js](https://dexie.org) (IndexedDB). It solves the hard problems of local-first architecture: all reads come from IndexedDB for instant response, all writes land locally first and queue for background sync, and a conflict resolution system handles concurrent edits across devices. Your app stays fast and fully functional whether the user is online, offline, or on a flaky connection.

The core engine is framework-agnostic (vanilla JS/TS), with optional integrations for **SvelteKit** and **Svelte 5**.

---

## Documentation

| Document | What it covers |
|----------|---------------|
| [API Reference](./API_REFERENCE.md) | Full signatures, parameters, and usage examples for every public export |
| [Architecture](./ARCHITECTURE.md) | Internal design, data flow, and module responsibilities |
| [Frameworks](./FRAMEWORKS.md) | Background on the frameworks used in stellar-drive |

---

## Why stellar-drive?

Building offline-first sync is notoriously difficult. stellar-drive handles the complexity so you can focus on your product:

- **Instant UI** -- Reads always come from local IndexedDB, so your app never waits on a network roundtrip.
- **Resilient writes** -- Writes land in IndexedDB immediately and sync in the background. If the user goes offline mid-session, nothing is lost.
- **Smart conflict resolution** -- Instead of "last write wins" for everything, the engine uses a three-tier approach: field-level auto-merge, different-field merge, and same-field resolution with configurable strategies. Numeric fields like counters can merge additively across devices.
- **Minimal boilerplate** -- Declare your schema once. The engine auto-generates IndexedDB stores, database versioning, TypeScript interfaces, and Supabase SQL.
- **Bandwidth-efficient** -- 50 rapid writes are coalesced into 1 outbound operation. Column-level selects and cursor-based pulls keep egress low.

---

## Features

- **Schema-driven configuration** -- Declare tables once in a simple object; the engine auto-generates Dexie stores, database versioning, TypeScript interfaces, and Supabase SQL. No manual migration files.
- **Intent-based sync operations** -- Operations preserve intent (`increment`, `set`, `create`, `delete`) instead of final state. This enables smarter coalescing and prevents conflicts where two users both increment the same counter.
- **6-step operation coalescing** -- 50 rapid writes compress into 1 outbound operation, dramatically reducing sync traffic and Supabase API calls.
- **Three-tier conflict resolution** -- Field-level auto-merge for non-overlapping changes, different-field merge, and same-field resolution (`local_pending` > `delete_wins` > `last_write_wins` with device ID tiebreaker). No data silently lost.
- **Offline authentication** -- SHA-256 credential caching and offline session tokens let users sign in and work without connectivity. Sessions reconcile automatically on reconnect.
- **Single-user PIN/password auth** -- Simplified gate backed by real Supabase email/password auth. PIN is padded to meet minimum length and verified server-side.
- **Device verification** -- Email OTP for untrusted devices with configurable trust duration. Prevents unauthorized access from unknown machines.
- **Realtime subscriptions** -- Supabase Realtime WebSocket push with echo suppression and deduplication against polling. Changes appear instantly across tabs and devices.
- **Tombstone management** -- Soft deletes with configurable garbage collection. Deleted records sync correctly before being permanently purged.
- **Egress optimization** -- Column-level selects, operation coalescing, push-only mode when realtime is healthy, and cursor-based pulls minimize bandwidth.
- **Demo mode** -- Sandboxed database, zero Supabase connections, mock auth. Ship instant onboarding experiences without backend setup.
- **Reactive stores** -- Svelte-compatible stores for sync status, auth state, network state, and remote changes. Works with Svelte 5 runes.
- **Store factories** -- `createCollectionStore` and `createDetailStore` for boilerplate-free reactive data layers with auto-refresh on sync.
- **Svelte actions** -- `remoteChangeAnimation`, `trackEditing`, `triggerLocalAnimation` for declarative UI behavior tied to sync events.
- **SQL generation** -- Auto-generate `CREATE TABLE` statements, RLS policies, and migrations from your schema config.
- **TypeScript generation** -- Auto-generate interfaces from schema field definitions.
- **Migration generation** -- Auto-generate `ALTER TABLE` rename and column rename SQL from `renamedFrom` / `renamedColumns` hints.
- **Diagnostics** -- Comprehensive runtime diagnostics covering sync, queue, realtime, conflicts, egress, and network state.
- **Debug utilities** -- Opt-in debug logging and `window` debug utilities for browser console inspection during development.
- **SvelteKit integration** (optional) -- Layout helpers, server handlers, email confirmation, service worker lifecycle, and auth hydration.
- **PWA scaffolding CLI** -- `stellar-drive install pwa` generates a fully wired SvelteKit PWA skeleton (51 files) with auth, PIN gate, device verification, profile page, demo mode, adaptive navbar, and PWA plumbing pre-connected.

### Use cases

- Productivity and task management apps
- Notion-like block editors
- Personal finance trackers (numeric merge across devices)
- File and asset management UIs (fractional ordering for drag-and-drop)
- Habit trackers and daily planners
- Knowledge bases and note-taking apps
- Any app needing offline-first multi-device sync

---

## Quick start

### Installation

```bash
npm install stellar-drive
```

### 1. Initialize the engine

Call once at app startup (e.g., root layout or main entry point). The schema-driven approach lets you declare tables once -- the engine handles IndexedDB setup, database versioning, and Supabase table mapping.

```ts
import { initEngine, startSyncEngine, getDb, resetDatabase } from 'stellar-drive';
import { initConfig } from 'stellar-drive/config';
import { resolveAuthState } from 'stellar-drive/auth';

initEngine({
  prefix: 'myapp', // Prefixes Supabase table names (e.g., goals -> myapp_goals)
  name: 'My App',  // Human-readable name for email templates
  domain: window.location.origin, // Production domain for email confirmation links

  // Schema-driven: declare tables once, engine handles the rest.
  // System indexes (id, user_id, created_at, updated_at, deleted, _version)
  // are auto-appended to every table. Database name auto-derived as `${prefix}DB`.
  schema: {
    projects: 'order',                              // String shorthand = indexes only
    tasks: 'project_id, order',                     // Comma-separated Dexie indexes
    focus_settings: { singleton: true },             // Object form for full control
    goals: {
      indexes: 'goal_list_id, order',
      numericMergeFields: ['current_value'],         // Additive merge on conflicts
      excludeFromConflict: ['device_id'],            // Skip these in conflict diffing
    },
  },

  // Auth: flat format with sensible defaults (all fields optional).
  auth: {
    gateType: 'code',                               // 'code' | 'password' (default: 'code')
    codeLength: 6,                                   // 4 | 6 (default: 6)
    emailConfirmation: true,                         // default: true
    deviceVerification: true,                        // default: true
    profileExtractor: (meta) => ({ firstName: meta.first_name }),
    profileToMetadata: (p) => ({ first_name: p.firstName }),
  },

  // Optional demo mode
  demo: {
    seedData: async (db) => {
      await db.table('projects').bulkPut([
        { id: 'demo-1', name: 'Sample Project', order: 1 },
      ]);
    },
    mockProfile: { email: 'demo@test.com', firstName: 'Demo', lastName: 'User' },
  },

  // Tuning (all optional with defaults)
  syncDebounceMs: 2000,        // Default: 2000
  syncIntervalMs: 900000,      // Default: 900000 (15 min)
  tombstoneMaxAgeDays: 7,      // Default: 7
});
```

### 2. Resolve auth and start the engine

The engine fetches runtime config (Supabase URL + publishable key) from your `/api/config` endpoint -- no need to pass a Supabase client directly.

```ts
await initConfig();
const auth = await resolveAuthState();

if (auth.authMode === 'none') {
  // Not authenticated -- show login/setup screen
  // -> call setupSingleUser(code, profile, email) for first-time setup
  // -> call unlockSingleUser(code) for returning users
} else {
  // Authenticated -- start syncing
  await startSyncEngine();
}
```

### 3. CRUD operations

```ts
import {
  engineCreate,
  engineUpdate,
  engineDelete,
  engineIncrement,
  engineBatchWrite,
  queryAll,
  queryOne,
  engineGetOrCreate,
} from 'stellar-drive/data';
import { generateId, now } from 'stellar-drive/utils';

// Create
const projectId = generateId();
await engineCreate('projects', {
  id: projectId,
  name: 'New Project',
  order: 1,
  created_at: now(),
  updated_at: now(),
  deleted: false,
  user_id: 'current-user-id',
});

// Update (only changed fields are synced)
await engineUpdate('tasks', taskId, {
  title: 'Updated title',
  updated_at: now(),
});

// Delete (soft delete -- tombstone managed by engine)
await engineDelete('tasks', taskId);

// Increment (intent-preserved -- concurrent increments merge correctly)
await engineIncrement('goals', goalId, 'current_value', 1);

// Query all rows from local IndexedDB
const projects = await queryAll('projects');

// Query a single row
const project = await queryOne('projects', projectId);

// Get or create (lookup by indexed field, create with defaults if missing)
const settings = await engineGetOrCreate(
  'focus_settings',  // table
  'user_id',         // index to query by
  currentUserId,     // value to match
  {                  // defaults if creating
    theme: 'dark',
    notifications: true,
    focus_duration: 25,
  },
  { checkRemote: true }  // optional: also check Supabase before creating
);

// Batch writes (multiple operations in one atomic transaction)
await engineBatchWrite([
  { type: 'create', table: 'tasks', data: { id: generateId(), title: 'Task 1', project_id: projectId, order: 1, created_at: now(), updated_at: now(), deleted: false, user_id: 'uid' } },
  { type: 'create', table: 'tasks', data: { id: generateId(), title: 'Task 2', project_id: projectId, order: 2, created_at: now(), updated_at: now(), deleted: false, user_id: 'uid' } },
  { type: 'update', table: 'projects', id: projectId, fields: { updated_at: now() } },
]);
```

### 4. Reactive store factories

```ts
import { createCollectionStore, createDetailStore, queryAll, queryOne } from 'stellar-drive';

// Collection store -- live-updating list from IndexedDB with auto-refresh on sync
const tasksStore = createCollectionStore<Task>({
  load: () => queryAll<Task>('tasks'),
});
// Usage: await tasksStore.load(); then subscribe for reactive updates.

// Detail store -- single record by ID with auto-refresh on sync
const taskDetailStore = createDetailStore<Task>({
  load: (id) => queryOne<Task>('tasks', id),
});
// Usage: await taskDetailStore.load('task-123');
```

### 5. Reactive stores

```ts
import {
  syncStatusStore,
  authState,
  isOnline,
  remoteChangesStore,
  onSyncComplete,
} from 'stellar-drive/stores';

// $syncStatusStore -- current SyncStatus, last sync time, errors
// $authState       -- { mode, session, offlineProfile, isLoading, authKickedMessage }
// $isOnline        -- reactive boolean reflecting network state
// remoteChangesStore -- tracks entities recently changed by remote peers

// Listen for sync completions
onSyncComplete(() => {
  console.log('Sync cycle finished');
});
```

### 6. Svelte actions

```ts
import { remoteChangeAnimation, trackEditing } from 'stellar-drive/actions';

// use:remoteChangeAnimation={{ table: 'tasks', id: task.id }}
// Animates elements when remote changes arrive for that entity.

// use:trackEditing={{ table: 'tasks', id: task.id }}
// Signals the engine a field is being actively edited (suppresses incoming overwrites).
```

### 7. Demo mode

```ts
import { setDemoMode, isDemoMode } from 'stellar-drive';

// Check if demo mode is active
if (isDemoMode()) {
  // In demo mode:
  // - Uses '${prefix}DB_demo' IndexedDB (real DB never opened)
  // - Zero Supabase network requests
  // - authMode === 'demo', protected routes work with mock data
  // - seedData callback runs on each page load
}

// Toggle demo mode from your UI (requires full page reload)
setDemoMode(true);
window.location.href = '/';
```

### 8. SQL and TypeScript generation

```ts
import { generateSupabaseSQL, generateTypeScript } from 'stellar-drive/utils';
import { getEngineConfig } from 'stellar-drive';

const config = getEngineConfig();

// Auto-generate Supabase SQL (CREATE TABLE + RLS policies) from schema
const sql = generateSupabaseSQL(config.schema!, { prefix: config.prefix });

// Auto-generate TypeScript interfaces from schema
const ts = generateTypeScript(config.schema!);
```

### 9. Diagnostics and debug

```ts
import { setDebugMode, isDebugMode } from 'stellar-drive/utils';
import { getDiagnostics } from 'stellar-drive';

setDebugMode(true);

// Comprehensive runtime diagnostics
const diagnostics = await getDiagnostics();
// diagnostics.sync     -- sync cycle statistics and recent cycle details
// diagnostics.queue    -- pending operation queue state
// diagnostics.realtime -- realtime connection state and health
// diagnostics.conflict -- conflict resolution history and stats
// diagnostics.egress   -- data transfer from Supabase (bytes, per-table breakdown)
// diagnostics.network  -- network state and connectivity info

// When debug mode is enabled, utilities are exposed on `window`:
// window.__myappSyncStats(), window.__myappEgress(), window.__myappTombstones()
// window.__myappSync.forceFullSync()
```

---

## Environment variables

| Variable | When needed | Description |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | Always | Your Supabase project URL. Find it at: Dashboard > Settings > API > Project URL. |
| `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Always | Your Supabase publishable (anon) key. Find it at: Dashboard > Settings > API > Project API keys > publishable. |
| `DATABASE_URL` | Only for auto-migration | Postgres connection string for the Vite plugin to push schema migrations directly to Postgres. If not set, migrations are skipped (types are still generated). Find it at: Dashboard > Settings > Database > Connection string (URI). |

---

## Schema workflow

The schema-driven workflow lets you declare your database schema once in `src/lib/schema.ts` and have three systems stay in sync automatically:

1. **TypeScript interfaces** -- auto-generated at `src/lib/types.generated.ts`
2. **Supabase DDL** -- auto-migrated via direct Postgres connection
3. **IndexedDB/Dexie** -- auto-versioned at runtime by `initEngine()`

### How it works

Enable schema auto-generation by passing `schema: true` to the `stellarPWA` Vite plugin:

```ts
// vite.config.ts
import { stellarPWA } from 'stellar-drive/vite';

export default defineConfig({
  plugins: [
    sveltekit(),
    stellarPWA({ prefix: 'myapp', name: 'My App', schema: true }),
  ],
});
```

In **dev mode**, the plugin watches `src/lib/schema.ts` and reprocesses on save (500ms debounce). In **build mode**, schema is processed once during `buildStart`.

**Each processing cycle:**

1. Generates TypeScript interfaces from schema field definitions
2. Loads the previous schema snapshot from `.stellar/schema-snapshot.json`
3. Diffs old vs new schema to produce `ALTER TABLE` migration SQL
4. Pushes migration SQL to Supabase via direct Postgres connection (requires `DATABASE_URL`)
5. Saves the updated snapshot (only on success -- failed migrations are retried on the next build)

On first run (no snapshot), the plugin generates idempotent initial SQL (`CREATE TABLE IF NOT EXISTS`) with RLS policies, triggers, and indexes. This works on both fresh databases and databases with existing tables -- no manual SQL is ever needed.

If `DATABASE_URL` is not set, types are still generated but migration push is skipped with a warning.

### Deploying to Vercel (or any CI/CD)

The schema migration runs automatically during every `vite build`. To enable it in CI/CD:

**Step 1: Set environment variables** in your Vercel project settings (Settings > Environment Variables):

| Variable | Type | Required |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | Plain | Yes -- client auth + data access |
| `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Plain | Yes -- client auth + data access |
| `DATABASE_URL` | Secret | Yes -- auto-migration during build |

**Step 2: Commit `.stellar/schema-snapshot.json`** to git. This file tracks the last-known schema state. Without it, every build is treated as a first run (full idempotent SQL). The snapshot is updated locally when you run `dev` or `build` and should be committed alongside schema changes.

**Step 3: Install the `postgres` npm package** -- `npm install postgres`. This is the Postgres client used by the Vite plugin for direct SQL execution.

**How it works on each deploy:**
- The Vite plugin's `buildStart` hook loads your schema, diffs against the committed snapshot, and pushes only the changes (ALTER TABLE statements) directly to Postgres.
- If the migration fails, the snapshot is **not updated**, so the next build retries the same migration.
- IndexedDB migrations happen client-side at runtime (no build step needed).

**Security:** `DATABASE_URL` is only used server-side during the Vite build process. It is never bundled into client code or exposed to users. `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` are served at runtime from your `/api/config` endpoint -- these are public keys by design, protected by Supabase Row Level Security.

See [API Reference -- Vite Plugin](./API_REFERENCE.md#vite-plugin-stellarpwa) for full configuration options.

---

## Commands

### Install PWA

Scaffold a complete offline-first SvelteKit PWA skeleton with an interactive walkthrough:

```bash
npx stellar-drive install pwa
```

Run this in an empty directory. The wizard collects four inputs, installs dependencies, and writes 51 files — a fully wired skeleton that passes `npm run validate` and `npm run cleanup` out of the box.

#### Wizard prompts

| Prompt | Required | Description |
|--------|----------|-------------|
| App Name | Yes | Full app name (e.g., "Stellar Planner"). Used in page titles, manifest, and email templates. |
| Short Name | Yes | Condensed name for the PWA home-screen icon (12 chars max). |
| Prefix | Yes | Lowercase key used for localStorage, caches, the service worker scope, and Supabase table prefixes. Auto-suggested from the app name. |
| Description | No | One-line description shown in the manifest (default: `"A self-hosted offline-first PWA"`). |

#### What gets generated — 51 files

**Project config (10)**

| File | Purpose |
|------|---------|
| `package.json` | All deps and scripts pre-configured: `dev`, `build`, `validate`, `cleanup` |
| `vite.config.ts` | `stellarPWA` plugin wired with your prefix; schema generation enabled |
| `tsconfig.json` | Extends SvelteKit's generated config with strict mode |
| `svelte.config.js` | `adapter-auto` + `vitePreprocess` |
| `eslint.config.js` | TypeScript-aware ESLint with Svelte plugin |
| `.prettierrc` | Consistent formatting rules |
| `.prettierignore` | Ignores build artifacts and generated files |
| `knip.json` | Dead-code detection configured for SvelteKit |
| `.gitignore` | Node, SvelteKit, and environment file ignores |
| `.env.example` | Template for `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` |

**Documentation (3)**

| File | Purpose |
|------|---------|
| `README.md` | Project-level readme linking architecture and framework docs |
| `ARCHITECTURE.md` | Directory layout, data flow, and module responsibilities |
| `FRAMEWORKS.md` | Technology choices, rationale, and Svelte 5 rune patterns |

**Git hooks (1)**

| File | Purpose |
|------|---------|
| `.husky/pre-commit` | Runs `npm run cleanup && npm run validate && git add -u` before every commit |

**Static assets (12)**

| File | Purpose |
|------|---------|
| `static/manifest.json` | PWA manifest with all icon sizes and display settings |
| `static/offline.html` | Offline fallback shown by the service worker |
| `static/icons/app.svg` | Green primary app icon (letter placeholder) |
| `static/icons/app-dark.svg` | Dark variant for light-mode context |
| `static/icons/maskable.svg` | Maskable icon for Android home screens |
| `static/icons/favicon.svg` | Browser tab favicon |
| `static/icons/monochrome.svg` | Monochrome icon for notification badges |
| `static/icons/splash.svg` | Splash screen icon |
| `static/icons/apple-touch.svg` | iOS Add-to-Home-Screen icon |
| `static/signup-email.html` | Signup confirmation email template |
| `static/change-email.html` | Email change confirmation template |
| `static/device-verification-email.html` | Device trust OTP email template |

**App core (2)**

| File | Purpose |
|------|---------|
| `src/app.html` | PWA shell: iOS meta tags, theme color, service-worker registration script |
| `src/app.d.ts` | SvelteKit ambient types (`App.Locals`, `App.PageData`) |

**Routes (16)**

| Route | File(s) | What it does |
|-------|---------|-------------|
| Root layout | `+layout.ts`, `+layout.svelte` | Engine bootstrap, auth resolution, adaptive navbar (top on desktop / bottom on mobile), sync status, offline toast, demo banner, PWA update prompt |
| Home | `+page.svelte` | Protected placeholder — add your app content here |
| Error | `+error.svelte` | SvelteKit error page with retry and home link |
| Login | `login/+page.svelte` | PIN-based login, device linking, device verification email flow, BroadcastChannel handshake, persistent lockout countdown |
| Email confirm | `confirm/+page.svelte` | Verifies Supabase email OTP, broadcasts `AUTH_CONFIRMED` to the login tab, then closes or redirects |
| Setup (initial) | `setup/+page.ts`, `setup/+page.svelte` | Multi-step wizard: Supabase credentials → validate → deploy schema → create account. Guarded by `resolveSetupAccess()` — only accessible before a user account exists. |
| Reconfigure | `setup/Reconfigure.svelte` | Single-page re-setup form for changing credentials after initial setup. Accessible from the profile settings. |
| Profile | `profile/+page.svelte` | Full settings hub: display name, email change (with re-verification), PIN/code change, trusted devices list with revocation, debug mode toggle, diagnostics dashboard (sync, realtime, queue, egress, errors), reset database |
| Demo | `demo/+page.svelte` | Toggle demo mode on/off with explanation and confirmation; triggers full page reload |
| Privacy policy | `policy/+page.svelte` | Static placeholder — replace with your actual policy |
| Config API | `api/config/+server.ts` | Returns `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` to the client |
| Setup deploy | `api/setup/deploy/+server.ts` | Writes `.env` during initial setup, creates Supabase auth user + pushes schema SQL |
| Setup validate | `api/setup/validate/+server.ts` | Validates Supabase credentials without writing anything |
| Catch-all | `[...catchall]/+page.server.ts` | 302 redirect to `/` for unknown URLs |

**Library (7)**

| File | Purpose |
|------|---------|
| `src/lib/routes.ts` | `ROUTES` constants for all app paths — single source of truth |
| `src/lib/schema.ts` | Example schema with two tables (`items`, `settings`); replace with your domain schema |
| `src/lib/types.generated.ts` | Placeholder for Vite-plugin-generated TypeScript interfaces |
| `src/lib/types.ts` | App-specific type stubs and re-exports |
| `src/lib/components/UpdatePrompt.svelte` | PWA update prompt that appears when a new service worker is waiting |
| `src/lib/demo/mockData.ts` | Mock data seeded into the demo database on each page load |
| `src/lib/demo/config.ts` | Demo configuration wired into `initEngine()` |

#### What's pre-wired

The skeleton is not just file stubs — the entire auth and engine lifecycle is already connected:

- **Engine bootstrap** — `initEngine()` in `+layout.ts` with your prefix, name, and demo config; `initConfig()` pulls Supabase credentials from `/api/config` at runtime
- **Auth resolution** — `resolveRootLayout()` in the layout load determines `authMode` (`'none'` | `'offline'` | `'demo'`) and redirects unauthenticated users to login
- **Single-user PIN gate** — login page handles first-time setup detection, `unlockSingleUser`, `setupSingleUser` inside the login flow, device linking, and persistent lockout
- **Device verification** — email OTP flow fully wired through login → confirm → BroadcastChannel → login tab reaction
- **Setup wizard** — multi-step Supabase credential entry, live validation, schema deploy, and user account creation; guarded so it only appears before initial setup
- **Profile page** — change name, email (with re-verification cooldown and resend), PIN, revoke trusted devices, toggle debug mode, full diagnostics panel, and reset database
- **Demo mode** — sandboxed IndexedDB, zero Supabase calls, mock profile, seeded data; toggle from `/demo` or profile settings
- **Adaptive navbar** — top bar on ≥768px, fixed bottom bar on mobile; active state driven by SvelteKit's `page` store; Dynamic Island safe area padding
- **PWA plumbing** — service worker via `stellarPWA` Vite plugin, Web App Manifest, offline fallback, `UpdatePrompt` for background updates, iOS splash/touch icons
- **Email templates** — Supabase-compatible HTML templates for signup, email change, and device verification; drop-in replacements for the default Supabase emails

#### Design theme

The skeleton uses a minimal green theme derived from the email templates:

| Token | Value | Use |
|-------|-------|-----|
| Primary | `#6B9E6B` | Buttons, active nav, focus rings, borders |
| Card background | `#0f0f1e` | Modal and card surfaces |
| Page background | `#111116` | App background |
| Card border | `#3d5a3d` | Card outlines |
| Text | `#f0f0ff` | Primary text |
| Text secondary | `#c8c8e0` | Descriptions, labels |
| Text muted | `#7878a0` | Hints, timestamps |

All colors are CSS custom properties — override `:root` in your app's global CSS to adopt any theme.

#### Building on the skeleton

After scaffolding, the typical customisation path is:

1. **Define your schema** — edit `src/lib/schema.ts` to replace the example tables with your domain entities; the Vite plugin auto-generates TypeScript interfaces and pushes Supabase migrations on `npm run dev`
2. **Add app pages** — create new routes under `src/routes/`; import stores and CRUD helpers from `stellar-drive`
3. **Wire stores** — in `+page.svelte`, create collection/detail stores with `createCollectionStore` / `createDetailStore` and refresh them with `onSyncComplete`
4. **Customise the navbar** — the root layout's navbar lists only the home and profile links; add your app's sections to the `navItems` array in `+layout.svelte`
5. **Replace placeholder content** — swap the privacy policy text, update icon SVGs with your actual branding, and fill in the demo mock data with representative records
6. **Set environment variables** — copy `.env.example` to `.env` and add your Supabase project URL and publishable key; run the setup wizard on first launch to push the schema

#### Prerequisites

- Node.js ≥ 18
- A [Supabase](https://supabase.com) project (free tier is sufficient)
- `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` from the Supabase dashboard (Settings → API)

---

## API overview

The full API is documented in the [API Reference](./API_REFERENCE.md). Below is a summary of what is available in each subpath export.

### Subpath exports

Import only what you need:

| Subpath | Contents |
|---|---|
| `stellar-drive` | Everything below, re-exported from one barrel import |
| `stellar-drive/data` | CRUD operations (`engineCreate`, `engineUpdate`, `engineDelete`, `engineIncrement`, `engineBatchWrite`), queries (`queryAll`, `queryOne`, `engineGet`, `engineGetOrCreate`), reorder helpers |
| `stellar-drive/auth` | All auth functions: Supabase auth core, single-user PIN/password gate, device verification, display utilities |
| `stellar-drive/stores` | Reactive stores (`syncStatusStore`, `authState`, `isOnline`, `remoteChangesStore`), store factories (`createCollectionStore`, `createDetailStore`), event hooks (`onSyncComplete`, `onRealtimeDataUpdate`) |
| `stellar-drive/types` | All TypeScript type definitions (zero runtime code) |
| `stellar-drive/utils` | Utilities (`generateId`, `now`, `calculateNewOrder`), debug helpers, diagnostics, SQL/TypeScript generation |
| `stellar-drive/actions` | Svelte `use:` actions (`remoteChangeAnimation`, `trackEditing`, `triggerLocalAnimation`, `truncateTooltip`) |
| `stellar-drive/config` | Runtime config management (`initConfig`, `getConfig`, `setConfig`, `getDexieTableFor`) |
| `stellar-drive/vite` | Vite plugin (`stellarPWA`) for service worker builds, asset manifests, and schema auto-generation |
| `stellar-drive/kit` | SvelteKit helpers: server route factories, layout loaders, email confirmation, SW lifecycle, auth hydration |
| `stellar-drive/toast` | Toast notifications: `addToast`, `dismissToast`, `toastStore`, `ToastVariant` type |
| `stellar-drive/components/*` | Svelte components: `SyncStatus`, `DeferredChangesBanner`, `DemoBanner`, `DemoBlockedMessage`, `OfflineToast`, `GlobalToast` |

### Key categories at a glance

**Engine lifecycle:** `initEngine`, `startSyncEngine`, `stopSyncEngine`, `runFullSync`, `scheduleSyncPush`, `getEngineConfig`, `validateSupabaseCredentials`, `validateSchema`

**Database:** `getDb`, `resetDatabase`, `clearLocalCache`, `clearPendingSyncQueue`, `getSupabaseAsync`, `resetSupabaseClient`

**CRUD and queries:** `engineCreate`, `engineUpdate`, `engineDelete`, `engineIncrement`, `engineBatchWrite`, `engineGetOrCreate`, `queryAll`, `queryOne`, `engineGet`, `markEntityModified`

**Authentication:** `resolveAuthState`, `signOut`, `getValidSession`, `setupSingleUser`, `unlockSingleUser`, `lockSingleUser`, `resetSingleUser`, device verification functions, display helpers (`resolveFirstName`, `resolveUserId`, `resolveAvatarInitial`)

**Reactive stores:** `syncStatusStore`, `authState`, `isAuthenticated`, `userDisplayInfo`, `isOnline`, `remoteChangesStore`, `createCollectionStore`, `createDetailStore`, `onSyncComplete`, `onRealtimeDataUpdate`

**Utilities:** `generateId`, `now`, `calculateNewOrder`, `setDebugMode`, `getDiagnostics`, `generateSupabaseSQL`, `generateTypeScript`, `generateMigrationSQL`

For full signatures, parameters, return types, and usage examples, see the [API Reference](./API_REFERENCE.md).

---

## Demo mode

stellar-drive includes a built-in demo mode that provides a completely isolated sandbox. When active:

- **Separate database** -- uses `${prefix}DB_demo` IndexedDB; the real database is never opened
- **No Supabase** -- zero network requests to the backend
- **Mock auth** -- `authMode === 'demo'`; protected routes work with mock data only
- **Auto-seeded** -- your `seedData(db)` callback populates the demo database on each page load
- **Full isolation** -- page reload required to enter/exit (complete engine teardown)

```ts
import type { DemoConfig } from 'stellar-drive';
import { setDemoMode, isDemoMode } from 'stellar-drive';

// Define demo config in initEngine
const demoConfig: DemoConfig = {
  seedData: async (db) => {
    await db.table('projects').bulkPut([
      { id: 'demo-1', name: 'Sample Project', order: 1 },
    ]);
  },
  mockProfile: { email: 'demo@example.com', firstName: 'Demo', lastName: 'User' },
};

initEngine({ /* ...config */, demo: demoConfig });

// Toggle demo mode from your UI
setDemoMode(true);
window.location.href = '/'; // Full reload required
```

---

## Multi-Tenant Supabase

Multiple stellar-drive apps can share a **single Supabase instance** -- same Postgres database, Auth, Realtime, and SMTP server. Each app's tables are automatically isolated via name prefixing.

### How it works

Given `prefix: 'stellar'` and schema key `goals`, the Supabase table becomes `stellar_goals`. This is automatic -- consumers still write `goals` in their schema and API calls.

**Shared across apps (unprefixed, per-app rows):**
- `auth.users` (Supabase Auth) -- same user account works in every app
- `trusted_devices` -- single table with an `app_prefix` column (default `'stellar'`). The unique constraint is `(user_id, device_id, app_prefix)`, so trusting a device in one app does not grant trust in another. All device verification queries filter by prefix automatically.
- Helper functions: `set_user_id()`, `update_updated_at_column()`

**Isolated per app (prefixed tables):**
- All app-defined tables: `stellar_goals`, `infinite_notes`, etc.
- RLS policies, triggers, and indexes

**PIN/password isolation:**
- `padPin()` uses a fixed `_app` suffix, so the same email + same PIN produces the same Supabase password in every app. Users set up in one app can authenticate in another without re-registering. A `padPinLegacy()` helper handles migration from the old per-app-prefix format.

**What does NOT change:**
- IndexedDB (Dexie) -- already namespaced by `${prefix}DB`
- Consumer schema files -- still write `goals`, not `stellar_goals`
- Consumer API calls -- `engineCreate('goals', data)` works as before
- Generated TypeScript types -- still `Goal`, not `StellarGoal`
- Auth flow -- same Supabase Auth, same user accounts across apps

### Auto-migration

When generating SQL, the engine includes safe, idempotent migration statements that rename legacy unprefixed tables to their prefixed equivalents:

```sql
-- Only renames if old table exists AND new table doesn't
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'goals')
  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'stellar_goals') THEN
    ALTER TABLE goals RENAME TO stellar_goals;
  END IF;
END $$;
```

### Self-hosting notes

On managed Supabase (Free tier), no configuration changes are needed. For self-hosted instances with 5+ apps:

- Postgres `max_connections`: increase to 200 (`postgres -c max_connections=200`)
- Realtime `max_concurrent_users`: increase via `REALTIME_MAX_CONCURRENT_USERS` env var
- PostgREST pool: `PGRST_DB_POOL=50` in docker-compose

---

## License

Private -- not yet published under an open-source license.
