/**
 * @fileoverview Remote Change Animation Action
 *
 * A Svelte action that automatically adds remote change animations to elements.
 * Use this on list items, cards, or any element that can be updated remotely
 * (e.g., via Supabase Realtime subscriptions).
 *
 * The action detects the ACTION TYPE from the remote change and applies
 * the appropriate CSS animation class:
 *   - `'create'`    --> `item-created`       (slide in with burst)
 *   - `'delete'`    --> `item-deleting`       (slide out with fade)
 *   - `'toggle'`    --> `item-toggled`        (+ checkbox-animating + completion-ripple)
 *   - `'increment'` --> `counter-increment`   (bump up)
 *   - `'decrement'` --> `counter-decrement`   (bump down)
 *   - `'reorder'`   --> `item-reordering`     (slide to new position)
 *   - `'rename'`    --> `text-changed`        (highlight flash)
 *   - `'update'`    --> `item-changed`        (default highlight)
 *
 * @example
 * ```svelte
 * <div use:remoteChangeAnimation={{ entityId: item.id, entityType: 'goals' }}>
 *   ...
 * </div>
 * ```
 *
 * @see {@link remoteChangeAnimation} for the main Svelte action
 * @see {@link trackEditing} for deferred-change tracking on forms
 * @see {@link triggerLocalAnimation} for programmatic local animations
 */
import { type RemoteActionType } from '../stores/remoteChanges';
/**
 * Configuration options for the {@link remoteChangeAnimation} Svelte action.
 */
interface RemoteChangeOptions {
    /** The unique identifier of the entity being watched (e.g., a row UUID). */
    entityId: string;
    /** The entity type / table name (e.g., `'goals'`, `'tasks'`). */
    entityType: string;
    /**
     * Optional list of field names to watch. When provided, animations are
     * only triggered if the remote change includes at least one of these
     * fields (or the wildcard `'*'`). Omit to animate on any field change.
     */
    fields?: string[];
    /**
     * Optional CSS class override. When set, this class is used instead of
     * the default mapping from {@link ACTION_ANIMATION_MAP}.
     */
    animationClass?: string;
    /**
     * Optional callback invoked when a remote action is detected.
     * Useful for component-specific handling beyond CSS animations
     * (e.g., updating local state, playing sounds, showing toasts).
     *
     * @param actionType - The type of remote action detected.
     * @param fields - The list of fields that changed.
     */
    onAction?: (actionType: RemoteActionType, fields: string[]) => void;
}
/**
 * Svelte action that watches for remote changes on a specific entity and
 * applies the appropriate CSS animation class to the host element.
 *
 * **Lifecycle:**
 *   1. On mount, checks for a recent change that may have arrived before
 *      the element was rendered (important for CREATE animations on new items).
 *   2. Subscribes to the `remoteChangesStore` for future changes.
 *   3. Subscribes to a pending-delete indicator for delete animations.
 *   4. On update, re-subscribes if the entity identity changes.
 *   5. On destroy, unsubscribes and cleans up CSS classes.
 *
 * @param node - The DOM element to animate.
 * @param options - Configuration specifying which entity to watch.
 * @returns A Svelte action lifecycle object with `update` and `destroy` methods.
 *
 * @example
 * ```svelte
 * <div use:remoteChangeAnimation={{ entityId: item.id, entityType: 'goals' }}>
 *   {item.name}
 * </div>
 * ```
 */
export declare function remoteChangeAnimation(node: HTMLElement, options: RemoteChangeOptions): {
    /**
     * Called when the action's options change. If the entity identity
     * (`entityId` or `entityType`) has changed, tears down old subscriptions
     * and creates new ones for the updated entity.
     *
     * @param newOptions - The updated {@link RemoteChangeOptions}.
     */
    update(newOptions: RemoteChangeOptions): void;
    /**
     * Cleanup handler — unsubscribes from all stores, removes the base
     * CSS class, and clears the element from the animation tracking set.
     */
    destroy(): void;
};
/**
 * Svelte action for form elements that should track editing state.
 * Use this on modal forms with Save buttons to defer remote changes
 * while the user is actively editing, preventing disruptive overwrites.
 *
 * When the form is destroyed (e.g., modal closes), any deferred changes
 * are passed to the `onDeferredChanges` callback so the component can
 * decide how to reconcile them.
 *
 * @example
 * ```svelte
 * <form use:trackEditing={{ entityId: item.id, entityType: 'goals', formType: 'manual-save' }}>
 *   ...
 * </form>
 * ```
 */
