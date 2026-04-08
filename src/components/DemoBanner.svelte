<!--
  @fileoverview DemoBanner — fixed-position notification bar for demo mode.

  Renders a dismissible banner at the bottom of the viewport when the app is
  running in demo mode. Informs the user that changes will reset on refresh.

  - Desktop: pill-shaped, centered, original design.
  - Mobile: full-width bar anchored to the bottom, shows all content.
  - Only renders when `isDemoMode()` returns `true`.
  - Dismissible via the close button (component-local state).
  - Glass morphism styling with backdrop-filter blur.
  - z-index 9000 — above page content, below modals.
-->
<script lang="ts">
  import { isDemoMode } from 'stellar-drive';

  let dismissed = $state(false);
  const visible = $derived(isDemoMode() && !dismissed);
</script>

{#if visible}
  <div class="demo-banner" role="status" aria-live="polite">
    <span class="demo-banner-text">Demo Mode<span class="demo-banner-subtitle">&ensp;—&ensp;Changes reset on refresh</span></span>
    <a class="demo-banner-link" href="/demo">Demo Page</a>
    <button
      class="demo-banner-close"
      onclick={() => (dismissed = true)}
      aria-label="Dismiss demo mode banner"
    >
      <svg width="7" height="7" viewBox="0 0 8 8" fill="none" aria-hidden="true">
        <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
      </svg>
    </button>
  </div>
{/if}

<style>
  /* ── Desktop: pill, centered (original design) ── */
  .demo-banner {
    position: fixed;
    bottom: calc(var(--demo-banner-bottom, 1rem) + env(safe-area-inset-bottom, 0px));
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
    max-width: calc(100vw - 2rem);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
    pointer-events: auto;
    animation: demo-banner-slide-up 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .demo-banner-text {
    opacity: 0.95;
  }

  .demo-banner-subtitle {
    opacity: 0.75;
  }

  .demo-banner-link {
    color: rgba(255, 255, 255, 0.65);
    font-size: 0.75rem;
    text-decoration: none;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    transition: background 0.15s ease, color 0.15s ease;
  }

  .demo-banner-link:hover {
    background: rgba(255, 255, 255, 0.18);
    color: #fff;
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
    cursor: pointer;
    transition: background 0.15s ease;
    flex-shrink: 0;
    line-height: 1;
  }

  .demo-banner-close:hover {
    background: rgba(255, 255, 255, 0.28);
  }

  /* ── Mobile: full-width bar anchored to bottom ── */
  @media (max-width: 767px) {
    .demo-banner {
      left: 0;
      right: 0;
      bottom: calc(var(--demo-banner-bottom, 0px) + env(safe-area-inset-bottom, 0px));
      transform: none;
      border-radius: 0;
      border-left: none;
      border-right: none;
      border-bottom: none;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      padding: 0.45rem 1rem;
      font-size: 0.78rem;
      gap: 0.6rem;
      max-width: none;
      white-space: normal;
      animation: demo-banner-rise 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
  }

  @keyframes demo-banner-slide-up {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(0.75rem);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }

  @keyframes demo-banner-rise {
    from {
      opacity: 0;
      transform: translateY(100%);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
