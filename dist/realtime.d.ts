/**
 * @fileoverview Real-Time Subscription Manager -- Supabase Realtime WebSocket Layer
 *
 * Phase 5 of multi-device sync: Implements Supabase Realtime subscriptions
 * for instant multi-device synchronization.
 *
 * ## Architecture
 *
 * This module manages a single Supabase Realtime channel per authenticated user,
 * listening for PostgreSQL changes (INSERT, UPDATE, DELETE) across all configured
 * entity tables. When a change arrives from another device, it is applied to the
 * local Dexie (IndexedDB) store and subscribers are notified so the UI can react.
 *
 * ```
 *   Supabase Postgres  --(CDC)--> Supabase Realtime Server
 *                                        |
 *                                   WebSocket
 *                                        |
 *                                   This module
 *                                        |
 *                          +-------------+-------------+
 *                          |                           |
 *                   Local Dexie DB             UI Notification
 *                  (conflict-resolved)       (animation / refresh)
 * ```
 *
 * ## Echo Suppression
 *
 * Every write to Supabase includes a `device_id` field. When a realtime event
 * arrives, we compare its `device_id` against our own. If they match, the event
 * originated from this device and is silently discarded. This prevents the
 * "echo" problem where a device processes its own outgoing changes a second time.
 *
 * ## Deduplication with Polling
 *
 * The sync engine also runs periodic polling as a fallback. To prevent the same
 * remote change from being applied twice (once via realtime, once via poll), this
 * module maintains a short-lived `recentlyProcessedByRealtime` map. The polling
 * path in `engine.ts` checks this map before processing a change.
 *
 * ## Reconnection Strategy
 *
 * On WebSocket disconnection the module uses exponential backoff (1s, 2s, 4s, ...)
 * up to {@link MAX_RECONNECT_ATTEMPTS} (5) attempts. If the browser is offline,
 * reconnection is paused entirely -- no timers fire until a `navigator.onLine`
 * event restores connectivity. A `reconnectScheduled` flag prevents duplicate
 * reconnection timers from stacking up when multiple channel events fire in
 * quick succession.
 *
 * ## Soft Deletes and Animations
 *
 * When a soft delete is detected (UPDATE with `deleted=true`), the module
 * records the deletion in {@link remoteChangesStore} *before* writing to Dexie.
 * This ordering is intentional: it allows the UI layer to play a removal
 * animation before the reactive store filters out the deleted record.
 *
 * ## Security Considerations
 *
 * - **Row-Level Security (RLS):** No client-side user ID filter is applied to
 *   the channel subscription. All access control is enforced by Supabase RLS
 *   policies at the database level. This is a deliberate security decision:
 *   client-side filters can be bypassed, whereas RLS operates inside Postgres
 *   and cannot be circumvented by a malicious client.
 * - **Device ID trust boundary:** The `device_id` field is used only for echo
 *   suppression and conflict tiebreaking, **not** for authorization. A spoofed
 *   `device_id` could cause an event to be incorrectly suppressed on another
 *   device, but it cannot escalate privileges or access unauthorized data.
 * - **Channel naming:** The channel name includes the user ID to ensure
 *   Supabase routes CDC events correctly. This is a routing hint, not a
 *   security boundary -- RLS is the actual enforcement mechanism.
 *
 * @see {@link ./engine.ts} for the orchestrating sync engine and polling loop
 * @see {@link ./conflicts.ts} for the conflict resolution algorithm
 * @see {@link ./queue.ts} for the pending operations queue
 * @see {@link ./stores/remoteChanges.ts} for UI change-tracking and animations
 * @see {@link ./deviceId.ts} for per-device identity generation
 */
/**
 * Possible states of the realtime WebSocket connection.
 *
 * - `'disconnected'` -- No active connection; initial state or after clean teardown.
 * - `'connecting'`   -- Subscription request sent; waiting for server acknowledgment.
 * - `'connected'`    -- Channel is `SUBSCRIBED`; events are flowing.
 * - `'error'`        -- An error or timeout occurred; reconnection may be in progress.
 *
 * State transitions follow this diagram:
 * ```
 *   disconnected --> connecting --> connected
 *        ^               |              |
 *        |               v              v
 *        +---------- error <-----------+
 * ```
 */
export type RealtimeConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
/**
 * Subscribe to connection state changes.
 *
 * The callback is invoked immediately with the current state upon registration,
 * then again on every subsequent transition.
 *
 * @param callback - Function invoked with the new {@link RealtimeConnectionState}.
 * @returns An unsubscribe function. Call it to remove the listener.
 *
 * @example
 * ```ts
 * const unsub = onConnectionStateChange((state) => {
 *   if (state === 'error') showReconnectBanner();
 * });
 * // Later, to stop listening:
 * unsub();
 * ```
 */
export declare function onConnectionStateChange(callback: (state: RealtimeConnectionState) => void): () => void;
/**
 * Subscribe to data update notifications.
 *
 * Callbacks fire *after* the remote change has been written to the local Dexie
 * database, so re-querying inside the callback will return fresh data.
 *
 * @param callback - Function invoked with the Supabase table name and entity ID.
 * @returns An unsubscribe function. Call it to remove the listener.
 *
 * @example
 * ```ts
 * const unsub = onRealtimeDataUpdate((table, entityId) => {
 *   if (table === 'habits') refreshHabitStore();
 * });
 * ```
 *
 * @see {@link notifyDataUpdate} for the internal dispatch function
 */
