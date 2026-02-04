/**
 * CRDT Awareness (Presence) Management
 *
 * Manages Yjs Awareness protocol for user presence indicators
 * (cursor positions, active users, etc.) via Supabase broadcast.
 */
import { Awareness } from 'y-protocols/awareness';
import type { AwarenessUser, RemoteUser } from './types';
/**
 * Initialize awareness (presence) for a CRDT document.
 *
 * Creates an Awareness instance and sets up a dedicated broadcast channel
 * for syncing presence state between clients.
 *
 * @param docId - Document/note ID
 * @param userInfo - Current user's display info
 * @returns The Awareness instance
 */
export declare function initAwareness(docId: string, userInfo: AwarenessUser): Awareness;
/**
 * Get the awareness instance for a document.
 *
 * @param docId - Document/note ID
 * @returns The Awareness instance if initialized, undefined otherwise
 */
export declare function getAwareness(docId: string): Awareness | undefined;
/**
 * Destroy awareness for a document.
 *
 * Removes awareness state, closes the broadcast channel, and cleans up listeners.
 *
 * @param docId - Document/note ID
 */
export declare function destroyAwareness(docId: string): Promise<void>;
/**
 * Update the local user's cursor position in awareness.
 *
 * @param docId - Document/note ID
 * @param cursor - Cursor position (blockId + offset), or null to clear
 */
export declare function updateAwarenessCursor(docId: string, cursor: {
    blockId: string;
    offset: number;
} | null): void;
/**
 * Get all remote users currently present on a document.
 *
 * Returns awareness state from all clients except the local one.
 *
 * @param docId - Document/note ID
 * @returns Array of remote user presence states
 */
export declare function getRemoteAwarenessUsers(docId: string): RemoteUser[];
//# sourceMappingURL=awareness.d.ts.map