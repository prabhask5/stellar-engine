# @prabhask5/stellar-engine [![npm version](https://img.shields.io/npm/v/@prabhask5/stellar-engine.svg?style=flat)](https://www.npmjs.com/package/@prabhask5/stellar-engine) [![Made with Supabase](https://supabase.com/badge-made-with-supabase-dark.svg)](https://supabase.com)

A local-first, offline-capable sync engine for **SvelteKit + Supabase + Dexie** applications. All reads come from IndexedDB, all writes land locally first, and a background sync loop ships changes to Supabase -- so your app stays fast and functional regardless of network state.

## Documentation

- [API Reference](./API_REFERENCE.md) -- full signatures, parameters, and usage examples for every public export
- [Architecture](./ARCHITECTURE.md) -- internal design, data flow, and module responsibilities
- [Framework Integration](./FRAMEWORKS.md) -- SvelteKit-specific patterns and conventions

## Features

- **Intent-based sync operations** -- operations preserve intent (`increment`, `set`, `create`, `delete`) instead of just final state, enabling smarter coalescing and conflict handling.
- **Three-tier conflict resolution** -- field-level diffing, numeric merge fields, and configurable exclusion lists let you resolve conflicts precisely rather than with blanket last-write-wins.
- **Offline authentication** -- credential caching and offline session tokens let users sign in and work without connectivity; sessions reconcile automatically on reconnect.
- **Single-user auth mode** -- for personal apps, use a simplified PIN code or password gate backed by real Supabase email/password auth. The user provides an email during setup; the PIN is padded to meet Supabase's minimum password length and verified server-side. Setup, unlock, lock, and gate change are all handled by the engine with full offline support.
- **Realtime subscriptions** -- Supabase Realtime channels push remote changes into local state instantly, with duplicate-delivery guards to prevent re-processing.
- **Operation coalescing** -- batches of rapid local writes (e.g., 50 individual increments) are compressed into a single outbound operation, reducing sync traffic dramatically.
- **Tombstone management** -- soft deletes are propagated cleanly, and stale tombstones are garbage-collected after a configurable retention period.
- **Egress optimization** -- column-level select lists and ownership filters ensure only the data your client needs is fetched from Supabase.

## Quick start

Install from npm:

```bash
npm install @prabhask5/stellar-engine
```

Initialize the engine at app startup (e.g., in a SvelteKit root `+layout.ts`):

```ts
import { initEngine, startSyncEngine, supabase } from '@prabhask5/stellar-engine';
import { initConfig } from '@prabhask5/stellar-engine/config';
import { resolveAuthState } from '@prabhask5/stellar-engine/auth';

initEngine({
  prefix: 'myapp',
  supabase,
  tables: [
    {
      supabaseName: 'projects',
      columns: 'id, name, created_at, updated_at, is_deleted, user_id',
    },
    // ...more tables
  ],
  database: {
    name: 'MyAppDB',
    versions: [
      {
        version: 1,
        stores: {
          projects: 'id, user_id, updated_at',
          tasks: 'id, project_id, user_id, updated_at',
        }
      }
    ]
  },
  auth: {
    enableOfflineAuth: true,
  },
});

await initConfig();
const auth = await resolveAuthState();
if (auth.authMode !== 'none') await startSyncEngine();
```

### Single-user mode

For personal apps with a PIN code gate backed by real Supabase email/password auth:

