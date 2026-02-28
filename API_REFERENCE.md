# stellar-drive API Reference

Complete reference for every public export from the `stellar-drive` package. This document is organized by **subpath export** — each section corresponds to a specific import path. All exports are also available from the root `stellar-drive` barrel import.

## Subpath Exports Overview

| Import Path | Purpose |
|---|---|
| `stellar-drive` | Full public API (everything below, re-exported) |
| `stellar-drive/auth` | Authentication: Supabase auth, single-user PIN/password gate, device verification, display helpers |
| `stellar-drive/stores` | Svelte reactive stores: sync status, auth state, network, remote changes, store factories |
| `stellar-drive/types` | All TypeScript type definitions (zero runtime code) |
| `stellar-drive/utils` | Utility functions, debug logging, diagnostics, SQL/TypeScript generation |
| `stellar-drive/actions` | Svelte `use:` action directives for DOM-level behavior |
| `stellar-drive/config` | Runtime configuration management (read/write app settings) |
| `stellar-drive/vite` | Vite plugin for PWA service worker builds, asset manifests, and schema auto-generation |
| `stellar-drive/kit` | SvelteKit-specific helpers: server route factories, layout loaders, email confirmation, SW lifecycle, auth hydration |
| `stellar-drive/crdt` | CRDT collaborative editing: document lifecycle, shared types, presence/cursors, offline, persistence |

---

## Table of Contents

