# Stellar Engine API Reference

Complete reference for all public exports from `stellar-drive`.

### Subpath Exports

| Subpath | Contents |
|---|---|
| `stellar-drive` | `initEngine`, `startSyncEngine`, `runFullSync`, `supabase`, `getDb`, `resetDatabase`, `validateSupabaseCredentials` |
| `stellar-drive/data` | CRUD + query operations + query/repo helpers |
| `stellar-drive/auth` | Authentication functions, display utilities (`resolveFirstName`, `resolveUserId`, `resolveAvatarInitial`) |
| `stellar-drive/stores` | Reactive stores + event subscriptions + store factories |
| `stellar-drive/types` | All type exports (including `Session` from Supabase) |
| `stellar-drive/utils` | Utility functions + debug + diagnostics + SQL generation |
| `stellar-drive/actions` | Svelte `use:` actions |
| `stellar-drive/config` | Runtime config (`initConfig`, `getConfig`, `setConfig`) |
| `stellar-drive/vite` | Vite plugin (`stellarPWA`) for service worker builds, schema auto-generation, and asset manifests |
| `stellar-drive/kit` | SvelteKit route helpers, server APIs, load functions, email confirmation, auth hydration |
| `stellar-drive/crdt` | CRDT collaborative editing (document lifecycle, shared types, presence, offline) |

All exports are also available from the root `stellar-drive` barrel export.

---

## Table of Contents

