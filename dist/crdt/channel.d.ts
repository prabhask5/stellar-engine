/**
 * @fileoverview CRDT Broadcast Channel — Supabase Realtime Transport
 *
 * Manages one Supabase Broadcast + Presence channel per open CRDT document.
 * Responsible for:
 *   - Distributing Yjs updates to remote peers via Broadcast
 *   - Receiving and applying remote updates (with echo suppression)
 *   - Debouncing outbound updates and merging via `Y.mergeUpdates()`
 *   - Chunking payloads that exceed the Broadcast size limit
 *   - Running the sync protocol on join (exchange state vectors, send deltas)
 *   - Cross-tab sync via browser `BroadcastChannel` API (avoids Supabase for same-device)
 *   - Reconnection with exponential backoff
 *
 * Channel naming convention: `crdt:${prefix}:${documentId}`
 *
 * @see {@link ./provider.ts} for the orchestrator that creates channels
 * @see {@link ./types.ts} for message type definitions
 * @see {@link ./awareness.ts} for Presence management (separate concern)
 */
import * as Y from 'yjs';
import type { CRDTConnectionState } from './types';
/**
 * Manages the Supabase Broadcast channel for a single CRDT document.
 *
 * Handles update distribution, echo suppression, debouncing, chunking,
 * the sync protocol, cross-tab sync, and reconnection.
 *
 * @internal — consumers interact via {@link ./provider.ts}, not this class directly.
 */
export declare class CRDTChannel {
    readonly documentId: string;
    private readonly doc;
    private readonly deviceId;
    private readonly channelName;
    /** Supabase Realtime channel instance. */
    private channel;
    /** Browser BroadcastChannel for cross-tab sync (same device). */
    private localChannel;
    /** Current connection state. */
    private _connectionState;
    /** Callback invoked when connection state changes. */
    private onConnectionStateChange;
    /** Initial presence info for Supabase Presence tracking. */
    private presenceInfo;
    private pendingUpdates;
    private debounceTimer;
    private chunkBuffers;
    private reconnectAttempts;
    private reconnectTimer;
    private destroyed;
    private syncResolvers;
    constructor(documentId: string, doc: Y.Doc, onConnectionStateChange?: (state: CRDTConnectionState) => void);
    /** Current connection state of the channel. */
    get connectionState(): CRDTConnectionState;
    /**
     * Set the local user's presence info for Supabase Presence tracking.
     *
     * Call this before `join()` to announce presence immediately on channel subscribe,
     * or after join to update the tracked presence.
     */
    setPresenceInfo(info: {
        name: string;
        avatarUrl?: string;
    }): void;
    /**
     * Join the Broadcast channel and start receiving messages.
     *
     * After subscribing, initiates the sync protocol by sending a sync-step-1
     * message with the local state vector so peers can respond with deltas.
     */
    join(): Promise<void>;
    /**
     * Leave the channel and clean up all resources.
     */
    leave(): Promise<void>;
    /**
     * Queue a Yjs update for broadcasting to remote peers.
     *
     * Updates are debounced for `broadcastDebounceMs` (default 100ms) and merged
     * via `Y.mergeUpdates()` before sending. This reduces network traffic for
     * rapid keystrokes while keeping latency under 100ms.
     *
     * @param update - The Yjs update delta from `doc.on('update')`.
     */
    broadcastUpdate(update: Uint8Array): void;
    /**
     * Wait for the sync protocol to complete after joining.
     *
     * Resolves when at least one peer responds with sync-step-2, or times out
     * after `syncPeerTimeoutMs` (default 3s) if no peers are available.
     *
     * @returns `true` if a peer responded, `false` if timed out (no peers).
     */
    waitForSync(): Promise<boolean>;
    /**
     * Handle an incoming Broadcast message from a remote peer.
     *
     * Dispatches to type-specific handlers and performs echo suppression
     * (skip messages from our own device).
     */
    private handleBroadcastMessage;
    /**
     * Apply a remote Yjs update to the local document.
     */
    private handleRemoteUpdate;
    /**
     * Handle sync-step-1: a peer is requesting missing updates.
     *
     * We compute the delta between our state and their state vector,
     * then send it back as sync-step-2.
     */
    private handleSyncStep1;
    /**
     * Handle sync-step-2: a peer responded to our sync-step-1 with a delta.
     */
    private handleSyncStep2;
    /**
     * Handle a chunk message — part of a large payload that was split.
     *
     * Buffers chunks until all parts arrive, then reassembles and processes
     * the full payload as a regular message.
     */
    private handleChunk;
    /**
     * Flush all pending updates: merge, encode, and send via Broadcast.
     *
     * If the merged payload exceeds the max size, it is chunked.
     */
    private flushUpdates;
    /**
     * Send sync-step-1 to request missing updates from connected peers.
     */
    private sendSyncStep1;
    /**
     * Send a message via the Supabase Broadcast channel.
     */
    private sendMessage;
    /**
     * Split a large base64 payload into chunks and send each one.
     */
    private sendChunked;
    /**
     * Set up the browser BroadcastChannel for same-device tab sync.
     *
     * This avoids Supabase Broadcast for updates between tabs on the same device,
     * which is faster and doesn't consume any network bandwidth.
     */
    private setupLocalChannel;
    /**
     * Handle a channel disconnect — attempt reconnection with exponential backoff.
     */
    private handleDisconnect;
    /**
     * Track the local user's presence on the Supabase Presence channel.
     *
     * Sends the user's name, avatar, color, and device ID so other collaborators
     * can display cursor badges and avatar lists.
     */
    private trackPresence;
    /**
     * Update the connection state and notify the listener.
     */
    private setConnectionState;
}
//# sourceMappingURL=channel.d.ts.map