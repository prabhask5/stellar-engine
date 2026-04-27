<!--
  @fileoverview OfflineBanner — fixed-position notification bar for offline state.

  Renders a persistent amber glass banner just below the top navigation when the
  app has no network connectivity. Auto-dismisses reactively when connectivity
  is restored — no explicit dismiss needed.

  - Desktop: pill-shaped, centered, positioned below the 64px top nav
    (accounts for safe-area-inset-top on notch/island devices).
  - Mobile: full-width bar flush below the island-header, which ends at
    calc(env(safe-area-inset-top, 47px) + 24px) from the viewport top.
  - Only renders when `$isOnline` is `false`.
  - No dismiss button — auto-hides on reconnect.
  - Glass morphism styling with amber tint to distinguish from DemoBanner.
  - z-index 9000 — matches DemoBanner tier.
  - Never overlaps top nav on desktop or island-header on mobile.
-->
<script lang="ts">
  import { isOnline } from 'stellar-drive/stores';
</script>

{#if !$isOnline}
  <div class="offline-banner" role="status" aria-live="assertive">
    <svg class="offline-banner-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="1" y1="1" x2="23" y2="23"/>
      <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
      <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
      <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
      <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
      <line x1="12" y1="20" x2="12.01" y2="20"/>
    </svg>
    <span class="offline-banner-text">You're offline — some features require a connection</span>
  </div>
{/if}

<style>
  /* ── Desktop: pill, centered, below top nav ──
     Both apps have a 64px top nav plus env(safe-area-inset-top) padding.
     0.75rem gap gives breathing room between nav bottom and banner top. */
  .offline-banner {
    position: fixed;
    top: calc(64px + env(safe-area-inset-top, 0px) + 0.75rem);
    left: 50%;
    transform: translateX(-50%);
    z-index: 9000;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 1.1rem;
    border-radius: 9999px;
    background: rgba(180, 120, 0, 0.15);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255, 200, 80, 0.2);
    color: #ffd97a;
    font-size: 0.8125rem;
    font-weight: 500;
    letter-spacing: 0.01em;
    white-space: nowrap;
    max-width: calc(100vw - 2rem);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    pointer-events: none;
    animation: offline-banner-slide-down 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .offline-banner-icon {
    flex-shrink: 0;
    opacity: 0.9;
  }

  .offline-banner-text {
    opacity: 0.95;
  }

  /* ── Mobile: full-width bar flush below island-header ──
     island-header bottom edge = safe-area-inset-top + 24px from viewport top.
     Formula: -safe-area-inset-top (header top offset) + safe-area-inset-top*2 + 24px (header height)
     = safe-area-inset-top + 24px.
     Using env(safe-area-inset-top, 47px) matches the fallback the header itself uses
     so the banner stays flush on devices that don't support env(). */
  @media (max-width: 767px) {
    .offline-banner {
      top: calc(env(safe-area-inset-top, 47px) + 24px);
      left: 0;
      right: 0;
      transform: none;
      border-radius: 0;
      border-left: none;
      border-right: none;
      border-top: none;
      border-bottom: 1px solid rgba(255, 200, 80, 0.18);
      padding: 0.45rem 1rem;
      font-size: 0.78rem;
      gap: 0.5rem;
      max-width: none;
      white-space: normal;
      animation: offline-banner-drop 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
  }

  @keyframes offline-banner-slide-down {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(-0.75rem);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }

  @keyframes offline-banner-drop {
    from {
      opacity: 0;
      transform: translateY(-100%);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
