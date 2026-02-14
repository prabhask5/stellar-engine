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
import { remoteChangesStore, createRecentChangeIndicator, createPendingDeleteIndicator } from '../stores/remoteChanges';
// =============================================================================
//                     ACTION-TO-CSS ANIMATION MAPPING
// =============================================================================
/**
 * Maps each {@link RemoteActionType} to the CSS class name that triggers
 * the corresponding animation. The consuming app must define these CSS
 * classes (keyframes + durations) in its stylesheet.
 */
const ACTION_ANIMATION_MAP = {
    create: 'item-created',
    delete: 'item-deleting',
    toggle: 'item-toggled',
    increment: 'counter-increment',
    decrement: 'counter-decrement',
    reorder: 'item-reordering',
    rename: 'text-changed',
    update: 'item-changed'
};
/**
 * Maps each {@link RemoteActionType} to its animation duration in
 * milliseconds. Used for fallback cleanup timers in case the
 * `animationend` DOM event never fires (e.g., display:none elements).
 */
const ACTION_DURATION_MAP = {
    create: 600,
    delete: 500,
    toggle: 600,
    increment: 400,
    decrement: 400,
    reorder: 400,
    rename: 700,
    update: 1600
};
// =============================================================================
//                    ANIMATION OVERLAP PREVENTION
// =============================================================================
/**
 * Tracks elements that currently have an active animation. Prevents
 * overlapping animations on the same element which would cause visual
 * glitches. Uses `WeakSet` so entries are automatically garbage-collected
 * when the element is removed from the DOM.
 */