```ts
import { initEngine, startSyncEngine, supabase } from '@prabhask5/stellar-engine';
import { initConfig } from '@prabhask5/stellar-engine/config';
import { resolveAuthState } from '@prabhask5/stellar-engine/auth';

initEngine({
  prefix: 'myapp',
  supabase,
  tables: [/* ... */],
  database: {/* ... */},
  auth: {
    singleUser: { gateType: 'code', codeLength: 4 },
    enableOfflineAuth: true,
    // emailConfirmation: { enabled: true },       // require email confirmation on setup
    // deviceVerification: { enabled: true },       // require OTP verification on new devices
  },
});

await initConfig();
const auth = await resolveAuthState();

if (!auth.singleUserSetUp) {
  // Show setup screen → call setupSingleUser(code, profile, email)
  // Returns { error, confirmationRequired }
  // If confirmationRequired, prompt user to check email then call completeSingleUserSetup()
} else if (auth.authMode === 'none') {
  // Show unlock screen → call unlockSingleUser(code)
  // Returns { error, deviceVerificationRequired?, maskedEmail? }
  // If deviceVerificationRequired, prompt for OTP then call completeDeviceVerification(tokenHash?)
} else {
  await startSyncEngine();
}
```

## Install PWA Command

Scaffold a complete offline-first PWA project with an interactive walkthrough:

```bash
npx @prabhask5/stellar-engine install pwa
```

The wizard guides you through each option (app name, short name, prefix, description), validates input inline, shows a confirmation summary, then scaffolds with animated progress.

### What it generates

The command creates a full SvelteKit 2 + Svelte 5 project with:

**Configuration files (8):** `vite.config.ts`, `tsconfig.json`, `svelte.config.js`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `knip.json`, `.gitignore`

**Documentation (3):** `README.md`, `ARCHITECTURE.md`, `FRAMEWORKS.md`

**Static assets (13):** `manifest.json`, `offline.html`, placeholder SVG icons (app, dark, maskable, favicon, monochrome, splash, apple-touch), email template placeholders (signup, change-email, device-verification)

**Database (1):** `supabase-schema.sql` with helper functions, example table pattern, and `trusted_devices` table

**Source files (2):** `src/app.html` (PWA-ready with iOS meta tags, landscape blocker, zoom prevention, SW registration), `src/app.d.ts`

**Route files (16):**
| File | What stellar-engine manages | What you customize (TODO) |
|------|---------------------------|--------------------------|
| `src/routes/+layout.ts` | Auth resolution, config init, sync engine startup via `resolveAuthState()`, `initConfig()`, `startSyncEngine()` | `initEngine()` config with your database schema |
| `src/routes/+layout.svelte` | Auth state hydration via `hydrateAuthState()` | App shell (navbar, tab bar, overlays) |
| `src/routes/+page.svelte` | Imports `resolveFirstName`, `onSyncComplete`, `authState`; derives `firstName` reactively | Home page UI |
| `src/routes/+error.svelte` | — | Error page UI |
| `src/routes/setup/+page.ts` | Config check, session validation via `getConfig()`, `getValidSession()` | — (fully managed) |
| `src/routes/setup/+page.svelte` | Imports `setConfig`, `isOnline`, `pollForNewServiceWorker` | Setup wizard UI |
| `src/routes/policy/+page.svelte` | — | Privacy policy content |
| `src/routes/login/+page.svelte` | All auth functions: `setupSingleUser`, `unlockSingleUser`, `getSingleUserInfo`, `completeSingleUserSetup`, `completeDeviceVerification`, `pollDeviceVerification`, `fetchRemoteGateConfig`, `linkSingleUserDevice`, `sendDeviceVerification` | Login page UI |
| `src/routes/confirm/+page.svelte` | Email confirmation via `handleEmailConfirmation()`, `broadcastAuthConfirmed()` | Confirmation page UI |
| `src/routes/api/config/+server.ts` | Fully managed: `getServerConfig()` | — |
| `src/routes/api/setup/deploy/+server.ts` | Fully managed: `deployToVercel()` | — |
| `src/routes/api/setup/validate/+server.ts` | Fully managed: `createValidateHandler()` | — |
| `src/routes/[...catchall]/+page.ts` | Redirect to `/` | — |
| `src/routes/(protected)/+layout.ts` | Auth guard via `resolveAuthState()` with login redirect | — (fully managed) |
| `src/routes/(protected)/+layout.svelte` | — | Protected area chrome |
| `src/routes/(protected)/profile/+page.svelte` | All profile functions: `changeSingleUserGate`, `updateSingleUserProfile`, `getSingleUserInfo`, `changeSingleUserEmail`, `completeSingleUserEmailChange`, `resetDatabase`, `getTrustedDevices`, `removeTrustedDevice`, `getCurrentDeviceId`, `isDebugMode`, `setDebugMode` | Profile page UI |

