/**
 * CRDT Module Types
 *
 * Type definitions for the Yjs/CRDT integration layer.
 */

/** Configuration for initializing a CRDT document */
export interface CrdtDocConfig {
  /** IndexedDB database name prefix (defaults to engine prefix) */
  dbPrefix?: string;
  /** Whether to auto-connect to Supabase Realtime on init */
  autoConnect?: boolean;
}

/** User role for presence identification */
export type AwarenessRole = 'owner' | 'shared';

/** Share scope for shared users */
export type AwarenessScope = 'READ' | 'WRITE' | 'COMMENT';

/** User info for awareness (presence) */
export interface AwarenessUser {
  name: string;
  color: string;
  /** Role: 'owner' for main user, 'shared' for shared users */
  role: AwarenessRole;
  /** Share scope — only relevant for shared users */
  scope?: AwarenessScope;
  /** Optional cursor position within a block */
  cursor?: {
    blockId: string;
    offset: number;
  } | null;
}

/** A remote user's presence state (includes Yjs client ID) */
export interface RemoteUser {
  clientId: number;
  user: AwarenessUser;
}

/** Internal state for a managed CRDT document */
export interface CrdtDocState {
  docId: string;
  cleanup: (() => void)[];
}

/** Sync state for a CRDT document */
export interface CrdtSyncState {
  /** Whether the document is connected to realtime */
  connected: boolean;
  /** Number of pending local updates not yet broadcast */
  pendingUpdates: number;
  /** Last time a checkpoint was saved */
  lastCheckpoint: number | null;
  /** Whether a checkpoint save is in progress */
  checkpointInProgress: boolean;
}

/** Broadcast message types for CRDT sync */
export interface CrdtBroadcastPayload {
  type: 'update' | 'awareness' | 'state-vector-request' | 'state-vector-response';
  /** Base64-encoded binary data */
  data: string;
  /** Device ID for echo suppression */
  deviceId: string;
  /** Document ID */
  docId: string;
}
