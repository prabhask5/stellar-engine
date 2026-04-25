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
/** Visual variant that drives the icon and colour in the toast UI. */
export type ToastVariant = 'info' | 'success' | 'error' | 'warning';
export interface Toast {
    id: number;
    message: string;
    variant: ToastVariant;
    duration: number;
    /** Timestamp when the toast was created (for fade timing). */
    createdAt: number;
}
/**
 * Add a toast notification to the queue.
 *
 * @param message  - The text content of the toast.
 * @param variant  - Visual variant. Default: 'info'.
 * @param duration - Auto-dismiss delay in ms. Default: 3000.
 */
export declare function addToast(message: string, variant?: ToastVariant, duration?: number): void;
/**
 * Remove a specific toast by ID.
 */
export declare function dismissToast(id: number): void;
/** The reactive toast store — subscribe to get the current toast queue. */
export declare const toastStore: {
    subscribe: (this: void, run: import("svelte/store").Subscriber<Toast[]>, invalidate?: () => void) => import("svelte/store").Unsubscriber;
};
//# sourceMappingURL=toast.d.ts.map