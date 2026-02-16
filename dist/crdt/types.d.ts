/**
 * @fileoverview CRDT Subsystem Type Definitions
 *
 * Defines all TypeScript interfaces and types used by the CRDT collaborative
 * editing subsystem. This includes:
 *   - {@link CRDTConfig} — configuration passed via `initEngine({ crdt: ... })`
 *   - {@link CRDTDocumentRecord} — IndexedDB record shape for persisted CRDT state
 *   - {@link CRDTPendingUpdate} — crash-safe incremental update records
 *   - {@link UserPresenceState} — per-user cursor/presence state for awareness
 *   - {@link OpenDocumentOptions} — options bag for `openDocument()`
 *   - {@link BroadcastMessage} — union of all Broadcast channel message types
 *
 * Architecture note:
 *   The CRDT subsystem is an optional layer on top of the existing sync engine.
 *   It uses Yjs for conflict-free document merging, Supabase Broadcast for
 *   real-time update distribution, Supabase Presence for cursor/awareness,
 *   and IndexedDB (via Dexie) for local persistence. Consumers never import
 *   yjs directly — all Yjs types are re-exported from the engine.
 *
 * @see {@link ./config.ts} for configuration singleton management
 * @see {@link ./provider.ts} for the per-document lifecycle orchestrator
 * @see {@link ./channel.ts} for Broadcast message handling
 * @see {@link ./awareness.ts} for Supabase Presence ↔ Yjs Awareness bridge
 */
/**
 * Configuration for the CRDT collaborative editing subsystem.
 *
 * Passed as the `crdt` field of {@link SyncEngineConfig} in `initEngine()`.
 * All fields are optional with sensible defaults. When this config is provided,
 * the engine creates additional IndexedDB tables for CRDT document storage and
 * enables the `@prabhask5/stellar-engine/crdt` API surface.
 *
 * @example
 * initEngine({
 *   prefix: 'myapp',
 *   tables: [...],
 *   database: { name: 'myapp-db', versions: [...] },
 *   crdt: {
 *     persistIntervalMs: 60000,   // Persist to Supabase every 60s
 *     maxOfflineDocuments: 100,    // Allow up to 100 docs offline
 *   },
 * });
 */
export interface CRDTConfig {
    /**
     * Supabase table name for CRDT document storage.
     * @default 'crdt_documents'
     */
    supabaseTable?: string;
    /**
     * Columns to SELECT from Supabase (egress optimization).
     * @default 'id,page_id,state,state_vector,state_size,device_id,updated_at,created_at'
     */
    columns?: string;
    /**
     * How often to persist dirty documents to Supabase (ms).
     * Lower values reduce data loss risk on crash but increase Supabase writes.
     * @default 30000 (30 seconds)
     */
    persistIntervalMs?: number;
    /**
     * Broadcast debounce window (ms). Updates within this window are merged
     * via `Y.mergeUpdates()` into a single Broadcast payload.
     * @default 100
     */
    broadcastDebounceMs?: number;
    /**
     * How long to debounce local IndexedDB full-state saves (ms).
     * Writes full Yjs state to IndexedDB on this interval to ensure recovery
     * from crashes without storing every single keystroke.
     * @default 5000 (5 seconds)
     */
    localSaveDebounceMs?: number;
    /**
     * Cursor/presence update debounce (ms). Limits the rate at which
     * cursor position changes are broadcast to other users.
     * @default 50
     */
    cursorDebounceMs?: number;
    /**
     * Maximum number of documents stored locally for offline access.
     * When the limit is reached, `enableOffline()` will reject new documents.
     * @default 50
     */
    maxOfflineDocuments?: number;
    /**
     * Maximum Broadcast payload size in bytes before chunking.
     * Supabase Broadcast has a ~1MB hard limit; we chunk well below that.
     * @default 250000 (250KB)
     */
    maxBroadcastPayloadBytes?: number;
    /**
     * Timeout (ms) waiting for peer sync-step-2 responses on reconnect.
     * If no peers respond within this window, falls back to Supabase fetch.
     * @default 3000
     */
    syncPeerTimeoutMs?: number;
    /**
     * Maximum reconnection attempts for the Broadcast channel.
     * After this many failures, the channel enters a permanent error state
     * and must be manually reconnected.
     * @default 5
     */
    maxReconnectAttempts?: number;
    /**
     * Base delay (ms) for exponential backoff on channel reconnect.
     * Actual delay: `baseDelay * 2^(attemptNumber - 1)`.
     * @default 1000
     */
    reconnectBaseDelayMs?: number;
}
/**
 * Fully resolved CRDT configuration with all defaults applied.
 *
 * Created by {@link config.ts#_initCRDT} from the user-provided
 * {@link CRDTConfig}. All fields are required (no `undefined` values).
 *
 * @internal
 */
export interface ResolvedCRDTConfig {
    supabaseTable: string;
    columns: string;
    persistIntervalMs: number;
    broadcastDebounceMs: number;
    localSaveDebounceMs: number;
    cursorDebounceMs: number;
    maxOfflineDocuments: number;
    maxBroadcastPayloadBytes: number;
    syncPeerTimeoutMs: number;
    maxReconnectAttempts: number;
    reconnectBaseDelayMs: number;
}
/**
 * Shape of a record in the `crdtDocuments` IndexedDB table.
 *
 * Stores the full Yjs document state as a binary `Uint8Array`, along with
 * metadata for sync, offline management, and diagnostics.
 *
 * The `offlineEnabled` field uses `0 | 1` instead of `boolean` because
 * Dexie/IndexedDB cannot index boolean fields.
 */
