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
import type { SyncOperationItem } from './types';
import type { ConflictHistoryEntry } from './types';
export type { ConflictHistoryEntry };
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
export declare function resolveConflicts(entityType: string, entityId: string, local: Record<string, unknown> | null, remote: Record<string, unknown>, pendingOps: SyncOperationItem[]): Promise<ConflictResolution>;
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
export declare function storeConflictHistory(resolution: ConflictResolution): Promise<void>;
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
export declare function getPendingOpsForEntity(entityId: string): Promise<SyncOperationItem[]>;
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
/**
 * Query the most recent conflict history entries for diagnostics.
 *
 * Reads from the `conflictHistory` IndexedDB table, returning entries in
 * reverse chronological order (newest first), limited to the specified count.
 *
 * @param limit - Maximum number of entries to return (default: 20)
 * @returns An object containing the recent entries and the total count
 */
export declare function _getRecentConflictHistory(limit?: number): Promise<{
    entries: ConflictHistoryEntry[];
    totalCount: number;
}>;
export declare function cleanupConflictHistory(): Promise<number>;
//# sourceMappingURL=conflicts.d.ts.map