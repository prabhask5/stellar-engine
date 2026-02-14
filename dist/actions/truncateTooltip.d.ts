/**
 * @fileoverview Svelte action for truncated-text tooltips.
 *
 * Provides a `use:truncateTooltip` directive that enforces CSS text-overflow
 * ellipsis on the target element and shows a floating tooltip with the
 * **full** text whenever the content is visually truncated.
 *
 * **Behaviour by device type:**
 *   - **Desktop** — tooltip appears on `mouseenter`, hides on `mouseleave`.
 *     Only shown when `scrollWidth > clientWidth` (text is actually clipped).
 *   - **Mobile** — tooltip appears on `touchstart` (tap), dismisses on
 *     tap-outside or after a 3-second auto-dismiss timeout.
 *
 * A **singleton** tooltip `<div>` is lazily appended to `document.body` and
 * reused across all instances of the action to avoid DOM bloat.
 *
 * @example
 * ```svelte
 * <span class="my-text" use:truncateTooltip>{longText}</span>
 * ```
 *
 * @see {@link truncateTooltip} for the Svelte action export
 * @see {@link showTooltip} for the display logic
 * @see {@link positionTooltip} for the positioning algorithm
 */
/**
 * Svelte action that applies truncation-aware tooltips to an element.
 *
 * **On mount the action:**
 *   1. Forces CSS `overflow: hidden`, `text-overflow: ellipsis`, and
 *      `white-space: nowrap` on the node to guarantee ellipsis rendering.
 *   2. Registers `mouseenter` / `mouseleave` handlers for desktop hover.
 *   3. Registers `touchstart` handlers for mobile tap-to-show behaviour.
 *   4. Registers a document-level `touchstart` listener for tap-outside
 *      dismissal on mobile.
 *
 * The returned `destroy` callback cleans up all listeners and hides the
 * tooltip if the destroyed node was its current owner.
 *
 * @param node - The DOM element to enhance with truncation tooltips.
 * @returns A Svelte action lifecycle object with a `destroy` method.
 *
 * @example
 * ```svelte
 * <span class="my-text" use:truncateTooltip>{longText}</span>
 * ```
 */
export declare function truncateTooltip(node: HTMLElement): {
    /**
     * Cleanup handler — removes all event listeners and hides the tooltip
     * if this node was the active owner. Prevents memory leaks from
     * orphaned document-level listeners.
     */
    destroy(): void;
};
//# sourceMappingURL=truncateTooltip.d.ts.map