**Library (1):** `src/lib/types.ts` with re-exports from stellar-engine + app-specific type stubs

**Git hooks (1):** `.husky/pre-commit` with lint + format + validate

### Interactive Prompts

| Prompt | Required | Description |
|--------|----------|-------------|
| App Name | Yes | Full app name (e.g., "Stellar Planner") |
| Short Name | Yes | Short name for PWA home screen (under 12 chars) |
| Prefix | Yes | Lowercase key for localStorage, caches, SW (auto-suggested from name) |
| Description | No | App description (default: "A self-hosted offline-first PWA") |

## Subpath exports

Import only what you need via subpath exports:

| Subpath | Contents |
|---|---|
| `@prabhask5/stellar-engine` | `initEngine`, `startSyncEngine`, `runFullSync`, `supabase`, `getDb`, `validateSupabaseCredentials`, `validateSchema` |
| `@prabhask5/stellar-engine/data` | All engine CRUD + query operations (`engineCreate`, `engineUpdate`, etc.) |
| `@prabhask5/stellar-engine/auth` | All auth functions (`resolveAuthState`, `signOut`, `setupSingleUser`, `unlockSingleUser`, `lockSingleUser`, `completeSingleUserSetup`, `completeDeviceVerification`, `changeSingleUserEmail`, `completeSingleUserEmailChange`, `padPin`, etc.) |
| `@prabhask5/stellar-engine/stores` | Reactive stores + event subscriptions (`syncStatusStore`, `authState`, `onSyncComplete`, etc.) |
| `@prabhask5/stellar-engine/types` | All type exports (`Session`, `SyncEngineConfig`, `BatchOperation`, `SingleUserConfig`, etc.) |
| `@prabhask5/stellar-engine/utils` | Utility functions (`generateId`, `now`, `calculateNewOrder`, `snakeToCamel`, `debug`, etc.) |
| `@prabhask5/stellar-engine/actions` | Svelte `use:` actions (`remoteChangeAnimation`, `trackEditing`, `triggerLocalAnimation`, `truncateTooltip`) |
| `@prabhask5/stellar-engine/kit` | SvelteKit route helpers, server APIs, load functions, confirmation, auth hydration |
| `@prabhask5/stellar-engine/components/SyncStatus` | Sync status indicator Svelte component |
| `@prabhask5/stellar-engine/components/DeferredChangesBanner` | Cross-device conflict banner Svelte component |
| `@prabhask5/stellar-engine/config` | Runtime config (`initConfig`, `getConfig`, `setConfig`, `getDexieTableFor`) |

The root export (`@prabhask5/stellar-engine`) re-exports everything for backward compatibility.

## Requirements

**Supabase**

Your Supabase project needs tables matching the `supabaseName` entries in your config. The corresponding Dexie (IndexedDB) table name is automatically derived from `supabaseName` using `snakeToCamel()` conversion (e.g., `goal_lists` becomes `goalLists`). Each table should have at minimum:
- `id` (uuid primary key)
- `updated_at` (timestamptz) -- used as the sync cursor
- `is_deleted` (boolean, default false) -- for soft-delete / tombstone support
- An ownership column (e.g., `user_id`) if you use `ownershipFilter`

Row-Level Security policies should scope reads and writes to the authenticated user.

**Single-user mode additional requirements:**

Single-user mode uses real Supabase email/password auth where the PIN is padded to meet Supabase's minimum password length. The user provides an email during setup, and the PIN is verified server-side.

