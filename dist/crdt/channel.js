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
import { supabase } from '../supabase/client';
import { getDeviceId } from '../deviceId';
import { debugLog, debugWarn } from '../debug';
import { getCRDTConfig, getCRDTPrefix } from './config';
import { handlePresenceJoin, handlePresenceLeave, assignColor } from './awareness';
// =============================================================================
//  Binary ↔ Base64 Encoding Utilities
// =============================================================================
/**
 * Encode a `Uint8Array` to a base64 string for JSON transport.
 *
 * Uses the browser's built-in `btoa()` via a binary string intermediary.
 * This is necessary because Supabase Broadcast payloads are JSON — binary
 * data must be string-encoded.
 */
function uint8ToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
/**
 * Decode a base64 string back to a `Uint8Array`.
 */
function base64ToUint8(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
// =============================================================================
//  CRDTChannel Class
// =============================================================================
/**
 * Manages the Supabase Broadcast channel for a single CRDT document.
 *
 * Handles update distribution, echo suppression, debouncing, chunking,
 * the sync protocol, cross-tab sync, and reconnection.
 *
 * @internal — consumers interact via {@link ./provider.ts}, not this class directly.
 */
export class CRDTChannel {
    constructor(documentId, doc, onConnectionStateChange) {
        /** Supabase Realtime channel instance. */
        this.channel = null;
        /** Browser BroadcastChannel for cross-tab sync (same device). */
        this.localChannel = null;
        /** Current connection state. */
        this._connectionState = 'disconnected';
        /** Callback invoked when connection state changes. */
        this.onConnectionStateChange = null;
        /** Initial presence info for Supabase Presence tracking. */
        this.presenceInfo = null;
        // --- Debounce state ---
        this.pendingUpdates = [];
        this.debounceTimer = null;
        // --- Chunk reassembly state ---
        this.chunkBuffers = new Map();
        // --- Reconnection state ---
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.destroyed = false;
        // --- Sync protocol state ---
        this.syncResolvers = new Map();
        this.documentId = documentId;
        this.doc = doc;
        this.deviceId = getDeviceId();
        this.channelName = `crdt:${getCRDTPrefix()}:${documentId}`;
        this.onConnectionStateChange = onConnectionStateChange ?? null;
    }
    // ===========================================================================
    //  Public API
    // ===========================================================================
    /** Current connection state of the channel. */
    get connectionState() {
        return this._connectionState;
    }
    /**
     * Set the local user's presence info for Supabase Presence tracking.
     *
     * Call this before `join()` to announce presence immediately on channel subscribe,
     * or after join to update the tracked presence.
     */
    setPresenceInfo(info) {
        this.presenceInfo = info;
        /* If already connected, track immediately. */
        if (this.channel && this._connectionState === 'connected') {
            this.trackPresence();
        }
    }
    /**
     * Join the Broadcast channel and start receiving messages.
     *
     * After subscribing, initiates the sync protocol by sending a sync-step-1
     * message with the local state vector so peers can respond with deltas.
     */
    async join() {
        if (this.destroyed)
            return;
        this.setConnectionState('connecting');
        debugLog(`[CRDT] Channel ${this.channelName} joining`);
        /* Create Supabase Broadcast channel. */
        this.channel = supabase.channel(this.channelName, {
            config: { broadcast: { self: false } }
        });
        /* Listen for Broadcast messages. */
        this.channel.on('broadcast', { event: 'crdt' }, (payload) => {
            this.handleBroadcastMessage(payload.payload);
        });
        /* Listen for Presence events (join/leave). */
        this.channel.on('presence', { event: 'join' }, ({ newPresences }) => {
            for (const presence of newPresences) {
                const state = presence;
                if (state.deviceId !== this.deviceId) {
                    handlePresenceJoin(this.documentId, state);
                }
            }
        });
        this.channel.on('presence', { event: 'leave' }, ({ leftPresences }) => {
            for (const presence of leftPresences) {
                const state = presence;
                handlePresenceLeave(this.documentId, state.userId, state.deviceId);
            }
        });
        /* Subscribe to the channel. */
        this.channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                this.setConnectionState('connected');
                this.reconnectAttempts = 0;
                debugLog(`[CRDT] Channel ${this.channelName} subscribed`);
                /* Track presence if info is available. */
                this.trackPresence();
                /* Initiate sync protocol — request missing updates from peers. */
                this.sendSyncStep1();
            }
            else if (status === 'CHANNEL_ERROR') {
                debugWarn(`[CRDT] Channel ${this.channelName} error`);
                this.handleDisconnect();
            }
            else if (status === 'CLOSED') {
                this.setConnectionState('disconnected');
            }
        });
        /* Set up cross-tab sync via browser BroadcastChannel API. */
        this.setupLocalChannel();
    }
    /**
     * Leave the channel and clean up all resources.
     */
    async leave() {
        this.destroyed = true;
        debugLog(`[CRDT] Channel ${this.channelName} leaving`);
        /* Clear debounce timer. */
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        /* Clear reconnect timer. */
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        /* Flush any pending updates before leaving. */
        if (this.pendingUpdates.length > 0) {
            this.flushUpdates();
        }
        /* Unsubscribe from Supabase channel. */
        if (this.channel) {
            await supabase.removeChannel(this.channel);
            this.channel = null;
        }
        /* Close browser BroadcastChannel. */
        if (this.localChannel) {
            this.localChannel.close();
            this.localChannel = null;
        }
        this.setConnectionState('disconnected');
        this.chunkBuffers.clear();
        this.syncResolvers.clear();
    }
    /**
     * Queue a Yjs update for broadcasting to remote peers.
     *
     * Updates are debounced for `broadcastDebounceMs` (default 100ms) and merged
     * via `Y.mergeUpdates()` before sending. This reduces network traffic for
     * rapid keystrokes while keeping latency under 100ms.
     *
     * @param update - The Yjs update delta from `doc.on('update')`.
     */
    broadcastUpdate(update) {
        if (this.destroyed || this._connectionState !== 'connected')
            return;
        this.pendingUpdates.push(update);
        /* Also broadcast to same-device tabs immediately (no debounce). */
        this.localChannel?.postMessage({
            type: 'update',
            data: uint8ToBase64(update),
            deviceId: this.deviceId
        });
        /* Debounce the Supabase Broadcast send. */
        if (!this.debounceTimer) {
            const config = getCRDTConfig();
            this.debounceTimer = setTimeout(() => {
                this.debounceTimer = null;
                this.flushUpdates();
            }, config.broadcastDebounceMs);
        }
    }
    /**
     * Wait for the sync protocol to complete after joining.
     *
     * Resolves when at least one peer responds with sync-step-2, or times out
     * after `syncPeerTimeoutMs` (default 3s) if no peers are available.
     *
     * @returns `true` if a peer responded, `false` if timed out (no peers).
     */
    waitForSync() {
        const config = getCRDTConfig();
        return new Promise((resolve) => {
            const key = `sync-${Date.now()}`;
            let resolved = false;
            this.syncResolvers.set(key, () => {
                if (!resolved) {
                    resolved = true;
                    resolve(true);
                }
            });
            setTimeout(() => {
                this.syncResolvers.delete(key);
                if (!resolved) {
                    resolved = true;
                    debugLog(`[CRDT] Document ${this.documentId}: no peers responded within ${config.syncPeerTimeoutMs}ms, fetching from Supabase`);
                    resolve(false);
                }
            }, config.syncPeerTimeoutMs);
        });
    }
    // ===========================================================================
    //  Message Handling
    // ===========================================================================
    /**
     * Handle an incoming Broadcast message from a remote peer.
     *
     * Dispatches to type-specific handlers and performs echo suppression
     * (skip messages from our own device).
     */
    handleBroadcastMessage(message) {
        /* Echo suppression — skip messages from our own device. */
        if (message.deviceId === this.deviceId) {
            debugLog(`[CRDT] Document ${this.documentId}: skipped own-device echo (deviceId=${this.deviceId})`);
            return;
        }
        switch (message.type) {
            case 'update':
                this.handleRemoteUpdate(message);
                break;
            case 'sync-step-1':
                this.handleSyncStep1(message);
                break;
            case 'sync-step-2':
                this.handleSyncStep2(message);
                break;
            case 'chunk':
                this.handleChunk(message);
                break;
        }
    }
    /**
     * Apply a remote Yjs update to the local document.
     */
    handleRemoteUpdate(message) {
        const update = base64ToUint8(message.data);
        debugLog(`[CRDT] Document ${this.documentId}: received remote update from device ${message.deviceId} (${update.byteLength} bytes)`);
        Y.applyUpdate(this.doc, update);
    }
    /**
     * Handle sync-step-1: a peer is requesting missing updates.
     *
     * We compute the delta between our state and their state vector,
     * then send it back as sync-step-2.
     */
    handleSyncStep1(message) {
        const remoteStateVector = base64ToUint8(message.stateVector);
        const update = Y.encodeStateAsUpdate(this.doc, remoteStateVector);
        if (update.byteLength > 0) {
            debugLog(`[CRDT] Document ${this.documentId}: sync-step-2 sent to ${message.deviceId} (${update.byteLength} bytes)`);
            this.sendMessage({
                type: 'sync-step-2',
                update: uint8ToBase64(update),
                deviceId: this.deviceId
            });
        }
    }
    /**
     * Handle sync-step-2: a peer responded to our sync-step-1 with a delta.
     */
    handleSyncStep2(message) {
        const update = base64ToUint8(message.update);
        debugLog(`[CRDT] Document ${this.documentId}: sync-step-2 received from ${message.deviceId} (${update.byteLength} bytes)`);
        Y.applyUpdate(this.doc, update);
        /* Resolve any pending sync waiters. */
        for (const resolver of this.syncResolvers.values()) {
            resolver();
        }
        this.syncResolvers.clear();
    }
    /**
     * Handle a chunk message — part of a large payload that was split.
     *
     * Buffers chunks until all parts arrive, then reassembles and processes
     * the full payload as a regular message.
     */
    handleChunk(message) {
        const { chunkId, index, total, data } = message;
        let buffer = this.chunkBuffers.get(chunkId);
        if (!buffer) {
            buffer = { total, chunks: new Map() };
            this.chunkBuffers.set(chunkId, buffer);
        }
        buffer.chunks.set(index, data);
        /* Check if all chunks have arrived. */
        if (buffer.chunks.size === buffer.total) {
            /* Reassemble in order. */
            let fullBase64 = '';
            for (let i = 0; i < buffer.total; i++) {
                fullBase64 += buffer.chunks.get(i) ?? '';
            }
            this.chunkBuffers.delete(chunkId);
            /* Process as an update message. */
            const update = base64ToUint8(fullBase64);
            debugLog(`[CRDT] Document ${this.documentId}: reassembled ${buffer.total} chunks (${update.byteLength} bytes)`);
            Y.applyUpdate(this.doc, update);
        }
    }
    // ===========================================================================
    //  Outbound Message Sending
    // ===========================================================================
    /**
     * Flush all pending updates: merge, encode, and send via Broadcast.
     *
     * If the merged payload exceeds the max size, it is chunked.
     */
    flushUpdates() {
        if (this.pendingUpdates.length === 0)
            return;
        const updates = this.pendingUpdates;
        this.pendingUpdates = [];
        /* Merge all buffered updates into a single binary payload. */
        const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
        const config = getCRDTConfig();
        debugLog(`[CRDT] Document ${this.documentId}: ${updates.length} updates buffered (${merged.byteLength} bytes), broadcasting`);
        const base64Data = uint8ToBase64(merged);
        if (base64Data.length > config.maxBroadcastPayloadBytes) {
            /* Payload too large — chunk it. */
            this.sendChunked(base64Data);
        }
        else {
            this.sendMessage({
                type: 'update',
                data: base64Data,
                deviceId: this.deviceId
            });
        }
    }
    /**
     * Send sync-step-1 to request missing updates from connected peers.
     */
    sendSyncStep1() {
        const stateVector = Y.encodeStateVector(this.doc);
        debugLog(`[CRDT] Document ${this.documentId}: sync-step-1 sent (stateVector ${stateVector.byteLength} bytes)`);
        this.sendMessage({
            type: 'sync-step-1',
            stateVector: uint8ToBase64(stateVector),
            deviceId: this.deviceId
        });
    }
    /**
     * Send a message via the Supabase Broadcast channel.
     */
    sendMessage(message) {
        if (!this.channel || this._connectionState !== 'connected')
            return;
        this.channel.send({
            type: 'broadcast',
            event: 'crdt',
            payload: message
        });
    }
    /**
     * Split a large base64 payload into chunks and send each one.
     */
    sendChunked(base64Data) {
        const config = getCRDTConfig();
        /* Use ~200KB per chunk to stay safely below the limit. */
        const chunkSize = Math.floor(config.maxBroadcastPayloadBytes * 0.8);
        const totalChunks = Math.ceil(base64Data.length / chunkSize);
        const chunkId = `${this.deviceId}-${Date.now()}`;
        debugWarn(`[CRDT] Document ${this.documentId}: chunking broadcast payload (${base64Data.length} bytes > ${config.maxBroadcastPayloadBytes} bytes, ${totalChunks} chunks)`);
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, base64Data.length);
            this.sendMessage({
                type: 'chunk',
                chunkId,
                index: i,
                total: totalChunks,
                data: base64Data.slice(start, end),
                deviceId: this.deviceId
            });
        }
    }
    // ===========================================================================
    //  Cross-Tab Sync (Browser BroadcastChannel)
    // ===========================================================================
    /**
     * Set up the browser BroadcastChannel for same-device tab sync.
     *
     * This avoids Supabase Broadcast for updates between tabs on the same device,
     * which is faster and doesn't consume any network bandwidth.
     */
    setupLocalChannel() {
        if (typeof BroadcastChannel === 'undefined')
            return;
        this.localChannel = new BroadcastChannel(this.channelName);
        this.localChannel.onmessage = (event) => {
            const message = event.data;
            /* Skip our own messages (same tab). */
            if (message.deviceId === this.deviceId)
                return;
            /* Apply update from another tab on the same device. */
            if (message.type === 'update') {
                const update = base64ToUint8(message.data);
                Y.applyUpdate(this.doc, update);
            }
        };
    }
    // ===========================================================================
    //  Reconnection
    // ===========================================================================
    /**
     * Handle a channel disconnect — attempt reconnection with exponential backoff.
     */
    handleDisconnect() {
        if (this.destroyed)
            return;
        this.setConnectionState('disconnected');
        const config = getCRDTConfig();
        if (this.reconnectAttempts >= config.maxReconnectAttempts) {
            debugWarn(`[CRDT] Channel ${this.channelName} max reconnect attempts reached (${config.maxReconnectAttempts})`);
            return;
        }
        this.reconnectAttempts++;
        const delay = config.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts - 1);
        debugLog(`[CRDT] Channel ${this.channelName} reconnecting (attempt ${this.reconnectAttempts}/${config.maxReconnectAttempts}, delay ${delay}ms)`);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.destroyed)
                return;
            /* Clean up old channel before rejoining. */
            if (this.channel) {
                await supabase.removeChannel(this.channel);
                this.channel = null;
            }
            await this.join();
        }, delay);
    }
    // ===========================================================================
    //  State Management
    // ===========================================================================
    /**
     * Track the local user's presence on the Supabase Presence channel.
     *
     * Sends the user's name, avatar, color, and device ID so other collaborators
     * can display cursor badges and avatar lists.
     */
    trackPresence() {
        if (!this.channel || !this.presenceInfo || this._connectionState !== 'connected')
            return;
        const presenceState = {
            userId: this.deviceId, // Will be replaced with actual userId when auth is available
            name: this.presenceInfo.name,
            avatarUrl: this.presenceInfo.avatarUrl,
            color: assignColor(this.deviceId),
            deviceId: this.deviceId,
            lastActiveAt: new Date().toISOString()
        };
        this.channel.track(presenceState);
    }
    /**
     * Update the connection state and notify the listener.
     */
    setConnectionState(state) {
        if (this._connectionState === state)
            return;
        this._connectionState = state;
        this.onConnectionStateChange?.(state);
    }
}
//# sourceMappingURL=channel.js.map