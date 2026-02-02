/**
 * Intent-Based Sync Operation Types
 *
 * These types enable preserving operation intent (e.g., "increment by 1")
 * rather than just final state (e.g., "current_value: 50").
 *
 * Benefits:
 * - Rapid increments are coalesced locally (50 +1s -> single +50) reducing sync traffic
 * - Pending operations are protected during conflict resolution
 *
 * Note: True numeric merge across devices (e.g., +50 + +30 = +80) is not implemented.
 * Operations are converted to final values before pushing to Supabase, so conflicts
 * use last-write-wins. Full numeric merge would require an operation inbox system.
 */

/**
 * Operation types that preserve intent:
 * - 'increment': Add delta to numeric field (e.g., current_value += 1)
 * - 'set': Set field to value (works for any type)
 * - 'create': Create new entity
 * - 'delete': Soft delete entity
 */
export type OperationType = 'increment' | 'set' | 'create' | 'delete';

/**
 * Intent-based sync operation item.
 *
 * Key design:
 * - Uses `operationType` to specify the operation intent
 * - Has optional `field` for field-level operations
 * - `value` is the delta (for increment) or new value (for set/create)
 *
 * For create operations, value contains the full entity payload.
 * For increment operations, value contains the delta to add.
 * For set operations, value contains the new field value(s).
 * For delete operations, value is not used.
 */
export interface SyncOperationItem {
  id?: number; // Auto-increment ID
  table: string; // Target table (generic string, not hardcoded union)
  entityId: string; // Entity being operated on
  operationType: OperationType; // 'increment', 'set', 'create', 'delete'
  field?: string; // Field being modified (for increment/single-field set)
  value?: unknown; // Delta (increment), new value (set), or full payload (create)
  timestamp: string; // ISO timestamp of when the operation was created
  retries: number; // Number of failed sync attempts
  lastRetryAt?: string; // ISO timestamp of last retry attempt (for backoff calculation)
}

// ============================================================
// OFFLINE AUTHENTICATION TYPES
// ============================================================

export interface OfflineCredentials {
  id: string; // 'current_user' - singleton pattern
  userId: string; // Supabase user ID
  email: string;
  password: string; // SHA-256 hashed password (legacy records may still be plaintext)
  profile: Record<string, unknown>; // Generic profile data (app-specific shape)
  cachedAt: string; // ISO timestamp when credentials were cached
}

export interface OfflineSession {
  id: string; // 'current_session' - singleton pattern
  userId: string; // Supabase user ID
  offlineToken: string; // UUID token for offline session
  createdAt: string; // ISO timestamp
  // Note: No expiresAt - sessions don't expire automatically
  // They are only revoked on: (1) successful online re-auth, (2) logout
}

// ============================================================
// CONFLICT RESOLUTION TYPES
// ============================================================

/**
 * Conflict history entry (stored in IndexedDB)
 * Records field-level conflict resolutions for review and potential undo
 */
export interface ConflictHistoryEntry {
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

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

export type AuthMode = 'supabase' | 'offline' | 'none';

// ============================================================
// SINGLE-USER AUTHENTICATION TYPES
// ============================================================

export type SingleUserGateType = 'code' | 'password';

export interface SingleUserConfig {
  id: string;                    // 'config' — singleton
  gateType: SingleUserGateType;
  codeLength?: 4 | 6;           // only when gateType === 'code'
  gateHash: string;              // SHA-256 of the code/password
  profile: Record<string, unknown>; // { firstName, lastName }
  supabaseUserId?: string;       // anonymous user's ID (set after first online setup)
  setupAt: string;               // ISO timestamp
  updatedAt: string;             // ISO timestamp
}