- [Engine Configuration](#engine-configuration)
- [Database Access](#database-access)
- [Engine Lifecycle](#engine-lifecycle)
- [Credential Validation](#credential-validation)
- [CRUD Operations](#crud-operations)
- [Query Operations](#query-operations)
- [Query Helpers](#query-helpers)
- [Repository Helpers](#repository-helpers)
- [Store Factories](#store-factories)
- [Authentication Core](#authentication-core)
- [Auth State Resolution](#auth-state-resolution)
- [Auth Display Utilities](#auth-display-utilities)
- [Single-User Auth](#single-user-auth)
- [Device Verification](#device-verification)
- [Reactive Stores](#reactive-stores)
- [Realtime](#realtime)
- [Supabase Client](#supabase-client)
- [Runtime Configuration](#runtime-configuration)
- [Diagnostics](#diagnostics)
- [Debug](#debug)
- [Utilities](#utilities)
- [SQL and TypeScript Generation](#sql-and-typescript-generation)
- [Svelte Actions](#svelte-actions)
- [SvelteKit Helpers](#sveltekit-helpers)
- [Demo Mode](#demo-mode)
- [CRDT Collaborative Editing](#crdt-collaborative-editing)
- [Types](#types)
- [Vite Plugin](#vite-plugin-stellarpwa)
- [CLI Commands](#cli-commands)
- [Re-exports](#re-exports)

---

## Engine Configuration

### `initEngine(config)`

Initialize the sync engine. Must be called once at app startup before any other engine function. Bootstraps the database, propagates the prefix to all internal modules, and optionally sets up authentication, demo mode, and CRDT subsystems.

The engine supports two configuration modes:
1. **Schema-driven** (recommended) -- Provide a `schema` object. The engine auto-generates `tables`, Dexie stores, versioning, and database naming.
2. **Manual** -- Provide explicit `tables` and `database` for full control over IndexedDB versioning.

```ts
function initEngine(config: InitEngineInput): void
```

**Example (schema-driven with flat auth):**

```ts
import { initEngine } from 'stellar-drive';

initEngine({
  prefix: 'myapp',
  schema: {
    tasks: 'project_id, order',
    projects: 'is_current, order',
    user_settings: { singleton: true },
  },
  auth: { gateType: 'code', codeLength: 6 },
});
```

**Example (manual):**

```ts
initEngine({
  prefix: 'myapp',
  tables: [
    {
      supabaseName: 'tasks',
      columns: 'id, user_id, name, completed, order, deleted, created_at, updated_at',
    },
  ],
  database: {
    name: 'myapp-db',
    versions: [{ version: 1, stores: { tasks: 'id, user_id, order' } }],
  },
});
```

### `InitEngineInput`

The input type for `initEngine()`. Differs from `SyncEngineConfig` in two ways:

- `tables` is optional (auto-generated when `schema` is provided).
- `auth` accepts either the flat `AuthConfig` format or the legacy nested format.

When using the `schema` field, do not pass `tables` or `database` -- they are mutually exclusive with `schema`.

### `SyncEngineConfig`

Full engine configuration shape (the internal, normalized form after `initEngine` processes the input).

| Field | Type | Default | Description |
|---|---|---|---|
| `prefix` | `string` | *required* | App prefix for localStorage keys, debug logging, and multi-tenant table name prefixing. When set, all app tables are prefixed (e.g., `stellar_goals`). Shared tables (`trusted_devices`, `crdt_documents`) remain unprefixed. |
| `schema` | `SchemaDefinition` | -- | Declarative schema (replaces `tables` + `database`). |
| `tables` | `TableConfig[]` | -- | Per-table sync config. Auto-populated when using `schema`. |
| `database` | `DatabaseConfig` | -- | Dexie database config. Auto-populated when using `schema`. |
| `databaseName` | `string` | `${prefix}DB` | Override auto-generated DB name when using `schema`. |
| `db` | `Dexie` | -- | Pre-created Dexie instance (backward compat). |
| `supabase` | `SupabaseClient` | -- | Pre-created Supabase client (backward compat). |
| `auth` | `AuthConfig \| nested` | -- | Authentication configuration. See `AuthConfig` below. |
| `syncDebounceMs` | `number` | `2000` | Delay (ms) after a local write before pushing. |
| `syncIntervalMs` | `number` | `900000` | Background polling sync interval (ms). 15 minutes. |
| `tombstoneMaxAgeDays` | `number` | `7` | Days to keep soft-deleted tombstones. |
| `visibilitySyncMinAwayMs` | `number` | `300000` | Min hidden time (ms) before visibility sync triggers. |
| `onlineReconnectCooldownMs` | `number` | `120000` | Min time (ms) between online-reconnect syncs. |
| `onAuthStateChange` | `(event, session) => void` | -- | Callback for Supabase auth state changes. |
| `onAuthKicked` | `(message) => void` | -- | Callback when user is forcibly signed out. |
| `demo` | `DemoConfig` | -- | Demo mode config (sandboxed DB, mock data). |
| `crdt` | `CRDTConfig \| true` | -- | CRDT config. Pass `true` for all defaults. |

### `AuthConfig`

The flat authentication configuration format. All fields are optional with sensible defaults. The engine normalizes this to an internal nested structure.

```ts
interface AuthConfig {
  gateType?: 'code' | 'password';              // Default: 'code'
  codeLength?: 4 | 6;                          // Default: 6
  emailConfirmation?: boolean;                  // Default: true
  deviceVerification?: boolean;                 // Default: true
  trustDurationDays?: number;                   // Default: 90
  confirmRedirectPath?: string;                 // Default: '/confirm'
  enableOfflineAuth?: boolean;                  // Default: true
  sessionValidationIntervalMs?: number;         // Default: 3600000 (1 hour)
  profileExtractor?: (userMetadata: Record<string, unknown>) => Record<string, unknown>;
  profileToMetadata?: (profile: Record<string, unknown>) => Record<string, unknown>;
}
```

**Example:**

```ts
initEngine({
  prefix: 'myapp',
  schema: { /* ... */ },
  auth: {
    gateType: 'code',
    codeLength: 6,
    emailConfirmation: true,
    deviceVerification: true,
    trustDurationDays: 90,
    confirmRedirectPath: '/confirm',
    enableOfflineAuth: true,
    profileExtractor: (meta) => ({ firstName: meta.first_name }),
    profileToMetadata: (p) => ({ first_name: p.firstName }),
  },
});
```

The legacy nested format (with `singleUser: { ... }`) is still accepted for backward compatibility. When a `singleUser` key is detected, the config is passed through as-is.

### `TableConfig`

Per-table sync configuration. Each entry describes one Supabase table and how it maps to the local IndexedDB store.

```ts
interface TableConfig {
  supabaseName: string;                        // Actual (prefixed) Supabase table name (e.g., 'stellar_goals')
  schemaKey?: string;                          // Raw schema key (unprefixed, e.g., 'goals'). Used for Dexie table name derivation and consumer-facing API lookups.
  columns: string;                             // Supabase SELECT columns (egress optimization)
  ownershipFilter?: string;                    // Column for RLS ownership filtering (undefined for child tables)
  isSingleton?: boolean;                       // One record per user (e.g., user settings)
  excludeFromConflict?: string[];              // Fields to skip during conflict resolution
  numericMergeFields?: string[];               // Fields that use additive merge for conflicts
  onRemoteChange?: (table: string, record: Record<string, unknown>) => void;
}
```

The Dexie (IndexedDB) table name is automatically derived from `schemaKey` (or `supabaseName` if no prefix) via `snakeToCamel()` conversion. For example, `schemaKey: 'goal_lists'` produces the Dexie table name `goalLists`.

### `SchemaDefinition`

```ts
type SchemaDefinition = Record<string, string | SchemaTableConfig>;
```

Each key is a Supabase table name (snake_case). Values are either a string of app-specific Dexie indexes (system indexes are auto-appended) or a `SchemaTableConfig` object for full control.

```ts
const schema: SchemaDefinition = {
  goal_lists: 'project_id, order',                              // string shorthand (has user_id)
  goals: {                                                      // child table (no user_id)
    indexes: 'goal_list_id, order',
    ownership: { parent: 'goal_lists', fk: 'goal_list_id' },
    fields: { goal_list_id: 'uuid', name: 'string', order: 'number' }
  },
  focus_settings: { singleton: true },                          // singleton (one per user)
  projects: 'is_current, order',
};
```

### `SchemaTableConfig`

Per-table configuration when using the object form of `SchemaDefinition`.

| Field | Type | Default | Description |
|---|---|---|---|
| `indexes` | `string` | `''` | App-specific Dexie indexes (system indexes auto-appended). |
| `singleton` | `boolean` | `false` | Single row per user (e.g., user settings). |
| `ownership` | `string \| { parent, fk }` | `'user_id'` | Row ownership for RLS. String overrides the ownership column name. Object form `{ parent: 'parent_table', fk: 'fk_column' }` marks a child table — no `user_id` column is added, and RLS policies filter via the parent FK. |
| `columns` | `string` | `'*'` | Explicit Supabase SELECT columns. |
| `dexieName` | `string` | auto | Override auto-generated camelCase Dexie table name. |
| `excludeFromConflict` | `string[]` | -- | Fields to skip during conflict resolution. |
| `numericMergeFields` | `string[]` | -- | Fields that attempt additive merge during conflicts. |
| `onRemoteChange` | `function` | -- | Callback when remote change arrives for this table. |
| `sqlColumns` | `Record<string, string>` | -- | Explicit SQL column types for `generateSupabaseSQL()`. |
| `fields` | `Record<string, FieldType>` | -- | Declarative field definitions for TypeScript + SQL generation. |
| `typeName` | `string` | auto | Override auto-generated PascalCase interface name. |
| `renamedFrom` | `string` | -- | Previous table name for one-time rename migration. |
| `renamedColumns` | `Record<string, string>` | -- | Column renames as `{ newName: oldName }`. |

---

## Database Access

### `getDb()`

Returns the Dexie (IndexedDB) database instance. Use for advanced queries not covered by the CRUD layer.

```ts
function getDb(): Dexie
```

Throws if `initEngine()` has not been called.

### `resetDatabase()`

Deletes and recreates the local IndexedDB database. Data is recovered on the next sync cycle via hydration from Supabase.

```ts
function resetDatabase(): Promise<void>
```

### `SYSTEM_INDEXES`

Constant string of Dexie indexes automatically appended to every app table when using the schema-driven API:

```ts
const SYSTEM_INDEXES = 'id, user_id, created_at, updated_at, deleted, _version';
```

### `computeSchemaVersion(prefix, stores)`

Computes an auto-version number based on a hash of the merged store schema. Used internally by the schema-driven API to detect schema changes and bump the database version.

```ts
function computeSchemaVersion(
  prefix: string,
  stores: Record<string, string>
): SchemaVersionResult
```

### `DatabaseConfig`

```ts
interface DatabaseConfig {
  name: string;                              // IndexedDB database name
  versions: DatabaseVersionConfig[];         // Ordered version declarations
}
```

### `DatabaseVersionConfig`

```ts
interface DatabaseVersionConfig {
  version: number;                           // Positive integer, monotonically increasing
  stores: Record<string, string>;            // App table schemas (Dexie index syntax)
  upgrade?: (tx: Transaction) => Promise<void>;  // Optional data migration callback
}
```

---

## Engine Lifecycle

### `startSyncEngine()`

Begins periodic background sync and realtime subscription after the engine has been initialized. Call this after resolving auth state to start syncing data.

```ts
function startSyncEngine(): Promise<void>
```

### `runFullSync()`

Triggers an immediate full sync cycle (push + pull). Useful for force-refreshing data.

```ts
function runFullSync(): Promise<void>
```

### `onSyncComplete(callback)`

Registers a callback that fires after each successful sync cycle. Returns an unsubscribe function.

```ts
function onSyncComplete(callback: () => void | Promise<void>): () => void
```

**Example:**

```ts
const unsub = onSyncComplete(async () => {
  console.log('Sync finished, refreshing UI...');
});
// Later: unsub();
```

---

## Credential Validation

### `validateSupabaseCredentials(url, publishableKey)`

Server-side utility that tests whether the provided Supabase URL and publishable key can successfully connect.

```ts
function validateSupabaseCredentials(
  url: string,
  publishableKey: string
): Promise<{ valid: boolean; error?: string }>
```

### `validateSchema(url, publishableKey, schema)`

Verifies that the required database tables and columns exist in the connected Supabase project.

```ts
function validateSchema(
  url: string,
  publishableKey: string,
  schema: SchemaDefinition
): Promise<{ valid: boolean; errors?: string[] }>
```

---

## CRUD Operations

All CRUD functions reference tables by their **consumer-facing schema key** (the unprefixed snake_case name, e.g., `'goals'`). The engine automatically resolves this to the actual prefixed Supabase table name (e.g., `'stellar_goals'`) and the corresponding Dexie (IndexedDB) table name. All writes are transactional: the local mutation and sync queue entry are committed atomically.

### `engineCreate(table, data)`

Create a new entity in the local store and enqueue it for remote sync. If `data.id` is omitted, a UUID is generated automatically.

```ts
function engineCreate(
  table: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>>
```

**Example:**

```ts
const task = await engineCreate('tasks', {
  title: 'Write docs',
  user_id: currentUserId,
  created_at: now(),
  updated_at: now(),
});
console.log(task.id); // auto-generated UUID
```

### `engineUpdate(table, id, fields)`

Update specific fields on an existing entity. Automatically sets `updated_at`.

```ts
function engineUpdate(
  table: string,
  id: string,
  fields: Record<string, unknown>
): Promise<Record<string, unknown> | undefined>
```

Returns `undefined` if the entity was not found.

### `engineDelete(table, id)`

Soft-delete an entity by setting `deleted: true`. The entity remains locally until a future compaction.

```ts
function engineDelete(table: string, id: string): Promise<void>
```

### `engineBatchWrite(operations)`

Execute multiple write operations in a single atomic Dexie transaction. All operations share a single `updated_at` timestamp.

```ts
function engineBatchWrite(operations: BatchOperation[]): Promise<void>
```

**`BatchOperation` type:**

```ts
type BatchOperation =
  | { type: 'create'; table: string; data: Record<string, unknown> }
  | { type: 'update'; table: string; id: string; fields: Record<string, unknown> }
  | { type: 'delete'; table: string; id: string };
```

**Example:**

```ts
await engineBatchWrite([
  { type: 'create', table: 'tasks', data: { title: 'Subtask 1', parent_id: parentId } },
  { type: 'create', table: 'tasks', data: { title: 'Subtask 2', parent_id: parentId } },
  { type: 'update', table: 'projects', id: projectId, fields: { task_count: newCount } },
]);
```

### `engineIncrement(table, id, field, amount, additionalFields?)`

Atomically increment a numeric field. Preserves the increment intent in the sync queue for correct multi-device conflict resolution (additive merge instead of last-write-wins).

```ts
function engineIncrement(
  table: string,
  id: string,
  field: string,
  amount: number,
  additionalFields?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined>
```

**Example:**

```ts
const updated = await engineIncrement('tasks', taskId, 'focus_count', 1, {
  last_focused_at: now(),
});
```

---

## Query Operations

All query functions read from the local Dexie store first. An optional `remoteFallback` parameter can be used to fall back to Supabase when local data is missing (useful for first-load scenarios).

### `engineGet(table, id, opts?)`

Retrieve a single entity by primary key.

```ts
function engineGet(
  table: string,
  id: string,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown> | null>
```

### `engineGetAll(table, opts?)`

Retrieve all entities from a table with optional ordering.

```ts
function engineGetAll(
  table: string,
  opts?: { orderBy?: string; remoteFallback?: boolean }
): Promise<Record<string, unknown>[]>
```

Note: Does not filter out soft-deleted entities. Use `queryAll()` for filtered results.

### `engineQuery(table, index, value, opts?)`

Query entities by a single indexed field value (equivalent to `WHERE index = value`).

```ts
function engineQuery(
  table: string,
  index: string,
  value: unknown,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown>[]>
```

### `engineQueryRange(table, index, lower, upper, opts?)`

Query entities where an indexed field falls within an inclusive range (`BETWEEN lower AND upper`).

```ts
function engineQueryRange(
  table: string,
  index: string,
  lower: unknown,
  upper: unknown,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown>[]>
```

### `engineGetOrCreate(table, index, value, defaults, opts?)`

Retrieve an existing entity by index, or create one with defaults if none exists. Commonly used for per-user settings singletons.

```ts
function engineGetOrCreate(
  table: string,
  index: string,
  value: unknown,
  defaults: Record<string, unknown>,
  opts?: { checkRemote?: boolean }
): Promise<Record<string, unknown>>
```

Resolution order: local lookup, optional remote check, then local create.

**Example:**

```ts
const settings = await engineGetOrCreate(
  'focus_settings',
  'user_id',
  currentUserId,
  { user_id: currentUserId, pomodoro_minutes: 25 },
  { checkRemote: true },
);
```

---

## Query Helpers

Convenience wrappers that eliminate repetitive query patterns. Import from `stellar-drive/data`.

### `queryAll<T>(table, opts?)`

Fetch all non-deleted records from a table, sorted by `order`.

```ts
function queryAll<T>(
  table: string,
  opts?: { remoteFallback?: boolean; orderBy?: string; autoRemoteFallback?: boolean }
): Promise<T[]>
```

- `autoRemoteFallback` — Automatically falls back to Supabase when the engine hasn't completed hydration yet. Equivalent to `remoteFallback: !hasHydrated()`.

### `queryOne<T>(table, id, opts?)`

Fetch a single non-deleted record by ID, or `null`.

```ts
function queryOne<T>(
  table: string,
  id: string,
  opts?: { remoteFallback?: boolean; autoRemoteFallback?: boolean }
): Promise<T | null>
```

### `queryByIndex<T>(table, index, value, opts?)`

Query non-deleted records by an indexed field value, with optional `order` sorting.

```ts
function queryByIndex<T>(
  table: string,
  index: string,
  value: unknown,
  opts?: { remoteFallback?: boolean; autoRemoteFallback?: boolean; sortByOrder?: boolean }
): Promise<T[]>
```

- Filters out soft-deleted records automatically.
- `sortByOrder` — If `true`, sorts results by `order` ascending.

### `queryByRange<T>(table, index, lower, upper, opts?)`

Query non-deleted records within an inclusive range.

```ts
function queryByRange<T>(
  table: string,
  index: string,
  lower: unknown,
  upper: unknown,
  opts?: { remoteFallback?: boolean; autoRemoteFallback?: boolean; sortByOrder?: boolean }
): Promise<T[]>
```

- Filters out soft-deleted records automatically.
- `sortByOrder` — If `true`, sorts results by `order` ascending.

---

## Repository Helpers

### `reorderEntity<T>(table, id, newOrder)`

Update just the `order` field on any entity.

```ts
function reorderEntity<T>(
  table: string,
  id: string,
  newOrder: number
): Promise<T | undefined>
```

### `prependOrder(table, indexField, indexValue)`

Compute the next prepend-order value for inserting at the top of a list (returns `minOrder - 1`).

```ts
function prependOrder(
  table: string,
  indexField: string,
  indexValue: string
): Promise<number>
```

---

## Store Factories

Generic factory functions for creating Svelte-compatible reactive stores. Import from `stellar-drive/stores`.

### `createCollectionStore<T>(config)`

Creates a reactive store for a collection of entities with built-in loading state and sync-complete auto-refresh.

```ts
function createCollectionStore<T>(config: CollectionStoreConfig<T>): CollectionStore<T>

interface CollectionStoreConfig<T> {
  load: () => Promise<T[]>;
}

interface CollectionStore<T> {
  subscribe: (run: (value: T[]) => void) => () => void;
  loading: { subscribe: (run: (value: boolean) => void) => () => void };
  load(): Promise<void>;
  refresh(): Promise<void>;
  set(data: T[]): void;
  mutate(fn: (items: T[]) => T[]): void;
}
```

**Example:**

```ts
import { createCollectionStore } from 'stellar-drive/stores';
import { queryAll } from 'stellar-drive/data';

const store = createCollectionStore<Task>({
  load: () => queryAll<Task>('tasks'),
});

await store.load();
// $store is now Task[], $store.loading is boolean
```

### `createDetailStore<T>(config)`

Creates a reactive store for a single entity with loading state and ID tracking.

```ts
function createDetailStore<T>(config: DetailStoreConfig<T>): DetailStore<T>

interface DetailStoreConfig<T> {
  load: (id: string) => Promise<T | null>;
}

interface DetailStore<T> {
  subscribe: (run: (value: T | null) => void) => () => void;
  loading: { subscribe: (run: (value: boolean) => void) => () => void };
  load(id: string): Promise<void>;
  clear(): void;
  set(data: T | null): void;
  mutate(fn: (item: T | null) => T | null): void;
  getCurrentId(): string | null;
}
```

### `createCrudCollectionStore<T>(config)`

Creates a CRUD collection store with built-in create, update, delete, and reorder operations plus optimistic UI mutations. Extends `CollectionStore` with standard CRUD methods.

```ts
function createCrudCollectionStore<T>(config: CrudCollectionStoreConfig<T>): CrudCollectionStore<T>

interface CrudCollectionStoreConfig<T> {
  table: string;
  load: () => Promise<T[]>;
  orderIndexField?: string;
}

interface CrudCollectionStore<T> extends CollectionStore<T> {
  create(data: Partial<T>): Promise<T>;
  update(id: string, fields: Partial<T>): Promise<T | undefined>;
  delete(id: string): Promise<void>;
  reorder(id: string, newOrder: number): Promise<T | undefined>;
}
```

- `orderIndexField` — When set, `create()` auto-computes a prepend order relative to records matching this index field.
- `create()` auto-generates `id`, `created_at`, `updated_at`, and records a local change for animation tracking.
- All methods optimistically update the store for instant UI feedback.

---

## Authentication Core

Core auth utilities. Import from `stellar-drive/auth`.

### `signOut()`

Full sign-out with 10-step teardown: clears Supabase session, offline credentials, offline session, login guard, sync queue, auth stores, and resets the database.

```ts
function signOut(): Promise<void>
```

### `getValidSession()`

Returns the current Supabase session if valid, or `null`. Attempts session refresh if the access token is expired.

```ts
function getValidSession(): Promise<Session | null>
```

### `getUserProfile(user)`

Extract app-specific profile fields from a Supabase `User` object using the configured `profileExtractor`.

```ts
function getUserProfile(user: User): Record<string, unknown>
```

### `updateProfile(updates)`

Update user profile metadata on Supabase and in the offline credential cache.

```ts
function updateProfile(updates: Record<string, unknown>): Promise<void>
```

### `resendConfirmationEmail(email)`

Resend the email confirmation link.

```ts
function resendConfirmationEmail(email: string): Promise<{ error?: string }>
```

### `verifyOtp(tokenHash, type)`

Verify an OTP token hash from a confirmation link.

```ts
function verifyOtp(
  tokenHash: string,
  type: 'email' | 'signup'
): Promise<{ session: Session | null; error?: string }>
```

### `resetLoginGuard()`

Clears the transient login lock that prevents duplicate login attempts.

```ts
function resetLoginGuard(): void
```

---

## Auth State Resolution

### `resolveAuthState()`

Determines the user's authentication state during app initialization. Returns an `AuthStateResult` describing whether the user is authenticated and in which mode.

```ts
function resolveAuthState(): Promise<AuthStateResult>

interface AuthStateResult {
  session: Session | null;
  authMode: 'supabase' | 'offline' | 'demo' | 'none';
  offlineProfile: OfflineCredentials | null;
  serverConfigured?: boolean;
}
```

---

## Auth Display Utilities

Pure helper functions that resolve user-facing display values from the auth state, handling the full fallback chain across online and offline modes. Import from `stellar-drive/auth`.

### `resolveFirstName(session, offlineProfile, fallback?)`

Resolve the user's first name. Checks session profile, email username, offline profile, then falls back to the provided default (`'Explorer'`).

```ts
function resolveFirstName(
  session: Session | null,
  offlineProfile: OfflineCredentials | null,
  fallback?: string
): string
```

### `resolveUserId(session, offlineProfile)`

Resolve the user's UUID from session or offline cache.

```ts
function resolveUserId(
  session: Session | null,
  offlineProfile: OfflineCredentials | null
): string | null
```

### `resolveAvatarInitial(session, offlineProfile)`

Resolve a single uppercase letter for avatar circles.

```ts
function resolveAvatarInitial(
  session: Session | null,
  offlineProfile: OfflineCredentials | null
): string
```

---

## Single-User Auth

Full lifecycle for single-user (kiosk/personal device) PIN/password gate authentication. Import from `stellar-drive/auth`.

### Setup and Teardown

- **`isSingleUserSetUp()`** -- Returns `true` if the single-user gate has been configured.
- **`getSingleUserInfo()`** -- Returns the current `SingleUserConfig` or `null`.
- **`setupSingleUser(email, gate, profile)`** -- Initial setup: creates Supabase account, stores gate config.
- **`completeSingleUserSetup()`** -- Finishes setup after email confirmation.
- **`resetSingleUser()`** -- Full teardown of single-user config and Supabase account.
- **`resetSingleUserRemote()`** -- Resets remote single-user config in Supabase user metadata.

### Lock/Unlock

- **`unlockSingleUser(gate)`** -- Verify the PIN/password and sign in. Returns `{ success, error? }`.
- **`lockSingleUser()`** -- Lock the gate (sign out without full teardown).
- **`changeSingleUserGate(currentGate, newGateType, newGate)`** -- Change the PIN/password.

### Profile Management

- **`updateSingleUserProfile(updates)`** -- Update the user's profile fields.
- **`changeSingleUserEmail(newEmail, gate)`** -- Change the user's email address.
- **`completeSingleUserEmailChange()`** -- Complete email change after confirmation.

### Device Linking

- **`linkSingleUserDevice(email, gate)`** -- Link a new device to an existing account.
- **`fetchRemoteGateConfig()`** -- Fetch gate config from Supabase user metadata.
- **`completeDeviceVerification(tokenHash)`** -- Complete device verification from email link.
- **`pollDeviceVerification(email)`** -- Poll for pending device verification.

### Utility

- **`padPin(pin, targetLength)`** -- Pad a short PIN to meet Supabase minimum password length.

---

## Device Verification

Trust management for multi-device single-user setups. Import from the root or `stellar-drive`.

- **`isDeviceTrusted()`** -- Check if the current device is trusted.
- **`trustCurrentDevice()`** -- Mark the current device as trusted.
- **`trustPendingDevice(deviceId, deviceLabel)`** -- Trust a pending device.
- **`getTrustedDevices()`** -- List all trusted devices.
- **`removeTrustedDevice(deviceId)`** -- Revoke trust for a device.
- **`maskEmail(email)`** -- Partially mask an email for display during verification.
- **`sendDeviceVerification(email)`** -- Initiate the device verification email flow.
- **`getCurrentDeviceId()`** -- Get the current device's stable identifier.
- **`getDeviceLabel()`** -- Get a human-readable device label (browser + OS).

---

## Reactive Stores

Svelte-compatible stores providing real-time observability. Import from `stellar-drive/stores`.

### `syncStatusStore`

Tracks the sync engine's lifecycle state: whether it is idle, syncing, or in error; the number of pending local changes; the last error; the realtime connection state; and the timestamp of the last successful sync.

```ts
// $syncStatusStore shape:
{
  status: SyncStatus;          // 'idle' | 'syncing' | 'error' | 'offline'
  pendingCount: number;
  lastError: string | null;
  syncErrors: SyncError[];
  realtimeState: RealtimeState;
  lastSyncAt: string | null;
  isTabVisible: boolean;
}
```

**`SyncError`:**
```ts
interface SyncError {
  table: string;
  operation: string;
  entityId: string;
  message: string;
  timestamp: string;
}
```

**`RealtimeState`:** `'disconnected' | 'connecting' | 'connected' | 'error'`

### `remoteChangesStore`

Tracks incoming remote changes from other devices via Supabase Realtime. Provides methods to check for deferred changes and clear them.

**`RemoteActionType`:** `'create' | 'delete' | 'toggle' | 'increment' | 'decrement' | 'reorder' | 'rename' | 'update'`

### `isOnline`

Boolean store reflecting the browser's `navigator.onLine` status.

### `authState`

Full auth state store (object, not a string).

```ts
// $authState shape:
{
  mode: AuthMode;                    // 'supabase' | 'offline' | 'demo' | 'none'
  session: Session | null;
  offlineProfile: OfflineCredentials | null;
  isLoading: boolean;
  authKickedMessage: string | null;
}
```

**Methods:**
- `authState.setSupabaseAuth(session)` -- Transition to Supabase-authenticated mode.
- `authState.setOfflineAuth(profile)` -- Transition to offline mode.
- `authState.setNoAuth(kickedMessage?)` -- Transition to unauthenticated.
- `authState.setLoading()` -- Set loading state.
- `authState.clearKickedMessage()` -- Clear the kicked message.

### `isAuthenticated`

Derived boolean store: `true` when `$authState.mode` is `'supabase'`, `'offline'`, or `'demo'`.

### `userDisplayInfo`

Derived store with display name and avatar initial.

### `hasHydrated()`

Check whether the engine has completed initial hydration this session. Useful for deciding if remote fallback queries are needed.

```ts
function hasHydrated(): boolean
```

### `wasDbReset()`

Check whether the database was deleted and recreated during initialization (schema mismatch, corruption, or manual reset). Cleared automatically after hydration completes.

```ts
function wasDbReset(): boolean
```

---

## Realtime

### `onRealtimeDataUpdate(callback)`

Registers a callback that fires when a realtime payload is received and applied to the local database. Returns an unsubscribe function.

```ts
function onRealtimeDataUpdate(
  callback: (table: string, record: Record<string, unknown>) => void
): () => void
```

---

## Supabase Client

### `supabase`

Direct access to the initialized Supabase client instance. Use for queries not covered by the generic CRUD layer (RPC calls, storage, custom PostgREST filters).

```ts
const supabase: SupabaseClient
```

Lazily initialized on first access using credentials from `initConfig`/`getConfig`.

---

## Runtime Configuration

Application-level configuration store. Import from `stellar-drive/config`.

### `initConfig()`

Initializes the config store by fetching `/api/config` from the server. Caches the result in localStorage for offline PWA support.

```ts
function initConfig(): Promise<AppConfig>
```

### `getConfig()`

Returns the current configuration snapshot synchronously (from cache).

```ts
function getConfig(): AppConfig
```

### `setConfig(partial)`

Merges partial updates into the active configuration and persists to localStorage.

```ts
function setConfig(partial: Partial<AppConfig>): void
```

### `AppConfig`

```ts
interface AppConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  configured: boolean;
}
```

---

## Diagnostics

Unified diagnostics API for inspecting sync engine state. Import from `stellar-drive/utils`.

### `getDiagnostics()`

Returns a comprehensive JSON snapshot of all engine state (sync cycles, egress, queue, realtime, network, conflicts, errors, configuration).

```ts
function getDiagnostics(): Promise<DiagnosticsSnapshot>
```

### Sub-category Functions

Lightweight synchronous access to specific diagnostics sections:

- **`getSyncDiagnostics()`** -- Sync cycle timing, egress stats.
- **`getRealtimeDiagnostics()`** -- Realtime connection state.
- **`getQueueDiagnostics()`** -- Pending sync queue info (async).
- **`getConflictDiagnostics()`** -- Recent conflict history (async).
- **`getEngineDiagnostics()`** -- Engine configuration summary.
- **`getNetworkDiagnostics()`** -- Online status, device ID.
- **`getErrorDiagnostics()`** -- Sync error history.

---

## Debug

Development-time logging gated by a localStorage flag. Import from `stellar-drive/utils`.

### `debug(level, ...args)`

Unified debug logging function. No-op when debug mode is disabled.

```ts
function debug(level: 'log' | 'warn' | 'error', ...args: unknown[]): void
```

### `isDebugMode()`

Returns whether debug mode is enabled. Reads `localStorage.<prefix>_debug_mode` and caches the result.

```ts
function isDebugMode(): boolean
```

### `setDebugMode(enabled)`

Enable or disable debug mode. Persists to localStorage.

```ts
function setDebugMode(enabled: boolean): void
```

---

## Utilities

Pure helper functions. Import from `stellar-drive/utils`.

### `generateId()`

Generate a UUID v4 using the native Web Crypto API.

```ts
function generateId(): string
```

### `now()`

Returns the current ISO 8601 timestamp string.

```ts
function now(): string
```

### `calculateNewOrder(items, fromIndex, toIndex)`

Compute a fractional `order` value when moving an item to a different position. Only the moved item's order changes -- no need to re-index the entire list.

```ts
function calculateNewOrder<T extends { order: number }>(
  items: T[],
  fromIndex: number,
  toIndex: number
): number
```

### `resolveSupabaseName(schemaKey)`

Resolve a consumer-facing schema key to the actual (prefixed) Supabase table name. For example, if the engine prefix is `'stellar'`, `resolveSupabaseName('goals')` returns `'stellar_goals'`.

```ts
function resolveSupabaseName(schemaKey: string): string
```

### `snakeToCamel(s)`

Convert a `snake_case` string to `camelCase`.

```ts
function snakeToCamel(s: string): string
// snakeToCamel('goal_lists')  // => 'goalLists'
```

### `formatBytes(bytes)`

Format a byte count into a human-readable string (B, KB, or MB).

```ts
function formatBytes(bytes: number): string
// formatBytes(2048)  // => '2.00 KB'
```

### `createAsyncGuard(fn)`

Create a concurrency guard that prevents overlapping async invocations. If called while a previous invocation is running, the new call returns `undefined`.

```ts
function createAsyncGuard<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>
): (...args: Args) => Promise<R | undefined>
```

---

## SQL and TypeScript Generation

Generate complete Supabase SQL or TypeScript interfaces from a `SchemaDefinition`. Import from `stellar-drive/utils`.

### `generateSupabaseSQL(schema, options?)`

Produces complete SQL: CREATE TABLE, RLS policies, triggers, indexes, and realtime subscriptions. Tables with `ownership: { parent, fk }` generate parent-FK RLS policies (per-operation `exists` checks) instead of direct `user_id` ownership, and skip the `user_id` column, `set_user_id` trigger, and `user_id` index. When `prefix` is set, generated SQL uses prefixed table names (e.g., `stellar_goals` instead of `goals`) and includes auto-migration SQL to rename legacy unprefixed tables.

```ts
function generateSupabaseSQL(
  schema: SchemaDefinition,
  options?: SQLGenerationOptions
): string
```

**`SQLGenerationOptions`:**

```ts
interface SQLGenerationOptions {
  appName?: string;
  prefix?: string;                           // App prefix for multi-tenant table name prefixing. When set, all app tables are prefixed (e.g., `stellar_goals`). Shared tables (`trusted_devices`, `crdt_documents`) remain unprefixed.
  includeCRDT?: boolean;                     // Default: false
  includeDeviceVerification?: boolean;        // Default: true
  includeHelperFunctions?: boolean;           // Default: true
}
```

### `generateMigrationSQL(oldSchema, newSchema)`

Diffs two schemas and produces ALTER TABLE statements for migration.

```ts
function generateMigrationSQL(
  oldSchema: SchemaDefinition,
  newSchema: SchemaDefinition
): string
```

### `generateTypeScript(schema, options?)`

Generates TypeScript interfaces from a schema.

```ts
function generateTypeScript(
  schema: SchemaDefinition,
  options?: TypeScriptGenerationOptions
): string
```

**`TypeScriptGenerationOptions`:**

```ts
interface TypeScriptGenerationOptions {
  header?: string;
  includeSystemColumns?: boolean;            // Default: true
}
```

### `inferColumnType(columnName)`

Maps a field name to its SQL type via naming conventions (e.g., `*_id` -> `uuid`, `*_at` -> `timestamptz`, `order` -> `double precision default 0`).

```ts
function inferColumnType(columnName: string): string
```

---

## Svelte Actions

DOM-level `use:action` directives for remote-change visual feedback. Import from `stellar-drive/actions`.

### `remoteChangeAnimation`

Applies CSS animation classes when a remote update arrives for the bound entity. Maps action types to CSS classes: `item-created`, `item-deleting`, `item-toggled`, `counter-increment`, `counter-decrement`, `item-reordering`, `text-changed`, `item-changed`.

```svelte
<div use:remoteChangeAnimation={{ entityId: item.id, entityType: 'goals' }}>
  ...
</div>
```

Options: `entityId`, `entityType`, `fields?` (filter which fields trigger animation), `animationClass?` (CSS class override), `onAction?` (callback).

### `trackEditing`

Marks an element as actively being edited. Remote changes for that entity are deferred until editing ends, preventing mid-edit data corruption.

```svelte
<form use:trackEditing={{ entityId: item.id, entityType: 'goals' }}>
  ...
</form>
```

### `triggerLocalAnimation`

Manually fires the animation for local visual feedback (not remote).

```ts
function triggerLocalAnimation(
  node: HTMLElement,
  animationClass: string,
  durationMs?: number
): void
```

---

## SvelteKit Helpers

SvelteKit-specific utilities for server routes, layout load functions, and PWA lifecycle. Import from `stellar-drive/kit`.

### Server Helpers

- **`getServerConfig()`** -- Reads server-side Supabase credentials from environment variables. Returns a `ServerConfig` object.
- **`deployToVercel(config: DeployConfig)`** -- Upserts Supabase env vars on Vercel and triggers a production deployment. Returns `DeployResult`.
- **`createValidateHandler()`** -- Factory for a SvelteKit POST handler that validates Supabase credentials during initial setup.

### Layout Load Functions

- **`resolveRootLayout()`** -- Top-level layout loader. Initializes config, resolves auth state, starts sync engine. Returns `RootLayoutData` (includes `serverConfigured` flag for distinguishing first-time setup from locked/new-device scenarios).
- **`resolveSetupAccess(parentData, url)`** -- Controls access to the `/setup` wizard. Returns `SetupAccessData`.

### Email Confirmation

- **`handleEmailConfirmation(url)`** -- Processes the token from the email confirmation URL and exchanges it for a session. Returns `ConfirmResult`.
- **`broadcastAuthConfirmed()`** -- Notifies other open tabs that auth has been confirmed (via BroadcastChannel).

### Service Worker Lifecycle

- **`pollForNewServiceWorker(options?: PollOptions)`** -- Periodically checks for a new service worker version.
- **`handleSwUpdate()`** -- Applies a pending service worker update and reloads.
- **`monitorSwLifecycle(callbacks: SwLifecycleCallbacks)`** -- Attaches lifecycle event listeners.

### Auth Hydration

- **`hydrateAuthState(data: AuthLayoutData)`** -- Hydrates the client-side auth state from server-provided layout data.

---

## Demo Mode

Provides a completely isolated sandbox for consumer apps. When active, the app uses a separate Dexie database, makes zero Supabase connections, and seeds mock data. Import from the root.

### `isDemoMode()`

Returns `true` if the app is running in demo mode.

```ts
function isDemoMode(): boolean
```

### `setDemoMode(enabled)`

Activates or deactivates demo mode. Requires a full page reload afterward.

```ts
function setDemoMode(enabled: boolean): void
```

### `seedDemoData()`

Seeds the demo database with mock data using the registered `DemoConfig.seedData` callback. Idempotent within a page load.

```ts
function seedDemoData(): Promise<void>
```

### `cleanupDemoDatabase()`

Deletes the demo database entirely.

```ts
function cleanupDemoDatabase(): Promise<void>
```

### `getDemoConfig()`

Returns the registered `DemoConfig` or `null`.

### `DemoConfig`

```ts
interface DemoConfig {
  seedData: (db: Dexie) => Promise<void>;
  mockProfile: {
    email: string;
    firstName: string;
    lastName: string;
    [key: string]: unknown;
  };
}
```

---

## CRDT Collaborative Editing

Optional real-time collaborative document editing subsystem built on Yjs. Only functional when `crdt` config is provided to `initEngine()`. Import from `stellar-drive/crdt`.

### Document Lifecycle

- **`openDocument(documentId, pageId, options?)`** -- Opens a CRDT document, loads state from IndexedDB/Supabase, subscribes to Broadcast. Returns a `CRDTProvider`.
- **`closeDocument(documentId)`** -- Persists and closes a single document.
- **`closeAllDocuments()`** -- Persists and closes all open documents.

**`OpenDocumentOptions`:**
```ts
interface OpenDocumentOptions {
  offlineEnabled?: boolean;
  initialPresence?: { name: string; avatarUrl?: string };
}
```

### Document Type Helpers

Factory functions for creating shared Yjs types on a document:

- **`createSharedText(doc, name?)`** -- Creates a `YText`.
- **`createSharedXmlFragment(doc, name?)`** -- Creates a `YXmlFragment` (for rich text editors).
- **`createSharedArray(doc, name?)`** -- Creates a `YArray`.
- **`createSharedMap(doc, name?)`** -- Creates a `YMap`.
- **`createBlockDocument(doc)`** -- Creates a block-based document structure.

### Awareness / Presence

- **`updateCursor(documentId, cursor, selection?)`** -- Broadcast cursor position to collaborators.
- **`getCollaborators(documentId)`** -- Get current collaborators as `UserPresenceState[]`.
- **`onCollaboratorsChange(documentId, callback)`** -- Subscribe to collaborator changes.
- **`assignColor(userId)`** -- Deterministic color from user ID hash.

### Offline Management

- **`enableOffline(documentId)`** -- Mark a document for offline storage.
- **`disableOffline(documentId)`** -- Remove offline storage for a document.
- **`isOfflineEnabled(documentId)`** -- Check if a document is stored offline.
- **`getOfflineDocuments()`** -- List all offline-enabled documents.
- **`loadDocumentByPageId(pageId)`** -- Load a document by its page ID from IndexedDB.

### Persistence

- **`persistDocument(documentId)`** -- Persist a single dirty document to Supabase.
- **`persistAllDirty()`** -- Persist all dirty documents.

### Configuration

```ts
interface CRDTConfig {
  supabaseTable?: string;              // Default: 'crdt_documents'
  columns?: string;                    // Supabase SELECT columns
  persistIntervalMs?: number;          // Default: 30000
  broadcastDebounceMs?: number;        // Default: 100
  localSaveDebounceMs?: number;        // Default: 5000
  cursorDebounceMs?: number;           // Default: 50
  maxOfflineDocuments?: number;         // Default: 50
  maxBroadcastPayloadBytes?: number;    // Default: 250000
  syncPeerTimeoutMs?: number;          // Default: 3000
  maxReconnectAttempts?: number;        // Default: 5
  reconnectBaseDelayMs?: number;        // Default: 1000
}
```

### Yjs Re-exports

Consumers never need to install `yjs` directly:

- `YDoc` (class), `YText`, `YXmlFragment`, `YArray`, `YMap`, `YXmlElement` (types)

### Diagnostics

- **`getCRDTDiagnostics()`** -- Returns CRDT-specific diagnostics (open providers, offline docs, connection states).

---

## Types

All public TypeScript types. Import from `stellar-drive/types`.

### `SyncStatus`

```ts
type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';
```

### `AuthMode`

```ts
type AuthMode = 'supabase' | 'offline' | 'demo' | 'none';
```

### `SingleUserGateType`

```ts
type SingleUserGateType = 'code' | 'password';
```

### `OperationType`

```ts
type OperationType = 'increment' | 'set' | 'create' | 'delete';
```

### `FieldType`

Declares a column's type in the schema `fields` map.

```ts
type FieldType =
  | string                                     // e.g., 'string', 'number?', 'uuid'
  | string[]                                   // enum: ['a', 'b', 'c']
  | { enum: string[]; nullable?: boolean; enumName?: string };
```

### `SyncOperationItem`

A single intent-based sync operation in the IndexedDB `syncQueue` table.

```ts
interface SyncOperationItem {
  id?: number;
  table: string;
  entityId: string;
  operationType: OperationType;
  field?: string;
  value?: unknown;
  timestamp: string;
  retries: number;
  lastRetryAt?: string;
}
```

### `OfflineCredentials`

Cached credentials for offline sign-in.

```ts
interface OfflineCredentials {
  id: string;                // Always 'current_user'
  userId: string;
  email: string;
  password: string;          // SHA-256 hash
  profile: Record<string, unknown>;
  cachedAt: string;
}
```

### `OfflineSession`

```ts
interface OfflineSession {
  id: string;                // Always 'current_session'
  userId: string;
  offlineToken: string;
  createdAt: string;
}
```

### `ConflictHistoryEntry`

```ts
interface ConflictHistoryEntry {
  id?: number;
  entityId: string;
  entityType: string;
  field: string;
  localValue: unknown;
  remoteValue: unknown;
  resolvedValue: unknown;
  winner: 'local' | 'remote' | 'merged';
  strategy: string;
  timestamp: string;
}
```

### `SingleUserConfig`

```ts
interface SingleUserConfig {
  id: string;                // Always 'config'
  gateType: SingleUserGateType;
  codeLength?: 4 | 6;
  gateHash?: string;
  email?: string;
  profile: Record<string, unknown>;
  supabaseUserId?: string;
  setupAt: string;
  updatedAt: string;
}
```

### `TrustedDevice`

```ts
interface TrustedDevice {
  id: string;
  userId: string;
  deviceId: string;
  deviceLabel?: string;
  trustedAt: string;
  lastUsedAt: string;
}
```

### `UserPresenceState`

```ts
interface UserPresenceState {
  userId: string;
  name: string;
  avatarUrl?: string;
  color: string;
  cursor?: unknown;
  selection?: unknown;
  deviceId: string;
  lastActiveAt: string;
}
```

---

## Vite Plugin (`stellarPWA`)

The `stellarPWA` Vite plugin provides service worker build, asset manifest generation, and **schema-driven auto-generation** of TypeScript types and Supabase migrations. Import from `stellar-drive/vite`.

```ts
import { stellarPWA } from 'stellar-drive/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    sveltekit(),
    stellarPWA({
      prefix: 'myapp',
      name: 'My App',
      schema: true,
    }),
  ],
});
```

### `stellarPWA(options)`

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `prefix` | `string` | Yes | -- | Cache prefix for service worker and asset naming. |
| `name` | `string` | Yes | -- | App name used in SQL comments and build logging. |
| `schema` | `boolean \| SchemaPluginOptions` | No | `false` | Enable schema auto-generation. Pass `true` for defaults or an options object. |

### `SchemaPluginOptions`

When `schema` is an object instead of `true`, these options are available:

| Field | Type | Default | Description |
|---|---|---|---|
| `path` | `string` | `'src/lib/schema.ts'` | Path to the schema source file (must export `schema`). |
| `typesOutput` | `string` | `'src/lib/types.generated.ts'` | Path where generated TypeScript interfaces are written. |
| `autoMigrate` | `boolean` | `true` | Whether to push migration SQL to Supabase automatically. |

### Schema Auto-Generation Workflow

When `schema` is enabled, the plugin drives three systems from a single `schema.ts` file:

1. **TypeScript interfaces** -- auto-generated at `src/lib/types.generated.ts`
2. **Supabase DDL** -- auto-migrated via direct Postgres connection
3. **IndexedDB/Dexie** -- auto-versioned at runtime by the engine's `initEngine()` call

#### Development Mode (`npm run dev`)

- On server start, the plugin loads the schema via Vite's `ssrLoadModule()` and processes it once.
- The schema file is **watched** for changes. On save, a **500ms debounce** triggers reprocessing.
- Each processing cycle: generates types, diffs against the snapshot, generates migration SQL, and pushes to Supabase.

#### Production Build (`npm run build`)

- The plugin uses **esbuild** to transpile the schema file (no Vite dev server available).
- Schema is processed **once** during the `buildStart` hook, ensuring CI/CD pipelines that skip dev mode still generate types and push migrations.

#### Schema Snapshot (`.stellar/schema-snapshot.json`)

The plugin maintains a JSON snapshot of the last-known schema state at `.stellar/schema-snapshot.json`. This file is used for **incremental migration diffing**:

- **First run (no snapshot):** Generates idempotent initial SQL via `generateSupabaseSQL()` (`CREATE TABLE IF NOT EXISTS`, RLS policies, triggers, indexes, extensions, helper functions). Pushes directly to Postgres and saves the snapshot. Works on both fresh databases and databases with existing tables.
- **Subsequent runs:** Loads the snapshot, compares against the current schema. If different, calls `generateMigrationSQL()` to produce only the delta (ALTER TABLE statements). Pushes to Postgres and updates the snapshot.
- **Failed migrations:** If a migration push fails, the snapshot is **not updated**. The next build or dev save retries the same migration automatically.

The `.stellar/schema-snapshot.json` file should be **committed to git** so CI/CD builds (e.g., Vercel) can diff against the last-known schema state.

#### Migration Push (`pushMigration`)

Migrations are pushed to Supabase via a **direct Postgres connection** using the `DATABASE_URL` environment variable and the `postgres` npm package. This eliminates any bootstrap requirements -- migrations work on completely fresh databases with no prior setup.

The connection is short-lived (one query per migration push) and the client is closed immediately after execution.

#### Migration Safety

- **Destructive operations are commented out.** `generateMigrationSQL()` produces `-- drop table` and `-- alter table drop column` as comments, requiring manual review.
- **Type changes are not handled.** Changing a column's type (e.g., `string` to `number`) requires manual migration.
- **Additive operations are safe.** New tables and new columns are applied automatically.

#### Fallback When Environment Variables Are Missing

If `DATABASE_URL` is not set:

- **TypeScript types are still generated** -- the plugin does not require database credentials for type generation.
- **Migration push is skipped** with a warning:
  ```
  [stellar-drive] ⚠ Supabase auto-migration skipped — missing env var: DATABASE_URL
  ```

This means local development works without database credentials; only the auto-migration feature requires them.

### Environment Variables

The Vite plugin and SvelteKit server helpers read these environment variables:

| Variable | Required For | Description |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | Runtime | Your Supabase project URL (e.g., `https://abc.supabase.co`). Find it: Supabase Dashboard > Settings > API > Project URL. |
| `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Runtime | The publishable API key for client-side auth and data access. Find it: Supabase Dashboard > Settings > API > Project API keys > publishable. |
| `DATABASE_URL` | Auto-migration only | Postgres connection string for direct SQL execution. Used by the Vite plugin to push schema migrations. If not set, migrations are skipped. Find it: Supabase Dashboard > Settings > Database > Connection string (URI). **Never expose this to the client.** |

### Generated Files

| File | Purpose | Git-tracked? |
|---|---|---|
| `src/lib/types.generated.ts` | TypeScript interfaces from schema | No (add to `.gitignore`) |
| `.stellar/schema-snapshot.json` | Schema state for migration diffing | **Yes** (commit to git) |
| `static/sw.js` | Service worker with cache config | No (add to `.gitignore`) |
| `static/asset-manifest.json` | Asset list for SW precaching | No (add to `.gitignore`) |

---

## CLI Commands

The package provides a CLI via `npx stellar-drive <command>`.

### `install pwa`

Scaffold a complete offline-first SvelteKit PWA project with an interactive walkthrough. Generates **34+ files** for a production-ready SvelteKit 2 + Svelte 5 project.

```bash
npx stellar-drive install pwa
```

#### Wizard Prompts

| Prompt | Required | Description |
|---|---|---|
| App Name | Yes | Full app name (e.g., "My Planner") |
| Short Name | Yes | Short name for PWA home screen (under 12 chars) |
| Prefix | Yes | Lowercase key for localStorage, caches, SW (auto-suggested from name) |
| Description | No | App description (default: "A self-hosted offline-first PWA") |

#### Generated Files

| Category | Count | Files |
|---|---|---|
| Config | 8 | `vite.config.ts`, `tsconfig.json`, `svelte.config.js`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `knip.json`, `.gitignore` |
| Documentation | 3 | `README.md`, `ARCHITECTURE.md`, `FRAMEWORKS.md` |
| Environment | 1 | `.env.example` with all Supabase env vars and setup instructions |
| Static assets | 13 | `manifest.json`, `offline.html`, placeholder SVG icons, email templates |
| Database | 1 | `supabase-schema.sql` with helper functions, example tables, `trusted_devices` |
| Schema | 1 | `src/lib/schema.ts` -- single source of truth for all tables |
| Types | 1 | `src/lib/types.ts` -- type re-exports and app-specific narrowing stubs |
| App entry | 2 | `src/app.html`, `src/app.d.ts` |
| Routes | 16 | Root layout, login, setup, profile, protected area, API endpoints, catch-all redirect |
| Git hooks | 1 | `.husky/pre-commit` with lint + format + validate |

#### Post-Scaffold Setup

After running `install pwa`:

1. Copy `.env.example` to `.env` and fill in your Supabase credentials (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `DATABASE_URL`).
2. Run `npm install` to install dependencies (includes the `postgres` package for direct database access).
3. Run `npm run dev` -- the Vite plugin will:
   - Generate TypeScript types at `src/lib/types.generated.ts`
   - Generate idempotent initial SQL and push it directly to Postgres (if `DATABASE_URL` is set)
   - Create `.stellar/schema-snapshot.json` for future migration diffing
4. Commit `.stellar/schema-snapshot.json` to git so future builds produce incremental migrations.

#### Schema Workflow Integration

The scaffolded project is fully integrated with the schema auto-generation workflow:

- `vite.config.ts` includes `stellarPWA({ ..., schema: true })`.
- `src/lib/schema.ts` is the single source of truth, imported by both the Vite plugin (for type/SQL generation) and the app's `+layout.ts` (for `initEngine()`).
- `.gitignore` excludes `src/lib/types.generated.ts` (but `.stellar/schema-snapshot.json` is committed for CI/CD migration diffing).
- `src/lib/types.ts` imports from `types.generated.ts` and provides a place for app-specific type narrowing (e.g., `Omit<Generated, 'field'> & { field: NarrowType }`).

---

## Re-exports

The following types are re-exported so consumers do not need direct dependencies:

- **`Session`** from `@supabase/supabase-js` -- Available from `stellar-drive/types` or the root.
- **Yjs types** (`YDoc`, `YText`, `YXmlFragment`, `YArray`, `YMap`, `YXmlElement`) -- Available from `stellar-drive/crdt`.
