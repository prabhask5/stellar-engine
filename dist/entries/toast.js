/**
 * @fileoverview Toast subpath barrel — `stellar-drive/toast`
 *
 * Re-exports the toast store, add/dismiss functions, and the ToastVariant type.
 * Consumed by app layouts and any component that needs to surface a notification.
 *
 * Mount `GlobalToast` (stellar-drive/components/GlobalToast) in your root
 * layout to render the toast queue — no props required.
 */
export { addToast, dismissToast, toastStore } from '../stores/toast';
//# sourceMappingURL=toast.js.map