/**
 * Configuration options for the {@link trackEditing} Svelte action.
 */
interface TrackEditingOptions {
    /** The unique identifier of the entity being edited. */
    entityId: string;
    /** The entity type / table name (e.g., `'goals'`, `'tasks'`). */
    entityType: string;
    /**
     * The save behaviour of the form:
     *   - `'auto-save'` — changes are saved immediately (e.g., inline editing).
     *   - `'manual-save'` — changes are saved on explicit submit (e.g., modal form).
     */
    formType: 'auto-save' | 'manual-save';
    /**
     * Optional list of field names this form edits. When provided, only
     * remote changes to these fields are deferred; changes to other fields
     * are applied immediately.
     */
    fields?: string[];
    /**
     * Callback invoked when the form closes and there are deferred changes
     * that need processing (e.g., conflict resolution, data refresh).
     *
     * @param changes - The array of deferred remote change objects.
     */
    onDeferredChanges?: (changes: unknown[]) => void;
}
/**
 * Svelte action that marks an entity as "being edited" in the remote changes
 * store. While editing, incoming remote changes for the same entity are
 * deferred instead of applied immediately.
 *
 * **Lifecycle:**
 *   1. On mount, calls `remoteChangesStore.startEditing()` to begin deferral.
 *   2. Periodically checks for deferred changes and toggles a CSS class
 *      (`has-deferred-changes`) on the node for visual indication.
 *   3. On update, re-registers if the entity identity changes.
 *   4. On destroy, calls `remoteChangesStore.stopEditing()` and invokes
 *      `onDeferredChanges` if any changes were deferred.
 *
 * @param node - The form DOM element.
 * @param options - Configuration specifying which entity is being edited.
 * @returns A Svelte action lifecycle object with `update` and `destroy` methods.
 */
export declare function trackEditing(node: HTMLElement, options: TrackEditingOptions): {
    /**
     * Called when the action's options change. If the entity identity
     * changes, stops tracking the old entity and starts tracking the new one.
     *
     * @param newOptions - The updated {@link TrackEditingOptions}.
     */
    update(newOptions: TrackEditingOptions): void;
    /**
     * Cleanup handler — stops the polling interval, removes CSS classes,
     * stops editing in the store, and notifies the callback of any
     * deferred changes that accumulated during the editing session.
     */
    destroy(): void;
};
/**
 * Trigger a local action animation on an element.
 *
 * Use this to make local user actions (e.g., tapping a checkbox, incrementing
 * a counter) animate with the same visual treatment as remote changes, giving
 * the UI a consistent feel.
 *
 * For `increment` and `decrement` actions, rapid repeated invocations will
 * restart the animation instead of being blocked — this allows the counter
 * to visually "bump" on each tap.
 *
 * @param element - The DOM element to animate (or `null`, in which case this is a no-op).
 * @param actionType - The type of animation to apply.
 *
 * @example
 * ```svelte
 * <script>
 *   import { triggerLocalAnimation } from '@prabhask5/stellar-engine';
 *   let element: HTMLElement;
 *
 *   function handleToggle() {
 *     triggerLocalAnimation(element, 'toggle');
 *     onToggle?.();
 *   }
 * </script>
 * <div bind:this={element}>...</div>
 * ```
 */
export declare function triggerLocalAnimation(element: HTMLElement | null, actionType: RemoteActionType): void;
export {};
//# sourceMappingURL=remoteChange.d.ts.map