/**
 * @fileoverview Toast notification store — `stellar-drive/toast`
 *
 * Provides a single, app-wide toast queue that any component or store
 * can push messages into. Toasts auto-dismiss after a configurable duration
 * and are displayed by `GlobalToast` (stellar-drive/components/GlobalToast).
 *
 * Variant semantics:
 *   - info    — informational / neutral messages (default)
 *   - success — confirmations, completed operations
 *   - error   — failures, deletions, blocked operations
 *   - warning — caution, non-fatal issues
 */
import { writable } from 'svelte/store';
let nextId = 0;
const { subscribe, update } = writable([]);
/**
 * Add a toast notification to the queue.
 *
 * @param message  - The text content of the toast.
 * @param variant  - Visual variant. Default: 'info'.
 * @param duration - Auto-dismiss delay in ms. Default: 3000.
 */
export function addToast(message, variant = 'info', duration = 3000) {
    const id = nextId++;
    update((toasts) => [...toasts, { id, message, variant, duration, createdAt: Date.now() }]);
    setTimeout(() => {
        dismissToast(id);
    }, duration);
}
/**
 * Remove a specific toast by ID.
 */
export function dismissToast(id) {
    update((toasts) => toasts.filter((t) => t.id !== id));
}
/** The reactive toast store — subscribe to get the current toast queue. */
export const toastStore = { subscribe };
//# sourceMappingURL=toast.js.map