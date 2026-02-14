/**
 * @fileoverview Three-Tier Conflict Resolution Engine for Multi-Device Sync
 *
 * This module implements a deterministic, three-tier conflict resolution
 * architecture designed for offline-first multi-device synchronization.
 * When a remote entity arrives that diverges from the local state, the engine
 * walks through progressively finer granularity to produce a merged result:
 *
 * **Tier 1 -- Non-overlapping entities (AUTO-MERGE)**
 *   Different entities changed on different devices never conflict; each side's
 *   changes are accepted wholesale. This tier is handled upstream by the sync
 *   pull logic before this module is invoked.
 *
 * **Tier 2 -- Different fields on the same entity (AUTO-MERGE FIELDS)**
 *   When two devices edit *different* fields of the same entity, both changes
 *   are preserved automatically. The per-field loop inside {@link resolveConflicts}
 *   only emits a {@link FieldConflictResolution} when the local and remote
 *   values for a given field actually differ.
 *
 * **Tier 3 -- Same field on the same entity (STRATEGY-BASED)**
 *   When the exact same field was modified on both sides, a resolution strategy
 *   is selected based on the field's nature and any pending local operations:
 *     - **local_pending** -- The field has unsynced local ops; local value wins
 *       so user intent is never silently discarded.
 *     - **numeric_merge** -- Reserved for fields declared in
 *       `numericMergeFields`; currently falls through to last-write-wins
 *       because true delta-merge requires an operation-inbox system.
 *     - **delete_wins** -- A delete on either side trumps edits to prevent
 *       accidental resurrection of soft-deleted entities.
 *     - **last_write** -- The default fallback: the later `updated_at` wins,
 *       with a deterministic deviceId tiebreaker for simultaneous writes.
 *
 * ## Design Decisions
 *
 * - **Remote as base layer:** The merged entity starts as a copy of the remote
 *   entity, with local-winning fields overwritten on top. This bias toward
 *   remote is intentional: in the common case the remote version is newer (the
 *   conflict arose because a remote change was detected), so starting from
 *   remote minimizes the number of field overwrites.
 * - **Version bumping:** After resolution, the merged entity's `_version` is
 *   set to `max(local, remote) + 1`. This ensures any device receiving the
 *   merged entity recognizes it as strictly newer than either input.
 * - **Timestamp preservation:** The later `updated_at` is preserved so the
 *   merged entity sorts correctly in "recently modified" queries.
 *
 * ## Security Considerations
 *
 * - **Device ID as tiebreaker:** The `device_id` field is used only for
 *   deterministic tiebreaking when timestamps are identical. It is not used
 *   for authorization or access control. Lexicographic comparison ensures
 *   every device converges on the same winner without coordination.
 * - **No data exfiltration:** Conflict history is stored locally in IndexedDB
 *   (`conflictHistory` table). It never leaves the device and is automatically
 *   purged after 30 days by {@link cleanupConflictHistory}.
 *
 * ## Auditability
 *
 * All resolution outcomes are recorded via {@link storeConflictHistory} for
 * auditability and potential future undo support. Each field-level decision
 * is stored as a separate {@link ConflictHistoryEntry}, enabling fine-grained
 * queries like "show me every time `title` was overwritten by a remote value."
 *
 * @see {@link ./types.ts} for {@link SyncOperationItem} and {@link ConflictHistoryEntry}
 * @see {@link ./config.ts} for per-table `excludeFromConflict` and `numericMergeFields`
 * @see {@link ./deviceId.ts} for the stable device identifier used as tiebreaker
 * @see {@link ./realtime.ts} for the primary consumer of this module
 * @see {@link ./queue.ts} for the sync queue that provides pending operations
 */

import { debugLog, debugError } from './debug';
import { getEngineConfig } from './config';
import { getDeviceId } from './deviceId';
import type { SyncOperationItem } from './types';
import type { ConflictHistoryEntry } from './types';

// Re-export for convenience -- allows consumers to import the type from
// this module without reaching into ./types directly.
export type { ConflictHistoryEntry };

// =============================================================================
// Interfaces
// =============================================================================

/**
 * Conflict resolution result for a single field.
 *
 * Each instance captures the before/after state for one field where the local
 * and remote values diverged, along with metadata about which side won and why.
 * This granular record enables:
 * - **UI display:** Showing the user exactly what changed and why.
 * - **Audit trail:** Persisted via {@link storeConflictHistory} for post-hoc analysis.
 * - **Potential undo:** Retaining the "losing" value so it can be restored.
 *
 * @see {@link ConflictResolution} for the entity-level container
 */
