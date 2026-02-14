/**
 * @fileoverview Core Type Definitions for the Stellar Sync Engine
 *
 * Defines the foundational TypeScript types used throughout the engine:
 * - Intent-based sync operation types (preserving operation semantics)
 * - Offline authentication types (credential caching, session tokens)
 * - Conflict resolution types (field-level history tracking)
 * - Single-user authentication types (PIN/password gate)
 * - Device trust types (multi-device verification)
 *
 * Architecture note:
 *   Operations use an intent-based model (e.g., "increment by 1") rather than
 *   final-state snapshots (e.g., "current_value: 50"). This enables local
 *   coalescing (50 rapid +1s become a single +50) and smarter conflict
 *   resolution. See {@link queue.ts} for the coalescing implementation.
 */
/**
 * The four supported operation intents for the sync queue.
 *
 * Each intent carries different semantics during coalescing and push:
 * - `'increment'` — Add a numeric delta to a field (coalesceable: multiple deltas sum)
 * - `'set'`       — Overwrite field(s) with new value(s) (coalesceable: later sets win)
 * - `'create'`    — Insert a new entity (coalesceable: subsequent sets merge into the create payload)
 * - `'delete'`    — Soft-delete an entity (a create + delete pair cancels both out entirely)
 */
export type OperationType = 'increment' | 'set' | 'create' | 'delete';
/**
 * A single intent-based sync operation stored in the IndexedDB `syncQueue` table.
 *
 * Design decisions:
 * - `operationType` preserves the *intent* so the coalescer can intelligently merge
 *   (e.g., 50 increment ops → one +50 instead of 50 separate server requests).
 * - `field` is optional: increment/single-field set use it; create and multi-field
 *   set store data in `value` instead.
 * - `retries` and `lastRetryAt` power exponential backoff for failed pushes.
 *
 * @example
 * // Increment operation: add 1 to `current_value`
 * { table: "goals", entityId: "abc", operationType: "increment", field: "current_value", value: 1 }
 *
 * // Multi-field set operation: update title and description
 * { table: "goals", entityId: "abc", operationType: "set", value: { title: "New", description: "..." } }
 *
 * // Create operation: full entity payload in `value`
 * { table: "goals", entityId: "abc", operationType: "create", value: { title: "Goal", target: 10 } }
 */
