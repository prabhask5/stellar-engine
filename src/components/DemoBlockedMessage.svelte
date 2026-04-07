<!--
  @fileoverview DemoBlockedMessage — center-screen overlay for blocked demo mode operations.

  Renders a centered modal card when a feature is unavailable in demo mode.
  Triggered by calling `showDemoBlocked(message)` from `stellar-drive/demo`.

  - Mount this component once in your app root layout.
  - Auto-dismisses after 3 seconds.
  - Clicking the backdrop dismisses immediately.
  - z-index 9950 — above page content and DemoBanner (9000), below sign-out overlay (9998).
  - App-neutral styling — works in both Stellar and Radiant themes.

  Example mount in `+layout.svelte`:
  `import DemoBlockedMessage from 'stellar-drive/components/DemoBlockedMessage';`
  `<DemoBlockedMessage />`
-->
<script lang="ts">
  import { _demoBlockedStore } from 'stellar-drive/demo';
  import { fade, scale } from 'svelte/transition';

  const message = $derived($_demoBlockedStore);

  function dismiss(): void {
    _demoBlockedStore.set(null);
  }

  $effect(() => {
    if (!message) return;
    const t = setTimeout(() => _demoBlockedStore.set(null), 3000);
    return () => clearTimeout(t);
  });
</script>

{#if message}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="demo-blocked-backdrop"
    onclick={dismiss}
    role="dialog"
    aria-modal="true"
    aria-label="Demo mode restriction"
    transition:fade={{ duration: 200 }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="demo-blocked-card"
      onclick={(e) => e.stopPropagation()}
      transition:scale={{ duration: 250, start: 0.9 }}
    >
      <span class="demo-blocked-icon" aria-hidden="true">🔒</span>
      <p class="demo-blocked-text">{message}</p>
      <p class="demo-blocked-hint">Demo mode — tap anywhere to dismiss</p>
    </div>
  </div>
{/if}

<style>
  .demo-blocked-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9950;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    cursor: pointer;
  }

  .demo-blocked-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.625rem;
    padding: 2rem 2.5rem;
    background: rgba(16, 16, 24, 0.96);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 1rem;
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    box-shadow:
      0 24px 64px rgba(0, 0, 0, 0.6),
      0 0 0 1px rgba(255, 255, 255, 0.04) inset;
    max-width: calc(100vw - 3rem);
    text-align: center;
    cursor: default;
    pointer-events: auto;
  }

  .demo-blocked-icon {
    font-size: 2.25rem;
    line-height: 1;
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.4));
  }

  .demo-blocked-text {
    color: #fff;
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
    letter-spacing: 0.01em;
  }

  .demo-blocked-hint {
    color: rgba(255, 255, 255, 0.4);
    font-size: 0.75rem;
    font-weight: 400;
    margin: 0;
    letter-spacing: 0.02em;
  }
</style>
