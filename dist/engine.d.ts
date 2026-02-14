/**
 * @fileoverview Local-First Sync Engine - Core orchestrator for offline-first data synchronization.
 *
 * This is the heart of stellar-engine: a bidirectional sync engine that keeps local
 * IndexedDB (via Dexie) in sync with a remote Supabase database. It implements the
 * "local-first" pattern where all reads/writes happen against the local DB for instant
 * responsiveness, and a background sync loop reconciles with the server.
 *
 * ## Architecture Overview
 *
 * ```
 * ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
 * │   UI Layer   │────▶│  Local DB    │────▶│  Sync Engine │────▶ Supabase
 * │  (instant)   │◀────│  (IndexedDB) │◀────│  (background)│◀──── (remote)
 * └─────────────┘     └──────────────┘     └──────────────┘
 * ```
 *
 * ## Core Rules
 *
 * 1. **All reads come from local DB** (IndexedDB via Dexie)
 * 2. **All writes go to local DB first**, immediately (no waiting for network)
 * 3. **Every write creates a pending operation** in the sync queue (outbox pattern)
 * 4. **Sync loop ships outbox to server** in the background (push phase)
 * 5. **On refresh, load local state instantly**, then run background sync (pull phase)
 *
 * ## Sync Cycle Flow
 *
 * 1. **Push**: Coalesce pending ops → send to Supabase → remove from queue
 * 2. **Pull**: Fetch changes since last cursor → apply with conflict resolution → update cursor
 * 3. **Notify**: Tell registered stores to refresh from local DB
 *
 * ## Key Subsystems
 *
 * - **Egress monitoring**: Tracks bytes/records transferred for debugging bandwidth usage
 * - **Sync lock (mutex)**: Prevents concurrent sync cycles from corrupting state
 * - **Watchdog**: Detects stuck syncs and auto-releases locks after timeout
 * - **Tombstone cleanup**: Garbage-collects soft-deleted records after configured TTL
 * - **Auth validation**: Ensures valid session before syncing (prevents silent RLS failures)
 * - **Visibility sync**: Smart re-sync when user returns to tab after extended absence
 * - **Realtime integration**: Skips polling pull when WebSocket subscription is healthy
 *
 * ## Egress Optimization Strategy
 *
 * The engine aggressively minimizes Supabase egress (bandwidth) through:
 * - Operation coalescing (50 rapid updates → 1 request)
 * - Push-only mode when realtime is healthy (skip pull after local writes)
 * - Cached user validation (1 getUser() call per hour instead of per sync)
 * - Visibility-aware sync (skip sync if tab was hidden briefly)
 * - Reconnect cooldown (skip sync if we just synced before going offline)
 * - Selective column fetching (only request configured columns, not `*`)
 *
 * @module engine
 * @see {@link ./queue.ts} - Sync queue (outbox) management
 * @see {@link ./conflicts.ts} - Field-level conflict resolution
 * @see {@link ./realtime.ts} - Supabase Realtime WebSocket subscriptions
 * @see {@link ./config.ts} - Engine configuration and table definitions
 */
/**
 * Clear all pending sync operations from the outbox queue.
 *
 * **SECURITY**: Called when offline credentials are found to be invalid, to prevent
 * unauthorized data from being synced to the server. Without this, a user who
 * tampered with offline credentials could queue malicious writes that get pushed
 * once the device reconnects.
 *
 * @returns The number of operations that were cleared
 *
 * @example
 * ```ts
 * // Called during auth validation failure
 * const cleared = await clearPendingSyncQueue();
 * console.log(`Prevented ${cleared} unauthorized sync operations`);
 * ```
 */
export declare function clearPendingSyncQueue(): Promise<number>;
/**
 * Mark an entity as recently modified to protect it from being overwritten by pull.
 *
 * Called by repository functions after every local write. The protection expires
 * after `RECENTLY_MODIFIED_TTL_MS` (2 seconds).
 *
 * @param entityId - The UUID of the entity that was just modified locally
 */
