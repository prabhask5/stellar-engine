# @prabhask5/stellar-engine: Architecture & System Design

## Table of Contents
1. [Authentication System](#1-authentication-system)
2. [Single-User Auth Mode](#2-single-user-auth-mode)
3. [Sync Engine](#3-sync-engine)
4. [Outbox Pattern & Operation Coalescing](#4-outbox-pattern--operation-coalescing)
5. [Conflict Resolution](#5-conflict-resolution)
6. [Realtime Subscriptions](#6-realtime-subscriptions)
7. [Tombstone System](#7-tombstone-system)
8. [Network State Machine](#8-network-state-machine)
9. [Egress Optimization](#9-egress-optimization)
10. [Data Flow Diagrams](#10-data-flow-diagrams)
11. [Debug & Observability](#11-debug--observability)
12. [Store & Data Factories](#12-store--data-factories)
13. [Install PWA Command & Scaffolding](#13-install-pwa-command--scaffolding)

---

## 1. Authentication System

The engine implements an authentication system that maintains full functionality offline. Your app can authenticate users through Supabase when online and fall back to cached credentials when offline.

### 1.1 Architecture Diagram

```
+------------------------------------------------------------------+
|                     AUTH STATE MACHINE                            |
|                                                                  |
|   +-----------+     +-----------+     +-----------+              |
|   |   none    |---->| supabase  |---->|  offline  |              |
|   | (no auth) |     | (online)  |     | (cached)  |              |
|   +-----------+     +-----+-----+     +-----+-----+              |
|         ^                 |                 |                    |
|         |   +-------------+                 |                    |
|         |   | On login:                     |                    |
|         |   | 1. unlockSingleUser()         |                    |
|         |   | 2. Cache credentials to       |                    |
|         |   |    IndexedDB                  |                    |
|         |   | 3. Set mode = 'supabase'      |                    |
|         |   +-------------------------------+                    |
|         |                                                        |
|         |   +-------------------------------+                    |
|         +---| On offline + cached creds:    |                    |
|             | 1. Verify email/password       |                    |
|             |    against IndexedDB cache     |                    |
|             | 2. Create offline session      |                    |
|             |    (random UUID token)         |                    |
|             | 3. Set mode = 'offline'        |                    |
|             +-------------------------------+                    |
+------------------------------------------------------------------+
```

### 1.2 Online Auth Flow

**File**: `src/supabase/auth.ts`

```
User enters email/password
        |
        v
supabase.auth.signInWithPassword()
        |
        +---> SUCCESS:
        |       |
        |       v
        |     cacheOfflineCredentials(email, password, user, session)
        |       |  --> Stores to IndexedDB: offlineCredentials table
        |       |  --> Verifies write with read-back (paranoid check)
        |       v
        |     authState.setSupabaseAuth(session)
        |
        +---> FAILURE: Show error to user
```

### 1.3 Offline Auth Flow

**Files**: `src/auth/offlineCredentials.ts`, `src/auth/offlineSession.ts`

```
User enters email/password (offline)
        |
        v
getOfflineCredentials() from IndexedDB
        |
        v
verifyOfflineCredentials(email, password, expectedUserId)
        |
        +---> Checks: userId match, email match, password match
        |
        +---> VALID:
        |       |
        |       v
        |     createOfflineSession(userId)
        |       |  --> Generates random UUID token
        |       |  --> Stores to IndexedDB: offlineSession table
        |       |  --> Read-back verification
        |       v
        |     authState.setOfflineAuth(profile)
        |
        +---> INVALID: { valid: false, reason: 'password_mismatch' }
```

### 1.4 Reconnection Security

When the device comes back online after offline usage:

1. The sync engine sets `authValidatedAfterReconnect = false`
2. **All sync operations are blocked** until auth is re-validated
3. The auth layer re-authenticates with Supabase using the cached credentials
4. On success: `markAuthValidated()` is called, sync resumes
5. On failure: The pending sync queue is cleared via `clearPendingSyncQueue()` to prevent unauthorized data from reaching the server

### 1.5 Auth State Store

**File**: `src/stores/authState.ts`

```typescript
interface AuthState {
  mode: AuthMode;                          // 'supabase' | 'offline' | 'none'
  session: Session | null;                 // Supabase JWT session
  offlineProfile: OfflineCredentials | null; // Cached credentials
  isLoading: boolean;                      // Initial auth check in progress
  authKickedMessage: string | null;        // Message when session expires
}
```

Derived stores:
- `isAuthenticated`: `mode !== 'none' && !isLoading`
- `userDisplayInfo`: Extracts user display fields from whichever auth mode is active

---

## 2. Single-User Auth Mode

The engine uses a **single-user auth mode** with a simplified PIN code or password gate. The user provides an email during first-time setup, and a PIN code (or password) that is padded and used as the real Supabase password via `supabase.auth.signUp()`. The PIN is verified server-side by Supabase via `supabase.auth.signInWithPassword()` — no client-side hash comparison. This gives the same `auth.uid()` as a regular email/password user, enabling proper RLS enforcement.

Optional email confirmation (`emailConfirmation.enabled`) blocks setup until the user confirms their email. Optional device verification (`deviceVerification.enabled`) requires OTP on untrusted devices.

### 2.1 Architecture Diagram

```
+------------------------------------------------------------------+
|               SINGLE-USER AUTH STATE MACHINE                      |
|                                                                  |
|   +-----------+     setupSingleUser()      +----------------+    |
|   | not setup |-----(creates account,----->| confirming     |    |
|   | (first    |     require email          | email          |    |
|   |  visit)   |     confirmation)          | (if enabled)   |    |
|   +-----------+          |                 +-------+--------+    |
|                          |                         |             |
|                          | (no confirmation        | email       |
|                          |  required)              | confirmed   |
|                          v                         v             |
|                    +-----------+                                  |
|                    | unlocked  |<-------------------------------+ |
|                    | (session  |                                  |
|                    |  active)  |                                  |
|                    +-----+-----+                                  |
|                          |                                       |
|                lockSingleUser()                                   |
|                (clears auth state, stops sync engine)             |
|                          |                                       |
|                          v                                       |
|                    +-----------+     unlockSingleUser()           |
|                    |  locked   |-----(calls signInWithPassword,   |
|                    | (config   |      may require device     +--->|
|                    |  exists,  |      verification)          |   |
|                    |  no sess) |           |                 |   |
|                    +-----------+           v                 |   |
|                                    +----------------+        |   |
|                                    | verifying      |--------+   |
|                                    | device         |            |
|                                    | (if enabled)   |            |
|                                    +----------------+            |
+------------------------------------------------------------------+
```

### 2.2 The `singleUserConfig` System Table

**File**: `src/auth/singleUser.ts`

When the engine is configured with `auth.singleUser`, an additional IndexedDB system table is created:

```
+--------------------+-----------------------------------------------+
| singleUserConfig   | Singleton config for single-user gate.         |
|                    | Key: 'config'                                 |
+--------------------+-----------------------------------------------+
```

```typescript
interface SingleUserConfig {
  id: string;                         // 'config' — singleton
  gateType: 'code' | 'password';
  codeLength?: 4 | 6;
  gateHash?: string;                  // SHA-256 hex (deprecated — offline fallback only)
  email?: string;                     // Real email for Supabase email/password auth
  profile: Record<string, unknown>;
  supabaseUserId?: string;
  setupAt: string;
  updatedAt: string;
}
```

Config is stored only in local IndexedDB. The Supabase `single_user_config` table has been removed — all auth data lives in Supabase `auth.users` (email, user_metadata) and local IndexedDB.

If `deviceVerification.enabled` is set, the `trusted_devices` Supabase table is used to track trusted device fingerprints per user.

### 2.3 Shared Hash Utility

**File**: `src/auth/crypto.ts`

A shared module provides SHA-256 hashing via the Web Crypto API. It is used by both the single-user gate and the offline credential system.

In the new auth model, `hashValue` is only used for offline PIN fallback. Online verification uses `signInWithPassword()` directly.

```typescript
// Hash a value to a 64-character hex string
async function hashValue(value: string): Promise<string>;

// Check if a stored value is already hashed (64-char hex)
function isAlreadyHashed(value: string): boolean;
```

### 2.4 Single-User Module API

**File**: `src/auth/singleUser.ts`

The module exports the following functions:

| Function | Purpose |
|----------|---------|
| `isSingleUserSetUp()` | Returns `true` if `singleUserConfig` exists in IndexedDB |
| `getSingleUserInfo()` | Returns non-sensitive display info (profile, gateType, codeLength) |
| `setupSingleUser(gate, profile, email)` | First-time setup: pads PIN, calls `supabase.auth.signUp()` with real email/password, stores config, caches offline credentials. May return `{ confirmationRequired: true }` if email confirmation is enabled |
| `unlockSingleUser(gate)` | Calls `signInWithPassword()` with stored email and padded PIN. May return `{ deviceVerificationRequired: true, maskedEmail }` if device verification is enabled and device is untrusted. Falls back to offline hash verification when offline |
| `completeSingleUserSetup()` | Called after email confirmation completes. Trusts device, sets auth state, starts sync |
| `completeDeviceVerification(tokenHash?)` | Called after device OTP verification. Trusts device, sets auth state, starts sync |
| `padPin(pin)` | Pads PIN to meet Supabase password minimum length requirement |
| `lockSingleUser()` | Stops sync engine, resets auth state to `'none'`; does NOT destroy session or sign out |
| `changeSingleUserGate(oldGate, newGate)` | Uses `signInWithPassword()` to verify old gate, `updateUser()` to set new padded gate as password |
| `updateSingleUserProfile(profile)` | Updates profile in IndexedDB and Supabase `user_metadata` |
| `changeSingleUserEmail(newEmail)` | Validates online, calls `updateUser({ email })`, returns `{ confirmationRequired: true }` on success |
| `completeSingleUserEmailChange()` | Refreshes session, reads new email, updates IndexedDB config and offline credentials |
| `resetSingleUser()` | Full reset: signs out of Supabase, clears all data, deletes config |

### 2.5 Setup Flow

```
User enters email + PIN + profile on first visit
  |
  v
setupSingleUser(gate, profile, email)
  |
  +---> padPin(gate) --> padded password
  |
  +---> supabase.auth.signUp({ email, password: padPin(gate), data: metadata })
  |       |
  |       +---> SUCCESS:
  |       |       Write SingleUserConfig to IndexedDB (with email)
  |       |       cacheOfflineCredentials() for offline fallback
  |       |       If emailConfirmation.enabled:
  |       |         return { confirmationRequired: true }
  |       |         --> App shows "check your email" modal
  |       |         --> User clicks email link → /confirm page
  |       |         --> BroadcastChannel sends AUTH_CONFIRMED
  |       |         --> completeSingleUserSetup() called
  |       |       Else:
  |       |         Auto-trust device, set authState, start sync
  |       |
  |       +---> FAILURE: return { error }
```

### 2.6 Unlock Flow

```
User enters PIN on return visit
  |
  v
unlockSingleUser(gate)
  |
  +---> ONLINE:
  |       supabase.auth.signInWithPassword({ email: config.email, password: padPin(gate) })
  |         FAILED → return { error: 'Incorrect code' }
  |         SUCCESS → check deviceVerification.enabled?
  |           NO  → touchTrustedDevice, set authState, done
  |           YES → isDeviceTrusted(userId)?
  |             YES → touchTrustedDevice, set authState, done
  |             NO  → sign out, sendDeviceVerification(email)
  |                   return { deviceVerificationRequired: true, maskedEmail }
  |                   --> App shows "new device" modal
  |                   --> User clicks email link → /confirm
  |                   --> BroadcastChannel sends AUTH_CONFIRMED
  |                   --> completeDeviceVerification() called
  |
  +---> OFFLINE:
          Verify gate hash against cached config (SHA-256 fallback)
          Restore offline session or cached Supabase session
```

### 2.7 Email Change Flow

```
User enters new email on profile page
  |
  v
changeSingleUserEmail(newEmail)
  |
  +---> Validate online (offline rejected)
  |
  +---> supabase.auth.updateUser({ email: newEmail })
  |
  +---> return { confirmationRequired: true }
  |
  v
Supabase sends confirmation email to new address
  |
  v
User clicks confirmation link → /confirm page
  |
  v
verifyOtp({ token_hash, type: 'email_change' })
  |
  v
BroadcastChannel sends AUTH_CONFIRMED with verificationType: 'email_change'
  |
  v
completeSingleUserEmailChange()
  |
  +---> refreshSession()
  +---> Read new email from session
  +---> Update IndexedDB singleUserConfig
  +---> Update offlineCredentials cache
  +---> return { newEmail }
```

### 2.8 How `resolveAuthState` Handles Single-User Mode

**File**: `src/auth/resolveAuthState.ts`

When `auth.singleUser` is configured, `resolveAuthState()` delegates to a dedicated `resolveSingleUserAuthState()` function. The result includes a `singleUserSetUp` boolean so the app can distinguish between "not set up" and "locked".

Note: `fetchAndCacheRemoteConfig` has been removed since the `single_user_config` Supabase table no longer exists. Auth state resolution now relies solely on local IndexedDB config and Supabase session state.

```typescript
interface AuthStateResult {
  session: Session | null;
  authMode: 'supabase' | 'offline' | 'none';
  offlineProfile: OfflineCredentials | null;
  singleUserSetUp?: boolean;  // only present in single-user mode
}
```

**Legacy config detection:** If a config exists but has no `email` field, it is from the pre-email auth era (anonymous auth). The resolver clears all legacy auth artifacts (`singleUserConfig`, `offlineCredentials`, `offlineSession`) and returns `singleUserSetUp: false`, forcing the user through the new setup flow.

Resolution logic:

| Config Exists | Session State | Result |
|---------------|---------------|--------|
| No (or legacy without email) | -- | `authMode: 'none'`, `singleUserSetUp: false` (needs first-time setup) |
| Yes | Valid Supabase session | `authMode: 'supabase'`, `singleUserSetUp: true` |
| Yes | Expired but offline | `authMode: 'supabase'` (usable offline), `singleUserSetUp: true` |
| Yes | Offline session only | `authMode: 'offline'`, `singleUserSetUp: true` |
| Yes | No session | `authMode: 'none'`, `singleUserSetUp: true` (locked) |

---

## 3. Sync Engine

**File**: `src/engine.ts`

The sync engine is the core of multi-device synchronization. It implements a **push-then-pull architecture** with mutex locking, cursor-based incremental sync, egress monitoring, and tombstone cleanup.

### 3.1 Core Rules

```
Rule 1: All reads come from local DB (IndexedDB)
Rule 2: All writes go to local DB first, immediately
Rule 3: Every write creates a pending operation in the outbox
Rule 4: Sync loop ships outbox to server in background
Rule 5: On refresh, load local state instantly, then run background sync
```

### 3.2 Sync Lifecycle

```
  User Action (write)
        |
        v
  Repository Layer (your app)
        |
        +---> 1. Write to local IndexedDB (instant)
        |
        +---> 2. Queue intent-based operation to syncQueue
        |
        +---> 3. Mark entity as "recently modified" (2s TTL)
        |
        v
  scheduleSyncPush()  (2s debounce)
        |
        v
  runFullSync(quiet=false, skipPull=realtime_healthy)
        |
        +---> acquireSyncLock()  (mutex, 60s timeout)
        |
        +---> needsAuthValidation()?  --> block if yes
        |
        +---> getCurrentUserId()  (validates session)
        |
        v
  +------ PUSH PHASE ------+
  |                         |
  | coalescePendingOps()    |  <-- Reduces N operations to M (M << N)
  |         |               |
  | for each pending item:  |
  |   processSyncItem()     |  <-- Transforms intent to Supabase mutation
  |   removeSyncItem()      |  <-- Dequeue on success
  |   incrementRetry()      |  <-- Backoff on failure
  |                         |
  +----------|-------------+
             |
             v
  +------ PULL PHASE ------+
  | (skipped if realtime    |
  |  is healthy)            |
  |                         |
  | pullRemoteChanges()     |
  |   |                     |
  |   +-> Parallel SELECT   |
  |   |   queries per       |
  |   |   entity table      |
  |   |   WHERE updated_at  |
  |   |   > cursor          |
  |   |                     |
  |   +-> For each record:  |
  |       - Skip recently   |
  |         modified        |
  |       - Skip realtime-  |
  |         processed       |
  |       - Conflict        |
  |         resolution      |
  |       - Apply to local  |
  |                         |
  +----------|-------------+
             |
             v
  releaseSyncLock()
  notifySyncComplete()  --> All stores refresh from local
```

### 3.3 Mutex Lock Implementation

The sync engine uses a **promise-based async mutex** with stale lock detection:

```
acquireSyncLock()
  |
  +---> lockPromise !== null?
  |       |
  |       YES --> Is lock stale (held > 60s)?
  |       |         |
  |       |         YES --> Force release, acquire
  |       |         NO  --> Return false (skip this sync)
  |       |
  |       NO --> Create new lock promise, record timestamp
  |
  +---> return true
```

This prevents concurrent sync cycles from corrupting state while also handling deadlocks from crashed syncs.

### 3.4 Cursor-Based Incremental Sync

```
localStorage: lastSyncCursor_{userId} = "2024-01-15T10:30:00.000Z"
                                              |
                                              v
    SELECT * FROM entity_table WHERE updated_at > '2024-01-15T10:30:00.000Z'
    ... (all entity tables in parallel)
                                              |
                                              v
    Track max(updated_at) across all results
                                              |
                                              v
    localStorage: lastSyncCursor_{userId} = "2024-01-15T10:35:22.000Z"
```

Key design decisions:
- **Per-user cursors** prevent cross-user sync contamination after logout/login
- **Parallel queries** across all entity tables reduce wall-clock time per sync cycle
- **30-second timeout** with `withTimeout()` wrapper prevents hanging syncs
- **Column-level SELECT** (explicit columns per table) instead of `SELECT *` to minimize egress

### 3.5 Watchdog & Resilience

```
Watchdog (every 15s):
  |
  +---> Is sync lock held > 45s?
  |       YES --> Force release (stuck sync detected)
  |
  +---> Clean up recently modified entity tracking
  +---> Clean up realtime tracking
```

### 3.6 Session Validation & Caching

To avoid a network call (`getUser()`) every sync cycle, the engine caches successful auth validation for 1 hour:

```
getCurrentUserId()
  |
  +---> getSession()  (local, no network)
  |
  +---> Is session expired?
  |       YES --> refreshSession() (network)
  |
  +---> Is cached validation < 1 hour old AND same userId?
  |       YES --> return userId (no network call!)
  |       NO  --> getUser() (network call to validate token)
  |
  +---> Cache result for next hour
```

This optimization alone saves approximately **720 Supabase auth API calls per day** for an active user.

---

## 4. Outbox Pattern & Operation Coalescing

### 4.1 Intent-Based Operations

**File**: `src/types.ts`

Instead of recording final state, the engine records the **user's intent**:

```typescript
type OperationType = 'increment' | 'set' | 'create' | 'delete';

interface SyncOperationItem {
  id?: number;              // Auto-increment queue ID
  table: SyncEntityType;    // Target table
  entityId: string;         // UUID of affected entity
  operationType: OperationType;
  field?: string;           // For field-level operations
  value?: unknown;          // Delta (increment), new value (set), or payload (create)
  timestamp: string;        // ISO timestamp for backoff calculation
  retries: number;          // Failed attempt count (max 5)
}
```

**Why intent-based?** Consider a user rapidly clicking "+1" on a counter 50 times:

```
Without intent-preservation:
  50 x SET current_value = N  --> 50 Supabase UPDATE requests

With intent-preservation:
  50 x INCREMENT +1           --> Coalesced to 1 x INCREMENT +50
                              --> 1 Supabase UPDATE request
```

### 4.2 Coalescing Engine

**File**: `src/queue.ts`

The coalescing engine runs as a **single-pass, in-memory algorithm** before every push. It processes operations grouped by entity:

```
INPUT: Queue with N operations
  |
  v
Step 1: Group by entity (table:entityId)
  |
  v
Step 2: For each entity group, apply cross-operation rules:
  |
  +---> CREATE + DELETE = cancel both (entity never needs to exist)
  +---> UPDATE(s) + DELETE = keep only DELETE
  +---> CREATE + UPDATE(s) = merge updates into CREATE payload
  +---> CREATE + SET(s) = merge sets into CREATE payload
  +---> INCREMENT(s) + SET (same field) = drop increments
  +---> SET + INCREMENT(s) (same field) = combine into final SET
  |
  v
Step 3: Coalesce same-type operations:
  |
  +---> Multiple INCREMENTs (same field) = sum deltas
  +---> Multiple SETs (same entity) = merge into single SET
  |
  v
Step 4: Remove no-ops:
  |
  +---> Zero-delta increments (INCREMENT +0)
  +---> Empty SETs or timestamp-only SETs
  |
  v
Step 5: Batch apply (bulkDelete + transaction updates)
  |
  v
OUTPUT: Queue with M operations (M << N)
```

### 4.3 Retry & Backoff

**File**: `src/queue.ts`

```
Retry #0: Immediate
Retry #1: 1 second backoff
Retry #2: 2 second backoff
Retry #3: 4 second backoff
Retry #4: 8 second backoff
Retry #5: PERMANENTLY FAILED --> item removed from queue
```

Errors are classified as **transient** (network, timeout, rate-limit, 5xx) or **persistent** (auth, validation, RLS). Transient errors suppress UI error indicators until retry #3.

---

## 5. Conflict Resolution

**File**: `src/conflicts.ts`

The engine implements a **three-tier, field-level conflict resolution** system.

### 5.1 Three-Tier Resolution Diagram

```
Remote change arrives for entity X
  |
  v
Does entity X exist locally?
  |
  NO --> Accept remote entirely (Tier 0: no conflict)
  |
  YES --> Does local have pending operations for X?
            |
            NO --> Is remote.updated_at > local.updated_at?
            |       |
            |       YES --> Accept remote (Tier 0: no conflict)
            |       NO  --> Keep local (remote is stale)
            |
            YES --> CONFLICT DETECTED: Enter field-level resolution
                      |
                      v
                For each field in union(local_fields, remote_fields):
                      |
                      +---> Field in EXCLUDED_FIELDS (id, user_id, etc)?
                      |       YES --> Skip
                      |
                      +---> Values are equal?
                      |       YES --> Skip (Tier 1: auto-merge, non-overlapping)
                      |
                      +---> Field has pending local operations?
                      |       YES --> LOCAL WINS (Tier 2: local_pending strategy)
                      |
                      +---> Field is numeric merge candidate?
                      |       YES --> Last-write-wins with tiebreaker
                      |
                      +---> DEFAULT: Last-write-wins (Tier 3)
                              |
                              +---> Compare timestamps
                              |       |
                              |       local > remote --> LOCAL WINS
                              |       remote > local --> REMOTE WINS
                              |       EQUAL --> Device ID tiebreaker
                              |                   |
                              |                   lower deviceId WINS
                              |                   (deterministic across
                              |                    all devices)
                              v
                      Store FieldConflictResolution
```

### 5.2 Resolution Strategies

| Strategy | When Applied | Behavior |
|----------|-------------|----------|
| `local_pending` | Field has queued operations | Local value preserved unconditionally |
| `delete_wins` | Remote has `deleted=true` | Delete always wins over edits (prevents resurrection) |
| `numeric_merge` | Numeric counter fields (e.g., `current_value`, `elapsed_duration`) | Falls back to last-write-wins (true merge would require operation inbox) |
| `last_write` | All other fields | Most recent timestamp wins; device_id breaks ties |

### 5.3 Device ID Tiebreaker

**File**: `src/deviceId.ts`

When two devices modify the same field at the exact same millisecond:

```typescript
// Lower deviceId wins (arbitrary but CONSISTENT across all devices)
if (localDeviceId < remoteDeviceId) {
  winner = 'local';
} else {
  winner = 'remote';
}
```

Device IDs are **UUID v4** values stored in `localStorage`. They persist across sessions but are unique per browser/device. The lexicographic ordering of UUIDs provides a deterministic, consistent tiebreaker that produces the same result regardless of which device processes the conflict first.

### 5.4 Conflict History

Every resolved conflict is logged to the `conflictHistory` table:

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

History is auto-cleaned after 30 days via `cleanupConflictHistory()`.

---

## 6. Realtime Subscriptions

**File**: `src/realtime.ts`

### 6.1 Architecture

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
|  Security: RLS policies handle filtering (no user_id filter)     |
+------------------------------------------------------------------+
```

### 6.2 Consolidated Channel Pattern

Instead of N separate channels (one per table), the engine uses a **single channel** with N event subscriptions:

```typescript
const channelName = `${prefix}_sync_${userId}`;
state.channel = supabase.channel(channelName);

for (const table of REALTIME_TABLES) {
  state.channel = state.channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table },
    (payload) => handleRealtimeChange(table, payload)
  );
}
```

This reduces WebSocket overhead from N connections to 1.

### 6.3 Echo Suppression

When device A pushes a change, Supabase broadcasts it to all subscribers including device A. The realtime handler **skips changes from its own device**:

```typescript
function isOwnDeviceChange(record: Record<string, unknown>): boolean {
  return record.device_id === state.deviceId;
}
```

### 6.4 Deduplication with Polling

Realtime and polling can both deliver the same change. A **recently processed tracking map** with 2-second TTL prevents duplicate processing:

```
Change arrives via Realtime
  --> Process it
  --> Mark entityId in recentlyProcessedByRealtime map

Later, same change arrives via polling
  --> Check wasRecentlyProcessedByRealtime(entityId)
  --> TRUE --> Skip (already applied)
```

### 6.5 Reconnection Strategy

```
Connection lost
  |
  v
Is device offline?
  YES --> pauseRealtime(), wait for 'online' event
  NO  --> scheduleReconnect()
            |
            v
          Attempt 1: 1s delay
          Attempt 2: 2s delay
          Attempt 3: 4s delay
          Attempt 4: 8s delay
          Attempt 5: 16s delay
          MAX REACHED --> Fall back to polling-only mode
```

The `reconnectScheduled` flag prevents duplicate reconnect attempts when both `CHANNEL_ERROR` and `CLOSED` events fire in sequence.

---

## 7. Tombstone System

**File**: `src/engine.ts`

The engine uses **soft deletes** with a `deleted` boolean flag instead of hard deletes. This enables multi-device sync (all devices must learn about deletions) while preventing data resurrection.

### 7.1 Soft Delete Flow

```
User deletes item on Device A
  |
  v
Local: item.deleted = true, item.updated_at = now()
  |
  v
Queue: { operationType: 'delete', entityId: ... }
  |
  v
Push to Supabase: UPDATE SET deleted=true, updated_at=now()
  |
  v
Realtime broadcasts UPDATE to Device B
  |
  v
Device B receives soft delete:
  1. Detect isSoftDelete (deleted=true, was false locally)
  2. Play delete animation BEFORE writing to DB
  3. Write soft-deleted record to local DB
  4. UI reactively removes item from display
```

### 7.2 Tombstone Cleanup

```
+------------------------------------------------------------------+
|  TOMBSTONE LIFECYCLE                                             |
|                                                                  |
|  Day 0: Item soft-deleted (deleted=true)                         |
|          - All devices eventually sync the tombstone             |
|          - UI filters out deleted items                          |
|                                                                  |
|  Day 1+: Local cleanup runs                                     |
|          - cleanupLocalTombstones()                              |
|          - Removes records where deleted=true AND                |
|            updated_at < (now - 1 day)                            |
|          - Runs across all entity tables                         |
|                                                                  |
|  Daily: Server cleanup runs (max once per 24 hours)              |
|          - cleanupServerTombstones()                             |
|          - HARD DELETES from PostgreSQL:                         |
|            DELETE FROM table                                     |
|            WHERE deleted=true AND updated_at < cutoff            |
|          - Iterates all entity tables                            |
|          - lastServerCleanup timestamp prevents re-running       |
+------------------------------------------------------------------+
```

Configuration constants:
- `TOMBSTONE_MAX_AGE_DAYS = 1` (local cleanup after 1 day)
- `CLEANUP_INTERVAL_MS = 86400000` (server cleanup max once per 24 hours)

### 7.3 Delete-Wins Guarantee

When a conflict involves a deleted entity:

```
Remote says: deleted = true
Local has: pending edits (but no pending delete)
  --> Remote delete WINS (prevents resurrection)
  --> "delete_wins" strategy applied

Local says: pending delete operation
Remote has: edits (but not deleted)
  --> Local delete WINS (local_pending strategy)
  --> Entity stays deleted
```

This is a deliberate design choice: **deletes are irreversible in conflict scenarios** to prevent confusing "ghost" resurrections.

---

## 8. Network State Machine

**File**: `src/stores/network.ts`

### 8.1 State Diagram

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

### 8.2 iOS PWA Special Handling

iOS Safari does not reliably fire `online`/`offline` events in PWA standalone mode. The network store listens for `visibilitychange` events as a fallback:

```typescript
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const nowOnline = navigator.onLine;
    setIfChanged(nowOnline);
    if (nowOnline && wasOffline) {
      wasOffline = false;
      setTimeout(() => {
        runCallbacksSequentially(reconnectCallbacks, 'Reconnect');
      }, 500);
    }
  }
});
```

### 8.3 Sequential Callback Execution

Reconnect callbacks are executed **sequentially with async/await**, not concurrently. This ensures auth validation completes before sync is triggered:

```
Online event fires
  |
  v
500ms stabilization delay
  |
  v
Callback 1: Validate auth credentials    (async, awaited)
  |
  v
Callback 2: Start realtime subscriptions (async, awaited)
  |
  v
Callback 3: Run full sync                (async, awaited)
```

---

## 9. Egress Optimization

The engine is designed to minimize Supabase bandwidth (egress) consumption. Here is a summary of every optimization.

### 9.1 Column Selection

**File**: `src/engine.ts`

Instead of `SELECT *`, every query explicitly lists columns:

```typescript
const COLUMNS = {
  entity_a: 'id,user_id,name,created_at,updated_at,deleted,_version,device_id',
  entity_b: 'id,parent_id,name,value,completed,order,...',
  // ... all entity tables
};
```

This prevents downloading columns that may be added to PostgreSQL but are not needed client-side.

### 9.2 Queue Coalescing

50 rapid increments become 1 UPDATE request. A create-then-delete sequence becomes 0 requests. This is the single largest egress reduction.

### 9.3 Realtime-First Strategy

```typescript
const skipPull = isRealtimeHealthy();
if (skipPull) {
  debugLog('[SYNC] Realtime healthy - push-only mode (skipping pull)');
}
```

When the WebSocket connection is healthy, user-triggered syncs **skip the pull phase entirely**. Changes from other devices arrive via realtime instead of polling all entity tables.

### 9.4 Cursor-Based Incremental Pull

Only records modified since the last sync are fetched:

```sql
SELECT ... FROM table WHERE updated_at > :cursor
```

### 9.5 Visibility-Based Sync Throttling

```
Tab hidden for < 5 minutes --> No sync on return
Tab hidden for > 5 minutes --> Sync on return (data may be stale)
```

Constants:
- `VISIBILITY_SYNC_MIN_AWAY_MS = 300000` (5 minutes)
- `SYNC_INTERVAL_MS = 900000` (15-minute periodic sync)

### 9.6 User Validation Caching

`getUser()` API call cached for 1 hour:
- `USER_VALIDATION_INTERVAL_MS = 3600000`
- Saves approximately 720 API calls/day for an active user

### 9.7 Online Reconnect Cooldown

```
ONLINE_RECONNECT_COOLDOWN_MS = 120000  // 2 minutes
```

If a sync completed less than 2 minutes before coming back online, the reconnect sync is skipped.

### 9.8 Egress Tracking

The engine tracks bytes transferred per table and per sync cycle:

```typescript
interface EgressStats {
  totalBytes: number;
  totalRecords: number;
  byTable: Record<string, { bytes: number; records: number }>;
  sessionStart: string;
}
```

Accessible via `window.__{prefix}Egress()` in debug mode (prefix is configurable).

---

## 10. Data Flow Diagrams

### 10.1 Creating an Entity

```
User creates a new item (e.g., a task titled "Review report")
  |
  v
UI Component: repository.createEntity("Review report")
  |
  v
Repository: db.transaction('rw', [db.entities, db.syncQueue], async () => {
  |
  +---> 1. Generate UUID: crypto.randomUUID()
  |
  +---> 2. Write to IndexedDB:
  |        db.entities.add({
  |          id: uuid, name: "Review report",
  |          order: 0, completed: false,
  |          user_id, created_at, updated_at,
  |          deleted: false, _version: 1, device_id
  |        })
  |
  +---> 3. Queue sync operation:
  |        db.syncQueue.add({
  |          table: 'entities',
  |          entityId: uuid,
  |          operationType: 'create',
  |          value: { ...full payload },
  |          timestamp: now, retries: 0
  |        })
  |
  +---> 4. markEntityModified(uuid)  // 2s protection
  })
  |
  v
UI updates INSTANTLY (reads from local IndexedDB)
  |
  v
scheduleSyncPush()  (2s debounce timer starts)
  |
  v  (2 seconds later)
runFullSync()
  |
  +---> coalescePendingOps()  // No-op for single create
  |
  +---> processSyncItem(): INSERT INTO entities ...
  |       +---> Supabase returns { id: uuid }
  |       +---> removeSyncItem()
  |
  +---> pullRemoteChanges() or skip (if realtime healthy)
  |
  v
Supabase broadcasts INSERT to other devices via Realtime
```

### 10.2 Editing Across Devices

```
Device A (phone):                    Device B (laptop):
  |                                    |
  v                                    |
Edit entity name to                    |
"Updated title"                        |
  |                                    |
  v                                    |
Local write + queue SET op             |
  |                                    |
  v                                    |
Push to Supabase:                      |
UPDATE entities                        |
SET name='Updated title',              |
    device_id='device-A-uuid',         |
    updated_at=now()                   |
WHERE id='entity-uuid'                |
  |                                    |
  +-- Realtime broadcast ------------->|
                                       v
                          handleRealtimeChange()
                                       |
                                       v
                          isOwnDeviceChange? NO
                          wasRecentlyProcessed? NO
                                       |
                                       v
                          localEntity exists? YES
                          hasPendingOps? NO
                          remote.updated_at > local? YES
                                       |
                                       v
                          db.entities.put(newRecord)
                                       |
                                       v
                          notifyDataUpdate('entities', id)
                                       |
                                       v
                          Store refreshes from local
                          UI shows "Updated title"
```

### 10.3 Handling Conflicts

```
Device A (offline):                  Device B (online):
  |                                    |
  v                                    v
Edit name to "Alpha"                 Edit name to "Beta"
Edit order to 3                      (no order change)
  |                                    |
  v                                    v
Queue: SET name="Alpha"              Push immediately:
Queue: SET order=3                   name="Beta" pushed to server
  |                                    |
  v (comes online)                     |
runFullSync()                          |
  |                                    |
  +---> PUSH: SET name="Alpha", SET order=3
  |       (coalesced into single SET)
  |
  +---> PULL: Gets record with name="Beta" from server
  |       (server has Beta because B pushed first)
  |
  +---> CONFLICT: Entity has pending ops (name, order)
  |
  +---> resolveConflicts():
  |
  |     Field "name":
  |       - Has pending local op? YES
  |       - Strategy: local_pending
  |       - Winner: LOCAL ("Alpha")
  |
  |     Field "order":
  |       - Has pending local op? YES
  |       - Strategy: local_pending
  |       - Winner: LOCAL (3)
  |
  |     Other fields (completed, etc):
  |       - No pending ops, values equal
  |       - Auto-merged (Tier 1)
  |
  +---> Merged entity: { name: "Alpha", order: 3, ... }
  |
  +---> storeConflictHistory() for audit
  |
  +---> PUSH again: name="Alpha" overwrites "Beta" on server
```

### 10.4 Offline-to-Online Transition

```
OFFLINE STATE                          ONLINE TRANSITION
+------------------+                   +---------------------------+
| User has been    |  'online' event   | 1. Network store fires    |
| working offline  |------------------>|    reconnect callbacks     |
| for 2 hours      |                   |    (sequential, awaited)  |
|                  |                   |                           |
| Local changes:   |                   | 2. AUTH VALIDATION:       |
| - Created 3 items|                   |    - getSession()         |
| - Edited 5 items |                   |    - Verify with Supabase |
| - Deleted 1 item |                   |    - markAuthValidated()  |
|                  |                   |    OR clearPendingQueue() |
| Sync queue:      |                   |                           |
| 12 operations    |                   | 3. START REALTIME:        |
| pending          |                   |    - Open WebSocket       |
+------------------+                   |    - Subscribe all tables |
                                       |                           |
                                       | 4. RUN FULL SYNC:         |
                                       |    a. coalescePendingOps() |
                                       |       12 ops -> 6 ops     |
                                       |                           |
                                       |    b. PUSH 6 operations   |
                                       |       to Supabase         |
                                       |                           |
                                       |    c. PULL all changes    |
                                       |       since last cursor   |
                                       |       (2 hours of data    |
                                       |        from other devices)|
                                       |                           |
                                       |    d. Conflict resolution |
                                       |       for any overlapping |
                                       |       edits               |
                                       |                           |
                                       | 5. notifySyncComplete()   |
                                       |    All stores refresh     |
                                       +---------------------------+
```

---

## 11. Debug & Observability

### 11.1 Debug Mode

**File**: `src/debug.ts`

Debug mode is toggled via `localStorage`:

```javascript
localStorage.setItem('{prefix}_debug_mode', 'true');
```

The prefix is configurable when initializing the engine. When enabled, all `debugLog()`, `debugWarn()`, and `debugError()` calls produce console output. When disabled, they are no-ops (zero overhead).

### 11.2 Console Debug Functions

Available in debug mode via the browser console. Function names are prefixed with a configurable prefix (shown here as `__{prefix}`):

| Function | Purpose |
|----------|---------|
| `window.__{prefix}SyncStats()` | Total sync cycles, last-minute cycle count, last 10 cycle details |
| `window.__{prefix}Egress()` | Total bandwidth consumed, per-table breakdown with percentages, recent cycle sizes |
| `window.__{prefix}Tombstones()` | Count of tombstones per table (local + server) |
| `window.__{prefix}Tombstones({ cleanup: true, force: true })` | Manually trigger tombstone cleanup |

### 11.3 Logging Prefixes

All log messages use structured prefixes for filtering:

| Prefix | Source | Examples |
|--------|--------|---------|
| `[SYNC]` | Sync engine | Push/pull operations, cursor updates, lock management |
| `[Realtime]` | WebSocket manager | Connection state, incoming changes, echo suppression |
| `[Conflict]` | Conflict resolver | Field resolutions, history storage |
| `[Tombstone]` | Cleanup system | Local/server cleanup counts |
| `[Auth]` | Auth layer | Login, credential caching, session validation |
| `[Network]` | Network store | Callback execution errors |

### 11.4 Sync Status Store

**File**: `src/stores/sync.ts`

The sync engine maintains a reactive store that drives the UI sync indicator:

```typescript
interface SyncStatus {
  status: 'idle' | 'syncing' | 'error' | 'offline';
  pendingCount: number;
  lastSyncTime: string | null;
  syncMessage: string;
  error: { title: string; details: string } | null;
  syncErrors: SyncError[];  // Recent push failures with timestamps
}
```

### 11.5 Egress Monitoring Output Example

```
=== EGRESS STATS ===
Session started: 2024-01-15T08:00:00.000Z
Total egress: 45.23 KB (312 records)

--- BY TABLE ---
  table_a: 18.50 KB (180 records, 40.9%)
  table_b: 8.20 KB (45 records, 18.1%)
  table_c: 6.30 KB (30 records, 13.9%)
  table_d: 4.10 KB (12 records, 9.1%)
  ...

--- RECENT SYNC CYCLES ---
  2024-01-15T10:30:00Z: 2.45 KB (18 records)
  2024-01-15T10:35:00Z: 0 B (0 records)  [push-only, realtime healthy]
  2024-01-15T10:40:00Z: 1.20 KB (8 records)
```

---

## File Map

| Layer | File | Purpose |
|-------|------|---------|
| Sync Engine | `src/engine.ts` | Push/pull, hydration, tombstone cleanup |
| Sync Queue | `src/queue.ts` | Outbox queue, coalescing engine, retry logic |
| Sync Operations | `src/operations.ts` | Operation-to-mutation transforms |
| Sync Types | `src/types.ts` | Intent-based operation type system |
| Conflict Resolution | `src/conflicts.ts` | Three-tier field-level conflict resolver |
| Realtime | `src/realtime.ts` | WebSocket subscription manager |
| Device ID | `src/deviceId.ts` | Deterministic tiebreaker generation |
| Auth | `src/supabase/auth.ts` | Supabase auth with offline credential caching |
| Supabase Client | `src/supabase/client.ts` | Supabase client initialization |
| Crypto Utils | `src/auth/crypto.ts` | SHA-256 hashing via Web Crypto API |
| Single-User Auth | `src/auth/singleUser.ts` | PIN gate with real Supabase email/password auth |
| Device Verification | `src/auth/deviceVerification.ts` | Device trust management + OTP verification |
| Auth State Resolver | `src/auth/resolveAuthState.ts` | Auth state resolution for single-user mode |
| Offline Credentials | `src/auth/offlineCredentials.ts` | IndexedDB credential cache |
| Offline Session | `src/auth/offlineSession.ts` | Offline session token management |
| Auth State | `src/stores/authState.ts` | Tri-modal auth state store |
| Network Store | `src/stores/network.ts` | Online/offline detection with iOS PWA handling |
| Sync Status Store | `src/stores/sync.ts` | Reactive sync status for UI indicators |
| Remote Changes | `src/stores/remoteChanges.ts` | Remote change notification store |
| Remote Change Actions | `src/actions/remoteChange.ts` | Remote change handling logic |
| Reconnect Handler | `src/reconnectHandler.ts` | Reconnection orchestration |
| Runtime Config | `src/runtime/runtimeConfig.ts` | Runtime Supabase config with localStorage cache |
| Debug | `src/debug.ts` | Conditional debug logging system |
| Config | `src/config.ts` | Engine configuration and constants |
| Utils | `src/utils.ts` | Shared utility functions |
| Store Factories | `src/stores/factories.ts` | Generic collection/detail store factories |
| Entry Point | `src/index.ts` | Public API and exports |

---

## 12. Store & Data Factories

The engine provides generic factory functions and helpers that eliminate repetitive boilerplate in consumer applications.

### 12.1 Store Factories

**File**: `src/stores/factories.ts`

Consumer apps typically create ~10 collection stores and ~4 detail stores, each repeating the same ~50-line scaffolding: writable creation, loading state management, sync-complete listener registration, and refresh logic. The store factories extract this pattern:

```
+-----------------------------------------+     +----------------------------------+
|  createCollectionStore<T>(config)       |     |  Consumer Store                  |
|                                         |     |                                  |
|  Handles automatically:                 |     |  Only needs to define:           |
|  - writable([]) + loading writable      |---->|  - load: () => queryAll(...)     |
|  - loading.set(true/false)              |     |  - Custom methods (create,       |
|  - onSyncComplete auto-refresh          |     |    update, delete, reorder)      |
|  - typeof window guard                  |     |                                  |
|  - refresh() without loading toggle     |     |  ~50% less code per store        |
|  - mutate() for optimistic updates      |     |                                  |
+-----------------------------------------+     +----------------------------------+
```

The `createDetailStore<T>(config)` follows the same pattern for single-entity views, adding ID tracking so the sync-complete listener refreshes the correct entity.

### 12.2 Query & Repository Helpers

**File**: `src/data.ts` (added to the existing data module)

Four helper functions eliminate the most common repetitive patterns in query and repository code:

| Helper | Pattern Eliminated |
|--------|--------------------|
| `queryAll<T>(table)` | `engineGetAll(table).filter(i => !i.deleted).sort((a,b) => a.order - b.order)` |
| `queryOne<T>(table, id)` | `engineGet(table, id)` + null-if-deleted guard |
| `reorderEntity<T>(table, id, order)` | `engineUpdate(table, id, { order })` with cast |
| `prependOrder(table, index, value)` | `engineQuery` + filter deleted + min computation |

These are intentionally thin wrappers — they compose existing engine functions rather than introducing new data access paths.

---

## 13. Install PWA Command & Scaffolding

**File**: `src/bin/install-pwa.ts`

The engine includes a CLI command (`stellar-engine install pwa`) that scaffolds a complete SvelteKit 2 + Svelte 5 PWA project via an interactive walkthrough. The scaffolder follows a strict separation: **stellar-engine owns all non-UI logic**; the generated route files import engine functions and leave UI as TODO placeholders.

### 12.1 Architecture Diagram

```
+--------------------------------------------------------------------+
|                    INSTALL PWA SCAFFOLDER                           |
|                                                                    |
|  CLI Entry:  stellar-engine install pwa                            |
|                                                                    |
|  1. Interactive walkthrough (name, shortName, prefix, description)  |
|  2. Write package.json with @prabhask5/stellar-engine dep          |
|  3. npm install                                                    |
|  4. Generate 34+ template files (grouped with animated progress)   |
|  5. npx husky init + pre-commit hook                               |
|  6. Print styled summary + next steps                              |
+--------------------------------------------------------------------+
```

### 12.2 File Categories

| Category | Count | Examples |
|----------|-------|---------|
| Config | 8 | vite.config.ts, tsconfig.json, eslint, prettier, knip |
| Documentation | 3 | README, ARCHITECTURE, FRAMEWORKS |
| Static assets | 13 | manifest.json, offline.html, SVG icons, email templates |
| Database | 1 | supabase-schema.sql |
| Source | 2 | app.html, app.d.ts |
| Routes | 16 | All route files below |
| Library | 1 | src/lib/types.ts |
| Git hooks | 1 | .husky/pre-commit |

### 12.3 Route File Ownership Model

Each generated route file follows this pattern:
- **Engine-managed code**: All imports, load functions, API handlers, auth logic, and state management are fully implemented using stellar-engine exports
- **TODO placeholders**: All UI/template/style code is left as TODO comments for the app developer

```
+--------------------------+     +----------------------------+
|  stellar-engine          |     |  Generated Route File      |
|  (fully implemented)     |     |                            |
|  - resolveAuthState()    |---->|  import { ... } from       |
|  - initConfig()          |     |    '@prabhask5/            |
|  - startSyncEngine()     |     |     stellar-engine/...'    |
|  - hydrateAuthState()    |     |                            |
|  - getServerConfig()     |     |  // All logic: ✓           |
|  - deployToVercel()      |     |  // All UI: TODO           |
|  - createValidateHandler |     |                            |
|  - handleEmailConfirm()  |     +----------------------------+
|  - broadcastAuthConfirm()|
+--------------------------+

+--------------------------+     +----------------------------+
|  stellar-engine          |     |  Generated Route File      |
|  (Svelte components)     |     |  (imports component)       |
|                          |     |                            |
|  components/SyncStatus   |---->|  <SyncStatus />            |
|  components/Deferred...  |---->|  <DeferredChangesBanner /> |
+--------------------------+     +----------------------------+

+--------------------------+     +----------------------------+
|  stellar-engine/kit      |     |  Generated Component       |
|  (SW lifecycle logic)    |     |  src/lib/components/       |
|                          |     |  UpdatePrompt.svelte       |
|  monitorSwLifecycle()    |---->|  (TODO UI placeholder)     |
|  handleSwUpdate()        |     |                            |
+--------------------------+     +----------------------------+
```

### 12.4 API Route Handlers

Three API routes are fully managed by stellar-engine with zero app-specific code:

| Route | Handler | Purpose |
|-------|---------|---------|
| `/api/config` | `getServerConfig()` | Returns runtime Supabase config for client hydration |
| `/api/setup/deploy` | `deployToVercel()` | Deploys env vars to Vercel project |
| `/api/setup/validate` | `createValidateHandler()` | Validates Supabase credentials + schema |

### 12.5 Svelte Components & Generated Components

The engine ships two ready-to-use Svelte 5 components that are imported by generated route files:

| Component | Export Path | Purpose |
|-----------|-------------|---------|
| SyncStatus | `./components/SyncStatus` | Animated sync indicator with 5-state morphing icons, tooltip, realtime badge, mobile refresh |
| DeferredChangesBanner | `./components/DeferredChangesBanner` | Cross-device conflict notification with diff preview |

These are full Svelte components (script + template + styles) that use CSS custom properties for theming, making them work across different app designs.

The scaffolder also generates `src/lib/components/UpdatePrompt.svelte` — a component with fully wired SW lifecycle logic (importing `monitorSwLifecycle` and `handleSwUpdate` from `@prabhask5/stellar-engine/kit`) but TODO placeholder UI. This follows the same pattern as route files: engine owns the logic, developer owns the UI.

### 12.6 Skip-if-exists Safety

The scaffolder uses `writeIfMissing()` — files are only created if they don't already exist. This means:
- Running the command twice is safe (existing files are skipped)
- Developers can modify generated files without fear of overwriting
- The summary output shows which files were created vs skipped

---

## Summary of Design Complexities

| Aspect | Complexity |
|--------|-----------|
| **Offline-first architecture** | Full CRUD with IndexedDB, seamless online/offline transitions |
| **Intent-based outbox** | 4 operation types, aggressive coalescing (11 rules), cross-operation optimization |
| **Three-tier conflict resolution** | Field-level merging, device ID tiebreakers, audit trail |
| **Tri-mode authentication** | Supabase + offline credential cache + single-user real email/password auth with device verification |
| **Realtime + polling hybrid** | WebSocket for instant sync, polling as fallback, deduplication |
| **Tombstone lifecycle** | Soft deletes, multi-device propagation, timed hard-delete cleanup |
| **Egress optimization** | Column selection, coalescing, realtime-first, cursor-based, validation caching |
| **Mutex-protected sync** | Promise-based lock with stale detection, operation timeouts |
| **Network state machine** | iOS PWA visibility handling, sequential reconnect callbacks |
| **PWA scaffolding** | CLI generates 34+ files with engine-managed logic and TODO UI placeholders, skip-if-exists safety |
