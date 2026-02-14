/**
 * @fileoverview Remote Changes Store
 *
 * Manages incoming realtime changes and active editing state to enable:
 *   - Graceful UI animations when remote changes arrive
 *   - Protection of user edits from being overwritten by concurrent updates
 *   - Deferred change application for entities being edited in manual-save forms
 *
 * **Entity Classification:**
 * The store distinguishes between two types of editable entities:
 *   1. **Auto-save entities** (toggles, quick actions) - Changes apply immediately
 *      with animation. No conflict risk since the user interaction is atomic.
 *   2. **Form entities** (modals with a Save button) - Remote changes are deferred
 *      and queued until the form closes, preventing mid-edit data corruption.
 *
 * **Action Type Detection:**
 * Since Supabase Realtime only sends INSERT/UPDATE/DELETE events (no semantic
 * action type), this store infers the user-level action by analyzing which
 * fields changed in the payload:
 *   - INSERT -> 'create' action
 *   - DELETE -> 'delete' action
 *   - UPDATE with 'completed' changed -> 'toggle' action
 *   - UPDATE with 'current_value' changed -> 'increment' or 'decrement' action
 *   - UPDATE with 'order' changed -> 'reorder' action
 *   - UPDATE with 'name' changed -> 'rename' action
 *   - UPDATE with 'is_enabled' changed -> 'toggle' action (for block lists)
 *   - UPDATE with other fields -> 'update' action
 *
 * **Svelte Store Pattern:**
 * Uses a custom writable store with a `Map`-heavy internal state. Methods
 * on the store provide imperative access for the sync engine, while derived
 * store factories (`createRecentChangeIndicator`, `createPendingDeleteIndicator`)
 * provide reactive per-entity subscriptions for UI components.
 *
 * **Reactive Architecture:**
 * Components use the derived store factories to subscribe to changes for a
 * specific entity, enabling fine-grained reactivity without re-rendering the
 * entire list when a single item changes.
 *
 * @see {@link ./sync} for the sync store that triggers remote change recording
 * @see {@link ./network} for connectivity state that gates realtime subscriptions
 */
import { writable, derived } from 'svelte/store';
// =============================================================================
// Constants
// =============================================================================
/** Duration (ms) to keep a change in the `recentChanges` map for animation purposes */
const ANIMATION_DURATION = 2000;
/** Interval (ms) at which stale entries are purged from `recentChanges` */
const CLEANUP_INTERVAL = 5000;
/** Duration (ms) to keep an entity in the `pendingDeletes` state for exit animation */
const DELETE_ANIMATION_DURATION = 500;
// =============================================================================
// Store Factory
// =============================================================================
/**
 * Creates the singleton remote changes store.
 *
 * The store manages four concurrent concerns:
 *   1. **Recent changes** - Short-lived entries that drive UI animations
 *   2. **Active edits** - Tracks which entities the local user is editing
 *   3. **Deferred changes** - Queues remote changes for entities in manual-save forms
 *   4. **Pending deletes** - Coordinates delete animations with actual DB removal
 *
 * A periodic cleanup interval automatically purges stale `recentChanges` entries.
 * The interval is lazily started on the first recorded change and can be stopped
 * via `destroy()`.
 *
 * @returns A Svelte-compatible store with remote-change-specific methods
 */