If `deviceVerification` is enabled in the auth config, you need a `trusted_devices` table:

```sql
CREATE TABLE trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  device_id text NOT NULL,
  device_label text,
  trusted_at timestamptz DEFAULT now() NOT NULL,
  last_used_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(user_id, device_id)
);
ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own devices" ON trusted_devices FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
```

If `emailConfirmation` is enabled, Supabase email templates must be configured. See [EMAIL_TEMPLATES.md](./EMAIL_TEMPLATES.md) for the full HTML templates for signup confirmation, email change confirmation, and device verification emails.

**Schema validation:** The engine automatically validates that all configured tables (and `trusted_devices` when `deviceVerification.enabled`) exist in Supabase on the first sync. Missing tables are reported via `syncStatusStore` and the debug console.

**Dexie (IndexedDB)**

When you provide a `database` config to `initEngine`, the engine creates and manages the Dexie instance for you. System tables (`syncQueue`, `conflictHistory`, `offlineCredentials`, `offlineSession`, `singleUserConfig`) are automatically merged into every schema version -- you only declare your application tables. Note that the store keys use the **camelCase** Dexie table names (auto-derived from `supabaseName` via `snakeToCamel()`):

```ts
database: {
  name: 'MyAppDB',
  versions: [
    {
      version: 1,
      stores: {
        projects: 'id, user_id, updated_at',
        tasks: 'id, project_id, user_id, updated_at',
      }
    }
  ]
}
```

Alternatively, you can provide a pre-created Dexie instance via the `db` config option for full control.

## Architecture

```
+---------------------+
|   Application UI    |
+---------------------+
         |
         v
+---------------------+       +-------------------+
|    Repositories     | ----> |    Dexie (IDB)    |
| (read/write local)  |       |  - app tables     |
+---------------------+       |  - syncQueue      |
         |                    |  - conflictHistory |
         | queueSyncOperation +-------------------+
         v                              ^
+---------------------+                |
|    Sync Engine      | ---------------+
|  - coalesce ops     |    hydrate / reconcile
|  - push to remote   |
|  - pull from remote  |
|  - resolve conflicts |
+---------------------+
         |
         v
+---------------------+       +---------------------+
|   Supabase REST     |       | Supabase Realtime   |
|   (push / pull)     |       | (live subscriptions)|
+---------------------+       +---------------------+
```

1. **Repositories** read from and write to Dexie, then enqueue a `SyncOperationItem` describing the intent of the change.
2. **The engine** debounces outbound operations, coalesces them, and pushes to Supabase via REST. On pull, it fetches rows newer than the local sync cursor and reconciles them with any pending local operations.
3. **Realtime** channels deliver server-side changes immediately, skipping the next poll cycle when the subscription is healthy.

## API overview

### Configuration

| Export | Description |
|---|---|
| `initEngine(config)` | Initialize the engine with table definitions, Supabase client, and Dexie instance. |
| `getEngineConfig()` | Retrieve the current config (throws if not initialized). |
| `SyncEngineConfig` / `TableConfig` | TypeScript interfaces for the config objects. `TableConfig` uses `supabaseName` only; Dexie table names are auto-derived. |

### Engine lifecycle

| Export | Description |
|---|---|
| `startSyncEngine()` | Start the sync loop, realtime subscriptions, and event listeners. |
| `stopSyncEngine()` | Tear down everything cleanly. |
| `scheduleSyncPush()` | Trigger a debounced push of pending operations. |
| `runFullSync()` | Run a complete pull-then-push cycle. |
| `clearLocalCache()` | Wipe all local application data. |
| `clearPendingSyncQueue()` | Drop all pending outbound operations. |

### Entity tracking

| Export | Description |
|---|---|
| `markEntityModified(table, id)` | Record that an entity was recently modified locally (prevents incoming realtime from overwriting). |
| `onSyncComplete(callback)` | Register a callback invoked after each successful sync cycle. |

