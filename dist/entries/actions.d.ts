/**
 * @fileoverview Actions subpath barrel — `@prabhask5/stellar-engine/actions`
 *
 * Re-exports Svelte use:action directives that provide DOM-level behavior for
 * remote-change animations and tooltip truncation. These actions are designed
 * to be applied to elements in Svelte templates via `use:actionName`.
 *
 * Typical usage:
 * ```svelte
 * <div use:remoteChangeAnimation use:trackEditing>...</div>
 * <span use:truncateTooltip>Long text here...</span>
 * ```
 */
export { remoteChangeAnimation, trackEditing, triggerLocalAnimation } from '../actions/remoteChange';
export { truncateTooltip } from '../actions/truncateTooltip';
//# sourceMappingURL=actions.d.ts.map