function createRemoteChangesStore() {
    const { subscribe, update } = writable({
        recentChanges: new Map(),
        activeEdits: new Map(),
        deferredChanges: new Map(),
        pendingDeletes: new Map()
    });
    // ---------------------------------------------------------------------------
    // Cleanup Timer
    // ---------------------------------------------------------------------------
    /** Handle for the periodic cleanup interval; null when not running */
    let cleanupInterval = null;
    /**
     * Lazily starts the periodic cleanup timer that purges stale entries
     * from `recentChanges`. No-ops if already running or in SSR context.
     */
    function startCleanup() {
        if (cleanupInterval)
            return;
        if (typeof window === 'undefined')
            return;
        cleanupInterval = setInterval(() => {
            const now = Date.now();
            update((state) => {
                const newRecentChanges = new Map(state.recentChanges);
                /* Remove entries older than ANIMATION_DURATION so the animation
                 * CSS class is no longer applied on the next render cycle */
                for (const [key, change] of newRecentChanges) {
                    if (now - change.timestamp > ANIMATION_DURATION) {
                        newRecentChanges.delete(key);
                    }
                }
                return { ...state, recentChanges: newRecentChanges };
            });
        }, CLEANUP_INTERVAL);
    }
    /**
     * Stops the periodic cleanup timer. Called by `clear()` and `destroy()`.
     */
    function stopCleanup() {
        if (cleanupInterval) {
            clearInterval(cleanupInterval);
            cleanupInterval = null;
        }
    }
    // ---------------------------------------------------------------------------
    // Store Methods
    // ---------------------------------------------------------------------------
    return {
        subscribe,
        /**
         * Infer the semantic action type from a Supabase realtime event.
         *
         * Since Supabase Realtime only provides INSERT/UPDATE/DELETE event types,
         * this method analyzes the changed field names to determine the user-level
         * action (toggle, increment, reorder, etc.) for animation purposes.
         *
         * Priority order matters: more specific field patterns are checked first
         * to avoid false positives (e.g., an UPDATE that changes both 'completed'
         * and 'name' is classified as 'toggle', not 'rename').
         *
         * @param eventType - The raw Supabase realtime event type
         * @param fields - Array of field names that changed in this event
         * @param valueDelta - Optional signed delta for numeric field changes
         * @returns The inferred semantic action type
         *
         * @example
         * ```ts
         * const action = remoteChangesStore.detectActionType('UPDATE', ['completed'], undefined);
         * // Returns: 'toggle'
         *
         * const action2 = remoteChangesStore.detectActionType('UPDATE', ['current_value'], -1);
         * // Returns: 'decrement'
         * ```
         */
        detectActionType(eventType, fields, valueDelta) {
            if (eventType === 'INSERT')
                return 'create';
            if (eventType === 'DELETE')
                return 'delete';
            /* For UPDATE, determine action from which fields changed.
             * Priority order matters - more specific actions first. */
            /* Toggle actions (completed, is_enabled) */
            if (fields.includes('completed') || fields.includes('is_enabled')) {
                return 'toggle';
            }
            /* Increment/decrement (current_value changed) */
            if (fields.includes('current_value')) {
                if (valueDelta !== undefined) {
                    return valueDelta > 0 ? 'increment' : 'decrement';
                }
                return 'increment'; /* Default to increment if delta is unknown */
            }
            /* Reorder - only when 'order' is the sole changed field */
            if (fields.includes('order') && fields.length === 1) {
                return 'reorder';
            }
            /* Rename or visual property change (name, color) with minimal other changes */
            if ((fields.includes('name') || fields.includes('color')) && fields.length <= 2) {
                return 'rename';
            }
            /* Generic update for any other combination of changed fields */
            return 'update';
        },
        /**
         * Record a remote change that just arrived via Supabase Realtime.
         *
         * Routing logic:
         *   - If the entity is being edited in a **manual-save** form, the change is
         *     deferred (queued) and will be returned when `stopEditing()` is called.
         *   - Otherwise, the change is stored in `recentChanges` for animation.
         *
         * @param entityId - Unique identifier of the changed entity
         * @param entityType - Database table name
         * @param fields - Array of field names that changed
         * @param applied - Whether the change was already written to the local DB
         * @param eventType - Supabase realtime event type (defaults to 'UPDATE')
         * @param valueDelta - Signed delta for numeric changes (for animation direction)
         * @returns Object indicating whether the change was deferred and the detected action type
         *
         * @see detectActionType for how the action type is inferred
         * @see stopEditing for retrieving deferred changes
         *
         * @example
         * ```ts
         * const result = remoteChangesStore.recordRemoteChange(
         *   'abc-123', 'todos', ['completed'], true, 'UPDATE'
         * );
         * if (result.deferred) {
         *   console.log('Change queued - entity is being edited');
         * }
         * ```
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
                    /* Entity is being edited in a form with a Save button - defer the change
                     * to prevent overwriting the user's in-progress edits */
                    const newDeferredChanges = new Map(state.deferredChanges);
                    const existing = [...(newDeferredChanges.get(key) || [])];
                    existing.push(change);
                    newDeferredChanges.set(key, existing);
                    deferred = true;
                    return { ...state, deferredChanges: newDeferredChanges };
                }
                else {
                    /* No conflicting edit in progress - record for immediate animation */
                    const newRecentChanges = new Map(state.recentChanges);
                    newRecentChanges.set(key, change);
                    return { ...state, recentChanges: newRecentChanges };
                }
            });
            return { deferred, actionType };
        },
        /**
         * Record a local change for animation purposes.
         *
         * Call this **before** the component mounts (e.g., right before inserting
         * into the database) so that when the component renders with the
         * `remoteChangeAnimation` directive, the create/update animation triggers
         * on the initial mount.
         *
         * This ensures local creates animate identically to remote creates,
         * providing a consistent visual experience.
         *
         * @param entityId - Unique identifier of the changed entity
         * @param entityType - Database table name
         * @param actionType - The semantic action type to animate
         * @param fields - Array of changed field names (defaults to `['*']` for all)
         *
         * @example
         * ```ts
         * // Before inserting a new todo:
         * remoteChangesStore.recordLocalChange(newId, 'todos', 'create');
         * await db.todos.insert({ id: newId, name: 'New Todo' });
         * ```
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
                const newRecentChanges = new Map(state.recentChanges);
                newRecentChanges.set(key, change);
                return { ...state, recentChanges: newRecentChanges };
            });
        },
        /**
         * Mark an entity as being actively edited by the local user.
         *
         * While an entity is marked as editing:
         *   - **auto-save**: Remote changes still apply immediately (no conflict risk)
         *   - **manual-save**: Remote changes are deferred until `stopEditing()` is called
         *
         * @param entityId - Unique identifier of the entity being edited
         * @param entityType - Database table name
         * @param formType - 'auto-save' for inline edits, 'manual-save' for modal/form edits
         * @param fields - Optional list of specific fields being edited (for field-level tracking)
         *
         * @see stopEditing for completing the edit session and retrieving deferred changes
         *
         * @example
         * ```ts
         * // When opening a todo edit modal:
         * remoteChangesStore.startEditing(todoId, 'todos', 'manual-save', ['name', 'description']);
         * ```
         */
        startEditing(entityId, entityType, formType, fields) {
            update((state) => {
                const key = `${entityType}:${entityId}`;
                const newActiveEdits = new Map(state.activeEdits);
                newActiveEdits.set(key, {
                    entityId,
                    entityType,
                    formType,
                    startedAt: Date.now(),
                    fields
                });
                return { ...state, activeEdits: newActiveEdits };
            });
        },
        /**
         * Mark editing as complete and return any deferred changes.
         *
         * The caller is responsible for processing the returned deferred changes
         * (typically by refreshing the entity from the database or replaying
         * the changes).
         *
         * @param entityId - Unique identifier of the entity
         * @param entityType - Database table name
         * @returns Array of deferred remote changes that arrived during the edit session
         *
         * @see startEditing for beginning an edit session
         *
         * @example
         * ```ts
         * // When closing a todo edit modal:
         * const deferred = remoteChangesStore.stopEditing(todoId, 'todos');
         * if (deferred.length > 0) {
         *   await refreshTodoFromServer(todoId);
         * }
         * ```
         */
        stopEditing(entityId, entityType) {
            let deferredChanges = [];
            update((state) => {
                const key = `${entityType}:${entityId}`;
                const newActiveEdits = new Map(state.activeEdits);
                newActiveEdits.delete(key);
                const newDeferredChanges = new Map(state.deferredChanges);
                /* Extract deferred changes for the caller to process */
                if (newDeferredChanges.has(key)) {
                    deferredChanges = newDeferredChanges.get(key) || [];
                    newDeferredChanges.delete(key);
                }
                return { ...state, activeEdits: newActiveEdits, deferredChanges: newDeferredChanges };
            });
            return deferredChanges;
        },
        /**
         * Synchronously check if an entity is currently being edited.
         *
         * Uses the subscribe-and-immediately-unsubscribe pattern to read the
         * current store value imperatively (outside of a reactive context).
         *
         * @param entityId - Unique identifier of the entity
         * @param entityType - Database table name
         * @returns `true` if the entity has an active edit session
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
         * Clear deferred changes for an entity without ending the edit session.
         *
         * Used when the user explicitly dismisses a "remote changes available"
         * banner or loads the remote version, acknowledging the deferred changes
         * without closing the form.
         *
         * @param entityId - Unique identifier of the entity
         * @param entityType - Database table name
         */
        clearDeferredChanges(entityId, entityType) {
            update((state) => {
                const key = `${entityType}:${entityId}`;
                const newDeferredChanges = new Map(state.deferredChanges);
                newDeferredChanges.delete(key);
                return { ...state, deferredChanges: newDeferredChanges };
            });
        },
        /**
         * Synchronously check if an entity has deferred changes waiting.
         *
         * Typically used by edit forms to display a "remote changes available"
         * indicator or banner.
         *
         * @param entityId - Unique identifier of the entity
         * @param entityType - Database table name
         * @returns `true` if one or more deferred changes exist for this entity
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
         * Synchronously check if an entity was recently changed (within `ANIMATION_DURATION`).
         *
         * Used by components to determine whether to apply an animation CSS class
         * on mount or re-render.
         *
         * @param entityId - Unique identifier of the entity
         * @param entityType - Database table name
         * @returns `true` if the entity has a recent change within the animation window
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
         * Synchronously retrieve the full `RemoteChange` details for a recently
         * changed entity. Returns `null` if no recent change exists or the
         * animation window has expired.
         *
         * Used for field-level animation where the component needs to know
         * which specific fields changed and the action type.
         *
         * @param entityId - Unique identifier of the entity
         * @param entityType - Database table name
         * @returns The `RemoteChange` object if within the animation window, otherwise `null`
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
         * Initiate a delete animation for an entity.
         *
         * Returns a promise that resolves after `DELETE_ANIMATION_DURATION` ms,
         * giving the UI time to play an exit animation. The caller should perform
         * the actual database deletion **after** the promise resolves.
         *
         * The pending delete entry is cleaned up ~100ms after resolve, which is
         * just housekeeping since the DB deletion (triggered on resolve) will
         * cause the reactive DOM removal.
         *
         * @param entityId - Unique identifier of the entity to delete
         * @param entityType - Database table name
         * @returns A promise that resolves after the animation duration
         *
         * @see createPendingDeleteIndicator for the reactive per-entity derived store
         *
         * @example
         * ```ts
         * // Animate, then delete:
         * await remoteChangesStore.markPendingDelete(todoId, 'todos');
         * await db.todos.delete(todoId);
         * ```
         */
        markPendingDelete(entityId, entityType) {
            update((state) => {
                const key = `${entityType}:${entityId}`;
                const newPendingDeletes = new Map(state.pendingDeletes);
                newPendingDeletes.set(key, Date.now());
                return { ...state, pendingDeletes: newPendingDeletes };
            });
            /* Return a promise that resolves after the animation completes */
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve();
                    /* Clean up the pending delete entry after a short delay.
                     * The caller deletes from DB on resolve which triggers DOM removal,
                     * so this is just housekeeping to avoid stale map entries. */
                    setTimeout(() => {
                        update((state) => {
                            const key = `${entityType}:${entityId}`;
                            const newPendingDeletes = new Map(state.pendingDeletes);
                            newPendingDeletes.delete(key);
                            return { ...state, pendingDeletes: newPendingDeletes };
                        });
                    }, 100);
                }, DELETE_ANIMATION_DURATION);
            });
        },
        /**
         * Synchronously check if an entity is currently pending deletion
         * (i.e., its exit animation is in progress).
         *
         * @param entityId - Unique identifier of the entity
         * @param entityType - Database table name
         * @returns `true` if the entity is in the pending delete state
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
         * Clear all tracking state (recent changes, active edits, deferred changes,
         * pending deletes) and stop the cleanup timer.
         *
         * Called during logout to ensure no stale state carries over to the next session.
         *
         * @see destroy for cleanup without state reset (e.g., component unmount)
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
         * Stop the periodic cleanup interval without resetting state.
         *
         * Called during component unmount or app teardown to prevent memory leaks
         * from orphaned intervals.
         *
         * @see clear for full state reset including cleanup stop
         */
        destroy() {
            stopCleanup();
        }
    };
}
// =============================================================================
// Singleton Store Instance
// =============================================================================
/**
 * Singleton remote changes store used throughout the application.
 *
 * @see {@link createRemoteChangesStore} for implementation details
 */