export interface CRDTDocumentRecord {
    /** Unique document identifier (primary key). */
    documentId: string;
    /** The page/entity this document belongs to. Indexed for lookups. */
    pageId: string;
    /** Full Yjs document state (`Y.encodeStateAsUpdate(doc)`). */
    state: Uint8Array;
    /** Yjs state vector for delta sync (`Y.encodeStateVector(doc)`). */
    stateVector: Uint8Array;
    /**
     * Whether this document is stored locally for offline access.
     * Uses `0 | 1` because IndexedDB cannot index booleans.
     */
    offlineEnabled: 0 | 1;
    /** ISO 8601 timestamp of the last local modification. */
    localUpdatedAt: string;
    /** ISO 8601 timestamp of the last successful Supabase write, or `null` if never persisted. */
    lastPersistedAt: string | null;
    /** Byte size of the `state` field, for diagnostics and compaction decisions. */
    stateSize: number;
}
/**
 * Shape of a record in the `crdtPendingUpdates` IndexedDB table.
 *
 * Stores incremental Yjs update deltas for crash safety. These are written
 * on every `doc.on('update')` event so that if the browser crashes between
 * full-state saves (every 5s), the pending deltas can be replayed to recover
 * the document to its last known state.
 *
 * Cleared after a successful full-state save to IndexedDB or Supabase persist.
 */
export interface CRDTPendingUpdate {
    /** Auto-increment primary key (assigned by IndexedDB). */
    id?: number;
    /** Which document this update belongs to. Indexed for efficient batch queries. */
    documentId: string;
    /** Incremental Yjs update delta (`Uint8Array` from `doc.on('update')`). */
    update: Uint8Array;
    /** ISO 8601 timestamp of when the update was received. */
    timestamp: string;
}
/**
 * Per-user presence state broadcast via Supabase Presence and bridged to
 * Yjs Awareness. This is what other users see when collaborating on a document.
 *
 * The `cursor` and `selection` fields are intentionally typed as `unknown`
 * because their shape depends on the editor implementation (Tiptap, Prosemirror,
 * CodeMirror, etc.). The CRDT engine transports them opaquely.
 */
export interface UserPresenceState {
    /** Supabase user UUID. */
    userId: string;
    /** Display name (e.g., first name or email). */
    name: string;
    /** Avatar URL, if available. */
    avatarUrl?: string;
    /**
     * Deterministic color assigned from userId hash.
     * Used for cursor color, selection highlight, avatar ring, etc.
     */
    color: string;
    /** Editor-specific cursor position (opaque to the engine). */
    cursor?: unknown;
    /** Editor-specific selection range (opaque to the engine). */
    selection?: unknown;
    /** Device identifier for multi-tab dedup. */
    deviceId: string;
    /** ISO 8601 timestamp of the user's last activity in this document. */
    lastActiveAt: string;
}
/**
 * Options for {@link provider.ts#openDocument}.
 */
export interface OpenDocumentOptions {
    /**
     * If `true`, the document will be persisted to IndexedDB for offline access.
     * When `false` or omitted, the document exists only in memory and is lost
     * when the provider is destroyed.
     * @default false
     */
    offlineEnabled?: boolean;
    /**
     * Initial user presence state to announce when joining the document.
     * If omitted, no presence is announced until `updateCursor()` is called.
     */
    initialPresence?: {
        name: string;
        avatarUrl?: string;
    };
}
/**
 * Connection state of a CRDT document's Broadcast channel.
 */
export type CRDTConnectionState = 'disconnected' | 'connecting' | 'connected';
/**
 * A CRDT document update distributed via Supabase Broadcast.
 *
 * Contains the merged Yjs update (possibly the result of debouncing multiple
 * rapid edits) encoded as a base64 string for JSON transport.
 */
export interface BroadcastUpdateMessage {
    type: 'update';
    data: string;
    deviceId: string;
}
/**
 * Sync step 1: sent on channel join to request missing updates from peers.
 * Contains the local state vector so peers can compute the delta.
 */
export interface BroadcastSyncStep1Message {
    type: 'sync-step-1';
    stateVector: string;
    deviceId: string;
}
/**
 * Sync step 2: response to a sync-step-1 request.
 * Contains the computed delta update for the requester.
 */
export interface BroadcastSyncStep2Message {
    type: 'sync-step-2';
    update: string;
    deviceId: string;
}
/**
 * A chunk of a large Broadcast payload that exceeds the max payload size.
 * The receiver reassembles chunks by matching `chunkId` and ordering by `index`.
 */
export interface BroadcastChunkMessage {
    type: 'chunk';
    chunkId: string;
    index: number;
    total: number;
    data: string;
    deviceId: string;
}
/**
 * Union of all Broadcast message types sent over the CRDT channel.
 */
export type BroadcastMessage = BroadcastUpdateMessage | BroadcastSyncStep1Message | BroadcastSyncStep2Message | BroadcastChunkMessage;
//# sourceMappingURL=types.d.ts.map