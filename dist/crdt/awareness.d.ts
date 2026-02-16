/**
 * @fileoverview CRDT Presence / Awareness Management
 *
 * Bridges Supabase Presence ↔ local presence state for collaborative cursor
 * and user tracking. Each open document has its own set of collaborators.
 *
 * Responsibilities:
 *   - Tracking local cursor/selection state per document
 *   - Debouncing cursor updates to avoid flooding the Presence channel
 *   - Maintaining a list of active collaborators per document
 *   - Providing subscription-based notifications for collaborator changes
 *   - Deterministic color assignment from userId hash
 *
 * The Supabase Presence integration is handled through the same Realtime
 * channel used for Broadcast. Presence state is tracked separately from
 * Yjs document updates — they use different Supabase Realtime features
 * (Presence vs Broadcast) on the same channel.
 *
 * @see {@link ./types.ts} for {@link UserPresenceState}
 * @see {@link ./channel.ts} for the underlying Broadcast channel
 * @see {@link ./provider.ts} for the lifecycle orchestrator
 */
import type { UserPresenceState } from './types';
/**
 * Assign a deterministic color to a user based on their userId.
 *
 * Uses a simple hash of the userId to index into the 12-color palette.
 * The same userId always gets the same color, so collaborators appear
 * consistent across sessions and devices.
 *
 * @param userId - The user's UUID.
 * @returns A hex color string from the palette.
 */
export declare function assignColor(userId: string): string;
/**
 * Initialize presence tracking for a document.
 *
 * Called by the provider when a document is opened. Sets up the collaborator
 * map and announces the local user's presence.
 *
 * @param documentId - The document to join.
 * @param isConnected - Whether the Broadcast channel is connected.
 * @param initialPresence - The local user's initial presence info.
 * @internal
 */
export declare function joinPresence(documentId: string, isConnected: boolean, initialPresence: {
    name: string;
    avatarUrl?: string;
}): void;
/**
 * Leave presence tracking for a document.
 *
 * Called by the provider when a document is closed. Cleans up the collaborator
 * map and notifies listeners.
 *
 * @param documentId - The document to leave.
 * @internal
 */
export declare function leavePresence(documentId: string): void;
/**
 * Handle a remote user joining the document.
 *
 * Called when a Supabase Presence `join` event is received.
 *
 * @param documentId - The document.
 * @param presence - The remote user's presence state.
 * @internal
 */
export declare function handlePresenceJoin(documentId: string, presence: UserPresenceState): void;
/**
 * Handle a remote user leaving the document.
 *
 * @param documentId - The document.
 * @param userId - The user's UUID.
 * @param deviceId - The user's device ID.
 * @internal
 */
export declare function handlePresenceLeave(documentId: string, userId: string, deviceId: string): void;
/**
 * Update the local user's cursor and selection in a document.
 *
 * Debounced to `cursorDebounceMs` (default 50ms) to avoid flooding the
 * Presence channel with rapid cursor movements.
 *
 * @param documentId - The document to update cursor for.
 * @param cursor - Editor-specific cursor position (opaque to the engine).
 * @param selection - Editor-specific selection range (opaque to the engine).
 *
 * @example
 * // In your editor's cursor change handler:
 * editor.on('selectionUpdate', ({ editor }) => {
 *   updateCursor('doc-1', editor.state.selection.anchor, editor.state.selection);
 * });
 */
export declare function updateCursor(documentId: string, cursor: unknown, selection?: unknown): void;
/**
 * Get the current list of collaborators for a document.
 *
 * Excludes the local user (they don't need to see their own cursor).
 *
 * @param documentId - The document to get collaborators for.
 * @returns Array of presence states for remote collaborators.
 *
 * @example
 * const collaborators = getCollaborators('doc-1');
 * // [{ userId: '...', name: 'Alice', color: '#E57373', cursor: {...} }]
 */
export declare function getCollaborators(documentId: string): UserPresenceState[];
/**
 * Subscribe to collaborator changes for a document.
 *
 * The callback is invoked whenever a collaborator joins, leaves, or updates
 * their cursor position. The callback receives the current list of remote
 * collaborators (excluding the local user).
 *
 * @param documentId - The document to subscribe to.
 * @param callback - Called with the updated collaborator list.
 * @returns An unsubscribe function.
 *
 * @example
 * const unsub = onCollaboratorsChange('doc-1', (collaborators) => {
 *   avatarList = collaborators.map(c => ({ name: c.name, color: c.color }));
 * });
 * // Later:
 * unsub();
 */
export declare function onCollaboratorsChange(documentId: string, callback: (collaborators: UserPresenceState[]) => void): () => void;
//# sourceMappingURL=awareness.d.ts.map