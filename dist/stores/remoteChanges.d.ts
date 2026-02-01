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
/**
 * Action types that can be detected from realtime events.
 * Used to apply appropriate animations.
 */
export type RemoteActionType = 'create' | 'delete' | 'toggle' | 'increment' | 'decrement' | 'reorder' | 'rename' | 'update';
interface RemoteChange {
    entityId: string;
    entityType: string;
    fields: string[];
    actionType: RemoteActionType;
    timestamp: number;
    applied: boolean;
    valueDelta?: number;
}
interface ActiveEdit {
    entityId: string;
    entityType: string;
    formType: 'auto-save' | 'manual-save';
    startedAt: number;
    fields?: string[];
}
interface RemoteChangesState {
    recentChanges: Map<string, RemoteChange>;
    activeEdits: Map<string, ActiveEdit>;
    deferredChanges: Map<string, RemoteChange[]>;
    pendingDeletes: Map<string, number>;
}
export declare const remoteChangesStore: {
    subscribe: (this: void, run: import("svelte/store").Subscriber<RemoteChangesState>, invalidate?: () => void) => import("svelte/store").Unsubscriber;
    /**
     * Detect action type from event type and changed fields.
     * This is how we know what animation to play even though Supabase
     * doesn't store the "action" - we infer it from what changed.
     */
    detectActionType(eventType: "INSERT" | "UPDATE" | "DELETE", fields: string[], valueDelta?: number): RemoteActionType;
    /**
     * Record a remote change that just arrived.
     * If the entity is being edited with a manual-save form, defer the change.
     * Otherwise, mark it as a recent change for animation.
     *
     * @param eventType - Supabase event type (INSERT/UPDATE/DELETE)
     * @param valueDelta - For increment/decrement, the change in value
     */
    recordRemoteChange(entityId: string, entityType: string, fields: string[], applied: boolean, eventType?: "INSERT" | "UPDATE" | "DELETE", valueDelta?: number): {
        deferred: boolean;
        actionType: RemoteActionType;
    };
    /**
     * Record a local change for animation purposes.
     * Call this BEFORE the component mounts (e.g., right before adding to database)
     * so that when the component mounts with remoteChangeAnimation, the create animation triggers.
     *
     * This is useful for local creates to animate the same way as remote creates.
     */
    recordLocalChange(entityId: string, entityType: string, actionType: RemoteActionType, fields?: string[]): void;
    /**
     * Mark an entity as being actively edited.
     * @param formType 'auto-save' for inline edits, 'manual-save' for modals with Save button
     */
    startEditing(entityId: string, entityType: string, formType: "auto-save" | "manual-save", fields?: string[]): void;
    /**
     * Mark editing as complete. Returns any deferred changes that need to be processed.
     */
    stopEditing(entityId: string, entityType: string): RemoteChange[];
    /**
     * Check if an entity is currently being edited.
     */
    isEditing(entityId: string, entityType: string): boolean;
    /**
     * Clear deferred changes for an entity without stopping editing.
     * Used when user dismisses or loads remote changes in the banner.
     */
    clearDeferredChanges(entityId: string, entityType: string): void;
    /**
     * Check if an entity has deferred changes waiting.
     */
    hasDeferredChanges(entityId: string, entityType: string): boolean;
    /**
     * Check if an entity was recently changed (for animation).
     */
    wasRecentlyChanged(entityId: string, entityType: string): boolean;
    /**
     * Get recent change details for an entity (for field-level animation).
     */
    getRecentChange(entityId: string, entityType: string): RemoteChange | null;
    /**
     * Mark an entity as pending delete (for delete animation).
     * Returns a promise that resolves after the animation duration.
     * The pending delete is cleared AFTER resolve so the caller can
     * delete from DB first — this prevents a reactive flash where the
     * item reappears between animation end and DOM removal.
     */
    markPendingDelete(entityId: string, entityType: string): Promise<void>;
    /**
     * Check if an entity is pending deletion (for animation).
     */
    isPendingDelete(entityId: string, entityType: string): boolean;
    /**
     * Clear all tracking (for logout).
     */
    clear(): void;
    /**
     * Stop the cleanup interval (for cleanup on unmount).
     */
    destroy(): void;
};
/**
 * Derived store for components to check if a specific entity was recently updated remotely.
 * Use this to trigger animations.
 */
export declare function createRecentChangeIndicator(entityId: string, entityType: string): import("svelte/store").Readable<RemoteChange | null>;
/**
 * Derived store for components to check if a specific entity is pending deletion.
 * Use this to apply delete animation before removing from DOM.
 */
export declare function createPendingDeleteIndicator(entityId: string, entityType: string): import("svelte/store").Readable<boolean>;
export {};
//# sourceMappingURL=remoteChanges.d.ts.map