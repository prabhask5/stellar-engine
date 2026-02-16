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
import { getDeviceId } from '../deviceId';
import { debugLog } from '../debug';
import { getCRDTConfig } from './config';
// =============================================================================
//  Color Palette
// =============================================================================
/**
 * 12-color palette for deterministic collaborator color assignment.
 *
 * Colors are chosen for good contrast on both light and dark backgrounds,
 * and to be distinguishable from each other even at small sizes (cursor lines,
 * selection highlights).
 */
const COLLABORATOR_COLORS = [
    '#E57373', // Red
    '#81C784', // Green
    '#64B5F6', // Blue
    '#FFD54F', // Amber
    '#BA68C8', // Purple
    '#4DB6AC', // Teal
    '#FF8A65', // Deep Orange
    '#A1887F', // Brown
    '#90A4AE', // Blue Grey
    '#F06292', // Pink
    '#AED581', // Light Green
    '#4FC3F7' // Light Blue
];
// =============================================================================
//  Module State
// =============================================================================
/** Active collaborators per document. */
const collaboratorsByDocument = new Map();
/** Change listeners per document. */
const changeListeners = new Map();
/** Last cursor update timestamp per document (for debouncing). */
const lastCursorUpdate = new Map();
// =============================================================================
//  Color Assignment
// =============================================================================
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
export function assignColor(userId) {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
    }
    return COLLABORATOR_COLORS[Math.abs(hash) % COLLABORATOR_COLORS.length];
}
// =============================================================================
//  Internal Lifecycle (called by provider.ts)
// =============================================================================
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
export function joinPresence(documentId, isConnected, initialPresence) {
    if (!collaboratorsByDocument.has(documentId)) {
        collaboratorsByDocument.set(documentId, new Map());
    }
    if (isConnected) {
        debugLog(`[CRDT] Document ${documentId}: announcing presence (name=${initialPresence.name})`);
    }
}
/**
 * Leave presence tracking for a document.
 *
 * Called by the provider when a document is closed. Cleans up the collaborator
 * map and notifies listeners.
 *
 * @param documentId - The document to leave.
 * @internal
 */
export function leavePresence(documentId) {
    collaboratorsByDocument.delete(documentId);
    lastCursorUpdate.delete(documentId);
    /* Don't delete listeners — they unsubscribe themselves. */
}
/**
 * Handle a remote user joining the document.
 *
 * Called when a Supabase Presence `join` event is received.
 *
 * @param documentId - The document.
 * @param presence - The remote user's presence state.
 * @internal
 */
export function handlePresenceJoin(documentId, presence) {
    const collaborators = collaboratorsByDocument.get(documentId);
    if (!collaborators)
        return;
    /* Multi-tab dedup: use `userId:deviceId` as the key so the same user on
     * different devices shows as separate presence entries, but same user on
     * the same device (multiple tabs) collapses to one. */
    const key = `${presence.userId}:${presence.deviceId}`;
    collaborators.set(key, presence);
    debugLog(`[CRDT] Document ${documentId}: ${presence.name} joined (userId=${presence.userId}, deviceId=${presence.deviceId})`);
    notifyListeners(documentId);
}
/**
 * Handle a remote user leaving the document.
 *
 * @param documentId - The document.
 * @param userId - The user's UUID.
 * @param deviceId - The user's device ID.
 * @internal
 */
export function handlePresenceLeave(documentId, userId, deviceId) {
    const collaborators = collaboratorsByDocument.get(documentId);
    if (!collaborators)
        return;
    const key = `${userId}:${deviceId}`;
    const presence = collaborators.get(key);
    collaborators.delete(key);
    if (presence) {
        debugLog(`[CRDT] Document ${documentId}: ${presence.name} left`);
    }
    notifyListeners(documentId);
}
// =============================================================================
//  Public API
// =============================================================================
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
export function updateCursor(documentId, cursor, selection) {
    const config = getCRDTConfig();
    const now = Date.now();
    const lastUpdate = lastCursorUpdate.get(documentId) ?? 0;
    if (now - lastUpdate < config.cursorDebounceMs) {
        debugLog(`[CRDT] Document ${documentId}: cursor update throttled (${now - lastUpdate}ms < ${config.cursorDebounceMs}ms)`);
        return;
    }
    lastCursorUpdate.set(documentId, now);
    /* Update local collaborator entry (if tracking). */
    const collaborators = collaboratorsByDocument.get(documentId);
    if (!collaborators)
        return;
    const deviceId = getDeviceId();
    /* The local user's entry — find it or it might not exist yet. */
    for (const [key, state] of collaborators) {
        if (state.deviceId === deviceId) {
            collaborators.set(key, {
                ...state,
                cursor,
                selection,
                lastActiveAt: new Date().toISOString()
            });
            notifyListeners(documentId);
            break;
        }
    }
}
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
export function getCollaborators(documentId) {
    const collaborators = collaboratorsByDocument.get(documentId);
    if (!collaborators)
        return [];
    const localDeviceId = getDeviceId();
    const result = [];
    for (const state of collaborators.values()) {
        if (state.deviceId !== localDeviceId) {
            result.push(state);
        }
    }
    const count = result.length;
    if (count > 0) {
        debugLog(`[CRDT] Document ${documentId}: ${count} active collaborators`);
    }
    return result;
}
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
export function onCollaboratorsChange(documentId, callback) {
    let listeners = changeListeners.get(documentId);
    if (!listeners) {
        listeners = new Set();
        changeListeners.set(documentId, listeners);
    }
    listeners.add(callback);
    return () => {
        listeners.delete(callback);
        if (listeners.size === 0) {
            changeListeners.delete(documentId);
        }
    };
}
// =============================================================================
//  Internal Helpers
// =============================================================================
/**
 * Notify all listeners for a document of a collaborator change.
 */
function notifyListeners(documentId) {
    const listeners = changeListeners.get(documentId);
    if (!listeners || listeners.size === 0)
        return;
    const collaborators = getCollaborators(documentId);
    for (const callback of listeners) {
        try {
            callback(collaborators);
        }
        catch {
            /* Swallow listener errors to prevent cascading failures. */
        }
    }
}
//# sourceMappingURL=awareness.js.map