export const remoteChangesStore = createRemoteChangesStore();
// =============================================================================
// Derived Store Factories
// =============================================================================
/**
 * Creates a derived store that reactively tracks whether a specific entity
 * was recently changed remotely.
 *
 * The derived store emits the full `RemoteChange` object while the change
 * is within the animation window, or `null` otherwise. Components use this
 * to apply and remove animation CSS classes.
 *
 * @param entityId - Unique identifier of the entity to watch
 * @param entityType - Database table name
 * @returns A Svelte readable store that emits `RemoteChange | null`
 *
 * @see remoteChangesStore.recordRemoteChange for how changes enter the recent map
 *
 * @example
 * ```svelte
 * <script>
 *   const recentChange = createRecentChangeIndicator(todo.id, 'todos');
 * </script>
 * <div class:animate-pulse={$recentChange?.actionType === 'toggle'}>
 *   {todo.name}
 * </div>
 * ```
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
 * Creates a derived store that reactively tracks whether a specific entity
 * is pending deletion (i.e., its exit animation is in progress).
 *
 * The derived store emits `true` while the entity is in the pending delete
 * state, and `false` otherwise. Components use this to apply exit animation
 * CSS classes before the entity is removed from the DOM.
 *
 * @param entityId - Unique identifier of the entity to watch
 * @param entityType - Database table name
 * @returns A Svelte readable store that emits a boolean
 *
 * @see remoteChangesStore.markPendingDelete for how entities enter the pending state
 *
 * @example
 * ```svelte
 * <script>
 *   const isPending = createPendingDeleteIndicator(todo.id, 'todos');
 * </script>
 * <div class:opacity-0={$isPending} class:transition-opacity={$isPending}>
 *   {todo.name}
 * </div>
 * ```
 */
export function createPendingDeleteIndicator(entityId, entityType) {
    return derived(remoteChangesStore, ($state) => {
        const key = `${entityType}:${entityId}`;
        return $state.pendingDeletes.has(key);
    });
}
//# sourceMappingURL=remoteChanges.js.map