export declare function onRealtimeDataUpdate(callback: (table: string, entityId: string) => void): () => void;
/**
 * Get the current realtime connection state.
 *
 * Primarily used by debug utilities exposed on `window.__stellarDebug`.
 *
 * @returns The current {@link RealtimeConnectionState}.
 *
 * @see {@link ./debug.ts} for the debug surface that consumes this
 */
export declare function getConnectionState(): RealtimeConnectionState;
/**
 * Check whether an entity was recently processed via a realtime event.
 *
 * Called by `engine.ts` during polling to avoid applying the same remote
 * change twice (once from realtime, once from the poll response).
 *
 * **Side effect:** Expired entries are lazily evicted on access. This keeps
 * the map from growing during bursts of activity, complementing the
 * periodic cleanup in {@link cleanupRealtimeTracking}.
 *
 * @param entityId - The UUID of the entity to check.
 * @returns `true` if the entity was processed within the last {@link RECENTLY_MODIFIED_TTL_MS} ms.
 *
 * @example
 * ```ts
 * if (wasRecentlyProcessedByRealtime(entity.id)) {
 *   // Skip -- realtime already handled this change
 *   continue;
 * }
 * ```
 *
 * @see {@link ./engine.ts} -- polling path
 */
export declare function wasRecentlyProcessedByRealtime(entityId: string): boolean;
/**
 * Check if the realtime connection is healthy (connected and not in an error state).
 *
 * @returns `true` when the WebSocket channel is in the `'connected'` state.
 */
export declare function isRealtimeHealthy(): boolean;
/**
 * Remove expired entries from the recently-processed tracking map.
 *
 * Called periodically by the sync engine's maintenance loop to prevent
 * unbounded memory growth in long-running sessions.
 *
 * **Why explicit cleanup?** Lazy eviction in {@link wasRecentlyProcessedByRealtime}
 * only fires when an entity is looked up. If an entity is processed by realtime
 * but never polled (e.g., a table not included in the current poll cycle),
 * its entry would persist indefinitely without this active sweep.
 *
 * @see {@link RECENTLY_MODIFIED_TTL_MS}
 */
export declare function cleanupRealtimeTracking(): void;
/**
 * Start realtime subscriptions for an authenticated user.
 *
 * Creates a single Supabase Realtime channel and registers PostgreSQL change
 * listeners for every table defined in the engine config.
 *
 * **Security:** Access control is enforced by Supabase RLS policies at the
 * database level -- no client-side `user_id` filter is applied to the channel
 * subscription. The Realtime server evaluates RLS policies for each CDC event
 * and only delivers events the user is authorized to see.
 *
 * This function is idempotent: if the channel is already connected for the
 * same user, it returns immediately. If a different user is provided, the
 * existing channel is torn down first.
 *
 * **Channel multiplexing:** One channel is created for all tables rather than
 * one per table. This is more efficient because Supabase multiplexes all
 * subscriptions over a single WebSocket connection regardless, so separate
 * channels would only add overhead without improving parallelism.
 *
 * @param userId - The authenticated user's UUID. Used to construct a unique
 *                 channel name (`{prefix}_sync_{userId}`).
 *
 * @throws Never throws -- all errors are caught internally. On failure, the
 *         connection state transitions to `'error'` and reconnection is
 *         scheduled automatically.
 *
 * @example
 * ```ts
 * // After login:
 * await startRealtimeSubscriptions(session.user.id);
 * ```
 *
 * @see {@link stopRealtimeSubscriptions} to cleanly tear down the channel
 * @see {@link getEngineConfig} for the table configuration consumed here
 */
export declare function startRealtimeSubscriptions(userId: string): Promise<void>;
/**
 * Stop realtime subscriptions and clean up all state.
 *
 * This is the public-facing teardown API. It acquires the concurrency lock,
 * delegates to {@link stopRealtimeSubscriptionsInternal}, clears the user ID,
 * and wipes the recently-processed tracking map.
 *
 * **When to call:** On user logout or app shutdown. For temporary connectivity
 * loss, use {@link pauseRealtime} instead (it preserves the userId so
 * reconnection can resume automatically).
 *
 * @throws Never throws -- errors during channel removal are caught and logged.
 *
 * @example
 * ```ts
 * // On logout:
 * await stopRealtimeSubscriptions();
 * ```
 *
 * @see {@link startRealtimeSubscriptions} to re-establish the connection
 * @see {@link pauseRealtime} for temporary disconnection (offline)
 */
export declare function stopRealtimeSubscriptions(): Promise<void>;
/**
 * Pause realtime subscriptions when the browser goes offline.
 *
 * Unlike {@link stopRealtimeSubscriptions}, this does **not** clear
 * `state.userId` -- the user is still authenticated, we just can't reach
 * the server. When the browser comes back online, the sync engine calls
 * {@link startRealtimeSubscriptions} with the same user ID.
 *
 * Key behaviors:
 * - Cancels any pending reconnect timers.
 * - Resets the reconnect attempt counter so we get a fresh set of attempts
 *   when connectivity returns.
 * - Transitions to `'disconnected'` state.
 *
 * **Why not call stopRealtimeSubscriptionsInternal?** Because the offline
 * transition is often transient (e.g., brief WiFi dropout). We want to
 * preserve the userId and avoid the overhead of `removeChannel()` (which
 * tries to send an unsubscribe message over the dead WebSocket). Simply
 * clearing the reconnect state and transitioning to `'disconnected'` is
 * faster and avoids potential errors from network calls during offline.
 *
 * @see {@link ./engine.ts} -- calls this from the `offline` event handler
 */
export declare function pauseRealtime(): void;
//# sourceMappingURL=realtime.d.ts.map