const animatingElements = new WeakSet();
// =============================================================================
//                   SVELTE ACTION: remoteChangeAnimation
// =============================================================================
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
export function remoteChangeAnimation(node, options) {
    let { entityId, entityType, fields, animationClass, onAction } = options;
    /* Add base class for styling hooks (e.g., transition defaults) */
    node.classList.add('syncable-item');
    // ---------------------------------------------------------------------------
    //                    ANIMATION APPLICATION LOGIC
    // ---------------------------------------------------------------------------
    /**
     * Apply the appropriate CSS animation to the node based on the change's
     * action type and affected fields.
     *
     * Handles special cases for toggle (checkbox + ripple), increment/decrement
     * (counter sub-element), and delete (no class removal — element will be
     * removed from DOM by the parent component).
     *
     * @param change - The remote change descriptor with `actionType` and `fields`.
     */
    function applyAnimation(change) {
        /* If specific fields are configured, only animate if at least one matches */
        if (fields && fields.length > 0) {
            const fieldsList = fields; /* Capture for closure safety */
            const hasRelevantChange = change.fields.some((f) => f === '*' || fieldsList.includes(f));
            if (!hasRelevantChange)
                return;
        }
        /* Prevent overlapping animations on the same element */
        if (animatingElements.has(node))
            return;
        animatingElements.add(node);
        /* Determine animation class based on action type */
        const actionType = change.actionType;
        const cssClass = animationClass || ACTION_ANIMATION_MAP[actionType] || 'item-changed';
        const duration = ACTION_DURATION_MAP[actionType] || 1600;
        /* Call action callback if provided (for component-specific handling) */
        if (onAction) {
            onAction(actionType, change.fields);
        }
        /* Apply animation class */
        node.classList.add(cssClass);
        /* For toggle actions, also add checkbox animation to child checkbox elements */
        if (actionType === 'toggle') {
            const checkbox = node.querySelector('.checkbox, [class*="checkbox"]');
            if (checkbox) {
                checkbox.classList.add('checkbox-animating');
                setTimeout(() => checkbox.classList.remove('checkbox-animating'), 500);
            }
            /* Add completion ripple effect — a temporary <span> that auto-removes */
            const ripple = document.createElement('span');
            ripple.className = 'completion-ripple';
            node.appendChild(ripple);
            setTimeout(() => ripple.remove(), 700);
        }
        /* For increment/decrement, animate the counter sub-element specifically */
        if (actionType === 'increment' || actionType === 'decrement') {
            const counter = node.querySelector('[class*="value"], [class*="counter"], [class*="current"]');
            if (counter) {
                counter.classList.add(cssClass);
                setTimeout(() => counter.classList.remove(cssClass), duration);
            }
        }
        /* For delete animations, don't remove the class — the element will be
         * removed from DOM after the animation. Removing it early causes the item
         * to briefly reappear between animation end and DOM removal. */
        if (actionType === 'delete')
            return;
        /* Remove class after animation completes */
        const handleAnimationEnd = () => {
            node.classList.remove(cssClass);
            animatingElements.delete(node);
            node.removeEventListener('animationend', handleAnimationEnd);
        };
        node.addEventListener('animationend', handleAnimationEnd);
        /* Fallback removal in case animationend doesn't fire
         * (e.g., element is display:none or animation is interrupted) */
        setTimeout(() => {
            node.classList.remove(cssClass);
            animatingElements.delete(node);
        }, duration + 100);
    }
    // ---------------------------------------------------------------------------
    //            INITIAL CHECK (HANDLES CREATE-ON-MOUNT SCENARIO)
    // ---------------------------------------------------------------------------
    /* Check for a recent change immediately on mount. This handles the case
     * where the element mounts after a remote INSERT — the store already has
     * the change recorded, and we need to animate the newly-rendered item. */
    const initialChange = remoteChangesStore.getRecentChange(entityId, entityType);
    if (initialChange) {
        /* Use requestAnimationFrame to ensure DOM is fully ready */
        requestAnimationFrame(() => {
            applyAnimation(initialChange);
        });
    }
    // ---------------------------------------------------------------------------
    //                   STORE SUBSCRIPTIONS
    // ---------------------------------------------------------------------------
    /* Create derived stores to watch for future changes and pending deletes */
    let changeIndicator = createRecentChangeIndicator(entityId, entityType);
    let deleteIndicator = createPendingDeleteIndicator(entityId, entityType);
    /* Track the current unsubscribe functions */
    let unsubscribeChange = changeIndicator.subscribe((change) => {
        /* Skip if no change or if this is the same change we already animated on mount */
        if (!change)
            return;
        if (initialChange && change.timestamp === initialChange.timestamp)
            return;
        applyAnimation(change);
    });
    /* Watch for pending deletes to apply delete animation */
    let unsubscribeDelete = deleteIndicator.subscribe((isPendingDelete) => {
        if (isPendingDelete) {
            /* Apply delete animation immediately */
            const deleteClass = ACTION_ANIMATION_MAP['delete'];
            node.classList.add(deleteClass);
            /* Call action callback if provided */
            if (onAction) {
                onAction('delete', ['*']);
            }
        }
    });
    // ---------------------------------------------------------------------------
    //                 SVELTE ACTION LIFECYCLE
    // ---------------------------------------------------------------------------
    return {
        /**
         * Called when the action's options change. If the entity identity
         * (`entityId` or `entityType`) has changed, tears down old subscriptions
         * and creates new ones for the updated entity.
         *
         * @param newOptions - The updated {@link RemoteChangeOptions}.
         */
        update(newOptions) {
            /* If entity changed, re-subscribe with new entity */
            if (newOptions.entityId !== entityId || newOptions.entityType !== entityType) {
                unsubscribeChange();
                unsubscribeDelete();
                entityId = newOptions.entityId;
                entityType = newOptions.entityType;
                fields = newOptions.fields;
                animationClass = newOptions.animationClass;
                onAction = newOptions.onAction;
                changeIndicator = createRecentChangeIndicator(entityId, entityType);
                deleteIndicator = createPendingDeleteIndicator(entityId, entityType);
                unsubscribeChange = changeIndicator.subscribe((change) => {
                    if (!change)
                        return;
                    applyAnimation(change);
                });
                unsubscribeDelete = deleteIndicator.subscribe((isPendingDelete) => {
                    if (isPendingDelete) {
                        const deleteClass = ACTION_ANIMATION_MAP['delete'];
                        node.classList.add(deleteClass);
                        if (onAction) {
                            onAction('delete', ['*']);
                        }
                    }
                });
            }
        },
        /**
         * Cleanup handler — unsubscribes from all stores, removes the base
         * CSS class, and clears the element from the animation tracking set.
         */
        destroy() {
            unsubscribeChange();
            unsubscribeDelete();
            node.classList.remove('syncable-item');
            animatingElements.delete(node);
        }
    };
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
export function trackEditing(node, options) {
    const { entityId, entityType, formType, fields, onDeferredChanges } = options;
    /* Start tracking when the element mounts */
    remoteChangesStore.startEditing(entityId, entityType, formType, fields);
    /**
     * Update the `has-deferred-changes` CSS class based on whether
     * remote changes have been deferred for this entity.
     */
    const updateDeferredIndicator = () => {
        const hasDeferred = remoteChangesStore.hasDeferredChanges(entityId, entityType);
        if (hasDeferred) {
            node.classList.add('has-deferred-changes');
        }
        else {
            node.classList.remove('has-deferred-changes');
        }
    };
    /* Check periodically for deferred changes (1-second polling interval) */
    const interval = setInterval(updateDeferredIndicator, 1000);
    updateDeferredIndicator();
    return {
        /**
         * Called when the action's options change. If the entity identity
         * changes, stops tracking the old entity and starts tracking the new one.
         *
         * @param newOptions - The updated {@link TrackEditingOptions}.
         */
        update(newOptions) {
            /* If entity changed, stop old tracking and start new */
            if (newOptions.entityId !== entityId || newOptions.entityType !== entityType) {
                remoteChangesStore.stopEditing(entityId, entityType);
                remoteChangesStore.startEditing(newOptions.entityId, newOptions.entityType, newOptions.formType, newOptions.fields);
            }
        },
        /**
         * Cleanup handler — stops the polling interval, removes CSS classes,
         * stops editing in the store, and notifies the callback of any
         * deferred changes that accumulated during the editing session.
         */
        destroy() {
            clearInterval(interval);
            node.classList.remove('has-deferred-changes');
            /* Stop tracking and get any deferred changes */
            const deferredChanges = remoteChangesStore.stopEditing(entityId, entityType);
            /* Notify callback if there are deferred changes */
            if (deferredChanges.length > 0 && onDeferredChanges) {
                onDeferredChanges(deferredChanges);
            }
        }
    };
}
// =============================================================================
//             PROGRAMMATIC LOCAL ANIMATION TRIGGER
// =============================================================================
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
export function triggerLocalAnimation(element, actionType) {
    if (!element)
        return;
    const cssClass = ACTION_ANIMATION_MAP[actionType] || 'item-changed';
    const duration = ACTION_DURATION_MAP[actionType] || 1600;
    /* For increment/decrement, restart animation on rapid taps instead of blocking */
    if (actionType === 'increment' || actionType === 'decrement') {
        if (animatingElements.has(element)) {
            /* Force restart: remove class, trigger reflow via offsetWidth read, re-add */
            element.classList.remove(cssClass);
            void element.offsetWidth;
        }
    }
    else {
        /* Prevent overlapping animations for other types */
        if (animatingElements.has(element))
            return;
    }
    animatingElements.add(element);
    /* Apply animation class */
    element.classList.add(cssClass);
    /* For toggle actions, also animate checkbox elements */
    if (actionType === 'toggle') {
        const checkbox = element.querySelector('.checkbox, [class*="checkbox"]');
        if (checkbox) {
            checkbox.classList.add('checkbox-animating');
            setTimeout(() => checkbox.classList.remove('checkbox-animating'), 500);
        }
        /* Add completion ripple effect */
        const ripple = document.createElement('span');
        ripple.className = 'completion-ripple';
        element.appendChild(ripple);
        setTimeout(() => ripple.remove(), 700);
    }
    /* For increment/decrement, animate the counter sub-element specifically */
    if (actionType === 'increment' || actionType === 'decrement') {
        const counter = element.querySelector('[class*="value"], [class*="counter"], [class*="current"]');
        if (counter) {
            counter.classList.add(cssClass);
            setTimeout(() => counter.classList.remove(cssClass), duration);
        }
    }
    /* Remove class after animation completes */
    const handleAnimationEnd = () => {
        element.classList.remove(cssClass);
        animatingElements.delete(element);
        element.removeEventListener('animationend', handleAnimationEnd);
    };
    element.addEventListener('animationend', handleAnimationEnd);
    /* Fallback removal in case animationend doesn't fire */
    setTimeout(() => {
        element.classList.remove(cssClass);
        animatingElements.delete(element);
    }, duration + 100);
}
//# sourceMappingURL=remoteChange.js.map