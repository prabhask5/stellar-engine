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
/**
 * Semantic action types inferred from Supabase realtime events.
 * Used by UI components to select the appropriate animation or visual indicator.
 */
export type RemoteActionType = 'create' | 'delete' | 'toggle' | 'increment' | 'decrement' | 'reorder' | 'rename' | 'update';
/**
 * Represents a single remote change event recorded by the store.
 * Stored in `recentChanges` for animation and in `deferredChanges` for
 * entities currently being edited in manual-save forms.
 */
interface RemoteChange {
    /** Unique identifier of the changed entity */
    entityId: string;
    /** Database table name the entity belongs to */
    entityType: string;
    /** List of field names that changed in this event */
    fields: string[];
    /** Inferred semantic action type for animation selection */
    actionType: RemoteActionType;
    /** Unix timestamp (ms) when the change was recorded locally */
    timestamp: number;
    /** Whether the change was already applied to the local database */
    applied: boolean;
    /**
     * For increment/decrement actions, the signed delta value.
     * Positive = increment, negative = decrement. Used to determine
     * animation direction (e.g., green flash vs. red flash).
     */
    valueDelta?: number;
}
/**
 * Represents an entity currently being edited by the local user.
 * Used to determine whether incoming remote changes should be applied
 * immediately or deferred until editing completes.
 */
interface ActiveEdit {
    /** Unique identifier of the entity being edited */
    entityId: string;
    /** Database table name the entity belongs to */
    entityType: string;
    /**
     * Editing mode that determines change deferral behavior:
     *   - 'auto-save': Inline edits (toggles, sliders) - remote changes apply immediately
     *   - 'manual-save': Modal/form edits with a Save button - remote changes are deferred
     */
    formType: 'auto-save' | 'manual-save';
    /** Unix timestamp (ms) when the edit session started */
    startedAt: number;
    /** Optional list of specific fields being edited (for field-level conflict tracking) */
    fields?: string[];
}
/**
 * Complete internal state shape for the remote changes store.
 */
interface RemoteChangesState {
    /**
     * Recently applied remote changes, keyed by `entityType:entityId`.
     * Entries are automatically cleaned up after `ANIMATION_DURATION` ms.
     * UI components check this map to trigger visual animations.
     */
    recentChanges: Map<string, RemoteChange>;
    /**
     * Entities currently being edited by the local user, keyed by `entityType:entityId`.
     * Determines whether incoming changes are applied immediately or deferred.
     */
    activeEdits: Map<string, ActiveEdit>;
    /**
     * Changes deferred because the target entity is being edited in a manual-save form.
     * Keyed by `entityType:entityId`, values are arrays of changes in arrival order.
     * Returned to the caller when `stopEditing()` is invoked so they can be replayed.
     */
    deferredChanges: Map<string, RemoteChange[]>;
    /**
     * Entities awaiting delete animation completion before actual DB removal.
     * Keyed by `entityType:entityId`, values are timestamps of when the delete was initiated.
     * Components check this to apply exit animations before the entity is removed from the DOM.
     */
    pendingDeletes: Map<string, number>;
}
/**
 * Singleton remote changes store used throughout the application.
 *
 * @see {@link createRemoteChangesStore} for implementation details
 */
export declare const remoteChangesStore: {
    subscribe: (this: void, run: import("svelte/store").Subscriber<RemoteChangesState>, invalidate?: () => void) => import("svelte/store").Unsubscriber;
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
    detectActionType(eventType: "INSERT" | "UPDATE" | "DELETE", fields: string[], valueDelta?: number): RemoteActionType;
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
    recordRemoteChange(entityId: string, entityType: string, fields: string[], applied: boolean, eventType?: "INSERT" | "UPDATE" | "DELETE", valueDelta?: number): {
        deferred: boolean;
        actionType: RemoteActionType;
    };
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
    recordLocalChange(entityId: string, entityType: string, actionType: RemoteActionType, fields?: string[]): void;
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
    startEditing(entityId: string, entityType: string, formType: "auto-save" | "manual-save", fields?: string[]): void;
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
    stopEditing(entityId: string, entityType: string): RemoteChange[];
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
    isEditing(entityId: string, entityType: string): boolean;
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
    clearDeferredChanges(entityId: string, entityType: string): void;
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
    hasDeferredChanges(entityId: string, entityType: string): boolean;
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
    wasRecentlyChanged(entityId: string, entityType: string): boolean;
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
    getRecentChange(entityId: string, entityType: string): RemoteChange | null;
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
    markPendingDelete(entityId: string, entityType: string): Promise<void>;
    /**
     * Synchronously check if an entity is currently pending deletion
     * (i.e., its exit animation is in progress).
     *
     * @param entityId - Unique identifier of the entity
     * @param entityType - Database table name
     * @returns `true` if the entity is in the pending delete state
     */
    isPendingDelete(entityId: string, entityType: string): boolean;
    /**
     * Clear all tracking state (recent changes, active edits, deferred changes,
     * pending deletes) and stop the cleanup timer.
     *
     * Called during logout to ensure no stale state carries over to the next session.
     *
     * @see destroy for cleanup without state reset (e.g., component unmount)
     */
    clear(): void;
    /**
     * Stop the periodic cleanup interval without resetting state.
     *
     * Called during component unmount or app teardown to prevent memory leaks
     * from orphaned intervals.
     *
     * @see clear for full state reset including cleanup stop
     */
    destroy(): void;
};
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
export declare function createRecentChangeIndicator(entityId: string, entityType: string): import("svelte/store").Readable<RemoteChange | null>;
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
export declare function createPendingDeleteIndicator(entityId: string, entityType: string): import("svelte/store").Readable<boolean>;
export {};
//# sourceMappingURL=remoteChanges.d.ts.map