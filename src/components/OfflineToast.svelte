<!--
  @fileoverview OfflineToast — app-neutral chunk-load error recovery toast.

  Mounts a single `unhandledrejection` listener and surfaces a friendly
  "page not available offline" message whenever a dynamic import fails because
  its JS chunk is not in the service-worker cache.

  - Mount once in your root `+layout.svelte`. No props required.
  - Auto-dismisses after 5 seconds. Dismiss button available immediately.
  - Positioned top-center, above all navigation chrome (z-index 1500).
  - Styled with the stellar-drive design tokens — works in any theme.

  Example mount:
  ```svelte
  import OfflineToast from 'stellar-drive/components/OfflineToast';
  <OfflineToast />
  ```
-->
<script lang="ts">
  // ==========================================================================
  //                           COMPONENT STATE
  // ==========================================================================

  /** Whether the toast is currently visible. */
  let visible = $state(false);

  /** Text to display in the toast. */
  let message = $state('');

  /** Auto-dismiss timer reference. */
  let timer: ReturnType<typeof setTimeout> | null = null;

  // ==========================================================================
  //                           HELPERS
  // ==========================================================================

  function show(msg: string, durationMs = 5000) {
    if (timer) clearTimeout(timer);
    message = msg;
    visible = true;
    timer = setTimeout(dismiss, durationMs);
  }

  function dismiss() {
    visible = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  // ==========================================================================
  //                      CHUNK ERROR LISTENER
  // ==========================================================================

  $effect(() => {
    function handleRejection(event: PromiseRejectionEvent) {
      const error = event.reason;
      const isChunkError =
        error?.message?.includes('Failed to fetch dynamically imported module') ||
        error?.message?.includes('error loading dynamically imported module') ||
        error?.message?.includes('Importing a module script failed') ||
        error?.name === 'ChunkLoadError' ||
        (error?.message?.includes('Loading chunk') && error?.message?.includes('failed'));

      if (isChunkError) {
        event.preventDefault();
        show("This page isn't available offline. Please reconnect or go back.");
      }
    }

    window.addEventListener('unhandledrejection', handleRejection);
    return () => window.removeEventListener('unhandledrejection', handleRejection);
  });
</script>

{#if visible}
  <div class="offline-toast" role="alert" aria-live="polite">
    <div class="offline-toast-icon" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    </div>
    <span class="offline-toast-message">{message}</span>
    <button class="offline-toast-dismiss" onclick={dismiss} aria-label="Dismiss">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </div>
{/if}

<style>
  .offline-toast {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 1rem);
    left: 50%;
    transform: translateX(-50%);
    z-index: 1500;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0.75rem 0.5rem 0.875rem;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 9999px;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    color: #fff;
    font-size: 0.8125rem;
    font-weight: 500;
    white-space: nowrap;
    max-width: calc(100vw - 2rem);
    animation: offline-toast-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes offline-toast-in {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(-0.75rem);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }

  .offline-toast-icon {
    flex-shrink: 0;
    color: rgba(255, 255, 255, 0.7);
    display: flex;
    align-items: center;
  }

  .offline-toast-message {
    flex: 1;
    opacity: 0.95;
  }

  .offline-toast-dismiss {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
    margin-left: 0.125rem;
    background: rgba(255, 255, 255, 0.15);
    border: none;
    border-radius: 50%;
    color: rgba(255, 255, 255, 0.8);
    cursor: pointer;
    transition: background 0.15s;
  }

  .offline-toast-dismiss:hover {
    background: rgba(255, 255, 255, 0.28);
  }

  @media (prefers-reduced-motion: reduce) {
    .offline-toast { animation: none; }
  }
</style>
