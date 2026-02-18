# stellar-drive [![npm version](https://img.shields.io/npm/v/stellar-drive.svg?style=flat)](https://www.npmjs.com/package/stellar-drive) [![Made with Supabase](https://supabase.com/badge-made-with-supabase-dark.svg)](https://supabase.com)

A plug-and-play, offline-first sync engine for **Supabase + Dexie.js** applications. All reads come from IndexedDB, all writes land locally first, and a background sync loop ships changes to Supabase -- so your app stays fast and functional regardless of network state. Optional **SvelteKit** integrations are included for teams building with Svelte 5, but the core engine works with any framework or vanilla JS.

## Documentation

- [Architecture](./ARCHITECTURE.md) -- internal design, data flow, and module responsibilities
- [API Reference](./API_REFERENCE.md) -- full signatures, parameters, and usage examples for every public export
- [Frameworks](./FRAMEWORKS.md) -- more reading on frameworks used in stellar-drive

## Features

- **Schema-driven configuration** -- declare tables once in a simple object; the engine auto-generates Dexie stores, database versioning, TypeScript interfaces, and Supabase SQL
- **Intent-based sync operations** -- operations preserve intent (`increment`, `set`, `create`, `delete`) instead of final state, enabling smarter coalescing and conflict handling
- **6-step operation coalescing** -- 50 rapid writes are compressed into 1 outbound operation, dramatically reducing sync traffic
- **Three-tier conflict resolution** -- field-level auto-merge for non-overlapping changes, different-field merge, and same-field resolution (`local_pending` > `delete_wins` > `last_write_wins` with device ID tiebreaker)
- **Offline authentication** -- SHA-256 credential caching and offline session tokens let users sign in and work without connectivity; sessions reconcile automatically on reconnect
- **Single-user PIN/password auth** -- simplified gate backed by real Supabase email/password auth; PIN is padded to meet minimum length and verified server-side
- **Device verification** -- email OTP for untrusted devices with configurable trust duration
- **Realtime subscriptions** -- Supabase Realtime WebSocket push with echo suppression and deduplication against polling
- **Tombstone management** -- soft deletes with configurable garbage collection
- **Egress optimization** -- column-level selects, operation coalescing, push-only mode when realtime is healthy, cursor-based pulls
- **CRDT collaborative editing** -- optional Yjs-based subsystem for real-time multi-user editing via Supabase Broadcast
- **Demo mode** -- sandboxed database, zero Supabase connections, mock auth for instant onboarding experiences
- **Reactive stores** -- Svelte-compatible stores for sync status, auth state, network state, and remote changes
- **Store factories** -- `createCollectionStore` and `createDetailStore` for boilerplate-free reactive data layers
- **Svelte actions** -- `remoteChangeAnimation`, `trackEditing`, `triggerLocalAnimation` for declarative UI behavior
- **SQL generation** -- auto-generate `CREATE TABLE` statements, RLS policies, and migrations from your schema config
- **TypeScript generation** -- auto-generate interfaces from schema
- **Migration generation** -- auto-generate `ALTER TABLE` rename and column rename SQL from `renamedFrom` / `renamedColumns` hints
- **Diagnostics** -- comprehensive runtime diagnostics covering sync, queue, realtime, conflicts, egress, and network
- **Debug utilities** -- opt-in debug logging and `window` debug utilities for browser console inspection
- **SvelteKit integration** (optional) -- layout helpers, server handlers, email confirmation, service worker lifecycle, and auth hydration
- **PWA scaffolding CLI** -- `stellar-drive install pwa` generates a complete SvelteKit PWA project (34+ files)

### Use cases

- Productivity and task management apps
- Notion-like block editors (with CRDT collaborative editing)
- Personal finance trackers (numeric merge across devices)
- File and asset management UIs (fractional ordering for drag-and-drop)
- Habit trackers and daily planners
- Knowledge bases and note-taking apps
- Any app needing offline-first multi-device sync

## Quick start

