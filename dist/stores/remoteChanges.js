/**
 * Remote Changes Store
 *
 * Manages incoming realtime changes and active editing state to enable:
 * - Graceful UI animations when remote changes arrive
 * - Protection of user edits from being overwritten
 * - Deferred change application for entities being edited
 *
 * Two types of entities:
 * 1. Auto-save entities (toggles, quick actions) - changes apply immediately with animation
 * 2. Form entities (modals with Save button) - changes are deferred until form closes
 *
 * Action type detection:
 * Since Supabase Realtime only sends INSERT/UPDATE/DELETE events, we detect
 * the specific action type by analyzing which fields changed:
 * - INSERT → 'create' action
 * - DELETE → 'delete' action
 * - UPDATE with 'completed' changed → 'toggle' action
 * - UPDATE with 'current_value' changed → 'increment' or 'decrement' action
 * - UPDATE with 'order' changed → 'reorder' action
 * - UPDATE with 'name' changed → 'rename' action
 * - UPDATE with 'is_enabled' changed → 'toggle' action (for block lists)
 * - UPDATE with other fields → 'update' action
 */
import { writable, derived } from 'svelte/store';
// ============================================================
// STORE
// ============================================================
const ANIMATION_DURATION = 2000; // How long to keep change in "recent" for animation
const CLEANUP_INTERVAL = 5000; // How often to clean up old changes
// How long to keep items in pending delete state for animation
const DELETE_ANIMATION_DURATION = 500;
function createRemoteChangesStore() {
    const { subscribe, update } = writable({
        recentChanges: new Map(),
        activeEdits: new Map(),
        deferredChanges: new Map(),
        pendingDeletes: new Map()
    });
    // Cleanup old changes periodically
    let cleanupInterval = null;
    function startCleanup() {
        if (cleanupInterval)
            return;
        if (typeof window === 'undefined')
            return;
        cleanupInterval = setInterval(() => {
            const now = Date.now();
            update((state) => {
                // Remove old recent changes
                for (const [key, change] of state.recentChanges) {
                    if (now - change.timestamp > ANIMATION_DURATION) {
                        state.recentChanges.delete(key);
                    }
                }
                return state;
            });
        }, CLEANUP_INTERVAL);
    }
    function stopCleanup() {
        if (cleanupInterval) {
            clearInterval(cleanupInterval);
            cleanupInterval = null;
        }
    }
    return {
        subscribe,
        /**
         * Detect action type from event type and changed fields.
         * This is how we know what animation to play even though Supabase
         * doesn't store the "action" - we infer it from what changed.
         */
        detectActionType(eventType, fields, valueDelta) {
            if (eventType === 'INSERT')
                return 'create';
            if (eventType === 'DELETE')
                return 'delete';
            // For UPDATE, determine action from which fields changed
            // Priority order matters - more specific actions first
            // Toggle actions (completed, is_enabled)
            if (fields.includes('completed') || fields.includes('is_enabled')) {
                return 'toggle';
            }
            // Increment/decrement (current_value changed)
            if (fields.includes('current_value')) {
                if (valueDelta !== undefined) {
                    return valueDelta > 0 ? 'increment' : 'decrement';
                }
                return 'increment'; // Default to increment if delta unknown
            }
            // Reorder (order changed)
            if (fields.includes('order') && fields.length === 1) {
                return 'reorder';
            }
            // Rename or visual property change (name, color)
            if ((fields.includes('name') || fields.includes('color')) && fields.length <= 2) {
                return 'rename';
            }
            // Generic update for other changes
            return 'update';
        },
        /**
         * Record a remote change that just arrived.
         * If the entity is being edited with a manual-save form, defer the change.
         * Otherwise, mark it as a recent change for animation.
         *
         * @param eventType - Supabase event type (INSERT/UPDATE/DELETE)
         * @param valueDelta - For increment/decrement, the change in value
         */
        recordRemoteChange(entityId, entityType, fields, applied, eventType = 'UPDATE', valueDelta) {
            startCleanup();
            const actionType = this.detectActionType(eventType, fields, valueDelta);
            const change = {
                entityId,
                entityType,
                fields,
                actionType,
                timestamp: Date.now(),
                applied,
                valueDelta
            };
            let deferred = false;
            update((state) => {
                const key = `${entityType}:${entityId}`;
                const activeEdit = state.activeEdits.get(key);
                if (activeEdit && activeEdit.formType === 'manual-save') {
                    // Entity is being edited in a form with Save button - defer the change
                    const existing = state.deferredChanges.get(key) || [];
                    existing.push(change);
                    state.deferredChanges.set(key, existing);
                    deferred = true;
                }
                else {
                    // Apply immediately (or already applied) - record for animation
                    state.recentChanges.set(key, change);
                }
                return state;
            });
            return { deferred, actionType };
        },
        /**
         * Record a local change for animation purposes.
         * Call this BEFORE the component mounts (e.g., right before adding to database)
         * so that when the component mounts with remoteChangeAnimation, the create animation triggers.
         *
         * This is useful for local creates to animate the same way as remote creates.
         */
        recordLocalChange(entityId, entityType, actionType, fields = ['*']) {
            startCleanup();
            const change = {
                entityId,
                entityType,
                fields,
                actionType,
                timestamp: Date.now(),
                applied: true
            };
            update((state) => {
                const key = `${entityType}:${entityId}`;
                state.recentChanges.set(key, change);
                return state;
            });
        },
        /**
         * Mark an entity as being actively edited.
         * @param formType 'auto-save' for inline edits, 'manual-save' for modals with Save button
         */
        startEditing(entityId, entityType, formType, fields) {
            update((state) => {
                const key = `${entityType}:${entityId}`;
                state.activeEdits.set(key, {
                    entityId,
                    entityType,
                    formType,
                    startedAt: Date.now(),
                    fields
                });
                return state;
            });
        },
        /**
         * Mark editing as complete. Returns any deferred changes that need to be processed.
         */
        stopEditing(entityId, entityType) {
            let deferredChanges = [];
            update((state) => {
                const key = `${entityType}:${entityId}`;
                state.activeEdits.delete(key);
                // Return deferred changes for processing
                if (state.deferredChanges.has(key)) {
                    deferredChanges = state.deferredChanges.get(key) || [];
                    state.deferredChanges.delete(key);
                }
                return state;
            });
            return deferredChanges;
        },
        /**
         * Check if an entity is currently being edited.
         */
        isEditing(entityId, entityType) {
            let editing = false;
            const unsubscribe = subscribe((state) => {
                editing = state.activeEdits.has(`${entityType}:${entityId}`);
            });
            unsubscribe();
            return editing;
        },
        /**
         * Clear deferred changes for an entity without stopping editing.
         * Used when user dismisses or loads remote changes in the banner.
         */
        clearDeferredChanges(entityId, entityType) {
            update((state) => {
                const key = `${entityType}:${entityId}`;
                state.deferredChanges.delete(key);
                return state;
            });
        },
        /**
         * Check if an entity has deferred changes waiting.
         */
        hasDeferredChanges(entityId, entityType) {
            let hasChanges = false;
            const unsubscribe = subscribe((state) => {
                const key = `${entityType}:${entityId}`;
                const changes = state.deferredChanges.get(key);
                hasChanges = !!changes && changes.length > 0;
            });
            unsubscribe();
            return hasChanges;
        },
        /**
         * Check if an entity was recently changed (for animation).
         */
        wasRecentlyChanged(entityId, entityType) {
            let recent = false;
            const unsubscribe = subscribe((state) => {
                const key = `${entityType}:${entityId}`;
                const change = state.recentChanges.get(key);
                if (change && Date.now() - change.timestamp < ANIMATION_DURATION) {
                    recent = true;
                }
            });
            unsubscribe();
            return recent;
        },
        /**
         * Get recent change details for an entity (for field-level animation).
         */
        getRecentChange(entityId, entityType) {
            let change = null;
            const unsubscribe = subscribe((state) => {
                const key = `${entityType}:${entityId}`;
                const c = state.recentChanges.get(key);
                if (c && Date.now() - c.timestamp < ANIMATION_DURATION) {
                    change = c;
                }
            });
            unsubscribe();
            return change;
        },
        /**
         * Mark an entity as pending delete (for delete animation).
         * Returns a promise that resolves after the animation duration.
         * The pending delete is cleared AFTER resolve so the caller can
         * delete from DB first — this prevents a reactive flash where the
         * item reappears between animation end and DOM removal.
         */
        markPendingDelete(entityId, entityType) {
            update((state) => {
                const key = `${entityType}:${entityId}`;
                state.pendingDeletes.set(key, Date.now());
                return state;
            });
            // Return promise that resolves after animation duration
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve();
                    // Clean up after a short delay — the caller deletes from DB on
                    // resolve which triggers DOM removal, so this is just housekeeping
                    setTimeout(() => {
                        update((state) => {
                            const key = `${entityType}:${entityId}`;
                            state.pendingDeletes.delete(key);
                            return state;
                        });
                    }, 100);
                }, DELETE_ANIMATION_DURATION);
            });
        },
        /**
         * Check if an entity is pending deletion (for animation).
         */
        isPendingDelete(entityId, entityType) {
            let pending = false;
            const unsubscribe = subscribe((state) => {
                const key = `${entityType}:${entityId}`;
                pending = state.pendingDeletes.has(key);
            });
            unsubscribe();
            return pending;
        },
        /**
         * Clear all tracking (for logout).
         */
        clear() {
            stopCleanup();
            update(() => ({
                recentChanges: new Map(),
                activeEdits: new Map(),
                deferredChanges: new Map(),
                pendingDeletes: new Map()
            }));
        },
        /**
         * Stop the cleanup interval (for cleanup on unmount).
         */
        destroy() {
            stopCleanup();
        }
    };
}
export const remoteChangesStore = createRemoteChangesStore();
// ============================================================
// DERIVED STORES FOR UI
// ============================================================
/**
 * Derived store for components to check if a specific entity was recently updated remotely.
 * Use this to trigger animations.
 */
export function createRecentChangeIndicator(entityId, entityType) {
    return derived(remoteChangesStore, ($state) => {
        const key = `${entityType}:${entityId}`;
        const change = $state.recentChanges.get(key);
        if (!change)
            return null;
        if (Date.now() - change.timestamp > ANIMATION_DURATION)
            return null;
        return change;
    });
}
/**
 * Derived store for components to check if a specific entity is pending deletion.
 * Use this to apply delete animation before removing from DOM.
 */
export function createPendingDeleteIndicator(entityId, entityType) {
    return derived(remoteChangesStore, ($state) => {
        const key = `${entityType}:${entityId}`;
        return $state.pendingDeletes.has(key);
    });
}
//# sourceMappingURL=remoteChanges.js.map