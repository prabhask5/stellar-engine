/**
 * @fileoverview Actions subpath barrel — `stellar-drive/actions`
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

// =============================================================================
//  Remote Change Animations
// =============================================================================
// Actions for visually indicating when data has been modified by another device
// via realtime sync. `remoteChangeAnimation` applies a highlight/pulse effect
// when a remote update arrives. `trackEditing` marks an element as being
// actively edited (so remote changes are deferred). `triggerLocalAnimation`
// manually fires the animation for local confirmation feedback.

export {
  remoteChangeAnimation,
  trackEditing,
  triggerLocalAnimation
} from '../actions/remoteChange';

// =============================================================================
//  Truncate Tooltip
// =============================================================================
// A Svelte action that detects CSS text-overflow (ellipsis) on an element and
// attaches a native `title` tooltip showing the full text when truncated.

export { truncateTooltip } from '../actions/truncateTooltip';