### Auth Utilities

| Export | Description |
|---|---|
| `signOut` | Full teardown: stops sync, clears caches, signs out of Supabase. |
| `resendConfirmationEmail` | Resend signup confirmation email. |
| `getUserProfile` / `updateProfile` | Profile read/write via Supabase user metadata. |
| `verifyOtp` | Verify OTP token hash from confirmation email links. |
| `getValidSession` | Get a non-expired Supabase session, or `null`. |
| `resolveFirstName(session, offline, fallback?)` | Resolve display name from session or offline profile with configurable fallback. |
| `resolveUserId(session, offline)` | Extract user UUID from session or offline credentials. |
| `resolveAvatarInitial(session, offline, fallback?)` | Single uppercase initial for avatar display. |

### Single-user auth

For personal apps that use a simplified PIN or password gate. Uses real Supabase email/password auth where the PIN is padded to meet minimum password length. Enable by setting `auth.singleUser` in the engine config.

| Export | Description |
|---|---|
| `isSingleUserSetUp()` | Check if initial setup is complete. |
| `getSingleUserInfo()` | Get display info (profile, gate type) for the unlock screen. |
| `setupSingleUser(gate, profile, email)` | First-time setup: create gate, Supabase email/password user, and store config. Returns `{ error, confirmationRequired }`. |
| `unlockSingleUser(gate)` | Verify gate and restore session (online or offline). Returns `{ error, deviceVerificationRequired?, maskedEmail? }`. |
| `completeSingleUserSetup()` | Called after the user confirms their email (when `emailConfirmation` is enabled). |
| `completeDeviceVerification(tokenHash?)` | Called after the user completes device OTP verification (when `deviceVerification` is enabled). |
| `lockSingleUser()` | Stop sync and reset auth state without destroying data. |
| `changeSingleUserGate(oldGate, newGate)` | Change the PIN code or password. |
| `updateSingleUserProfile(profile)` | Update profile in IndexedDB and Supabase metadata. |
| `changeSingleUserEmail(newEmail)` | Request email change for single-user mode. Returns `{ error, confirmationRequired }`. |
| `completeSingleUserEmailChange()` | Finalize email change: refresh session, update IndexedDB config and cached credentials. |
| `resetSingleUser()` | Full reset: clear config, sign out, wipe local data. |
| `padPin(pin)` | Pad a PIN to meet Supabase's minimum password length requirement. |

### Queue

| Export | Description |
|---|---|
| `queueSyncOperation(item)` | Enqueue a raw `SyncOperationItem`. |
| `queueCreateOperation(table, id, payload)` | Enqueue entity creation. |
| `queueDeleteOperation(table, id)` | Enqueue a soft delete. |
| `coalescePendingOps()` | Compress the outbox in-place (called automatically before push). |
| `getPendingSync()` / `getPendingEntityIds()` | Inspect the current outbox. |

### Conflict resolution

| Export | Description |
|---|---|
| `resolveConflicts(table, localEntity, remoteEntity, pendingOps)` | Three-tier field-level conflict resolver. Returns the merged entity. |

### Realtime

| Export | Description |
|---|---|
| `startRealtimeSubscriptions()` / `stopRealtimeSubscriptions()` | Manage Supabase Realtime channels for all configured tables. |
| `isRealtimeHealthy()` | Realtime connection health check. |
| `wasRecentlyProcessedByRealtime(table, id)` | Guard against duplicate processing. |
| `onRealtimeDataUpdate(callback)` | Register a handler for incoming realtime changes. |

### Stores (Svelte 5 compatible)