export declare function markEntityModified(entityId: string): void;
/**
 * Register a callback to be invoked when a sync cycle completes.
 *
 * Used by Svelte stores to refresh their data from the local DB after new
 * remote data has been pulled. Returns an unsubscribe function for cleanup.
 *
 * @param callback - Function to call after each sync completion
 * @returns Unsubscribe function that removes the callback
 *
 * @example
 * ```ts
 * // In a Svelte store
 * const unsubscribe = onSyncComplete(() => {
 *   refreshFromLocalDb();
 * });
 * // Later, during cleanup:
 * unsubscribe();
 * ```
 */
export declare function onSyncComplete(callback: () => void): () => void;
/**
 * Schedule a debounced sync push after a local write.
 *
 * Called by repository functions after every write to the local DB. The debounce
 * prevents hammering the server during rapid edits (e.g., typing in a text field).
 * When realtime is healthy, runs in push-only mode (skips the pull phase) since
 * remote changes arrive via WebSocket.
 *
 * @example
 * ```ts
 * // After a local write in a repository
 * await db.table('todos').put(newTodo);
 * scheduleSyncPush(); // Sync will fire after debounce delay
 * ```
 */
export declare function scheduleSyncPush(): void;
/**
 * Execute a full sync cycle: push local changes, then pull remote changes.
 *
 * This is the main entry point for sync. It orchestrates the complete cycle:
 * 1. **Pre-flight checks**: Online status, auth validation, session validity
 * 2. **Acquire lock**: Prevent concurrent syncs
 * 3. **Push phase**: Send pending local changes to Supabase
 * 4. **Pull phase**: Fetch remote changes since last cursor (with retry)
 * 5. **Post-sync**: Update UI status, notify stores, log egress stats
 *
 * The `quiet` flag controls whether the UI sync indicator is shown. Background
 * periodic syncs use `quiet=true` to avoid distracting the user. User-triggered
 * syncs (after local writes) use `quiet=false` to show progress.
 *
 * The `skipPull` flag enables push-only mode when realtime subscriptions are
 * healthy — since remote changes arrive via WebSocket, polling is redundant.
 *
 * @param quiet - If `true`, don't update the UI status indicator
 * @param skipPull - If `true`, skip the pull phase (push-only mode)
 */
export declare function runFullSync(quiet?: boolean, skipPull?: boolean): Promise<void>;
/**
 * Start the sync engine: initialize all listeners, timers, and subscriptions.
 *
 * This is the main "boot" function for the sync engine. It:
 * 1. Ensures the Dexie DB is open and upgraded
 * 2. Cleans up any existing listeners (idempotent restart support)
 * 3. Sets up debug window utilities
 * 4. Subscribes to Supabase auth state changes (handles sign-out/token-refresh)
 * 5. Registers online/offline handlers with auth validation
 * 6. Registers visibility change handler for smart tab-return syncing
 * 7. Starts realtime WebSocket subscriptions
 * 8. Starts periodic background sync interval
 * 9. Validates Supabase schema (one-time)
 * 10. Runs initial hydration (if local DB is empty) or full sync
 * 11. Runs initial cleanup (tombstones, conflicts, failed items)
 * 12. Starts the watchdog timer
 *
 * **Must be called after `initEngine()`** — requires configuration to be set.
 * Safe to call multiple times (previous listeners are cleaned up first).
 */
export declare function startSyncEngine(): Promise<void>;
/**
 * Stop the sync engine: tear down all listeners, timers, and subscriptions.
 *
 * After calling this, no sync activity will occur. All event listeners are
 * removed to prevent memory leaks. The sync lock is released in case a sync
 * was in progress. Hydration and schema validation flags are reset so the
 * engine can be cleanly restarted.
 *
 * Call this during app teardown, before reconfiguring the engine, or when
 * the user navigates away from pages that need sync.
 */
export declare function stopSyncEngine(): Promise<void>;
/**
 * Clear all local data from IndexedDB (used during logout).
 *
 * Wipes all entity tables, the sync queue, and conflict history in a single
 * transaction. Also removes the user's sync cursor from localStorage and
 * resets the hydration flag so the next login triggers a fresh hydration.
 *
 * **IMPORTANT**: Call this BEFORE calling `stopSyncEngine()` to ensure the
 * database is still open when clearing tables.
 */
export declare function clearLocalCache(): Promise<void>;
//# sourceMappingURL=engine.d.ts.map