```ts
// ─── Install ───────────────────────────────────────────────────────
// npm install stellar-drive

// ─── 1. Initialize the engine ──────────────────────────────────────
// Call once at app startup (e.g., root layout, main entry point).
// Schema-driven: declare tables once, engine handles everything else.

import { initEngine, startSyncEngine, getDb, resetDatabase } from 'stellar-drive';
import { initConfig } from 'stellar-drive/config';
import { resolveAuthState } from 'stellar-drive/auth';

initEngine({
  prefix: 'myapp', // Used to prefix Supabase table names (e.g., goals → myapp_goals)
  name: 'My App',  // Human-readable app name — included in Supabase user_metadata for email templates
  domain: window.location.origin, // Production domain — included in user_metadata for email confirmation links

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
  // No nested `singleUser` key needed -- engine normalizes internally.
  auth: {
    gateType: 'code',                               // 'code' | 'password' (default: 'code')
    codeLength: 6,                                   // 4 | 6 (default: 6)
    emailConfirmation: true,                         // default: true
    deviceVerification: true,                        // default: true
    profileExtractor: (meta) => ({ firstName: meta.first_name }),
    profileToMetadata: (p) => ({ first_name: p.firstName }),
  },

  // Optional CRDT collaborative editing
  crdt: true,  // or { persistIntervalMs: 60000, maxOfflineDocuments: 50 }

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

// ─── 2. Resolve auth and start the engine ──────────────────────────
// The engine fetches runtime config (Supabase URL + publishable key) from
// your /api/config endpoint -- no need to pass a supabase client.

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

// ─── 3. CRUD operations ────────────────────────────────────────────

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

// Get or create (atomic upsert)
const { record, created } = await engineGetOrCreate('focus_settings', settingsId, {
  id: settingsId,
  theme: 'dark',
  created_at: now(),
  updated_at: now(),
  deleted: false,
  user_id: 'current-user-id',
});

// Batch writes (multiple operations in one sync push)
await engineBatchWrite([
  { type: 'create', table: 'tasks', data: { id: generateId(), title: 'Task 1', project_id: projectId, order: 1, created_at: now(), updated_at: now(), deleted: false, user_id: 'uid' } },
  { type: 'create', table: 'tasks', data: { id: generateId(), title: 'Task 2', project_id: projectId, order: 2, created_at: now(), updated_at: now(), deleted: false, user_id: 'uid' } },
  { type: 'update', table: 'projects', id: projectId, data: { updated_at: now() } },
]);

// ─── 4. Reactive store factories ───────────────────────────────────

import { createCollectionStore, createDetailStore } from 'stellar-drive/stores';

// Collection store -- live-updating list from IndexedDB
const projectsStore = createCollectionStore('projects', {
  filter: (p) => !p.deleted,
  sort: (a, b) => a.order - b.order,
});
// Subscribe: projectsStore.subscribe(items => { ... })

// Detail store -- single record by ID
const projectDetail = createDetailStore('projects', projectId);
// Subscribe: projectDetail.subscribe(record => { ... })

// ─── 5. Reactive stores ────────────────────────────────────────────

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

// ─── 6. Svelte actions ─────────────────────────────────────────────

import { remoteChangeAnimation, trackEditing } from 'stellar-drive/actions';

// use:remoteChangeAnimation={{ table: 'tasks', id: task.id }}
// Animates elements when remote changes arrive for that entity.

// use:trackEditing={{ table: 'tasks', id: task.id }}
// Signals the engine a field is being actively edited (suppresses incoming overwrites).

// ─── 7. CRDT collaborative editing ────────────────────────────────

import {
  openDocument,
  closeDocument,
  createSharedText,
  createBlockDocument,
  updateCursor,
  getCollaborators,
  onCollaboratorsChange,
} from 'stellar-drive/crdt';

// Open a collaborative document (uses Supabase Broadcast -- zero DB writes per keystroke)
const provider = await openDocument('doc-1', 'page-1', {
  offlineEnabled: true,
  initialPresence: { name: 'Alice' },
});

// Use with any Yjs-compatible editor (Tiptap, BlockNote, etc.)
const { content, meta } = createBlockDocument(provider.doc);
meta.set('title', 'My Page');

// Shared text for simpler use cases
const text = createSharedText(provider.doc);

// Track collaborator cursors and presence
const unsub = onCollaboratorsChange('doc-1', (collaborators) => {
  // Update avatar list, cursor positions, etc.
});

await closeDocument('doc-1');

// ─── 8. Demo mode ──────────────────────────────────────────────────

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

// ─── 9. SQL and TypeScript generation ──────────────────────────────

import { generateSupabaseSQL, generateTypeScript } from 'stellar-drive/utils';
import { getEngineConfig } from 'stellar-drive';

const config = getEngineConfig();

// Auto-generate Supabase SQL (CREATE TABLE + RLS policies) from schema
// Pass prefix to generate prefixed table names (e.g., myapp_goals)
const sql = generateSupabaseSQL(config.schema!, { prefix: config.prefix });

// Auto-generate TypeScript interfaces from schema
const ts = generateTypeScript(config.schema!);

// ─── 10. Diagnostics and debug ─────────────────────────────────────

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

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | Yes | Supabase project URL. Find it: Dashboard > Settings > API > Project URL. |
| `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Yes | Supabase publishable key. Find it: Dashboard > Settings > API > Project API keys > publishable. |
| `PUBLIC_APP_DOMAIN` | Yes | Production domain (e.g. `https://myapp.example.com`). Used in Supabase email templates so confirmation links point to the correct app. |
| `DATABASE_URL` | For auto-migration | Postgres connection string. Used by the Vite plugin to push schema migrations directly to Postgres. If not set, migrations are skipped and types are still generated. Find it: Dashboard > Settings > Database > Connection string (URI). |

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

