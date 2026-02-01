/**
 * Remote Change Animation Action
 *
 * A Svelte action that automatically adds remote change animations to elements.
 * Use this on list items, cards, or any element that can be updated remotely.
 *
 * The action detects the ACTION TYPE from the remote change and applies
 * the appropriate animation:
 * - 'create' → item-created (slide in with burst)
 * - 'delete' → item-deleting (slide out with fade)
 * - 'toggle' → checkbox-animating + completion-ripple
 * - 'increment' → counter-increment
 * - 'decrement' → counter-decrement
 * - 'reorder' → item-reordering
 * - 'rename' → text-changed
 * - 'update' → item-changed (default highlight)
 *
 * Usage:
 * ```svelte
 * <div use:remoteChangeAnimation={{ entityId: item.id, entityType: 'goals' }}>
 *   ...
 * </div>
 * ```
 */

import {
  remoteChangesStore,
  createRecentChangeIndicator,
  createPendingDeleteIndicator,
  type RemoteActionType
} from '../stores/remoteChanges';

interface RemoteChangeOptions {
  entityId: string;
  entityType: string;
  // Optional: only animate specific fields
  fields?: string[];
  // Optional: custom animation class override
  animationClass?: string;
  // Optional: callback when action detected (for component-specific handling)
  onAction?: (actionType: RemoteActionType, fields: string[]) => void;
}

/**
 * Map action types to CSS animation classes
 */
