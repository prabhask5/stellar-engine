<!--
  @fileoverview GlobalToast — toast notification queue renderer.

  Self-contained: subscribes to the stellar-drive toast store internally and
  renders toasts at the bottom of the viewport.

  - Mount once in your root `+layout.svelte`. No props required.
  - Automatically raises toasts above the demo banner in demo mode.
  - Stacks up to three toasts with distinct bottom offsets.
  - Toasts slide up on entry and fade out on dismiss (via Svelte out:fade).
  - Four variants: info (blue), success (green), error (red), warning (purple).
  - z-index 9100 — above DemoBanner (9000), below modals.

  Example mount:
  ```svelte
  import GlobalToast from 'stellar-drive/components/GlobalToast';
  <GlobalToast />
  ```
-->
<script lang="ts">
  import { fade } from 'svelte/transition';
  import { toastStore, dismissToast } from 'stellar-drive/toast';
  import { isDemoMode } from 'stellar-drive/demo';
  import type { ToastVariant } from 'stellar-drive/toast';

  // ==========================================================================
  //                           COMPONENT STATE
  // ==========================================================================

  /** Whether demo mode is active — raises toasts above the demo banner. */
  const inDemoMode = $derived(isDemoMode());

  /** SVG icon paths for each variant. */
  const ICONS: Record<ToastVariant, { paths: string[]; type: 'stroke' }> = {
    info: {
      type: 'stroke',
      paths: [
        'M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z',
        'M12 16L12 12',
        'M12 8L12.01 8'
      ]
    },
    success: {
      type: 'stroke',
      paths: [
        'M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z',
        'M9 12L11 14L15 10'
      ]
    },
    error: {
      type: 'stroke',
      paths: [
        'M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z',
        'M15 9L9 15',
        'M9 9L15 15'
      ]
    },
    warning: {
      type: 'stroke',
      paths: [
        'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
        'M12 9L12 13',
        'M12 17L12.01 17'
      ]
    }
  };
</script>

<!-- demo-mode class raises toasts above the demo banner -->
<div class="toast-stack" class:demo-mode={inDemoMode}>
  {#each $toastStore as toast (toast.id)}
    <div class="toast-item toast-{toast.variant}" out:fade={{ duration: 180 }}>
      <div class="toast-content">
        <svg class="toast-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          {#each ICONS[toast.variant].paths as d}
            <path {d} />
          {/each}
        </svg>
        <span class="toast-text">{toast.message}</span>
        <button
          class="toast-dismiss"
          onclick={() => dismissToast(toast.id)}
          aria-label="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  {/each}
</div>

<style>
  /* ==========================================================================
     TOAST NOTIFICATIONS
     ========================================================================== */

  .toast-item {
    position: fixed;
    bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
    left: 50%;
    transform: translateX(-50%);
    z-index: 9100; /* above DemoBanner (9000) */
    max-width: 420px;
    width: calc(100% - 32px);
    animation: toastSlideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    pointer-events: auto;
  }

  /* Stack multiple toasts */
  .toast-item + .toast-item {
    bottom: calc(4.5rem + env(safe-area-inset-bottom, 0px));
  }
  .toast-item + .toast-item + .toast-item {
    bottom: calc(8rem + env(safe-area-inset-bottom, 0px));
  }

  /* Demo mode — raise above demo banner */
  .toast-stack.demo-mode .toast-item {
    bottom: calc(4rem + env(safe-area-inset-bottom, 0px));
  }
  .toast-stack.demo-mode .toast-item + .toast-item {
    bottom: calc(7.5rem + env(safe-area-inset-bottom, 0px));
  }
  .toast-stack.demo-mode .toast-item + .toast-item + .toast-item {
    bottom: calc(11rem + env(safe-area-inset-bottom, 0px));
  }

  @keyframes toastSlideUp {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(20px) scale(0.94);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0) scale(1);
    }
  }

  .toast-content {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: var(--color-glass, rgba(20, 18, 30, 0.85));
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid var(--color-glass-border, rgba(255, 255, 255, 0.08));
    border-radius: 14px;
    color: var(--color-text, #f0ede8);
    font-size: 0.875rem;
    line-height: 1.4;
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
    transition:
      border-color 0.3s,
      box-shadow 0.3s;
  }

  /* ── Info (blue) ── */
  .toast-info .toast-content {
    border-color: rgba(96, 165, 250, 0.3);
    box-shadow:
      0 8px 32px rgba(96, 165, 250, 0.12),
      0 0 0 1px rgba(96, 165, 250, 0.06),
      inset 0 1px 0 rgba(96, 165, 250, 0.08);
  }
  .toast-info .toast-icon { color: #60a5fa; }

  /* ── Success (green) ── */
  .toast-success .toast-content {
    border-color: rgba(16, 185, 129, 0.3);
    box-shadow:
      0 8px 32px rgba(16, 185, 129, 0.12),
      0 0 0 1px rgba(16, 185, 129, 0.06),
      inset 0 1px 0 rgba(16, 185, 129, 0.08);
  }
  .toast-success .toast-icon { color: #34d399; }

  /* ── Error (red) ── */
  .toast-error .toast-content {
    border-color: rgba(220, 50, 70, 0.3);
    box-shadow:
      0 8px 32px rgba(220, 50, 70, 0.12),
      0 0 0 1px rgba(220, 50, 70, 0.06),
      inset 0 1px 0 rgba(220, 50, 70, 0.08);
  }
  .toast-error .toast-icon { color: #e85d75; }

  /* ── Warning (purple) ── */
  .toast-warning .toast-content {
    border-color: rgba(167, 139, 250, 0.3);
    box-shadow:
      0 8px 32px rgba(167, 139, 250, 0.12),
      0 0 0 1px rgba(167, 139, 250, 0.06),
      inset 0 1px 0 rgba(167, 139, 250, 0.08);
  }
  .toast-warning .toast-icon { color: #a78bfa; }

  .toast-icon {
    flex-shrink: 0;
    opacity: 0.9;
  }

  .toast-text {
    flex: 1;
  }

  .toast-dismiss {
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--color-text-muted, rgba(240, 237, 232, 0.5));
    cursor: pointer;
    padding: 4px;
    border-radius: 6px;
    transition:
      color 0.15s,
      background 0.15s;
  }

  .toast-dismiss:hover {
    color: var(--color-text, #f0ede8);
    background: rgba(255, 255, 255, 0.06);
  }

  /* Push toasts above the mobile tab bar */
  @media (max-width: 767px) {
    .toast-item {
      bottom: calc(5.5rem + env(safe-area-inset-bottom, 0px));
    }
    .toast-item + .toast-item {
      bottom: calc(9rem + env(safe-area-inset-bottom, 0px));
    }
    .toast-item + .toast-item + .toast-item {
      bottom: calc(12.5rem + env(safe-area-inset-bottom, 0px));
    }

    .toast-stack.demo-mode .toast-item {
      bottom: calc(7.5rem + env(safe-area-inset-bottom, 0px));
    }
    .toast-stack.demo-mode .toast-item + .toast-item {
      bottom: calc(11rem + env(safe-area-inset-bottom, 0px));
    }
    .toast-stack.demo-mode .toast-item + .toast-item + .toast-item {
      bottom: calc(14.5rem + env(safe-area-inset-bottom, 0px));
    }
  }
</style>