export interface FieldConflictResolution {
  /** The name of the conflicting field (e.g., `"title"`, `"target_amount"`). */
  field: string;

  /** The value of this field in the local (device) copy of the entity. */
  localValue: unknown;

  /** The value of this field in the remote (server) copy of the entity. */
  remoteValue: unknown;

  /** The value chosen (or computed) by the resolution strategy. */
  resolvedValue: unknown;

  /**
   * Which side's value was accepted.
   * - `'local'`  -- local device value was kept
   * - `'remote'` -- server value was kept
   * - `'merged'` -- a new value was computed from both sides (e.g., numeric merge)
   */
  winner: 'local' | 'remote' | 'merged';

  /**
   * The strategy that determined the outcome.
   * - `'last_write'`    -- timestamp comparison (with deviceId tiebreaker)
   * - `'numeric_merge'` -- reserved for additive delta merge
   * - `'delete_wins'`   -- delete operation trumps edits
   * - `'local_pending'` -- unsynced local operation takes priority
   *
   * @see the Tier 3 description in the file-level JSDoc for details
   */
  strategy: 'last_write' | 'numeric_merge' | 'delete_wins' | 'local_pending';
}

/**
 * Full conflict resolution result for a single entity.
 *
 * Aggregates every field-level decision and provides the final merged entity
 * ready to be written back to the local database.
 *
 * **Invariant:** `hasConflicts === (fieldResolutions.length > 0)`. If no fields
 * diverged, both are false/empty and the merged entity is simply the remote copy.
 *
 * @see {@link resolveConflicts} which produces this structure
 * @see {@link storeConflictHistory} which persists it for auditing
 */
export interface ConflictResolution {
  /** UUID of the entity that was resolved. */
  entityId: string;

  /** Supabase table name the entity belongs to (e.g., `"goals"`). */
  entityType: string;

  /** ISO 8601 `updated_at` from the local copy (empty string if no local copy existed). */
  localUpdatedAt: string;

  /** ISO 8601 `updated_at` from the incoming remote copy. */
  remoteUpdatedAt: string;

  /** Per-field resolution details; empty when there were no diverging fields. */
  fieldResolutions: FieldConflictResolution[];

  /** The fully merged entity payload, ready to be persisted locally. */
  mergedEntity: Record<string, unknown>;

  /** `true` when at least one field required a resolution decision. */
  hasConflicts: boolean;

  /** ISO 8601 timestamp of when this resolution was computed. */
  timestamp: string;
}

// =============================================================================
// Configuration Helpers
// =============================================================================

/**
 * Get the set of field names that should be excluded from conflict resolution
 * for a given entity type.
 *
 * Certain fields are *always* excluded because they are either immutable
 * identifiers or managed by the sync engine itself (e.g., `_version`).
 * Additional per-table exclusions can be declared via the engine config's
 * `excludeFromConflict` array.
 *
 * **Why exclude these fields?**
 * - `id` -- Immutable primary key; resolving it would break identity.
 * - `user_id` -- Immutable foreign key; changing it would violate RLS.
 * - `created_at` -- Immutable timestamp; should never diverge.
 * - `_version` -- Managed by the engine's version-bumping logic post-resolution.
 *
 * @param entityType - The Supabase table name (e.g., `"goals"`)
 * @returns A `Set` of field names to skip during resolution
 *
 * @see {@link getEngineConfig} for the table configuration schema
 *
 * @example
 * ```ts
 * const excluded = getExcludedFields('goals');
 * // Set { 'id', 'user_id', 'created_at', '_version', ...any table-specific fields }
 * ```
 */
function getExcludedFields(entityType: string): Set<string> {
  const defaultExcluded = new Set(['id', 'user_id', 'created_at', '_version']);
  const tableConfig = getEngineConfig().tables.find((t) => t.supabaseName === entityType);
  return new Set([...defaultExcluded, ...(tableConfig?.excludeFromConflict || [])]);
}