const ACTION_ANIMATION_MAP: Record<RemoteActionType, string> = {
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
 * Animation durations for cleanup (ms)
 */
const ACTION_DURATION_MAP: Record<RemoteActionType, number> = {
  create: 600,
  delete: 500,
  toggle: 600,
  increment: 400,
  decrement: 400,
  reorder: 400,
  rename: 700,
  update: 1600
};

// Track currently animating elements to prevent overlapping animations
const animatingElements = new WeakSet<HTMLElement>();

export function remoteChangeAnimation(node: HTMLElement, options: RemoteChangeOptions) {
  let { entityId, entityType, fields, animationClass, onAction } = options;

  // Add base class for styling hooks
  node.classList.add('syncable-item');

  // Helper function to apply animation
  function applyAnimation(change: { actionType: RemoteActionType; fields: string[] }) {
    // If fields are specified, only animate if those fields changed
    if (fields && fields.length > 0) {
      const fieldsList = fields; // Capture for closure
      const hasRelevantChange = change.fields.some((f) => f === '*' || fieldsList.includes(f));
      if (!hasRelevantChange) return;
    }

    // Prevent overlapping animations on the same element
    if (animatingElements.has(node)) return;
    animatingElements.add(node);

    // Determine animation class based on action type
    const actionType = change.actionType;
    const cssClass = animationClass || ACTION_ANIMATION_MAP[actionType] || 'item-changed';
    const duration = ACTION_DURATION_MAP[actionType] || 1600;

    // Call action callback if provided (for component-specific handling)
    if (onAction) {
      onAction(actionType, change.fields);
    }

    // Apply animation class
    node.classList.add(cssClass);

    // For toggle actions, also add checkbox animation to child checkbox elements
    if (actionType === 'toggle') {
      const checkbox = node.querySelector('.checkbox, [class*="checkbox"]');
      if (checkbox) {
        checkbox.classList.add('checkbox-animating');
        setTimeout(() => checkbox.classList.remove('checkbox-animating'), 500);
      }

      // Add completion ripple effect
      const ripple = document.createElement('span');
      ripple.className = 'completion-ripple';
      node.appendChild(ripple);
      setTimeout(() => ripple.remove(), 700);
    }

    // For increment/decrement, animate the counter element
    if (actionType === 'increment' || actionType === 'decrement') {
      const counter = node.querySelector(
        '[class*="value"], [class*="counter"], [class*="current"]'
      );
      if (counter) {
        counter.classList.add(cssClass);
        setTimeout(() => counter.classList.remove(cssClass), duration);
      }
    }

    // For delete animations, don't remove the class — the element will be
    // removed from DOM after the animation. Removing it early causes the item
    // to briefly reappear between animation end and DOM removal.
    if (actionType === 'delete') return;

    // Remove class after animation completes
    const handleAnimationEnd = () => {
      node.classList.remove(cssClass);
      animatingElements.delete(node);
      node.removeEventListener('animationend', handleAnimationEnd);
    };

    node.addEventListener('animationend', handleAnimationEnd);

    // Fallback removal in case animationend doesn't fire
    setTimeout(() => {
      node.classList.remove(cssClass);
      animatingElements.delete(node);
    }, duration + 100);
  }

  // Check for recent change immediately on mount (important for CREATE animations)
  // This handles the case where the element mounts after a remote INSERT
  const initialChange = remoteChangesStore.getRecentChange(entityId, entityType);
  if (initialChange) {
    // Use requestAnimationFrame to ensure DOM is ready
    requestAnimationFrame(() => {
      applyAnimation(initialChange);
    });
  }

  // Create derived stores to watch for future changes and pending deletes
  let changeIndicator = createRecentChangeIndicator(entityId, entityType);
  let deleteIndicator = createPendingDeleteIndicator(entityId, entityType);

  // Track the current unsubscribe functions
  let unsubscribeChange = changeIndicator.subscribe((change) => {
    // Skip if no change or if this is the same change we already animated on mount
    if (!change) return;
    if (initialChange && change.timestamp === initialChange.timestamp) return;

    applyAnimation(change);
  });

  // Watch for pending deletes to apply delete animation
  let unsubscribeDelete = deleteIndicator.subscribe((isPendingDelete) => {
    if (isPendingDelete) {
      // Apply delete animation immediately
      const deleteClass = ACTION_ANIMATION_MAP['delete'];
      node.classList.add(deleteClass);

      // Call action callback if provided
      if (onAction) {
        onAction('delete', ['*']);
      }
    }
  });

  return {
    update(newOptions: RemoteChangeOptions) {
      // If entity changed, re-subscribe with new entity
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
          if (!change) return;
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
    destroy() {
      unsubscribeChange();
      unsubscribeDelete();
      node.classList.remove('syncable-item');
      animatingElements.delete(node);
    }
  };
}

/**
 * Action for form elements that should track editing state.
 * Use this on modal forms with Save buttons to defer remote changes.
 *
 * Usage:
 * ```svelte
 * <form use:trackEditing={{ entityId: item.id, entityType: 'goals', formType: 'manual-save' }}>
 *   ...
 * </form>
 * ```
 */

interface TrackEditingOptions {
  entityId: string;
  entityType: string;
  formType: 'auto-save' | 'manual-save';
  fields?: string[];
  // Callback when form closes and deferred changes need processing
  onDeferredChanges?: (changes: unknown[]) => void;
}

export function trackEditing(node: HTMLElement, options: TrackEditingOptions) {
  const { entityId, entityType, formType, fields, onDeferredChanges } = options;

  // Start tracking when the element mounts
  remoteChangesStore.startEditing(entityId, entityType, formType, fields);

  // Check for deferred changes indicator
  const updateDeferredIndicator = () => {
    const hasDeferred = remoteChangesStore.hasDeferredChanges(entityId, entityType);
    if (hasDeferred) {
      node.classList.add('has-deferred-changes');
    } else {
      node.classList.remove('has-deferred-changes');
    }
  };

  // Check periodically for deferred changes
  const interval = setInterval(updateDeferredIndicator, 1000);
  updateDeferredIndicator();

  return {
    update(newOptions: TrackEditingOptions) {
      // If entity changed, stop old tracking and start new
      if (newOptions.entityId !== entityId || newOptions.entityType !== entityType) {
        remoteChangesStore.stopEditing(entityId, entityType);
        remoteChangesStore.startEditing(
          newOptions.entityId,
          newOptions.entityType,
          newOptions.formType,
          newOptions.fields
        );
      }
    },
    destroy() {
      clearInterval(interval);
      node.classList.remove('has-deferred-changes');

      // Stop tracking and get any deferred changes
      const deferredChanges = remoteChangesStore.stopEditing(entityId, entityType);

      // Notify callback if there are deferred changes
      if (deferredChanges.length > 0 && onDeferredChanges) {
        onDeferredChanges(deferredChanges);
      }
    }
  };
}

/**
 * Trigger a local action animation on an element.
 * Use this to make local actions animate the same way as remote actions.
 *
 * Usage in components:
 * ```svelte
 * <script>
 *   import { triggerLocalAnimation } from '@stellar/sync-engine';
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
export function triggerLocalAnimation(
  element: HTMLElement | null,
  actionType: RemoteActionType
): void {
  if (!element) return;

  const cssClass = ACTION_ANIMATION_MAP[actionType] || 'item-changed';
  const duration = ACTION_DURATION_MAP[actionType] || 1600;

  // For increment/decrement, restart animation on rapid taps instead of blocking
  if (actionType === 'increment' || actionType === 'decrement') {
    if (animatingElements.has(element)) {
      // Force restart: remove class, trigger reflow, re-add
      element.classList.remove(cssClass);
      void element.offsetWidth;
    }
  } else {
    // Prevent overlapping animations for other types
    if (animatingElements.has(element)) return;
  }
  animatingElements.add(element);

  // Apply animation class
  element.classList.add(cssClass);

  // For toggle actions, also animate checkbox elements
  if (actionType === 'toggle') {
    const checkbox = element.querySelector('.checkbox, [class*="checkbox"]');
    if (checkbox) {
      checkbox.classList.add('checkbox-animating');
      setTimeout(() => checkbox.classList.remove('checkbox-animating'), 500);
    }

    // Add completion ripple effect
    const ripple = document.createElement('span');
    ripple.className = 'completion-ripple';
    element.appendChild(ripple);
    setTimeout(() => ripple.remove(), 700);
  }

  // For increment/decrement, animate the counter element
  if (actionType === 'increment' || actionType === 'decrement') {
    const counter = element.querySelector(
      '[class*="value"], [class*="counter"], [class*="current"]'
    );
    if (counter) {
      counter.classList.add(cssClass);
      setTimeout(() => counter.classList.remove(cssClass), duration);
    }
  }

  // Remove class after animation completes
  const handleAnimationEnd = () => {
    element.classList.remove(cssClass);
    animatingElements.delete(element);
    element.removeEventListener('animationend', handleAnimationEnd);
  };

  element.addEventListener('animationend', handleAnimationEnd);

  // Fallback removal
  setTimeout(() => {
    element.classList.remove(cssClass);
    animatingElements.delete(element);
  }, duration + 100);
}