- [Engine](#engine)
  - [Initialization](#initialization)
  - [Database Access](#database-access)
  - [Lifecycle](#lifecycle)
  - [Credential Validation](#credential-validation)
- [Data Operations (`stellar-drive` or `stellar-drive/data`)](#data-operations)
  - [Create](#create)
  - [Update](#update)
  - [Delete](#delete)
  - [Batch Write](#batch-write)
  - [Increment](#increment)
  - [Query — Single Entity](#query--single-entity)
  - [Query — Multiple Entities](#query--multiple-entities)
  - [Query Helpers](#query-helpers)
  - [Reorder Helpers](#reorder-helpers)
- [Authentication (`stellar-drive/auth`)](#authentication)
  - [Supabase Auth Core](#supabase-auth-core)
  - [Auth State Resolution](#auth-state-resolution)
  - [Login Guard](#login-guard)
  - [Single-User Auth (PIN/Password Gate)](#single-user-auth-pinpassword-gate)
  - [Device Verification](#device-verification)
  - [Display Utilities](#display-utilities)
- [Reactive Stores (`stellar-drive/stores`)](#reactive-stores)
  - [Sync Status Store](#sync-status-store)
  - [Remote Changes Store](#remote-changes-store)
  - [Network Store](#network-store)
  - [Auth State Stores](#auth-state-stores)
  - [Lifecycle Event Hooks](#lifecycle-event-hooks)
  - [Store Factories](#store-factories)
  - [Hydration State](#hydration-state)
- [Runtime Configuration (`stellar-drive/config`)](#runtime-configuration)
- [Svelte Actions (`stellar-drive/actions`)](#svelte-actions)
  - [remoteChangeAnimation](#remotechangeanimation)
  - [trackEditing](#trackediting)
  - [triggerLocalAnimation](#triggerlocalanimation)
  - [truncateTooltip](#truncatetooltip)
- [Utilities (`stellar-drive/utils`)](#utilities)
  - [General Utilities](#general-utilities)
  - [Debug Utilities](#debug-utilities)
  - [Diagnostics](#diagnostics)
  - [SQL Generation](#sql-generation)
  - [TypeScript Generation](#typescript-generation)
- [Demo Mode](#demo-mode)
- [Supabase Client](#supabase-client)
- [SvelteKit Helpers (`stellar-drive/kit`)](#sveltekit-helpers)
  - [Server Route Factories](#server-route-factories)
  - [Layout Load Functions](#layout-load-functions)
  - [Email Confirmation](#email-confirmation)
  - [Service Worker Lifecycle](#service-worker-lifecycle)
  - [Auth Hydration](#auth-hydration)
- [Vite Plugin (`stellar-drive/vite`)](#vite-plugin)
- [CRDT Collaborative Editing (`stellar-drive/crdt`)](#crdt-collaborative-editing)
  - [Document Lifecycle](#document-lifecycle)
  - [Shared Type Factories](#shared-type-factories)
  - [Yjs Re-exports](#yjs-re-exports)
  - [Awareness / Presence](#awareness--presence)
  - [Offline Management](#offline-management)
  - [Persistence (Advanced)](#persistence-advanced)
  - [CRDT Diagnostics](#crdt-diagnostics)
- [CLI (`stellar-drive` bin)](#cli)
  - [install pwa](#install-pwa)
- [Type Definitions (`stellar-drive/types`)](#type-definitions)

---

## Engine

These exports control the core sync engine — initialization, database access, lifecycle management, and server validation. Import from `stellar-drive`.

### Initialization

#### `initEngine(config)`

Bootstraps the entire sync engine with a declarative configuration. This must be called **before** any other stellar-drive function. It sets up the IndexedDB database schema, configures table mappings, auth settings, conflict resolution strategies, and optional subsystems (CRDT, demo mode).

The recommended approach is **schema-driven configuration**, where you pass a `schema` object and the engine auto-generates the database versions, table configs, and Dexie indexes. Alternatively, you can provide manual `tables` and `database` config for full control.

**Signature:**
```ts
function initEngine(config: InitEngineInput): void
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `config.prefix` | `string` | Namespace prefix for localStorage keys, cache names, and database names. Must be unique per app sharing a Supabase project. |
| `config.name` | `string` | Human-readable app name used in emails and service worker output. |
| `config.domain` | `string` | The canonical app URL (e.g., `'https://myapp.com'`). Used for email links and redirect validation. |
| `config.schema` | `SchemaDefinition` | Declarative table definitions. Keys are Supabase table names, values are index strings or `SchemaTableConfig` objects. |
| `config.tables` | `TableConfig[]` | *(Manual mode)* Array of per-table sync configurations. Mutually exclusive with `schema`. |
| `config.database` | `DatabaseConfig` | *(Manual mode)* IndexedDB database name and version definitions. Auto-generated when using `schema`. |
| `config.auth` | `AuthConfig` | Authentication configuration (gate type, device verification, email confirmation, offline auth). |
| `config.syncDebounceMs` | `number` | Delay in ms before pushing local changes to Supabase after a write. Default: `2000`. |
| `config.syncIntervalMs` | `number` | Interval in ms for periodic background sync polling. Default: `900000` (15 min). |
| `config.tombstoneMaxAgeDays` | `number` | Days before soft-deleted records are permanently purged. Default: `7`. |
| `config.crdt` | `CRDTConfig` | Enables the CRDT collaborative editing subsystem. Omit to disable. |
| `config.demo` | `DemoConfig` | Enables demo mode with sandboxed database and mock data. |

**Example — Schema-driven (recommended):**
```ts
import { initEngine } from 'stellar-drive';

initEngine({
  prefix: 'myapp',
  name: 'My App',
  domain: 'https://myapp.com',
  schema: {
    tasks: 'project_id, order',
    projects: { indexes: 'order', sqlColumns: { name: 'text not null' } },
    user_settings: { singleton: true }
  },
  auth: {
    gateType: 'pin',
    codeLength: 4,
    enableOfflineAuth: true,
    deviceVerification: { enabled: true, trustDurationDays: 90 },
    emailConfirmation: { enabled: true }
  },
  syncDebounceMs: 2000,
  syncIntervalMs: 900000
});
```

**Example — With CRDT and demo mode:**
```ts
initEngine({
  prefix: 'notes',
  name: 'Notes App',
  domain: 'https://notes.app',
  schema: {
    pages: 'notebook_id, order',
    notebooks: 'order'
  },
  auth: { gateType: 'password' },
  crdt: { persistIntervalMs: 30000 },
  demo: {
    seedData: async (db) => { /* seed mock data */ },
    mockProfile: { firstName: 'Demo', email: 'demo@example.com' }
  }
});
```

---

#### `SyncEngineConfig`

The top-level configuration interface after normalization. You typically don't construct this directly — use `InitEngineInput` with `initEngine()` instead.

```ts
interface SyncEngineConfig {
  prefix: string;
  name: string;
  domain: string;
  tables: TableConfig[];
  database: DatabaseConfig;
  auth: { singleUser: SingleUserAuthConfig };
  syncDebounceMs: number;
  syncIntervalMs: number;
  tombstoneMaxAgeDays: number;
  crdt?: CRDTConfig;
  demo?: DemoConfig;
}
```

---

#### `TableConfig`

Per-table sync configuration used internally by the engine.

```ts
interface TableConfig {
  name: string;           // Supabase table name (remote)
  dexieName: string;      // Local Dexie table name
  columns: string[];      // Columns to sync (not SELECT *)
  conflictStrategy: 'local_pending' | 'last_write' | 'numeric_merge' | 'delete_wins';
  orderField?: string;    // Field used for ordering (e.g., 'order')
  singleton?: boolean;    // Whether only one row per user exists
}
```

---

#### `InitEngineInput`

The input shape accepted by `initEngine()`. Supports both schema-driven and manual configuration, plus a flat `auth` config that gets normalized internally.

```ts
interface InitEngineInput {
  prefix: string;
  name: string;
  domain: string;
  schema?: SchemaDefinition;
  tables?: TableConfig[];
  database?: DatabaseConfig;
  auth: AuthConfig;
  syncDebounceMs?: number;
  syncIntervalMs?: number;
  tombstoneMaxAgeDays?: number;
  crdt?: CRDTConfig;
  demo?: DemoConfig;
}
```

---

### Database Access

#### `getDb()`

Returns a handle to the open Dexie (IndexedDB) database instance. Use this for advanced queries that go beyond the generic CRUD layer — for example, compound Dexie queries, direct table access, or debugging.

The database is guaranteed to be open after `initEngine()` completes. Calling this before initialization throws.

**Signature:**
```ts
function getDb(): Dexie
```

**Returns:** The initialized Dexie database instance.

**Example:**
```ts
import { getDb } from 'stellar-drive';

const db = getDb();
const allTasks = await db.table('tasks').toArray();
```

---

#### `resetDatabase()`

Deletes and recreates the entire local IndexedDB database. This is a **destructive nuclear recovery option** — all local data, sync queue entries, conflict history, and offline credentials are permanently lost. After calling this, the next `startSyncEngine()` call will trigger a full re-hydration from Supabase.

Use this when the database is corrupted, schema migrations fail, or the user explicitly requests a "reset local data" action.

**Signature:**
```ts
function resetDatabase(): Promise<void>
```

**Example:**
```ts
import { resetDatabase, startSyncEngine } from 'stellar-drive';

await resetDatabase();
await startSyncEngine(); // Will re-hydrate from Supabase
```

---

#### `waitForDb()`

Returns a promise that resolves once the IndexedDB database has been opened and all schema upgrades have completed. Useful when you need to ensure the database is ready before performing direct Dexie queries outside the engine's normal flow.

**Signature:**
```ts
function waitForDb(): Promise<void>
```

**Example:**
```ts
import { waitForDb, getDb } from 'stellar-drive';

await waitForDb();
const db = getDb(); // Guaranteed to be open
```

---

#### `SYSTEM_INDEXES`

A constant string containing the Dexie index definitions for system columns that are automatically appended to every table. These columns are managed by the engine and should not be set manually by application code.

**Value:** `'id, user_id, created_at, updated_at, deleted, device_id'`

**Signature:**
```ts
const SYSTEM_INDEXES: string
```

---

#### `computeSchemaVersion(prefix, stores)`

Computes a deterministic version number from the schema definition using DJB2 hashing. This enables automatic database versioning — when you add or modify tables in your schema, the version number changes automatically, triggering a Dexie schema upgrade without manual version bumping.

**Signature:**
```ts
function computeSchemaVersion(
  prefix: string,
  stores: Record<string, string>
): SchemaVersionResult
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `prefix` | `string` | App prefix for namespacing. |
| `stores` | `Record<string, string>` | Map of Dexie table names to index definitions. |

**Returns:** `SchemaVersionResult` — `{ version: number; stores: Record<string, string> }`.

**Example:**
```ts
import { computeSchemaVersion } from 'stellar-drive';

const result = computeSchemaVersion('myapp', {
  tasks: 'id, project_id, order, user_id, created_at, updated_at, deleted, device_id',
  projects: 'id, order, user_id, created_at, updated_at, deleted, device_id'
});
// result.version → deterministic integer based on schema hash
```

---

### Lifecycle

#### `startSyncEngine()`

Boots the sync engine and begins all background operations. This is the main "start" function that must be called **after** `initEngine()` and **after** the user is authenticated. It performs the following initialization sequence:

1. Ensures the Dexie database is open and upgraded
2. Subscribes to Supabase auth state changes (handles sign-out and token refresh)
3. Registers online/offline network handlers with auth validation
4. Registers tab visibility change handler for smart sync-on-return
5. Starts Supabase Realtime WebSocket subscriptions
6. Starts the periodic background sync interval
7. Validates the Supabase schema (one-time, non-blocking)
8. Runs initial hydration (if the local database is empty) or a full sync
9. Cleans up stale tombstones, conflict history, and failed sync items
10. Starts the watchdog timer to detect stuck syncs
11. Registers debug utilities on `window` for developer inspection

**Idempotent** — calling multiple times after the first is a no-op. Use `stopSyncEngine()` to reset and allow a fresh start.

**Signature:**
```ts
function startSyncEngine(): Promise<void>
```

**Example:**
```ts
import { initEngine, startSyncEngine } from 'stellar-drive';

initEngine({ /* ... */ });

// After user authenticates:
await startSyncEngine();
```

---

#### `runFullSync(quiet?, skipPull?)`

Triggers an immediate full sync cycle: push local changes to Supabase, then pull remote changes. This is the core sync orchestration function that handles the complete bidirectional sync flow:

1. **Pre-flight checks** — verifies online status, auth validity, and session expiry
2. **Acquires sync lock** — prevents concurrent sync cycles via mutex
3. **Push phase** — coalesces and sends pending local changes to Supabase
4. **Pull phase** — fetches remote changes since the last cursor, applies with conflict resolution
5. **Post-sync** — updates UI status stores, notifies registered callbacks, logs egress stats

The `quiet` parameter controls whether the UI sync indicator is shown. Background periodic syncs use `quiet: true` to avoid distracting the user. User-triggered syncs after local writes use `quiet: false` to show progress. The `skipPull` parameter enables push-only mode when realtime subscriptions are healthy, since remote changes arrive via WebSocket and polling is redundant.

**Signature:**
```ts
function runFullSync(quiet?: boolean, skipPull?: boolean): Promise<void>
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `quiet` | `boolean` | `false` | When `true`, suppresses the sync status indicator in the UI. |
| `skipPull` | `boolean` | `false` | When `true`, only pushes local changes (skips the pull phase). |

**Example:**
```ts
import { runFullSync } from 'stellar-drive';

// User-triggered sync with UI feedback:
await runFullSync();

// Silent background sync:
await runFullSync(true);

// Push-only (when realtime is healthy):
await runFullSync(false, true);
```

---

#### `onSyncComplete(callback)`

Registers a callback that fires after every successful sync cycle completes. This is the primary mechanism for Svelte stores to refresh their data after the engine has pulled remote changes into the local database.

Each callback is wrapped in try/catch so a failing store refresh doesn't prevent other registered callbacks from executing. Returns an unsubscribe function.

**Signature:**
```ts
function onSyncComplete(callback: () => void): () => void
```

**Returns:** An unsubscribe function that removes the callback.

**Example:**
```ts
import { onSyncComplete } from 'stellar-drive/stores';

const unsubscribe = onSyncComplete(() => {
  // Refresh your store data from local DB
  myStore.refresh();
});

// Later, when tearing down:
unsubscribe();
```

---

### Credential Validation

#### `validateSupabaseCredentials(url, key)`

Tests that a Supabase project URL and publishable (anon) key are valid and reachable. Creates a temporary Supabase client (does not affect the singleton) and attempts a lightweight REST API query. Used during initial app setup wizards to validate user-provided credentials before saving them.

Distinguishes between invalid credentials (wrong URL/key) and missing tables (valid credentials, but the database schema hasn't been applied yet).

**Signature:**
```ts
function validateSupabaseCredentials(
  url: string,
  key: string
): Promise<{ valid: boolean; error?: string; missingSchema?: boolean }>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `url` | `string` | The Supabase project URL (e.g., `'https://abc123.supabase.co'`). |
| `key` | `string` | The Supabase publishable (anon) key. |

**Returns:** Object with `valid` (boolean), optional `error` message, and `missingSchema` flag.

**Example:**
```ts
import { validateSupabaseCredentials } from 'stellar-drive';

const result = await validateSupabaseCredentials(
  'https://abc123.supabase.co',
  'eyJhbGciOiJIUzI1NiIs...'
);

if (!result.valid) {
  if (result.missingSchema) {
    console.log('Credentials OK, but database tables are missing');
  } else {
    console.error('Invalid credentials:', result.error);
  }
}
```

---

#### `validateSchema(supabaseClient, schema)`

Verifies that all required database tables exist and are accessible in the connected Supabase project. Executes a zero-data-egress query (`SELECT id FROM <table> LIMIT 0`) against each configured table to check for existence and RLS permission errors.

Automatically appends the `trusted_devices` table to validation if device verification is enabled. In demo mode, skips validation entirely and returns success.

**Signature:**
```ts
function validateSchema(
  supabaseClient: SupabaseClient,
  schema: SchemaDefinition
): Promise<{ valid: boolean; errors?: string[] }>
```

**Example:**
```ts
import { validateSchema, supabase } from 'stellar-drive';

const result = await validateSchema(supabase, {
  tasks: 'project_id, order',
  projects: 'order'
});

if (!result.valid) {
  console.error('Missing tables:', result.errors);
}
```

---

## Data Operations

All CRUD and query functions operate against the **local IndexedDB database** (via Dexie) for instant responsiveness. Write operations automatically enqueue changes in the sync queue for eventual push to Supabase. Read operations query locally first, with optional remote fallback for cache misses.

Import from `stellar-drive` (root barrel).

> **Table name convention:** All functions accept the **Supabase table name** (the remote/canonical name). The engine internally resolves it to the corresponding Dexie table name via the configured table map.

### Create

#### `engineCreate(table, data)`

Inserts a new entity into the local database and enqueues it for remote sync. This is the primary entry point for all entity creation. The operation is atomic — the Dexie insert and sync queue entry are wrapped in a single transaction.

Auto-generated fields:
- `id` — UUID v4 if not provided
- `created_at` — current ISO 8601 timestamp if not provided
- `updated_at` — current ISO 8601 timestamp if not provided

After the transaction commits, the entity is marked as modified (for reactive UI updates) and a debounced sync push is scheduled.

**Signature:**
```ts
function engineCreate(
  table: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `table` | `string` | Supabase table name (e.g., `'tasks'`). |
| `data` | `Record<string, unknown>` | Entity data. May include `id` to use a specific ID. |

**Returns:** The complete entity as stored in Dexie (with auto-generated fields).

**Throws:** `Dexie.ConstraintError` if an entity with the same `id` already exists.

**Example:**
```ts
import { engineCreate } from 'stellar-drive';

const task = await engineCreate('tasks', {
  title: 'Buy groceries',
  project_id: 'proj-123',
  order: 1,
  completed: false
});
// task.id → auto-generated UUID
// task.created_at → '2025-01-15T10:30:00.000Z'
```

---

### Update

#### `engineUpdate(table, id, fields)`

Patches specific fields on an existing entity. Automatically sets `updated_at` to the current timestamp. The update and corresponding sync queue entry are wrapped in a single transaction for atomicity.

If the entity does not exist (e.g., it was deleted between the caller's check and this call), the sync operation is skipped and `undefined` is returned — no orphan queue entries are created.

**Signature:**
```ts
function engineUpdate(
  table: string,
  id: string,
  fields: Record<string, unknown>
): Promise<Record<string, unknown> | undefined>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `table` | `string` | Supabase table name. |
| `id` | `string` | Primary key of the entity to update. |
| `fields` | `Record<string, unknown>` | Key-value pairs of fields to patch. |

**Returns:** The updated entity, or `undefined` if the entity was not found.

**Example:**
```ts
import { engineUpdate } from 'stellar-drive';

await engineUpdate('tasks', 'task-123', {
  title: 'Buy organic groceries',
  completed: true
});
```

---

### Delete

#### `engineDelete(table, id)`

Soft-deletes an entity by setting `deleted: true`. The entity remains in the local database for offline access and conflict resolution, but is hidden from query helpers like `queryAll` and `queryOne`. The deletion is enqueued for remote sync.

Tombstoned entities are permanently purged after `tombstoneMaxAgeDays` (default: 7 days).

**Signature:**
```ts
function engineDelete(table: string, id: string): Promise<void>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `table` | `string` | Supabase table name. |
| `id` | `string` | Primary key of the entity to soft-delete. |

**Example:**
```ts
import { engineDelete } from 'stellar-drive';

await engineDelete('tasks', 'task-123');
```

---

### Batch Write

#### `BatchOperation`

Discriminated union representing a single operation within a batch write. Each variant mirrors its corresponding single-entity function.

```ts
type BatchOperation =
  | { type: 'create'; table: string; data: Record<string, unknown> }
  | { type: 'update'; table: string; id: string; fields: Record<string, unknown> }
  | { type: 'delete'; table: string; id: string };
```

---

#### `engineBatchWrite(operations)`

Executes multiple write operations in a single atomic Dexie transaction. This is the preferred way to perform related mutations that must succeed or fail together — for example, creating a parent entity and its children, moving an item between lists, or bulk-updating sort orders.

All operations share a single `updated_at` timestamp for consistency. Transaction scope is dynamically computed: only the Dexie tables referenced by the operations (plus `syncQueue`) are locked, minimizing contention. After the transaction commits, all modified entity IDs are marked as modified in a single pass, and a single sync push is scheduled.

**Signature:**
```ts
function engineBatchWrite(operations: BatchOperation[]): Promise<void>
```

**Throws:** `Dexie.AbortError` if any operation fails — the entire batch is rolled back.

**Example:**
```ts
import { engineBatchWrite } from 'stellar-drive';

await engineBatchWrite([
  { type: 'create', table: 'projects', data: { id: 'proj-1', name: 'Work', order: 0 } },
  { type: 'create', table: 'tasks', data: { title: 'First task', project_id: 'proj-1', order: 0 } },
  { type: 'delete', table: 'tasks', id: 'old-task-123' }
]);
```

---

### Increment

#### `engineIncrement(table, id, field, amount, additionalFields?)`

Atomically increments a numeric field on an entity. Unlike a plain `engineUpdate` with a computed value, this function preserves the **increment intent** in the sync queue (`operationType: 'increment'`). This is critical for correct multi-device conflict resolution: when two devices each increment a counter by 1, the server applies both increments additively (+2) rather than last-write-wins (which would yield +1).

The local Dexie value is updated immediately via read-modify-write inside a transaction to prevent TOCTOU races. If additional fields need to be set alongside the increment (e.g., a `completed` flag), they are queued as a separate `set` operation so the increment and set semantics remain distinct.

**Signature:**
```ts
function engineIncrement(
  table: string,
  id: string,
  field: string,
  amount: number,
  additionalFields?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `table` | `string` | Supabase table name. |
| `id` | `string` | Primary key of the entity. |
| `field` | `string` | The numeric field to increment. |
| `amount` | `number` | The increment delta (can be negative for decrement). |
| `additionalFields` | `Record<string, unknown>` | Optional extra fields to set alongside the increment. |

**Returns:** The updated entity, or `undefined` if not found.

**Example:**
```ts
import { engineIncrement } from 'stellar-drive';

// Increment a counter by 1:
await engineIncrement('tasks', 'task-123', 'focus_count', 1);

// Decrement with an additional field update:
await engineIncrement('tasks', 'task-123', 'remaining', -1, {
  last_worked_at: new Date().toISOString()
});
```

---

### Query — Single Entity

#### `engineGet(table, id, opts?)`

Retrieves a single entity by its primary key from the local Dexie store. If the entity is not found locally and `remoteFallback` is enabled (and the device is online), a single-row fetch is made from Supabase. The remote result is cached locally in Dexie for subsequent offline access.

The remote fallback filters out soft-deleted rows to avoid resurrecting deleted entities.

**Signature:**
```ts
function engineGet(
  table: string,
  id: string,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown> | null>
```

**Returns:** The entity object, or `null` if not found.

**Example:**
```ts
import { engineGet } from 'stellar-drive';

const task = await engineGet('tasks', 'task-123');

// With remote fallback for cache misses:
const task = await engineGet('tasks', 'task-123', { remoteFallback: true });
```

---

#### `engineGetOrCreate(table, index, value, defaults, opts?)`

Retrieves an existing entity by an indexed field, or creates one with defaults if none exists. Implements the singleton/get-or-create pattern commonly used for per-user settings records where exactly one row per user should exist.

**Resolution order:**
1. **Local lookup** — query Dexie by the given index. If a non-deleted match is found, return it.
2. **Remote check** (optional) — if `checkRemote` is true and online, query Supabase. If found, cache locally and return.
3. **Local create** — if neither has a match, create with the provided defaults, queue for sync, and return.

**Signature:**
```ts
function engineGetOrCreate(
  table: string,
  index: string,
  value: unknown,
  defaults: Record<string, unknown>,
  opts?: { checkRemote?: boolean }
): Promise<Record<string, unknown>>
```

**Example:**
```ts
import { engineGetOrCreate } from 'stellar-drive';

const settings = await engineGetOrCreate(
  'user_settings',
  'user_id',
  currentUserId,
  { theme: 'dark', notifications: true, focus_duration: 25 },
  { checkRemote: true }
);
```

---

### Query — Multiple Entities

#### `engineGetAll(table, opts?)`

Retrieves all entities from a table, with optional ordering and remote fallback. Returns the **full unfiltered** contents of the local Dexie table (including soft-deleted records). If the local table is empty and `remoteFallback` is enabled, a bulk fetch from Supabase is performed using paginated fetching (1000 rows per page) to avoid hitting Supabase's default row limit.

> **Note:** This does NOT filter out soft-deleted entities. Use `queryAll()` for filtered, sorted results.

**Signature:**
```ts
function engineGetAll(
  table: string,
  opts?: { orderBy?: string; remoteFallback?: boolean }
): Promise<Record<string, unknown>[]>
```

**Example:**
```ts
import { engineGetAll } from 'stellar-drive';

const allTasks = await engineGetAll('tasks');
const sortedTasks = await engineGetAll('tasks', { orderBy: 'order' });
```

---

#### `engineQuery(table, index, value, opts?)`

Queries entities by a single indexed field value (equivalent to `WHERE index = value`). Uses Dexie's indexed `where().equals()` for efficient local lookups. If no results are found locally and `remoteFallback` is enabled, a filtered query is made against Supabase and results are cached locally.

**Signature:**
```ts
function engineQuery(
  table: string,
  index: string,
  value: unknown,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown>[]>
```

**Example:**
```ts
import { engineQuery } from 'stellar-drive';

const projectTasks = await engineQuery('tasks', 'project_id', 'proj-123');
```

---

#### `engineQueryRange(table, index, lower, upper, opts?)`

Queries entities where an indexed field falls within an inclusive range (equivalent to `WHERE index BETWEEN lower AND upper`). Useful for date-range queries or numeric range filters.

**Signature:**
```ts
function engineQueryRange(
  table: string,
  index: string,
  lower: unknown,
  upper: unknown,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown>[]>
```

**Example:**
```ts
import { engineQueryRange } from 'stellar-drive';

// All tasks due this week:
const weekTasks = await engineQueryRange(
  'tasks', 'due_date',
  '2025-01-13T00:00:00Z',
  '2025-01-19T23:59:59Z'
);
```

---

### Query Helpers

Convenience wrappers that apply the two most common post-processing steps: filtering out soft-deleted records and sorting by the `order` field. These eliminate the repetitive `.filter(i => !i.deleted).sort(...)` pattern.

#### `queryAll(table, opts?)`

Fetches all non-deleted records from a table, sorted by the `order` field. A convenience wrapper around `engineGetAll` with built-in filtering and sorting.

**Signature:**
```ts
function queryAll<T extends Record<string, unknown>>(
  table: string,
  opts?: { remoteFallback?: boolean; orderBy?: string; autoRemoteFallback?: boolean }
): Promise<T[]>
```

**Example:**
```ts
import { queryAll } from 'stellar-drive';

const tasks = await queryAll<Task>('tasks');
// Returns only non-deleted tasks, sorted by `order` ascending
```

---

#### `queryOne(table, id, opts?)`

Fetches a single non-deleted record by ID, or `null`. Returns `null` if the record exists but is soft-deleted, preventing callers from accidentally displaying tombstoned entities.

**Signature:**
```ts
function queryOne<T extends Record<string, unknown>>(
  table: string,
  id: string,
  opts?: { remoteFallback?: boolean; autoRemoteFallback?: boolean }
): Promise<T | null>
```

**Example:**
```ts
import { queryOne } from 'stellar-drive';

const task = await queryOne<Task>('tasks', 'task-123');
if (task) {
  console.log(task.title);
}
```

---

#### `queryByIndex(table, index, value, opts?)`

Queries non-deleted records by an indexed field value, with optional ordering. A convenience wrapper around `engineQuery` that filters out soft-deleted records.

**Signature:**
```ts
function queryByIndex<T extends Record<string, unknown>>(
  table: string,
  index: string,
  value: unknown,
  opts?: { remoteFallback?: boolean; autoRemoteFallback?: boolean; sortByOrder?: boolean }
): Promise<T[]>
```

**Example:**
```ts
import { queryByIndex } from 'stellar-drive';

const projectTasks = await queryByIndex<Task>('tasks', 'project_id', 'proj-123', {
  sortByOrder: true
});
```

---

#### `queryByRange(table, index, lower, upper, opts?)`

Queries non-deleted records within an inclusive range, with optional ordering. A convenience wrapper around `engineQueryRange`.

**Signature:**
```ts
function queryByRange<T extends Record<string, unknown>>(
  table: string,
  index: string,
  lower: unknown,
  upper: unknown,
  opts?: { remoteFallback?: boolean; autoRemoteFallback?: boolean; sortByOrder?: boolean }
): Promise<T[]>
```

**Example:**
```ts
import { queryByRange } from 'stellar-drive';

const recentTasks = await queryByRange<Task>(
  'tasks', 'created_at',
  '2025-01-01T00:00:00Z',
  '2025-01-31T23:59:59Z',
  { sortByOrder: true }
);
```

---

### Reorder Helpers

#### `reorderEntity(table, id, newOrder)`

Updates just the `order` field on any entity. A thin wrapper around `engineUpdate` for the common drag-and-drop reorder operation. Use with `calculateNewOrder()` to compute the new fractional order value.

**Signature:**
```ts
function reorderEntity<T extends Record<string, unknown>>(
  table: string,
  id: string,
  newOrder: number
): Promise<T | undefined>
```

**Example:**
```ts
import { reorderEntity, calculateNewOrder } from 'stellar-drive';

// User drags task from index 2 to index 0:
const newOrder = calculateNewOrder(tasks, 2, 0);
await reorderEntity('tasks', 'task-123', newOrder);
```

---

#### `prependOrder(table, indexField, indexValue)`

Computes the next prepend-order value for inserting at the top of a list. Queries all non-deleted records matching the given index/value pair, finds the minimum `order` value, and returns `min - 1`. If no records exist, returns `0`.

**Signature:**
```ts
function prependOrder(
  table: string,
  indexField: string,
  indexValue: string
): Promise<number>
```

**Example:**
```ts
import { prependOrder, engineCreate } from 'stellar-drive';

const order = await prependOrder('tasks', 'project_id', 'proj-123');
await engineCreate('tasks', {
  title: 'New top task',
  project_id: 'proj-123',
  order // Will be placed at the top of the list
});
```

---

## Authentication

Import from `stellar-drive/auth` for a focused bundle, or from `stellar-drive` for everything.

### Supabase Auth Core

#### `signOut(options?)`

Performs a complete 10-step sign-out teardown sequence:

1. Stops the sync engine (all listeners, timers, realtime subscriptions)
2. Clears the local IndexedDB data cache
3. Clears offline credentials
4. Clears offline session tokens
5. Calls `supabase.auth.signOut()`
6. Cleans up `sb-*` keys from localStorage
7. Resets the login guard counters
8. Resets all reactive stores to their default state
9. Optionally navigates to a redirect URL
10. Optionally reloads the page

**Signature:**
```ts
function signOut(options?: {
  redirectTo?: string;
  reload?: boolean;
}): Promise<void>
```

**Example:**
```ts
import { signOut } from 'stellar-drive/auth';

// Sign out and redirect to login:
await signOut({ redirectTo: '/login', reload: true });

// Sign out silently (no redirect):
await signOut();
```

---

#### `getValidSession()`

Returns the current Supabase session if it exists and is not expired. This is a convenience wrapper that combines `getSession()` and `isSessionExpired()` into a single call. Returns `null` if there is no session or the access token has expired.

**Signature:**
```ts
function getValidSession(): Session | null
```

**Example:**
```ts
import { getValidSession } from 'stellar-drive/auth';

const session = getValidSession();
if (session) {
  console.log('Authenticated as:', session.user.email);
} else {
  console.log('Not authenticated or session expired');
}
```

---

#### `getUserProfile()`

Extracts the current user profile from the active Supabase session. Returns the `user` object from `supabase.auth.getUser()`, or `null` if no session is active.

**Signature:**
```ts
function getUserProfile(): Promise<User | null>
```

**Example:**
```ts
import { getUserProfile } from 'stellar-drive/auth';

const user = await getUserProfile();
if (user) {
  console.log(user.email, user.user_metadata);
}
```

---

#### `updateProfile(profile)`

Updates the user's `user_metadata` on Supabase and also updates the locally cached offline credentials so the new profile data is available when offline.

**Signature:**
```ts
function updateProfile(
  profile: Record<string, unknown>
): Promise<{ error: string | null }>
```

**Example:**
```ts
import { updateProfile } from 'stellar-drive/auth';

await updateProfile({ firstName: 'Alice', theme: 'dark' });
```

---

#### `resendConfirmationEmail(email)`

Resends the signup confirmation email for an unconfirmed user. Calls `supabase.auth.resend()` with the `signup` type.

**Signature:**
```ts
function resendConfirmationEmail(email: string): Promise<{ error: string | null }>
```

**Example:**
```ts
import { resendConfirmationEmail } from 'stellar-drive/auth';

const result = await resendConfirmationEmail('user@example.com');
if (result.error) {
  console.error('Failed to resend:', result.error);
}
```

---

#### `verifyOtp(email, token, type)`

Verifies an OTP token hash from an email link. Used by the confirmation page to exchange the token for a valid session.

**Signature:**
```ts
function verifyOtp(
  email: string,
  token: string,
  type: 'signup' | 'email' | 'magiclink'
): Promise<{ error: string | null; session: Session | null }>
```

**Example:**
```ts
import { verifyOtp } from 'stellar-drive/auth';

const result = await verifyOtp('user@example.com', tokenHash, 'signup');
if (result.session) {
  console.log('Email verified, session established');
}
```

---

### Auth State Resolution

#### `resolveAuthState()`

Determines the current authentication state during app initialization. This is the master auth resolver that checks multiple sources (Supabase session, offline credentials, cached session, demo mode) and returns a single `AuthStateResult` describing which auth path the app should take.

Handles corrupted state cleanup by purging `sb-*` localStorage keys if session retrieval throws. Requires `auth.singleUser` to be configured in `initEngine()`.

**Signature:**
```ts
function resolveAuthState(): Promise<AuthStateResult>
```

**Returns:** `AuthStateResult`:

```ts
interface AuthStateResult {
  session: Session | null;
  authMode: 'supabase' | 'offline' | 'demo' | 'none';
  offlineProfile: OfflineCredentials | null;
  serverConfigured?: boolean;
}
```

| Field | Description |
|---|---|
| `session` | The Supabase session if one is active, or `null`. |
| `authMode` | `'supabase'` (active session), `'offline'` (cached credentials), `'demo'` (sandboxed), `'none'` (must log in). |
| `offlineProfile` | Offline credential data, populated only when `authMode === 'offline'`. |
| `serverConfigured` | Whether the server has been configured. Used to distinguish "first-time setup" from "locked". |

**Example:**
```ts
import { resolveAuthState } from 'stellar-drive/auth';

const { authMode, session, offlineProfile } = await resolveAuthState();

switch (authMode) {
  case 'supabase':
    console.log('Online session:', session.user.email);
    break;
  case 'offline':
    console.log('Offline mode:', offlineProfile.email);
    break;
  case 'demo':
    console.log('Demo mode active');
    break;
  case 'none':
    console.log('User must authenticate');
    break;
}
```

---

### Login Guard

#### `resetLoginGuard()`

Clears all login guard state: local failure counters, rate-limit attempts, and the next-allowed-attempt timestamp. Call this on sign-out or app reset to ensure the next login attempt starts with a clean slate.

The login guard prevents brute-force attacks by rate-limiting failed login attempts with exponential backoff. It also performs a local pre-check against the cached gate hash before calling Supabase, reducing unnecessary API requests.

**Signature:**
```ts
function resetLoginGuard(): void
```

**Example:**
```ts
import { resetLoginGuard } from 'stellar-drive';

resetLoginGuard();
```

---

### Single-User Auth (PIN/Password Gate)

The single-user auth system provides a PIN or password gate for personal/kiosk-style apps. It wraps Supabase email/password auth with a local gate (PIN, password, or code), offline credential caching, device linking across multiple devices, and OTP-based device verification.

#### `isSingleUserSetUp()`

Checks if single-user mode has been set up on this device (config exists in IndexedDB). Used to decide whether to show the setup screen or the unlock screen.

**Signature:**
```ts
function isSingleUserSetUp(): Promise<boolean>
```

**Example:**
```ts
import { isSingleUserSetUp } from 'stellar-drive/auth';

if (await isSingleUserSetUp()) {
  // Show unlock screen
} else {
  // Show setup wizard
}
```

---

#### `getSingleUserInfo()`

Returns non-sensitive display info about the single user: profile data, gate type, code length, and a masked email. Does NOT return the gate hash or any secrets.

**Signature:**
```ts
function getSingleUserInfo(): Promise<{
  profile: Record<string, unknown>;
  gateType: SingleUserGateType;
  codeLength?: number;
  email?: string;
  maskedEmail?: string;
} | null>
```

**Returns:** Display-safe user info, or `null` if not set up.

**Example:**
```ts
import { getSingleUserInfo } from 'stellar-drive/auth';

const info = await getSingleUserInfo();
if (info) {
  console.log(`Welcome back, ${info.profile.firstName}`);
  console.log(`Gate type: ${info.gateType}, Email: ${info.maskedEmail}`);
}
```

---

#### `setupSingleUser(gate, profile, email)`

First-time setup: creates a Supabase user account with email/password auth, stores a local config in IndexedDB, and optionally requires email confirmation. This is the entry point for new users.

**Signature:**
```ts
function setupSingleUser(
  gate: string,
  profile: Record<string, unknown>,
  email: string
): Promise<{ error: string | null; confirmationRequired: boolean }>
```

**Example:**
```ts
import { setupSingleUser } from 'stellar-drive/auth';

const result = await setupSingleUser(
  '1234',
  { firstName: 'Alice' },
  'alice@example.com'
);

if (result.error) {
  showError(result.error);
} else if (result.confirmationRequired) {
  showMessage('Check your email to confirm your account');
}
```

---

#### `completeSingleUserSetup()`

Completes setup after the user clicks the email confirmation link. This is the second half of the two-step setup flow — called after `setupSingleUser()` when email confirmation is enabled. It verifies the Supabase session was established by the email confirmation, updates the local IndexedDB config with the real user ID (replacing any temporary ID from offline setup), caches offline credentials for future offline logins, creates an offline session token, and marks the current device as trusted.

**Signature:**
```ts
function completeSingleUserSetup(): Promise<{ error: string | null }>
```

**Returns:** Object with `error` (string message if something went wrong, or `null` on success).

**Example:**
```ts
import { completeSingleUserSetup } from 'stellar-drive/auth';

// Called after the user clicks the email confirmation link:
const result = await completeSingleUserSetup();
if (result.error) {
  showError(result.error);
} else {
  navigateTo('/dashboard');
}
```

---

#### `unlockSingleUser(gate)`

Unlocks (logs into) the single-user account by verifying the PIN/password.

**Online flow:** client-side rate limiting pre-check, authenticate with Supabase `signInWithPassword()`, optionally trigger OTP if the device is untrusted.

**Offline flow:** verify against locally-stored SHA-256 hash, restore cached Supabase session or create a synthetic offline session.

**Signature:**
```ts
function unlockSingleUser(gate: string): Promise<{
  error: string | null;
  deviceVerificationRequired?: boolean;
  maskedEmail?: string;
  retryAfterMs?: number;
}>
```

**Returns:**

| Field | Description |
|---|---|
| `error` | Error message, or `null` on success. |
| `deviceVerificationRequired` | `true` if the device needs OTP verification before proceeding. |
| `maskedEmail` | Masked email shown during device verification (e.g., `'al••••@example.com'`). |
| `retryAfterMs` | Milliseconds until the next login attempt is allowed (rate limiting). |

**Example:**
```ts
import { unlockSingleUser } from 'stellar-drive/auth';

const result = await unlockSingleUser('1234');

if (result.error) {
  if (result.retryAfterMs) {
    showError(`Too many attempts. Try again in ${Math.ceil(result.retryAfterMs / 1000)}s`);
  } else {
    showError(result.error);
  }
} else if (result.deviceVerificationRequired) {
  showDeviceVerification(result.maskedEmail);
} else {
  navigateTo('/dashboard');
}
```

---

#### `lockSingleUser()`

Locks the application by stopping the sync engine and resetting auth state to `'none'`. This is a "soft lock" — it does NOT destroy the Supabase session, clear local data, or sign out. The user's data remains intact in IndexedDB, and they can unlock again with their PIN without needing network access (if offline credentials are cached).

Use this for "lock screen" functionality where the app should be inaccessible but preserve all state for quick re-entry.

**Signature:**
```ts
function lockSingleUser(): Promise<void>
```

**Example:**
```ts
import { lockSingleUser } from 'stellar-drive/auth';

// User taps "Lock" button:
await lockSingleUser();
navigateTo('/login');
```

---

#### `changeSingleUserGate(oldGate, newGate)`

Changes the gate (PIN or password) for the single-user account. Verifies the old gate before accepting the new one to prevent unauthorized changes. When online, the password is also updated in Supabase via `updateUser()`. When offline, only the local SHA-256 hash is updated; the Supabase password will be synced on the next online login.

**Signature:**
```ts
function changeSingleUserGate(
  oldGate: string,
  newGate: string
): Promise<{ error: string | null }>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `oldGate` | `string` | The current PIN/password for verification. |
| `newGate` | `string` | The new PIN/password to set. |

**Returns:** Object with `error` (string message if verification failed or update failed, or `null` on success).

**Example:**
```ts
import { changeSingleUserGate } from 'stellar-drive/auth';

const result = await changeSingleUserGate('1234', '5678');
if (result.error) {
  showError(result.error); // e.g., 'Current PIN is incorrect'
} else {
  showSuccess('PIN changed successfully');
}
```

---

#### `updateSingleUserProfile(profile)`

Updates the user's profile data in both the local IndexedDB config and Supabase `user_metadata`. Also updates the offline credentials cache so the new profile is available when offline. This is the single-user equivalent of `updateProfile()` but also handles the local config store.

**Signature:**
```ts
function updateSingleUserProfile(
  profile: Record<string, unknown>
): Promise<{ error: string | null }>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `profile` | `Record<string, unknown>` | Arbitrary profile data to store (e.g., `{ firstName: 'Alice', theme: 'dark' }`). |

**Returns:** Object with `error` (string or `null` on success).

**Example:**
```ts
import { updateSingleUserProfile } from 'stellar-drive/auth';

const result = await updateSingleUserProfile({
  firstName: 'Alice',
  avatarUrl: 'https://example.com/avatar.png'
});
if (result.error) {
  showError(result.error);
}
```

---

#### `changeSingleUserEmail(newEmail)`

Initiates an email change for the single-user account. Requires an active internet connection. Supabase sends a confirmation email to the new address; the change is not applied until the user clicks the confirmation link. The old email continues to work until confirmation is complete.

**Signature:**
```ts
function changeSingleUserEmail(
  newEmail: string
): Promise<{ error: string | null; confirmationRequired: boolean }>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `newEmail` | `string` | The new email address to change to. |

**Returns:** Object with `error` (string or `null`) and `confirmationRequired` (boolean indicating whether the user needs to check their email).

**Example:**
```ts
import { changeSingleUserEmail } from 'stellar-drive/auth';

const result = await changeSingleUserEmail('newemail@example.com');
if (result.error) {
  showError(result.error);
} else if (result.confirmationRequired) {
  showMessage('Check your new email to confirm the change');
}
```

---

#### `completeSingleUserEmailChange()`

Completes an email change after the user confirms via the email link. Refreshes the Supabase session to pick up the new email, then updates the local IndexedDB config and offline credentials cache with the confirmed new email address.

**Signature:**
```ts
function completeSingleUserEmailChange(): Promise<{
  error: string | null;
  newEmail: string | null;
}>
```

**Returns:** Object with `error` (string or `null`) and `newEmail` (the confirmed new email address, or `null` if there was an error).

**Example:**
```ts
import { completeSingleUserEmailChange } from 'stellar-drive/auth';

const result = await completeSingleUserEmailChange();
if (result.error) {
  showError(result.error);
} else {
  showSuccess(`Email changed to ${result.newEmail}`);
}
```

---

#### `resetSingleUser()`

Performs a full local reset: clears the single-user config from IndexedDB, signs out of Supabase, and wipes all local cached data. After this call, the app returns to the initial setup state where the user can go through the setup wizard again.

This does NOT delete the Supabase user account or any server-side data. Use `resetSingleUserRemote()` for a complete server-side wipe.

**Signature:**
```ts
function resetSingleUser(): Promise<{ error: string | null }>
```

**Returns:** Object with `error` (string or `null` on success).

**Example:**
```ts
import { resetSingleUser } from 'stellar-drive/auth';

// User confirms "Reset App" in settings:
const result = await resetSingleUser();
if (!result.error) {
  window.location.href = '/setup'; // Redirect to setup wizard
}
```

---

#### `resetSingleUserRemote()`

Performs a full server-side reset: calls the Supabase RPC function `reset_single_user` to delete the user account and all associated data from the database, then signs out and clears all local IndexedDB state and Supabase session tokens from localStorage. This is a destructive, irreversible operation.

**Signature:**
```ts
function resetSingleUserRemote(): Promise<{ error: string | null }>
```

**Returns:** Object with `error` (string or `null` on success).

**Example:**
```ts
import { resetSingleUserRemote } from 'stellar-drive/auth';

// User confirms "Delete Account" with a confirmation dialog:
const result = await resetSingleUserRemote();
if (!result.error) {
  window.location.href = '/'; // App is now in fresh state
}
```

---

#### `fetchRemoteGateConfig()`

Fetches the account configuration from Supabase for multi-device linking. Calls the RPC function `get_extension_config` to retrieve the user's email, gate type, code length, and profile from Supabase `user_metadata`. Used when setting up a new device that needs to know the existing account's gate configuration.

**Signature:**
```ts
function fetchRemoteGateConfig(): Promise<{
  email: string;
  gateType: string;
  codeLength: number;
  profile: Record<string, unknown>;
} | null>
```

**Returns:** Object with the remote account config, or `null` if the RPC call fails or no config exists.

**Example:**
```ts
import { fetchRemoteGateConfig } from 'stellar-drive/auth';

const config = await fetchRemoteGateConfig();
if (config) {
  console.log(`Account email: ${config.email}`);
  console.log(`Gate type: ${config.gateType}, Code length: ${config.codeLength}`);
}
```

---

#### `linkSingleUserDevice(email, pin)`

Links a new device to an existing single-user account. Signs in with the provided email and PIN via Supabase `signInWithPassword()`, then builds and stores a local single-user config from the account's `user_metadata`. If device verification is enabled, untrusted devices are challenged with an OTP email before being granted full access.

This is the counterpart to `setupSingleUser()` — used when a user already has an account and wants to access it from an additional device.

**Signature:**
```ts
function linkSingleUserDevice(
  email: string,
  pin: string
): Promise<{
  error: string | null;
  deviceVerificationRequired?: boolean;
  maskedEmail?: string;
  retryAfterMs?: number;
}>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `email` | `string` | The email address of the existing account. |
| `pin` | `string` | The PIN/password to authenticate with. |

**Returns:** Same shape as `unlockSingleUser()` — includes `error`, `deviceVerificationRequired`, `maskedEmail`, and `retryAfterMs`.

**Example:**
```ts
import { linkSingleUserDevice } from 'stellar-drive/auth';

const result = await linkSingleUserDevice('alice@example.com', '1234');
if (result.error) {
  showError(result.error);
} else if (result.deviceVerificationRequired) {
  showDeviceVerification(result.maskedEmail);
} else {
  navigateTo('/dashboard');
}
```

---

#### `completeDeviceVerification(tokenHash?)`

Completes device verification after OTP confirmation. If a `tokenHash` is provided (from the email confirmation URL), it verifies the token with Supabase first. Then trusts the current device, caches offline credentials for future offline logins, creates an offline session token, and updates the auth state store to reflect successful authentication.

**Signature:**
```ts
function completeDeviceVerification(
  tokenHash?: string
): Promise<{ error: string | null }>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `tokenHash` | `string` | Optional token hash from the confirmation email's URL query parameters. If omitted, assumes the device has already been verified externally. |

**Returns:** Object with `error` (string or `null` on success).

**Example:**
```ts
import { completeDeviceVerification } from 'stellar-drive/auth';

// On the confirmation page, extract token from URL:
const tokenHash = new URL(window.location.href).searchParams.get('token_hash');
const result = await completeDeviceVerification(tokenHash || undefined);
if (result.error) {
  showError(result.error);
} else {
  navigateTo('/dashboard');
}
```

---

#### `pollDeviceVerification()`

Polls whether the current device has been trusted after OTP verification. Used by the UI to detect when device verification was completed on another device — for example, if the user entered their PIN on their laptop but opened the OTP confirmation link on their phone. The phone's confirmation page trusts the laptop's device, and this poll detects that trust.

**Signature:**
```ts
function pollDeviceVerification(): Promise<boolean>
```

**Returns:** `true` if the current device is now trusted, `false` otherwise.

**Example:**
```ts
import { pollDeviceVerification } from 'stellar-drive/auth';

// Poll every 3 seconds while showing "Waiting for verification..." UI:
const interval = setInterval(async () => {
  const trusted = await pollDeviceVerification();
  if (trusted) {
    clearInterval(interval);
    navigateTo('/dashboard');
  }
}, 3000);
```

---

#### `padPin(pin)`

Pads a PIN to meet Supabase's minimum 6-character password length by appending a fixed deterministic suffix (`_app`). Since PINs can be as short as 4 digits, this padding ensures they always satisfy Supabase's password requirements. The suffix is app-independent so that multiple apps sharing a Supabase project produce the same password for the same PIN — users can authenticate across apps without re-registering.

**Signature:**
```ts
function padPin(pin: string): string
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `pin` | `string` | The raw PIN/password entered by the user. |

**Returns:** The padded string suitable for use as a Supabase password.

**Example:**
```ts
import { padPin } from 'stellar-drive/auth';

padPin('1234');   // → '1234_app'
padPin('secret'); // → 'secret_app'
```

---

### Device Verification

Multi-device trust management for single-user setups. Devices are trusted via OTP email verification and tracked in the `trusted_devices` Supabase table.

#### `isDeviceTrusted(userId)`

Checks if the current device is trusted for a given user. Queries the `trusted_devices` Supabase table for a record matching the current device ID and user ID, with `last_used_at` within the configured trust duration window (default: 90 days). **Fails closed** — any error (network, RLS, database) returns `false` to ensure untrusted devices are always challenged.

**Signature:**
```ts
function isDeviceTrusted(userId: string): Promise<boolean>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `userId` | `string` | The Supabase user ID to check trust for. |

**Returns:** `true` if the device is trusted and not expired, `false` otherwise.

**Example:**
```ts
import { isDeviceTrusted } from 'stellar-drive';

const trusted = await isDeviceTrusted('user-uuid-123');
if (!trusted) {
  // Trigger device verification OTP flow
  await sendDeviceVerification(userEmail);
}
```

---

#### `trustCurrentDevice(userId)`

Trusts the current device for a user by creating or updating a record in the `trusted_devices` Supabase table. Uses upsert on the `(user_id, device_id)` unique constraint, so calling this multiple times is safe. Both `trusted_at` and `last_used_at` are set to the current time, and the device label is updated from the current User-Agent.

**Signature:**
```ts
function trustCurrentDevice(userId: string): Promise<void>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `userId` | `string` | The Supabase user ID to associate the trust record with. |

**Example:**
```ts
import { trustCurrentDevice } from 'stellar-drive';

// After successful OTP verification:
await trustCurrentDevice('user-uuid-123');
```

---

#### `trustPendingDevice()`

Trusts the pending device stored in Supabase `user_metadata`. Called from the email confirmation page after a device OTP is verified. This trusts the **originating device** (the one that entered the PIN and triggered the verification email), not necessarily the device that opened the confirmation link. This distinction matters because users often open confirmation emails on a different device (e.g., PIN entered on laptop, email opened on phone).

Falls back to trusting the current device if no pending device ID is found in `user_metadata`.

**Signature:**
```ts
function trustPendingDevice(): Promise<void>
```

**Example:**
```ts
import { trustPendingDevice } from 'stellar-drive';

// On the /confirm page after OTP verification succeeds:
await trustPendingDevice();
```

---

#### `getTrustedDevices(userId)`

Returns all trusted devices for a user, ordered by most recently used first. Used by device management UIs to display a list of trusted devices with the option to revoke trust.

**Signature:**
```ts
function getTrustedDevices(userId: string): Promise<TrustedDevice[]>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `userId` | `string` | The Supabase user ID to fetch devices for. |

**Returns:** Array of `TrustedDevice` objects, or an empty array on error:

```ts
interface TrustedDevice {
  id: string;
  user_id: string;
  device_id: string;
  device_label: string;
  trusted_at: string;
  last_used_at: string;
}
```

**Example:**
```ts
import { getTrustedDevices, getCurrentDeviceId } from 'stellar-drive';

const devices = await getTrustedDevices('user-uuid-123');
const currentDeviceId = getCurrentDeviceId();

devices.forEach(device => {
  const isCurrent = device.device_id === currentDeviceId;
  console.log(`${device.device_label} ${isCurrent ? '(this device)' : ''}`);
  console.log(`  Trusted: ${device.trusted_at}, Last used: ${device.last_used_at}`);
});
```

---

#### `removeTrustedDevice(id)`

Removes a trusted device by its primary key ID. After removal, the device will be challenged with OTP verification on its next login attempt. Used by device management UIs to allow users to revoke trust on devices they no longer control (e.g., lost phone, sold laptop).

**Signature:**
```ts
function removeTrustedDevice(id: string): Promise<void>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `id` | `string` | The UUID primary key of the `trusted_devices` row to delete. |

**Example:**
```ts
import { removeTrustedDevice } from 'stellar-drive';

// User clicks "Remove" next to a device in the management UI:
await removeTrustedDevice('device-row-uuid-456');
```

---

#### `sendDeviceVerification(email)`

Sends a device verification OTP email to the user. Performs two actions: (1) stores the pending device info (device ID and label) in Supabase `user_metadata` so the confirmation page can trust the originating device even if the link is opened on a different device, and (2) sends an OTP email via `signInWithOtp()` with `shouldCreateUser: false` to prevent account creation abuse.

**Signature:**
```ts
function sendDeviceVerification(email: string): Promise<{ error: string | null }>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `email` | `string` | The user's email address to send the OTP to. |

**Returns:** Object with `error` (string or `null` on success).

**Example:**
```ts
import { sendDeviceVerification } from 'stellar-drive';

const result = await sendDeviceVerification('alice@example.com');
if (result.error) {
  showError(result.error);
} else {
  showMessage('Verification email sent — check your inbox');
}
```

---

#### `maskEmail(email)`

Partially masks an email address for safe display in the UI. Shows the first 2 characters of the local part, replaces the rest with bullet characters (`•`), and preserves the full domain. This prevents shoulder-surfing while still letting the user confirm it's the right email.

**Signature:**
```ts
function maskEmail(email: string): string
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `email` | `string` | The full email address to mask. |

**Returns:** The masked email string.

**Example:**
```ts
import { maskEmail } from 'stellar-drive';

maskEmail('prabhask@gmail.com'); // → 'pr••••••@gmail.com'
maskEmail('ab@test.com');        // → 'ab@test.com' (nothing to mask)
```

---

#### `getCurrentDeviceId()`

Returns the current device's persistent unique identifier from localStorage. This ID is generated once (UUID v4) and persisted across page reloads. It is used throughout stellar-drive for echo suppression (filtering out realtime events from the same device), conflict tiebreaking (deterministic ordering when timestamps match), and device trust management.

**Signature:**
```ts
function getCurrentDeviceId(): string
```

**Returns:** The persistent device ID string.

**Example:**
```ts
import { getCurrentDeviceId } from 'stellar-drive';

const deviceId = getCurrentDeviceId();
console.log('This device:', deviceId); // → 'a1b2c3d4-e5f6-...'
```

---

#### `getDeviceLabel()`

Generates a human-readable device label from the browser's User-Agent string. Detects common browsers (Chrome, Firefox, Edge, Safari) and operating systems (macOS, Windows, Linux, iOS, Android, ChromeOS), returning a combined label like `'Chrome on macOS'`. Used in device management UIs to help users identify their devices.

**Signature:**
```ts
function getDeviceLabel(): string
```

**Returns:** A human-readable label describing the current browser and OS, or `'Unknown device'` in non-browser environments.

**Example:**
```ts
import { getDeviceLabel } from 'stellar-drive';

const label = getDeviceLabel();
console.log(label); // → 'Chrome on macOS' or 'Safari on iOS' etc.
```

---

### Display Utilities

Pure helper functions that resolve user-facing display values from the auth state. Each handles the full fallback chain across online (Supabase session) and offline (cached credential) modes.

#### `resolveFirstName(session?, offlineProfile?, fallback?)`

Resolves the user's first name for greeting/display purposes.

**Fallback chain:**
1. `firstName` / `first_name` from the Supabase session profile
2. Email username (before `@`) from the Supabase session
3. `firstName` from the offline cached profile
4. Email username from the offline cached profile
5. The provided `fallback` string (default: `'Explorer'`)

**Signature:**
```ts
function resolveFirstName(
  session: Session | null,
  offlineProfile: OfflineCredentials | null,
  fallback?: string
): string
```

**Example:**
```ts
import { resolveFirstName } from 'stellar-drive/auth';

const name = resolveFirstName(session, null);
// → 'Alice' (from session metadata) or 'alice' (from email) or 'Explorer'
```

---

#### `resolveUserId(session?, offlineProfile?)`

Resolves the current user's UUID from the available auth state. Checks the Supabase session first (`session.user.id`), then falls back to the offline credential cache (`offlineProfile.userId`). Returns an empty string when no user is authenticated in either mode.

**Signature:**
```ts
function resolveUserId(
  session: Session | null,
  offlineProfile: OfflineCredentials | null
): string
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `session` | `Session \| null` | The current Supabase session, or `null`. |
| `offlineProfile` | `OfflineCredentials \| null` | The cached offline credentials, or `null`. |

**Returns:** The user's UUID string, or `''` if unauthenticated.

**Example:**
```ts
import { resolveUserId } from 'stellar-drive/auth';

const userId = resolveUserId(session, offlineProfile);
if (userId) {
  console.log('Current user:', userId);
}
```

---

#### `resolveAvatarInitial(session?, offlineProfile?, fallback?)`

Resolves a single uppercase initial letter for avatar display. Uses `resolveFirstName()` internally, then returns the first character uppercased.

**Signature:**
```ts
function resolveAvatarInitial(
  session: Session | null,
  offlineProfile: OfflineCredentials | null,
  fallback?: string
): string
```

**Example:**
```ts
import { resolveAvatarInitial } from 'stellar-drive/auth';

const initial = resolveAvatarInitial(session, null); // → 'A'
```

---

## Reactive Stores

Import from `stellar-drive/stores`. All stores follow the Svelte store contract (`subscribe`/`unsubscribe`) and can be used with the `$store` auto-subscription syntax in `.svelte` files.

### Sync Status Store

#### `syncStatusStore`

Exposes the current state of the sync engine: whether it is idle, syncing, or in error; the number of pending local changes; recent errors; the realtime connection state; and the timestamp of the last successful sync.

Implements anti-flicker logic: the `'syncing'` status is displayed for a minimum of 500ms to prevent jarring flashes during fast syncs.

**Type:**
```ts
const syncStatusStore: Readable<{
  status: SyncStatus;
  pendingCount: number;
  lastError: string | null;
  errors: SyncError[];
  lastSyncTime: string | null;
  syncMessage: string | null;
  tabVisible: boolean;
  realtimeState: RealtimeState;
}>
```

**Related Types:**
```ts
type SyncStatus = 'idle' | 'syncing' | 'error';
type RealtimeState = 'disconnected' | 'connecting' | 'connected' | 'error';

interface SyncError {
  table: string;
  operation: string;
  entityId: string;
  message: string;
  timestamp: string;
}
```

**Example:**
```svelte
<script>
  import { syncStatusStore } from 'stellar-drive/stores';
</script>

{#if $syncStatusStore.status === 'syncing'}
  <Spinner />
{:else if $syncStatusStore.pendingCount > 0}
  <span>{$syncStatusStore.pendingCount} changes pending</span>
{/if}
```

---

### Remote Changes Store

#### `remoteChangesStore`

Tracks incoming remote changes from other devices via Supabase Realtime. Provides methods to check for recent changes (for animations), deferred changes (changes that arrived while the user was actively editing), and pending deletes (for exit animations).

**Type:**
```ts
type RemoteActionType =
  | 'create' | 'delete' | 'toggle'
  | 'increment' | 'decrement'
  | 'reorder' | 'rename' | 'update';
```

**Key methods on the store:**
- `recordRemoteChange(entityType, entityId, actionType, fields?)` — Record an incoming remote change
- `recordLocalChange(entityType, entityId, actionType)` — Record a local change (for animation)
- `startEditing(entityType, entityId, formType, fields?)` — Mark entity as being edited
- `stopEditing(entityType, entityId)` — Stop editing, return any deferred changes
- `markPendingDelete(entityType, entityId)` — Mark entity for delete animation
- `wasRecentlyChanged(entityType, entityId)` — Check if entity was recently changed
- `hasDeferredChanges(entityType, entityId)` — Check for deferred changes
- `isPendingDelete(entityType, entityId)` — Check if entity is pending delete
- `getRecentChange(entityType, entityId)` — Get the most recent change details

**Derived store factories:**
- `createRecentChangeIndicator(entityType, entityId)` — Returns a readable store that emits `true` when the entity has a recent remote change
- `createPendingDeleteIndicator(entityType, entityId)` — Returns a readable store that emits `true` when the entity has a pending remote delete

**Example:**
```svelte
<script>
  import { remoteChangesStore } from 'stellar-drive/stores';

  // Check for deferred changes when closing an edit form:
  function handleClose() {
    const deferred = remoteChangesStore.stopEditing('tasks', taskId);
    if (deferred.length > 0) {
      showDeferredChangesNotification(deferred);
    }
  }
</script>
```

---

### Network Store

#### `isOnline`

A boolean Svelte store that reflects the browser's online/offline status. Automatically updates via `navigator.onLine` and listens to `online`, `offline`, and `visibilitychange` events. Includes guards against duplicate reconnect callbacks on iOS PWAs.

**Type:**
```ts
const isOnline: Readable<boolean>
```

**Example:**
```svelte
<script>
  import { isOnline } from 'stellar-drive/stores';
</script>

{#if !$isOnline}
  <OfflineBanner />
{/if}
```

---

### Auth State Stores

#### `authState`

The primary authentication state store. Contains the current auth mode, session, offline profile, loading state, and any "kicked" message (e.g., when the session is invalidated server-side).

**Type:**
```ts
const authState: Readable<{
  mode: AuthMode;
  session: Session | null;
  offlineProfile: OfflineCredentials | null;
  isLoading: boolean;
  authKickedMessage: string | null;
}>
```

**Imperative setter methods:**
- `authState.setSupabaseAuth(session)` — Set auth mode to `'supabase'` with a valid session
- `authState.setOfflineAuth(profile)` — Set auth mode to `'offline'` with cached credentials
- `authState.setNoAuth()` — Set auth mode to `'none'`
- `authState.setDemoAuth()` — Set auth mode to `'demo'`
- `authState.setLoading()` — Set loading state
- `authState.clearKickedMessage()` — Clear the kicked message
- `authState.updateSession(session)` — Update the session without changing the mode
- `authState.updateUserProfile(metadata)` — Update user metadata in the session
- `authState.reset()` — Reset to default state

> **Important:** `authState` is an **object store**, not a string. Always access properties like `$authState.mode`, never compare `$authState === 'string'`.

---

#### `isAuthenticated`

Derived boolean Svelte store that resolves to `true` when the user is authenticated (any mode except `'none'`) and loading is complete. This is the simplest way to conditionally render authenticated vs unauthenticated UI.

**Type:**
```ts
const isAuthenticated: Readable<boolean>
```

**Example:**
```svelte
<script>
  import { isAuthenticated } from 'stellar-drive/stores';
</script>

{#if $isAuthenticated}
  <Dashboard />
{:else}
  <LoginScreen />
{/if}
```

---

#### `userDisplayInfo`

Derived Svelte store providing the user's display profile and email for UI rendering. Resolves from the active auth mode — pulls from the Supabase session's `user_metadata` in online mode, or from the cached offline credentials in offline mode. Returns `null` when not authenticated.

**Type:**
```ts
const userDisplayInfo: Readable<{
  profile: Record<string, unknown>;
  email: string;
} | null>
```

**Example:**
```svelte
<script>
  import { userDisplayInfo } from 'stellar-drive/stores';
</script>

{#if $userDisplayInfo}
  <p>Welcome, {$userDisplayInfo.profile.firstName}</p>
  <p>Email: {$userDisplayInfo.email}</p>
{/if}
```

---

### Lifecycle Event Hooks

#### `onSyncComplete(callback)`

Registers a callback that fires after every successful sync cycle completes. This is the primary mechanism for Svelte stores to refresh their data after the engine has pulled remote changes into the local database. Each callback is wrapped in try/catch so a failing store refresh doesn't prevent other registered callbacks from executing.

**Signature:**
```ts
function onSyncComplete(callback: () => void): () => void
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `callback` | `() => void` | Function to call after each successful sync cycle. |

**Returns:** An unsubscribe function that removes the callback.

**Example:**
```ts
import { onSyncComplete } from 'stellar-drive/stores';

const unsubscribe = onSyncComplete(() => {
  myStore.refresh();
});

// Later, during teardown:
unsubscribe();
```

#### `onRealtimeDataUpdate(callback)`

Registers a callback that fires when a realtime payload is received from Supabase and applied to the local database. Use this to react to cross-device changes in real time (e.g., updating a live counter, playing a notification sound).

**Signature:**
```ts
function onRealtimeDataUpdate(
  callback: (table: string, record: Record<string, unknown>) => void
): () => void
```

**Returns:** An unsubscribe function.

**Example:**
```ts
import { onRealtimeDataUpdate } from 'stellar-drive/stores';

const unsubscribe = onRealtimeDataUpdate((table, record) => {
  if (table === 'tasks' && record.completed) {
    playCompletionSound();
  }
});
```

---

### Store Factories

Generic factory functions that create Svelte-compatible reactive stores with built-in loading state and sync-complete auto-refresh. These eliminate the repetitive loading/sync/refresh boilerplate from every store definition.

#### `createCollectionStore(config)`

Creates a reactive store for a collection of entities with loading state and auto-refresh on sync completion.

**Signature:**
```ts
function createCollectionStore<T>(config: CollectionStoreConfig<T>): CollectionStore<T>
```

**Types:**
```ts
interface CollectionStoreConfig<T> {
  load: () => Promise<T[]>;
}

interface CollectionStore<T> {
  subscribe: (fn: (value: T[]) => void) => () => void;
  loading: Readable<boolean>;
  load(): Promise<void>;
  refresh(): Promise<void>;
  set(items: T[]): void;
  mutate(fn: (items: T[]) => T[]): void;
}
```

**Example:**
```ts
import { createCollectionStore, queryAll } from 'stellar-drive';

const tasksStore = createCollectionStore<Task>({
  load: () => queryAll<Task>('tasks')
});

// In a component:
await tasksStore.load();
// The store auto-refreshes after every sync cycle
```

---

#### `createDetailStore(config)`

Creates a reactive store for a single entity with loading state and ID tracking.

**Signature:**
```ts
function createDetailStore<T>(config: DetailStoreConfig<T>): DetailStore<T>
```

**Types:**
```ts
interface DetailStoreConfig<T> {
  load: (id: string) => Promise<T | null>;
}

interface DetailStore<T> {
  subscribe: (fn: (value: T | null) => void) => () => void;
  loading: Readable<boolean>;
  load(id: string): Promise<void>;
  clear(): void;
  set(item: T | null): void;
  mutate(fn: (item: T | null) => T | null): void;
}
```

**Example:**
```ts
import { createDetailStore, queryOne } from 'stellar-drive';

const taskDetailStore = createDetailStore<Task>({
  load: (id) => queryOne<Task>('tasks', id)
});

await taskDetailStore.load('task-123');
```

---

#### `createCrudCollectionStore(config)`

Creates a collection store with built-in create, update, delete, and reorder operations. Each mutation performs the engine operation and optimistically updates the store.

**Signature:**
```ts
function createCrudCollectionStore<T>(config: CrudCollectionStoreConfig<T>): CrudCollectionStore<T>
```

**Types:**
```ts
interface CrudCollectionStoreConfig<T> {
  table: string;
  load: () => Promise<T[]>;
}

interface CrudCollectionStore<T> extends CollectionStore<T> {
  create(data: Partial<T>): Promise<T>;
  update(id: string, fields: Partial<T>): Promise<void>;
  remove(id: string): Promise<void>;
  reorder(id: string, newOrder: number): Promise<void>;
}
```

**Example:**
```ts
import { createCrudCollectionStore, queryAll } from 'stellar-drive';

const projectsStore = createCrudCollectionStore<Project>({
  table: 'projects',
  load: () => queryAll<Project>('projects')
});

await projectsStore.load();
await projectsStore.create({ name: 'New Project', order: 0 });
await projectsStore.update('proj-123', { name: 'Renamed' });
await projectsStore.remove('proj-456');
```

---

### Hydration State

#### `hasHydrated()`

Returns `true` if the initial local-to-remote sync (hydration) has completed this session. Hydration is the first pull after the engine starts, which populates the local IndexedDB from Supabase. When `false`, the app should treat local data as potentially stale and may want to show a loading indicator or skeleton UI.

Returns `true` even if hydration fetched zero rows (the attempt itself is what matters).

**Signature:**
```ts
function hasHydrated(): boolean
```

**Returns:** `true` if hydration has completed successfully, `false` if still in progress or not yet started.

**Example:**
```svelte
<script>
  import { hasHydrated } from 'stellar-drive/stores';

  let hydrated = $state(hasHydrated());
</script>

{#if !hydrated}
  <LoadingSkeleton />
{:else}
  <TaskList />
{/if}
```

---

#### `hydrationAttempted()`

Returns `true` if the engine has attempted initial hydration this session, regardless of whether it succeeded or failed. This is useful for dismissing loading overlays even when hydration encounters a network error — the app can still show cached local data rather than an infinite spinner.

**Signature:**
```ts
function hydrationAttempted(): boolean
```

**Returns:** `true` if hydration was attempted (success or failure), `false` if not yet attempted.

**Example:**
```ts
import { hydrationAttempted } from 'stellar-drive/stores';

if (hydrationAttempted()) {
  // Safe to show UI, even if hydration failed
  showMainContent();
} else {
  showLoadingOverlay();
}
```

---

#### `wasDbReset()`

Returns `true` if the database was reset (nuked via `resetDatabase()`) during this session and needs a full re-hydration from Supabase. Used to detect when the app should show a "resyncing all data" state instead of the normal loading indicator.

**Signature:**
```ts
function wasDbReset(): boolean
```

**Returns:** `true` if the database was reset this session, `false` otherwise.

**Example:**
```ts
import { wasDbReset } from 'stellar-drive/stores';

if (wasDbReset()) {
  showMessage('Resyncing all data from server...');
}
```

---

## Runtime Configuration

Import from `stellar-drive/config`. Provides a runtime configuration system that persists across sessions via localStorage, with async initialization that fetches from the server's `/api/config` endpoint.

#### `initConfig(defaults?)`

Initializes the config store by fetching the application's runtime configuration from the server's `/api/config` endpoint and caching it in localStorage. This is the first step in the app initialization sequence — it loads the Supabase URL and publishable key that the engine needs to connect.

De-duplicates concurrent init calls (safe to call from multiple components). Falls back to the localStorage cache when the device is offline, enabling PWA support without network access. On subsequent loads when a cache exists, performs a background validation fetch to ensure the cached config is still valid.

**Signature:**
```ts
function initConfig(defaults?: Partial<AppConfig>): Promise<void>
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `defaults` | `Partial<AppConfig>` | Optional default values to use before the server responds. |

**Example:**
```ts
import { initConfig } from 'stellar-drive/config';

// On app boot (typically in root +layout.ts):
await initConfig();
```

---

#### `getConfig()`

Synchronous access to the current configuration snapshot. Must be called after `initConfig()` has resolved — throws if called before initialization. This is the primary way to read the Supabase URL and key throughout the application.

**Signature:**
```ts
function getConfig(): AppConfig
```

**Returns:** `AppConfig`:
```ts
interface AppConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  configured: boolean;
}
```

**Example:**
```ts
import { getConfig } from 'stellar-drive/config';

const config = getConfig();
console.log('Supabase URL:', config.supabaseUrl);
console.log('Configured:', config.configured);
```

---

#### `setConfig(updates)`

Merges partial updates into the active configuration and persists the result to localStorage. Used programmatically after setup wizards to store the validated Supabase credentials. The updated config is immediately available via `getConfig()`.

**Signature:**
```ts
function setConfig(updates: Partial<AppConfig>): void
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `updates` | `Partial<AppConfig>` | Key-value pairs to merge into the current config. |

**Example:**
```ts
import { setConfig } from 'stellar-drive/config';

// After the setup wizard validates credentials:
setConfig({
  supabaseUrl: 'https://abc123.supabase.co',
  supabasePublishableKey: 'eyJhbGciOiJIUzI1NiIs...',
  configured: true
});
```

---

## Svelte Actions

Import from `stellar-drive/actions`. These are Svelte `use:action` directives that attach DOM-level behavior for remote change animations, edit tracking, and tooltip truncation.

### `remoteChangeAnimation`

Watches an entity for remote changes (arriving via Supabase Realtime) and applies a CSS animation class to the element based on the action type. Supports 8 distinct action types, each with a corresponding CSS class.

| Action Type | CSS Class | Duration |
|---|---|---|
| `create` | `item-created` | 600ms |
| `delete` | `item-deleted` | 500ms |
| `toggle` | `item-toggled` | 600ms |
| `increment` | `counter-increment` | 400ms |
| `decrement` | `counter-decrement` | 400ms |
| `reorder` | `item-reordering` | 400ms |
| `rename` | `text-changed` | 500ms |
| `update` | `item-changed` | 500ms |

**Signature:**
```ts
function remoteChangeAnimation(
  node: HTMLElement,
  options: {
    entityId: string;
    entityType: string;
    fields?: string[];
    animationClass?: string;
    onAction?: (actionType: RemoteActionType, fields?: string[]) => void;
  }
): { update: (opts) => void; destroy: () => void }
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `options.entityId` | `string` | The entity's primary key. |
| `options.entityType` | `string` | The Supabase table name. |
| `options.fields` | `string[]` | Optional field filter — only animate when these fields change. |
| `options.animationClass` | `string` | Custom CSS class override (replaces the default per-type class). |
| `options.onAction` | `function` | Callback fired when a remote change is detected. |

**Example:**
```svelte
<script>
  import { remoteChangeAnimation } from 'stellar-drive/actions';
</script>

<li use:remoteChangeAnimation={{ entityId: task.id, entityType: 'tasks' }}>
  {task.title}
</li>
```

---

### `trackEditing`

Marks an entity as "being edited" so that remote changes are deferred until the form closes. This prevents data loss from concurrent multi-device edits — for example, if the user is editing a task title on their phone while it's updated on their laptop, the remote change is held until the form is dismissed.

Polls for deferred changes every 1 second and adds the `has-deferred-changes` CSS class when deferred changes exist.

**Signature:**
```ts
function trackEditing(
  node: HTMLElement,
  options: {
    entityId: string;
    entityType: string;
    formType: 'auto-save' | 'manual-save';
    fields?: string[];
    onDeferredChanges?: (changes: DeferredChange[]) => void;
  }
): { update: (opts) => void; destroy: () => void }
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `options.formType` | `'auto-save' \| 'manual-save'` | `'auto-save'` applies remote changes immediately. `'manual-save'` defers them until the form closes. |
| `options.onDeferredChanges` | `function` | Called on destroy with any deferred changes that accumulated while editing. |

**Example:**
```svelte
<form use:trackEditing={{
  entityId: task.id,
  entityType: 'tasks',
  formType: 'manual-save',
  fields: ['title', 'description'],
  onDeferredChanges: (changes) => showNotification(`${changes.length} changes were made by another device`)
}}>
  <input bind:value={task.title} />
</form>
```

---

### `triggerLocalAnimation`

Programmatically triggers a remote-change animation on an element for **local** user actions (e.g., showing a brief highlight when the user toggles a checkbox). Allows rapid restart for increment/decrement animations and blocks overlapping for other types.

**Signature:**
```ts
function triggerLocalAnimation(
  element: HTMLElement | null,
  actionType: RemoteActionType
): void
```

**Example:**
```ts
import { triggerLocalAnimation } from 'stellar-drive/actions';

function handleToggle(event: Event) {
  triggerLocalAnimation(event.currentTarget as HTMLElement, 'toggle');
}
```

---

### `truncateTooltip`

A Svelte action that detects CSS text-overflow (ellipsis) on an element and shows a tooltip with the full text when the content is truncated. Uses a singleton tooltip element reused across all instances for performance.

**Desktop:** hover to show, move mouse away to hide.
**Mobile:** tap to show/hide, auto-dismiss after 3 seconds, dismiss on tap-outside.

Automatically positions above the anchor element, flips below if there's overflow, and clamps to viewport edges.

**Signature:**
```ts
function truncateTooltip(node: HTMLElement): { destroy: () => void }
```

**Example:**
```svelte
<script>
  import { truncateTooltip } from 'stellar-drive/actions';
</script>

<span class="truncate" use:truncateTooltip>
  This is a very long text that will be truncated with an ellipsis
</span>
```

---

## Utilities

Import from `stellar-drive/utils`.

### General Utilities

#### `generateId()`

Generates a UUID v4 string using `crypto.randomUUID()` with a `crypto.getRandomValues()` fallback for environments that don't support it.

**Signature:**
```ts
function generateId(): string
```

**Example:**
```ts
import { generateId } from 'stellar-drive/utils';

const id = generateId(); // → 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
```

---

#### `now()`

Returns the current time as an ISO 8601 timestamp string.

**Signature:**
```ts
function now(): string
```

**Example:**
```ts
import { now } from 'stellar-drive/utils';

const timestamp = now(); // → '2025-01-15T10:30:00.000Z'
```

---

#### `calculateNewOrder(items, fromIndex, toIndex)`

Computes a fractional order value for reorderable lists. Calculates the midpoint between the two adjacent items at the target position, enabling drag-and-drop reordering without reindexing the entire list.

**Signature:**
```ts
function calculateNewOrder<T extends { order: number }>(
  items: T[],
  fromIndex: number,
  toIndex: number
): number
```

**Example:**
```ts
import { calculateNewOrder } from 'stellar-drive/utils';

// Items: [{ order: 0 }, { order: 1 }, { order: 2 }]
// Drag item at index 2 to index 0:
const newOrder = calculateNewOrder(items, 2, 0); // → -0.5 (before first item)
```

---

#### `snakeToCamel(s)`

Converts a `snake_case` string to `camelCase`.

**Signature:**
```ts
function snakeToCamel(s: string): string
```

**Example:**
```ts
import { snakeToCamel } from 'stellar-drive/utils';

snakeToCamel('goal_list_id'); // → 'goalListId'
```

---

#### `formatBytes(bytes)`

Formats a byte count into a human-readable string with appropriate unit.

**Signature:**
```ts
function formatBytes(bytes: number): string
```

**Example:**
```ts
import { formatBytes } from 'stellar-drive/utils';

formatBytes(456);     // → '456 B'
formatBytes(1536);    // → '1.50 KB'
formatBytes(1048576); // → '1.00 MB'
```

---

#### `createAsyncGuard()`

Creates an async mutual exclusion lock that prevents overlapping async operations. Returns `check()` (acquires the guard, returns `true` if acquired) and `release()` (releases the guard).

**Signature:**
```ts
function createAsyncGuard(): { check: () => boolean; release: () => void }
```

**Example:**
```ts
import { createAsyncGuard } from 'stellar-drive/utils';

const guard = createAsyncGuard();

async function doWork() {
  if (!guard.check()) return; // Already running
  try {
    await expensiveOperation();
  } finally {
    guard.release();
  }
}
```

---

#### `isSafeRedirect(url)`

Validates that a redirect URL is safe (same-origin, no protocol changes). Prevents open-redirect vulnerabilities in auth callback flows.

**Signature:**
```ts
function isSafeRedirect(url: string): boolean
```

**Example:**
```ts
import { isSafeRedirect } from 'stellar-drive/utils';

isSafeRedirect('/dashboard');           // → true
isSafeRedirect('https://evil.com');     // → false
isSafeRedirect('javascript:alert(1)');  // → false
```

---

### Debug Utilities

Development-time logging gated by a localStorage flag. Zero runtime cost when disabled.

#### `debug(level, ...args)`

Conditional logger that only outputs when debug mode is active. Accepts a severity level and passes all remaining arguments to the corresponding `console` method.

**Signature:**
```ts
function debug(level: 'log' | 'warn' | 'error', ...args: unknown[]): void
```

**Example:**
```ts
import { debug } from 'stellar-drive/utils';

debug('log', 'Sync completed', { tables: 3, records: 42 });
debug('warn', 'Session expires in 5 minutes');
debug('error', 'Failed to push changes:', error);
```

---

#### `isDebugMode()`

Returns whether debug mode is currently enabled. Debug mode causes all `debug()` calls to output to the browser console, providing visibility into sync cycles, realtime events, and CRDT operations.

**Signature:**
```ts
function isDebugMode(): boolean
```

**Returns:** `boolean` — `true` if debug logging is enabled.

**Example:**
```ts
import { isDebugMode } from 'stellar-drive/utils';

if (isDebugMode()) {
  console.log('Debug logging is active');
}
```

---

#### `setDebugMode(enabled)`

Enables or disables debug mode at runtime. When enabled, all `debug()` calls will output to the console, logging sync cycles, realtime events, CRDT operations, and more. The setting persists in localStorage so it survives page reloads.

**Signature:**
```ts
function setDebugMode(enabled: boolean): void
```

| Parameter | Type | Description |
|---|---|---|
| `enabled` | `boolean` | `true` to enable debug logging, `false` to disable. |

**Returns:** `void`

**Example:**
```ts
import { setDebugMode } from 'stellar-drive/utils';

// Enable debug logging (persists in localStorage)
setDebugMode(true);

// Disable
setDebugMode(false);
```

---

### Diagnostics

Unified diagnostics API for inspecting the engine's internal state. Useful for debugging, support tickets, and admin dashboards.

#### `getDiagnostics()`

Returns a comprehensive JSON snapshot of the entire engine state, including sync status, queue state, realtime connection, conflict history, network status, error history, and CRDT state.

**Signature:**
```ts
function getDiagnostics(): Promise<DiagnosticsSnapshot>
```

**Returns:** `DiagnosticsSnapshot` — a deeply nested object containing all engine subsystem states.

**Example:**
```ts
import { getDiagnostics } from 'stellar-drive/utils';

const diagnostics = await getDiagnostics();
console.log(JSON.stringify(diagnostics, null, 2));
// → { sync: { ... }, realtime: { ... }, queue: { ... }, conflicts: { ... }, ... }
```

---

#### `getSyncDiagnostics()`

Returns sync cycle and egress diagnostics. Synchronous — reads from in-memory engine state. Returns sync status, total cycles, last sync time, recent cycle details, hydration state, and per-table egress bandwidth breakdown.

**Signature:**
```ts
function getSyncDiagnostics(): Pick<DiagnosticsSnapshot, 'sync' | 'egress'>
```

**Returns:** Object with `sync` (status, cycle stats, pending count) and `egress` (bandwidth totals, per-table breakdown with formatted bytes and percentages).

**Example:**
```ts
import { getSyncDiagnostics } from 'stellar-drive/utils';

const { sync, egress } = getSyncDiagnostics();
console.log(`Status: ${sync.status}, Cycles: ${sync.totalCycles}`);
console.log(`Total egress: ${egress.totalFormatted}`);
```

---

#### `getRealtimeDiagnostics()`

Returns realtime WebSocket connection diagnostics. Synchronous. Includes connection state, health status, reconnect attempts, last error, user/device IDs, and whether a reconnect is currently scheduled.

**Signature:**
```ts
function getRealtimeDiagnostics(): DiagnosticsSnapshot['realtime']
```

**Returns:** Object with `connectionState`, `healthy`, `reconnectAttempts`, `lastError`, `userId`, `deviceId`, `recentlyProcessedCount`, `operationInProgress`, `reconnectScheduled`.

**Example:**
```ts
import { getRealtimeDiagnostics } from 'stellar-drive/utils';

const rt = getRealtimeDiagnostics();
console.log(`Realtime: ${rt.connectionState}, healthy: ${rt.healthy}`);
```

---

#### `getQueueDiagnostics()`

Returns pending sync queue diagnostics. Async — reads from IndexedDB. Includes total pending operation count, entity IDs, breakdowns by table and operation type, oldest pending timestamp, and items in backoff (retry > 0).

**Signature:**
```ts
function getQueueDiagnostics(): Promise<DiagnosticsSnapshot['queue']>
```

**Returns:** `Promise` resolving to object with `pendingOperations`, `pendingEntityIds`, `byTable`, `byOperationType`, `oldestPendingTimestamp`, `itemsInBackoff`.

**Example:**
```ts
import { getQueueDiagnostics } from 'stellar-drive/utils';

const queue = await getQueueDiagnostics();
console.log(`Pending: ${queue.pendingOperations}, in backoff: ${queue.itemsInBackoff}`);
```

---

#### `getConflictDiagnostics()`

Returns conflict resolution history diagnostics. Async — reads from IndexedDB. Returns recent conflict entries with their resolution strategies and a total count.

**Signature:**
```ts
function getConflictDiagnostics(): Promise<{ recentHistory: ConflictHistoryEntry[]; totalCount: number }>
```

**Returns:** `Promise` resolving to object with `recentHistory` (array of conflict entries) and `totalCount`.

**Example:**
```ts
import { getConflictDiagnostics } from 'stellar-drive/utils';

const conflicts = await getConflictDiagnostics();
console.log(`Total conflicts: ${conflicts.totalCount}`);
conflicts.recentHistory.forEach(c => console.log(`${c.table}: ${c.resolution}`));
```

---

#### `getEngineDiagnostics()`

Returns engine-internal state diagnostics. Synchronous. Includes tab visibility, sync lock state, recently modified entity count, offline status, and auth validation status after reconnect.

**Signature:**
```ts
function getEngineDiagnostics(): DiagnosticsSnapshot['engine']
```

**Returns:** Object with `isTabVisible`, `tabHiddenAt`, `lockHeld`, `lockHeldForMs`, `recentlyModifiedCount`, `wasOffline`, `authValidatedAfterReconnect`.

**Example:**
```ts
import { getEngineDiagnostics } from 'stellar-drive/utils';

const engine = getEngineDiagnostics();
console.log(`Tab visible: ${engine.isTabVisible}, lock held: ${engine.lockHeld}`);
```

---

#### `getNetworkDiagnostics()`

Returns network connectivity diagnostics. Synchronous. Reads the current online/offline status from the reactive store.

**Signature:**
```ts
function getNetworkDiagnostics(): { online: boolean }
```

**Returns:** Object with `online` boolean.

**Example:**
```ts
import { getNetworkDiagnostics } from 'stellar-drive/utils';

const { online } = getNetworkDiagnostics();
console.log(`Network: ${online ? 'online' : 'offline'}`);
```

---

#### `getErrorDiagnostics()`

Returns error state diagnostics. Synchronous. Includes the latest error message and details, plus the recent error history array from the sync status store.

**Signature:**
```ts
function getErrorDiagnostics(): { lastError: string | null; lastErrorDetails: string | null; recentErrors: SyncError[] }
```

**Returns:** Object with `lastError`, `lastErrorDetails`, and `recentErrors` array.

**Example:**
```ts
import { getErrorDiagnostics } from 'stellar-drive/utils';

const errors = getErrorDiagnostics();
if (errors.lastError) {
  console.error(`Last error: ${errors.lastError}`);
  console.error(`Details: ${errors.lastErrorDetails}`);
}
console.log(`Recent errors: ${errors.recentErrors.length}`);
```

---

### SQL Generation

Generate complete Supabase SQL and TypeScript interfaces from a declarative schema definition. The schema in code becomes the single source of truth — no hand-written SQL needed.

#### `generateSupabaseSQL(schema, options?)`

Generates a complete, idempotent SQL file that can be pasted directly into the Supabase SQL Editor to bootstrap the entire database. The generated SQL includes:

1. Extensions (`uuid-ossp`)
2. Helper trigger functions (`set_user_id`, `update_updated_at_column`)
3. One `CREATE TABLE` block per schema table (with columns, RLS policies, triggers, indexes)
4. `trusted_devices` table (unless `includeDeviceVerification: false`)
5. `crdt_documents` table (only if `includeCRDT: true`)
6. Supabase Realtime publication for all tables
7. Storage bucket policies (if configured)

Column types are inferred from field naming conventions:

| Pattern | SQL Type |
|---|---|
| `*_id` | `uuid` |
| `*_at` | `timestamptz` |
| `order` | `double precision default 0` |
| `*_count`, `*_value` | `integer default 0` |
| `is_*`, `completed`, `deleted` | `boolean default false` |
| Everything else | `text` |

**Signature:**
```ts
function generateSupabaseSQL(
  schema: SchemaDefinition,
  options?: SQLGenerationOptions
): string
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `appName` | `string` | — | Application name for SQL comments. |
| `prefix` | `string` | — | Table name prefix for multi-tenant setups. |
| `includeCRDT` | `boolean` | `false` | Include `crdt_documents` table. |
| `includeDeviceVerification` | `boolean` | `true` | Include `trusted_devices` table. |
| `includeHelperFunctions` | `boolean` | `true` | Include trigger helper functions. |
| `storage.buckets` | `StorageBucketConfig[]` | — | Storage buckets to create with RLS policies. |

**Example:**
```ts
import { generateSupabaseSQL } from 'stellar-drive/utils';

const sql = generateSupabaseSQL({
  tasks: 'project_id, order',
  projects: { indexes: 'order', sqlColumns: { name: 'text not null' } },
  user_settings: { singleton: true }
}, {
  appName: 'My App',
  prefix: 'myapp',
  includeCRDT: true,
  storage: {
    buckets: [
      { name: 'avatars', public: true, maxFileSize: 2097152, allowedMimeTypes: ['image/png', 'image/jpeg'] }
    ]
  }
});
```

---

#### `inferColumnType(fieldName)`

Infers a SQL column type from a field name using the engine's naming conventions. Consumers can override any inference via `sqlColumns` in the schema config.

**Signature:**
```ts
function inferColumnType(fieldName: string): string
```

**Example:**
```ts
import { inferColumnType } from 'stellar-drive/utils';

inferColumnType('goal_list_id');   // → 'uuid'
inferColumnType('completed_at');   // → 'timestamptz'
inferColumnType('order');          // → 'double precision default 0'
inferColumnType('is_active');      // → 'boolean default false'
inferColumnType('title');          // → 'text'
```

---

### TypeScript Generation

#### `generateTypeScript(schema, options?)`

Generates TypeScript interfaces from a schema definition. Only tables with a `fields` property are included; tables without `fields` are silently skipped.

**Signature:**
```ts
function generateTypeScript(
  schema: SchemaDefinition,
  options?: TypeScriptGenerationOptions
): string
```

**Options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `header` | `string` | — | Header comment at the top of the generated file. |
| `includeSystemColumns` | `boolean` | `true` | Whether to include system columns (`id`, `user_id`, etc.) in generated interfaces. |

**Example:**
```ts
import { generateTypeScript } from 'stellar-drive/utils';

const ts = generateTypeScript({
  tasks: {
    indexes: 'project_id, order',
    fields: {
      title: 'string',
      completed: 'boolean',
      project_id: 'string',
      order: 'number'
    }
  }
}, { header: '// Auto-generated — do not edit' });
```

---

## Demo Mode

A completely isolated sandbox mode for consumer apps. When active, the engine uses a separate Dexie database with no Supabase connections, allowing users to try the app without creating an account.

#### `isDemoMode()`

Checks whether demo mode is currently active. Reads a localStorage flag (`${prefix}_demo_mode`) that is set by `setDemoMode()`. SSR-safe — returns `false` on the server (no `localStorage` access). When demo mode is active, the engine uses a separate Dexie database (`${name}_demo`), makes zero Supabase connections, and skips all sync/auth/email/device-verification flows.

**Signature:**
```ts
function isDemoMode(): boolean
```

**Returns:** `boolean` — `true` if the demo mode localStorage flag is set.

**Example:**
```ts
import { isDemoMode } from 'stellar-drive';

if (isDemoMode()) {
  console.log('Running in demo mode — no real data');
}
```

---

#### `setDemoMode(enabled)`

Activates or deactivates demo mode by setting a localStorage flag. The flag is read during engine initialization (`initEngine()`). **The caller must trigger a full page reload** after calling this — the entire data layer (database, sync engine, auth) must be reinitialized with the correct (demo or real) database. SSR-safe — no-op on the server.

**Signature:**
```ts
function setDemoMode(enabled: boolean): void
```

| Parameter | Type | Description |
|---|---|---|
| `enabled` | `boolean` | `true` to enter demo mode, `false` to exit. |

**Returns:** `void`

**Example:**
```ts
import { setDemoMode } from 'stellar-drive';

// Enter demo mode
setDemoMode(true);
window.location.href = '/'; // Full page reload required

// Exit demo mode
setDemoMode(false);
window.location.href = '/'; // Full page reload required
```

---

#### `seedDemoData()`

Seeds the demo database with mock data using the consumer's `seedData` callback (provided via `initEngine({ demo: { seedData, mockProfile } })`). Idempotent per page load — no-ops if data has already been seeded (prevents re-seeding on SvelteKit client-side navigations). Clears all app tables and system tables (`syncQueue`, `conflictHistory`) before calling the consumer's seed function.

**Signature:**
```ts
function seedDemoData(): Promise<void>
```

**Returns:** `Promise<void>` — Resolves when seeding is complete.

**Throws:** `Error` if no demo config is registered (i.e., `demo` was not passed to `initEngine()`).

**Example:**
```ts
import { isDemoMode, seedDemoData } from 'stellar-drive';

// In your +layout.ts or +layout.svelte after engine init:
if (isDemoMode()) {
  await seedDemoData();
  // Demo data is now available in IndexedDB
}
```

---

#### `cleanupDemoDatabase(dbName)`

Deletes the demo Dexie database entirely from IndexedDB. Call this when the user exits demo mode, before triggering a page reload. The caller should provide the demo database name (typically `'${name}-db_demo'` where `name` matches the `initEngine()` database name config).

**Signature:**
```ts
function cleanupDemoDatabase(dbName: string): Promise<void>
```

| Parameter | Type | Description |
|---|---|---|
| `dbName` | `string` | The name of the demo database to delete (e.g., `'myapp-db_demo'`). |

**Returns:** `Promise<void>` — Resolves when the database is deleted (or if it didn't exist).

**Example:**
```ts
import { setDemoMode, cleanupDemoDatabase } from 'stellar-drive';

// Exit demo mode
setDemoMode(false);
await cleanupDemoDatabase('myapp-db_demo');
window.location.href = '/'; // Reload to reinitialize with real database
```

---

#### `getDemoConfig()`

Returns the currently registered demo configuration, or `null` if demo mode was not configured in `initEngine()`. The config contains the consumer's `seedData` callback and `mockProfile` for the demo session.

**Signature:**
```ts
function getDemoConfig(): DemoConfig | null
```

**Returns:** `DemoConfig | null` — The registered demo config, or `null`.

**Type:**
```ts
interface DemoConfig {
  /** Consumer callback that populates the demo Dexie DB with mock data. */
  seedData: (db: Dexie) => Promise<void>;
  /** Mock user profile for the demo session. */
  mockProfile: {
    email: string;
    firstName: string;
    lastName: string;
    [key: string]: unknown;
  };
}
```

**Example:**
```ts
import { getDemoConfig } from 'stellar-drive';

const config = getDemoConfig();
if (config) {
  console.log(`Demo user: ${config.mockProfile.firstName} (${config.mockProfile.email})`);
}
```

---

## Supabase Client

#### `supabase`

Direct access to the initialized Supabase client instance. Use this for queries or operations not covered by the generic CRUD layer — for example, RPC calls, Supabase Storage operations, or custom PostgREST filters.

The client is a **lazy singleton** implemented via ES Proxy — it defers client creation until the first property access. This ensures the runtime config (Supabase URL and key) is loaded before the client is created.

**Type:**
```ts
const supabase: SupabaseClient
```

**Example:**
```ts
import { supabase } from 'stellar-drive';

// Custom RPC call:
const { data } = await supabase.rpc('my_function', { param: 'value' });

// Storage upload:
const { error } = await supabase.storage
  .from('avatars')
  .upload('user-123/avatar.png', file);
```

---

## SvelteKit Helpers

Import from `stellar-drive/kit`. These utilities bridge stellar-drive with SvelteKit's routing and server conventions. **Only use within SvelteKit projects.**

### Server Route Factories

#### `getServerConfig()`

Reads Supabase configuration from `process.env` at runtime. Checks for the presence of both `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` environment variables. Returns `{ configured: true }` with the values when both exist, or `{ configured: false }` otherwise. Intended for use in SvelteKit server routes (`+server.ts`) to report configuration status to the client during the setup flow.

**Signature:**
```ts
function getServerConfig(): ServerConfig
```

**Returns:** `ServerConfig` — Object indicating whether credentials are present.

**Type:**
```ts
interface ServerConfig {
  /** true when both PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY are set. */
  configured: boolean;
  /** The Supabase project URL, if configured. */
  supabaseUrl?: string;
  /** The Supabase publishable key, if configured. */
  supabasePublishableKey?: string;
}
```

**Example:**
```ts
// In /api/config/+server.ts
import { getServerConfig } from 'stellar-drive/kit';

export function GET() {
  return new Response(JSON.stringify(getServerConfig()), {
    headers: { 'Content-Type': 'application/json' }
  });
}
```

---

#### `createValidateHandler()`

Factory returning a SvelteKit POST handler that validates Supabase credentials by attempting to connect to the provided Supabase instance. Parses the JSON request body for `supabaseUrl` and `supabasePublishableKey`, validates both are present (returns 400 if not), then delegates to the internal `validateSupabaseCredentials` function. Includes built-in security guards: blocks requests if `PUBLIC_SUPABASE_URL` is already set (app already configured), and validates the Origin header to prevent cross-origin CSRF attacks.

**Signature:**
```ts
function createValidateHandler(): (event: { request: Request; url: URL }) => Promise<Response>
```

**Returns:** An async handler function compatible with SvelteKit's `RequestHandler` signature for POST endpoints.

**Example:**
```ts
// src/routes/api/validate/+server.ts
import { createValidateHandler } from 'stellar-drive/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = createValidateHandler();
```

---

#### `createConfigHandler()`

Factory returning a SvelteKit GET handler that serves the server config (from `getServerConfig()`) as JSON with appropriate security headers (`Cache-Control: private, no-cache`, `X-Content-Type-Options: nosniff`).

**Signature:**
```ts
function createConfigHandler(): () => Promise<Response>
```

**Returns:** An async handler function compatible with SvelteKit's `RequestHandler` signature for GET endpoints.

**Example:**
```ts
// src/routes/api/config/+server.ts
import { createConfigHandler } from 'stellar-drive/kit';

export const GET = createConfigHandler();
```

---

#### `deployToVercel(config)`

Full Vercel deployment flow: upserts Supabase environment variables (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, and optionally `PUBLIC_APP_PREFIX`), then triggers a production redeployment. Uses a two-strategy approach: **Strategy A (preferred)** — git-based redeployment using the repo metadata from Vercel's environment variables, triggering a fresh build from the source branch. **Strategy B (fallback)** — clone-based redeployment using an existing deployment ID, reusing the last build artifacts with updated env vars.

**Signature:**
```ts
function deployToVercel(config: DeployConfig): Promise<DeployResult>
```

| Parameter | Type | Description |
|---|---|---|
| `config` | `DeployConfig` | Deployment configuration with Vercel auth and Supabase values. |

**Types:**
```ts
interface DeployConfig {
  /** Vercel personal access token or team token for API authentication. */
  vercelToken: string;
  /** The Vercel project ID (found in project settings). */
  projectId: string;
  /** The Supabase project URL (e.g., https://abc.supabase.co). */
  supabaseUrl: string;
  /** The Supabase publishable key for client-side access. */
  supabasePublishableKey: string;
  /** Optional table name prefix (sets PUBLIC_APP_PREFIX env var on Vercel). */
  prefix?: string;
}

interface DeployResult {
  /** Whether the env var upsert and redeployment completed without errors. */
  success: boolean;
  /** The Vercel deployment URL (only present when success is true). */
  deploymentUrl?: string;
  /** Error message (only present when success is false). */
  error?: string;
}
```

**Example:**
```ts
import { deployToVercel } from 'stellar-drive/kit';

const result = await deployToVercel({
  vercelToken: 'tok_...',
  projectId: 'prj_...',
  supabaseUrl: 'https://abc.supabase.co',
  supabasePublishableKey: 'eyJ...',
  prefix: 'myapp'
});

if (result.success) {
  console.log(`Deployed: ${result.deploymentUrl}`);
} else {
  console.error(`Deploy failed: ${result.error}`);
}
```

---

#### `createServerSupabaseClient(prefix?)`

Creates a server-side Supabase client using environment variables. Reads `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` from `process.env` via `getServerConfig()` and returns a fresh `SupabaseClient` instance. Intended for use in SvelteKit server hooks or API routes where the browser-side lazy singleton is unavailable. When a `prefix` is provided, the returned client is wrapped in a Proxy that transparently prefixes all `.from()` calls — e.g., with `prefix = 'switchboard'`, `.from('users')` becomes `.from('switchboard_users')`.

**Signature:**
```ts
function createServerSupabaseClient(prefix?: string): SupabaseClient | null
```

| Parameter | Type | Description |
|---|---|---|
| `prefix` | `string` | Optional table name prefix (e.g., `'switchboard'`). |

**Returns:** `SupabaseClient | null` — A Supabase client instance, or `null` if credentials are not configured in environment variables.

**Example:**
```ts
// In hooks.server.ts or +server.ts
import { createServerSupabaseClient } from 'stellar-drive/kit';

const supabase = createServerSupabaseClient('switchboard');
if (supabase) {
  // supabase.from('users') → queries 'switchboard_users' in Supabase
  const { data } = await supabase.from('users').select('*');
}
```

---

### Layout Load Functions

#### `resolveRootLayout()`

Orchestrates the root layout load sequence — the critical initialization path that runs on every page load:

1. Calls `initEngine()` for database schema setup
2. Runs `initConfig()` to load runtime config from storage
3. Resolves auth state (determines whether the user is authenticated)
4. Starts the sync engine if the user is authenticated

**Signature:**
```ts
function resolveRootLayout(): Promise<RootLayoutData>
```

**Returns:** `RootLayoutData` (alias for `AuthStateResult`) — contains `session`, `authMode`, `offlineProfile`, and `serverConfigured`.

**Example:**
```ts
// src/routes/+layout.ts
import { resolveRootLayout } from 'stellar-drive/kit';

export async function load() {
  return await resolveRootLayout();
}
```

---

#### `resolveSetupAccess()`

Setup page guard implementing a two-tier access model:
- **Unconfigured app** (first-time setup): public access, no auth required. Returns `{ isFirstSetup: true }`.
- **Configured app** (reconfiguration): any authenticated user may access. Unauthenticated users are redirected.

**Signature:**
```ts
function resolveSetupAccess(): Promise<{
  data: SetupAccessData;
  redirectUrl: string | null;
}>
```

**Type:**
```ts
interface SetupAccessData {
  isFirstSetup: boolean;
}
```

**Example:**
```ts
// src/routes/setup/+layout.ts
import { resolveSetupAccess } from 'stellar-drive/kit';
import { redirect } from '@sveltejs/kit';

export async function load() {
  const { data, redirectUrl } = await resolveSetupAccess();
  if (redirectUrl) throw redirect(303, redirectUrl);
  return data;
}
```

---

### Email Confirmation

#### `handleEmailConfirmation(tokenHash, type)`

Handles the full email confirmation flow: verifies the OTP token hash via Supabase, optionally trusts the pending device, and translates Supabase error messages into user-friendly strings.

**Signature:**
```ts
function handleEmailConfirmation(
  tokenHash: string,
  type: 'signup' | 'email' | 'email_change' | 'magiclink'
): Promise<ConfirmResult>
```

**Type:**
```ts
interface ConfirmResult {
  success: boolean;
  error?: string;
}
```

**Example:**
```ts
// src/routes/confirm/+page.ts
import { handleEmailConfirmation } from 'stellar-drive/kit';

export async function load({ url }) {
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') || 'signup';

  if (!tokenHash) return { success: false, error: 'Missing token' };
  return await handleEmailConfirmation(tokenHash, type);
}
```

---

#### `broadcastAuthConfirmed(channelName, type)`

Broadcasts an auth confirmation event via the browser's `BroadcastChannel` API so other open tabs (e.g., the login page that initiated the email flow) can detect the completed authentication and update their UI. After broadcasting, waits briefly (500ms) for the receiving tab to process the message, then attempts to auto-close the confirmation tab via `window.close()`.

**Signature:**
```ts
function broadcastAuthConfirmed(
  channelName: string,
  type: string
): Promise<'closed' | 'can_close' | 'no_broadcast'>
```

| Parameter | Type | Description |
|---|---|---|
| `channelName` | `string` | The BroadcastChannel name (should match the name used by the login page listener). |
| `type` | `string` | The confirmation type (e.g., `'signup'`, `'email_change'`). Included in the broadcast message. |

**Returns:** `Promise<'closed' | 'can_close' | 'no_broadcast'>`
- `'closed'` — Tab was auto-closed successfully via `window.close()`.
- `'can_close'` — Browser blocked `window.close()` (not opened via script); show a "you may close this tab" message.
- `'no_broadcast'` — `BroadcastChannel` API not supported in this browser.

**Example:**
```ts
import { broadcastAuthConfirmed } from 'stellar-drive/kit';

// In /confirm/+page.svelte after successful email verification:
const result = await broadcastAuthConfirmed('auth-confirm', 'signup');
if (result === 'can_close') {
  showMessage('Email confirmed! You can close this tab.');
}
```

---

### Service Worker Lifecycle

#### `pollForNewServiceWorker(options?)`

Polls `registration.update()` until a new service worker is detected in the `waiting` state. Useful after triggering a deployment to detect when the new build is live and ready to activate. Calls `registration.update()` on each tick, which forces the browser to check the server for a new SW script. When a waiting worker is found, the `onFound` callback fires and polling stops automatically. Handles background tab throttling — when the tab returns to foreground, immediately triggers a poll.

**Signature:**
```ts
function pollForNewServiceWorker(options?: PollOptions): () => void
```

| Parameter | Type | Description |
|---|---|---|
| `options` | `PollOptions` | Optional polling configuration. |

**Type:**
```ts
interface PollOptions {
  /** Polling interval in milliseconds. @default 5000 */
  intervalMs?: number;
  /** Maximum polling attempts before giving up. @default 60 */
  maxAttempts?: number;
  /** Callback invoked when a new SW is found in waiting state. Called once. */
  onFound?: () => void;
}
```

**Returns:** `() => void` — A cleanup function that stops polling. Call it in Svelte's `onDestroy` or `$effect` teardown.

**Example:**
```ts
import { pollForNewServiceWorker } from 'stellar-drive/kit';

const stopPolling = pollForNewServiceWorker({
  intervalMs: 3000,
  maxAttempts: 100,
  onFound: () => {
    showUpdateBanner();
  }
});

// Later, to stop polling early:
stopPolling();
```

---

#### `handleSwUpdate()`

Sends `SKIP_WAITING` to the waiting service worker, listens for the `controllerchange` event, then reloads the page to activate the new version. If no waiting worker is found (e.g., the update was already applied), falls back to a simple page reload. The `{ once: true }` listener option acts as a double-reload guard. SSR-safe — no-op on the server.

**Signature:**
```ts
function handleSwUpdate(): Promise<void>
```

**Returns:** `Promise<void>` — Resolves just before the page reloads. In practice, the caller won't observe the resolution since `window.location.reload()` interrupts execution.

**Example:**
```ts
import { handleSwUpdate } from 'stellar-drive/kit';

// In an "Update Now" button handler
async function onUpdateClick() {
  await handleSwUpdate();
  // Page will have reloaded by this point
}
```

---

#### `monitorSwLifecycle(callbacks)`

Comprehensive service worker monitoring covering six detection strategies for maximum reliability across browsers and platforms (including iOS PWA quirks):

1. **Immediate check** — inspects the current registration for a waiting worker right away
2. **Delayed retries at 1s/3s** — iOS PWA sometimes needs extra time after app launch
3. **`SW_INSTALLED` message listener** — listens for a custom message from the SW itself
4. **`updatefound` + `statechange` tracking** — monitors standard SW lifecycle events
5. **`visibilitychange` re-check** — triggers an update check when the app resumes from background
6. **2-minute polling interval** — periodic fallback for long-running sessions

SSR-safe — returns a no-op cleanup function if not in a browser context.

**Signature:**
```ts
function monitorSwLifecycle(callbacks: SwLifecycleCallbacks): () => void
```

| Parameter | Type | Description |
|---|---|---|
| `callbacks` | `SwLifecycleCallbacks` | Object containing the `onUpdateAvailable` callback. |

**Type:**
```ts
interface SwLifecycleCallbacks {
  /** Called whenever an update-available condition is detected through any strategy. */
  onUpdateAvailable: () => void;
}
```

**Returns:** `() => void` — A cleanup function that removes all event listeners, clears all intervals and timeouts, and stops monitoring. Call it in Svelte's `onDestroy` or `$effect` teardown.

**Example:**
```ts
import { monitorSwLifecycle, handleSwUpdate } from 'stellar-drive/kit';

// In a Svelte component's $effect
let updateAvailable = $state(false);

$effect(() => {
  const cleanup = monitorSwLifecycle({
    onUpdateAvailable: () => {
      updateAvailable = true;
    }
  });
  return cleanup;
});

// When user clicks "Update Now":
async function onUpdate() {
  await handleSwUpdate();
}
```

---

### Auth Hydration

#### `hydrateAuthState(layoutData)`

Hydrates the client-side auth stores from server-provided layout data, populating the auth stores without an extra network round-trip. Switches on the `authMode` discriminator and calls the appropriate `authState` setter method.

**Signature:**
```ts
function hydrateAuthState(layoutData: AuthLayoutData): void
```

**Type:**
```ts
interface AuthLayoutData {
  authMode: 'supabase' | 'offline' | 'demo' | 'none';
  session: Session | null;
  offlineProfile: OfflineCredentials | null;
}
```

**Example:**
```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { hydrateAuthState } from 'stellar-drive/kit';

  let { data } = $props();

  $effect(() => {
    hydrateAuthState(data);
  });
</script>
```

---

## Vite Plugin

Import from `stellar-drive/vite`. This plugin runs at **build time** in `vite.config.ts` — it is not a browser runtime module.

#### `stellarPWA(config)`

Vite plugin factory that generates the service worker (`static/sw.js`), asset manifest (`asset-manifest.json`), and optionally auto-generates TypeScript types from your schema and pushes the schema SQL to Supabase via a direct Postgres connection.

**Lifecycle hooks:**

| Hook | When | What it does |
|---|---|---|
| `buildStart` | Dev + production builds | Generates `static/sw.js` from compiled SW template. If `schema` enabled: generates TypeScript types + pushes schema SQL. |
| `closeBundle` | After Rollup finishes | Scans SvelteKit's immutable output directory, writes `asset-manifest.json` for SW precaching. |
| `configureServer` | Dev only (when `schema` enabled) | Watches schema file with 500ms debounce, re-generates types + pushes SQL on save. |

**Signature:**
```ts
function stellarPWA(config: SWConfig): VitePlugin
```

**Types:**
```ts
interface SWConfig {
  prefix: string;
  name: string;
  schema?: boolean | SchemaConfig;
}

interface SchemaConfig {
  path?: string;           // Default: 'src/lib/schema.ts'
  typesOutput?: string;    // Default: 'src/lib/types.generated.ts'
  autoMigrate?: boolean;   // Default: true (requires DATABASE_URL in .env)
  includeCRDT?: boolean;   // Default: false
}
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `config.prefix` | `string` | Cache name prefix for the service worker (e.g., `'myapp'`). Becomes part of cache names like `myapp-assets-v1`. |
| `config.name` | `string` | Human-readable app name for the offline fallback page. |
| `config.schema` | `boolean \| SchemaConfig` | Pass `true` for all defaults, or a `SchemaConfig` object for full control. When enabled, the plugin generates TypeScript types and pushes schema SQL on every build. |

**Service Worker Features:**
- **Immutable asset caching** — `/_app/immutable/*` files are cached permanently (cache-first)
- **Shell asset caching** — versioned per deploy (cache-first)
- **Navigation caching** — HTML pages use network-first with 3-second timeout
- **Background precaching** — batches of 5 assets with 50ms delays to avoid blocking
- **Old cache cleanup** — automatically removes outdated cache versions on activation

**Example:**
```ts
// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import { stellarPWA } from 'stellar-drive/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit(),
    stellarPWA({
      prefix: 'myapp',
      name: 'My App',
      schema: {
        path: 'src/lib/schema.ts',
        typesOutput: 'src/lib/types.generated.ts',
        autoMigrate: true,
        includeCRDT: false
      }
    })
  ]
});
```

**Minimal example (PWA only, no schema):**
```ts
stellarPWA({ prefix: 'myapp', name: 'My App' })
```

**With schema auto-generation (all defaults):**
```ts
stellarPWA({ prefix: 'myapp', name: 'My App', schema: true })
```

---

## CRDT Collaborative Editing

Import from `stellar-drive/crdt`. Provides real-time collaborative document editing powered by Yjs. Consumers never need to install `yjs` directly — all necessary types and constructors are re-exported.

The CRDT subsystem must be enabled by providing `crdt` config to `initEngine()`.

### Document Lifecycle

#### `openDocument(documentId, options?)`

Opens a CRDT document for collaborative editing. Loads the document state from IndexedDB (if available) or Supabase, establishes a Supabase Broadcast channel for real-time sync, and starts awareness (presence tracking).

**Idempotent** — calling with the same `documentId` returns the existing provider.

**Signature:**
```ts
function openDocument(
  documentId: string,
  options?: OpenDocumentOptions
): Promise<CRDTProvider>
```

**Types:**
```ts
interface OpenDocumentOptions {
  offlineEnabled?: boolean;
  initialPresence?: Partial<UserPresenceState>;
}

interface CRDTProvider {
  doc: YDoc;
  documentId: string;
  destroy(): Promise<void>;
}
```

**Example:**
```ts
import { openDocument, createSharedText } from 'stellar-drive/crdt';

const provider = await openDocument('page-123');
const text = createSharedText(provider.doc);
// Use `text` with a Yjs-compatible editor (e.g., TipTap, ProseMirror)
```

---

#### `closeDocument(documentId)`

Closes a specific CRDT document. Saves the final state to IndexedDB (if offline-enabled), persists to Supabase if dirty and online, leaves the Broadcast channel and presence, destroys the `Y.Doc`, and removes the provider from the active registry. No-op if the document is not currently open.

**Signature:**
```ts
function closeDocument(documentId: string): Promise<void>
```

| Parameter | Type | Description |
|---|---|---|
| `documentId` | `string` | The unique document identifier to close. |

**Returns:** `Promise<void>` — Resolves when the document has been fully cleaned up.

**Example:**
```ts
import { closeDocument } from 'stellar-drive/crdt';

// Close a single document (e.g., when navigating away from the editor page)
await closeDocument('doc-123');
```

---

#### `closeAllDocuments()`

Closes all currently open CRDT documents in parallel. Each document is saved, persisted (if dirty and online), and cleaned up. Call this during app teardown or sign-out to ensure all collaborative documents are properly saved and all Broadcast channels are disconnected.

**Signature:**
```ts
function closeAllDocuments(): Promise<void>
```

**Returns:** `Promise<void>` — Resolves when all documents have been closed. Uses `Promise.allSettled` internally so one document's failure doesn't block others.

**Example:**
```ts
import { closeAllDocuments } from 'stellar-drive/crdt';

// During sign-out flow
async function handleSignOut() {
  await closeAllDocuments();
  // Now safe to clear auth state, redirect to login, etc.
}
```

---

### Shared Type Factories

Factory functions that create Yjs shared types on a document. These are the building blocks for collaborative data structures. Each factory takes a `Y.Doc` and an optional name string. If the type already exists in the doc (e.g., from a previous session or a remote peer), the existing instance is returned — Yjs shared types are singletons keyed by name within a doc.

#### `createSharedText(doc, name?)`

Gets or creates a `Y.Text` shared type within a Yjs document. `Y.Text` supports rich text with formatting attributes (bold, italic, etc.) and is the standard type for collaborative text editors like TipTap, ProseMirror, or CodeMirror.

**Signature:**
```ts
function createSharedText(doc: YDoc, name?: string): YText
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `doc` | `YDoc` | — | The Yjs document instance (from `provider.doc`). |
| `name` | `string` | `'text'` | The shared type name (unique within the document). |

**Returns:** `YText` — The shared text instance, either existing or newly created.

**Example:**
```ts
import { openDocument, createSharedText } from 'stellar-drive/crdt';

const provider = await openDocument('doc-1', 'page-1');
const title = createSharedText(provider.doc, 'title');
title.insert(0, 'My Page Title');

// Use with TipTap editor:
// new Editor({ extensions: [Collaboration.configure({ document: provider.doc, field: 'title' })] })
```

---

#### `createSharedXmlFragment(doc, name?)`

Gets or creates a `Y.XmlFragment` shared type within a Yjs document. `Y.XmlFragment` is the standard container for block-based editors (ProseMirror, TipTap, BlockNote). It represents a tree of XML elements that maps to the editor's document model.

**Signature:**
```ts
function createSharedXmlFragment(doc: YDoc, name?: string): YXmlFragment
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `doc` | `YDoc` | — | The Yjs document instance. |
| `name` | `string` | `'content'` | The shared type name. |

**Returns:** `YXmlFragment` — The shared XML fragment instance.

**Example:**
```ts
import { openDocument, createSharedXmlFragment } from 'stellar-drive/crdt';

const provider = await openDocument('doc-1', 'page-1');
const content = createSharedXmlFragment(provider.doc, 'content');
// Use with TipTap:
// new Editor({ extensions: [Collaboration.configure({ fragment: content })] })
```

---

#### `createSharedArray(doc, name?)`

Gets or creates a `Y.Array` shared type within a Yjs document. `Y.Array` is a CRDT list type suitable for ordered collections (e.g., a list of block IDs, kanban columns, or comment threads).

**Signature:**
```ts
function createSharedArray<T>(doc: YDoc, name?: string): YArray<T>
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `doc` | `YDoc` | — | The Yjs document instance. |
| `name` | `string` | `'array'` | The shared type name. |

**Returns:** `YArray<T>` — The shared array instance.

**Example:**
```ts
import { openDocument, createSharedArray } from 'stellar-drive/crdt';

const provider = await openDocument('doc-1', 'page-1');
const blockOrder = createSharedArray<string>(provider.doc, 'blockOrder');
blockOrder.push(['block-1', 'block-2', 'block-3']);
```

---

#### `createSharedMap(doc, name?)`

Gets or creates a `Y.Map` shared type within a Yjs document. `Y.Map` is a CRDT key-value map suitable for document metadata, settings, or per-block properties.

**Signature:**
```ts
function createSharedMap<T>(doc: YDoc, name?: string): YMap<T>
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `doc` | `YDoc` | — | The Yjs document instance. |
| `name` | `string` | `'map'` | The shared type name. |

**Returns:** `YMap<T>` — The shared map instance.

**Example:**
```ts
import { openDocument, createSharedMap } from 'stellar-drive/crdt';

const provider = await openDocument('doc-1', 'page-1');
const settings = createSharedMap<string>(provider.doc, 'settings');
settings.set('theme', 'dark');
settings.set('fontSize', '14');
```

---

#### `createBlockDocument(doc)`

Sets up a standard "block document" structure within a Yjs document. Creates two shared types commonly used by Notion-style block editors: a `Y.XmlFragment` named `'content'` for the block tree (paragraphs, headings, lists, etc.) and a `Y.Map` named `'meta'` for per-document metadata (title, icon, cover, properties, etc.). This is a convenience wrapper — you can also create these types individually using the other factory functions.

**Signature:**
```ts
function createBlockDocument(doc: YDoc): { content: YXmlFragment; meta: YMap<unknown> }
```

| Parameter | Type | Description |
|---|---|---|
| `doc` | `YDoc` | The Yjs document instance. |

**Returns:** `{ content: YXmlFragment; meta: YMap<unknown> }` — Object with `content` (block tree) and `meta` (metadata map) shared types.

**Example:**
```ts
import { openDocument, createBlockDocument } from 'stellar-drive/crdt';

const provider = await openDocument('doc-1', 'page-1');
const { content, meta } = createBlockDocument(provider.doc);
meta.set('title', 'My Page');
meta.set('icon', '📝');
// Pass `content` to your block editor's collaboration extension
```

---

### Yjs Re-exports

These re-exports allow consumers to work with Yjs without installing it directly:

| Export | Yjs Type | Description |
|---|---|---|
| `YDoc` | `Doc` | The root Yjs document (class, can be instantiated) |
| `YText` | `Text` | Collaborative text type |
| `YXmlFragment` | `XmlFragment` | XML fragment type |
| `YArray` | `Array` | Ordered array type |
| `YMap` | `Map` | Key-value map type |
| `YXmlElement` | `XmlElement` | XML element type |

---

### Awareness / Presence

Track which users are currently viewing or editing a document, their cursor positions, and selections.

#### `updateCursor(documentId, cursor, selection?)`

Updates the local user's cursor position and optional selection in a document. Debounced to `cursorDebounceMs` (default 50ms) to avoid flooding the Presence channel with rapid cursor movements. The cursor and selection values are opaque to the engine — pass whatever your editor provides.

**Signature:**
```ts
function updateCursor(
  documentId: string,
  cursor: unknown,
  selection?: unknown
): void
```

| Parameter | Type | Description |
|---|---|---|
| `documentId` | `string` | The document to update cursor for. |
| `cursor` | `unknown` | Editor-specific cursor position (opaque to the engine). |
| `selection` | `unknown` | Optional editor-specific selection range. |

**Returns:** `void`

**Example:**
```ts
import { updateCursor } from 'stellar-drive/crdt';

// In your TipTap editor's selection change handler:
editor.on('selectionUpdate', ({ editor }) => {
  updateCursor('doc-1', editor.state.selection.anchor, editor.state.selection);
});
```

---

#### `getCollaborators(documentId)`

Returns all currently active remote collaborators in a document. Excludes the local user (they don't need to see their own cursor). Each collaborator includes their name, deterministically assigned color, cursor position, and selection.

**Signature:**
```ts
function getCollaborators(documentId: string): UserPresenceState[]
```

| Parameter | Type | Description |
|---|---|---|
| `documentId` | `string` | The document to get collaborators for. |

**Returns:** `UserPresenceState[]` — Array of presence states for remote collaborators.

**Type:**
```ts
interface UserPresenceState {
  userId: string;
  deviceId: string;
  name: string;
  color: string;
  cursor?: unknown;
  selection?: unknown;
  lastActiveAt: string;
}
```

**Example:**
```ts
import { getCollaborators } from 'stellar-drive/crdt';

const collaborators = getCollaborators('doc-1');
collaborators.forEach(c => {
  console.log(`${c.name} is editing (color: ${c.color})`);
});
// [{ userId: '...', name: 'Alice', color: '#E57373', cursor: 42 }]
```

---

#### `onCollaboratorsChange(documentId, callback)`

Subscribes to collaborator changes for a document. The callback fires whenever a collaborator joins, leaves, or updates their cursor position. The callback receives the current list of remote collaborators (excluding the local user). Returns an unsubscribe function for cleanup.

**Signature:**
```ts
function onCollaboratorsChange(
  documentId: string,
  callback: (collaborators: UserPresenceState[]) => void
): () => void
```

| Parameter | Type | Description |
|---|---|---|
| `documentId` | `string` | The document to subscribe to. |
| `callback` | `(collaborators: UserPresenceState[]) => void` | Called with the updated collaborator list. |

**Returns:** `() => void` — Unsubscribe function. Call it to stop receiving updates.

**Example:**
```ts
import { onCollaboratorsChange } from 'stellar-drive/crdt';

// In a Svelte component
let collaborators = $state<UserPresenceState[]>([]);

$effect(() => {
  const unsubscribe = onCollaboratorsChange('doc-1', (collabs) => {
    collaborators = collabs;
  });
  return unsubscribe;
});

// Render avatar list from `collaborators`
```

---

#### `assignColor(userId)`

Deterministically assigns a hex color string to a user ID from a 12-color palette. Uses a simple hash of the userId to index into the palette. The same userId always gets the same color across sessions and devices, ensuring consistent collaborator colors.

**Signature:**
```ts
function assignColor(userId: string): string
```

| Parameter | Type | Description |
|---|---|---|
| `userId` | `string` | The user's UUID. |

**Returns:** `string` — A hex color string from the 12-color palette (e.g., `'#E57373'`).

**Example:**
```ts
import { assignColor } from 'stellar-drive/crdt';

const color = assignColor('user-abc-123');
// '#64B5F6' — always the same for this userId
// Use for cursor color, avatar ring, selection highlight, etc.
```

---

### Offline Management

#### `enableOffline(pageId, documentId)`

Marks a CRDT document for offline storage so it's available without network access. Persists the document's current Yjs state to IndexedDB. If the document is currently open in a provider, its live state is saved. If not open but online, the state is fetched from Supabase. Enforces the `maxOfflineDocuments` limit configured in `CRDTConfig` (default: 50).

**Signature:**
```ts
function enableOffline(pageId: string, documentId: string): Promise<void>
```

| Parameter | Type | Description |
|---|---|---|
| `pageId` | `string` | The page/entity this document belongs to. |
| `documentId` | `string` | The unique document identifier. |

**Returns:** `Promise<void>` — Resolves when the document is saved for offline access.

**Throws:**
- `Error` if the offline document limit has been reached.
- `Error` if the document is not open and the device is offline (can't fetch remote state).

**Example:**
```ts
import { enableOffline } from 'stellar-drive/crdt';

// Mark a document for offline access
await enableOffline('page-1', 'doc-1');
// Document is now available even without network connectivity
```

---

#### `disableOffline(pageId, documentId)`

Removes a CRDT document from offline storage. Deletes the document and all its pending updates from IndexedDB. If the document is currently open in a provider, it continues to work in memory but will no longer persist to IndexedDB.

**Signature:**
```ts
function disableOffline(pageId: string, documentId: string): Promise<void>
```

| Parameter | Type | Description |
|---|---|---|
| `pageId` | `string` | The page/entity this document belongs to (kept for API consistency). |
| `documentId` | `string` | The document to remove from offline storage. |

**Returns:** `Promise<void>` — Resolves when the document has been removed from offline storage.

**Example:**
```ts
import { disableOffline } from 'stellar-drive/crdt';

await disableOffline('page-1', 'doc-1');
// Document is no longer available offline
```

---

#### `isOfflineEnabled(documentId)`

Checks whether a specific document is stored for offline access. Reads the document record from IndexedDB and checks the `offlineEnabled` flag.

**Signature:**
```ts
function isOfflineEnabled(documentId: string): Promise<boolean>
```

| Parameter | Type | Description |
|---|---|---|
| `documentId` | `string` | The document to check. |

**Returns:** `Promise<boolean>` — `true` if the document has `offlineEnabled: 1` in IndexedDB.

**Example:**
```ts
import { isOfflineEnabled } from 'stellar-drive/crdt';

const offline = await isOfflineEnabled('doc-1');
if (offline) {
  console.log('This document is available offline');
}
```

---

#### `getOfflineDocuments()`

Returns all CRDT document records that are stored for offline access. Each record includes the document ID, page ID, state size, timestamps, and sync status.

**Signature:**
```ts
function getOfflineDocuments(): Promise<CRDTDocumentRecord[]>
```

**Returns:** `Promise<CRDTDocumentRecord[]>` — Array of document records with `offlineEnabled: 1`.

**Example:**
```ts
import { getOfflineDocuments } from 'stellar-drive/crdt';

const docs = await getOfflineDocuments();
console.log(`${docs.length} documents available offline`);
docs.forEach(d => console.log(`${d.documentId}: ${d.stateSize} bytes`));
```

---

#### `loadDocumentByPageId(pageId)`

Loads a CRDT document record from IndexedDB by its page reference ID. Pages have at most one CRDT document. Returns the full document record including the Yjs binary state, or `undefined` if not found.

**Signature:**
```ts
function loadDocumentByPageId(pageId: string): Promise<CRDTDocumentRecord | undefined>
```

| Parameter | Type | Description |
|---|---|---|
| `pageId` | `string` | The page/entity ID to look up. |

**Returns:** `Promise<CRDTDocumentRecord | undefined>` — The document record, or `undefined` if no offline document exists for this page.

**Example:**
```ts
import { loadDocumentByPageId } from 'stellar-drive/crdt';

const record = await loadDocumentByPageId('page-123');
if (record) {
  console.log(`Found offline document: ${record.documentId} (${record.stateSize} bytes)`);
}
```

---

#### `deleteDocumentState(documentId)`

Deletes a CRDT document's offline state from IndexedDB. Also clears all associated pending crash-recovery updates for the document.

**Signature:**
```ts
function deleteDocumentState(documentId: string): Promise<void>
```

| Parameter | Type | Description |
|---|---|---|
| `documentId` | `string` | The document to delete from offline storage. |

**Returns:** `Promise<void>` — Resolves when the document and its pending updates are deleted.

**Example:**
```ts
import { deleteDocumentState } from 'stellar-drive/crdt';

// Manually clean up a document's offline data
await deleteDocumentState('doc-123');
```

---

### Persistence (Advanced)

Low-level persistence functions. The CRDT provider automatically handles persistence during normal operation — these are for advanced use cases like forced saves or manual cleanup.

#### `persistDocument(documentId, doc)`

Immediately saves a Yjs document's full state to Supabase via upsert. The upsert key is `page_id` (unique per user via RLS). On success, clears all `crdtPendingUpdates` for this document in IndexedDB and updates `lastPersistedAt` in the local record. The CRDT provider calls this automatically on a periodic timer (`persistIntervalMs`, default 30s), but you can call it manually for a forced save.

**Signature:**
```ts
function persistDocument(documentId: string, doc: YDoc): Promise<void>
```

| Parameter | Type | Description |
|---|---|---|
| `documentId` | `string` | The document identifier (for logging and IndexedDB updates). |
| `doc` | `YDoc` | The Yjs document to persist. |

**Returns:** `Promise<void>` — Resolves when the Supabase upsert succeeds.

**Throws:** `Error` if the Supabase upsert fails or no active provider exists for this document.

**Example:**
```ts
import { openDocument, persistDocument } from 'stellar-drive/crdt';

const provider = await openDocument('doc-1', 'page-1');
// ... make edits ...
// Force an immediate save to Supabase
await persistDocument('doc-1', provider.doc);
```

---

#### `persistAllDirty()`

Persists all active documents that have unsaved changes (dirty flag set) to Supabase. Iterates all active providers, checks each for dirty state, and persists each one. Errors are caught per-document so one failure doesn't block others. Useful as a manual "save all" action or for pre-close cleanup.

**Signature:**
```ts
function persistAllDirty(): Promise<void>
```

**Returns:** `Promise<void>` — Resolves when all dirty documents have been persisted (or failed individually).

**Example:**
```ts
import { persistAllDirty } from 'stellar-drive/crdt';

// Save all unsaved CRDT documents before app teardown
await persistAllDirty();
```

---

#### `deleteRemoteDocument(pageId)`

Deletes a CRDT document from Supabase by page ID. Removes the row from the `crdt_documents` table. RLS scopes the delete to the current user's row. No-op if the row doesn't exist.

**Signature:**
```ts
function deleteRemoteDocument(pageId: string): Promise<void>
```

| Parameter | Type | Description |
|---|---|---|
| `pageId` | `string` | The page/entity ID whose CRDT document should be deleted from Supabase. |

**Returns:** `Promise<void>` — Resolves when the remote document is deleted (or if it didn't exist).

**Example:**
```ts
import { deleteRemoteDocument } from 'stellar-drive/crdt';

// When deleting a page, also clean up its CRDT document
await deleteRemoteDocument('page-123');
```

---

### CRDT Diagnostics

#### `getCRDTDiagnostics()`

Returns a comprehensive diagnostic snapshot of the CRDT subsystem. Includes active documents with their state sizes and connection states, collaborator counts, offline storage usage and per-document details, pending crash-recovery updates, and the resolved CRDT configuration. If CRDT is not enabled, returns a minimal object with `enabled: false`. This is an async function because it reads from IndexedDB for offline and pending data.

**Signature:**
```ts
function getCRDTDiagnostics(): Promise<DiagnosticsSnapshot['crdt']>
```

**Returns:** `Promise<DiagnosticsSnapshot['crdt']>` — Object with `enabled`, `config`, `activeDocuments`, `activeDocumentCount`, `offline` (storage stats), `pendingUpdates`, and `totalPendingUpdates`.

**Example:**
```ts
import { getCRDTDiagnostics } from 'stellar-drive/crdt';

const crdt = await getCRDTDiagnostics();
console.log(`CRDT enabled: ${crdt.enabled}`);
console.log(`Active documents: ${crdt.activeDocumentCount}`);
console.log(`Offline documents: ${crdt.offline.documentCount}/${crdt.offline.maxDocuments}`);
console.log(`Offline storage: ${crdt.offline.totalSizeFormatted}`);
console.log(`Pending updates: ${crdt.totalPendingUpdates}`);
```

---

### CRDT Configuration Types

```ts
interface CRDTConfig {
  persistIntervalMs?: number;        // Default: 30000 (30s)
  broadcastDebounceMs?: number;      // Default: 100
  localSaveDebounceMs?: number;      // Default: 5000
  cursorDebounceMs?: number;         // Default: 50
  maxOfflineDocuments?: number;      // Default: 50
  maxBroadcastPayloadBytes?: number; // Default: 256000 (250KB)
}
```

---

## CLI

The `stellar-drive` package includes a CLI accessible via `npx stellar-drive`.

### `install pwa`

Scaffolds a complete offline-first SvelteKit PWA project with stellar-drive preconfigured. Runs an interactive walkthrough to collect app name, short name, prefix, and description, then generates all template files.

**Usage:**
```bash
npx stellar-drive install pwa
```

**What it generates:**
- `package.json` with all required dependencies and dev tooling
- `vite.config.ts` with `stellarPWA` plugin configured
- `tsconfig.json` and `svelte.config.js`
- `static/manifest.json` for PWA installation
- `src/app.d.ts` for SvelteKit type declarations
- SvelteKit routes: root layout, login page, setup wizard, confirm page
- API endpoints: `/api/config`, `/api/validate`, `/api/deploy`
- Schema file template at `src/lib/schema.ts`
- Husky pre-commit hook for lint/format/check

**Non-destructive** — skips any files that already exist, so it's safe to run in an existing project.

**Example:**
```bash
$ npx stellar-drive install pwa

┌  stellar-drive — install PWA
│
◆  App name?
│  My Cool App
│
◆  Short name (home screen)?
│  Cool
│
◆  Prefix (cache/storage keys)?
│  coolapp
│
◆  Description?
│  A cool offline-first app
│
◇  Installing dependencies...
◇  Writing template files...
◇  Initializing Husky...
│
└  Done! Created 34 files.
```

---

## Type Definitions

Import from `stellar-drive/types`. All exports are type-only (`export type`) and produce no runtime code.

### Core Types

#### `OperationType`

The four supported operation intents for the sync queue. Each intent carries different semantics during coalescing and push.

```ts
type OperationType = 'increment' | 'set' | 'create' | 'delete';
```

- `'increment'` — Add a numeric delta to a field (coalesceable: multiple deltas sum)
- `'set'` — Overwrite field(s) with new value(s) (coalesceable: later sets win)
- `'create'` — Insert a new entity (coalesceable: subsequent sets merge into the create payload)
- `'delete'` — Soft-delete an entity (a create + delete pair cancels both out entirely)

---

#### `SyncOperationItem`

A single intent-based sync operation stored in the IndexedDB `syncQueue` table. Uses the `operationType` field to preserve the intent so the coalescer can intelligently merge operations (e.g., 50 increment ops become one +50 instead of 50 separate server requests).

```ts
interface SyncOperationItem {
  /** Auto-increment primary key (assigned by IndexedDB). */
  id?: number;
  /** Supabase table name (e.g., "goals", "goal_lists"). */
  table: string;
  /** UUID of the entity being operated on. */
  entityId: string;
  /** The operation intent: 'increment', 'set', 'create', or 'delete'. */
  operationType: OperationType;
  /** Target field name — used by increment and single-field set operations. */
  field?: string;
  /** Payload — delta (increment), new value (set), full entity (create), or unused (delete). */
  value?: unknown;
  /** ISO 8601 timestamp of when the operation was enqueued locally. */
  timestamp: string;
  /** Number of failed push attempts (drives exponential backoff). */
  retries: number;
  /** ISO 8601 timestamp of the last retry attempt (used for backoff calculation). */
  lastRetryAt?: string;
}
```

**Usage:** You don't create these directly — they are generated by `engineCreate()`, `engineUpdate()`, `engineIncrement()`, and `engineDelete()`. Access via `getQueueDiagnostics()` for debugging.

---

#### `SyncStatus`

Current state of the sync engine's background loop.

```ts
type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';
```

- `'idle'` — No active sync; everything is up to date
- `'syncing'` — Push or pull currently in progress
- `'error'` — Last sync attempt failed (will retry)
- `'offline'` — Device has no network connectivity

**Usage:** Subscribe to `syncStatusStore` to reactively display sync state in your UI.

---

#### `AuthMode`

Authentication mode for the engine. Determines how the engine handles data access, sync, and user identity.

```ts
type AuthMode = 'supabase' | 'offline' | 'demo' | 'none';
```

- `'supabase'` — Standard Supabase email/password or OAuth auth
- `'offline'` — Using cached credentials (device is offline)
- `'demo'` — Demo mode with sandboxed DB and mock data (no real auth)
- `'none'` — No active authentication

**Usage:** Returned by `resolveAuthState()` and available in layout load data as `data.authMode`.

---

#### `ConflictHistoryEntry`

A single field-level conflict resolution record stored in IndexedDB. Recorded whenever the conflict resolution engine detects divergent values for the same field across devices. Entries are retained for 30 days.

```ts
interface ConflictHistoryEntry {
  id?: number;
  /** UUID of the conflicting entity. */
  entityId: string;
  /** Supabase table name (e.g., "goals"). */
  entityType: string;
  /** Field that had conflicting values. */
  field: string;
  /** Value from the local device. */
  localValue: unknown;
  /** Value from the remote server. */
  remoteValue: unknown;
  /** Final merged value written to IndexedDB. */
  resolvedValue: unknown;
  /** Which side's value was chosen (or 'merged' for numeric merges). */
  winner: 'local' | 'remote' | 'merged';
  /** The strategy that resolved this conflict (e.g., 'last_write', 'delete_wins'). */
  strategy: string;
  /** ISO 8601 timestamp of resolution. */
  timestamp: string;
}
```

**Usage:** Access via `getConflictDiagnostics()` or `getDiagnostics()` to review conflict history.

---

#### `AppConfig`

Runtime configuration shape stored in IndexedDB and loaded by `initConfig()`. Contains the Supabase connection credentials and a flag indicating whether the app has been configured.

```ts
interface AppConfig {
  /** The Supabase project URL. */
  supabaseUrl: string;
  /** The Supabase publishable key for client-side access. */
  supabasePublishableKey: string;
  /** Whether the app has been configured with valid Supabase credentials. */
  configured: boolean;
}
```

**Usage:** Returned by `getConfig()` and set by `setConfig()` or `initConfig()`.

---

### Auth Types

#### `AuthConfig`

Flat authentication configuration for `initEngine()`. All fields are optional with sensible defaults. The engine internally normalizes this flat config to the existing nested structure so all auth subsystem code works unchanged.

```ts
interface AuthConfig {
  /** Gate type: 'code' (numeric PIN) or 'password'. @default 'code' */
  gateType?: SingleUserGateType;
  /** Digit count for code gates. @default 6 */
  codeLength?: 4 | 6;
  /** Whether signup requires email confirmation. @default true */
  emailConfirmation?: boolean;
  /** Whether untrusted devices require email OTP verification. @default true */
  deviceVerification?: boolean;
  /** Days before a trusted device must re-verify. @default 90 */
  trustDurationDays?: number;
  /** Path to redirect to after email confirmation. @default '/confirm' */
  confirmRedirectPath?: string;
  /** Enable offline credential caching and offline sign-in. @default true */
  enableOfflineAuth?: boolean;
  /** How often to re-validate the Supabase session (ms). @default 3600000 */
  sessionValidationIntervalMs?: number;
  /** Extract app-specific profile fields from Supabase user_metadata. */
  profileExtractor?: (userMetadata: Record<string, unknown>) => Record<string, unknown>;
  /** Convert app-specific profile back to Supabase user_metadata shape. */
  profileToMetadata?: (profile: Record<string, unknown>) => Record<string, unknown>;
}
```

**Usage:** Pass to `initEngine({ auth: { ... } })` in your `+layout.ts`.

---

#### `AuthStateResult`

Result of `resolveAuthState()`. Contains the current auth session, mode, offline profile (if applicable), and whether the server has been configured with Supabase credentials.

```ts
interface AuthStateResult {
  /** The Supabase session (null if not authenticated via Supabase). */
  session: Session | null;
  /** The current authentication mode. */
  authMode: AuthMode;
  /** Offline profile data (present when authMode is 'offline'). */
  offlineProfile: Record<string, unknown> | null;
  /** Whether the server has Supabase credentials configured. */
  serverConfigured: boolean;
}
```

**Usage:** Returned by layout load functions (`resolveRootLayout()`) and consumed in `+layout.svelte`.

---

#### `SingleUserConfig`

Persistent configuration for single-user mode, stored in IndexedDB. Single-user mode replaces traditional email/password sign-in with a simplified local gate (PIN or password). Under the hood it still uses a real Supabase account — the PIN is padded and used as the account password.

```ts
interface SingleUserConfig {
  /** Singleton key — always 'config'. */
  id: string;
  /** Whether the gate is a numeric code or a freeform password. */
  gateType: SingleUserGateType;
  /** Digit count for code gates (4 or 6). Only set when gateType === 'code'. */
  codeLength?: 4 | 6;
  /** SHA-256 hash of the code/password. */
  gateHash?: string;
  /** Email address used for the underlying Supabase account. */
  email?: string;
  /** App-specific profile data (e.g., { firstName, lastName }). */
  profile: Record<string, unknown>;
  /** Supabase user UUID (set after first successful online setup). */
  supabaseUserId?: string;
  /** ISO 8601 timestamp of initial setup. */
  setupAt: string;
  /** ISO 8601 timestamp of last configuration change. */
  updatedAt: string;
}
```

**Usage:** Managed internally by the single-user auth functions (`completeSingleUserSetup`, `lockSingleUser`, `changeSingleUserGate`).

---

#### `SingleUserGateType`

The type of gate protecting single-user mode.

```ts
type SingleUserGateType = 'code' | 'password';
```

- `'code'` — Numeric PIN (4 or 6 digits)
- `'password'` — Freeform password string

---

#### `TrustedDevice`

A trusted device record stored in the Supabase `trusted_devices` table. When device verification is enabled, untrusted devices must complete an email OTP challenge before they can access data. Once verified, the device is trusted for a configurable duration (default: 90 days).

```ts
interface TrustedDevice {
  /** Row UUID (primary key in Supabase). */
  id: string;
  /** Supabase user UUID who owns this device. */
  userId: string;
  /** Stable device identifier from localStorage. */
  deviceId: string;
  /** Human-readable device label (e.g., browser + OS). */
  deviceLabel?: string;
  /** App prefix for multi-tenant isolation (e.g., 'stellar', 'infinite'). */
  appPrefix: string;
  /** ISO 8601 timestamp of when the device was first trusted. */
  trustedAt: string;
  /** ISO 8601 timestamp of the device's most recent use. */
  lastUsedAt: string;
}
```

**Usage:** Returned by `getTrustedDevices()`. Managed by `trustCurrentDevice()`, `trustPendingDevice()`, and `removeTrustedDevice()`.

---

#### `OfflineCredentials`

Cached credentials stored in IndexedDB for offline sign-in. Uses a singleton pattern (`id: 'current_user'`) so only one set of credentials is cached at a time. The password is stored as a SHA-256 hash.

```ts
interface OfflineCredentials {
  /** Singleton key — always 'current_user'. */
  id: string;
  /** Supabase user UUID. */
  userId: string;
  /** User's email address. */
  email: string;
  /** SHA-256 hash of the user's password. */
  password: string;
  /** App-specific profile data. */
  profile: Record<string, unknown>;
  /** ISO 8601 timestamp of when credentials were cached. */
  cachedAt: string;
}
```

**Usage:** Managed internally by the offline auth system. Cached on successful online login, consumed during offline sign-in.

---

#### `OfflineSession`

Offline session token stored in IndexedDB. Created when the device goes offline (if credentials are cached) and consumed during offline sign-in to verify the user's identity without a network call. Sessions have no expiry — revoked only on successful online re-authentication or explicit logout.

```ts
interface OfflineSession {
  /** Singleton key — always 'current_session'. */
  id: string;
  /** Supabase user UUID. */
  userId: string;
  /** Random UUID used as the offline session token. */
  offlineToken: string;
  /** ISO 8601 timestamp of session creation. */
  createdAt: string;
}
```

---

### Schema Types

#### `SchemaDefinition`

Declarative schema definition for the sync engine. Each key is a Supabase table name (snake_case), and the value is either a string of Dexie indexes or a `SchemaTableConfig` object for full control. The engine auto-generates `TableConfig[]`, Dexie stores, database versioning, SQL migration, and TypeScript interfaces from this single declaration.

```ts
type SchemaDefinition = Record<string, string | SchemaTableConfig>;
```

**Usage:**
```ts
const schema: SchemaDefinition = {
  goals: 'goal_list_id, order',           // string shorthand — just indexes
  goal_lists: { indexes: 'order' },        // object form
  focus_settings: { singleton: true },     // single row per user
  projects: {
    indexes: 'is_current, order',
    fields: { name: 'string', type: ['work', 'personal'] },
    sqlColumns: { name: 'text not null' }
  }
};
```

---

#### `SchemaTableConfig`

Per-table configuration when using the object form of `SchemaDefinition`. The string form (`'goal_list_id, order'`) is sugar for `{ indexes: 'goal_list_id, order' }`.

```ts
interface SchemaTableConfig {
  /** App-specific Dexie indexes (system indexes auto-appended). @default '' */
  indexes?: string;
  /** Single row per user (e.g., user settings). @default false */
  singleton?: boolean;
  /** Row ownership config for RLS policy generation. @default 'user_id' */
  ownership?: string | { parent: string; fk: string };
  /** Explicit Supabase SELECT columns (egress optimization). @default '*' */
  columns?: string;
  /** Override auto-generated camelCase Dexie table name. */
  dexieName?: string;
  /** Fields to skip during conflict resolution. */
  excludeFromConflict?: string[];
  /** Numeric fields that attempt additive merge during conflicts. */
  numericMergeFields?: string[];
  /** Callback when remote change arrives for this table. */
  onRemoteChange?: (table: string, record: Record<string, unknown>) => void;
  /** Explicit SQL column types for generateSupabaseSQL(). Overrides type inference. */
  sqlColumns?: Record<string, string>;
  /** Declarative field definitions for TypeScript + SQL generation. */
  fields?: Record<string, FieldType>;
  /** Override the auto-generated PascalCase interface name. */
  typeName?: string;
}
```

---

#### `FieldType`

Declares a column's type in the schema `fields` map. Supports string shorthands, enum arrays, and full enum objects.

```ts
type FieldType =
  | string                                        // 'string', 'number?', 'uuid', 'boolean', 'date', 'timestamp', 'json'
  | string[]                                      // ['a', 'b', 'c'] → union type
  | { enum: string[]; nullable?: boolean; enumName?: string };  // full control
```

- **String shorthand:** `'string'`, `'number?'`, `'uuid'`, `'boolean'`, `'date'`, `'timestamp'`, `'json'`. Append `?` for nullable (e.g., `'string?'` → `string | null` / `text`).
- **Enum array:** `['a', 'b', 'c']` → union type `'a' | 'b' | 'c'` / SQL `text not null`.
- **Enum object:** `{ enum: ['a', 'b'], nullable: true, enumName: 'MyType' }` — full control over nullability and TypeScript type name.

---

#### `SQLGenerationOptions`

Options for `generateSupabaseSQL()`. Controls which tables and features are included in the generated SQL.

```ts
interface SQLGenerationOptions {
  /** Application name for SQL comments. */
  appName?: string;
  /** Table name prefix for multi-tenant setups. */
  prefix?: string;
  /** Include crdt_documents table. @default false */
  includeCRDT?: boolean;
  /** Include trusted_devices table. @default true */
  includeDeviceVerification?: boolean;
  /** Include trigger helper functions. @default true */
  includeHelperFunctions?: boolean;
  /** Storage buckets to create with RLS policies. */
  storage?: { buckets: StorageBucketConfig[] };
}
```

---

#### `StorageBucketConfig`

Supabase Storage bucket configuration for SQL generation. Each bucket generates `CREATE` + RLS policy statements.

```ts
interface StorageBucketConfig {
  /** Bucket name (e.g., 'avatars'). */
  name: string;
  /** Whether the bucket is publicly accessible. */
  public: boolean;
  /** Maximum file size in bytes. */
  maxFileSize?: number;
  /** Allowed MIME types (e.g., ['image/png', 'image/jpeg']). */
  allowedMimeTypes?: string[];
}
```

---

### Store Types

#### `CollectionStore<T>`

A Svelte-compatible reactive store for a collection of entities. Provides `subscribe` for reactivity, `loading` state, and methods to load, refresh, and mutate the collection.

```ts
interface CollectionStore<T> {
  subscribe: (fn: (value: T[]) => void) => () => void;
  loading: boolean;
  load(): Promise<void>;
  refresh(): Promise<void>;
  set(items: T[]): void;
  mutate(fn: (items: T[]) => T[]): void;
}
```

**Usage:** Created by `createCollectionStore({ load: async () => [...] })`. Use `$store` syntax in Svelte templates.

---

#### `CollectionStoreConfig<T>`

Configuration for `createCollectionStore()`.

```ts
interface CollectionStoreConfig<T> {
  /** Async function that returns the collection data. */
  load: () => Promise<T[]>;
}
```

---

#### `DetailStore<T>`

A Svelte-compatible reactive store for a single entity detail view. Provides `subscribe`, `loading`, and methods to load by ID, clear, and mutate.

```ts
interface DetailStore<T> {
  subscribe: (fn: (value: T | null) => void) => () => void;
  loading: boolean;
  load(id: string): Promise<void>;
  clear(): void;
  set(item: T | null): void;
  mutate(fn: (item: T | null) => T | null): void;
}
```

**Usage:** Created by `createDetailStore({ load: async (id) => {...} })`.

---

#### `DetailStoreConfig<T>`

Configuration for `createDetailStore()`.

```ts
interface DetailStoreConfig<T> {
  /** Async function that returns the entity data for a given ID. */
  load: (id: string) => Promise<T | null>;
}
```

---

#### `CrudCollectionStore<T>`

A collection store with built-in CRUD operations that automatically enqueue sync operations and update IndexedDB.

```ts
interface CrudCollectionStore<T> extends CollectionStore<T> {
  create(entity: Partial<T>): Promise<string>;
  update(id: string, fields: Partial<T>): Promise<void>;
  remove(id: string): Promise<void>;
  reorder(items: T[]): Promise<void>;
}
```

**Usage:** Created by `createCrudCollectionStore({ table: 'tasks', load: async () => [...] })`.

---

#### `CrudCollectionStoreConfig<T>`

Configuration for `createCrudCollectionStore()`.

```ts
interface CrudCollectionStoreConfig<T> {
  /** The Supabase table name for sync operations. */
  table: string;
  /** Async function that returns the collection data. */
  load: () => Promise<T[]>;
}
```

---

### CRDT Types

#### `CRDTConfig`

Configuration for the CRDT collaborative editing subsystem. All fields are optional with sensible defaults.

```ts
interface CRDTConfig {
  /** Supabase table name for CRDT document storage. @default 'crdt_documents' */
  supabaseTable?: string;
  /** How often to persist dirty documents to Supabase (ms). @default 30000 */
  persistIntervalMs?: number;
  /** Debounce for broadcasting Yjs updates to peers (ms). @default 100 */
  broadcastDebounceMs?: number;
  /** Debounce for local IndexedDB full-state saves (ms). @default 5000 */
  localSaveDebounceMs?: number;
  /** Debounce for cursor/presence updates (ms). @default 50 */
  cursorDebounceMs?: number;
  /** Maximum documents stored for offline access. @default 50 */
  maxOfflineDocuments?: number;
  /** Maximum Broadcast payload size in bytes. @default 256000 */
  maxBroadcastPayloadBytes?: number;
}
```

**Usage:** Pass to `initEngine({ crdt: { ... } })`.

---

#### `CRDTProvider`

Public interface for a CRDT document provider. Returned by `openDocument()`. Provides access to the Yjs document instance and metadata.

```ts
interface CRDTProvider {
  /** The Yjs document instance — use with your editor. */
  readonly doc: YDoc;
  /** Unique document identifier. */
  readonly documentId: string;
  /** The page/entity this document belongs to. */
  readonly pageId: string;
  /** Current Broadcast channel connection state. */
  readonly connectionState: CRDTConnectionState;
  /** Whether the document has unsaved changes. */
  readonly isDirty: boolean;
  /** Resolves when network sync (channel join + sync protocol) completes. */
  readonly networkReady: Promise<void>;
  /** Destroy this provider and release all resources. */
  destroy(): Promise<void>;
}
```

**Usage:** Returned by `openDocument()`. Pass `provider.doc` to your editor's collaboration extension.

---

#### `OpenDocumentOptions`

Options for `openDocument()`.

```ts
interface OpenDocumentOptions {
  /** Whether this document should be persisted to IndexedDB for offline access. @default false */
  offlineEnabled?: boolean;
  /** Initial presence info for awareness tracking. */
  initialPresence?: {
    name: string;
    avatarUrl?: string;
  };
}
```

---

#### `UserPresenceState`

Per-user cursor/presence state for awareness tracking. Represents a remote collaborator's current position and identity within a document.

```ts
interface UserPresenceState {
  /** Supabase user UUID. */
  userId: string;
  /** Stable device identifier. */
  deviceId: string;
  /** Display name (from initialPresence). */
  name: string;
  /** Deterministically assigned hex color. */
  color: string;
  /** Editor-specific cursor position (opaque to the engine). */
  cursor?: unknown;
  /** Editor-specific selection range (opaque to the engine). */
  selection?: unknown;
  /** ISO 8601 timestamp of last activity. */
  lastActiveAt: string;
}
```

**Usage:** Returned by `getCollaborators()` and passed to `onCollaboratorsChange()` callbacks.

---

### Diagnostics Types

#### `DiagnosticsSnapshot`

Complete engine diagnostics snapshot returned by `getDiagnostics()`. Contains every observable aspect of the sync engine's runtime state, structured into logical sections. See the `getDiagnostics()` documentation for the full nested structure.

```ts
interface DiagnosticsSnapshot {
  timestamp: string;
  prefix: string;
  deviceId: string;
  sync: { status, totalCycles, lastSyncTime, recentCycles, ... };
  egress: { totalBytes, totalFormatted, byTable, ... };
  queue: { pendingOperations, pendingEntityIds, byTable, ... };
  realtime: { connectionState, healthy, reconnectAttempts, ... };
  network: { online };
  engine: { isTabVisible, lockHeld, wasOffline, ... };
  conflicts: { recentHistory, totalCount };
  crdt: { enabled, activeDocuments, offline, pendingUpdates, ... };
  errors: { lastError, lastErrorDetails, recentErrors };
  config: { tableCount, tableNames, syncDebounceMs, ... };
}
```

**Usage:** Returned by `getDiagnostics()`. Log as JSON for debugging, or display in a diagnostics dashboard.

---

### Third-Party Re-exports

These types are re-exported from `stellar-drive/types` so consumers don't need to install the source packages directly.

#### `Session`

Supabase auth session object. Contains the access token, refresh token, user object, and expiry information. Re-exported from `@supabase/supabase-js`.

**Usage:** The `session` field in `AuthStateResult` and the parameter to `setSupabaseAuth()` in the auth state store.

---

#### `SupabaseClient`

The Supabase client type for database queries, auth, storage, and realtime operations. Re-exported from `@supabase/supabase-js`.

**Usage:** The type of the `supabase` singleton export and the return type of `createServerSupabaseClient()`.
