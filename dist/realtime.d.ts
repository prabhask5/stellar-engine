/**
 * Real-Time Subscription Manager
 *
 * Phase 5 of multi-device sync: Implements Supabase Realtime subscriptions
 * for instant multi-device synchronization.
 *
 * Design decisions:
 * - Uses Supabase Realtime PostgreSQL Changes for all entity tables
 * - Skips echo (own changes) by comparing device_id in the payload
 * - Tracks recently processed entities to prevent duplicate processing with polling
 * - Applies changes through existing conflict resolution engine
 * - Falls back to polling if WebSocket connection fails (max 5 reconnect attempts)
 * - Single channel per user with filter by user_id for efficiency
 * - Pauses reconnection attempts while offline (waits for online event)
 * - Uses reconnectScheduled flag to prevent duplicate reconnect attempts
 */
export type RealtimeConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
/**
 * Subscribe to connection state changes
 */
export declare function onConnectionStateChange(callback: (state: RealtimeConnectionState) => void): () => void;
/**
 * Subscribe to data update notifications (called after local DB is updated)
 */
export declare function onRealtimeDataUpdate(callback: (table: string, entityId: string) => void): () => void;
/**
 * Get current realtime connection state.
 * Used by debug utilities exposed on the window object.
 */
export declare function getConnectionState(): RealtimeConnectionState;
/**
 * Check if an entity was recently processed via realtime
 * Used by engine.ts to prevent duplicate processing during polling
 */
export declare function wasRecentlyProcessedByRealtime(entityId: string): boolean;
/**
 * Start realtime subscriptions for a user
 */
export declare function startRealtimeSubscriptions(userId: string): Promise<void>;
/**
 * Stop realtime subscriptions (public API)
 */
export declare function stopRealtimeSubscriptions(): Promise<void>;
/**
 * Pause realtime (when going offline) - stops reconnection attempts
 * Called by sync engine when offline event fires
 */
export declare function pauseRealtime(): void;
/**
 * Check if realtime is healthy (connected and not in error state)
 */
export declare function isRealtimeHealthy(): boolean;
/**
 * Clean up expired entries from recently processed tracking
 */
export declare function cleanupRealtimeTracking(): void;
//# sourceMappingURL=realtime.d.ts.map