/**
 * Get the set of field names eligible for numeric (additive delta) merging
 * for a given entity type.
 *
 * Numeric merge fields are declared per-table in the engine config. When both
 * local and remote hold numeric values for such a field, the engine *could*
 * sum the deltas instead of picking a winner. Currently this falls through to
 * last-write-wins because the system stores final values, not operation deltas.
 *
 * **Future direction:** To enable true numeric merge, the system would need
 * either:
 * 1. An operation-inbox pattern where each device stores its delta relative
 *    to a known base value, or
 * 2. A three-way merge with the common ancestor (base) value.
 *
 * Neither is currently implemented, so this configuration point is a
 * forward-compatible hook for when delta-merge support is added.
 *
 * @param entityType - The Supabase table name (e.g., `"goals"`)
 * @returns A `Set` of field names configured for numeric merge
 *
 * @see {@link getEngineConfig} for the table configuration schema
 *
 * @example
 * ```ts
 * const mergeFields = getNumericMergeFields('goals');
 * // Set { 'current_amount' } -- if configured
 * ```
 */
function getNumericMergeFields(entityType: string): Set<string> {
  const tableConfig = getEngineConfig().tables.find((t) => t.supabaseName === entityType);
  return new Set(tableConfig?.numericMergeFields || []);
}

// =============================================================================
// Core Resolution Logic
// =============================================================================

/**
 * Resolve conflicts between local and remote entity states.
 *
 * This is the main entry point for the three-tier conflict resolution engine.
 * It compares every field of the local and remote copies, applies the
 * appropriate resolution strategy for each divergence, and returns a fully
 * merged entity along with an audit trail of every decision.
 *
 * **Resolution flow:**
 * 1. If no local entity exists, the remote is accepted wholesale (no conflict).
 * 2. Pending delete operations are checked first -- deletes always win to
 *    prevent entity resurrection.
 * 3. Each field is compared; equal values are skipped (Tier 2 auto-merge).
 * 4. Divergent fields are resolved via the Tier 3 strategy cascade:
 *    pending local ops --> numeric merge --> last-write-wins.
 * 5. The merged entity's `_version` is bumped past both sides so downstream
 *    sync recognizes the merge as the newest state.
 *
 * **Delete handling rationale:**
 * Deletes are resolved before the per-field loop because a delete affects the
 * entire entity, not a single field. The "delete wins" policy prevents entity
 * resurrection, which is almost always the correct UX: if a user explicitly
 * deleted something on one device, they don't want it reappearing because
 * another device had pending edits.
 *
 * @param entityType  - Supabase table name (e.g., `"goals"`)
 * @param entityId    - UUID of the entity being resolved
 * @param local       - The local entity state, or `null` if the entity does
 *                       not yet exist on this device
 * @param remote      - The incoming remote entity state from the server
 * @param pendingOps  - Unsynced operations for this entity from the local
 *                       sync queue (used to detect local user intent)
 * @returns A {@link ConflictResolution} containing the merged entity and
 *          per-field audit trail
 *
 * @throws Never throws directly -- but callers should handle potential Dexie
 *         errors when persisting the returned `mergedEntity`.
 *
 * @see {@link resolveByTimestamp} for the last-write-wins tiebreaker logic
 * @see {@link storeConflictHistory} for persisting the resolution outcome
 * @see {@link ./realtime.ts} and {@link ./engine.ts} which call this function
 *
 * @example
 * ```ts
 * const result = await resolveConflicts(
 *   'goals',
 *   'abc-123',
 *   { id: 'abc-123', title: 'Local Title', target: 100, updated_at: '2026-01-01T00:00:00Z' },
 *   { id: 'abc-123', title: 'Remote Title', target: 100, updated_at: '2026-01-02T00:00:00Z' },
 *   []
 * );
 * // result.mergedEntity.title === 'Remote Title' (remote is newer)
 * // result.hasConflicts === true
 * ```
 */
