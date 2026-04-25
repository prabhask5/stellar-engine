# stellar-drive: Architecture & System Design

> **What this document covers:** This is the complete architectural reference for stellar-drive, an offline-first sync engine for Supabase + Dexie.js applications. It explains every major subsystem -- how it works, why it was designed that way, and where to find the code.
>
> **Who it's for:** Developers (human or AI) who need to understand, modify, or extend the codebase. No prior knowledge of stellar-drive is assumed. Familiarity with TypeScript, IndexedDB concepts, and Supabase basics is helpful but not required -- key terms are defined as they appear.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Schema-Driven Configuration](#2-schema-driven-configuration)
3. [Database Management](#3-database-management)
4. [Intent-Based Sync Operations](#4-intent-based-sync-operations)
5. [Operation Coalescing Pipeline](#5-operation-coalescing-pipeline)
6. [Sync Cycle Orchestration](#6-sync-cycle-orchestration)
7. [Three-Tier Conflict Resolution](#7-three-tier-conflict-resolution)
8. [Realtime Subscriptions](#8-realtime-subscriptions)
9. [Authentication System](#9-authentication-system)
10. [Data Operations](#10-data-operations)
11. [Reactive Stores](#11-reactive-stores)
12. [Svelte Actions](#12-svelte-actions)
13. [Demo Mode](#13-demo-mode)
14. [SQL & TypeScript Generation](#14-sql--typescript-generation)
15. [Diagnostics](#15-diagnostics)
16. [SvelteKit Integration](#16-sveltekit-integration)
17. [CLI Tool](#17-cli-tool)
18. [Vite Plugin Schema Processing](#18-vite-plugin-schema-processing)
19. [File Map](#19-file-map)

---

## 1. High-Level Architecture

stellar-drive is an offline-first, local-first sync engine for **Supabase + Dexie.js** applications. It keeps a local IndexedDB database (via Dexie) synchronized with a remote Supabase database, providing instant reads, background sync, and real-time multi-device collaboration. Optional SvelteKit integrations are included but the core engine works with any framework.

The central idea is simple: **the user's device is the source of truth for reads, and the server is the source of truth for persistence.** All reads happen from the local database (instant, works offline), all writes go to the local database first (no waiting for the network), and a background sync loop reconciles local and remote state.

### 1.1 Data Flow Diagram

```
 +---------------------+
 |   Application UI    |
 |   (Svelte 5 app)    |
 +----------+----------+
            |
            | engineCreate / engineUpdate / engineDelete / engineIncrement
            v
 +---------------------+        +------------------------+
 | Generic CRUD Layer   |       |  Reactive Stores       |
 | (data.ts)            |       |  (stores/*.ts)         |
 |                      |       |                        |
 | All writes:          |       | Subscribe to sync      |
 | 1. Write to Dexie    |       | completion events,     |
 | 2. Queue sync op     |       | re-read from Dexie     |
 | 3. Schedule push     |       | for UI updates         |
 +----------+-----------+       +----------+-------------+
            |                              ^
            v                              |
 +---------------------+                  |
 | Dexie (IndexedDB)   |<---------+-------+
 | - Entity tables      |         |
 | - syncQueue (outbox) |         |
 | - conflictHistory    |         |
 | - offlineCredentials |         |
 +----------+-----------+         |
            ^                     |
            | read/write          | notify sync complete
            v                     |
 +---------------------+----------+-----------+
 |           Sync Engine (engine.ts)           |
 |                                             |
 |  PUSH: coalesce ops -> send to Supabase     |
 |  PULL: fetch changes -> conflict resolve    |
 |         -> write to Dexie -> notify stores  |
 +----------+-----------+----------------------+
            |           ^
            v           |
 +---------------------+---------------------+
 | Supabase                                   |
 |                                             |
 | REST API: CRUD mutations + cursor queries   |
 | Realtime: WebSocket push of remote changes  |
 +---------------------------------------------+
```

### 1.2 Core Rules

These five rules define the fundamental behavior of every stellar-drive application:

```
Rule 1: All reads come from local DB (IndexedDB via Dexie) -- instant, offline
Rule 2: All writes go to local DB first, immediately -- no waiting for network
Rule 3: Every write creates a pending operation in the sync queue (outbox)
Rule 4: Sync loop ships the outbox to the server in the background
Rule 5: On page load, display local state instantly, then run background sync
```

These rules guarantee that the application feels instant regardless of network conditions. Users never wait for a server round-trip for any read or write operation.

### 1.3 Supabase Client Creation

The engine does NOT require a pre-created Supabase client. By default, the engine creates its own Supabase client internally from runtime config (Supabase URL and publishable key fetched from an `/api/config` endpoint and cached in localStorage). The `supabase/client.ts` module exports a proxy-based lazy singleton that defers initialization until first use. A consumer may optionally pass a custom Supabase client via `initEngine({ supabase: myClient })`, but this is not required.

---

Now that we understand the overall architecture, the next section explains how an application tells stellar-drive what data it manages.

## 2. Schema-Driven Configuration

**File**: `src/config.ts`

The schema is the single source of truth for your application's data model. Instead of manually wiring up database tables, sync configuration, and type definitions separately, you declare your schema once and the engine derives everything else.

### 2.1 `initEngine()` -- The Single Entry Point

Every consuming application calls `initEngine()` once at startup before using any other engine function. This single call:

1. Validates and normalizes the configuration
2. Propagates the `prefix` to all internal modules (debug logging, deviceId, Supabase client, runtime config, demo mode, Supabase table name prefixing)
3. Creates or registers the Dexie database instance
5. Registers demo mode configuration if provided

```typescript
initEngine({
  prefix: 'stellar',
  schema: {
    goals: 'goal_list_id, order',
    goal_lists: 'order',
    focus_settings: { singleton: true },
  },
  auth: {
    gateType: 'code',
    codeLength: 6,
    emailConfirmation: true,
    deviceVerification: true,
  },
  demo: { seedData: seedDemoData, mockProfile: { email: 'demo@example.com', firstName: 'Demo', lastName: 'User' } },
});
```

### 2.2 Two Configuration Modes

**Schema-Driven (Recommended):**

The consumer provides a declarative `schema` object where each key is a logical table name and the value is either a Dexie index string or a `SchemaTableConfig` object. The actual Supabase table name is `${prefix}_${schemaKey}` -- consumers write raw keys (e.g., `goals`) and the engine automatically prefixes them (e.g., `stellar_goals`). The engine auto-generates everything:

- `TableConfig[]` -- per-table sync configuration (columns, ownership filter, singleton flag, conflict settings)
- Dexie store schemas -- by merging app-specific indexes with `SYSTEM_INDEXES`
- Database versioning -- via `computeSchemaVersion()` (automatic, no manual version bumping)
- Database naming -- defaults to `${prefix}DB` (overridable via `databaseName`)

No manual Dexie store declarations are needed. The schema definition IS the single source of truth.

**Manual (Backward Compat):**

The consumer provides explicit `tables: TableConfig[]` and `database: DatabaseConfig` objects. This was the original API and is still supported.

The two modes are mutually exclusive -- providing `schema` alongside `tables` or `database` throws an error.

### 2.3 Auth Config Format

The `auth` option uses a **flat format** at the top level. There is no nesting under a `singleUser` key:

```typescript
auth: {
  gateType: 'code',        // 'code' | 'password' (default: 'code')
  codeLength: 6,           // 4 | 6 (default: 6, only used when gateType === 'code')
  emailConfirmation: true,  // boolean (default: true)
  deviceVerification: true, // boolean (default: true)
  trustDurationDays: 90,    // number (default: 90)
  confirmRedirectPath: '/confirm', // string (default: '/confirm')
  enableOfflineAuth: true,  // boolean (default: true)
  profileExtractor: (meta) => ({ firstName: meta.first_name }),
  profileToMetadata: (profile) => ({ first_name: profile.firstName }),
}
```

Internally, `normalizeAuthConfig()` detects this flat form (by the absence of a `singleUser` key) and converts it to the nested structure used by the engine internals. Consumers should always use the flat format.

### 2.4 System Indexes

Every synced entity table gets these Dexie indexes automatically:

```
SYSTEM_INDEXES = 'id, user_id, created_at, updated_at, deleted, _version'
```

These correspond to the system columns every sync-enabled row has:

| Column | Purpose |
|--------|---------|
| `id` | UUID primary key |
| `user_id` | Ownership filter for RLS (Row-Level Security -- Supabase's mechanism for isolating each user's data) |
| `created_at` | Creation timestamp (immutable) |
| `updated_at` | Last modification timestamp (used as the sync cursor to fetch only new changes) |
| `deleted` | Soft-delete flag (a "tombstone" -- the row is marked as deleted but not physically removed, so other devices learn about the deletion during sync) |
| `_version` | Optimistic concurrency version counter (incremented on every write to detect stale updates) |

App-specific indexes are appended after the system indexes:

```
// Schema: goals: 'goal_list_id, order'
// Becomes: 'id, user_id, created_at, updated_at, deleted, _version, goal_list_id, order'
```

### 2.5 Table/Column Rename Support

Tables and columns can be renamed across versions using `renamedFrom` and `renamedColumns`:

```typescript
schema: {
  goal_categories: {
    indexes: 'order',
    renamedFrom: 'goal_lists',       // Old Supabase table name
    renamedColumns: { category_name: 'name' },  // new_col: old_col
  }
}
```

When the engine detects a rename, it generates a Dexie upgrade callback that copies data from the old table to the new one, applying column renames, then clears the old table. Dexie's schema diff handles structural changes (creating/removing tables).

### 2.6 Auto-Versioning via `computeSchemaVersion()`

**File**: `src/database.ts`

The engine automatically manages Dexie version numbers so consumers never need to increment them manually. The algorithm:

1. Serialize the merged store schema (app tables + system tables) into a deterministic sorted string
2. Compute a DJB2 hash of the string (a fast, deterministic, non-cryptographic hash function)
3. Compare the hash to the previous hash stored in `localStorage` (`${prefix}_schema_hash`)
4. If unchanged: return the stored version number
5. If changed (or first run): increment the stored version, persist the new hash, store the previous schema for upgrade path
6. Return a `SchemaVersionResult` containing:
   - `version` -- the new Dexie version number
   - `previousStores` -- the old schema (so Dexie can diff for additive changes)
   - `previousVersion` -- the old version number

When an upgrade is detected, both the old version and new version are declared to Dexie, giving it a proper upgrade path (vN-1 -> vN) instead of requiring a full database rebuild.

### 2.7 Schema-Driven Auto-Generation Flow

When `initEngine({ schema: {...} })` is called, two internal functions run:

**`generateTablesFromSchema(schema)`** produces a `TableConfig[]` where each schema key becomes:
- `supabaseName` = `${prefix}_${schemaKey}` (the actual Supabase table name is automatically prefixed; consumers write raw schema keys and the engine prefixes them transparently)
- `columns` = `'*'` (SELECT all by default)
- `ownershipFilter` = `'user_id'` (default)
- Plus optional `isSingleton`, `excludeFromConflict`, `numericMergeFields`, `onRemoteChange` from the object form

**`generateDatabaseFromSchema(schema, prefix, databaseName?)`** produces a `DatabaseConfig` by:
1. Building Dexie store schemas (system indexes + app indexes for each table, camelCase Dexie names)
2. Computing the auto-version via `computeSchemaVersion()`
3. Declaring both old and new versions for proper upgrade path
4. Generating rename upgrade callbacks if any table uses `renamedFrom`

---

With the schema configured, the next step is understanding how the local database is created and managed.

## 3. Database Management

**File**: `src/database.ts`

The local database is the user's personal copy of their data. It lives in the browser's IndexedDB (accessed through the Dexie.js library, which provides a friendlier API on top of raw IndexedDB). This section covers how that database is created, structured, and recovered from failures.

### 3.1 Two Modes

**Managed Mode** (recommended): The engine creates and owns the Dexie instance via `createDatabase()`. System tables are automatically merged into every schema version declaration.

**Manual Mode**: The consumer provides explicit `tables` and `database` config for full control over IndexedDB versioning and migration history.

### 3.2 System Tables

These internal tables are auto-merged into every version declaration. They power the sync engine's internal bookkeeping:

| Table | Indexes | Purpose |
|-------|---------|---------|
| `syncQueue` | `++id, table, entityId, timestamp` | Pending outbound operations (the "outbox" -- writes waiting to be sent to the server) |
| `conflictHistory` | `++id, entityId, entityType, timestamp` | Field-level conflict resolution audit trail (which value won and why) |
| `offlineCredentials` | `id` | Cached user credentials for offline sign-in (hashed, never plaintext) |
| `offlineSession` | `id` | Offline session tokens |
| `singleUserConfig` | `id` | Single-user mode gate configuration (PIN/password settings) |

### 3.3 Recovery Strategy

If the database fails to open (blocked by another tab, corrupted schema, stale service worker), the engine follows a recovery flow:

```
createDatabase(config)
  |
  v
buildDexie(config) -> db.open()
  |
  +---> SUCCESS:
  |       |
  |       v
  |     Validate object stores:
  |       db.backendDB().objectStoreNames vs db.tables
  |       |
  |       +---> All match: Database ready
  |       |
  |       +---> Missing stores detected (stale SW served old JS):
  |               db.close() -> Dexie.delete(name) -> rebuild -> reopen
  |
  +---> FAILURE (UpgradeError, blocked, corruption):
          db.close() -> Dexie.delete(name) -> rebuild -> reopen
```

After recovery, data is rehydrated from Supabase on the next sync cycle via `hydrateFromRemote()`. The Supabase auth session is preserved in localStorage so the same user is recovered on reload.

The `resetDatabase()` function provides a nuclear recovery option: it closes connections, deletes the IndexedDB entirely, and clears sync cursors. The app should then reload to trigger fresh `initEngine()` + hydration.

---

With the database ready to accept writes, the next section explains how those writes are recorded and why the format matters for efficient sync.

## 4. Intent-Based Sync Operations

**Files**: `src/types.ts`, `src/queue.ts`

When a user makes a change, the engine doesn't just record the final state of the data. It records what the user **intended to do**. This distinction is critical for efficient sync and correct conflict resolution.

### 4.1 Four Operation Types

| Operation | Semantics | Example |
|-----------|-----------|---------|
| `create` | Insert a new entity | User adds a new goal |
| `set` | Overwrite field(s) with new value(s) | User renames a goal title |
| `increment` | Add a numeric delta to a field | User taps "+1" on a counter |
| `delete` | Soft-delete an entity (mark as deleted, don't physically remove) | User removes a goal |

### 4.2 Why Intent Matters

Consider a user rapidly clicking "+1" on a counter 50 times while offline:

```
Without intent-preservation (state snapshots):
  50 x SET current_value = N  -->  50 Supabase UPDATE requests

With intent-preservation:
  50 x INCREMENT +1            -->  Coalesced to 1 x INCREMENT +50
                               -->  1 Supabase UPDATE request
```

**Why not just use snapshots?** Intent-based operations enable algebraic reduction (combining multiple operations into one equivalent operation). State snapshots cannot be reduced this way because the engine cannot determine whether the user meant to "set to 50" or "add 50 to whatever the current value is." By preserving the intent, the engine can safely combine operations, reducing server requests from potentially hundreds to just one.

### 4.3 SyncOperationItem Structure

```typescript
interface SyncOperationItem {
  id?: number;              // Auto-increment queue ID (assigned by IndexedDB)
  table: string;            // Target Supabase table name
  entityId: string;         // UUID of the affected entity
  operationType: OperationType; // 'increment' | 'set' | 'create' | 'delete'
  field?: string;           // Target field (for field-level ops)
  value?: unknown;          // Delta (increment), new value (set), payload (create)
  timestamp: string;        // ISO 8601 enqueue time (immutable)
  retries: number;          // Failed push attempt count
  lastRetryAt?: string;     // ISO 8601 timestamp of last retry (for backoff)
}
```

Key design: `timestamp` is **immutable after creation**. It preserves enqueue order for deterministic sync processing. Only `lastRetryAt` is updated on retries, and only `retries` is incremented.

### 4.4 Retry & Exponential Backoff

When a sync operation fails (network error, server timeout, etc.), the engine uses exponential backoff -- each retry waits longer than the last, preventing the client from hammering a struggling server:

```
Retry #0: Immediate (first attempt)
Retry #1: 1 second backoff  (2^0 * 1000ms)
Retry #2: 2 second backoff  (2^1 * 1000ms)
Retry #3: 4 second backoff  (2^2 * 1000ms)
Retry #4: 8 second backoff  (2^3 * 1000ms)
Retry #5: PERMANENTLY FAILED --> item removed from queue, user notified
```

`MAX_SYNC_RETRIES = 5`. With exponential backoff, 5 retries span approximately 15 seconds of cumulative wait time. This covers transient network errors and brief server outages without keeping doomed operations in the queue indefinitely.

The `shouldRetryItem()` function checks both the retry count and the backoff window before allowing a retry. The `cleanupFailedItems()` function garbage-collects permanently failed items and returns the affected table names for user notification.

---

Before sync operations are sent to the server, they pass through the coalescing pipeline -- the engine's most important optimization for reducing network traffic.

## 5. Operation Coalescing Pipeline

**File**: `src/queue.ts`

"Coalescing" means combining multiple pending operations into fewer, equivalent operations. This pipeline runs as a single-pass, in-memory algorithm before every push cycle. It dramatically reduces the number of server requests and payload size. For example, if a user makes 200 edits while offline, coalescing might reduce that to 5-10 actual server requests.

### 5.1 Performance Characteristics

- **O(n) memory** where n = queue length (single fetch, in-memory processing)
- **O(1) IndexedDB reads** regardless of queue size (one `toArray()` call)
- **O(k) IndexedDB writes** where k = number of changed rows (bulk delete + transaction)
- **Crash-safe**: all mutations are accumulated in `idsToDelete` and `itemUpdates` Sets/Maps and flushed atomically at the end. If the process crashes mid-pipeline, the queue is untouched.

### 5.2 The 6-Step Pipeline in Detail

**Step 1: Group by Entity**

Operations are bucketed by a `table:entityId` composite key. This ensures operations on different tables with the same UUID are never incorrectly merged.

```
INPUT: [
  { table:'goals', entityId:'A', op:'set', field:'title', value:'New' },
  { table:'goals', entityId:'A', op:'increment', field:'score', value:3 },
  { table:'goals', entityId:'B', op:'create', value:{...} },
  { table:'goals', entityId:'B', op:'delete' },
]

AFTER STEP 1:
  goals:A -> [SET title, INCREMENT score+3]
  goals:B -> [CREATE, DELETE]
```

**Step 2: Entity-Level Reduction**

For each entity group, operations are sorted chronologically by `timestamp` (the original enqueue time, which never changes). Then one of four mutually exclusive cases is applied:

**Case 1: CREATE + DELETE = Cancel Everything**
The entity was created and deleted within the same offline session. The server never knew about it. N operations become 0.

```
goals:B -> [CREATE, SET title, DELETE]  -->  [] (all cancelled)
```

**Case 2: DELETE without CREATE = Only DELETE Survives**
The entity existed on the server before going offline. Intermediate sets/increments are pointless because the delete will wipe the row.

```
goals:C -> [SET title, SET desc, DELETE]  -->  [DELETE]
```

**Case 3: CREATE without DELETE = Fold Updates into CREATE Payload**
Since the server hasn't seen the entity yet, the final create payload is built by replaying all subsequent sets and increments into the original create value. N operations become 1.

```
goals:D -> [CREATE {title:'Draft'}, SET title='Final', INC score+5]
  -->  [CREATE {title:'Final', score:5}]
```

Increments are folded arithmetically: if the field doesn't exist in the payload (or isn't a number), it starts at 0. Sets overwrite the field directly. Whole-object sets are shallow-merged.

**Case 4: No CREATE, No DELETE = Field-Level Coalescing**
This is the most nuanced case. The entity exists on the server, and we have a mix of sets and increments targeting various fields. This is handled by `processFieldOperations()`.

For each field that has both SETs and INCREMENTs:

1. Find the **last SET** on that field -- it establishes a known absolute value
2. Everything **before** the last SET is superseded (deleted)
3. INCREMENTs **after** the last SET are folded into the set's value

```
Field 'score': [INC +3, SET 10, INC +5]
  --> INC +3 is moot (SET overwrites it)
  --> INC +5 is folded into SET: SET 15
  --> Final: [SET score=15]
```

Groups with only increments or only sets are left for Steps 3 and 4 respectively.

**Step 3: Increment Coalescing**

Surviving increment operations on the same field are summed into the oldest operation (preserving enqueue order for deterministic sync):

```
[INC score+3, INC score+5, INC score+2]  -->  [INC score+10]
```

**Step 4: Set Coalescing**

Surviving set operations on the same entity are merged into a single whole-object set. Field-targeted sets contribute their field; whole-object sets are shallow-merged (later values win on overlap):

```
[SET title='A', SET desc='B', SET title='C']  -->  [SET {title:'C', desc:'B'}]
```

The carrier operation's `field` is cleared to `undefined` since it now carries multiple fields as a whole-object set.

**Step 5: No-Op Pruning**

Final cleanup catches edge cases produced by earlier phases:

- **Zero-delta increments**: `INC +3` and `INC -3` summed to `INC +0` -- no server effect
- **Timestamp-only sets**: A set where the only remaining key is `updated_at` -- the server manages this via triggers
- **Empty/null sets**: A set with no value at all -- degenerate case handled defensively

**Step 6: Batch Persist**

All deletions and updates are flushed to IndexedDB:
1. `bulkDelete(idsToDelete)` -- single IndexedDB call for all removals
2. `transaction('rw', ...)` -- single transaction for all updates
3. Return the count of removed operations

---

With coalesced operations ready, the sync engine orchestrates the actual push and pull cycle.

## 6. Sync Cycle Orchestration

**File**: `src/engine.ts`

The sync engine is the central coordinator. It manages when and how data flows between the local database and Supabase. It handles push (sending local changes to the server), pull (fetching remote changes), hydration (initial data load), and various edge cases like tab visibility, network transitions, and stale locks.

### 6.1 Module State Variables

| Variable | Type | Purpose |
|----------|------|---------|
| `wasOffline` | boolean | Whether device was recently offline (triggers auth validation on reconnect) |
| `authValidatedAfterReconnect` | boolean | Whether auth has been validated since last offline->online transition |
| `lockPromise` | Promise or null | Mutex lock for preventing concurrent sync cycles |
| `lockAcquiredAt` | number or null | Timestamp when lock was acquired (for stale detection) |
| `syncTimeout` | timer | Debounce timer for push-after-write (cleared on each new write) |
| `syncInterval` | timer | Periodic background sync interval timer |
| `recentlyModifiedEntities` | Map<string, number> | Entity ID -> timestamp map with 2s TTL, protects recently-written entities from being overwritten by stale pull data |
| `lastSuccessfulSyncTimestamp` | number | For reconnect cooldown comparison |
| `isTabVisible` | boolean | Current tab visibility state |
| `tabHiddenAt` | number or null | When the tab became hidden (for away-duration calculation) |
| `_hasHydrated` | boolean | Whether initial empty-DB hydration has been attempted |
| `_schemaValidated` | boolean | Whether Supabase schema has been validated this session |
| `lastUserValidation` | number | Timestamp of last `getUser()` network call |
| `lastValidatedUserId` | string or null | User ID from last successful `getUser()` call |

### 6.2 `startSyncEngine()`

Called after auth resolves to start the sync lifecycle. Sets up:

1. **Realtime subscriptions** -- single Supabase channel for all tables
2. **Periodic sync timer** -- every `syncIntervalMs` (default 15min)
3. **Watchdog timer** -- every 15s, checks for stuck locks
4. **Visibility listener** -- `visibilitychange` event for smart re-sync
5. **Online/offline listeners** -- network state transitions
6. **Initial hydration** -- if local DB is empty, pull all data from Supabase

### 6.3 `runFullSync()` -- The Main Sync Cycle

This is the core sync loop. It runs on a timer, after writes, on tab focus, and on reconnect:

```
runFullSync(quiet, skipPull)
  |
  v
acquireSyncLock()  ------> Lock held? Check stale (>60s) -> force release or skip
  |
  +---> FALSE: Another sync in progress -> return
  |
  +---> TRUE: Lock acquired
          |
          v
        needsAuthValidation()?
          |
          +---> YES: Device was offline -> block until auth re-validated
          |
          v
        getCurrentUserId()  -- validates session, cached 1 hour
          |
          +---> NULL: Not authenticated -> release lock, return
          |
          v
   +------- PUSH PHASE -------+
   |                           |
   | coalescePendingOps()      |  <-- Reduces N operations to M (M << N)
   |         |                 |
   | getPendingSync()          |  <-- Get eligible items (respect backoff)
   |         |                 |
   | for each pending item:    |
   |   processSyncItem()       |  <-- Transform intent to Supabase mutation
   |     |                     |
   |     +-> create: INSERT    |
   |     +-> set: UPDATE       |
   |     +-> increment: UPDATE |
   |     +-> delete: UPDATE    |
   |         (deleted=true)    |
   |   On success:             |
   |     bulkRemoveSyncItems() |  <-- Batch dequeue (1 IDB txn)
   |   On failure:             |
   |     incrementRetry()      |  <-- Backoff
   |                           |
   +-----------+---------------+
               |
               v
   +------- PULL PHASE -------+
   | (skipped if skipPull)     |
   |                           |
   | pullRemoteChanges()       |
   |   |                       |
   |   +-> Parallel SELECT     |
   |   |   per entity table    |
   |   |   WHERE updated_at    |
   |   |   > cursor            |
   |   |   ORDER BY updated_at |
   |   |                       |
   |   +-> For each record:    |
   |       - isRecentlyModified |
   |         (2s TTL)? SKIP    |
   |       - wasRecentlyProc-  |
   |         essedByRealtime?  |
   |         SKIP              |
   |       - No local? INSERT  |
   |       - Local newer? SKIP |
   |       - No pending ops?   |
   |         Accept remote     |
   |       - Has pending ops?  |
   |         resolveConflicts()|
   |       - Write to Dexie    |
   |       - Update cursor     |
   |                           |
   +-----------+---------------+
               |
               v
         releaseSyncLock()
         updatePendingCount()  --> Always updates, even for quiet (background) syncs
         notifySyncComplete()  --> All registered stores re-read from local DB
         cleanupFailedItems()
         cleanupConflictHistory()
```

**Pending count accuracy:** The pending count update runs unconditionally after the sync cycle — both foreground and background (quiet) syncs update the count. Without this, background syncs that clear the queue would leave a stale badge count in the UI.

### 6.4 Push Phase Details

**Singleton Table Conflict Reconciliation**: A "singleton" table is one that holds exactly one row per user (e.g., user settings). When a `create` operation fails on a singleton table with a duplicate key error (another device created the singleton first), the engine reconciles the local ID with the server's existing row instead of treating it as an error. It fetches the server's row, updates the local entity's ID to match, and the create becomes an update.

**Error Classification**: Errors are classified as transient (network timeout, rate-limit, 5xx, RLS policy violations) or persistent (auth failure, validation). Transient errors suppress UI error indicators until retry #3 to avoid alarming users during brief network hiccups. RLS violations are classified as transient because they are often caused by parent-child ordering issues (the parent record hasn't synced yet) and resolve on retry.

**Batch Creates**: Create operations are grouped by table and sent as a single `supabase.from(table).upsert([...])` call (up to 500 rows per batch). This is critical for bulk operations like CSV imports — hundreds of transactions push in 1-2 HTTP calls instead of hundreds of individual round trips. `upsert` (INSERT ON CONFLICT UPDATE) is used instead of `insert` so that duplicate records are handled in one round-trip without error fallback. The grouping phase uses `bulkGet` to verify items are still in the sync queue in a single IndexedDB read (instead of per-item sequential reads), which eliminates O(N) IndexedDB overhead for large batches.

**Secondary Unique Constraint Handling (23505 Dedup-and-Retry)**: When a batch create fails with Postgres error code `23505` (duplicate key), it indicates a secondary unique constraint violation (e.g., `csv_import_hash`, `teller_transaction_id`) rather than a primary `id` conflict. The engine queries Supabase for which entity IDs from the failed batch already exist, removes those from the sync queue (they're true duplicates), then retries with only the genuinely new items. This avoids the catastrophic individual fallback (500 sequential HTTP requests at ~200ms each). If the retry still fails, the remaining items are removed from the queue to prevent infinite retry storms. Individual fallback is reserved for non-duplicate errors (RLS, schema violations).

**Parent-Before-Child Table Ordering**: When the schema defines child tables via `ownership: { parent, fk }`, the push phase sorts batch creates so parent tables are processed before child tables. This is essential because child table RLS policies validate that the parent FK exists with a matching `user_id`. Without this ordering, a batch of child creates would fail RLS because the parent records haven't been inserted yet.

**Self-Healing Upsert Fallback**: When a `set` or `increment` operation fails because the target row doesn't exist in Supabase (UPDATE returns 0 rows), the engine reads the full entity from IndexedDB and INSERTs it. This self-heals "stuck" data — records that exist locally but never made it to the server (e.g., written by code paths that bypassed the sync queue). Duplicate key errors during the fallback insert are handled gracefully. For singleton tables, the existing ID reconciliation logic takes precedence.

### 6.5 Pull Phase Details

All table queries run in parallel via `Promise.all()` wrapped in a `withTimeout()` (dynamic timeout based on pending operation count: 45s base + 30s per 500 items, capped at 5 minutes). Results are applied inside a single Dexie transaction spanning all entity tables + syncQueue + conflictHistory.

The per-record application logic:
1. Skip if recently modified locally (2s TTL protection)
2. Skip if just processed by realtime (prevents duplicate application)
3. No local entity? Simple insert
4. Remote not newer than local? Skip (no conflict possible)
5. No pending ops for this entity? Accept remote directly
6. Has pending ops? Full 3-tier conflict resolution via `resolveConflicts()`
7. Write merged entity to Dexie
8. Store conflict history if conflicts were detected

After all records are processed, the sync cursor is advanced to the newest `updated_at` seen.

### 6.6 Mutex Lock Implementation

A mutex lock prevents multiple sync cycles from running concurrently (which could cause race conditions and duplicate writes):

```
acquireSyncLock()
  |
  +---> lockPromise !== null?
  |       |
  |       YES --> Is lock stale (held > 60s)?
  |       |         |
  |       |         YES --> Force release, log warning, acquire
  |       |         NO  --> Return false (skip this sync)
  |       |
  |       NO --> Create new Promise, record timestamp, return true
```

The watchdog timer runs every 15s and force-releases any lock held longer than 45s. It also garbage-collects expired entries from the `recentlyModifiedEntities` map and the realtime tracking map.

### 6.7 Session Validation & Caching

To avoid a network call (`getUser()`) on every sync cycle, the engine caches successful auth validation for 1 hour:

```
getCurrentUserId()
  |
  +---> getSession()  (local only, no network)
  |
  +---> Is session expired?
  |       YES --> refreshSession() (network call)
  |
  +---> Is cached validation < 1 hour old AND same userId?
  |       YES --> return userId immediately (zero network cost)
  |       NO  --> getUser() (network call to validate token server-side)
  |
  +---> On success: cache result for next hour
  +---> On error: invalidate cache, try refresh, return null
```

`USER_VALIDATION_INTERVAL_MS = 3,600,000` (1 hour). This optimization alone saves approximately 720 Supabase auth API calls per day for an active user.

### 6.8 Egress Optimization Strategies

The engine aggressively minimizes Supabase bandwidth consumption. This matters because Supabase bills by egress, and mobile users have limited bandwidth:

| Strategy | Savings | How It Works |
|----------|---------|--------------|
| **Operation coalescing** | Largest reduction | 50 rapid writes become 1 request. Create+delete = 0 requests. |
| **Push-only mode** | Skips all pull queries | When realtime WebSocket is healthy, user-triggered syncs skip the pull phase. Remote changes arrive via WebSocket instead. |
| **Cached user validation** | ~720 calls/day saved | `getUser()` is called once per hour instead of once per sync cycle. |
| **Visibility-aware sync** | Avoids unnecessary syncs | If tab was hidden < 15 minutes (`visibilitySyncMinAwayMs = 900000`), skip sync on return. No data loss: local writes always push immediately, and realtime (restarted on tab visible) delivers remote changes in real-time. This threshold only controls when a backup *poll* runs on return. |
| **Reconnect cooldown** | Prevents duplicate syncs | If a sync completed < 2 minutes ago (`onlineReconnectCooldownMs = 120000`), skip reconnect-triggered sync. |
| **Selective columns** | Reduces payload size | Every query specifies explicit columns instead of `SELECT *` (when configured). |
| **Cursor-based incremental pull** | Only fetches new data | `WHERE updated_at > cursor` instead of full table scan. |
| **Realtime dedup** | Prevents double-processing | Entities processed by realtime are tracked in a 2s TTL map; polling skips them. |
| **Parallel table queries** | Reduces wall-clock time | All tables are fetched concurrently via `Promise.all()`. |
| **Batch upserts** | N creates → 1 request | Create operations are grouped by table and sent as a single `upsert([...])`. Handles duplicates without fallback round-trips. |
| **Parent-first ordering** | Prevents RLS retry storms | Child table batches wait until parent batches succeed, avoiding failed inserts that waste bandwidth on retries. |
| **Realtime suspension during batch push** | Eliminates echo egress | When ≥50 ops are pending, the realtime channel is removed before pushing. Supabase generates no CDC events for this client during the push. Channel is re-subscribed after push completes. Any missed remote changes are caught by the pull phase. |
| **Realtime teardown on tab hidden** | ~30-40 MB/day saved | WebSocket fully torn down after 15s hidden, eliminating background heartbeat egress (~21 pings/min). Restarted instantly on tab return. |
| **TOKEN_REFRESHED skip** | ~5-10 MB/day saved | Routine token refresh (~every 55 min) no longer triggers full sync or realtime restart. The Supabase JS client handles token rotation automatically. Only restarts realtime if it was already unhealthy. |
| **Reconnect grace period** | Avoids redundant polls | 60s grace period after realtime (re)start before the periodic poll falls back to polling. Prevents unnecessary full pulls while the WebSocket is still connecting. |

#### Realtime Teardown Strategy

When the browser tab is hidden for >15 seconds, the WebSocket channel is fully torn down to eliminate heartbeat egress (~21 pings/min). Quick tab switches (<15s, e.g. checking a notification) cancel the timer with zero overhead. On return:

1. Realtime is restarted immediately (delivers remote changes in ~1-2s)
2. A visibility sync poll runs if away >15 minutes (catches anything missed)
3. A 60s grace period prevents the periodic poll from firing while realtime reconnects

**Data safety**: Local writes always push immediately via the sync queue regardless of visibility state. Remote changes from other devices may display a few minutes late if realtime hasn't reconnected yet, but are never lost.

#### Timeout Architecture for Large Batches

Designed to handle 10,000-20,000+ row operations without timeouts:

| Component | Timeout | Rationale |
|-----------|---------|-----------|
| Per-page pull | 30s/page | Catches individual hung HTTP requests without capping total pull duration |
| Total pull (runFullSync) | 5 min fixed | Large initial hydrations, force syncs. Not based on push count heuristics. |
| Push | 45s + 30s/500 items, max 5 min | Scales with batch size |
| Sync lock | 6 min | Exceeds max operation (5 min) by 1 min headroom. Prevents watchdog from force-releasing during legitimate large batch operations. |

### 6.9 Egress Tracking

The engine tracks bytes transferred per table and per sync cycle:

```typescript
interface EgressStats {
  totalBytes: number;
  totalRecords: number;
  byTable: Record<string, { bytes: number; records: number }>;
  sessionStart: string;  // ISO 8601 timestamp
}
```

Byte size is estimated using `new Blob([JSON.stringify(data)]).size` for accurate UTF-8 byte counting. Stats are session-scoped (reset on page reload). The sync cycle log retains the last 100 entries as a rolling window.

Accessible via `getDiagnostics()` or `window.__<prefix>Diagnostics()` in the browser console.

### 6.10 Tombstone System

The engine uses **soft deletes** (also called "tombstones") instead of hard deletes. When something is deleted, the row stays in the database with `deleted = true` rather than being physically removed. This is essential for multi-device sync: if a row were simply deleted, other devices would have no way to learn that the deletion happened -- they'd just see the row was missing and might think it was never synced.

**Soft Delete Flow:**
1. User deletes item -> local `item.deleted = true`, `updated_at = now()`
2. Queue `delete` operation
3. Push to Supabase: `UPDATE SET deleted=true, updated_at=now()`
4. Realtime broadcasts to other devices
5. Other devices receive soft delete:
   - Detect `isSoftDelete` (deleted=true, was false locally)
   - Play delete animation BEFORE writing to DB (so UI can animate)
   - Write soft-deleted record to local DB
   - UI reactively removes item from display

**Tombstone Cleanup:**
Tombstones accumulate over time and must eventually be cleaned up:
- **Local cleanup**: `cleanupLocalTombstones()` removes records where `deleted=true AND updated_at < (now - tombstoneMaxAgeDays)`. Default: 7 days.
- **Server cleanup**: `cleanupServerTombstones()` hard-deletes from PostgreSQL. Runs at most once per 24 hours (`CLEANUP_INTERVAL_MS = 86400000`). The `lastServerCleanup` timestamp prevents re-running.

### 6.11 Sync Queue Repair

**File**: `src/engine.ts` — `repairSyncQueue()`

The sync queue repair mechanism self-heals data that was written to IndexedDB via code paths that bypassed the sync queue (e.g., direct Dexie writes from legacy code, or migration artifacts). It is a **manual debug tool** invoked from the profile page — it does not run automatically.

**How it works:**
1. Reads all entity IDs currently in the sync queue (`syncQueue.toArray()`)
2. For each configured table, reads all local records from IndexedDB
3. Records that are not in the queue AND not soft-deleted are re-queued as `create` operations
4. Tables are sorted parent-first to ensure FK ordering (same logic as batch creates)

**Egress considerations:**
- The repair itself is zero-egress (IndexedDB reads only)
- Re-queued records are pushed via the normal batch upsert path, so duplicates are handled in one round-trip
- Since it is manual-only, there is no risk of accidental repeated re-queuing

**When to use:** If you suspect stuck data (records visible locally but not on other devices), use the "Repair Sync Queue" button on the profile page's debug tools section.

---

When the pull phase detects that both the local device and the server have modified the same data, the conflict resolution system decides which version wins.

## 7. Three-Tier Conflict Resolution

**File**: `src/conflicts.ts`

Conflicts happen when two devices edit the same data before syncing with each other. For example, Device A changes a goal's title to "Alpha" while offline, and Device B changes the same goal's title to "Beta" on the server. When Device A comes back online, the engine must decide which title to keep.

**Why three tiers?** Most sync engines use a single strategy (usually "last write wins"). This works for simple cases but produces poor results when, for example, two users edit *different* fields of the same record. A three-tier approach handles the common case (different fields, no conflict) cheaply and automatically, while reserving expensive strategy-based resolution for the rare case (same field, true conflict).

### 7.1 Architecture Overview

```
Remote change arrives for entity X
  |
  v
Does entity X exist locally?
  |
  NO --> Accept remote entirely (Tier 0: no conflict possible)
  |
  YES --> Does local have pending delete?
            |
            YES + remote not deleted --> delete_wins (local, Tier 3)
            |
            NO + remote is deleted --> delete_wins (remote, early return)
            |
            v
          For each field in union(local_fields, remote_fields):
            |
            +---> Field in EXCLUDED_FIELDS? --> Skip
            |
            +---> Values are equal? --> Skip  (Tier 1/2: auto-merge, no conflict)
            |
            +---> Field has pending local operations?
            |       YES --> local_pending strategy -> LOCAL WINS  (Tier 3a)
            |
            +---> Field is numeric merge candidate?
            |       YES --> last_write_wins (Tier 3b, future: additive merge)
            |
            +---> DEFAULT: last_write_wins  (Tier 3c)
                    |
                    +---> Compare updated_at timestamps:
                    |       local > remote --> LOCAL WINS
                    |       remote > local --> REMOTE WINS
                    |       EQUAL --> Device ID tiebreaker
                    |                   (lower UUID wins, deterministic)
```

### 7.2 Tier-by-Tier Explanation

**Tier 1: Non-Overlapping Entities (Auto-Merge)**
Different entities changed on different devices never conflict. This is handled upstream by the sync pull logic before the conflict resolver is invoked. If the remote entity doesn't exist locally, it's simply inserted. This covers the vast majority of sync operations.

**Tier 2: Different Fields on Same Entity (Auto-Merge)**
When two devices edit different fields of the same entity, both changes are preserved automatically. The per-field loop inside `resolveConflicts()` only emits a `FieldConflictResolution` when the local and remote values for a given field actually differ. Fields that are equal are silently skipped -- no resolution entry is created, and both sides' values are preserved. For example, if Device A edits the title and Device B edits the description, both edits are kept with zero data loss.

**Tier 3: Same Field on Same Entity (Strategy-Based)**
When the exact same field was modified on both sides, a resolution strategy is selected based on priority order:

1. **`local_pending`** (Tier 3a): The field has unsynced local operations in the sync queue. Local value wins unconditionally so user intent is never silently discarded. The pending op will be pushed on the next sync cycle. **Why not merge the values?** Because the user hasn't seen the remote value yet. Merging would produce results the user never chose, which is more confusing than picking one side.

2. **`numeric_merge`** (Tier 3b): Reserved for fields declared in `numericMergeFields` per table. Currently falls through to last-write-wins because true delta-merge requires storing the original base value or using an operation-inbox pattern. This is a forward-compatible hook for future additive merge support.

3. **`delete_wins`** (Tier 3, handled before per-field loop): When either side has a delete, the delete wins. **Why?** This prevents "entity resurrection" -- if a user deliberately deleted something, it should stay deleted even if another device edited it. Resurrecting deleted items is almost always the wrong behavior.

4. **`last_write`** (Tier 3c): The default fallback. Compare `updated_at` timestamps; the later timestamp wins. On exact tie: device ID tiebreaker (lexicographically lower UUID wins). The tiebreaker is arbitrary but **consistent** -- every device will make the same tiebreaking decision, which is essential for convergence.

### 7.3 Excluded Fields

Always excluded from conflict resolution:

| Field | Reason |
|-------|--------|
| `id` | Immutable primary key -- resolving it would break identity |
| `user_id` | Immutable foreign key -- changing it would violate RLS |
| `created_at` | Immutable timestamp -- should never diverge |
| `_version` | Managed by the engine's version-bumping logic post-resolution |

Additional per-table exclusions can be declared via `excludeFromConflict` in the table config.

### 7.4 Device ID Tiebreaker

**File**: `src/deviceId.ts`

When two devices modify the same field at the exact same millisecond, the device ID provides a deterministic, consistent tiebreaker:

```typescript
// Lower deviceId wins (arbitrary but CONSISTENT across all devices)
if (localDeviceId < remoteDeviceId) {
  winner = 'local';
} else {
  winner = 'remote';
}
```

Device IDs are UUID v4 values stored in localStorage (prefixed with the engine prefix). They persist across sessions but are unique per browser/device.

**localStorage clearing resilience**: The ID is also backed up to a separate raw IndexedDB database (`{prefix}_device_store`). On startup, `_initDeviceId()` runs as fire-and-forget from `_setDeviceIdPrefix()`: if localStorage has been cleared (e.g., by Firefox's "Delete cookies and site data when Firefox is closed" privacy setting) but IndexedDB still has the old UUID, it is silently restored to localStorage. This prevents the device from being re-registered as a new unknown device after a privacy-triggered storage wipe. Callers that make trust decisions (`isDeviceTrusted`, `sendDeviceVerification`) await `waitForDeviceId()` before reading the ID to ensure recovery completes first.

### 7.5 Post-Resolution Bookkeeping

After all fields are resolved:
1. **Version bump**: `_version = max(local._version, remote._version) + 1`. Ensures any device receiving the merged entity recognizes it as strictly newer.
2. **Timestamp preservation**: The later `updated_at` is preserved for correct "recently modified" ordering.
3. **Merged entity base**: The remote entity is used as the base layer, with local-winning fields overwritten on top.

### 7.6 Conflict History

Every resolved conflict is logged to the `conflictHistory` IndexedDB table for debugging and auditing:

```typescript
interface ConflictHistoryEntry {
  entityId: string;
  entityType: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  resolvedValue: unknown;
  winner: 'local' | 'remote' | 'merged';
  strategy: 'last_write' | 'numeric_merge' | 'delete_wins' | 'local_pending';
  timestamp: string;
}
```

Each field-level decision is stored as a separate row (via `bulkAdd`) for fine-grained auditing. History is auto-cleaned after 30 days via `cleanupConflictHistory()`. Storage cost is minimal (~200-500 bytes per entry). Conflict history never leaves the device.

### 7.7 Detailed Conflict Example

This walkthrough shows how a real multi-device conflict plays out end-to-end:

```
Device A (offline for 2 hours):      Device B (online):
  |                                    |
  v                                    v
Edit name to "Alpha"                 Edit name to "Beta"
Edit order to 3                      (no order change)
Increment score by 5                 (no score change)
  |                                    |
  v                                    v
Queue: SET name="Alpha"              Push immediately:
Queue: SET order=3                   name="Beta" synced to server
Queue: INC score+5                   server now has name="Beta"
  |                                    |
  v (comes online)                     |
runFullSync()
  |
  +---> PUSH: coalescePendingOps()
  |     SET name="Alpha", SET order=3, INC score+5
  |     (coalesced into: SET {name:"Alpha", order:3}, INC score+5)
  |
  +---> PULL: Gets record with name="Beta" from server
  |
  +---> CONFLICT: Entity has pending ops
  |
  +---> resolveConflicts():
  |
  |     Field "name":
  |       local="Alpha", remote="Beta"
  |       Has pending SET? YES -> Strategy: local_pending
  |       Winner: LOCAL ("Alpha")
  |
  |     Field "order":
  |       local=3, remote=(same as before)
  |       Has pending SET? YES -> Strategy: local_pending
  |       Winner: LOCAL (3)
  |
  |     Field "score":
  |       local=(base+5), remote=(base, unchanged)
  |       Has pending INC? YES -> Strategy: local_pending
  |       Winner: LOCAL (base+5)
  |
  |     Field "updated_at":
  |       Not in excluded set, but values differ
  |       No pending op for updated_at -> Strategy: last_write
  |       Remote is newer -> Winner: REMOTE timestamp
  |
  +---> Merged entity written to Dexie
  +---> PUSH again: name="Alpha", order=3, score=base+5 sent to server
```

---

While the sync cycle handles periodic reconciliation, realtime subscriptions provide instant push notifications from the server for low-latency collaboration.

## 8. Realtime Subscriptions

**File**: `src/realtime.ts`

Realtime subscriptions use Supabase's WebSocket-based Realtime service to receive instant notifications when other devices modify data. This eliminates the latency of waiting for the next polling-based sync cycle -- changes from other users appear within milliseconds.

### 8.1 Architecture

```
+------------------------------------------------------------------+
|  REALTIME SUBSCRIPTION MANAGER                                   |
|                                                                  |
|  State Machine:                                                  |
|  disconnected --> connecting --> connected                        |
|       ^              |              |                             |
|       |              v              v                             |
|       +---------  error  <----------+                             |
|       |              |                                            |
|       |              v                                            |
|       +-- reconnect (exponential backoff, max 5 attempts)        |
|                                                                  |
|  Channel: {prefix}_sync_{userId}                                 |
|  Events: postgres_changes (INSERT, UPDATE, DELETE)               |
|  Tables: All registered entity tables                            |
|  Security: RLS policies handle filtering (no client-side filter) |
+------------------------------------------------------------------+
```

### 8.2 Consolidated Channel Pattern

Instead of N separate channels (one per table), the engine uses a **single channel** with N event subscriptions. This reduces WebSocket overhead from N connections to 1:

```typescript
const channelName = `${prefix}_sync_${userId}`;
state.channel = supabase.channel(channelName);

for (const table of realtimeTables) {
  // table is the prefixed Supabase table name (e.g., 'stellar_goals')
  state.channel = state.channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table },
    (payload) => handleRealtimeChange(table, payload)
  );
}
```

The engine subscribes to prefixed table names in PostgreSQL changes (e.g., `stellar_goals`, not `goals`), matching the actual Supabase table names.

### 8.3 Echo Suppression

When device A pushes a change, Supabase broadcasts it to all subscribers, including device A itself. Without echo suppression, the device would process its own change as if it came from another user. The realtime handler skips changes from its own device:

```typescript
function isOwnDeviceChange(record: Record<string, unknown>): boolean {
  return record.device_id === state.deviceId;
}
```

The `device_id` field is included in every row and is set by the client on every write. It is used only for echo suppression and conflict tiebreaking, NOT for authorization.

### 8.4 Deduplication with Polling

Realtime and polling can both deliver the same change. A `recentlyProcessedByRealtime` Map with 2-second TTL prevents duplicate processing:

```
Change arrives via Realtime
  --> Process it
  --> Mark entityId in recentlyProcessedByRealtime map with current timestamp

Later, same change arrives via polling (pullRemoteChanges)
  --> wasRecentlyProcessedByRealtime(entityId)?
  --> TRUE (within 2s TTL) --> Skip (already applied)

After 2 seconds, entry expires and is lazily cleaned up on next read
```

### 8.5 Three-Branch Conflict Path in Realtime

When a change arrives via realtime:

```
handleRealtimeChange(table, payload)
  |
  +---> isOwnDeviceChange? --> YES: Skip (echo suppression)
  |
  +---> Fetch local entity from Dexie
  |
  +---> Branch 1: No local entity exists
  |       --> Simple insert to Dexie
  |       --> Notify UI of remote change (animation)
  |
  +---> Branch 2: Local exists, no pending ops
  |       --> Compare timestamps
  |       --> Remote newer? Accept remote, write to Dexie
  |       --> Local newer? Skip (stale remote)
  |       --> Notify UI
  |
  +---> Branch 3: Local exists, has pending ops
          --> Full resolveConflicts() with all pending ops
          --> Write merged entity to Dexie
          --> Store conflict history
          --> Notify UI
```

### 8.6 Soft Delete Handling

When a soft delete is detected (UPDATE with `deleted=true` where local has `deleted=false`), the module records the deletion in `remoteChangesStore` BEFORE writing to Dexie. This ordering is intentional: it allows the UI layer to play a removal animation before the reactive store filters out the deleted record.

### 8.7 Reconnection Strategy

```
Connection lost
  |
  v
Is device offline (navigator.onLine === false)?
  YES --> pauseRealtime()
          Wait for 'online' event
          --> Resume on online
  NO  --> scheduleReconnect()
            |
            v
          Attempt 1: 1s delay    (RECONNECT_BASE_DELAY * 2^0)
          Attempt 2: 2s delay    (RECONNECT_BASE_DELAY * 2^1)
          Attempt 3: 4s delay    (RECONNECT_BASE_DELAY * 2^2)
          Attempt 4: 8s delay    (RECONNECT_BASE_DELAY * 2^3)
          Attempt 5: 16s delay   (RECONNECT_BASE_DELAY * 2^4)
          MAX_RECONNECT_ATTEMPTS (5) REACHED
            --> Fall back to polling-only mode
```

A `reconnectScheduled` flag prevents duplicate reconnect attempts when both `CHANNEL_ERROR` and `CLOSED` events fire in sequence.

### 8.8 Connection Management

- **Pause when offline**: `pauseRealtime()` is called when the network goes down. No reconnect timers fire. The userId is preserved for seamless resumption.
- **Resume on online**: When the `online` event fires, realtime subscriptions are re-established with the same userId.

### 8.9 Realtime Suspension During Batch Push

When the sync engine detects ≥50 pending operations (the `BATCH_SUSPEND_THRESHOLD`), it **suspends the realtime channel entirely** before pushing. This is the primary egress optimization for large batch operations like CSV imports:

```
1. Engine detects 1,119 pending ops (e.g., CSV import)
2. suspendRealtimeForBatchPush()
   --> Sets batchSuspended = true (blocks reconnection + drops stale events)
   --> removeChannel() — Supabase stops sending CDC events
3. pushPendingOps() — batch upserts to Supabase
   --> 0 CDC events arrive (channel is gone)
   --> Any stale buffered events are dropped by batchSuspended guard
4. resumeRealtimeAfterBatchPush()
   --> Clears batchSuspended flag
   --> startRealtimeSubscriptions(userId) — re-subscribe
5. Pull phase catches any changes from other devices
```

**Without suspension:** A 1,119-row CSV import would generate 1,119 WebSocket CDC events, all discarded as own-device echoes — pure wasted egress.

**With suspension:** Zero CDC events during push. The pull phase (cursor-based incremental fetch) handles any missed remote changes.

**Three-layer defense:**
1. `batchSuspended` flag — set unconditionally regardless of channel state, prevents reconnection during push
2. Channel teardown — removes the WebSocket channel so Supabase generates no CDC events
3. `handleRealtimeChange` guard — drops any stale events that arrive from WebSocket buffers after the channel was removed but before the connection fully closed

**Safety:** The `userId` is preserved across suspend/resume. The `finally` block ensures resumption even if the push fails. The `batchSuspended` guard in `startRealtimeSubscriptions` prevents premature reconnection (e.g., from network-online events during the push window).

### 8.10 Debounced Notification Batching

For smaller batch operations (below the suspension threshold), or for CDC events from other devices, notifications are coalesced into a single per-table refresh using a **50ms debounce window**:

```
CDC Event 1 (table: transactions, id: abc)
  --> Add to pendingNotifications Map<table, Set<entityId>>
  --> Start 50ms timer (if not already running)

CDC Event 2 (table: transactions, id: def)  [arrives 5ms later]
  --> Add to pendingNotifications (same table set)
  --> Timer already running, skip

... [50ms elapses] ...

flushPendingNotifications()
  --> Snapshot & clear pendingNotifications
  --> For each table: fire ONE callback (not N)
  --> UI refreshes once per table, not once per record
```

This reduces store refresh count from O(N) to O(tables) for batch operations.
- **Connection state tracking**: The `RealtimeConnectionState` type tracks `'disconnected' | 'connecting' | 'connected' | 'error'`, exposed via `syncStatusStore.setRealtimeState()` for UI display.

---

The sync and realtime systems require authenticated users. The next section covers how authentication works, including offline scenarios.

## 9. Authentication System

The authentication system supports multiple modes to handle the full spectrum of connectivity scenarios -- from fully online with a Supabase JWT session, to completely offline with cached credentials, to demo mode with no server at all.

### 9.1 Auth Modes

| Mode | Description | Network Required |
|------|-------------|-----------------|
| `supabase` | Full Supabase auth session (JWT) | Yes (for initial sign-in) |
| `offline` | Cached credentials in IndexedDB, offline session token | No |
| `demo` | Mock auth with sandboxed database | No |
| `none` | Not authenticated | N/A |

### 9.2 Auth State Store

**File**: `src/stores/authState.ts`

```typescript
interface AuthState {
  mode: AuthMode;                      // 'supabase' | 'offline' | 'demo' | 'none'
  session: Session | null;             // Supabase JWT session
  offlineProfile: OfflineCredentials | null; // Cached credentials
  isLoading: boolean;                  // Initial auth check in progress
  authKickedMessage: string | null;    // Message when session expires/revoked
}
```

Methods: `setSupabaseAuth(session)`, `setOfflineAuth(profile)`, `setDemoAuth(profile)`, `setNoAuth()`, `setLoading()`, `clearKickedMessage()`

Important: `authState` is an OBJECT store. Do NOT compare `$authState === 'string'` -- use `data.authMode !== 'none'`.

### 9.3 Single-User PIN/Password Gate

**File**: `src/auth/singleUser.ts`

The engine implements a single-user auth mode with a simplified PIN code or password gate. This is designed for personal apps where the user is the only person who accesses the account, but still needs Supabase auth for RLS enforcement.

```typescript
auth: {
  gateType: 'code',      // 'code' | 'password'
  codeLength: 6,          // 4 | 6 (only for gateType 'code')
  emailConfirmation: true,
  deviceVerification: true,
}
```

The PIN is padded to meet Supabase's minimum password length and used as a real Supabase password via `supabase.auth.signUp()`. This gives the same `auth.uid()` as a regular email/password user, enabling proper RLS enforcement.

`padPin(gate)` appends a fixed suffix `_app` to the PIN before padding. This means the same email + same PIN produces the same Supabase password across every app sharing a Supabase project -- users carry one credential set regardless of which app registered them. A `padPinLegacy(gate, prefix)` helper reproduces the old per-app-prefix format used before this change; it is used internally for transparent password migration.

**Setup Flow:**
```
User enters email + PIN + profile on first visit
  |
  v
setupSingleUser(gate, profile, email)
  |
  +---> padPin(gate) --> padded password (meets Supabase min length)
  |
  +---> supabase.auth.signUp({ email, password: padPin(gate), data: metadata })
  |       |
  |       +---> SUCCESS:
  |       |       Write SingleUserConfig to IndexedDB
  |       |       cacheOfflineCredentials() for offline fallback
  |       |       If emailConfirmation enabled:
  |       |         return { confirmationRequired: true }
  |       |         --> App shows "check your email" modal
  |       |         --> User clicks email link -> /confirm page
  |       |         --> BroadcastChannel sends AUTH_CONFIRMED
  |       |         --> completeSingleUserSetup() called
  |       |       Else:
  |       |         Auto-trust device, set authState, start sync
  |       |
  |       +---> FAILURE: return { error }
```

**Unlock Flow:**
```
User enters PIN on return visit
  |
  v
unlockSingleUser(gate)
  |
  +---> ONLINE:
  |       signInWithPassword({ email: config.email, password: padPin(gate) })
  |         FAILED -> try padPinLegacy(gate, prefix) as fallback
  |           FAILED -> return { error: 'Incorrect code' }
  |           SUCCESS -> silently migrate: updateUser({ password: padPin(gate) })
  |         SUCCESS -> check deviceVerification enabled?
  |           NO  -> touchTrustedDevice, set authState, start sync
  |           YES -> isDeviceTrusted(userId)?
  |             YES -> touchTrustedDevice, set authState, start sync
  |             NO  -> sign out, sendDeviceVerification(email)
  |                   return { deviceVerificationRequired: true, maskedEmail }
  |                   --> App shows "new device" modal
  |                   --> User clicks email link -> /confirm
  |                   --> BroadcastChannel sends AUTH_CONFIRMED
  |                   --> completeDeviceVerification() called
  |
  +---> OFFLINE:
          Verify gate hash against cached config (SHA-256 fallback)
          Restore offline session or cached Supabase session
```

**Lock Flow:**
```
lockSingleUser()
  |
  +---> Stop sync engine (stopSyncEngine())
  +---> Reset auth state to 'none' (authState.setNoAuth())
  +---> Does NOT destroy session or sign out
  +---> Does NOT clear local data
  +---> User must re-enter PIN to unlock
```

**Change Gate Flow:**
```
changeSingleUserGate(oldGate, newGate)
  |
  +---> signInWithPassword(email, padPin(oldGate))  -- verify old gate
  |       FAILED -> try padPinLegacy(oldGate, prefix) as fallback
  |         FAILED -> return { error: 'Incorrect code' }
  |         SUCCESS -> silently migrate: updateUser({ password: padPin(newGate) })
  +---> updateUser({ password: padPin(newGate) })    -- set new password
  +---> Update local config hash in IndexedDB
  +---> Update offline credentials cache
```

### 9.4 Device Verification

**File**: `src/auth/deviceVerification.ts`

When a user signs in from a new device, the engine can require email-based verification before granting access. This prevents unauthorized access even if the PIN is compromised.

Trusted device registry stored in Supabase `trusted_devices` table:

| Column | Type | Purpose |
|--------|------|---------|
| `user_id` | uuid | The user this device belongs to |
| `device_id` | text | The device's unique identifier |
| `app_prefix` | text | App that registered the trust (default `'stellar'`); isolates device trust per app |
| `trusted_at` | timestamptz | When the device was first trusted |
| `last_seen_at` | timestamptz | Last access (updated on each use) |

The unique constraint is `(user_id, device_id, app_prefix)`. A device trusted in one app is not automatically trusted in another app sharing the same Supabase project. All device verification queries filter by `app_prefix` via an internal `getAppPrefix()` helper that returns the current engine prefix.

Pending device metadata in Supabase `user_metadata` is also namespaced per app: `pending_{prefix}_device_id` and `pending_{prefix}_device_label` (previously the flat keys `pending_device_id` / `pending_device_label`).

Trust duration: 90 days (configurable via `trustDurationDays` in the flat auth config).

Flow: Login on untrusted device → OTP email sent via Supabase → user clicks email link → `/confirm` page verifies OTP → device added to `trusted_devices` → trust established for 90 days.

### 9.5 Auth State Resolution (`resolveAuthState`)

**File**: `src/auth/resolveAuthState.ts`

Determines the initial auth state at app startup. This runs before anything else and decides whether the user needs to log in:

1. Check for demo mode -> return `authMode: 'demo'`
2. If single-user mode configured, delegate to `resolveSingleUserAuthState()`
3. Check Supabase session -> if valid, return `authMode: 'supabase'`
4. If no session, check offline credentials + session -> return `authMode: 'offline'`
5. Return `authMode: 'none'`

**Offline fast path**: When `isOffline()` returns `true`, the resolver skips all Supabase SDK calls (`getSession()`, `refreshSession()`) which can hang indefinitely in airplane mode. Instead, it reads the session directly from localStorage via `getSessionFromStorage()` and checks IndexedDB for offline session credentials. The codeLength migration is also deferred when offline to avoid hanging on RPC calls.

**Unified offline detection**: The `isOffline()` function combines three signal sources: (1) `navigator.onLine`, (2) the network reachability probe result, and (3) the service worker's `NETWORK_UNREACHABLE` message bridge (`window.__stellarOffline`). The consumer app calls `probeNetworkReachability()` once in the root layout load function before `resolveRootLayout()`. The probe sends a `HEAD` request to `/api/config` (bypasses the SW) with a 1.5s timeout, and stores the result in a module-level flag. If the SW's navigation fetch already timed out (1.5s), it writes a timestamp entry to the Cache API (`stellar-network/__status`) and broadcasts `NETWORK_UNREACHABLE` to all clients. On cold starts, the Cache API entry is the primary signal — `probeNetworkReachability()` reads it before making its own HEAD request. On warm reloads, the `postMessage` is caught by an inline `<script>` in `app.html` that sets `window.__stellarOffline = true`. Either way, the probe returns instantly without a network request. All downstream startup code (`initConfig()`, `resolveAuthState()`, `getSession()`) uses `isOffline()` synchronously.

For single-user mode, the resolution determines the auth mode based on local config and session state:

| Config Exists | Session State | Offline? | Result |
|---------------|---------------|----------|--------|
| No (or without email) | -- | -- | `authMode: 'none'` |
| Yes | Valid Supabase session | No | `authMode: 'supabase'` |
| Yes | Any cached session in localStorage | Yes | `authMode: 'supabase'` |
| Yes | No Supabase session, offline session in IndexedDB | Yes | `authMode: 'offline'` |
| Yes | No session at all | Yes | `authMode: 'none'` (user can unlock via PIN) |
| Yes | Expired but offline (`navigator.onLine` lied) | No* | `authMode: 'supabase'` |
| Yes | Offline session only | No | `authMode: 'offline'` |
| Yes | No session | No | `authMode: 'none'` (locked) |

### 9.6 Login Guard

**File**: `src/auth/loginGuard.ts`

Minimizes Supabase auth API requests by verifying credentials locally first. This is especially useful for rate-limited Supabase auth endpoints and for providing instant feedback on incorrect PINs.

**Persistent brute-force protection**: The login guard uses IndexedDB (key `'pin_lockout'` in the `singleUserConfig` table) to persist lockout state across page refreshes and browser restarts. The persistent lockout applies progressive tiers:

| Failures | Lockout Duration |
|----------|-----------------|
| 5        | 5 minutes       |
| 10       | 30 minutes      |
| 15       | 2 hours         |
| 20+      | 24 hours        |

`checkPersistentLockout()` is exported from `stellar-drive/auth` for login pages to restore lockout UI on mount. `onLoginSuccess()` and `resetLoginGuard()` are async to clear the IndexedDB record on success or sign-out.

```
User enters PIN/password
  |
  v
loginGuard.check(gate)
  |
  +---> Cached hash exists in IndexedDB?
  |       |
  |       YES --> Hash matches user input?
  |       |         |
  |       |         YES --> Strategy: 'local-match'
  |       |         |       Proceed to Supabase for authoritative check
  |       |         |
  |       |         NO  --> Increment consecutiveLocalFailures
  |       |                 |
  |       |                 +---> failures < 5? Return error immediately
  |       |                 |     (no network call -- instant rejection)
  |       |                 |
  |       |                 +---> failures >= 5? Invalidate stale hash
  |       |                       Fall through to 'no-cache' strategy
  |       |
  |       NO --> Strategy: 'no-cache'
  |              Rate limiting: exponential backoff (1s base, 30s max)
  |              If nextAllowedAttempt > now, return rate-limited error
  |              Otherwise proceed to Supabase
```

All state is in-memory only -- resets on page refresh. Supabase remains the authoritative verifier.

### 9.7 Offline Credential Caching

**File**: `src/auth/offlineCredentials.ts`

SHA-256 hashed passwords stored in IndexedDB's `offlineCredentials` table. Uses a singleton pattern (`id: 'current_user'`) so only one set of credentials is cached at a time.

Created on successful Supabase login. Cleared on logout. The `hashValue()` function from `src/auth/crypto.ts` provides SHA-256 hashing via the Web Crypto API.

### 9.8 Reconnection Security

When the device comes back online after offline usage, the engine takes a cautious approach to prevent unauthorized data from reaching the server:

1. `markOffline()` sets `wasOffline = true`, `authValidatedAfterReconnect = false`
2. **All sync operations are blocked** until auth is re-validated
3. The auth layer re-authenticates with Supabase using the cached credentials
4. On success: `markAuthValidated()` is called, sync resumes
5. On failure: `clearPendingSyncQueue()` is called to prevent unauthorized data from reaching the server

---

With sync and auth covered, the next sections describe the application-facing APIs: how apps read and write data, subscribe to changes, and handle UI animations.

## 10. Data Operations

**File**: `src/data.ts`

The generic CRUD layer replaces per-entity repository boilerplate with a unified, table-driven API. Instead of writing separate create/update/delete functions for every table, apps use a single set of generic functions. All operations reference tables by their Supabase name; the engine resolves to the corresponding Dexie table internally (snake_case -> camelCase via `snakeToCamel()`).

### 11.1 Write Operations

All write operations follow the same transactional pattern:

1. Open a Dexie read-write transaction spanning the target table + syncQueue
2. Apply the mutation locally
3. Enqueue the corresponding sync operation
4. After commit: `markEntityModified(entityId)` + `scheduleSyncPush()`

| Function | Op Type | Description |
|----------|---------|-------------|
| `engineCreate(table, data)` | `create` | Insert new entity; auto-generates UUID if `data.id` is absent |
| `engineUpdate(table, id, fields)` | `set` | Update fields; auto-sets `updated_at`; skips if entity doesn't exist |
| `engineDelete(table, id)` | `delete` | Soft-delete (`deleted=true`); auto-sets `updated_at` |
| `engineIncrement(table, id, field, delta)` | `increment` | Add numeric delta to a field; reads current value, writes new value |
| `engineBatchWrite(operations)` | mixed | Atomic batch of creates/updates/deletes in a single transaction |

`engineIncrement` is distinct from `engineUpdate` because it preserves the increment intent for coalescing. Using `engineUpdate` for a counter would store a `set` intent, losing the ability to sum multiple increments.

### 11.2 Read Operations

| Function | Description |
|----------|-------------|
| `engineGet(table, id)` | Get a single entity by ID from Dexie |
| `engineGetAll(table)` | Get all entities from a Dexie table |
| `engineQuery(table, indexName, value)` | Query by Dexie index |
| `engineQueryRange(table, indexName, lower, upper)` | Range query on a Dexie index |
| `engineGetOrCreate(table, id, defaults)` | Get or create with default values |

**Remote Fallback:** When a read returns empty results and the device is online, the engine optionally fetches from Supabase and populates the local store. This handles the "first load on a new device" case.

### 11.3 Helper Functions

| Helper | Pattern Eliminated |
|--------|--------------------|
| `queryAll<T>(table)` | `engineGetAll().filter(i => !i.deleted).sort((a,b) => a.order - b.order)` |
| `queryOne<T>(table, id)` | `engineGet()` + null-if-deleted guard |
| `reorderEntity<T>(table, id, order)` | `engineUpdate(table, id, { order })` with cast |
| `prependOrder(table, index, value)` | `engineQuery` + filter deleted + min computation |

---

## 11. Reactive Stores

**Files**: `src/stores/`

Reactive stores bridge the gap between the sync engine and the UI. They expose engine state as Svelte-compatible stores that automatically update when sync completes, remote changes arrive, or network state changes.

### 11.1 Auth State Store (`authState.ts`)

Object store tracking the current authentication mode and session. See [Section 9.2](#92-auth-state-store).

### 11.2 Sync Status Store (`sync.ts`)

Tracks sync progress for UI indicators (e.g., a spinning sync icon):

```typescript
interface SyncState {
  status: 'idle' | 'syncing' | 'error' | 'offline';
  pendingCount: number;
  lastError: string | null;
  lastErrorDetails: string | null;
  syncErrors: SyncError[];     // Rolling history, capped at MAX_ERROR_HISTORY
  lastSyncTime: string | null; // ISO 8601
  realtimeState: 'disconnected' | 'connecting' | 'connected' | 'error';
  isTabVisible: boolean;
  progress: SyncProgress | null; // Real-time batch-push progress (null when idle)
}

interface SyncProgress {
  total: number;           // Queue size at start of push (denominator)
  completed: number;       // Items successfully pushed
  failed: number;          // Items that errored (still in queue for retry)
  currentTable: string | null; // Table currently being pushed
}
```

**Anti-Flicker Logic:** The store enforces a minimum 500ms display time for the `'syncing'` state. If a sync cycle completes faster than 500ms, the status change to `'idle'` is deferred until the minimum time elapses. This prevents the sync indicator from rapidly flashing on and off.

**Batch-Push Progress:** When a push cycle begins with `>= 50` queued items, `pushPendingOps()` calls `startProgress(total)` and polls IndexedDB every 400ms to update `progress.completed` and `pendingCount`. This powers the `SyncStatus` component's `'catching-up'` state — a determinate progress ring and shimmer bar that surfaces to users during high-volume sync operations (e.g., 2500-item first-login fetches or mass category deletions). The progress field clears on push completion via a `try/finally` block to guarantee cleanup even on error.

**Offline Cold Start:** When `startSyncEngine()` detects the device is offline at startup, it immediately sets status to `'offline'` with a user-friendly message. Without this, `syncStatusStore.reset()` would leave the status as `'idle'`, and the sync indicator would not show the offline state until the first online→offline transition.

**Batch Mode:** `engineBatchWrite()` enters batch mode before its transaction and exits after. In batch mode, individual `queueSyncOperation()` calls suppress per-item `setPendingCount()` updates. A single count update fires on `exitBatchMode()`. This avoids O(N) IndexedDB count queries for large batch writes (e.g., 200 propagation updates).

Setter methods: `setStatus()`, `setPendingCount()`, `setError()`, `setRealtimeState()`, `setSyncMessage()`, `addSyncError()`.

### 11.3 Remote Changes Store (`remoteChanges.ts`)

Manages incoming realtime changes and active editing state for UI animations and deferred change handling.

**Action Type Detection:**
Since Supabase Realtime only sends INSERT/UPDATE/DELETE events (no semantic action type), the store infers the user-level action by analyzing which fields changed:

| Supabase Event | Changed Field(s) | Inferred Action |
|----------------|-------------------|-----------------|
| INSERT | -- | `'create'` |
| DELETE | -- | `'delete'` |
| UPDATE | `completed` | `'toggle'` |
| UPDATE | `current_value` (increased) | `'increment'` |
| UPDATE | `current_value` (decreased) | `'decrement'` |
| UPDATE | `order` | `'reorder'` |
| UPDATE | `name` | `'rename'` |
| UPDATE | `is_enabled` | `'toggle'` |
| UPDATE | other | `'update'` |

**Entity Classification:**
- **Auto-save entities** (toggles, quick actions): Changes apply immediately with animation
- **Form entities** (modals with Save button): Remote changes are deferred and queued until the form closes, preventing mid-edit data corruption

**Derived Store Factories:**
- `createRecentChangeIndicator(entityId)` -- reactive per-entity subscription for animation triggers
- `createPendingDeleteIndicator(entityId)` -- reactive indicator for pending soft deletes

### 11.4 Network Store (`network.ts`)

**File**: `src/stores/network.ts`

Tracks online/offline state with a workaround for iOS PWA quirks:

```
+----------+     'offline' event     +-----------+
|  ONLINE  |------------------------->|  OFFLINE  |
|          |                          |           |
|  - Sync  |     'online' event      | - Local   |
|    active |<-------------------------  only     |
|  - RT    |     + 500ms delay        | - Queue   |
|    alive |                          |   ops     |
+----+-----+                          +-----+-----+
     |                                      |
     | visibilitychange                     |
     | (document.hidden)                    |
     v                                      |
+----------+                                |
| HIDDEN   |   visibilitychange (visible)   |
| (iOS PWA)|   + check navigator.onLine     |
|          |--------------------------------+
| - Assume |   If online + wasOffline:
|   might  |     trigger reconnect callbacks
|   lose   |
|   conn.  |
+----------+
```

**iOS PWA Special Handling:** iOS Safari does not reliably fire `online`/`offline` events in PWA standalone mode. The store listens for `visibilitychange` events as a fallback -- when the app becomes visible again, it checks the actual network state.

**Sequential Callback Execution:** Reconnect callbacks are executed sequentially with async/await (not concurrently). This ensures auth validation completes before sync is triggered.

### 11.5 Store Factories (`factories.ts`)

Consumer apps typically create many collection stores and detail stores. The store factories extract the common pattern:

**`createCollectionStore<T>(config)`:**
- Creates a writable store with `[]` initial value + loading writable
- Auto-registers for `onSyncComplete` to refresh data
- Provides `refresh()` (without loading toggle), `mutate()` for optimistic updates
- SSR guard (`typeof window`)
- Consumer only needs to define: `load()` function

**`createDetailStore<T>(config)`:**
- Same pattern for single-entity views
- Adds ID tracking so `onSyncComplete` refreshes the correct entity

### 11.6 Choosing Between `load()`, `refresh()`, and `mutate()`

| Method | Loading spinner | IndexedDB re-query | Use when |
|--------|----------------|--------------------|----------|
| `load()` | Yes | Yes | Initial page load; cold start where data may be absent |
| `refresh()` | No | Yes | After external sync or cascading writes; background re-read |
| `mutate(fn)` | No | No | After a local write — instant optimistic in-memory update |

**Optimistic update pattern** (preferred after writes):

```ts
// After create: spread the returned record directly into the store
const created = await engineCreate('tasks', payload);
store.mutate(items => [...items, created as Task]);

// After update: swap the modified record in-place
const updated = await engineUpdate('tasks', id, delta);
if (updated) store.mutate(items => items.map(i => i.id === id ? updated as Task : i));

// After delete: filter out the removed record
store.mutate(items => items.filter(i => i.id !== id));
```

Both `engineCreate` and `engineUpdate` return the full persisted record (with `created_at`, `updated_at`, `_version`, etc.), so the mutated state is immediately accurate without a re-query.

**Why avoid `store.load()` after writes**: it shows a loading spinner and triggers a full IndexedDB scan. With `mutate()`, the UI updates in < 1ms. The store still auto-refreshes from IndexedDB on the next `onSyncComplete` callback, which corrects any discrepancy.

**Exception — use `store.refresh()` when**:
- The write cascades to other records (e.g., deleting a category clears `category_id` on many transactions)
- The full updated state cannot be derived from the engine return value alone (e.g., joined/aggregated queries)

---

## 12. Svelte Actions

**File**: `src/actions/remoteChange.ts`

Svelte actions are reusable behaviors attached to DOM elements. These actions handle the visual feedback when remote changes arrive or local actions occur.

### 12.1 `remoteChangeAnimation`

A Svelte action that automatically adds CSS animation classes to elements when remote changes arrive:

| Action Type | CSS Class | Visual Effect |
|-------------|-----------|---------------|
| `'create'` | `item-created` | Slide in with burst |
| `'delete'` | `item-deleting` | Slide out with fade |
| `'toggle'` | `item-toggled` + `checkbox-animating` + `completion-ripple` | Toggle animation |
| `'increment'` | `counter-increment` | Bump up |
| `'decrement'` | `counter-decrement` | Bump down |
| `'reorder'` | `item-reordering` | Slide to new position |
| `'rename'` | `text-changed` | Highlight flash |
| `'update'` | `item-changed` | Default highlight |

Features:
- Overlap prevention: if a new animation fires while one is in progress, the old one is cleaned up first
- Fallback cleanup: animations are removed after `animationend` event or a timeout (safety net)
- Configurable fields filter: only animate if specific fields changed
- Custom CSS class override
- `onAction` callback for component-specific handling beyond CSS

### 12.2 `trackEditing`

Tracks whether the user is currently editing an entity in a form. When a form is open:
- Auto-save forms: remote changes apply immediately
- Manual-save forms: remote changes are deferred until the form closes

### 12.3 `triggerLocalAnimation`

Programmatic animation trigger for locally initiated actions (not remote). Supports rapid-fire animations (e.g., quickly tapping increment/decrement).

---

## 13. Demo Mode

**File**: `src/demo.ts`

Demo mode provides a completely isolated sandbox at the engine level, allowing users to try the app without creating an account or connecting to a server. Every layer of the engine participates in the isolation to ensure zero risk of data contamination.

### 13.1 Database Isolation

- `initEngine()` detects `isDemoMode()` and appends `_demo` to the database name
- The real database is never opened -- zero risk of data contamination
- On page refresh, the demo DB is re-seeded with fresh mock data via the consumer's `seedData(db)` function

### 13.2 Auth Isolation

- `resolveAuthState()` short-circuits and returns `authMode: 'demo'`
- No Supabase session is created or validated
- `authState` store uses `setDemoAuth()` with a mock profile from `DemoConfig`

### 13.3 Network Isolation

All sync/queue/realtime entry points guard against demo mode:
- `startSyncEngine()`, `runFullSync()`, `scheduleSyncPush()` -- return early
- `queueSyncOperation()`, `queueCreateOperation()`, `queueDeleteOperation()` -- return early
- `startRealtimeSubscriptions()` -- return early

### 13.4 Cross-Tab Safety

Demo mode uses a two-part mechanism to prevent cross-tab data contamination:

1. **Snapshot at init:** `_setDemoPrefix()` (called by `initEngine()`) captures the current localStorage demo flag into a module-level variable. After init, `isDemoMode()` returns this cached snapshot -- it never re-reads localStorage. This prevents another tab's demo mode toggle from poisoning an already-running session (which would cause the sync engine to push demo data to Supabase).

2. **BroadcastChannel force-reload:** `setDemoMode()` broadcasts a `DEMO_MODE_CHANGED` message to all other tabs. `_setDemoPrefix()` registers a `BroadcastChannel` listener that calls `window.location.reload()` on receipt, forcing a full engine teardown and reinitialization with the correct database.

Without the snapshot, a tab running in production mode could see `isDemoMode() === true` on its next client navigation (because localStorage is shared), causing `seedDemoData()` to run against the **production** Dexie database -- wiping real data and replacing it with mock data.

### 13.5 Data Flow

```
User -> setDemoMode(true) + page reload
  -> initEngine() -> isDemoMode() -> DB name: ${name}_demo
  -> resolveAuthState() -> authMode: 'demo'
  -> seedDemoData() -> consumer's seedData(db) populates mock data
  -> CRUD reads/writes go to demo DB (local only)
  -> Sync/queue/realtime guards prevent any server traffic

Cross-tab:
  setDemoMode(true) -> BroadcastChannel -> other tabs receive DEMO_MODE_CHANGED
    -> window.location.reload() -> initEngine() reads fresh localStorage
    -> engine reinitializes with demo (or real) database
```

### 13.6 Security Model

- Demo mode does NOT bypass auth -- it replaces the entire data layer
- If someone manually sets the localStorage flag, they see an empty/seeded demo DB
- No path to real user data exists (different database, no Supabase client with real credentials)
- Full page reload required to enter/exit
- `isDemoMode()` is snapshotted at init -- localStorage mutations by other tabs cannot change the running engine's mode

### 13.7 UI Components

Two Svelte components handle demo mode UI from `stellar-drive/components/`:

- **`DemoBanner`** — fixed-position bottom pill banner shown when demo mode is active. Dismissible. Respects the `--demo-banner-bottom` CSS custom property so apps can raise it above their mobile nav bar (set to `4.5rem` on mobile; defaults to `1rem`). z-index: 9000. Mount once in the root layout alongside `<DemoBlockedMessage />`.

- **`DemoBlockedMessage`** — center-screen modal overlay triggered by `showDemoBlocked(message)` from `stellar-drive/demo`. Auto-dismisses after 3 seconds; clicking the backdrop dismisses immediately. Uses neutral dark glass styling that works across all app themes. z-index: 9950 (above DemoBanner, below the sign-out overlay at 9998). Mount once in the app root layout.

**Pattern:** `showDemoBlocked(message)` (exported from `stellar-drive/demo`) writes to `_demoBlockedStore`, which `<DemoBlockedMessage />` reads reactively. Apps must mount `<DemoBlockedMessage />` in their root layout for any calls to `showDemoBlocked()` to render. This is the standardized replacement for all per-page ad-hoc "not available in demo mode" toast implementations.

### 13.8 Offline Navigation Toast

**Component:** `stellar-drive/components/OfflineToast`

When a user navigates to a page whose JavaScript chunks are not cached in the service worker, the dynamic import fails with an `unhandledrejection` event. `<OfflineToast />` catches this centrally and surfaces a friendly message ("This page isn't available offline. Please reconnect or go back.") instead of letting it bubble up as an unhandled error.

- **Self-contained** — registers its own `unhandledrejection` listener in a `$effect` with cleanup on destroy. Apps mount it once in the root layout; no props or store wiring required.
- **z-index 1500** — positioned top-center, above all navigation chrome but below full-screen overlays.
- **Auto-dismisses** after 5 seconds. Dismiss button available immediately.
- **Error variant** available via the internal `show(msg, 'error')` API for future use.
- **Styled** with stellar-drive design tokens (`#1a2e1a` / `#3d5a3d` green-dark theme) — app-neutral.

This replaces the per-app inline `unhandledrejection` + toast state pattern that was previously duplicated in both Stellar and Radiant's root layouts.

**Mobile banner positioning:** Apps set `--demo-banner-bottom: 4.5rem` in a `@media (max-width: 767px)` rule on `:root` in their root layout `<style>` block. This raises the banner above the ~64px mobile tab bar without affecting the desktop layout.

### 13.9 Toast Notifications

**Store:** `stellar-drive/toast` — **Component:** `stellar-drive/components/GlobalToast`

Centralized toast notification system. The store (`src/stores/toast.ts`) manages the queue; the component (`src/components/GlobalToast.svelte`) renders it.

**Variants:**

| Variant | Colour | Icon | Semantic |
|---|---|---|---|
| `info` | Blue | Info circle | Informational / neutral (default) |
| `success` | Green | Check circle | Confirmations, completed operations |
| `error` | Red | X circle | Failures, deletions, blocked operations |
| `warning` | Purple | Alert triangle | Caution, non-fatal issues |

**API:** `addToast(message, variant?, duration?)` enqueues a toast. `dismissToast(id)` removes it immediately. `toastStore` is a read-only `Readable<Toast[]>`.

**`<GlobalToast />`** — self-contained, no props. Subscribes to `toastStore`, renders each toast as a frosted-glass pill with a semantic icon, and calls `dismissToast` after the duration elapses. Handles demo-mode banner offset automatically (shifts the stack up when `<DemoBanner />` is active). Mount once in the root layout:

```svelte
import GlobalToast from 'stellar-drive/components/GlobalToast';
<GlobalToast />
```

Dispatch from any module:

```ts
import { addToast } from 'stellar-drive/toast';
addToast('Item saved', 'success');
addToast('Sync failed', 'error');
```

---

## 14. SQL & TypeScript Generation

**File**: `src/schema.ts`

The schema module generates both the Supabase SQL DDL (Data Definition Language -- the SQL statements that create tables, indexes, and policies) and TypeScript interfaces from the same schema definition. This ensures the database structure and TypeScript types never drift apart.

### 14.1 `generateSupabaseSQL(schema, options)`

Generates complete Supabase SQL from a declarative schema. Accepts a `prefix` option which causes all generated `CREATE TABLE` names, RLS policy names, trigger names, and index names to be prefixed with `${prefix}_`. Auto-migration SQL is also generated to rename legacy unprefixed tables (e.g., `ALTER TABLE goals RENAME TO stellar_goals`) for backward compatibility.

Generated output includes:
- `CREATE TABLE` statements with system columns (`id`, `user_id`, `created_at`, `updated_at`, `deleted`, `_version`, `device_id`) -- table names are prefixed (e.g., `stellar_goals`)
- Convergent column migration: add new columns, converge types/nullability/defaults on existing columns, drop stale columns no longer in the schema
- Row-Level Security (RLS) policies per table
- `updated_at` trigger (auto-update on modification)
- `set_user_id` trigger (auto-set `user_id` from `auth.uid()`)
- Indexes for common query patterns
- Unique constraint indexes (from `uniqueConstraints` config)
- `DROP TABLE` for tables removed from the schema (via `previousTables` discovery)
- Realtime subscription enablement
- Optional: `trusted_devices` table, helper functions

### 14.2 Column Type Inference

Types are inferred from field naming conventions, so you rarely need to specify SQL types explicitly:

| Pattern | Inferred SQL Type | Example |
|---------|-------------------|---------|
| `*_id` | `uuid` | `goal_list_id` |
| `*_at` | `timestamptz` | `completed_at` |
| `order` | `double precision default 0` | `order` |
| `*_count`, `*_value`, `*_duration`, `*_total` | `integer default 0` | `elapsed_duration` |
| `is_*`, `completed`, `deleted`, `enabled`, `active` | `boolean default false` | `is_enabled` |
| `*_url`, `*_path` | `text` | `avatar_url` |
| Everything else | `text` | `title` |

SQL reserved words (`order`, `type`, `section`, `status`, `date`, `name`, `value`) are automatically double-quoted in generated DDL/DML.

### 14.3 `generateMigrationSQL(oldSchema, newSchema)`

Generates `ALTER TABLE` statements for:
- Table renames (via `renamedFrom`)
- Column renames (via `renamedColumns`)
- New columns added in the new schema

### 14.4 `generateTypeScript(schema, options)`

Generates TypeScript interfaces from schema field definitions. Each table gets an interface with typed fields. System columns (`id`, `user_id`, `created_at`, etc.) are optionally included.

### 14.5 Unique Constraints

Tables can declare `uniqueConstraints` to enforce uniqueness at the database level. Each constraint generates a `CREATE UNIQUE INDEX IF NOT EXISTS` statement. Partial unique indexes are supported via the optional `where` clause.

```ts
transactions: {
  indexes: 'account_id, date',
  uniqueConstraints: [
    { columns: ['teller_transaction_id'], where: 'teller_transaction_id is not null' }
  ]
}
```

This produces:

```sql
create unique index if not exists idx_transactions_teller_transaction_id_unique
  on transactions(teller_transaction_id)
  where teller_transaction_id is not null;
```

The index name follows the pattern `idx_{tableName}_{columns joined by _}_unique`. Multi-column constraints are supported (e.g., `{ columns: ['user_id', 'slug'] }`). The `where` clause enables partial indexes -- for example, enforcing uniqueness only on non-null values of an optional foreign key.

---

## 15. Diagnostics

**File**: `src/diagnostics.ts`

The diagnostics system provides full observability into the engine's internal state. This is invaluable for debugging sync issues, understanding egress costs, and monitoring conflict resolution in production.

### 15.1 `getDiagnostics()`

Returns a comprehensive `DiagnosticsSnapshot` -- a single JSON-serializable object with all observable engine state. Each call returns a point-in-time snapshot covering: sync cycles, egress stats, queue state, realtime connection, network status, conflict history, errors, and configuration.

```json
{
  "timestamp": "2025-01-15T10:30:00.000Z",
  "prefix": "stellar",
  "deviceId": "abc123",
  "sync": {
    "status": "idle",
    "totalCycles": 42,
    "lastSyncTime": "2025-01-15T10:29:55.000Z",
    "cyclesLastMinute": 2,
    "hasHydrated": true,
    "schemaValidated": true,
    "pendingCount": 0
  },
  "egress": {
    "totalBytes": 46315,
    "totalFormatted": "45.23 KB",
    "totalRecords": 312,
    "byTable": {
      "goals": { "bytes": 18944, "formatted": "18.50 KB", "records": 180, "percentage": "40.9%" }
    }
  },
  "queue": {
    "pendingOperations": 0,
    "byTable": {},
    "byOperationType": {},
    "itemsInBackoff": 0
  },
  "realtime": { "connectionState": "connected", "healthy": true, "reconnectAttempts": 0 },
  "network": { "online": true },
  "engine": {
    "isTabVisible": true,
    "lockHeld": false,
    "lockHeldForMs": null,
    "recentlyModifiedCount": 0,
    "wasOffline": false,
    "authValidatedAfterReconnect": true
  },
  "conflicts": { "recentHistory": [], "totalCount": 0 },
  "errors": { "lastError": null, "recentErrors": [] },
  "config": { "tableCount": 5, "tableNames": ["goals", "..."], "syncDebounceMs": 2000 }
}
```

### 15.2 Sub-Category Functions

Lightweight access to specific sections without fetching the full snapshot:

| Function | Async | Returns |
|----------|-------|---------|
| `getDiagnostics()` | Yes | Full `DiagnosticsSnapshot` |
| `getSyncDiagnostics()` | No | Sync cycles + egress stats |
| `getRealtimeDiagnostics()` | No | WebSocket connection state |
| `getQueueDiagnostics()` | Yes | Pending operations breakdown |
| `getConflictDiagnostics()` | Yes | Recent conflict history |
| `getEngineDiagnostics()` | No | Internal engine state (locks, visibility) |
| `getNetworkDiagnostics()` | No | Online/offline status |
| `getErrorDiagnostics()` | No | Recent errors |

### 15.3 Console Debug Functions

Available in debug mode via the browser console (toggle: `localStorage.setItem('{prefix}_debug_mode', 'true')`):

| Function | Purpose |
|----------|---------|
| `window.__{prefix}Diagnostics()` | Full diagnostics snapshot (async) |
| `window.__{prefix}Tombstones()` | Count of tombstones per table |
| `window.__{prefix}Tombstones({ cleanup: true, force: true })` | Trigger tombstone cleanup |
| `window.__{prefix}Sync.sync()` | Trigger immediate sync cycle |
| `window.__{prefix}Sync.forceFullSync()` | Reset cursor + full re-sync |
| `window.__{prefix}Sync.resetSyncCursor()` | Clear cursor (next sync = full) |

### 15.4 Debug Logging

**File**: `src/debug.ts`

All log messages use structured prefixes for filtering in the browser console:

| Prefix | Source | Examples |
|--------|--------|---------|
| `[SYNC]` | Sync engine | Push/pull operations, cursor updates, lock management |
| `[Realtime]` | WebSocket manager | Connection state, incoming changes, echo suppression |
| `[Conflict]` | Conflict resolver | Field resolutions, strategy selection, history storage |
| `[QUEUE]` | Sync queue | Coalescing cancellations, zero-delta pruning |
| `[Tombstone]` | Cleanup system | Local/server cleanup counts |
| `[Auth]` | Auth layer | Login, credential caching, session validation |
| `[Network]` | Network store | Reconnect/disconnect callbacks |
| `[DB]` | Database | Object store validation, recovery |

When debug mode is disabled, all `debugLog()`, `debugWarn()`, and `debugError()` calls are no-ops (zero overhead).

---

## 16. SvelteKit Integration

**Files**: `src/kit/`

While the core engine is framework-agnostic, these modules provide first-class SvelteKit integration for common patterns like layout load functions, server-side config, email confirmation, and service worker management.

### 16.1 Load Function Helpers (`kit/loads.ts`)

**`resolveRootLayout()`**: Full app initialization sequence for the root `+layout.ts`:
1. Initialize runtime config (`initConfig`) -- fetches Supabase credentials from `/api/config`
2. Resolve auth state (`resolveAuthState`) -- determines supabase/offline/demo/none
3. Start sync engine (`startSyncEngine`) -- if authenticated
4. Seed demo data (`seedDemoData`) -- if demo mode
5. Return `RootLayoutData` with auth mode, session, and `serverConfigured` flag

**Auth guarding**: Handled in the root layout via a `PUBLIC_ROUTES` list. Unauthenticated users on non-public routes are redirected to `/login?redirect=<returnUrl>` (for locked/new-device scenarios) or `/setup` (for first-time configuration when `serverConfigured === false`).

**`resolveSetupAccess()`**: Access control for the `/setup` wizard:
- Allows access when no config exists (first-time setup)
- Requires authentication for reconfiguration

### 16.2 Server Handlers (`kit/server.ts`)

**`getServerConfig()`**: Returns runtime Supabase config for client hydration. Reads from environment variables.

**`createServerSupabaseClient(prefix?)`**: Creates a server-side Supabase client from environment variables. When a `prefix` is provided (e.g. `'switchboard'`), returns a Proxy that transparently prefixes all `.from()` calls -- `.from('users')` becomes `.from('switchboard_users')`. This matches the client-side auto-prefixing done by `resolveSupabaseName()` in `config.ts`.

**`deployToVercel(config)`**: Deploys environment variables to a Vercel project. Used by the `/setup` wizard. Accepts an optional `prefix` field in `DeployConfig` -- when set, also writes `PUBLIC_APP_PREFIX` to Vercel env vars.

**`createValidateHandler()`**: Creates a request handler that validates Supabase credentials and schema against the database.

### 16.3 Email Confirmation (`kit/confirm.ts`)

**`handleEmailConfirmation(url)`**: Processes email confirmation links (signup, device verification, email change). Calls `supabase.auth.verifyOtp()` with the token hash from the URL.

**`broadcastAuthConfirmed(verificationType)`**: Sends an `AUTH_CONFIRMED` message via the browser's `BroadcastChannel` API. The original tab listens for this message and calls the appropriate completion function.

### 16.4 Auth Hydration (`kit/auth.ts`)

**`hydrateAuthState(data)`**: Bridge function that takes layout data and sets the appropriate auth state in the `authState` store. Called in `+layout.svelte` to synchronize the store with the load function's results.

### 16.5 Service Worker (`kit/sw.ts`)

**`pollForNewServiceWorker(options)`**: Active polling for a new SW after deployment. Configurable interval (default 5s) and max attempts (default 60, ~5 minutes).

**`handleSwUpdate()`**: Triggers `SKIP_WAITING` on a waiting SW and reloads the page when the new controller activates.

**`monitorSwLifecycle(callbacks)`**: Comprehensive passive monitoring using 6 detection strategies for maximum reliability across browsers and platforms (including iOS PWA quirks):

1. **Registration statechange**: Listen for `installing` -> `waiting` transition
2. **Existing waiting worker**: Check on mount if SW is already waiting
3. **Controller change**: Listen for `navigator.serviceWorker.controllerchange`
4. **Registration update**: Periodic `registration.update()` checks
5. **Visibility change**: Re-check on tab focus (iOS may miss events)
6. **Online event**: Re-check after regaining connectivity

All functions include SSR guards (`typeof navigator === 'undefined'`) for universal SvelteKit compatibility.

---

## 17. CLI Tool

**File**: `src/bin/commands.ts`

The CLI provides a scaffolding command that generates a complete SvelteKit project pre-wired for stellar-drive.

### 17.1 `stellar-drive install pwa`

Scaffolds a complete SvelteKit 2 + Svelte 5 PWA project via an interactive walkthrough:

```
+--------------------------------------------------------------------+
|                    INSTALL PWA SCAFFOLDER                           |
|                                                                    |
|  1. Interactive prompts: name, shortName, prefix, description       |
|  2. Write package.json with stellar-drive dep                       |
|  3. npm install                                                    |
|  4. Generate 51 template files (grouped with animated progress)    |
|  5. npx husky init + pre-commit hook                               |
|  6. Print styled summary + next steps                              |
+--------------------------------------------------------------------+
```

### 17.2 File Categories

| Category | Count | Examples |
|----------|-------|---------|
| Config | 10 | `vite.config.ts`, `tsconfig.json`, `svelte.config.js`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `knip.json`, `.gitignore`, `.env.example`, `package.json` |
| Documentation | 3 | `README.md`, `ARCHITECTURE.md`, `FRAMEWORKS.md` |
| Static assets | 12 | `manifest.json`, `offline.html`, SVG icons (6), email templates (3) |
| Source | 3 | `app.html`, `app.d.ts`, `app.css` |
| Routes | 16 | Layout files, auth pages, setup wizard, API routes |
| Library | 10 | `routes.ts`, `schema.ts`, `types.generated.ts`, `types.ts`, `stores/data.ts`, `db/queries.ts`, `db/repositories/items.ts`, `components/UpdatePrompt.svelte`, `demo/mockData.ts`, `demo/config.ts` |
| Git hooks | 1 | `.husky/pre-commit` |

### 17.3 Page Implementation Model

All infrastructure pages are **fully implemented** — the scaffold ships with complete UI, logic, and styling pre-wired using the green design theme from the email templates. Developers add their app-specific content on top.

**Fully implemented pages (no changes required to use):**

| Page | What's implemented |
|------|--------------------|
| `login/+page.svelte` | 3-mode auth (Setup / Unlock / Link Device), 6-digit PIN with auto-focus/paste/backspace, rate-limit countdown, email confirmation and device verification modals, BroadcastChannel cross-tab relay |
| `confirm/+page.svelte` | Token verification, BroadcastChannel broadcast, can-close / redirect fallback |
| `profile/+page.svelte` | Name edit, email change with modal, PIN change (3×6 inputs), trusted devices with revocation, debug mode toggle, diagnostics dashboard, debug tools |
| `setup/+page.svelte` | 4-step wizard: Supabase credentials → validate → deploy via Vercel API → SW polling |
| `+error.svelte` | 3 variants: offline / 404 / generic, retry and go-home actions |
| `policy/+page.svelte` | Self-hosted privacy policy template |
| `demo/+page.svelte` | Demo mode toggle with explanation |
| `[...catchall]` | Server-side 302 redirect to home |
| All API routes | Zero app-specific code required |

**TODO stubs (developer fills in):**

- `+page.svelte` (home) — add your app's dashboard content
- `src/lib/schema.ts` — replace example tables with your domain schema
- `src/lib/stores/data.ts` — add collection/detail stores for your tables
- `src/lib/db/queries.ts` — add query functions for your tables
- `src/lib/demo/mockData.ts` — seed realistic demo data

Three API routes are fully managed with zero app-specific code:

| Route | Handler | Purpose |
|-------|---------|---------|
| `/api/config` | `getServerConfig()` | Runtime Supabase config for client hydration |
| `/api/setup/deploy` | `deployToVercel()` | Deploy env vars to Vercel project |
| `/api/setup/validate` | `createValidateHandler()` | Validate Supabase credentials + schema |

### 17.4 Skip-If-Exists Safety

The scaffolder uses `writeIfMissing()` -- files are only created if they don't already exist:
- Running the command twice is safe (existing files are skipped)
- Developers can modify generated files without fear of overwriting
- The summary output shows which files were created vs skipped

### 17.5 Schema Workflow Integration

The scaffolded project is fully wired for the schema auto-generation workflow:

- `vite.config.ts` includes `stellarPWA({ ..., schema: true })`
- `src/lib/schema.ts` is the single source of truth, imported by both the Vite plugin and the app's `+layout.ts`
- `.env.example` documents all required env vars (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `DATABASE_URL`)
- `.gitignore` excludes `src/lib/types.generated.ts` (`.stellar/schema-snapshot.json` is committed for CI/CD migration diffing)
- `src/lib/types.ts` imports from `types.generated.ts` with guidance on `Omit` + extend narrowing

---

## 18. Vite Plugin Schema Processing

**File**: `src/sw/build/vite-plugin.ts`

The `stellarPWA` Vite plugin handles service worker builds, asset manifest generation, and (when `schema` is enabled) automatic TypeScript type generation and Supabase migration pushing. This creates a "save schema file -> types + database update automatically" developer experience.

### 18.1 Schema Processing Flow

```
Schema file changes (src/lib/schema.ts)
  |
  v
[Load schema] -- dev: ssrLoadModule()
  |               build: esbuild -> dynamic import
  v
[Generate TypeScript] -- generateTypeScript(schema) -> src/lib/types.generated.ts
  |
  v
[Load snapshot] -- .stellar/schema-snapshot.json
  |
  +-- No snapshot (first run):
  |     generateSupabaseSQL(schema) -> full CREATE TABLE DDL
  |
  +-- Snapshot exists:
        diff JSON.stringify(old) vs JSON.stringify(new)
        if different: generateMigrationSQL(old, new) -> ALTER TABLE deltas
  |
  v
[Push migration SQL] -- direct Postgres connection via DATABASE_URL
  |                      uses `postgres` npm package
  v
[Save snapshot] -- .stellar/schema-snapshot.json (only on success)
```

### 18.2 Dev vs Build Behavior

**Development** (`npm run dev`):
- `configureServer` hook loads the schema via Vite's `ssrLoadModule()` (live transpilation)
- Schema file is watched; changes trigger reprocessing with a **500ms debounce**
- Full cycle (types + diff + migrate) runs on every save

**Production** (`npm run build`):
- `buildStart` hook uses **esbuild** to transpile the schema file into a temp `.mjs` file, then dynamically imports it
- Schema is processed **once** during build (ensures CI/CD still migrates)
- Temp file is cleaned up after import

### 18.3 Environment Variables

| Variable | Required For | Description |
|---|---|---|
| `DATABASE_URL` | Migration push | Postgres connection string for direct SQL execution |

If `DATABASE_URL` is not set, TypeScript types are still generated but migration push is **skipped** with a console warning. This allows local development without database credentials.

### 18.4 Direct Postgres Migration

Migrations are pushed via a **direct Postgres connection** using the `DATABASE_URL` environment variable and the `postgres` npm package. This approach:

- **Eliminates bootstrap requirements** -- works on completely fresh databases with no prior setup
- **Uses idempotent SQL on first run** -- `CREATE TABLE IF NOT EXISTS` ensures existing databases aren't affected (table names are prefixed, e.g., `stellar_goals`)
- **Retries on failure** -- the schema snapshot is only saved after a successful push, so the next build retries automatically
- **Short-lived connections** -- one connection per migration push, closed immediately after

### 18.5 Migration Safety

- **Additive operations** (new tables, new columns) are applied automatically via `CREATE TABLE IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`.
- **Column convergence** -- existing columns are converged to match the schema: type (`ALTER COLUMN ... TYPE`), nullability (`SET/DROP NOT NULL`), and defaults (`SET/DROP DEFAULT`) are all updated.
- **Stale column removal** -- columns that exist in the live table but are no longer declared in the schema are automatically dropped via a PL/pgSQL introspection block. System columns (`id`, `user_id`, `created_at`, `updated_at`, `deleted`, `_version`, `device_id`) are never dropped.
- **Table removal** -- tables present in the database but removed from the schema are dropped when detected by `discoverExistingTables()`.
- **Renames** (via `renamedFrom` and `renamedColumns`) produce proper `ALTER TABLE ... RENAME` statements.

### 18.6 Generated Files

| File | Purpose | Git-tracked? |
|---|---|---|
| `src/lib/types.generated.ts` | TypeScript interfaces from schema `fields` | No |
| `.stellar/schema-snapshot.json` | Previous schema state for migration diffing | No |
| `static/sw.js` | Service worker with cache prefix and version | Yes |
| `static/asset-manifest.json` | Asset list for service worker precaching | Yes |

---

## 19. File Map

This is a complete reference of every source file and its purpose. Use it to quickly locate the code for any concept discussed above.

| Layer | File | Purpose |
|-------|------|---------|
| **Configuration** | | |
| Config | `src/config.ts` | Engine configuration, schema-to-config generation, auth normalization |
| Types | `src/types.ts` | Core type definitions (operations, auth, conflicts, devices) |
| Database | `src/database.ts` | Dexie instance creation, system tables, auto-versioning, recovery |
| Schema | `src/schema.ts` | SQL generation, TypeScript generation, migration SQL |
| Debug | `src/debug.ts` | Conditional debug logging system |
| Utils | `src/utils.ts` | Shared utilities (`formatBytes`, `generateId`, `snakeToCamel`, etc.) |
| Device ID | `src/deviceId.ts` | Stable per-device UUID for tiebreaking and echo suppression |
| Demo | `src/demo.ts` | Demo mode sandboxing (database isolation, mock auth, network guards) |
| **Sync Engine** | | |
| Engine | `src/engine.ts` | Core orchestrator: push/pull, hydration, tombstone cleanup, mutex |
| Queue | `src/queue.ts` | Outbox queue, 6-step coalescing pipeline, retry/backoff logic |
| Conflicts | `src/conflicts.ts` | Three-tier field-level conflict resolver, history persistence |
| Realtime | `src/realtime.ts` | Supabase Realtime WebSocket subscription manager |
| Data | `src/data.ts` | Generic CRUD operations, query helpers, remote fallback |
| Diagnostics | `src/diagnostics.ts` | Unified diagnostics snapshot API |
| **Authentication** | | |
| Supabase Auth | `src/supabase/auth.ts` | Supabase auth with offline credential caching |
| Supabase Client | `src/supabase/client.ts` | Proxy-based Supabase client (auto-created from runtime config) |
| Supabase Validate | `src/supabase/validate.ts` | Schema validation against Supabase database |
| Single-User | `src/auth/singleUser.ts` | PIN/password gate with real Supabase email/password auth |
| Resolve Auth | `src/auth/resolveAuthState.ts` | Auth state resolution for all modes |
| Device Verification | `src/auth/deviceVerification.ts` | Device trust management + OTP verification |
| Login Guard | `src/auth/loginGuard.ts` | Local credential pre-check + rate limiting |
| Crypto | `src/auth/crypto.ts` | SHA-256 hashing via Web Crypto API |
| Offline Creds | `src/auth/offlineCredentials.ts` | IndexedDB credential cache |
| Offline Session | `src/auth/offlineSession.ts` | Offline session token management |
| Display Utils | `src/auth/displayUtils.ts` | Auth-related display helpers |
| **Stores** | | |
| Auth State | `src/stores/authState.ts` | Multi-modal auth state store |
| Sync Status | `src/stores/sync.ts` | Reactive sync status with anti-flicker |
| Remote Changes | `src/stores/remoteChanges.ts` | Remote change notification + action type detection |
| Network | `src/stores/network.ts` | Online/offline detection with iOS PWA handling |
| Factories | `src/stores/factories.ts` | Generic collection/detail store factories |
| Toast | `src/stores/toast.ts` | App-wide toast notification queue (`addToast`, `dismissToast`, `toastStore`) |
| **Components** | | |
| SyncStatus | `src/components/SyncStatus.svelte` | Live sync status indicator (idle / syncing / catching-up / error) |
| DemoBanner | `src/components/DemoBanner.svelte` | Fixed-position demo mode active pill banner |
| DemoBlockedMessage | `src/components/DemoBlockedMessage.svelte` | Center-screen overlay triggered by `showDemoBlocked()` |
| DeferredChangesBanner | `src/components/DeferredChangesBanner.svelte` | Cross-device conflict notification with field-level diff preview |
| GlobalToast | `src/components/GlobalToast.svelte` | Toast queue renderer; mount once in root layout, no props needed |
| OfflineToast | `src/components/OfflineToast.svelte` | Chunk-load error recovery toast; self-managing `unhandledrejection` listener |
| **Actions** | | |
| Remote Change | `src/actions/remoteChange.ts` | Animation action, editing tracker, local animation trigger |
| Truncate Tooltip | `src/actions/truncateTooltip.ts` | Text truncation with tooltip |
| **SvelteKit** | | |
| Loads | `src/kit/loads.ts` | Root/protected layout load helpers |
| Server | `src/kit/server.ts` | Server-side handlers (config, deploy, validate) |
| Confirm | `src/kit/confirm.ts` | Email confirmation + BroadcastChannel bridge |
| Auth | `src/kit/auth.ts` | Auth hydration bridge for +layout.svelte |
| SW | `src/kit/sw.ts` | Service worker lifecycle (6 detection strategies) |
| **Runtime** | | |
| Runtime Config | `src/runtime/runtimeConfig.ts` | Runtime Supabase config with localStorage cache |
| **Service Worker** | | |
| SW Build | `src/sw/build/vite-plugin.ts` | Vite plugin for service worker build |
| SW Runtime | `src/sw/sw.ts` | Service worker runtime |
| **CLI** | | |
| Commands | `src/bin/commands.ts` | `stellar-drive install pwa` scaffolder |
| Install PWA | `src/bin/install-pwa.ts` | PWA scaffolding implementation |
| **Entry Points** | | |
| Main | `src/index.ts` | Public API barrel export |
| Auth Entry | `src/entries/auth.ts` | Subpath export for auth utilities |
| Stores Entry | `src/entries/stores.ts` | Subpath export for stores |
| Toast Entry | `src/entries/toast.ts` | Subpath export for toast notifications |
| Actions Entry | `src/entries/actions.ts` | Subpath export for actions |
| Config Entry | `src/entries/config.ts` | Subpath export for configuration |
| Kit Entry | `src/entries/kit.ts` | Subpath export for SvelteKit integration |
| Types Entry | `src/entries/types.ts` | Subpath export for type definitions |
| Utils Entry | `src/entries/utils.ts` | Subpath export for utilities |
| Vite Entry | `src/entries/vite.ts` | Subpath export for Vite plugin |
