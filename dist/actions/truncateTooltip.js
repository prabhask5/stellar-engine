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
// =============================================================================
//                        SINGLETON TOOLTIP STATE
// =============================================================================
/**
 * The shared tooltip DOM element — lazily created by {@link getTooltip}.
 * Only one tooltip element exists in the entire document, regardless of
 * how many `use:truncateTooltip` instances are active.
 */
let tooltipEl = null;
/**
 * Handle for the mobile auto-dismiss `setTimeout`.
 * Cleared on manual hide to prevent stale timeouts from
 * dismissing a newly-shown tooltip.
 */
let hideTimeout = null;
/**
 * The DOM element that currently "owns" the visible tooltip.
 * Used to prevent hide events from one element dismissing another's tooltip,
 * and to implement tap-toggle behaviour on mobile (tap same element = hide).
 */
let currentOwner = null;
// =============================================================================
//                       TOOLTIP ELEMENT MANAGEMENT
// =============================================================================
/**
 * Return the singleton tooltip element, creating it on first call.
 *
 * The element is given the CSS class `truncate-tooltip` and an ARIA
 * `role="tooltip"` attribute for accessibility. The consuming app must
 * provide CSS for `.truncate-tooltip` (positioning, background, etc.)
 * and a `.visible` modifier class to control opacity/display.
 *
 * @returns The shared tooltip `HTMLElement`.
 */
function getTooltip() {
    if (!tooltipEl) {
        tooltipEl = document.createElement('div');
        tooltipEl.className = 'truncate-tooltip';
        tooltipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
}
// =============================================================================
//                          TRUNCATION DETECTION
// =============================================================================
/**
 * Check whether an element's text content is visually truncated.
 *
 * Compares `scrollWidth` (full content width including overflow) against
 * `clientWidth` (visible width). When `scrollWidth` exceeds `clientWidth`,
 * the CSS `text-overflow: ellipsis` rule is hiding part of the text.
 *
 * @param el - The DOM element to test.
 * @returns `true` if the text overflows its container.
 *
 * @example
 * ```ts
 * if (isTruncated(spanElement)) {
 *   showTooltip(spanElement);
 * }
 * ```
 */
function isTruncated(el) {
    return el.scrollWidth > el.clientWidth;
}
// =============================================================================
//                         TOOLTIP POSITIONING
// =============================================================================
/**
 * Position the tooltip relative to an anchor element.
 *
 * Default placement is **centred above** the anchor with an 8 px gap.
 * Two edge-case corrections are applied:
 *   1. If the tooltip would overflow the **top** of the viewport, it flips
 *      to appear **below** the anchor instead.
 *   2. The horizontal position is clamped to keep the tooltip within the
 *      viewport (8 px padding on each side).
 *
 * @param tooltip - The tooltip element to reposition.
 * @param anchor  - The element the tooltip should point at.
 */
function positionTooltip(tooltip, anchor) {
    const rect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    /* ── Default: centred above the anchor ──── */
    let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
    let top = rect.top - tooltipRect.height - 8;
    /* Flip below if tooltip would overflow the top edge */
    if (top < 4) {
        top = rect.bottom + 8;
    }
    /* ── Horizontal clamping ──── */
    const maxLeft = window.innerWidth - tooltipRect.width - 8;
    left = Math.max(8, Math.min(left, maxLeft));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
}
// =============================================================================
//                         SHOW / HIDE LOGIC
// =============================================================================
/**
 * Show the tooltip for the given anchor element.
 *
 * Exits early if the anchor's text is **not** truncated (no tooltip needed).
 * Positioning is deferred to the next animation frame so that the tooltip's
 * dimensions are accurate after its `textContent` is set.
 *
 * @param anchor - The element whose full text should be displayed in the tooltip.
 */
function showTooltip(anchor) {
    if (!isTruncated(anchor))
        return;
    const tooltip = getTooltip();
    const fullText = anchor.textContent?.trim() || '';
    if (!fullText)
        return;
    /* Cancel any pending auto-dismiss from a previous mobile tap */
    if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
    }
    tooltip.textContent = fullText;
    tooltip.classList.add('visible');
    currentOwner = anchor;
    /* Position after content is set so dimensions are correct */
    requestAnimationFrame(() => {
        positionTooltip(tooltip, anchor);
    });
}
/**
 * Hide the tooltip and reset ownership state.
 *
 * Safe to call even when no tooltip is visible — the function is a no-op
 * in that case. Also clears any pending auto-dismiss timeout.
 */
