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
- **CRDT collaborative editing** -- Optional Yjs-based subsystem for real-time multi-user editing via Supabase Broadcast. Zero database writes per keystroke.
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
- **PWA scaffolding CLI** -- `stellar-drive install pwa` generates a complete SvelteKit PWA project (34+ files) with an interactive walkthrough.

### Use cases

- Productivity and task management apps
- Notion-like block editors (with CRDT collaborative editing)
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

### 7. CRDT collaborative editing

```ts
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
```

### 8. Demo mode

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

### 9. SQL and TypeScript generation

```ts
import { generateSupabaseSQL, generateTypeScript } from 'stellar-drive/utils';
import { getEngineConfig } from 'stellar-drive';

const config = getEngineConfig();

// Auto-generate Supabase SQL (CREATE TABLE + RLS policies) from schema
const sql = generateSupabaseSQL(config.schema!, { prefix: config.prefix });

// Auto-generate TypeScript interfaces from schema
const ts = generateTypeScript(config.schema!);
```

### 10. Diagnostics and debug

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
| `stellar-drive/crdt` | CRDT collaborative editing: document lifecycle, shared types, presence/cursors, offline persistence |
| `stellar-drive/components/*` | Svelte components: `SyncStatus`, `DeferredChangesBanner`, `DemoBanner` |

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
- `crdt_documents` (CRDT collaborative editing)
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
