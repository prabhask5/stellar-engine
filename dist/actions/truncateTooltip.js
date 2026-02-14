/**
 * @fileoverview Svelte action for truncated-text tooltips.
 *
 * Provides a `use:truncateTooltip` directive that enforces CSS text-overflow
 * ellipsis on the target element and shows a floating tooltip with the
 * **full** text whenever the content is visually truncated.
 *
 * **Behaviour by device type:**
 * - **Desktop** — tooltip appears on `mouseenter`, hides on `mouseleave`.
 *   Only shown when `scrollWidth > clientWidth` (text is actually clipped).
 * - **Mobile** — tooltip appears on `touchstart` (tap), dismisses on
 *   tap-outside or after a 3-second auto-dismiss timeout.
 *
 * A **singleton** tooltip `<div>` is lazily appended to `document.body` and
 * reused across all instances of the action to avoid DOM bloat.
 *
 * **Usage:**
 * ```svelte
 * <span class="my-text" use:truncateTooltip>{longText}</span>
 * ```
 */
// =============================================================================
//                        SINGLETON TOOLTIP STATE
// =============================================================================
/** The shared tooltip DOM element — lazily created by {@link getTooltip}. */
let tooltipEl = null;
/** Handle for the mobile auto-dismiss `setTimeout` (cleared on manual hide). */
let hideTimeout = null;
/**
 * The DOM element that currently "owns" the visible tooltip.
 * Used to prevent hide events from one element dismissing another's tooltip.
 */
let currentOwner = null;
// =============================================================================
//                       TOOLTIP ELEMENT MANAGEMENT
// =============================================================================
/**
 * Return the singleton tooltip element, creating it on first call.
 *
 * The element is given the CSS class `truncate-tooltip` and an ARIA
 * `role="tooltip"` attribute for accessibility.
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
 * Compares `scrollWidth` (full content width) against `clientWidth`
 * (visible width). When `scrollWidth` exceeds `clientWidth`, the CSS
 * `text-overflow: ellipsis` rule is hiding part of the text.
 *
 * @param el - The DOM element to test.
 * @returns `true` if the text overflows its container.
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
 * 1. If the tooltip would overflow the **top** of the viewport, it flips
 *    to appear **below** the anchor instead.
 * 2. The horizontal position is clamped to keep the tooltip within the
 *    viewport (8 px padding on each side).
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
 * @param anchor - The element whose full text should be displayed.
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
 * in that case.
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
 * rather than user-agent sniffing.
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
 * On mount the action:
 * 1. Forces CSS `overflow: hidden`, `text-overflow: ellipsis`, and
 *    `white-space: nowrap` on the node to guarantee ellipsis rendering.
 * 2. Registers `mouseenter` / `mouseleave` handlers for desktop hover.
 * 3. Registers `touchstart` handlers for mobile tap-to-show behaviour.
 * 4. Registers a document-level `touchstart` listener for tap-outside
 *    dismissal on mobile.
 *
 * The returned `destroy` callback cleans up all listeners and hides the
 * tooltip if the destroyed node was its current owner.
 *
 * @param node - The DOM element to enhance with truncation tooltips.
 * @returns A Svelte action lifecycle object with a `destroy` method.
 */
export function truncateTooltip(node) {
    /* ── Apply ellipsis CSS ──── */
    node.style.overflow = 'hidden';
    node.style.textOverflow = 'ellipsis';
    node.style.whiteSpace = 'nowrap';
    /* ── Desktop: hover handlers ──── */
    /** Show tooltip on mouse enter (desktop only). */
    function handleMouseEnter() {
        if (isTouchDevice())
            return;
        showTooltip(node);
    }
    /** Hide tooltip on mouse leave if this node owns the tooltip. */
    function handleMouseLeave() {
        if (currentOwner === node) {
            hideTooltip();
        }
    }
    /* ── Mobile: tap handlers ──── */
    /**
     * Toggle tooltip on tap (mobile only).
     * Prevents default to avoid triggering navigation or selection.
     * Auto-dismisses after 3 seconds.
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
     * (mobile only). Ignores taps on the anchor itself or inside the tooltip.
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
    /* ── Register event listeners ──── */
    node.addEventListener('mouseenter', handleMouseEnter);
    node.addEventListener('mouseleave', handleMouseLeave);
    node.addEventListener('touchstart', handleTap, { passive: false });
    document.addEventListener('touchstart', handleTapOutside, { passive: true });
    /* ── Svelte action lifecycle ──── */
    return {
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