function hideTooltip() {
    if (tooltipEl) {
        tooltipEl.classList.remove('visible');
    }
    currentOwner = null;
    if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
    }
}
// =============================================================================
//                         DEVICE DETECTION
// =============================================================================
/**
 * Detect whether the current device supports touch input.
 *
 * Uses feature detection (`ontouchstart` in `window` or `maxTouchPoints`)
 * rather than user-agent sniffing, which is more reliable across browsers
 * and avoids false negatives on hybrid devices.
 *
 * @returns `true` on touch-capable devices.
 */
function isTouchDevice() {
    return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}
// =============================================================================
//                        SVELTE ACTION EXPORT
// =============================================================================
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
export function truncateTooltip(node) {
    /* ── Apply ellipsis CSS ──── */
    node.style.overflow = 'hidden';
    node.style.textOverflow = 'ellipsis';
    node.style.whiteSpace = 'nowrap';
    // ---------------------------------------------------------------------------
    //                    DESKTOP: HOVER HANDLERS
    // ---------------------------------------------------------------------------
    /**
     * Show tooltip on mouse enter (desktop only).
     * Skips on touch devices to avoid double-triggering with touch handlers.
     */
    function handleMouseEnter() {
        if (isTouchDevice())
            return;
        showTooltip(node);
    }
    /**
     * Hide tooltip on mouse leave, but only if this node owns the tooltip.
     * Prevents one element's mouseleave from dismissing another's tooltip.
     */
    function handleMouseLeave() {
        if (currentOwner === node) {
            hideTooltip();
        }
    }
    // ---------------------------------------------------------------------------
    //                    MOBILE: TAP HANDLERS
    // ---------------------------------------------------------------------------
    /**
     * Toggle tooltip on tap (mobile only).
     *
     * Prevents default to avoid triggering navigation or text selection.
     * Stops propagation to prevent the document-level tap-outside handler
     * from immediately dismissing the tooltip.
     * Auto-dismisses after 3 seconds.
     *
     * @param e - The touch event.
     */
    function handleTap(e) {
        if (!isTouchDevice())
            return;
        if (!isTruncated(node))
            return;
        e.preventDefault();
        e.stopPropagation();
        /* Toggle off if already showing for this node */
        if (currentOwner === node) {
            hideTooltip();
            return;
        }
        showTooltip(node);
        /* Auto-dismiss after 3 s on mobile */
        hideTimeout = setTimeout(hideTooltip, 3000);
    }
    /**
     * Dismiss the tooltip when the user taps outside the anchor or tooltip
     * (mobile only). Ignores taps on the anchor itself or inside the tooltip
     * to prevent unintended dismissal.
     *
     * @param e - The document-level touch event.
     */
    function handleTapOutside(e) {
        if (!currentOwner || currentOwner !== node)
            return;
        const target = e.target;
        if (target === node || node.contains(target))
            return;
        if (tooltipEl && (target === tooltipEl || tooltipEl.contains(target)))
            return;
        hideTooltip();
    }
    // ---------------------------------------------------------------------------
    //                 EVENT LISTENER REGISTRATION
    // ---------------------------------------------------------------------------
    node.addEventListener('mouseenter', handleMouseEnter);
    node.addEventListener('mouseleave', handleMouseLeave);
    node.addEventListener('touchstart', handleTap, { passive: false });
    document.addEventListener('touchstart', handleTapOutside, { passive: true });
    // ---------------------------------------------------------------------------
    //                 SVELTE ACTION LIFECYCLE
    // ---------------------------------------------------------------------------
    return {
        /**
         * Cleanup handler — removes all event listeners and hides the tooltip
         * if this node was the active owner. Prevents memory leaks from
         * orphaned document-level listeners.
         */
        destroy() {
            node.removeEventListener('mouseenter', handleMouseEnter);
            node.removeEventListener('mouseleave', handleMouseLeave);
            node.removeEventListener('touchstart', handleTap);
            document.removeEventListener('touchstart', handleTapOutside);
            /* Clean up tooltip if this node was the active owner */
            if (currentOwner === node) {
                hideTooltip();
            }
        }
    };
}
//# sourceMappingURL=truncateTooltip.js.map