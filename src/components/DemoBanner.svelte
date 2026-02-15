<!--
  @fileoverview DemoBanner — fixed-position notification bar for demo mode.

  Renders a subtle, dismissible banner at the bottom center of the viewport
  when the app is running in demo mode. Informs the user that changes will
  reset on refresh.

  - Only renders when `isDemoMode()` returns `true`.
  - Dismissible via the close button (component-local state).
  - Glass morphism styling with backdrop-filter blur.
  - z-index 9000 — above page content, below modals.
-->
<script lang="ts">
  import { isDemoMode } from '../demo';

  let dismissed = $state(false);
  const visible = $derived(isDemoMode() && !dismissed);
</script>

{#if visible}
  <div class="demo-banner" role="status" aria-live="polite">
    <span class="demo-banner-text">Demo Mode — Changes reset on refresh</span>
    <button
      class="demo-banner-close"
      onclick={() => (dismissed = true)}
      aria-label="Dismiss demo mode banner"
    >
      ✕
    </button>
  </div>
{/if}

<style>
  .demo-banner {
    position: fixed;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9000;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-radius: 9999px;
    background: rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #fff;
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: 0.01em;
    white-space: nowrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    pointer-events: auto;
    animation: demo-banner-slide-up 0.3s ease-out;
  }

  .demo-banner-text {
    opacity: 0.95;
  }

  .demo-banner-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.625rem;
    cursor: pointer;
    transition: background 0.15s ease;
    flex-shrink: 0;
  }

  .demo-banner-close:hover {
    background: rgba(255, 255, 255, 0.25);
  }

  @keyframes demo-banner-slide-up {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(1rem);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
</style>