export async function resolveConflicts(
  entityType: string,
  entityId: string,
  local: Record<string, unknown> | null,
  remote: Record<string, unknown>,
  pendingOps: SyncOperationItem[]
): Promise<ConflictResolution> {
  const timestamp = new Date().toISOString();
  const fieldResolutions: FieldConflictResolution[] = [];
  const deviceId = getDeviceId();

  // ---------------------------------------------------------------------------
  // Fast path: no local copy means the remote is entirely new to this device.
  // No conflict is possible -- accept the remote entity as-is.
  // ---------------------------------------------------------------------------
  if (!local) {
    return {
      entityId,
      entityType,
      localUpdatedAt: '',
      remoteUpdatedAt: remote.updated_at as string,
      fieldResolutions: [],
      mergedEntity: { ...remote },
      hasConflicts: false,
      timestamp
    };
  }

  const localUpdatedAt = local.updated_at as string;
  const remoteUpdatedAt = remote.updated_at as string;

  /* Start with remote as the base layer. Fields where local wins will be
     overwritten below. This bias toward remote is intentional: in the common
     case the remote version is newer (the pull happened because we detected
     a server change), so starting from remote minimises the number of
     overwrites needed. */
  const mergedEntity: Record<string, unknown> = { ...remote };

  // Get all unique fields from both entities
  const allFields = new Set([...Object.keys(local), ...Object.keys(remote)]);

  // ---------------------------------------------------------------------------
  // Build a lookup of pending operations keyed by the field they affect.
  // This powers the Tier 3a "local_pending" strategy: if the user has an
  // unsynced change to a field, that change must not be silently overwritten
  // by a remote value the user has never seen.
  // ---------------------------------------------------------------------------
  const pendingFieldOps = new Map<string, SyncOperationItem[]>();
  for (const op of pendingOps) {
    if (op.field) {
      /* Single-field operations (e.g., SET title='...') are registered
         directly under their field name. */
      const existing = pendingFieldOps.get(op.field) || [];
      existing.push(op);
      pendingFieldOps.set(op.field, existing);
    } else if (op.operationType === 'set' && typeof op.value === 'object' && op.value !== null) {
      /* Multi-field set operations (e.g., updating title + description in one
         call) don't carry a single `field` name. We unpack the value object
         to register each affected field individually. This ensures that
         conflict detection works correctly for every field touched by the op. */
      for (const field of Object.keys(op.value as Record<string, unknown>)) {
        const existing = pendingFieldOps.get(field) || [];
        existing.push(op);
        pendingFieldOps.set(field, existing);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Delete resolution -- handled before the per-field loop because a delete
  // affects the entire entity, not a single field.
  //
  // **Security consideration:** The "delete wins" policy is a UX-driven
  // decision, not a security measure. Even if a delete is ignored (e.g., due
  // to a bug), RLS policies prevent unauthorized data access. The worst case
  // is that a deleted entity reappears temporarily until the next sync.
  // ---------------------------------------------------------------------------

  // Check if there's a pending delete
  const hasPendingDelete = pendingOps.some((op) => op.operationType === 'delete');

  /* Local pending delete vs. remote non-deleted: the user explicitly deleted
     this entity on the current device but the server still has it alive.
     Honour the user's destructive intent -- delete wins. */
  if (hasPendingDelete && !remote.deleted) {
    mergedEntity.deleted = true;
    fieldResolutions.push({
      field: 'deleted',
      localValue: true,
      remoteValue: remote.deleted,
      resolvedValue: true,
      winner: 'local',
      strategy: 'local_pending'
    });
  }

  /* Remote is deleted but local has no pending delete: the entity was deleted
     on another device. Even if the local device has pending *edits*, the
     delete wins -- otherwise we'd "resurrect" an entity the user (on another
     device) intentionally removed, which is almost always the wrong UX.

     **Early return:** We skip the per-field loop entirely because all fields
     are moot when the entity is deleted. The remote (deleted) state is
     returned as-is. */
  if (remote.deleted && !hasPendingDelete) {
    // Remote delete wins - entity should stay deleted
    return {
      entityId,
      entityType,
      localUpdatedAt,
      remoteUpdatedAt,
      fieldResolutions: [
        {
          field: 'deleted',
          localValue: local.deleted,
          remoteValue: true,
          resolvedValue: true,
          winner: 'remote',
          strategy: 'delete_wins'
        }
      ],
      mergedEntity: { ...remote },
      hasConflicts: true,
      timestamp
    };
  }

  // ---------------------------------------------------------------------------
  // Per-field resolution (Tier 2 and Tier 3)
  // ---------------------------------------------------------------------------

  // Get config-driven field sets for this entity type
  const excludedFields = getExcludedFields(entityType);
  const numericMergeFields = getNumericMergeFields(entityType);

  // Process each field
  for (const field of allFields) {
    /* Skip infrastructure fields that are managed by the engine, not the user.
       Resolving these could cause version loops or identity corruption.
       For example, resolving `_version` would defeat the version-bumping
       logic at the end of this function. */
    if (excludedFields.has(field)) continue;
    /* Skip `deleted` if already handled by the delete resolution above.
       Processing it again would create a duplicate field resolution entry. */
    if (field === 'deleted' && hasPendingDelete) continue; // Already handled

    const localValue = local[field];
    const remoteValue = remote[field];

    /* Tier 2: if the values are identical there is no conflict -- both devices
       agree on this field, so no resolution entry is emitted. This is the most
       common case and the cheapest to evaluate. */
    if (valuesEqual(localValue, remoteValue)) {
      continue;
    }

    // Check for pending operations on this field
    const fieldOps = pendingFieldOps.get(field) || [];
    const hasPendingOps = fieldOps.length > 0;

    // Determine resolution strategy
    let resolution: FieldConflictResolution;

    if (hasPendingOps) {
      /* Tier 3a: The user has an unsynced local operation touching this field.
         Local wins unconditionally so we never silently discard user intent
         that hasn't reached the server yet. The pending op will be pushed on
         the next sync cycle, at which point the server will receive the
         user's value.

         **Why not merge?** Because the user hasn't seen the remote value yet.
         If we merged (e.g., concatenated strings), the result would be
         surprising. Keeping the local value ensures the user sees exactly
         what they intended. The remote value is preserved in the conflict
         history for potential manual review. */
      resolution = {
        field,
        localValue,
        remoteValue,
        resolvedValue: localValue,
        winner: 'local',
        strategy: 'local_pending'
      };
      mergedEntity[field] = localValue;
    } else if (numericMergeFields.has(field) && canNumericMerge(local, remote, field)) {
      /* Tier 3b: Numeric field that *could* be merged additively (e.g., both
         devices incremented a counter). True delta merge (local_delta +
         remote_delta + base = merged) requires storing the original base
         value or using an operation-inbox pattern. Since we currently only
         have the final local and remote snapshots, we fall through to
         last-write-wins as a safe default.

         **When this will change:** Once the sync engine implements operation-
         inbox support (storing the base value alongside the delta), this
         branch can compute: merged = base + local_delta + remote_delta.
         The `numericMergeFields` config is a forward-compatible hook for
         that future capability. */
      resolution = resolveByTimestamp(
        field,
        local,
        remote,
        localUpdatedAt,
        remoteUpdatedAt,
        deviceId
      );
      mergedEntity[field] = resolution.resolvedValue;
    } else {
      /* Tier 3c: Default strategy -- last-write-wins. The entity with the
         more recent `updated_at` timestamp takes this field. When timestamps
         are identical (sub-second clash), the deviceId tiebreaker ensures
         every device converges on the same winner deterministically.

         **Why last-write-wins?** It's the simplest strategy that produces
         predictable, consistent results across all devices. More sophisticated
         strategies (operational transform, CRDTs) add significant complexity
         and are overkill for the entity-level sync this engine performs. */
      resolution = resolveByTimestamp(
        field,
        local,
        remote,
        localUpdatedAt,
        remoteUpdatedAt,
        deviceId
      );
      mergedEntity[field] = resolution.resolvedValue;
    }

    fieldResolutions.push(resolution);
  }

  // ---------------------------------------------------------------------------
  // Post-resolution bookkeeping
  // ---------------------------------------------------------------------------

  /* Bump _version past both sides so that any device receiving this merged
     entity recognises it as strictly newer than either the local or remote
     version it already has. Without this, a device could ignore the merge
     result because its own _version appears equal or higher.

     Only bump when conflicts were actually resolved; clean merges (where all
     fields agreed) don't need a version bump because the remote entity was
     already accepted as-is. */
  if (fieldResolutions.length > 0) {
    const localVersion = typeof local._version === 'number' ? local._version : 1;
    const remoteVersion = typeof remote._version === 'number' ? remote._version : 1;
    mergedEntity._version = Math.max(localVersion, remoteVersion) + 1;
  }

  /* Preserve the later updated_at so the merged entity sorts correctly in
     any "recently modified" queries. The remote base was already set above;
     we only need to override if local is actually newer. ISO 8601 strings
     are lexicographically comparable, so a simple > comparison works. */
  if (localUpdatedAt > remoteUpdatedAt) {
    mergedEntity.updated_at = localUpdatedAt;
  }

  return {
    entityId,
    entityType,
    localUpdatedAt,
    remoteUpdatedAt,
    fieldResolutions,
    mergedEntity,
    hasConflicts: fieldResolutions.length > 0,
    timestamp
  };
}

// =============================================================================
// Timestamp-Based Resolution (Last-Write-Wins)
// =============================================================================

/**
 * Resolve a field conflict using the last-write-wins (LWW) strategy.
 *
 * Compares `updated_at` timestamps of the local and remote entities. The side
 * with the strictly later timestamp wins the field. When timestamps are exactly
 * equal (possible with sub-second clock drift between devices), the device ID
 * is used as a **deterministic tiebreaker**: the lexicographically lower ID
 * wins. This ensures every device in the fleet converges on the same result
 * without coordination.
 *
 * **Why lexicographic comparison for tiebreaking?** The choice of which device
 * wins is arbitrary -- what matters is that the choice is *consistent*. Any
 * deterministic comparison function would work (hash, numeric, etc.), but
 * string comparison is the simplest to implement and reason about.
 *
 * **Edge cases:**
 * - If both devices have the same device ID (should never happen in practice),
 *   local wins because the local write is the most recent user action on this
 *   device.
 * - If the remote entity has no `device_id` field (e.g., written by a server
 *   process), local wins by default.
 *
 * @param field           - Name of the conflicting field
 * @param local           - Full local entity (used to read the field's value)
 * @param remote          - Full remote entity (used to read the field's value)
 * @param localUpdatedAt  - ISO 8601 timestamp from the local entity
 * @param remoteUpdatedAt - ISO 8601 timestamp from the remote entity
 * @param localDeviceId   - Stable identifier of the current device
 * @returns A {@link FieldConflictResolution} with `strategy: 'last_write'`
 *
 * @see {@link resolveConflicts} which calls this for Tier 3b and 3c fields
 * @see {@link getDeviceId} for how the stable device identifier is generated
 *
 * @example
 * ```ts
 * const res = resolveByTimestamp(
 *   'title',
 *   { title: 'A', updated_at: '2026-01-01T00:00:00Z' },
 *   { title: 'B', updated_at: '2026-01-02T00:00:00Z' },
 *   '2026-01-01T00:00:00Z',
 *   '2026-01-02T00:00:00Z',
 *   'device-aaa'
 * );
 * // res.winner === 'remote', res.resolvedValue === 'B'
 * ```
 */
function resolveByTimestamp(
  field: string,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  localUpdatedAt: string,
  remoteUpdatedAt: string,
  localDeviceId: string
): FieldConflictResolution {
  const localValue = local[field];
  const remoteValue = remote[field];

  // Compare timestamps
  const localTime = new Date(localUpdatedAt).getTime();
  const remoteTime = new Date(remoteUpdatedAt).getTime();

  let winner: 'local' | 'remote';
  let resolvedValue: unknown;

  if (localTime > remoteTime) {
    winner = 'local';
    resolvedValue = localValue;
  } else if (remoteTime > localTime) {
    winner = 'remote';
    resolvedValue = remoteValue;
  } else {
    /* Timestamps are identical -- fall back to deviceId comparison.
       Using lexicographic ordering (lower ID wins) is arbitrary but
       *consistent*: every device running this code will pick the same
       winner without needing a coordination round-trip.

       **Why lower ID wins?** This is an arbitrary but stable convention.
       The important property is that all devices agree, not which device
       is chosen. Lower-wins is a common convention in distributed systems. */
    const remoteDeviceId = (remote.device_id as string) || '';

    if (remoteDeviceId && localDeviceId < remoteDeviceId) {
      /* Local device has the lower ID -> local wins. */
      winner = 'local';
      resolvedValue = localValue;
    } else if (remoteDeviceId && localDeviceId > remoteDeviceId) {
      /* Remote device has the lower ID -> remote wins. */
      winner = 'remote';
      resolvedValue = remoteValue;
    } else {
      /* Same device authored both changes, or the remote has no device_id.
         Local wins because the local write is the user's most recent
         conscious action on *this* device. In the "same device" case this
         should not normally happen (echo suppression should have caught it),
         but we handle it defensively. */
      winner = 'local';
      resolvedValue = localValue;
    }
  }

  return {
    field,
    localValue,
    remoteValue,
    resolvedValue,
    winner,
    strategy: 'last_write'
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if two values are deeply equal.
 *
 * Performs a recursive structural comparison for objects and arrays, and a
 * strict identity check (`===`) for primitives. This is used to detect
 * Tier 2 auto-merge opportunities: if the local and remote values for a
 * field are identical, no resolution entry is emitted.
 *
 * **Performance note:** This function uses recursive descent, which is
 * adequate for the entity fields in this system (typically shallow objects
 * with a few keys). For deeply nested structures or very large arrays,
 * a more optimized approach (e.g., JSON.stringify comparison) might be
 * faster, but at the cost of sensitivity to key ordering.
 *
 * **Null vs. undefined:** `null` and `undefined` are considered different
 * values. This matches JSON semantics: `null` is a valid JSON value, while
 * `undefined` is omitted during serialization.
 *
 * @param a - First value to compare
 * @param b - Second value to compare
 * @returns `true` if the values are structurally identical
 *
 * @example
 * ```ts
 * valuesEqual({ x: 1 }, { x: 1 }); // true
 * valuesEqual([1, 2], [1, 3]);      // false
 * valuesEqual(null, undefined);     // false
 * ```
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  /* Fast path: reference equality or primitive equality. */
  if (a === b) return true;
  /* null requires special handling because typeof null === 'object'. */
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  /* Array comparison: must have same length and element-wise equality. */
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => valuesEqual(val, b[i]));
  }

  /* Object comparison: must have same key set and value-wise equality.
     Note: this does not account for Symbol keys or prototype differences,
     which is acceptable for plain JSON-serializable entity data. */
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      valuesEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
  }

  return false;
}

/**
 * Check whether a numeric merge is structurally possible for a given field.
 *
 * Both the local and remote values must be of type `number` for an additive
 * delta merge to make sense. If either side holds a non-numeric value (e.g.,
 * `null` or a string), the field falls through to last-write-wins.
 *
 * **Why check both sides?** A field that was `number` on one side but `null`
 * on the other indicates a schema mismatch or a reset operation. Attempting
 * to add deltas in this case would produce `NaN` or incorrect results.
 *
 * @param local  - The local entity record
 * @param remote - The remote entity record
 * @param field  - The field name to check
 * @returns `true` if both sides hold numeric values for this field
 *
 * @see {@link getNumericMergeFields} for how fields are declared as mergeable
 *
 * @example
 * ```ts
 * canNumericMerge({ score: 10 }, { score: 20 }, 'score'); // true
 * canNumericMerge({ score: 10 }, { score: null }, 'score'); // false
 * ```
 */
function canNumericMerge(
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  field: string
): boolean {
  return typeof local[field] === 'number' && typeof remote[field] === 'number';
}

// =============================================================================
// Conflict History Persistence
// =============================================================================

/**
 * Store conflict resolution history for review and potential undo.
 *
 * Each {@link FieldConflictResolution} within the given resolution is persisted
 * as a separate {@link ConflictHistoryEntry} row in the `conflictHistory`
 * IndexedDB table. This enables fine-grained auditing (e.g., "show me every
 * time field X was overwritten by a remote value").
 *
 * No-ops silently when there are no actual conflicts (`hasConflicts === false`).
 *
 * **Storage cost:** Each entry is a small JSON object (~200-500 bytes). With
 * 30-day retention and typical usage patterns, the `conflictHistory` table
 * rarely exceeds a few hundred KB. {@link cleanupConflictHistory} handles
 * periodic pruning.
 *
 * **Error handling:** Failures are caught and logged but do not propagate.
 * Conflict history is a best-effort audit trail; a failure to record it must
 * not block the critical path of applying the merged entity to the local DB.
 *
 * @param resolution - The entity-level resolution result produced by
 *                     {@link resolveConflicts}
 * @returns Resolves when all entries have been written (or on error, after
 *          logging the failure)
 *
 * @throws Never throws -- all errors are caught internally and logged.
 *
 * @see {@link ConflictHistoryEntry} in `./types.ts` for the persisted schema
 * @see {@link cleanupConflictHistory} for expiring old entries
 *
 * @example
 * ```ts
 * const resolution = await resolveConflicts('goals', 'abc', local, remote, []);
 * await storeConflictHistory(resolution);
 * ```
 */
export async function storeConflictHistory(resolution: ConflictResolution): Promise<void> {
  if (!resolution.hasConflicts) return;

  try {
    /* Map each field-level resolution to a flat history entry. The entry
       duplicates the entityId and entityType from the parent resolution
       so each row is self-contained and queryable independently. */
    const entries: ConflictHistoryEntry[] = resolution.fieldResolutions.map((fr) => ({
      entityId: resolution.entityId,
      entityType: resolution.entityType,
      field: fr.field,
      localValue: fr.localValue,
      remoteValue: fr.remoteValue,
      resolvedValue: fr.resolvedValue,
      winner: fr.winner,
      strategy: fr.strategy,
      timestamp: resolution.timestamp
    }));

    /* bulkAdd is used instead of individual adds for efficiency -- one
       IndexedDB transaction instead of N. */
    await getEngineConfig().db!.table('conflictHistory').bulkAdd(entries);
  } catch (error) {
    /* Non-fatal: conflict history is an audit trail, not a critical operation.
       The merged entity has already been computed; failing to record the
       history should not prevent it from being persisted. */
    debugError('[Conflict] Failed to store conflict history:', error);
  }
}

// =============================================================================
// Sync Queue Helpers
// =============================================================================

/**
 * Get all pending (unsynced) operations for a specific entity from the
 * local sync queue.
 *
 * This is used by {@link resolveConflicts} to detect Tier 3a situations where
 * the user has local changes that have not yet been pushed to the server.
 * Those pending operations take priority so user intent is never silently lost.
 *
 * **Query strategy:** Uses Dexie's `where('entityId').equals(...)` for an
 * indexed lookup rather than scanning the entire queue. This is efficient
 * even for large queues because `entityId` is indexed.
 *
 * @param entityId - UUID of the entity to look up
 * @returns An array of {@link SyncOperationItem} entries queued for this entity
 *          (may be empty if nothing is pending)
 *
 * @see {@link SyncOperationItem} in `./types.ts` for the operation schema
 * @see {@link resolveConflicts} which consumes these pending ops
 *
 * @example
 * ```ts
 * const ops = await getPendingOpsForEntity('abc-123');
 * // [{ table: 'goals', entityId: 'abc-123', operationType: 'set', ... }]
 * ```
 */
export async function getPendingOpsForEntity(entityId: string): Promise<SyncOperationItem[]> {
  const allPending = await getEngineConfig()
    .db!.table('syncQueue')
    .where('entityId')
    .equals(entityId)
    .toArray();
  return allPending as unknown as SyncOperationItem[];
}

// =============================================================================
// History Cleanup
// =============================================================================

/**
 * Clean up old conflict history entries older than 30 days.
 *
 * Should be called periodically (e.g., on app launch or after a successful
 * full sync) to prevent the `conflictHistory` IndexedDB table from growing
 * unboundedly. The 30-day retention window provides enough runway for users
 * to notice and investigate unexpected data changes.
 *
 * **Why 30 days?** This balances storage cost against audit usefulness:
 * - Too short (e.g., 7 days) and users may not notice a conflict before
 *   the history is purged.
 * - Too long (e.g., 1 year) and the table could grow to several MB on
 *   devices with frequent multi-device conflicts.
 * - 30 days covers typical usage patterns where users check in at least
 *   once a month.
 *
 * **Performance note:** Uses Dexie's `.filter()` (client-side scan) rather
 * than an indexed query because the `conflictHistory` table is small and
 * does not have a `timestamp` index. If the table grows significantly,
 * adding an index on `timestamp` and using `.where()` would be faster.
 *
 * @returns The number of entries deleted, or `0` if an error occurred
 *
 * @throws Never throws -- all errors are caught internally and logged.
 *
 * @see {@link storeConflictHistory} which creates the entries being cleaned
 *
 * @example
 * ```ts
 * const deleted = await cleanupConflictHistory();
 * console.log(`Purged ${deleted} stale conflict records`);
 * ```
 */
export async function cleanupConflictHistory(): Promise<number> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);
  const cutoffStr = cutoffDate.toISOString();

  try {
    /* Filter and delete in one pass. Dexie's `.filter().delete()` iterates
       the table and removes matching rows in a single transaction. */
    const count = await getEngineConfig()
      .db!.table('conflictHistory')
      .filter((entry: ConflictHistoryEntry) => entry.timestamp < cutoffStr)
      .delete();

    if (count > 0) {
      debugLog(`[Conflict] Cleaned up ${count} old conflict history entries`);
    }

    return count;
  } catch (error) {
    debugError('[Conflict] Failed to cleanup conflict history:', error);
    return 0;
  }
}