export interface SyncOperationItem {
    /** Auto-increment primary key (assigned by IndexedDB). */
    id?: number;
    /** Supabase table name (e.g., `"goals"`, `"goal_lists"`). */
    table: string;
    /** UUID of the entity being operated on. */
    entityId: string;
    /** The operation intent: `'increment'`, `'set'`, `'create'`, or `'delete'`. */
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
/**
 * Cached credentials stored in IndexedDB for offline sign-in.
 *
 * Uses a singleton pattern (`id: 'current_user'`) so only one set of
 * credentials is cached at a time. The password is stored as a SHA-256
 * hash — legacy records may contain plaintext from before hashing was added.
 *
 * @see {@link auth/offlineCredentials.ts} for caching/verification logic
 */
export interface OfflineCredentials {
    /** Singleton key — always `'current_user'`. */
    id: string;
    /** Supabase user UUID. */
    userId: string;
    /** User's email address. */
    email: string;
    /** SHA-256 hash of the user's password (legacy records may be plaintext). */
    password: string;
    /** App-specific profile data (e.g., `{ firstName, lastName }`). */
    profile: Record<string, unknown>;
    /** ISO 8601 timestamp of when credentials were cached. */
    cachedAt: string;
}
/**
 * Offline session token stored in IndexedDB.
 *
 * Created when the device goes offline (if credentials are cached) and
 * consumed during offline sign-in to verify the user's identity without
 * a network call.
 *
 * Sessions have no expiry — they are revoked only on:
 *   1. Successful online re-authentication
 *   2. Explicit logout
 *
 * @see {@link auth/offlineSession.ts} for session management
 */
export interface OfflineSession {
    /** Singleton key — always `'current_session'`. */
    id: string;
    /** Supabase user UUID. */
    userId: string;
    /** Random UUID used as the offline session token. */
    offlineToken: string;
    /** ISO 8601 timestamp of session creation. */
    createdAt: string;
}
/**
 * A single field-level conflict resolution record stored in IndexedDB.
 *
 * Recorded whenever the conflict resolution engine detects divergent values
 * for the same field across devices. Entries are retained for 30 days to
 * allow review and potential manual override.
 *
 * @see {@link conflicts.ts} for the three-tier resolution algorithm
 */
export interface ConflictHistoryEntry {
    /** Auto-increment primary key (assigned by IndexedDB). */
    id?: number;
    /** UUID of the conflicting entity. */
    entityId: string;
    /** Supabase table name (e.g., `"goals"`). */
    entityType: string;
    /** Field that had conflicting values. */
    field: string;
    /** Value from the local device. */
    localValue: unknown;
    /** Value from the remote server. */
    remoteValue: unknown;
    /** Final merged value written to IndexedDB. */
    resolvedValue: unknown;
    /** Which side's value was chosen (or `'merged'` for numeric merges). */
    winner: 'local' | 'remote' | 'merged';
    /** The strategy that resolved this conflict (e.g., `'last_write'`, `'delete_wins'`). */
    strategy: string;
    /** ISO 8601 timestamp of when the conflict was resolved. */
    timestamp: string;
}
/**
 * Current state of the sync engine's background loop.
 *
 * - `'idle'`    — No active sync; everything is up to date
 * - `'syncing'` — Push or pull currently in progress
 * - `'error'`   — Last sync attempt failed (will retry)
 * - `'offline'` — Device has no network connectivity
 */
export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';
/**
 * Authentication mode for the engine.
 *
 * - `'supabase'` — Standard Supabase email/password or OAuth auth
 * - `'offline'`  — Using cached credentials (device is offline)
 * - `'none'`     — No active authentication
 */
export type AuthMode = 'supabase' | 'offline' | 'none';
/**
 * The type of gate protecting single-user mode.
 *
 * - `'code'`     — Numeric PIN (4 or 6 digits)
 * - `'password'` — Freeform password string
 */
export type SingleUserGateType = 'code' | 'password';
/**
 * Persistent configuration for single-user mode, stored in IndexedDB.
 *
 * Single-user mode replaces traditional email/password sign-in with a
 * simplified local gate (PIN or password). Under the hood it still uses
 * a real Supabase account — the PIN is padded to meet Supabase's minimum
 * password length and used as the account password.
 *
 * Uses a singleton pattern (`id: 'config'`).
 *
 * @see {@link auth/singleUser.ts} for setup, unlock, and change flows
 */
export interface SingleUserConfig {
    /** Singleton key — always `'config'`. */
    id: string;
    /** Whether the gate is a numeric code or a freeform password. */
    gateType: SingleUserGateType;
    /** Digit count for code gates (4 or 6). Only set when `gateType === 'code'`. */
    codeLength?: 4 | 6;
    /** SHA-256 hash of the code/password (deprecated — kept for offline fallback verification). */
    gateHash?: string;
    /** Email address used for the underlying Supabase account. */
    email?: string;
    /** App-specific profile data (e.g., `{ firstName, lastName }`). */
    profile: Record<string, unknown>;
    /** Supabase user UUID (set after first successful online setup). */
    supabaseUserId?: string;
    /** ISO 8601 timestamp of initial setup. */
    setupAt: string;
    /** ISO 8601 timestamp of last configuration change. */
    updatedAt: string;
}
/**
 * A trusted device record stored in the Supabase `trusted_devices` table.
 *
 * When device verification is enabled, untrusted devices must complete an
 * email OTP challenge before they can access data. Once verified, the device
 * is trusted for a configurable duration (default: 90 days).
 *
 * @see {@link auth/deviceVerification.ts} for the trust/verify flow
 */
export interface TrustedDevice {
    /** Row UUID (primary key in Supabase). */
    id: string;
    /** Supabase user UUID who owns this device. */
    userId: string;
    /** Stable device identifier from localStorage. */
    deviceId: string;
    /** Human-readable device label (e.g., browser + OS). */
    deviceLabel?: string;
    /** ISO 8601 timestamp of when the device was first trusted. */
    trustedAt: string;
    /** ISO 8601 timestamp of the device's most recent use. */
    lastUsedAt: string;
}
//# sourceMappingURL=types.d.ts.map