| Export | Description |
|---|---|
| `syncStatusStore` | Reactive store exposing current `SyncStatus`, last sync time, and errors. |
| `remoteChangesStore` | Tracks which entities were recently changed by remote peers. |
| `createRecentChangeIndicator(table, id)` | Derived indicator for UI highlighting of remote changes. |
| `createPendingDeleteIndicator(table, id)` | Derived indicator for entities awaiting delete confirmation. |
| `isOnline` | Reactive boolean reflecting network state. |
| `authState` / `isAuthenticated` / `userDisplayInfo` | Reactive auth status stores. |

### Supabase client

| Export | Description |
|---|---|
| `supabase` | The configured `SupabaseClient` instance. |
| `getSupabaseAsync()` | Async getter that waits for initialization. |
| `resetSupabaseClient()` | Tear down and reinitialize the client. |

### Runtime config

| Export | Description |
|---|---|
| `initConfig` / `getConfig` / `waitForConfig` / `setConfig` | Manage app-level runtime configuration (e.g., feature flags loaded from the server). |
| `isConfigured()` / `clearConfigCache()` | Status and cache management. |

### Utilities

| Export | Description |
|---|---|
| `generateId()` | Generate a UUID. |
| `now()` | Current ISO timestamp string. |
| `calculateNewOrder(before, after)` | Fractional ordering helper for drag-and-drop reorder. |
| `snakeToCamel(str)` | Convert a `snake_case` string to `camelCase` (also strips invalid characters). Used internally to derive Dexie table names from `supabaseName`. |
| `getDeviceId()` | Stable per-device identifier (persisted in localStorage). |
| `debugLog` / `debugWarn` / `debugError` | Prefixed console helpers (gated by `setDebugMode`). |

### Browser console debug utilities

When debug mode is enabled, the engine exposes utilities on the `window` object using the configured app prefix (e.g. `stellar`):

| Window property | Description |
|---|---|
| `window.__<prefix>SyncStats()` | View sync cycle statistics (total cycles, recent cycle details, trigger types). |
| `window.__<prefix>Egress()` | Monitor data transfer from Supabase (total bytes, per-table breakdown, recent cycles). |
| `window.__<prefix>Tombstones()` | Check soft-deleted record counts across all tables. |
| `window.__<prefix>Tombstones({ cleanup: true })` | Manually trigger tombstone cleanup. |
| `window.__<prefix>Tombstones({ cleanup: true, force: true })` | Force server cleanup (bypasses 24-hour interval). |
| `window.__<prefix>Sync.forceFullSync()` | Reset sync cursor, clear local data, and re-download everything from server. |
| `window.__<prefix>Sync.resetSyncCursor()` | Clear the stored cursor so the next sync pulls all data. |
| `window.__<prefix>Sync.sync()` | Trigger a manual sync cycle. |
| `window.__<prefix>Sync.getStatus()` | View current sync cursor and pending operation count. |
| `window.__<prefix>Sync.checkConnection()` | Test Supabase connectivity. |
| `window.__<prefix>Sync.realtimeStatus()` | Check realtime connection state and health. |

### Svelte actions

| Export | Description |
|---|---|
| `remoteChangeAnimation` | Svelte `use:` action that animates an element when a remote change arrives. |
| `trackEditing` | Action that signals the engine a field is being actively edited (suppresses incoming overwrites). |
| `triggerLocalAnimation` | Programmatically trigger the local-change animation on a node. |
| `truncateTooltip` | Action that shows a tooltip with full text when content is truncated via CSS overflow. |

### Svelte components

| Export | Description |
|---|---|
| `@prabhask5/stellar-engine/components/SyncStatus` | Full Svelte 5 component for animated sync-state indicator with tooltip and PWA refresh. Shows offline/syncing/synced/error/pending states with live indicator. |
| `@prabhask5/stellar-engine/components/DeferredChangesBanner` | Full Svelte 5 component for cross-device data conflict notification. Shows when another device pushes changes while user is editing. Provides Update/Dismiss/Show Changes actions with diff preview. |

