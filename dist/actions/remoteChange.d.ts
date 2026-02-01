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
import { type RemoteActionType } from '../stores/remoteChanges';
interface RemoteChangeOptions {
    entityId: string;
    entityType: string;
    fields?: string[];
    animationClass?: string;
    onAction?: (actionType: RemoteActionType, fields: string[]) => void;
}
export declare function remoteChangeAnimation(node: HTMLElement, options: RemoteChangeOptions): {
    update(newOptions: RemoteChangeOptions): void;
    destroy(): void;
};
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
    onDeferredChanges?: (changes: unknown[]) => void;
}
export declare function trackEditing(node: HTMLElement, options: TrackEditingOptions): {
    update(newOptions: TrackEditingOptions): void;
    destroy(): void;
};
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
export declare function triggerLocalAnimation(element: HTMLElement | null, actionType: RemoteActionType): void;
export {};
//# sourceMappingURL=remoteChange.d.ts.map