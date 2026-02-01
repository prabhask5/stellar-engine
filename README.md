# @stellar/sync-engine

A local-first, offline-capable sync engine for **SvelteKit + Supabase + Dexie** applications. All reads come from IndexedDB, all writes land locally first, and a background sync loop ships changes to Supabase -- so your app stays fast and functional regardless of network state.

## Documentation

- [API Reference](./API_REFERENCE.md) -- full signatures, parameters, and usage examples for every public export
- [Architecture](./ARCHITECTURE.md) -- internal design, data flow, and module responsibilities
- [Framework Integration](./FRAMEWORKS.md) -- SvelteKit-specific patterns and conventions

## Features

- **Intent-based sync operations** -- operations preserve intent (`increment`, `set`, `create`, `delete`) instead of just final state, enabling smarter coalescing and conflict handling.
- **Three-tier conflict resolution** -- field-level diffing, numeric merge fields, and configurable exclusion lists let you resolve conflicts precisely rather than with blanket last-write-wins.
- **Offline authentication** -- credential caching and offline session tokens let users sign in and work without connectivity; sessions reconcile automatically on reconnect.
- **Realtime subscriptions** -- Supabase Realtime channels push remote changes into local state instantly, with duplicate-delivery guards to prevent re-processing.
- **Operation coalescing** -- batches of rapid local writes (e.g., 50 individual increments) are compressed into a single outbound operation, reducing sync traffic dramatically.
- **Tombstone management** -- soft deletes are propagated cleanly, and stale tombstones are garbage-collected after a configurable retention period.
- **Egress optimization** -- column-level select lists and ownership filters ensure only the data your client needs is fetched from Supabase.

## Quick start

Install from a Git URL (the package is not yet published to npm):

```bash
npm install git+https://github.com/prabhask/stellar-engine.git
```

Initialize the engine at app startup (e.g., in a SvelteKit layout load function or `hooks.client.ts`):

```ts
import { initEngine, startSyncEngine, initConfig } from '@stellar/sync-engine';
import { supabase } from './supabase'; // your SupabaseClient instance
import { db } from './db';             // your Dexie database instance

initEngine({
  prefix: 'myapp',
  supabase,
  db,
  tables: [
    {
      supabaseName: 'projects',
      dexieTable: 'projects',
      columns: 'id, name, created_at, updated_at, is_deleted, user_id',
      ownershipFilter: 'user_id',
    },
    {
      supabaseName: 'tasks',
      dexieTable: 'tasks',
      columns: 'id, title, completed, project_id, sort_order, updated_at, is_deleted, user_id',
      ownershipFilter: 'user_id',
      numericMergeFields: ['sort_order'],
      excludeFromConflict: ['updated_at'],
    },
    {
      supabaseName: 'user_settings',
      dexieTable: 'userSettings',
      columns: 'id, theme, notifications_enabled, updated_at, user_id',
      ownershipFilter: 'user_id',
      isSingleton: true,
    },
  ],

  // Optional tuning
  syncDebounceMs: 2000,       // debounce before pushing (default: 2000)
  syncIntervalMs: 900000,     // background full-sync interval (default: 15 min)
  tombstoneMaxAgeDays: 1,     // garbage-collect soft deletes after N days
  auth: {
    enableOfflineAuth: true,
    sessionValidationIntervalMs: 300000,
  },
});

await startSyncEngine();
```

## Requirements

**Supabase**

Your Supabase project needs tables matching the `supabaseName` entries in your config. Each table should have at minimum:
- `id` (uuid primary key)
- `updated_at` (timestamptz) -- used as the sync cursor
- `is_deleted` (boolean, default false) -- for soft-delete / tombstone support
- An ownership column (e.g., `user_id`) if you use `ownershipFilter`

Row-Level Security policies should scope reads and writes to the authenticated user.

**Dexie (IndexedDB)**

Your Dexie database must include two system tables alongside your application tables:

```ts
const db = new Dexie('myapp');
db.version(1).stores({
  // System tables (required by the engine)
  syncQueue: '++id, table, entityId, operationType, timestamp',
  conflictHistory: '++id, entityId, entityType, timestamp',

  // Your application tables
  projects: 'id, user_id, updated_at',
  tasks: 'id, project_id, user_id, updated_at',
  userSettings: 'id, user_id',
});
```

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
| `SyncEngineConfig` / `TableConfig` | TypeScript interfaces for the config objects. |

### Engine lifecycle

| Export | Description |
|---|---|
| `startSyncEngine()` | Start the sync loop, realtime subscriptions, and event listeners. |
| `stopSyncEngine()` | Tear down everything cleanly. |
| `scheduleSyncPush()` | Trigger a debounced push of pending operations. |
| `runFullSync()` | Run a complete pull-then-push cycle. |
| `forceFullSync()` | Full sync ignoring debounce / cooldown. |
| `resetSyncCursor()` | Clear the stored cursor so the next sync pulls all data. |
| `hydrateFromRemote()` | Pull all remote data into local DB (first-load scenario). |
| `reconcileLocalWithRemote()` | Merge remote state with local pending changes. |
| `performSync()` | Single push cycle (coalesce, push, handle errors). |
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
| `markOffline` / `markAuthValidated` / `needsAuthValidation` | Engine-level auth state transitions. |

### Offline auth

| Export | Description |
|---|---|
| `cacheOfflineCredentials` / `getOfflineCredentials` / `verifyOfflineCredentials` / `clearOfflineCredentials` | Store and verify credentials locally for offline sign-in. |
| `createOfflineSession` / `getValidOfflineSession` / `hasValidOfflineSession` / `clearOfflineSession` | Manage offline session tokens in IndexedDB. |

### Queue

| Export | Description |
|---|---|
| `queueSyncOperation(item)` | Enqueue a raw `SyncOperationItem`. |
| `queueIncrementOperation(table, id, field, delta)` | Enqueue a numeric increment. |
| `queueSetOperation(table, id, field, value)` | Enqueue a single-field set. |
| `queueMultiFieldSetOperation(table, id, fields)` | Enqueue a multi-field set. |
| `queueCreateOperation(table, id, payload)` | Enqueue entity creation. |
| `queueDeleteOperation(table, id)` | Enqueue a soft delete. |
| `coalescePendingOps()` | Compress the outbox in-place (called automatically before push). |
| `getPendingSync()` / `getPendingEntityIds()` | Inspect the current outbox. |

### Conflict resolution

| Export | Description |
|---|---|
| `resolveConflicts(table, localEntity, remoteEntity, pendingOps)` | Three-tier field-level conflict resolver. Returns the merged entity. |
| `getConflictHistory()` | Retrieve stored conflict resolution records. |

### Realtime

| Export | Description |
|---|---|
| `startRealtimeSubscriptions()` / `stopRealtimeSubscriptions()` | Manage Supabase Realtime channels for all configured tables. |
| `isRealtimeHealthy()` / `getConnectionState()` | Health checks. |
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
| `getDeviceId()` | Stable per-device identifier (persisted in localStorage). |
| `debugLog` / `debugWarn` / `debugError` | Prefixed console helpers (gated by `setDebugMode`). |
| `setReconnectHandler` / `callReconnectHandler` | Hook for custom reconnect logic. |

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
