# @prabhask5/stellar-engine

A local-first, offline-capable sync engine for **SvelteKit + Supabase + Dexie** applications. All reads come from IndexedDB, all writes land locally first, and a background sync loop ships changes to Supabase -- so your app stays fast and functional regardless of network state.

## Documentation

- [API Reference](./API_REFERENCE.md) -- full signatures, parameters, and usage examples for every public export
- [Architecture](./ARCHITECTURE.md) -- internal design, data flow, and module responsibilities
- [Framework Integration](./FRAMEWORKS.md) -- SvelteKit-specific patterns and conventions

## Features

- **Intent-based sync operations** -- operations preserve intent (`increment`, `set`, `create`, `delete`) instead of just final state, enabling smarter coalescing and conflict handling.
- **Three-tier conflict resolution** -- field-level diffing, numeric merge fields, and configurable exclusion lists let you resolve conflicts precisely rather than with blanket last-write-wins.
- **Offline authentication** -- credential caching and offline session tokens let users sign in and work without connectivity; sessions reconcile automatically on reconnect.
- **Single-user auth mode** -- for personal apps, replace email/password with a local PIN code or password gate backed by Supabase anonymous auth. Setup, unlock, lock, and gate change are all handled by the engine with full offline support.
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

For personal apps with a PIN code gate instead of email/password:

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
    mode: 'single-user',
    singleUser: { gateType: 'code', codeLength: 4 },
    enableOfflineAuth: true,
  },
});

await initConfig();
const auth = await resolveAuthState();

if (!auth.singleUserSetUp) {
  // Show setup screen → call setupSingleUser(code, profile)
} else if (auth.authMode === 'none') {
  // Show unlock screen → call unlockSingleUser(code)
} else {
  await startSyncEngine();
}
```

## Subpath exports

Import only what you need via subpath exports:

| Subpath | Contents |
|---|---|
| `@prabhask5/stellar-engine` | `initEngine`, `startSyncEngine`, `runFullSync`, `supabase`, `getDb`, `validateSupabaseCredentials`, `validateSchema` |
| `@prabhask5/stellar-engine/data` | All engine CRUD + query operations (`engineCreate`, `engineUpdate`, etc.) |
| `@prabhask5/stellar-engine/auth` | All auth functions (`signIn`, `signUp`, `resolveAuthState`, `isAdmin`, single-user: `setupSingleUser`, `unlockSingleUser`, `lockSingleUser`, etc.) |
| `@prabhask5/stellar-engine/stores` | Reactive stores + event subscriptions (`syncStatusStore`, `authState`, `onSyncComplete`, etc.) |
| `@prabhask5/stellar-engine/types` | All type exports (`Session`, `SyncEngineConfig`, `BatchOperation`, `SingleUserConfig`, etc.) |
| `@prabhask5/stellar-engine/utils` | Utility functions (`generateId`, `now`, `calculateNewOrder`, `snakeToCamel`, `debug`, etc.) |
| `@prabhask5/stellar-engine/actions` | Svelte `use:` actions (`remoteChangeAnimation`, `trackEditing`, `triggerLocalAnimation`) |
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

Single-user mode requires a `single_user_config` table in Supabase for multi-device config sync:

```sql
CREATE TABLE single_user_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_type text NOT NULL DEFAULT 'code',
  code_length integer,
  gate_hash text NOT NULL,
  profile jsonb NOT NULL DEFAULT '{}',
  setup_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_deleted boolean NOT NULL DEFAULT false,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE
);

-- Enable RLS
ALTER TABLE single_user_config ENABLE ROW LEVEL SECURITY;

-- RLS policy: authenticated users (anonymous sessions) can manage their own row
CREATE POLICY "Users can manage their own config"
  ON single_user_config FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

You must also enable **"Allow anonymous sign-ins"** in your Supabase project under Authentication > Settings.

**Schema validation:** The engine automatically validates that all configured tables (and `single_user_config` in single-user mode) exist in Supabase on the first sync. Missing tables are reported via `syncStatusStore` and the debug console.

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

### Auth

| Export | Description |
|---|---|
| `signIn` / `signUp` / `signOut` | Supabase auth wrappers that also manage offline credential caching. |
| `getSession` / `isSessionExpired` | Session inspection helpers. |
| `changePassword` / `resendConfirmationEmail` | Account management. |
| `getUserProfile` / `updateProfile` | Profile read/write via Supabase user metadata. |

### Offline auth

| Export | Description |
|---|---|
| `cacheOfflineCredentials` / `getOfflineCredentials` / `verifyOfflineCredentials` / `clearOfflineCredentials` | Store and verify credentials locally for offline sign-in. |
| `createOfflineSession` / `getValidOfflineSession` / `clearOfflineSession` | Manage offline session tokens in IndexedDB. |

### Single-user auth

For personal apps that don't need email/password accounts. Uses a local PIN code or password gate with Supabase anonymous auth behind the scenes. Enable by setting `auth.mode: 'single-user'` in the engine config. Requires "Allow anonymous sign-ins" enabled in Supabase Authentication settings.

| Export | Description |
|---|---|
| `isSingleUserSetUp()` | Check if initial setup is complete. |
| `getSingleUserInfo()` | Get display info (profile, gate type) for the unlock screen. |
| `setupSingleUser(gate, profile)` | First-time setup: create gate, anonymous Supabase user, and store config. |
| `unlockSingleUser(gate)` | Verify gate and restore session (online or offline). |
| `lockSingleUser()` | Stop sync and reset auth state without destroying data. |
| `changeSingleUserGate(oldGate, newGate)` | Change the PIN code or password. |
| `updateSingleUserProfile(profile)` | Update profile in IndexedDB and Supabase metadata. |
| `resetSingleUser()` | Full reset: clear config, sign out, wipe local data. |

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

## Use cases

- **Productivity and task management apps** -- offline-capable task boards, habit trackers, daily planners with cross-device sync.
- **Notion-like editors** -- block-based documents where each block is a synced entity with field-level conflict resolution.
- **Personal finance trackers** -- numeric merge fields handle concurrent balance adjustments across devices.
- **File and asset management UIs** -- fractional ordering keeps drag-and-drop sort order consistent without rewriting every row.

## License

Private -- not yet published under an open-source license.