The `UpdatePrompt` component is **not** shipped as a stellar-engine export. Instead, it is generated by `stellar-engine install pwa` at `src/lib/components/UpdatePrompt.svelte` with TODO UI placeholders. The generated component imports `monitorSwLifecycle` and `handleSwUpdate` from `@prabhask5/stellar-engine/kit` for all SW lifecycle logic.

## Use cases

- **Productivity and task management apps** -- offline-capable task boards, habit trackers, daily planners with cross-device sync.
- **Notion-like editors** -- block-based documents where each block is a synced entity with field-level conflict resolution.
- **Personal finance trackers** -- numeric merge fields handle concurrent balance adjustments across devices.
- **File and asset management UIs** -- fractional ordering keeps drag-and-drop sort order consistent without rewriting every row.

## Demo Mode

stellar-engine includes a built-in demo mode that provides a completely isolated sandbox for consumer apps. When active:

- **Separate database**: Uses `${name}_demo` IndexedDB — the real DB is never opened
- **No Supabase**: Zero network requests to the backend
- **Mock auth**: `authMode === 'demo'` — protected routes work with mock data only
- **Auto-seeded**: Consumer's `seedData(db)` populates the demo DB on each page load
- **Full isolation**: Page reload required to enter/exit (complete engine teardown)

### Quick Start

1. Define a `DemoConfig` with mock data and profile:

```ts
import type { DemoConfig } from '@prabhask5/stellar-engine';

const demoConfig: DemoConfig = {
  seedData: async (db) => {
    await db.table('items').bulkPut([{ id: '1', name: 'Sample', ... }]);
  },
  mockProfile: { email: 'demo@example.com', firstName: 'Demo', lastName: 'User' },
};
```

2. Pass it to `initEngine()`:

```ts
initEngine({ ..., demo: demoConfig });
```

3. Toggle demo mode:

```ts
import { setDemoMode } from '@prabhask5/stellar-engine';
setDemoMode(true);
window.location.href = '/'; // Full reload required
```

The `stellar-engine install pwa` scaffolding generates demo files automatically.

## CRDT Collaborative Editing (optional)

The engine includes an optional Yjs-based CRDT subsystem for real-time collaborative document editing. Enable it by adding `crdt` to your `initEngine()` config:

```ts
initEngine({
  prefix: 'myapp',
  tables: [...],
  database: { name: 'myapp-db', versions: [...] },
  crdt: {
    persistIntervalMs: 30000,     // Persist to Supabase every 30s
    maxOfflineDocuments: 50,       // Max docs stored offline
  },
});
```

Then use the `@prabhask5/stellar-engine/crdt` subpath:

```ts
import {
  openDocument, closeDocument,
  createSharedText, createBlockDocument,
  updateCursor, getCollaborators, onCollaboratorsChange,
  enableOffline, disableOffline,
  type YDoc, type YText,
} from '@prabhask5/stellar-engine/crdt';

// Open a collaborative document
const provider = await openDocument('doc-1', 'page-1', {
  offlineEnabled: true,
  initialPresence: { name: 'Alice' },
});

// Use with any Yjs-compatible editor (Tiptap, BlockNote, etc.)
const { content, meta } = createBlockDocument(provider.doc);
meta.set('title', 'My Page');

// Track collaborator cursors
const unsub = onCollaboratorsChange('doc-1', (collaborators) => {
  // Update avatar list, cursor positions, etc.
});

// Close when done
await closeDocument('doc-1');
```

Key features:
- **Real-time multi-user editing** via Supabase Broadcast (zero DB writes per keystroke)
- **Cursor/presence awareness** via Supabase Presence
- **Offline-first** with IndexedDB persistence and crash recovery
- **Periodic Supabase persistence** (every 30s) for durable cross-device storage
- **Cross-tab sync** via browser BroadcastChannel API (avoids network for same-device)
- **Consumers never import yjs** -- all Yjs types are re-exported from the engine

## License

Private -- not yet published under an open-source license.
