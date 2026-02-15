# @prabhask5/stellar-engine -- Frameworks & Libraries

The `@prabhask5/stellar-engine` package is an offline-first, local-first sync engine for web applications. It handles bidirectional synchronization between a local IndexedDB database and a remote Supabase PostgreSQL backend, using intent-based operations, operation coalescing, and three-tier conflict resolution. The engine is designed to be consumed by any frontend application; Svelte integration is provided as an optional peer dependency.

---

## Table of Contents

1. [Dexie.js / IndexedDB (Local Database)](#1-dexiejs--indexeddb-local-database)
2. [Supabase (Backend-as-a-Service)](#2-supabase-backend-as-a-service)
3. [Sync System (Custom Sync Engine)](#3-sync-system-custom-sync-engine)
4. [Svelte (Optional Peer Dependency)](#4-svelte-optional-peer-dependency)
5. [TypeScript (Language)](#5-typescript-language)

---

## 1. Dexie.js / IndexedDB (Local Database)

### What is IndexedDB?

IndexedDB is a database built into every modern web browser. Unlike `localStorage` (which only stores strings), IndexedDB is a full object database that can store complex JavaScript objects, supports indexes for fast queries, and can hold megabytes of data. It is asynchronous (non-blocking) and works entirely offline.

### What is Dexie.js?

Dexie.js is a wrapper library around IndexedDB that provides a friendlier API. Raw IndexedDB requires verbose, callback-based code with request objects and event handlers. Dexie replaces that with a clean, Promise-based API that supports queries, transactions, and live queries (reactive queries that automatically re-run when data changes).

### System Tables Used by the Engine

The engine requires five system tables in the consumer application's Dexie database. These are local-only and never synced to the server:

| Table | Schema | Purpose |
|-------|--------|---------|
| `syncQueue` | `++id, table, entityId, timestamp` | **Outbox** for pending sync operations. Auto-incrementing ID ensures FIFO ordering. Stores intent-based operations (create/set/increment/delete) that are pushed to the server in background. |
| `offlineCredentials` | `id` | **Singleton** (`id = 'current_user'`). Caches user email, password, and profile for offline login and reconnect credential validation. |
| `offlineSession` | `id` | **Singleton** (`id = 'current_session'`). Stores an offline session token (UUID) so the app can authenticate users locally when the network is unavailable. |
| `singleUserConfig` | `id` | **Singleton** (`id = 'config'`). Stores single-user mode configuration: gate hash (SHA-256 for offline fallback), gate type, email, profile, and Supabase user ID. Only used when `auth.mode` is `'single-user'`. |
| `conflictHistory` | `++id, entityId, entityType, timestamp` | **Diagnostic log** of field-level conflict resolutions. Records which fields conflicted, the local/remote values, the resolved value, and the strategy used. Automatically cleaned up after 30 days. |

### The Repository Pattern

The engine does not own entity tables. Consumer applications define their own Dexie schema and entity tables, then implement repository functions that use the engine's queue operations. The pattern is:

1. **Write to local DB** (IndexedDB via Dexie) -- instant, no network required
2. **Queue a sync operation** (into the `syncQueue` table) -- records the intent
3. **Schedule a sync push** (tells the engine to push soon) -- debounced background work

These three steps are wrapped in a single Dexie transaction to guarantee atomicity:

```typescript
import { queueCreateOperation, scheduleSyncPush, markEntityModified } from '@prabhask5/stellar-engine';
import { db } from './schema'; // Consumer's Dexie database

export async function createItem(name: string) {
  const newItem = { id: crypto.randomUUID(), name, created_at: new Date().toISOString() };

  // Atomic transaction: local write + queue entry succeed or fail together
  await db.transaction('rw', [db.items, db.syncQueue], async () => {
    await db.items.add(newItem);
    await queueCreateOperation('items', newItem.id, { name, created_at: newItem.created_at });
  });

  markEntityModified(newItem.id);  // Protect from being overwritten by pull
  scheduleSyncPush();              // Tell sync engine to push soon

  return newItem;
}
```

The engine exports queue helpers for all four operation types:

- `queueCreateOperation(table, entityId, payload)` -- new entity
- `queueSetOperation(table, entityId, field, value)` -- set a single field
- `queueMultiFieldSetOperation(table, entityId, fields)` -- set multiple fields
- `queueIncrementOperation(table, entityId, field, delta)` -- increment a numeric field
- `queueDeleteOperation(table, entityId)` -- soft-delete

### Schema Versioning

The engine does not manage the consumer's Dexie schema versions. Consumer applications define their own `this.version(N).stores({...})` chain, including both their entity tables and the five system tables listed above. When adding a new entity table or modifying indexes, the consumer bumps the version number and provides an upgrade function. Dexie handles the migration automatically when the database is opened.

### Transactions

Dexie transactions are critical for the engine's correctness guarantee: **if data is written locally, a sync operation is always queued for it**. The `'rw'` (read-write) transaction mode ensures that both the entity write and the queue entry either both succeed or both roll back. The engine also uses transactions internally for batch operations like coalescing, pull-phase merges, and tombstone cleanup.

---

## 2. Supabase (Backend-as-a-Service)

### What is Supabase?

Supabase is an open-source backend platform that provides:

- **PostgreSQL database** -- stores all synced user data on the server.
- **Authentication** -- email/password auth with session management, token refresh, and PKCE flow.
- **Realtime** -- WebSocket-based subscriptions that push database changes to connected clients in real time.
- **Row Level Security (RLS)** -- PostgreSQL policies that ensure users can only read/write their own data, enforced at the database level.
- **REST API** -- auto-generated CRUD endpoints for every table (powered by PostgREST).

Supabase is self-hostable. The engine is designed for applications where users deploy their own Supabase instance.

### Runtime Configuration

The engine uses runtime configuration instead of build-time environment variables. This allows a single build artifact to be deployed against different Supabase instances.

**`src/runtime/runtimeConfig.ts`** (`/Users/prabhask/Documents/Projects/stellar/stellar-engine/src/runtime/runtimeConfig.ts`):

```typescript
export interface AppConfig {
  supabaseUrl: string;      // e.g., https://your-project.supabase.co
  supabaseAnonKey: string;  // Public anonymous key
  configured: boolean;
}
```

The configuration lifecycle:

1. `initConfig()` -- tries localStorage first for instant load, then fetches from the server (`/api/config`) to validate/update. If offline, falls back to cached config.
2. `getConfig()` -- synchronous getter, returns cached config or loads from localStorage.
3. `waitForConfig()` -- async, resolves when config is available.
4. `setConfig(config)` -- used after initial setup wizard completes.
5. `clearConfigCache()` -- clears localStorage cache.

All keys are prefixed with a configurable app prefix (e.g., `stellar_config`) to avoid collisions when multiple apps share the same origin.

### Proxy-Based Lazy Supabase Client

**`src/supabase/client.ts`** (`/Users/prabhask/Documents/Projects/stellar/stellar-engine/src/supabase/client.ts`):

The Supabase client uses a **Proxy-based lazy singleton** pattern. Consumer code imports `supabase` and uses it directly; the actual `SupabaseClient` is created on first property access, after runtime config is available:

```typescript
let realClient: SupabaseClient | null = null;

function getOrCreateClient(): SupabaseClient {
  if (realClient) return realClient;
  const config = getConfig();
  realClient = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: `${prefix}-auth`,
      flowType: 'pkce'
    }
  });
  return realClient;
}

export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getOrCreateClient();
    const value = Reflect.get(client, prop, receiver);
    if (typeof value === 'function') return value.bind(client);
    return value;
  }
});
```

This avoids initialization-order issues. The `getSupabaseAsync()` function is also exported for contexts where config may not yet be loaded.

### Auth Features

The engine provides a full auth module (`src/supabase/auth.ts`) with:

- **PKCE flow** -- more secure than implicit flow, works well with PWAs.
- **Auto token refresh** -- Supabase client is configured with `autoRefreshToken: true`; tokens are refreshed before expiry.
- **Corrupted data cleanup** -- on startup, any malformed Supabase auth data in localStorage (keys starting with `sb-`) is detected and cleared. An unhandled rejection handler catches runtime auth errors and auto-recovers.
- **iOS PWA detection** -- detects standalone mode (`navigator.standalone` or `display-mode: standalone` media query) and applies enhanced auth persistence. iOS can evict localStorage data when the PWA is backgrounded; the engine logs these events for debugging.
- **Offline credential caching** -- on successful login, credentials are cached in IndexedDB (`offlineCredentials` table). On reconnect after offline use, credentials are re-validated before sync is allowed.
- **Single-user email/password auth** -- the user provides a real email during setup. The PIN code or password is padded to meet Supabase's minimum password length and used as the actual Supabase password via `supabase.auth.signUp()` / `supabase.auth.signInWithPassword()`. This gives the user a real `auth.uid()` for RLS compliance. Optional email confirmation (`emailConfirmation.enabled`) and device verification (`deviceVerification.enabled`) add security layers. Email changes are supported via `changeSingleUserEmail()` which triggers a Supabase confirmation email flow.
- **Session management** -- `getSession()`, `isSessionExpired()`, offline session fallback from localStorage.
- **Profile management** -- configurable `profileExtractor` and `profileToMetadata` functions in engine config for app-specific profile shapes.

### Realtime: WebSocket Subscriptions

**`src/realtime.ts`** (`/Users/prabhask/Documents/Projects/stellar/stellar-engine/src/realtime.ts`):

The engine uses Supabase Realtime (PostgreSQL Changes over WebSocket) for instant multi-device sync. Design decisions:

1. **Single consolidated channel per user** -- one WebSocket channel (`{prefix}_sync_{userId}`) subscribes to all configured entity tables. This is more efficient than one channel per table.
2. **Echo suppression** -- each record carries a `device_id`. Changes from the current device are ignored to prevent echo.
3. **Duplicate prevention** -- recently processed entities are tracked with a 2-second TTL map, preventing the same change from being applied by both realtime and polling.
4. **Conflict-aware** -- incoming realtime changes go through the same three-tier conflict resolution engine as polled changes.
5. **Graceful degradation** -- if the WebSocket fails, it retries with exponential backoff (1s, 2s, 4s, 8s, 16s) up to 5 attempts, then falls back to polling only.
6. **Offline-aware** -- reconnection attempts are paused while offline (`pauseRealtime()`) and resumed when the browser fires the `online` event.

---

## 3. Sync System (Custom Sync Engine)

### Overview

The sync system is the core of this package. It enables offline-first multi-device operation using an **outbox pattern** with **intent-based operations** and **three-tier conflict resolution**.

```
+------------------+          +-------------------+          +------------------+
|   User Action    |          |   Sync Engine     |          |   Supabase       |
|                  |          |                   |          |   (PostgreSQL)   |
|  1. Write to     |  push    |  3. Read outbox   |  HTTP    |                  |
|     IndexedDB    |--------->|  4. Transform ops  |--------->|  5. Apply to DB  |
|  2. Queue to     |          |     to mutations  |          |                  |
|     syncQueue    |          |                   |  pull    |                  |
|                  |<---------|  6. Pull changes   |<---------|  7. Return delta |
|  8. Merge into   |          |     since cursor  |          |                  |
|     IndexedDB    |          |                   |          |                  |
+------------------+          +-------------------+          +------------------+
                                      |
                                      | WebSocket
                                      v
                              +-------------------+
                              |  Realtime Layer   |
                              |  (instant push    |
                              |   from other      |
                              |   devices)        |
                              +-------------------+
```

### The Five Rules of Local-First Sync

From the engine header comment (`/Users/prabhask/Documents/Projects/stellar/stellar-engine/src/engine.ts`):

```
1. All reads come from local DB (IndexedDB)
2. All writes go to local DB first, immediately
3. Every write creates a pending operation in the outbox
4. Sync loop ships outbox to server in background
5. On refresh, load local state instantly, then run background sync
```

### Intent-Based Operations

Instead of syncing raw data diffs, the engine records the **intent** of each user action. This preserves semantic meaning during conflict resolution and enables operation coalescing.

There are four operation types:

| Operation | Intent | Example |
|-----------|--------|---------|
| `create` | A new entity was created | User creates a new task |
| `set` | A field (or fields) was explicitly set to a value | User renames a task |
| `increment` | A numeric field was incremented by a delta | User taps +1 on a counter |
| `delete` | An entity was soft-deleted | User deletes a task |

The `increment` operation is particularly important. Instead of recording "current_value is now 5," it records "current_value was incremented by +1." This allows the coalescing engine to sum deltas locally (e.g., 50 rapid +1 taps become a single +50 operation).

Each operation is stored in the `syncQueue` table:

```typescript
interface SyncOperationItem {
  id?: number;           // Auto-increment queue ID
  table: string;         // Target table (e.g., 'goals')
  entityId: string;      // UUID of the entity
  operationType: 'create' | 'set' | 'increment' | 'delete';
  field?: string;        // Specific field (for set/increment)
  value?: unknown;       // New value or delta
  timestamp: string;     // ISO timestamp
  retries: number;       // Number of push attempts
}
```

### Operation Coalescing

Before pushing, the queue is coalesced to minimize server requests. Coalescing is performed entirely in memory with a single DB read and batch write at the end.

**`src/queue.ts`** (`/Users/prabhask/Documents/Projects/stellar/stellar-engine/src/queue.ts`):

The 11 coalescing rules, organized in 6 steps:

```
Step 1-2: Entity-level coalescing
  Rule 1:  CREATE -> DELETE                → Cancel both (entity never existed on server)
  Rule 2:  CREATE -> UPDATE(s) -> DELETE   → Cancel all (net effect is nothing)
  Rule 3:  UPDATE(s) -> DELETE             → Keep only DELETE
  Rule 4:  CREATE -> SET(s)               → Merge sets into create payload
  Rule 5:  CREATE -> INCREMENT(s)         → Sum deltas into create payload

Step 3: Increment coalescing
  Rule 6:  Multiple INCREMENTs (same field) → Sum deltas (e.g., +1, +1, +1 = +3)

Step 4: Set coalescing
  Rule 7:  Multiple SETs (same entity)      → Merge into single set (last value wins)

Step 5: Field interaction coalescing
  Rule 8:  SET followed by INCREMENT(s) on same field → Add delta to set value
  Rule 9:  Operations before last SET on same field   → Delete (overwritten)

Step 6: No-op removal
  Rule 10: Zero-delta increments           → Delete (no effect)
  Rule 11: Empty sets or updated_at-only   → Delete (no meaningful change)
```

### Push/Pull Sync Cycle

The sync engine (`/Users/prabhask/Documents/Projects/stellar/stellar-engine/src/engine.ts`) runs a push/pull cycle:

```
SYNC CYCLE
==========

1. PUSH PHASE (local -> server)
   a. Pre-flight auth validation (getCurrentUserId)
   b. Coalesce pending operations
   c. For each operation in the outbox:
      - Transform to Supabase mutation (insert/update/delete)
      - Execute against Supabase REST API with .select() verification
      - On success: remove from outbox
      - On failure: increment retry counter (max 5 retries, exponential backoff)
   d. Singleton reconciliation: if server has a different ID for a singleton
      entity, reconcile the local ID and purge stale queue entries

2. PULL PHASE (server -> local)
   a. Pull all tables in parallel (egress optimization)
   b. For each remote record:
      * Skip if recently modified locally (2s protection window)
      * Skip if recently processed by realtime (prevents duplicate)
      * If no local entity: accept remote
      * If remote is not newer: skip
      * If no pending ops: accept remote
      * If has pending ops: run through conflict resolution
   c. Update the sync cursor to the latest timestamp (per-user)
   d. Egress optimization: skip pull when realtime is healthy (push-only mode)

3. POST-SYNC
   a. Clean up failed items (> 5 retries)
   b. Clean up old tombstones (configurable, default 1 day)
   c. Clean up old conflict history (> 30 days)
   d. Clean up recently modified entity cache
   e. Update sync status store (for UI indicator)
   f. Notify registered callbacks (stores refresh from local DB)
```

Additional sync features:
- **Mutex lock** with 60-second timeout and watchdog to prevent concurrent syncs and detect stuck operations.
- **Operation timeouts** (45 seconds per push/pull phase).
- **Hydration**: on first load with empty local DB, pulls all non-deleted records.
- **Reconciliation**: after re-login, detects orphaned local changes (modified after cursor but no queue entries) and re-queues them.
- **Tab visibility**: skips background sync when tab is hidden; runs quiet sync on return if away > 5 minutes and realtime is disconnected.
- **Online reconnect cooldown** (configurable, default 2 minutes): prevents redundant syncs on frequent iOS PWA network transitions.
- **Egress monitoring**: tracks bytes and records per table per sync cycle, with debug utilities exposed on `window`.

### Three-Tier Conflict Resolution

**`src/conflicts.ts`** (`/Users/prabhask/Documents/Projects/stellar/stellar-engine/src/conflicts.ts`):

When the pull phase (or realtime) finds a remote record that conflicts with a local record, the conflict resolution engine applies three tiers:

```
CONFLICT RESOLUTION TIERS
==========================

Tier 1: NON-OVERLAPPING CHANGES (different entities)
  -> Auto-merge. No conflict. Each entity is independent.

Tier 2: DIFFERENT FIELDS on the same entity
  -> Auto-merge fields. If Device A changed "name" and Device B
     changed "completed," both changes are kept.

Tier 3: SAME FIELD on the same entity
  -> Apply resolution strategy:

     a. PENDING LOCAL OPS: If the field has pending local operations
        that haven't been pushed yet, local wins. The push will
        send the latest local value.

     b. DELETE WINS: If either side deleted the entity, the delete
        wins. This prevents resurrection of deleted entities.

     c. LAST-WRITE-WINS: Compare updated_at timestamps. The more
        recent write wins. If timestamps are identical, use device_id
        as a deterministic tiebreaker (lower device_id wins).
```

Per-table configuration allows customizing conflict behavior:
- `excludeFromConflict`: fields to skip during conflict resolution (in addition to defaults: `id`, `user_id`, `created_at`, `_version`).
- `numericMergeFields`: fields eligible for numeric merge (currently resolved via last-write-wins; true delta merge would require an operation inbox on the server).

Conflict resolutions are recorded in the `conflictHistory` table:

```typescript
interface ConflictHistoryEntry {
  entityId: string;
  entityType: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  resolvedValue: unknown;
  winner: 'local' | 'remote' | 'merged';
  strategy: string;  // 'last_write' | 'numeric_merge' | 'delete_wins' | 'local_pending'
  timestamp: string;
}
```

### Realtime Subscriptions

See the [Supabase Realtime section](#realtime-websocket-subscriptions) above. The realtime layer feeds into the same conflict resolution engine. Realtime changes also trigger remote change recording for UI animations (via `remoteChangesStore`), with action type detection based on which fields changed (e.g., `completed` changed = toggle, `current_value` changed = increment/decrement, `order` changed = reorder).

### Tombstone System

The engine uses soft deletes exclusively. Entities are never hard-deleted from the local database or the server during normal operation. Instead, a `deleted: true` flag is set:

- **Why**: a hard delete cannot be synced (the record is gone), but a soft delete is just an update that flows through the normal sync pipeline.
- **Queries**: consumer applications filter out soft-deleted records (e.g., `items.filter(item => !item.deleted)`).
- **Cleanup**: tombstones are periodically cleaned up from both local IndexedDB and Supabase. The `tombstoneMaxAgeDays` config (default: 1 day) controls the cutoff. Server cleanup runs at most once per 24 hours to avoid unnecessary requests.
- **Entity metadata**: every entity carries `updated_at` (ISO timestamp, for conflict resolution), `_version` (numeric, incremented on conflict merge), `device_id` (last modifier, for tiebreaking), and `deleted` (boolean soft-delete flag).

---

## 4. Svelte (Optional Peer Dependency)

Svelte is listed as an **optional peer dependency** in `package.json`. The core sync functionality (engine, queue, conflicts, realtime, auth, config) works without Svelte. However, if Svelte is available, the engine provides reactive stores and DOM actions for UI integration.

### Svelte Stores

The engine exports four Svelte stores built with `writable` and `derived` from `svelte/store`:

| Store | File | Purpose |
|-------|------|---------|
| `syncStatusStore` | `src/stores/sync.ts` | Tracks sync status (`idle`/`syncing`/`error`/`offline`), pending count, error messages, last sync time, tab visibility, and realtime connection state. Includes minimum syncing display time (500ms) to prevent UI flickering. |
| `authState` | `src/stores/authState.ts` | Tracks authentication mode (`supabase`/`offline`/`none`), current session, offline profile, loading state, and auth-kicked messages. Also exports `isAuthenticated` and `userDisplayInfo` as derived stores. |
| `isOnline` | `src/stores/network.ts` | Reactive boolean tracking network connectivity. Provides `onReconnect()` and `onDisconnect()` callback registration. Handles iOS PWA-specific visibility change events. |
| `remoteChangesStore` | `src/stores/remoteChanges.ts` | Manages incoming remote changes for UI animation. Detects action types (create/delete/toggle/increment/decrement/reorder/rename/update) from field-level diffs. Supports editing state tracking and deferred change application for modal forms. |

### Svelte Actions

The engine exports three Svelte actions from `src/actions/remoteChange.ts`:

**`remoteChangeAnimation`** -- attaches to list items or cards to automatically animate when remote changes arrive:

```svelte
<div use:remoteChangeAnimation={{ entityId: item.id, entityType: 'goals' }}>
  ...
</div>
```

Maps action types to CSS classes: `item-created`, `item-deleting`, `item-toggled`, `counter-increment`, `counter-decrement`, `item-reordering`, `text-changed`, `item-changed`. Handles checkbox animations, completion ripple effects, and counter animations. Supports pending delete animations (plays animation before DOM removal).

**`trackEditing`** -- attaches to form elements to protect user edits from remote overwrites:

```svelte
<form use:trackEditing={{ entityId: item.id, entityType: 'goals', formType: 'manual-save' }}>
  ...
</form>
```

Auto-save forms apply remote changes immediately with animation. Manual-save forms defer changes until the form closes, then notify via callback.

**`triggerLocalAnimation`** -- programmatically triggers the same animations for local actions:

```typescript
import { triggerLocalAnimation } from '@prabhask5/stellar-engine';
triggerLocalAnimation(element, 'toggle');
```

### Note on Framework Independence

The Svelte stores and actions are the only parts of the engine that import from `svelte/store`. All core modules (engine, queue, conflicts, realtime, auth, config, deviceId, debug, utils) are framework-agnostic TypeScript. If a consumer application does not use Svelte, the stores and actions are simply not imported and tree-shaken away.

---

## 5. TypeScript (Language)

### Configuration

**`tsconfig.json`** (`/Users/prabhask/Documents/Projects/stellar/stellar-engine/tsconfig.json`):

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

Key settings:

| Option | Purpose |
|--------|---------|
| `strict: true` | Enables all strict type-checking options (no implicit `any`, strict null checks, etc.). |
| `declaration: true` | Generates `.d.ts` type declaration files alongside the JavaScript output, so consumer apps get full type information and IDE support. |
| `declarationMap: true` | Generates `.d.ts.map` files that link declarations back to the original TypeScript source, enabling "Go to Definition" to navigate to the engine's source code. |
| `target: ES2020` | Targets modern browsers with native async/await, optional chaining, and nullish coalescing. |
| `moduleResolution: "bundler"` | Uses bundler-style resolution, matching how Vite and other modern tools resolve imports. |

### Type Exports

The engine exports all public types from `src/index.ts` for consumer applications:

- `SyncEngineConfig`, `TableConfig` -- engine initialization configuration
- `SyncOperationItem`, `OperationType` -- outbox operation types
- `OfflineCredentials`, `OfflineSession` -- offline auth types
- `SingleUserConfig`, `SingleUserGateType` -- single-user mode types
- `ConflictHistoryEntry` -- conflict resolution records
- `SyncStatus`, `AuthMode` -- status enums
- `AppConfig` -- runtime configuration shape
- `RealtimeConnectionState` -- WebSocket state
- `SyncError`, `RealtimeState` -- store-related types
- `RemoteActionType` -- detected action types for animations
Consumer apps use these types to implement their repositories, configure the engine, and build type-safe UI integrations.
