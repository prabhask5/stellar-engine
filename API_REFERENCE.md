# Stellar Engine API Reference

Complete reference for all public exports from `@prabhask5/stellar-engine`.

### Subpath Exports

| Subpath | Contents |
|---|---|
| `@prabhask5/stellar-engine` | `initEngine`, `startSyncEngine`, `runFullSync`, `supabase`, `getDb`, `resetDatabase`, `validateSupabaseCredentials` |
| `@prabhask5/stellar-engine/data` | CRUD + query operations |
| `@prabhask5/stellar-engine/auth` | Authentication functions |
| `@prabhask5/stellar-engine/stores` | Reactive stores + event subscriptions |
| `@prabhask5/stellar-engine/types` | All type exports (including `Session` from Supabase) |
| `@prabhask5/stellar-engine/utils` | Utility functions + debug (`snakeToCamel`, etc.) |
| `@prabhask5/stellar-engine/actions` | Svelte `use:` actions |
| `@prabhask5/stellar-engine/config` | Runtime config, `getDexieTableFor` |
| `@prabhask5/stellar-engine/email` | `sendEmail`, `validateSmtpCredentials` |

All exports are also available from the root `@prabhask5/stellar-engine` for backward compatibility.

---

## Table of Contents

- [Configuration](#configuration)
- [Database](#database)
- [Engine Lifecycle](#engine-lifecycle)
- [Credential Validation](#credential-validation)
- [CRUD Operations](#crud-operations)
- [Query Operations](#query-operations)
- [Authentication](#authentication)
- [Auth Lifecycle](#auth-lifecycle)
- [Admin](#admin)
- [Offline Login](#offline-login)
- [Single-User Auth](#single-user-auth)
- [Device Verification](#device-verification)
- [Stores](#stores)
- [Realtime](#realtime)
- [Supabase Client](#supabase-client)
- [Runtime Config](#runtime-config)
- [Email](#email)
- [Debug](#debug)
- [Utilities](#utilities)
- [Svelte Actions](#svelte-actions)
- [Types](#types)

---

## Configuration

### `initEngine(config)`

Initialize the sync engine with configuration. Must be called before any other engine function.

```ts
function initEngine(config: SyncEngineConfig): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `SyncEngineConfig` | Engine configuration object |

**Example:**

```ts
import { initEngine } from '@prabhask5/stellar-engine';

initEngine({
  prefix: 'myapp',
  tables: [
    {
      supabaseName: 'tasks',
      columns: 'id, user_id, name, completed, order, deleted, created_at, updated_at'
    }
  ],
  database: {
    name: 'myapp-db',
    versions: [{ version: 1, stores: { tasks: 'id, user_id, order' } }]
  }
});
```

### `SyncEngineConfig`

```ts
interface SyncEngineConfig {
  tables: TableConfig[];
  prefix: string;
  db?: Dexie;                              // Pre-created Dexie instance (backward compat)
  supabase?: SupabaseClient;               // Pre-created Supabase client (backward compat)
  database?: DatabaseConfig;               // Engine creates and owns the Dexie instance
  auth?: {
    mode?: 'multi-user' | 'single-user';   // Default: 'multi-user'
    singleUser?: {                          // Required when mode is 'single-user'
      gateType: SingleUserGateType;         // 'code' or 'password'
      codeLength?: 4 | 6;                   // Required when gateType is 'code'
    };
    profileExtractor?: (userMetadata: Record<string, unknown>) => Record<string, unknown>;
    profileToMetadata?: (profile: Record<string, unknown>) => Record<string, unknown>;
    enableOfflineAuth?: boolean;
    sessionValidationIntervalMs?: number;
    confirmRedirectPath?: string;
    adminCheck?: (user: User | null) => boolean;
  };
  onAuthStateChange?: (event: string, session: Session | null) => void;
  onAuthKicked?: (message: string) => void;
  syncDebounceMs?: number;                 // Default: 2000
  syncIntervalMs?: number;                 // Default: 900000 (15 min)
  tombstoneMaxAgeDays?: number;            // Default: 1
  visibilitySyncMinAwayMs?: number;        // Default: 300000 (5 min)
  onlineReconnectCooldownMs?: number;      // Default: 120000 (2 min)
}
```

### `TableConfig`

```ts
interface TableConfig {
  supabaseName: string;                    // Supabase table name
  columns: string;                         // Supabase select columns
  ownershipFilter?: string;                // Column used for RLS ownership filtering
  isSingleton?: boolean;                   // One record per user (e.g., user settings)
  excludeFromConflict?: string[];          // Fields to skip during conflict resolution
  numericMergeFields?: string[];           // Fields that use additive merge for conflicts
  onRemoteChange?: (table: string, record: Record<string, unknown>) => void;
}
```

The Dexie (IndexedDB) table name is **automatically derived** from `supabaseName` using `snakeToCamel()` conversion. For example, `supabaseName: 'goal_lists'` produces the Dexie table name `goalLists`. The `snakeToCamel()` function also strips invalid characters (non-alphanumeric except underscores) before converting. The `database.versions[].stores` config should use the camelCase names for IndexedDB index definitions.

Use `getDexieTableFor(table)` (exported from `@prabhask5/stellar-engine/config`) to resolve the Dexie table name for a given Supabase table name at runtime.

---

## Database

### `getDb()`

Get the engine-managed Dexie database instance. Throws if `initEngine()` has not been called.

```ts
function getDb(): Dexie
```

**Returns:** `Dexie` -- The managed IndexedDB instance.

### `resetDatabase()`

Delete the entire IndexedDB database and clear sync cursors from localStorage. Use this as a nuclear recovery option when the database is corrupted (e.g., missing object stores due to failed upgrades). After calling, the app should reload so `initEngine()` runs fresh and rehydrates from Supabase. The Supabase auth session is preserved so the user doesn't need to log in again.

```ts
async function resetDatabase(): Promise<string | null>
```

**Returns:** The name of the deleted database, or `null` if no managed database exists.

**Example:**

```ts
import { resetDatabase } from '@prabhask5/stellar-engine';

const dbName = await resetDatabase();
window.location.reload(); // Re-initializes everything from scratch
```

### `DatabaseConfig`

```ts
interface DatabaseConfig {
  name: string;
  versions: DatabaseVersionConfig[];
}
```

### `DatabaseVersionConfig`

```ts
interface DatabaseVersionConfig {
  version: number;
  stores: Record<string, string>;          // App tables only; system tables are auto-merged
  upgrade?: (tx: Transaction) => Promise<void>;
}
```

---

## Engine Lifecycle

### `startSyncEngine()`

Start the sync engine. Sets up event listeners for online/offline, visibility changes, periodic sync, realtime subscriptions, and initial data hydration. Safe to call multiple times (cleans up previous listeners). On first call (when online), runs one-time schema validation via `validateSchema()`.

```ts
async function startSyncEngine(): Promise<void>
```

**Example:**

```ts
import { startSyncEngine } from '@prabhask5/stellar-engine';

await startSyncEngine();
```

### `runFullSync(quiet?, skipPull?)`

Execute a full push-then-pull sync cycle. Pushes pending local changes to Supabase, then pulls remote changes into IndexedDB.

```ts
async function runFullSync(quiet?: boolean, skipPull?: boolean): Promise<void>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `quiet` | `boolean` | `false` | If true, do not update UI sync status indicators |
| `skipPull` | `boolean` | `false` | If true, only push (skip pull from server) |

### `onSyncComplete(callback)`

Register a callback that fires after each successful sync cycle. Returns an unsubscribe function.

```ts
function onSyncComplete(callback: () => void): () => void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `callback` | `() => void` | Function to call when sync completes |

**Returns:** `() => void` -- Unsubscribe function.

**Example:**

```ts
import { onSyncComplete } from '@prabhask5/stellar-engine';

const unsubscribe = onSyncComplete(() => {
  console.log('Sync complete, refresh UI');
});
// Later: unsubscribe();
```

---

## Credential Validation

### `validateSupabaseCredentials(url, anonKey)`

> **Subpath:** `@prabhask5/stellar-engine` (root)

Test connectivity to a Supabase project using provided credentials. Creates a temporary client, runs a test query, and checks for common error patterns (invalid API key, missing schema, etc.). Useful in setup/onboarding flows.

```ts
async function validateSupabaseCredentials(
  url: string,
  anonKey: string
): Promise<{ valid: boolean; error?: string }>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | `string` | Supabase project URL |
| `anonKey` | `string` | Supabase anonymous key |

**Returns:** `{ valid: true }` if credentials work, or `{ valid: false, error: string }`.

### `validateSchema()`

> **Subpath:** `@prabhask5/stellar-engine` (root)

Validates that all configured Supabase tables exist and are accessible. Runs `SELECT id FROM <table> LIMIT 0` per table (zero data egress). If `auth.deviceVerification?.enabled`, also validates the `trusted_devices` table. Called automatically by `startSyncEngine()` on first run when online — can also be called manually.

```ts
async function validateSchema(): Promise<{
  valid: boolean;
  missingTables: string[];
  errors: string[];
}>
```

**Returns:** `{ valid: true, missingTables: [], errors: [] }` if all tables are accessible. Otherwise, `valid` is `false` and `missingTables` lists tables that don't exist, while `errors` includes human-readable messages for all issues (missing tables, RLS denials, etc.).

**Behavior:** Does not throw. Logs errors via the debug system. When called from `startSyncEngine()`, sets `syncStatusStore` to `'error'` with a descriptive message if validation fails.

---

## CRUD Operations

All CRUD functions use Supabase table names as the API surface and internally resolve to Dexie table names. Writes go to IndexedDB first, then sync to Supabase in the background.

### `engineCreate(table, data)`

Create a new entity. Writes to local DB, queues sync, and schedules push.

```ts
async function engineCreate(
  table: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Supabase table name |
| `data` | `Record<string, unknown>` | Entity data. If `id` is omitted, a UUID is generated. |

**Returns:** The created entity (with `id`).

**Example:**

```ts
const task = await engineCreate('tasks', {
  user_id: userId,
  name: 'New Task',
  completed: false,
  order: 1,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
});
```

### `engineUpdate(table, id, fields)`

Update an entity's fields. Automatically sets `updated_at`.

```ts
async function engineUpdate(
  table: string,
  id: string,
  fields: Record<string, unknown>
): Promise<Record<string, unknown> | undefined>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Supabase table name |
| `id` | `string` | Entity ID |
| `fields` | `Record<string, unknown>` | Fields to update |

**Returns:** The updated entity, or `undefined` if not found.

### `engineDelete(table, id)`

Soft-delete an entity. Sets `deleted: true` and queues a delete sync operation.

```ts
async function engineDelete(table: string, id: string): Promise<void>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Supabase table name |
| `id` | `string` | Entity ID |

### `engineBatchWrite(operations)`

Execute multiple write operations in a single atomic IndexedDB transaction.

```ts
async function engineBatchWrite(operations: BatchOperation[]): Promise<void>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `operations` | `BatchOperation[]` | Array of create/update/delete operations |

### `BatchOperation`

```ts
type BatchOperation =
  | { type: 'create'; table: string; data: Record<string, unknown> }
  | { type: 'update'; table: string; id: string; fields: Record<string, unknown> }
  | { type: 'delete'; table: string; id: string };
```

**Example:**

```ts
await engineBatchWrite([
  { type: 'create', table: 'tasks', data: { user_id: uid, name: 'A' } },
  { type: 'update', table: 'tasks', id: 'abc', fields: { name: 'B' } },
  { type: 'delete', table: 'tasks', id: 'xyz' }
]);
```

### `engineIncrement(table, id, field, amount, additionalFields?)`

Increment a numeric field. Preserves increment intent for conflict resolution so multi-device increments can be additive.

```ts
async function engineIncrement(
  table: string,
  id: string,
  field: string,
  amount: number,
  additionalFields?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Supabase table name |
| `id` | `string` | Entity ID |
| `field` | `string` | Numeric field to increment |
| `amount` | `number` | Delta to add (can be negative) |
| `additionalFields` | `Record<string, unknown>` | Optional extra fields to set alongside the increment |

**Returns:** The updated entity, or `undefined` if not found.

---

## Query Operations

All queries read from local IndexedDB first. Optional `remoteFallback` fetches from Supabase if local results are empty.

### `engineGet(table, id, opts?)`

Get a single entity by ID.

```ts
async function engineGet(
  table: string,
  id: string,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown> | null>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Supabase table name |
| `id` | `string` | Entity ID |
| `opts.remoteFallback` | `boolean` | If true, fetch from Supabase when not found locally |

### `engineGetAll(table, opts?)`

Get all entities from a table.

```ts
async function engineGetAll(
  table: string,
  opts?: { orderBy?: string; remoteFallback?: boolean }
): Promise<Record<string, unknown>[]>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Supabase table name |
| `opts.orderBy` | `string` | Dexie index to order by |
| `opts.remoteFallback` | `boolean` | If true, fetch from Supabase when local is empty |

### `engineQuery(table, index, value, opts?)`

Query entities by index equality (`WHERE index = value`).

```ts
async function engineQuery(
  table: string,
  index: string,
  value: unknown,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown>[]>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Supabase table name |
| `index` | `string` | Dexie index name |
| `value` | `unknown` | Value to match |
| `opts.remoteFallback` | `boolean` | If true, fetch from Supabase when local is empty |

### `engineQueryRange(table, index, lower, upper, opts?)`

Range query (`WHERE index BETWEEN lower AND upper`, inclusive).

```ts
async function engineQueryRange(
  table: string,
  index: string,
  lower: unknown,
  upper: unknown,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown>[]>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Supabase table name |
| `index` | `string` | Dexie index name |
| `lower` | `unknown` | Lower bound (inclusive) |
| `upper` | `unknown` | Upper bound (inclusive) |
| `opts.remoteFallback` | `boolean` | If true, fetch from Supabase when local is empty |

### `engineGetOrCreate(table, index, value, defaults, opts?)`

Get a singleton entity by index, or create it with defaults if it does not exist. Useful for per-user settings records.

```ts
async function engineGetOrCreate(
  table: string,
  index: string,
  value: unknown,
  defaults: Record<string, unknown>,
  opts?: { checkRemote?: boolean }
): Promise<Record<string, unknown>>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | Supabase table name |
| `index` | `string` | Dexie index to search |
| `value` | `unknown` | Value to match |
| `defaults` | `Record<string, unknown>` | Default fields for new entity (excluding `id`, `created_at`, `updated_at`) |
| `opts.checkRemote` | `boolean` | If true, check Supabase before creating locally |

**Returns:** The existing or newly created entity.

---

## Authentication

### `signIn(email, password)`

Sign in with email and password. When cached credentials exist, wrong passwords are rejected locally without hitting Supabase. If no cached credentials exist, rate limiting with exponential backoff is applied. Caches credentials for offline use on success.

```ts
async function signIn(email: string, password: string): Promise<AuthResponse>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `email` | `string` | User email |
| `password` | `string` | User password |

**Returns:** `AuthResponse` — includes `retryAfterMs` when rate-limited.

### `signUp(email, password, profileData)`

Create a new account. Uses `profileToMetadata` from config if provided.

```ts
async function signUp(
  email: string,
  password: string,
  profileData: Record<string, unknown>
): Promise<AuthResponse>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `email` | `string` | User email |
| `password` | `string` | User password |
| `profileData` | `Record<string, unknown>` | Profile fields stored in user metadata |

### `signOut(options?)`

Sign out. Stops sync engine, clears local data, clears offline sessions, and signs out of Supabase.

```ts
async function signOut(options?: {
  preserveOfflineCredentials?: boolean;
  preserveLocalData?: boolean;
}): Promise<{ error: string | null }>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `options.preserveOfflineCredentials` | `boolean` | If true, keep cached offline credentials |
| `options.preserveLocalData` | `boolean` | If true, keep local IndexedDB data and sync queue |

### `changePassword(currentPassword, newPassword)`

Change the user's password. Verifies the current password locally against cached credentials when available, falling back to Supabase verification if no cache exists. Updates offline credential cache.

```ts
async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<{ error: string | null }>
```

### `changeEmail(newEmail)`

Initiate an email change for the current user. Supabase sends a confirmation email to the new address. The user must click the confirmation link to complete the change. Use `completeEmailChange()` after confirmation.

```ts
async function changeEmail(
  newEmail: string
): Promise<{ error: string | null; confirmationRequired: boolean }>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `newEmail` | `string` | The new email address |

**Returns:** `{ error: null, confirmationRequired: true }` on success. `confirmationRequired` is always `true` when there is no error — the caller should show a confirmation modal.

### `completeEmailChange()`

Complete an email change after the user confirms via the email link. Refreshes the session to pick up the new email and updates the offline credentials cache.

```ts
async function completeEmailChange(): Promise<{ error: string | null; newEmail: string | null }>
```

**Returns:** `{ error: null, newEmail: 'new@example.com' }` on success.

**Example:**

```ts
import { changeEmail, completeEmailChange } from '@prabhask5/stellar-engine/auth';

// Step 1: Initiate
const { error, confirmationRequired } = await changeEmail('new@example.com');
if (confirmationRequired) {
  // Show "check your email" modal, listen for BroadcastChannel AUTH_CONFIRMED
}

// Step 2: After confirmation (e.g., in BroadcastChannel listener)
const { newEmail } = await completeEmailChange();
// newEmail === 'new@example.com'
```

### `resendConfirmationEmail(email)`

Resend the signup confirmation email.

```ts
async function resendConfirmationEmail(email: string): Promise<{ error: string | null }>
```

### `getUserProfile(user)`

Extract the user profile from a Supabase `User` object. Uses `profileExtractor` from config if provided.

```ts
function getUserProfile(user: User | null): Record<string, unknown>
```

### `updateProfile(profile)`

Update the current user's profile metadata. Also updates the offline credential cache.

```ts
async function updateProfile(
  profile: Record<string, unknown>
): Promise<{ error: string | null }>
```

### `verifyOtp(tokenHash, type)`

Verify an OTP token for email confirmation or email change.

```ts
async function verifyOtp(
  tokenHash: string,
  type: 'signup' | 'email' | 'email_change'
): Promise<{ error: string | null }>
```

### `getValidSession()`

Get the current Supabase session if it exists and is not expired.

```ts
async function getValidSession(): Promise<Session | null>
```

### `AuthResponse`

```ts
interface AuthResponse {
  user: User | null;
  session: Session | null;
  error: string | null;
  retryAfterMs?: number;
}
```

`retryAfterMs` is set when the login guard's rate limiting is active (no cached credentials and too many recent failed attempts). Callers can use this value to show a countdown or disable the login button.

---

## Auth Lifecycle

### `resolveAuthState()`

Determine the current authentication state. Checks Supabase session when online, falls back to offline session when offline.

```ts
async function resolveAuthState(): Promise<AuthStateResult>
```

**Returns:** `AuthStateResult`

**Example:**

```ts
import { resolveAuthState } from '@prabhask5/stellar-engine';

const { session, authMode, offlineProfile } = await resolveAuthState();
if (authMode === 'supabase') {
  // Online with valid Supabase session
} else if (authMode === 'offline') {
  // Offline with valid cached credentials
} else {
  // No valid session -- redirect to login
}
```

### `AuthStateResult`

```ts
interface AuthStateResult {
  session: Session | null;
  authMode: 'supabase' | 'offline' | 'none';
  offlineProfile: OfflineCredentials | null;
  singleUserSetUp?: boolean;              // Only present when mode is 'single-user'
}
```

When `auth.mode` is `'single-user'`, the `singleUserSetUp` field indicates whether the user has completed initial setup. If `false`, the app should show a setup screen. If `true` and `authMode` is `'none'`, the user is locked and should see an unlock screen.

---

## Admin

### `isAdmin(user)`

Check if a user has admin privileges. In single-user mode (`auth.mode === 'single-user'`), always returns `true`. Otherwise delegates to `config.auth.adminCheck` if provided, or returns `false`.

```ts
function isAdmin(user: User | null): boolean
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `user` | `User \| null` | Supabase User object |

---

## Offline Login

### `signInOffline(email, password)`

Sign in using cached offline credentials. Verifies email and password against the locally cached credentials, then creates an offline session.

```ts
async function signInOffline(
  email: string,
  password: string
): Promise<OfflineLoginResult>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `email` | `string` | User email |
| `password` | `string` | User password |

**Returns:** `OfflineLoginResult` with `success: boolean`, optional `error` string, and optional `reason` code (`'no_credentials'`, `'no_stored_password'`, `'user_mismatch'`, `'email_mismatch'`, `'password_mismatch'`, `'session_failed'`).

### `getOfflineLoginInfo()`

Get non-sensitive display info about cached offline credentials. Returns `null` if no credentials are cached.

```ts
async function getOfflineLoginInfo(): Promise<{
  hasCredentials: boolean;
  email?: string;
  firstName?: string;
  lastName?: string;
} | null>
```

---

## Login Guard

The login guard provides local credential pre-checking and rate limiting to minimize unnecessary Supabase auth requests. It is used internally by `signIn()`, `unlockSingleUser()`, and `linkSingleUserDevice()`.

**How it works:**

- When cached credentials exist (offline credentials hash for multi-user, `gateHash` for single-user), passwords are verified locally first. Wrong passwords are rejected without making a Supabase call.
- When no cached credentials exist (new device, first login), exponential backoff rate limiting is applied (1s base, 30s max, 2x multiplier). The `retryAfterMs` field in the response indicates how long to wait.
- If a user changes their password on another device, the local hash will no longer match. After 5 consecutive local rejections, the cached hash is invalidated and the system falls through to rate-limited Supabase authentication. On successful Supabase login, the new hash is cached immediately.
- If a locally-matched password is rejected by Supabase (stale hash), the cached hash is invalidated so future attempts use Supabase directly.

**State is in-memory only** — it resets on page refresh.

### `resetLoginGuard()`

Reset all login guard state (counters and rate limiting). Called automatically by `signOut()`. Consumers should call this if implementing custom sign-out flows.

```ts
function resetLoginGuard(): void
```

---

## Single-User Auth

Single-user mode uses **real Supabase email/password auth** where the user provides an email during setup and a PIN code (or password) that is padded and used as the Supabase password. The PIN is verified server-side by Supabase — no client-side hash comparison. This gives server-side rate limiting, real user identity, and proper RLS enforcement.

This mode is designed for personal apps where there is one user per device/deployment.

**Requirements:**
- If `deviceVerification.enabled`, create a `trusted_devices` table in Supabase (see README for full SQL).
- If `emailConfirmation.enabled`, configure Supabase email templates in your Supabase project under Authentication > Email Templates.

**Configuration:**

```ts
initEngine({
  // ...
  auth: {
    mode: 'single-user',
    singleUser: { gateType: 'code', codeLength: 4 },
    emailConfirmation: { enabled: true },
    deviceVerification: { enabled: true, trustDurationDays: 90 },
    enableOfflineAuth: true,
    confirmRedirectPath: '/confirm',
    profileExtractor: (meta) => ({ firstName: meta.first_name, lastName: meta.last_name }),
    profileToMetadata: (p) => ({ first_name: p.firstName, last_name: p.lastName }),
  },
});
```

### `isSingleUserSetUp()`

Check if single-user mode has been set up (i.e., a `SingleUserConfig` record exists in IndexedDB).

```ts
async function isSingleUserSetUp(): Promise<boolean>
```

**Returns:** `true` if setup is complete, `false` otherwise.

### `getSingleUserInfo()`

Get non-sensitive display info about the configured single user. Returns `null` if not set up.

```ts
async function getSingleUserInfo(): Promise<{
  profile: Record<string, unknown>;
  gateType: SingleUserGateType;
  codeLength?: 4 | 6;
} | null>
```

**Returns:** Profile data and gate configuration, or `null`.

**Example:**

```ts
import { getSingleUserInfo } from '@prabhask5/stellar-engine/auth';

const info = await getSingleUserInfo();
if (info) {
  console.log(`Welcome back, ${info.profile.firstName}`);
  // info.gateType === 'code', info.codeLength === 4
}
```

### `setupSingleUser(gate, profile, email)`

First-time setup. Calls `supabase.auth.signUp()` with the email and padded PIN as password. Stores config in IndexedDB. If `emailConfirmation.enabled`, returns `{ confirmationRequired: true }` — the app should show a confirmation modal.

```ts
async function setupSingleUser(
  gate: string,
  profile: Record<string, unknown>,
  email: string
): Promise<{ error: string | null; confirmationRequired: boolean }>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `gate` | `string` | The PIN code or password |
| `profile` | `Record<string, unknown>` | User profile (e.g., `{ firstName, lastName }`) |
| `email` | `string` | Email address for Supabase email/password auth |

**Example:**

```ts
import { setupSingleUser } from '@prabhask5/stellar-engine/auth';

const { error, confirmationRequired } = await setupSingleUser('1234', {
  firstName: 'Alice',
  lastName: 'Smith',
}, 'alice@example.com');
if (error) console.error(error);
if (confirmationRequired) {
  // Show email confirmation modal
}
```

### `unlockSingleUser(gate)`

Verify PIN via local `gateHash` pre-check, then `supabase.auth.signInWithPassword()`. Wrong PINs are rejected locally without hitting Supabase when a `gateHash` is cached. If `deviceVerification.enabled` and the current device is not trusted, signs out and sends OTP, returning `{ deviceVerificationRequired: true, maskedEmail }`. Falls back to offline hash verification when offline.

```ts
async function unlockSingleUser(
  gate: string
): Promise<{
  error: string | null;
  deviceVerificationRequired?: boolean;
  maskedEmail?: string;
  retryAfterMs?: number;
}>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `gate` | `string` | The PIN code or password to verify |

**Returns:** `{ error: null }` on success, or `{ error: string }` if the gate is incorrect or setup is incomplete. Includes `retryAfterMs` when rate-limited. If device verification is required, returns `{ deviceVerificationRequired: true, maskedEmail }` instead of completing sign-in.

### `lockSingleUser()`

Lock the app. Stops the sync engine and resets auth state to `'none'`. Does **not** sign out of Supabase, destroy the session, or clear local data — so unlocking is fast.

```ts
async function lockSingleUser(): Promise<void>
```

**Example:**

```ts
import { lockSingleUser } from '@prabhask5/stellar-engine/auth';

await lockSingleUser();
// Redirect to login/unlock screen
```

### `changeSingleUserGate(oldGate, newGate)`

Change the gate (code or password). Verifies the old gate locally against the cached `gateHash` when available, falling back to `signInWithPassword()` if no hash is cached. Uses `supabase.auth.updateUser()` to change the password.

```ts
async function changeSingleUserGate(
  oldGate: string,
  newGate: string
): Promise<{ error: string | null }>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `oldGate` | `string` | Current code or password |
| `newGate` | `string` | New code or password |

**Returns:** `{ error: null }` on success, or `{ error: string }` if the old gate is incorrect.

### `updateSingleUserProfile(profile)`

Update the user's profile in IndexedDB and Supabase `user_metadata`.

```ts
async function updateSingleUserProfile(
  profile: Record<string, unknown>
): Promise<{ error: string | null }>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `profile` | `Record<string, unknown>` | Updated profile fields (e.g., `{ firstName, lastName }`) |

### `changeSingleUserEmail(newEmail)`

Initiate an email change in single-user mode. Requires an internet connection. Calls `supabase.auth.updateUser({ email })` which sends a confirmation email to the new address. Use `completeSingleUserEmailChange()` after confirmation.

```ts
async function changeSingleUserEmail(
  newEmail: string
): Promise<{ error: string | null; confirmationRequired: boolean }>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `newEmail` | `string` | The new email address |

**Returns:** `{ error: null, confirmationRequired: true }` on success. Returns an error if offline or not set up.

### `completeSingleUserEmailChange()`

Complete an email change after the user confirms via the email link. Refreshes the session, updates the local IndexedDB config's `email` field, and updates the offline credentials cache.

```ts
async function completeSingleUserEmailChange(): Promise<{ error: string | null; newEmail: string | null }>
```

**Returns:** `{ error: null, newEmail: 'new@example.com' }` on success.

**Example:**

```ts
import { changeSingleUserEmail, completeSingleUserEmailChange } from '@prabhask5/stellar-engine/auth';

// Step 1: Initiate
const { error, confirmationRequired } = await changeSingleUserEmail('new@example.com');
if (confirmationRequired) {
  // Show "check your email" modal, listen for BroadcastChannel AUTH_CONFIRMED
  // with verificationType === 'email_change'
}

// Step 2: After confirmation
const { newEmail } = await completeSingleUserEmailChange();
```

### `resetSingleUser()`

Full reset: clears the single-user config from IndexedDB, signs out of Supabase, and clears all local data. After reset, the app should show the setup screen again.

```ts
async function resetSingleUser(): Promise<{ error: string | null }>
```

### `completeSingleUserSetup()`

Called after email confirmation succeeds (e.g., when the confirm page broadcasts `AUTH_CONFIRMED`).

```ts
async function completeSingleUserSetup(): Promise<{ error: string | null }>
```

### `completeDeviceVerification(tokenHash?)`

Called after device OTP verification succeeds. Trusts the current device and restores auth state.

```ts
async function completeDeviceVerification(
  tokenHash?: string
): Promise<{ error: string | null }>
```

### `linkSingleUserDevice(email, pin)`

Link a new device to an existing single-user account. Signs in with email + padded PIN, builds local config from `user_metadata`. Rate limiting with exponential backoff is applied since no local hash exists on a new device.

```ts
async function linkSingleUserDevice(
  email: string,
  pin: string
): Promise<{
  error: string | null;
  deviceVerificationRequired?: boolean;
  maskedEmail?: string;
  retryAfterMs?: number;
}>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `email` | `string` | The account email |
| `pin` | `string` | The PIN code or password |

**Returns:** `{ error: null }` on success. Includes `retryAfterMs` when rate-limited.

### `padPin(pin)`

Pad a PIN to meet Supabase's minimum password length. Must match across all clients (app + extension).

```ts
function padPin(pin: string): string
```

---

## Device Verification

Optional device trust system that requires email OTP verification on untrusted devices. Enable via `auth.deviceVerification.enabled`.

### `isDeviceTrusted(userId)`

```ts
async function isDeviceTrusted(userId: string): Promise<boolean>
```

### `trustCurrentDevice(userId)`

```ts
async function trustCurrentDevice(userId: string): Promise<void>
```

### `getTrustedDevices(userId)`

```ts
async function getTrustedDevices(userId: string): Promise<TrustedDevice[]>
```

### `removeTrustedDevice(id)`

```ts
async function removeTrustedDevice(id: string): Promise<void>
```

### `sendDeviceVerification(email)`

Sign out and send OTP to the email for device verification.

```ts
async function sendDeviceVerification(email: string): Promise<{ error: string | null }>
```

### `verifyDeviceCode(tokenHash)`

Verify an OTP token for device verification.

```ts
async function verifyDeviceCode(tokenHash: string): Promise<{ error: string | null }>
```

### `maskEmail(email)`

Mask an email for display (e.g., "pr••••@gmail.com").

```ts
function maskEmail(email: string): string
```

### `getDeviceLabel()`

Get a human-readable label for the current device (e.g., "Chrome on macOS").

```ts
function getDeviceLabel(): string
```

### `getCurrentDeviceId()`

Get the current device's stable ID.

```ts
function getCurrentDeviceId(): string
```

### `TrustedDevice`

```ts
interface TrustedDevice {
  id: string;
  userId: string;
  deviceId: string;
  deviceLabel: string | null;
  trustedAt: string;
  lastUsedAt: string;
}
```

---

## Stores

All stores are Svelte-compatible (implement `subscribe`).

### `syncStatusStore`

Svelte store tracking sync engine status.

**Type:** Svelte writable store of `SyncState`

```ts
interface SyncState {
  status: SyncStatus;           // 'idle' | 'syncing' | 'error' | 'offline'
  pendingCount: number;
  lastError: string | null;
  lastErrorDetails: string | null;
  syncErrors: SyncError[];
  lastSyncTime: string | null;
  syncMessage: string | null;
  isTabVisible: boolean;
  realtimeState: RealtimeState;
}
```

**Methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `subscribe` | `(cb) => unsubscribe` | Standard Svelte subscribe |
| `setStatus` | `(status: SyncStatus) => void` | Update sync status with min-display-time debounce |
| `setPendingCount` | `(count: number) => void` | Set pending operation count |
| `setError` | `(friendly: string \| null, raw?: string \| null) => void` | Set error messages |
| `addSyncError` | `(error: SyncError) => void` | Add a detailed sync error (max 10 kept) |
| `clearSyncErrors` | `() => void` | Clear all sync errors |
| `setLastSyncTime` | `(time: string) => void` | Set last successful sync timestamp |
| `setSyncMessage` | `(message: string \| null) => void` | Set human-readable status message |
| `setTabVisible` | `(visible: boolean) => void` | Track tab visibility |
| `setRealtimeState` | `(state: RealtimeState) => void` | Track realtime connection state |
| `reset` | `() => void` | Reset to initial idle state |

### `SyncError`

```ts
interface SyncError {
  table: string;
  operation: string;
  entityId: string;
  message: string;
  timestamp: string;
}
```

### `RealtimeState`

```ts
type RealtimeState = 'disconnected' | 'connecting' | 'connected' | 'error';
```

### `remoteChangesStore`

Svelte store managing incoming realtime changes, active editing state, and deferred changes for UI animations.

**Key methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `subscribe` | `(cb) => unsubscribe` | Standard Svelte subscribe |
| `recordRemoteChange` | `(entityId, entityType, fields, applied, eventType?, valueDelta?) => { deferred, actionType }` | Record an incoming remote change |
| `recordLocalChange` | `(entityId, entityType, actionType, fields?) => void` | Record a local change for animation |
| `startEditing` | `(entityId, entityType, formType, fields?) => void` | Mark entity as being edited |
| `stopEditing` | `(entityId, entityType) => RemoteChange[]` | Stop editing; returns deferred changes |
| `isEditing` | `(entityId, entityType) => boolean` | Check if entity is being edited |
| `wasRecentlyChanged` | `(entityId, entityType) => boolean` | Check if entity was recently changed |
| `getRecentChange` | `(entityId, entityType) => RemoteChange \| null` | Get recent change details |
| `markPendingDelete` | `(entityId, entityType) => Promise<void>` | Mark entity for delete animation |
| `isPendingDelete` | `(entityId, entityType) => boolean` | Check pending deletion status |
| `clear` | `() => void` | Clear all tracking |
| `destroy` | `() => void` | Stop cleanup interval |

### `RemoteActionType`

```ts
type RemoteActionType =
  | 'create' | 'delete' | 'toggle' | 'increment'
  | 'decrement' | 'reorder' | 'rename' | 'update';
```

### `isOnline`

Svelte readable store tracking network connectivity. Also provides lifecycle hooks.

**Type:** `Readable<boolean>` with additional methods.

| Method | Signature | Description |
|--------|-----------|-------------|
| `subscribe` | `(cb) => unsubscribe` | Standard Svelte subscribe; value is `true` when online |
| `init` | `() => void` | Initialize network listeners (idempotent) |
| `onReconnect` | `(callback) => unsubscribe` | Register callback for when connection is restored |
| `onDisconnect` | `(callback) => unsubscribe` | Register callback for when connection is lost |

### `authState`

Svelte store tracking authentication mode and session.

**Key methods:**

| Method | Signature | Description |
|--------|-----------|-------------|
| `subscribe` | `(cb) => unsubscribe` | Standard Svelte subscribe |
| `setSupabaseAuth` | `(session: Session) => void` | Set mode to `'supabase'` with session |
| `setOfflineAuth` | `(profile: OfflineCredentials) => void` | Set mode to `'offline'` with cached profile |
| `setNoAuth` | `(kickedMessage?: string) => void` | Set mode to `'none'` |
| `setLoading` | `(isLoading: boolean) => void` | Set loading state |
| `clearKickedMessage` | `() => void` | Clear the auth-kicked message |
| `updateSession` | `(session: Session \| null) => void` | Update session (e.g., on token refresh) |
| `updateUserProfile` | `(profile: Record<string, unknown>) => void` | Update profile info in current session |
| `reset` | `() => void` | Reset to initial state |

### `isAuthenticated`

Svelte derived readable store. `true` when auth mode is not `'none'` and loading is complete.

```ts
const isAuthenticated: Readable<boolean>
```

### `userDisplayInfo`

Svelte derived readable store providing user profile and email for display.

```ts
const userDisplayInfo: Readable<{
  profile: Record<string, unknown>;
  email: string;
} | null>
```

---

## Realtime

### `onRealtimeDataUpdate(callback)`

Subscribe to realtime data update notifications. The callback fires after a remote change is applied to the local database.

```ts
function onRealtimeDataUpdate(
  callback: (table: string, entityId: string) => void
): () => void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `callback` | `(table: string, entityId: string) => void` | Called with table name and entity ID on each remote update |

**Returns:** `() => void` -- Unsubscribe function.

---

## Supabase Client

### `supabase`

Proxy-based lazy singleton for the Supabase client. Created on first access using runtime config. Use for advanced or custom queries not covered by the engine's CRUD functions.

```ts
const supabase: SupabaseClient
```

**Example:**

```ts
import { supabase } from '@prabhask5/stellar-engine';

const { data, error } = await supabase
  .from('custom_table')
  .select('*')
  .eq('status', 'active');
```

---

## Runtime Config

### `initConfig()`

Initialize runtime configuration. Loads from localStorage cache first (instant), then validates against the server (`/api/config`). Supports offline PWA use via cache fallback.

```ts
async function initConfig(): Promise<AppConfig | null>
```

**Returns:** `AppConfig | null` -- The config if the app is configured, `null` otherwise.

### `getConfig()`

Get the current config synchronously. Returns the cached config or attempts to load from localStorage.

```ts
function getConfig(): AppConfig | null
```

### `setConfig(config)`

Set config directly and persist to localStorage cache. Used after a setup wizard completes.

```ts
function setConfig(config: AppConfig): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `AppConfig` | The configuration to set |

### `AppConfig`

```ts
interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  configured: boolean;
  // Optional email config
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  fromEmail?: string;
  fromName?: string;
  emailConfigured?: boolean;
  // HMAC secret for token generation
  shareTokenSecret?: string;
}
```

### `getDexieTableFor(table)`

Resolve the Dexie (IndexedDB) table name for a given Supabase table name. Returns the camelCase name derived via `snakeToCamel()`.

```ts
function getDexieTableFor(table: string): string
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `table` | `string` | The Supabase table name (e.g., `'goal_lists'`) |

**Returns:** `string` -- The corresponding Dexie table name (e.g., `'goalLists'`).

**Example:**

```ts
import { getDexieTableFor } from '@prabhask5/stellar-engine/config';

getDexieTableFor('goal_lists'); // 'goalLists'
getDexieTableFor('projects');   // 'projects'
```

---

## Email

Server-side email sending via SMTP. Requires the `nodemailer` dependency (included). Import from `@prabhask5/stellar-engine/email`.

### `sendEmail(config, params)`

Send an email via SMTP. Never throws — errors are returned in the result object.

```ts
async function sendEmail(
  config: EmailConfig,
  params: SendEmailParams
): Promise<{ success: boolean; error?: string }>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `EmailConfig` | SMTP server configuration |
| `params` | `SendEmailParams` | Email content (to, subject, html, text) |

**Returns:** `{ success: true }` on success, `{ success: false, error }` on failure.

**Example:**

```ts
import { sendEmail } from '@prabhask5/stellar-engine/email';

const result = await sendEmail(
  {
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpUser: 'user@example.com',
    smtpPass: 'password',
    fromEmail: 'noreply@example.com',
    fromName: 'My App'
  },
  {
    to: 'recipient@example.com',
    subject: 'Hello',
    html: '<p>Welcome!</p>',
    text: 'Welcome!'
  }
);
```

### `validateSmtpCredentials(config)`

Test SMTP connectivity by attempting to connect and authenticate. Matches the `{ valid, error }` pattern used by `validateSupabaseCredentials`.

```ts
async function validateSmtpCredentials(
  config: EmailConfig
): Promise<{ valid: boolean; error?: string }>
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `config` | `EmailConfig` | SMTP server configuration |

**Returns:** `{ valid: true }` if the connection succeeds, `{ valid: false, error }` otherwise.

### `EmailConfig`

```ts
interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  fromEmail: string;
  fromName: string;
}
```

### `SendEmailParams`

```ts
interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
}
```

---

## Debug

### `debug(level, ...args)`

Unified debug logging function. Only outputs when debug mode is enabled.

```ts
function debug(level: 'log' | 'warn' | 'error', ...args: unknown[]): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `level` | `'log' \| 'warn' \| 'error'` | Console method to use |
| `...args` | `unknown[]` | Arguments passed to `console[level]` |

### `isDebugMode()`

Check if debug mode is enabled. Reads from `localStorage` key `{prefix}_debug_mode`.

```ts
function isDebugMode(): boolean
```

### `setDebugMode(enabled)`

Enable or disable debug mode. Persists to `localStorage`.

```ts
function setDebugMode(enabled: boolean): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `enabled` | `boolean` | Whether to enable debug logging |

---

## Utilities

### `generateId()`

Generate a UUID v4.

```ts
function generateId(): string
```

**Returns:** A random UUID string (via `crypto.randomUUID()`).

### `now()`

Get the current timestamp as an ISO 8601 string.

```ts
function now(): string
```

**Returns:** ISO timestamp string (e.g., `"2025-01-15T12:34:56.789Z"`).

### `snakeToCamel(str)`

Convert a `snake_case` string to `camelCase`. Also strips invalid characters (non-alphanumeric except underscores) before converting. Used internally to derive Dexie table names from `supabaseName`.

```ts
function snakeToCamel(str: string): string
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `str` | `string` | The snake_case string to convert |

**Returns:** `string` -- The camelCase equivalent.

**Examples:**

```ts
import { snakeToCamel } from '@prabhask5/stellar-engine/utils';

snakeToCamel('goal_lists');    // 'goalLists'
snakeToCamel('projects');      // 'projects'
snakeToCamel('user_settings'); // 'userSettings'
```

### `calculateNewOrder(items, fromIndex, toIndex)`

Calculate a new fractional order value when moving an item to a new position in a sorted list. Minimizes the number of records that need updating.

```ts
function calculateNewOrder<T extends { order: number }>(
  items: T[],
  fromIndex: number,
  toIndex: number
): number
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `items` | `T[]` | Sorted array of items with `order` property |
| `fromIndex` | `number` | Current index of the item being moved |
| `toIndex` | `number` | Target index |

**Returns:** `number` -- The new order value for the moved item.

**Example:**

```ts
import { calculateNewOrder } from '@prabhask5/stellar-engine';

// items sorted by order: [{ order: 1 }, { order: 2 }, { order: 3 }]
const newOrder = calculateNewOrder(items, 0, 2);
// Returns 2.5 (between index 1 and 2)
```

---

## Svelte Actions

### `remoteChangeAnimation`

Svelte action that automatically applies CSS animation classes when remote changes arrive for an entity. Detects the action type and applies the corresponding animation.

```ts
function remoteChangeAnimation(
  node: HTMLElement,
  options: RemoteChangeOptions
): SvelteActionReturn
```

**Options:**

| Property | Type | Description |
|----------|------|-------------|
| `entityId` | `string` | Entity ID to watch |
| `entityType` | `string` | Table/entity type name |
| `fields` | `string[]` | Only animate if these fields changed |
| `animationClass` | `string` | Override the default CSS class |
| `onAction` | `(actionType, fields) => void` | Callback when action is detected |

**Animation class mapping:**

| Action Type | CSS Class |
|-------------|-----------|
| `create` | `item-created` |
| `delete` | `item-deleting` |
| `toggle` | `item-toggled` |
| `increment` | `counter-increment` |
| `decrement` | `counter-decrement` |
| `reorder` | `item-reordering` |
| `rename` | `text-changed` |
| `update` | `item-changed` |

**Example:**

```svelte
<div use:remoteChangeAnimation={{ entityId: item.id, entityType: 'tasks' }}>
  {item.name}
</div>
```

### `trackEditing`

Svelte action for form elements that tracks editing state. Defers remote changes while a manual-save form is open.

```ts
function trackEditing(
  node: HTMLElement,
  options: TrackEditingOptions
): SvelteActionReturn
```

**Options:**

| Property | Type | Description |
|----------|------|-------------|
| `entityId` | `string` | Entity being edited |
| `entityType` | `string` | Table/entity type name |
| `formType` | `'auto-save' \| 'manual-save'` | `'manual-save'` defers remote changes until form closes |
| `fields` | `string[]` | Fields being edited |
| `onDeferredChanges` | `(changes) => void` | Callback when form closes with pending deferred changes |

**Example:**

```svelte
<form use:trackEditing={{
  entityId: task.id,
  entityType: 'tasks',
  formType: 'manual-save'
}}>
  <input bind:value={task.name} />
  <button type="submit">Save</button>
</form>
```

### `triggerLocalAnimation(element, actionType)`

Programmatically trigger an animation on an element. Makes local actions animate the same way as remote actions.

```ts
function triggerLocalAnimation(
  element: HTMLElement | null,
  actionType: RemoteActionType
): void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `element` | `HTMLElement \| null` | Target DOM element |
| `actionType` | `RemoteActionType` | Animation type to apply |

**Example:**

```svelte
<script>
  import { triggerLocalAnimation } from '@prabhask5/stellar-engine';
  let element;

  function handleToggle() {
    triggerLocalAnimation(element, 'toggle');
  }
</script>

<div bind:this={element} on:click={handleToggle}>
  Toggle me
</div>
```

---

## Types

> **Subpath:** All types are available from `@prabhask5/stellar-engine/types`.

### `Session`

Re-exported from `@supabase/supabase-js`. Represents a Supabase auth session. Consumers can import this from the engine instead of depending on `@supabase/supabase-js` directly.

```ts
import type { Session } from '@prabhask5/stellar-engine/types';
```

### `SyncOperationItem`

Intent-based sync operation queued for background sync.

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
}
```

### `OperationType`

```ts
type OperationType = 'increment' | 'set' | 'create' | 'delete';
```

### `OfflineCredentials`

```ts
interface OfflineCredentials {
  id: string;
  userId: string;
  email: string;
  password: string;
  profile: Record<string, unknown>;
  cachedAt: string;
}
```

### `OfflineSession`

```ts
interface OfflineSession {
  id: string;
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

### `SyncStatus`

```ts
type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';
```

### `AuthMode`

```ts
type AuthMode = 'supabase' | 'offline' | 'none';
```

### `SingleUserGateType`

```ts
type SingleUserGateType = 'code' | 'password';
```

### `SingleUserConfig`

Configuration record stored in IndexedDB for single-user mode. Singleton with `id: 'config'`.

```ts
interface SingleUserConfig {
  id: string;                          // Always 'config' (singleton)
  gateType: SingleUserGateType;        // 'code' or 'password'
  codeLength?: 4 | 6;                  // Only when gateType is 'code'
  gateHash?: string;                   // SHA-256 hex (deprecated — kept for offline fallback)
  email?: string;                      // Real email for Supabase email/password auth
  profile: Record<string, unknown>;    // App-specific profile
  supabaseUserId?: string;             // User ID (set after first online setup)
  setupAt: string;
  updatedAt: string;
}
```