Each processing cycle:
1. Generates TypeScript interfaces from schema field definitions
2. Loads the previous schema snapshot from `.stellar/schema-snapshot.json`
3. Diffs old vs new schema to produce `ALTER TABLE` migration SQL
4. Pushes migration SQL to Supabase via direct Postgres connection (requires `DATABASE_URL`)
5. Saves the updated snapshot (only on success -- failed migrations are retried on the next build)

On first run (no snapshot), the plugin generates idempotent initial SQL (`CREATE TABLE IF NOT EXISTS`) with RLS policies, triggers, and indexes. This works on both fresh databases and databases with existing tables -- no manual SQL is ever needed.

If `DATABASE_URL` is not set, types are still generated but migration push is skipped with a warning.

### Deploying to Vercel (or any CI/CD)

The schema migration runs automatically during every `vite build`. To enable it in CI/CD:

1. **Set environment variables** in your Vercel project settings (Settings > Environment Variables):

   | Variable | Type | Required |
   |---|---|---|
   | `PUBLIC_SUPABASE_URL` | Plain | Yes -- client auth + data access |
   | `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Plain | Yes -- client auth + data access |
   | `PUBLIC_APP_DOMAIN` | Plain | Yes -- email template links |
   | `DATABASE_URL` | Secret | Yes -- auto-migration during build |

2. **Commit `.stellar/schema-snapshot.json`** to git. This file tracks the last-known schema state. Without it, every build is treated as a first run (full idempotent SQL). The snapshot is updated locally when you run `dev` or `build` and should be committed alongside schema changes.

3. **Install the `postgres` npm package** -- `npm install postgres`. This is the Postgres client used by the Vite plugin for direct SQL execution.

**How it works on each deploy:**
- The Vite plugin's `buildStart` hook loads your schema, diffs against the committed snapshot, and pushes only the changes (ALTER TABLE statements) directly to Postgres.
- If the migration fails, the snapshot is **not updated**, so the next build retries the same migration.
- IndexedDB migrations happen client-side at runtime (no build step needed).

**Security:** `DATABASE_URL` is only used server-side during the Vite build process. It is never bundled into client code or exposed to users. `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` are served at runtime from your `/api/config` endpoint -- these are public keys by design, protected by Supabase Row Level Security.

See [API Reference -- Vite Plugin](./API_REFERENCE.md#vite-plugin-stellarpwa) for full configuration options.

## Commands

### Install PWA

Scaffold a complete offline-first SvelteKit PWA project with an interactive walkthrough:

```bash
npx stellar-drive install pwa
```

The wizard prompts for:

| Prompt | Required | Description |
|--------|----------|-------------|
| App Name | Yes | Full app name (e.g., "Stellar Planner") |
| Short Name | Yes | Short name for PWA home screen (under 12 chars) |
| Prefix | Yes | Lowercase key for localStorage, caches, SW, and Supabase table names (auto-suggested from name) |
| Description | No | App description (default: "A self-hosted offline-first PWA") |

Generates **34+ files** for a production-ready SvelteKit 2 + Svelte 5 project:

- **Config files (8):** `vite.config.ts`, `tsconfig.json`, `svelte.config.js`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `knip.json`, `.gitignore`
- **Documentation (3):** `README.md`, `ARCHITECTURE.md`, `FRAMEWORKS.md`
- **Static assets (13):** `manifest.json`, `offline.html`, placeholder SVG icons, email template placeholders
- **Database (1):** `supabase-schema.sql` with helper functions, example tables, and `trusted_devices` table
- **Source files (2):** `src/app.html` (PWA-ready with iOS meta tags, SW registration), `src/app.d.ts`
- **Route files (16):** Root layout, login, setup, profile, protected area, API endpoints, catch-all redirect
- **Library (1):** `src/lib/types.ts` with re-exports and app-specific type stubs
- **Git hooks (1):** `.husky/pre-commit` with lint + format + validate

## API overview

### Engine Configuration and Lifecycle

| Export | Description |
|---|---|
| `initEngine(config)` | Initialize the engine with schema, auth, and optional CRDT/demo config |
| `startSyncEngine()` | Start the sync loop, realtime subscriptions, and event listeners |
| `stopSyncEngine()` | Tear down sync loop and subscriptions cleanly |
| `runFullSync()` | Run a complete pull-then-push cycle |
| `scheduleSyncPush()` | Trigger a debounced push of pending operations |
| `getEngineConfig()` | Retrieve the current engine config (throws if not initialized) |
| `validateSupabaseCredentials()` | Verify Supabase URL and publishable key are valid |
| `validateSchema()` | Validate all configured tables exist in Supabase |

### Database

| Export | Description |
|---|---|
| `getDb()` | Get the Dexie database instance |
| `resetDatabase()` | Drop and recreate the local IndexedDB database |
| `clearLocalCache()` | Wipe all local application data |
| `clearPendingSyncQueue()` | Drop all pending outbound operations |
| `getSupabaseAsync()` | Async getter that waits for Supabase client initialization |
| `resetSupabaseClient()` | Tear down and reinitialize the Supabase client |

### CRUD and Query Operations

| Export | Description |
|---|---|
| `engineCreate(table, data)` | Create a record locally and enqueue sync |
| `engineUpdate(table, id, data)` | Update specific fields locally and enqueue sync |
| `engineDelete(table, id)` | Soft-delete a record (tombstone) |
| `engineIncrement(table, id, field, delta)` | Intent-preserving numeric increment |
| `engineBatchWrite(operations)` | Execute multiple operations in a single sync push |
| `engineGetOrCreate(table, id, defaults)` | Atomic get-or-create (upsert) |
| `queryAll(table, options?)` | Query all rows from local IndexedDB |
| `queryOne(table, id)` | Query a single row by ID |
| `markEntityModified(table, id)` | Suppress incoming realtime overwrites for a recently modified entity |

### Authentication -- Core

| Export | Description |
|---|---|
| `resolveAuthState()` | Determine current auth state (online, offline, or none) |
| `signOut()` | Full teardown: stop sync, clear caches, sign out of Supabase |
| `getValidSession()` | Get a non-expired Supabase session, or `null` |
| `verifyOtp(tokenHash)` | Verify OTP token hash from email confirmation links |
| `resendConfirmationEmail()` | Resend signup confirmation email |
| `getUserProfile()` | Read profile from Supabase user metadata |
| `updateProfile(data)` | Write profile to Supabase user metadata |

### Authentication -- Single-User

| Export | Description |
|---|---|
| `setupSingleUser(gate, profile, email)` | First-time setup: create gate, Supabase user, and store config |
| `unlockSingleUser(gate)` | Verify gate and restore session (online or offline) |
| `lockSingleUser()` | Stop sync and reset auth state without destroying data |
| `isSingleUserSetUp()` | Check if initial setup is complete |
| `getSingleUserInfo()` | Get display info (profile, gate type) for the unlock screen |
| `changeSingleUserGate(oldGate, newGate)` | Change PIN code or password |
| `updateSingleUserProfile(profile)` | Update profile in IndexedDB and Supabase metadata |
| `changeSingleUserEmail(newEmail)` | Request email change |
| `completeSingleUserEmailChange()` | Finalize email change after confirmation |
| `resetSingleUser()` | Full reset: clear config, sign out, wipe local data |
| `padPin(pin)` | Pad a PIN to meet Supabase's minimum password length |

### Authentication -- Device Verification

| Export | Description |
|---|---|
| `completeDeviceVerification(tokenHash?)` | Complete device OTP verification |
| `sendDeviceVerification()` | Send device verification email |
| `pollDeviceVerification()` | Poll for device verification completion |
| `linkSingleUserDevice()` | Link current device to user after verification |
| `getTrustedDevices()` | List all trusted devices for current user |
| `removeTrustedDevice(deviceId)` | Remove a trusted device |
| `getCurrentDeviceId()` | Get the stable device identifier |
| `fetchRemoteGateConfig()` | Fetch gate config from Supabase for cross-device setup |

### Authentication -- Display Utilities

| Export | Description |
|---|---|
| `resolveFirstName(session, offline, fallback?)` | Resolve display name from session or offline profile |
| `resolveUserId(session, offline)` | Extract user UUID from session or offline credentials |
| `resolveAvatarInitial(session, offline, fallback?)` | Single uppercase initial for avatar display |

### Reactive Stores

| Export | Description |
|---|---|
| `syncStatusStore` | Current `SyncStatus`, last sync time, and errors |
| `authState` | Reactive auth state object (`mode`, `session`, `offlineProfile`, `isLoading`) |
| `isAuthenticated` | Derived boolean for auth status |
| `userDisplayInfo` | Derived display name and avatar info |
| `isOnline` | Reactive boolean reflecting network state |
| `remoteChangesStore` | Tracks entities recently changed by remote peers |
| `createRecentChangeIndicator(table, id)` | Derived indicator for UI highlighting of remote changes |
| `createPendingDeleteIndicator(table, id)` | Derived indicator for entities awaiting delete confirmation |
| `onSyncComplete(callback)` | Register a callback invoked after each successful sync cycle |
| `onRealtimeDataUpdate(callback)` | Register a handler for incoming realtime changes |

### Store Factories

| Export | Description |
|---|---|
| `createCollectionStore(table, options?)` | Live-updating list store from IndexedDB with filter and sort |
| `createDetailStore(table, id)` | Single-record store by ID |

### Realtime

| Export | Description |
|---|---|
| `startRealtimeSubscriptions()` | Start Supabase Realtime channels for all configured tables |
| `stopRealtimeSubscriptions()` | Stop all Realtime channels |
| `isRealtimeHealthy()` | Realtime connection health check |
| `wasRecentlyProcessedByRealtime(table, id)` | Guard against duplicate processing |

### Runtime Config

| Export | Description |
|---|---|
| `initConfig()` | Initialize runtime configuration (fetches Supabase credentials from `/api/config`) |
| `getConfig()` | Get current config |
| `setConfig(config)` | Update runtime config |
| `waitForConfig()` | Async getter that waits for config initialization |
| `isConfigured()` | Check if config is initialized |
| `clearConfigCache()` | Clear cached config |
| `getDexieTableFor(supabaseName)` | Get the Dexie table name for a Supabase table name |

### Diagnostics and Debug

| Export | Description |
|---|---|
| `getDiagnostics()` | Comprehensive runtime diagnostics (sync, queue, realtime, conflict, egress, network) |
| `setDebugMode(enabled)` | Enable/disable debug logging |
| `isDebugMode()` | Check if debug mode is active |
| `debugLog` / `debugWarn` / `debugError` | Prefixed console helpers (gated by debug mode) |

When debug mode is enabled, the engine exposes utilities on `window` using your configured prefix (e.g., `window.__myappSyncStats()`, `window.__myappEgress()`, `window.__myappTombstones()`, `window.__myappSync.forceFullSync()`).

### Utilities

| Export | Description |
|---|---|
| `generateId()` | Generate a UUID |
| `now()` | Current ISO timestamp string |
| `calculateNewOrder(before, after)` | Fractional ordering helper for drag-and-drop reorder |
| `snakeToCamel(str)` | Convert `snake_case` to `camelCase` |
| `getDeviceId()` | Stable per-device identifier (persisted in localStorage) |

### SQL and TypeScript Generation

| Export | Description |
|---|---|
| `generateSupabaseSQL(schema, options?)` | Generate `CREATE TABLE` statements and RLS policies from schema (accepts `prefix` to prefix table names) |
| `generateTypeScript(schema)` | Generate TypeScript interfaces from schema |
| `generateMigrationSQL(oldSchema, newSchema)` | Generate `ALTER TABLE` migration SQL for schema changes |

### Svelte Actions

| Export | Description |
|---|---|
| `remoteChangeAnimation` | `use:` action that animates an element when a remote change arrives |
| `trackEditing` | Action that signals the engine a field is being actively edited (suppresses incoming overwrites) |
| `triggerLocalAnimation` | Programmatically trigger the local-change animation on a node |
| `truncateTooltip` | Action that shows a tooltip with full text when content is truncated |

### Svelte Components (Optional - SvelteKit)

| Export | Description |
|---|---|
| `stellar-drive/components/SyncStatus` | Animated sync-state indicator with tooltip and PWA refresh |
| `stellar-drive/components/DeferredChangesBanner` | Cross-device data conflict notification with diff preview |
| `stellar-drive/components/DemoBanner` | Demo mode indicator banner |

### SvelteKit Helpers (Optional - SvelteKit)

These require `svelte ^5.0.0` and `@sveltejs/kit` as peer dependencies.

| Export | Description |
|---|---|
| Layout load functions | `resolveAuthState` integration for `+layout.ts` |
| Server handlers | Factory functions for API routes (`getServerConfig`, `createValidateHandler`, `deployToVercel`) |
| Email confirmation | `handleEmailConfirmation()`, `broadcastAuthConfirmed()` |
| SW lifecycle | `monitorSwLifecycle()`, `handleSwUpdate()`, `pollForNewServiceWorker()` |
| Auth hydration | `hydrateAuthState()` for `+layout.svelte` |

### CRDT Collaborative Editing

| Export | Description |
|---|---|
| `openDocument(docId, pageId, options?)` | Open a collaborative document via Supabase Broadcast |
| `closeDocument(docId)` | Close and clean up a document |
| `createSharedText(doc)` | Create a shared Yjs text type |
| `createBlockDocument(doc)` | Create a block-based document structure |
| `updateCursor(docId, cursor)` | Update cursor position for presence |
| `getCollaborators(docId)` | Get current collaborators |
| `onCollaboratorsChange(docId, callback)` | Subscribe to collaborator changes |
| `enableOffline(docId)` / `disableOffline(docId)` | Toggle offline persistence |

### Types

All TypeScript types are available from `stellar-drive/types`:

`Session`, `SyncEngineConfig`, `TableConfig`, `AuthConfig`, `SchemaDefinition`, `SchemaTableConfig`, `FieldType`, `BatchOperation`, `SingleUserConfig`, `DemoConfig`, `SyncStatus`, `AuthMode`, `CRDTConfig`, and more.

## Subpath exports

Import only what you need:

| Subpath | Contents |
|---|---|
| `stellar-drive` | Core: `initEngine`, `startSyncEngine`, `runFullSync`, `getDb`, `resetDatabase`, `getDiagnostics`, CRUD, auth, stores, and all re-exports |
| `stellar-drive/data` | CRUD + query operations + helpers |
| `stellar-drive/auth` | All auth functions |
| `stellar-drive/stores` | Reactive stores + store factories + event subscriptions |
| `stellar-drive/types` | All type exports |
| `stellar-drive/utils` | Utilities + debug + diagnostics + SQL/TS generation |
| `stellar-drive/actions` | Svelte `use:` actions |
| `stellar-drive/config` | Runtime config + `getDexieTableFor` |
| `stellar-drive/vite` | Vite plugin |
| `stellar-drive/kit` | SvelteKit helpers (optional) |
| `stellar-drive/crdt` | CRDT collaborative editing |
| `stellar-drive/components/SyncStatus` | Sync indicator component |
| `stellar-drive/components/DeferredChangesBanner` | Conflict banner component |
| `stellar-drive/components/DemoBanner` | Demo mode banner component |

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

## Multi-Tenant Supabase

Multiple stellar-drive apps can share a **single Supabase instance** — same Postgres database, Auth, Realtime, and SMTP server. Each app's tables are automatically isolated via name prefixing.

### How it works

Given `prefix: 'stellar'` and schema key `goals`, the Supabase table becomes `stellar_goals`. This is automatic — consumers still write `goals` in their schema and API calls.

**Shared across apps (unprefixed):**
- `auth.users` (Supabase Auth)
- `trusted_devices` (device verification)
- `crdt_documents` (CRDT collaborative editing)
- Helper functions: `set_user_id()`, `update_updated_at_column()`

**Isolated per app (prefixed):**
- All app-defined tables: `stellar_goals`, `infinite_notes`, etc.
- RLS policies, triggers, and indexes

**What does NOT change:**
- IndexedDB (Dexie) — already namespaced by `${prefix}DB`
- Consumer schema files — still write `goals`, not `stellar_goals`
- Consumer API calls — `engineCreate('goals', data)` works as before
- Generated TypeScript types — still `Goal`, not `StellarGoal`
- Auth flow — same Supabase Auth, same user accounts across apps

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

## License

Private -- not yet published under an open-source license.
