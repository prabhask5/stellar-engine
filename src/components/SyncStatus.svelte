<script lang="ts">
  /**
   * @fileoverview SyncStatus — animated sync-state indicator with tooltip and PWA refresh.
   *
   * Displays a circular button whose icon morphs between five states:
   * **offline** (wifi-off), **syncing** (spinner), **synced** (checkmark),
   * **error** (exclamation), and **pending** (refresh arrows).  Each state
   * has its own colour, ring animation, and SVG draw-in transition.
   *
   * Key behaviours:
   * - Icons cross-fade via absolute positioning + opacity + scale/rotation.
   * - `isTransitioning` triggers a brief pulse when moving from syncing to
   *   synced/error, giving a satisfying "morph" feel.
   * - A **live indicator** (green dot + expanding ring) shows when the
   *   realtime subscription is connected.
   * - Hovering reveals a tooltip with sync status, description, last-sync
   *   time, and (when in error state) an expandable error-details panel.
   * - A **mobile refresh button** (visible < 640 px) triggers a full page
   *   reload to pull the latest PWA deployment.
   * - `prefers-reduced-motion` disables all animations gracefully.
   */

  import { syncStatusStore, isOnline } from '@prabhask5/stellar-engine/stores';
  import type { SyncError, RealtimeState } from '@prabhask5/stellar-engine/types';
  import { runFullSync } from '@prabhask5/stellar-engine';
  import type { SyncStatus } from '@prabhask5/stellar-engine/types';

  // =============================================================================
  //                          Local Reactive State
  // =============================================================================

  /** Current sync status (`idle` | `syncing` | `error` | ...) */
  let status = $state<SyncStatus>('idle');
  /** Whether a PWA page-reload is in progress */
  let isRefreshing = $state(false);
  /** Number of un-synced local changes */
  let pendingCount = $state(0);
  /** Whether the browser is online */
  let online = $state(true);
  /** Human-readable error message (last sync failure) */
  let lastError = $state<string | null>(null);
  /** Technical error details (for the expandable panel) */
  let lastErrorDetails = $state<string | null>(null);
  /** Array of per-entity sync errors for the detail panel */
  let syncErrors = $state<SyncError[]>([]);
  /** ISO timestamp of the last successful sync */
  let lastSyncTime = $state<string | null>(null);
  /** Transient message shown during sync (e.g. "Syncing goals...") */
  let syncMessage = $state<string | null>(null);
  /** Supabase Realtime connection state */
  let realtimeState = $state<RealtimeState>('disconnected');
  /** Whether the tooltip is visible */
  let showTooltip = $state(false);
  /** Whether the error-details panel inside the tooltip is expanded */
  let showDetails = $state(false);
  /** Handle for the delayed tooltip show/hide */
  let tooltipTimeout: ReturnType<typeof setTimeout> | null = null;
  /** Whether the cursor is currently over the indicator */
  let isMouseOver = $state(false);

  // =============================================================================
  //                     Transition Tracking State
  // =============================================================================

  /** Previous display-state string — used to detect state changes */
  let prevDisplayState = $state<string>('idle');
  /** Previous realtime state — used to detect realtime transitions */
  let prevRealtimeState = $state<RealtimeState>('disconnected');
  /** Brief flag that triggers the icon-core "pulse" animation */
  let isTransitioning = $state(false);
  /** Brief flag for the live-indicator pop animation */
  let isRealtimeTransitioning = $state(false);

  // =============================================================================
  //                     Store Subscriptions (via $effect)
  // =============================================================================

  /**
   * Subscribe to `syncStatusStore` and `isOnline` stores, copying their
   * values into local state.  Also tracks realtime state transitions
   * so the live-indicator can play a smooth pop animation.
   */
  $effect(() => {
    const unsubSync = syncStatusStore.subscribe((value) => {
      status = value.status;
      pendingCount = value.pendingCount;
      lastError = value.lastError;
      lastErrorDetails = value.lastErrorDetails;
      syncErrors = value.syncErrors;
      lastSyncTime = value.lastSyncTime;
      syncMessage = value.syncMessage;

      // Track realtime state changes for smooth animation
      if (value.realtimeState !== prevRealtimeState) {
        isRealtimeTransitioning = true;
        setTimeout(() => {
          isRealtimeTransitioning = false;
        }, 400);
        prevRealtimeState = value.realtimeState;
      }
      realtimeState = value.realtimeState;
    });
    const unsubOnline = isOnline.subscribe((value) => {
      online = value;
    });

    return () => {
      unsubSync();
      unsubOnline();
      if (tooltipTimeout) clearTimeout(tooltipTimeout);
    };
  });

  // =============================================================================
  //                     Derived — Realtime Live Check
  // =============================================================================

  /** Whether the realtime channel is connected and the browser is online */
  const isRealtimeLive = $derived(() => {
    return online && realtimeState === 'connected';
  });

  // =============================================================================
  //                          Event Handlers
  // =============================================================================

  /**
   * Trigger a full manual sync when the indicator is clicked (only if online
   * and not already syncing).
   */
  function handleSyncClick() {
    if (online && status !== 'syncing') {
      runFullSync(false);
    }
  }

  /**
   * Trigger a full page reload to fetch the latest PWA deployment.
   * Debounced — ignored if already in progress.
   */
  function handleRefresh() {
    if (isRefreshing) return;
    isRefreshing = true;

    // Short delay for visual feedback before reload
    setTimeout(() => {
      window.location.reload();
    }, 300);
  }

  /**
   * Show the tooltip after a brief hover delay.
   */
  function handleMouseEnter() {
    isMouseOver = true;
    if (tooltipTimeout) clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
      if (isMouseOver) {
        showTooltip = true;
      }
    }, 200);
  }

  /**
   * Hide the tooltip (and error details) after a brief leave delay.
   */
  function handleMouseLeave() {
    isMouseOver = false;
    if (tooltipTimeout) clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
      if (!isMouseOver) {
        showTooltip = false;
        showDetails = false;
      }
    }, 150);
  }

  // =============================================================================
  //                     Derived — Display State
  // =============================================================================

  /**
   * Map the raw sync status + online flag into one of five display states:
   * `offline` | `syncing` | `error` | `pending` | `synced`.
   */
  const displayState = $derived(() => {
    if (!online) return 'offline';
    if (status === 'syncing') return 'syncing';
    if (status === 'error') return 'error';
    if (pendingCount > 0) return 'pending';
    return 'synced';
  });

  // =============================================================================
  //                     Effect — Transition Animation Trigger
  // =============================================================================

  /**
   * When the display state changes from `syncing` to `synced` or `error`,
   * briefly set `isTransitioning` to trigger the morph-in CSS animation.
   */
  $effect(() => {
    const current = displayState();
    if (current !== prevDisplayState) {
      if (prevDisplayState === 'syncing' && (current === 'synced' || current === 'error')) {
        isTransitioning = true;
        setTimeout(() => {
          isTransitioning = false;
        }, 600);
      }
      prevDisplayState = current;
    }
  });

  // =============================================================================
  //                     Derived — Tooltip Labels
  // =============================================================================

  /**
   * Relative time label for the last successful sync
   * (e.g. "Just now", "5m ago", "2h ago").
   */
  const formattedLastSync = $derived(() => {
    if (!lastSyncTime) return null;
    const date = new Date(lastSyncTime);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 10) return 'Just now';
    if (diffSecs < 60) return `${diffSecs}s ago`;
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  });

  /** Short status label for the tooltip header (e.g. "All Synced") */
  const statusLabel = $derived(() => {
    const state = displayState();
    switch (state) {
      case 'offline':
        return 'Offline';
      case 'syncing':
        return 'Syncing';
      case 'error':
        return 'Sync Error';
      case 'pending':
        return 'Changes Pending';
      default:
        return 'All Synced';
    }
  });

  /** Realtime connection label (e.g. "Live", "Connecting...") */
  const realtimeLabel = $derived(() => {
    if (!online) return null;
    switch (realtimeState) {
      case 'connected':
        return 'Live';
      case 'connecting':
        return 'Connecting...';
      case 'error':
        return 'Using polling';
      default:
        return null;
    }
  });

  /** Longer description for the tooltip body */
  const statusDescription = $derived(() => {
    const state = displayState();
    if (syncMessage) return syncMessage;

    switch (state) {
      case 'offline':
        return "Changes will sync when you're back online.";
      case 'syncing':
        return 'Syncing your data...';
      case 'error':
        return lastError || 'Something went wrong. Tap to retry.';
      case 'pending':
        return `${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting to sync.`;
      default:
        if (isRealtimeLive()) {
          return 'Live sync active. Changes sync instantly across devices.';
        }
        return 'All your data is up to date.';
    }
  });

  // =============================================================================
  //                     Utility — Error Detail Formatting
  // =============================================================================

  /**
   * Convert a snake_case table name to Title Case for display.
   * @param {string} table - Database table name (e.g. "daily_routine_goals")
   * @returns {string} Formatted name (e.g. "Daily Routine Goals")
   */
  function formatTableName(table: string): string {
    return table.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Capitalise a CRUD operation name for display.
   * @param {string} op - Operation string ("create" | "update" | "delete")
   * @returns {string} Capitalised label
   */
  function formatOperation(op: string): string {
    switch (op) {
      case 'create':
        return 'Create';
      case 'update':
        return 'Update';
      case 'delete':
        return 'Delete';
      default:
        return op;
    }
  }

  /**
   * Return the appropriate CSS colour variable for a CRUD operation.
   * @param {string} op - Operation string
   * @returns {string} CSS variable reference
   */
  function getOperationColor(op: string): string {
    switch (op) {
      case 'create':
        return 'var(--color-green)';
      case 'update':
        return 'var(--color-primary-light)';
      case 'delete':
        return 'var(--color-red)';
      default:
        return 'var(--color-text-muted)';
    }
  }
</script>

<!-- ═══════════════════════════════════════════════════════════════════════════
     Template — Sync Indicator + Tooltip + Mobile Refresh
     ═══════════════════════════════════════════════════════════════════════════ -->

<!-- Sync indicator with tooltip and mobile refresh button -->
<div
  class="sync-container"
  role="status"
  onmouseenter={handleMouseEnter}
  onmouseleave={handleMouseLeave}
>
  <!-- ═══ Mobile Refresh Button (visible < 640 px) ═══ -->
  <button
    class="refresh-btn"
    class:refreshing={isRefreshing}
    onclick={handleRefresh}
    disabled={isRefreshing || !online}
    aria-label="Refresh app"
  >
    <span class="refresh-glow"></span>
    <svg
      class="refresh-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M21 21v-5h-5" />
    </svg>
  </button>

  <div class="sync-wrapper">
    <!-- ═══ Main Sync Indicator Button ═══ -->
    <button
      class="sync-indicator"
      class:offline={displayState() === 'offline'}
      class:syncing={displayState() === 'syncing'}
      class:error={displayState() === 'error'}
      class:pending={displayState() === 'pending'}
      class:synced={displayState() === 'synced'}
      onclick={handleSyncClick}
      disabled={!online || status === 'syncing'}
      aria-label={statusLabel()}
    >
      <!-- Animated ring around the button -->
      <span class="indicator-ring"></span>

      <!-- ═══ Morphing Icon Container ═══ -->
      <span class="indicator-core" class:transitioning={isTransitioning}>
        <!-- Offline Icon (wifi-off) -->
        <svg
          class="icon icon-offline"
          class:active={displayState() === 'offline'}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line x1="1" y1="1" x2="23" y2="23" />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </svg>

        <!-- Syncing Spinner -->
        <svg
          class="icon icon-syncing"
          class:active={displayState() === 'syncing'}
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        >
          <circle class="spinner-track" cx="12" cy="12" r="9" stroke-opacity="0.2" />
          <path class="spinner-arc" d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>

        <!-- Success Checkmark (draw-in animation) -->
        <svg
          class="icon icon-synced"
          class:active={displayState() === 'synced'}
          class:morph-in={isTransitioning && displayState() === 'synced'}
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <circle class="check-circle" cx="12" cy="12" r="9" />
          <polyline class="check-mark" points="8 12 11 15 16 9" />
        </svg>

        <!-- Error Icon (draw-in animation) -->
        <svg
          class="icon icon-error"
          class:active={displayState() === 'error'}
          class:morph-in={isTransitioning && displayState() === 'error'}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        >
          <circle class="error-circle" cx="12" cy="12" r="9" />
          <line class="error-line" x1="12" y1="8" x2="12" y2="12" />
          <line class="error-dot" x1="12" y1="16" x2="12.01" y2="16" />
        </svg>

        <!-- Pending Icon (refresh arrows) -->
        <svg
          class="icon icon-pending"
          class:active={displayState() === 'pending'}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        >
          <path
            d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"
          />
        </svg>
      </span>

      <!-- Pending count badge -->
      {#if displayState() === 'pending'}
        <span class="pending-badge">{pendingCount}</span>
      {/if}

      <!-- ═══ Live Indicator (green dot when realtime connected) ═══ -->
      <span
        class="live-indicator"
        class:active={isRealtimeLive()}
        class:connecting={online && realtimeState === 'connecting'}
        class:transitioning={isRealtimeTransitioning}
      >
        <span class="live-dot"></span>
        <span class="live-ring"></span>
      </span>
    </button>

    <!-- ═══ Tooltip (hover-reveal) ═══ -->
    {#if showTooltip}
      <div
        class="tooltip"
        class:error={displayState() === 'error'}
        class:has-errors={syncErrors.length > 0}
      >
        <div class="tooltip-arrow"></div>
        <div class="tooltip-content">
          <!-- ── Status Header (dot + label + realtime badge + last sync) ── -->
          <div class="tooltip-header">
            <div
              class="status-dot"
              class:offline={displayState() === 'offline'}
              class:syncing={displayState() === 'syncing'}
              class:error={displayState() === 'error'}
              class:pending={displayState() === 'pending'}
              class:synced={displayState() === 'synced'}
            ></div>
            <span class="status-label">{statusLabel()}</span>
            {#if realtimeLabel() && displayState() !== 'offline'}
              <span
                class="realtime-badge"
                class:live={realtimeState === 'connected'}
                class:connecting={realtimeState === 'connecting'}
              >
                {#if realtimeState === 'connected'}
                  <span class="realtime-dot"></span>
                {/if}
                {realtimeLabel()}
              </span>
            {/if}
            {#if formattedLastSync() && displayState() !== 'syncing'}
              <span class="last-sync">{formattedLastSync()}</span>
            {/if}
          </div>

          <!-- ── Status Description ── -->
          <p class="tooltip-description">{statusDescription()}</p>

          <!-- ── Error Details (expandable panel) ── -->
          {#if displayState() === 'error' && (syncErrors.length > 0 || lastErrorDetails)}
            <button
              class="details-toggle"
              onclick={(e) => {
                e.stopPropagation();
                showDetails = !showDetails;
              }}
            >
              <span>{showDetails ? 'Hide' : 'Show'} error details</span>
              <svg
                class="chevron"
                class:expanded={showDetails}
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {#if showDetails}
              <div class="error-details-panel">
                {#if syncErrors.length > 0}
                  <!-- Per-entity error cards -->
                  <div class="error-list">
                    {#each syncErrors as error, i (i)}
                      <div class="error-item" style="animation-delay: {i * 50}ms">
                        <div class="error-item-header">
                          <span
                            class="error-operation"
                            style="color: {getOperationColor(error.operation)}"
                          >
                            {formatOperation(error.operation)}
                          </span>
                          <span class="error-table">{formatTableName(error.table)}</span>
                        </div>
                        <div class="error-message">
                          <code>{error.message}</code>
                        </div>
                        <div class="error-meta">
                          <span class="error-entity" title={error.entityId}>
                            ID: {error.entityId.slice(0, 8)}...
                          </span>
                        </div>
                      </div>
                    {/each}
                  </div>
                {:else if lastErrorDetails}
                  <!-- Fallback raw error text -->
                  <div class="error-fallback">
                    <code>{lastErrorDetails}</code>
                  </div>
                {/if}
              </div>
            {/if}
          {/if}

          <!-- ── Action Hint ("Tap to sync now") ── -->
          {#if displayState() === 'error' || displayState() === 'pending'}
            <div class="tooltip-action">
              <span class="action-hint">Tap to sync now</span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path
                  d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"
                />
              </svg>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<!-- ═══════════════════════════════════════════════════════════════════════════
     Styles
     ═══════════════════════════════════════════════════════════════════════════ -->

<style>
  /* ═══ Sync Container ═══ */

  .sync-container {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* ═══ Mobile Refresh Button ═══ */

  .refresh-btn {
    display: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: linear-gradient(145deg, rgba(20, 20, 40, 0.9) 0%, rgba(15, 15, 32, 0.95) 100%);
    border: 1.5px solid rgba(108, 92, 231, 0.25);
    color: var(--color-primary-light);
    cursor: pointer;
    transition: all 0.4s var(--ease-spring);
    position: relative;
    overflow: hidden;
    align-items: center;
    justify-content: center;
  }

  .refresh-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .refresh-btn:not(:disabled):hover {
    border-color: rgba(108, 92, 231, 0.5);
    transform: scale(1.05);
    box-shadow: 0 0 20px var(--color-primary-glow);
  }

  .refresh-btn:not(:disabled):active {
    transform: scale(0.95);
  }

  /* Radial glow behind the refresh button */
  .refresh-glow {
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(108, 92, 231, 0.3) 0%, transparent 70%);
    opacity: 0;
    transition: opacity 0.3s;
    pointer-events: none;
  }

  .refresh-btn:not(:disabled):hover .refresh-glow {
    opacity: 1;
  }

  .refresh-btn.refreshing .refresh-glow {
    opacity: 1;
    animation: refreshGlowPulse 0.8s ease-in-out infinite;
  }

  @keyframes refreshGlowPulse {
    0%,
    100% {
      opacity: 0.5;
      transform: scale(1);
    }
    50% {
      opacity: 1;
      transform: scale(1.3);
    }
  }

  .refresh-icon {
    position: relative;
    z-index: 1;
    transition: transform 0.4s var(--ease-spring);
  }

  .refresh-btn:not(:disabled):hover .refresh-icon {
    transform: rotate(-30deg);
  }

  .refresh-btn.refreshing .refresh-icon {
    animation: refreshSpin 0.8s ease-in-out infinite;
  }

  @keyframes refreshSpin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(-360deg);
    }
  }

  /* Show refresh button only on mobile */
  @media (max-width: 640px) {
    .refresh-btn {
      display: flex;
    }
  }

  /* ═══ Sync Wrapper (relative container for tooltip positioning) ═══ */

  .sync-wrapper {
    position: relative;
    display: inline-flex;
  }

  /* ═══ Main Sync Indicator Button ═══ */

  .sync-indicator {
    position: relative;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(145deg, rgba(20, 20, 40, 0.9) 0%, rgba(15, 15, 32, 0.95) 100%);
    border: 1.5px solid rgba(108, 92, 231, 0.25);
    cursor: pointer;
    transition: all 0.4s var(--ease-spring);
    flex-shrink: 0;
  }

  .sync-indicator:disabled {
    cursor: default;
  }

  .sync-indicator:not(:disabled):hover {
    border-color: rgba(108, 92, 231, 0.5);
  }

  .sync-indicator:not(:disabled):hover .indicator-core {
    transform: scale(1.1);
  }

  .sync-indicator:not(:disabled):active .indicator-core {
    transform: scale(0.95);
  }

  /* Transition pulse effect — only on the icon core, not the whole button */
  .indicator-core.transitioning {
    animation: transitionPulse 0.6s var(--ease-spring);
  }

  @keyframes transitionPulse {
    0% {
      transform: scale(1);
    }
    30% {
      transform: scale(1.15);
    }
    100% {
      transform: scale(1);
    }
  }

  /* Animated ring around the indicator */
  .indicator-ring {
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 2px solid transparent;
    transition: all 0.4s var(--ease-smooth);
  }

  /* ═══ Morphing Icon System ═══ */

  .indicator-core {
    position: relative;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.3s var(--ease-spring);
  }

  /* Base icon styles — all icons absolutely positioned, cross-fading */
  .icon {
    position: absolute;
    opacity: 0;
    transform: scale(0.5) rotate(-90deg);
    transition:
      opacity 0.35s var(--ease-spring),
      transform 0.45s var(--ease-spring);
    color: var(--color-text-muted);
  }

  .icon.active {
    opacity: 1;
    transform: scale(1) rotate(0deg);
  }

  /* ═══ Syncing State — Spinning Animation ═══ */

  .sync-indicator.syncing {
    border-color: rgba(108, 92, 231, 0.5);
    box-shadow: 0 0 20px var(--color-primary-glow);
  }

  .icon-syncing {
    color: var(--color-primary-light);
  }

  .icon-syncing.active {
    animation: spinnerRotate 1s linear infinite;
  }

  .spinner-arc {
    stroke-dasharray: 45;
    stroke-dashoffset: 0;
  }

  @keyframes spinnerRotate {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .sync-indicator.syncing .indicator-ring {
    border-color: var(--color-primary);
    border-top-color: transparent;
    animation: ringSpinPurple 1s linear infinite;
  }

  @keyframes ringSpinPurple {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  /* ═══ Synced State — Checkmark with Draw Animation ═══ */

  .sync-indicator.synced {
    border-color: rgba(38, 222, 129, 0.3);
  }

  .icon-synced {
    color: var(--color-green);
  }

  /* SVG stroke-dash draw-in for the circle and checkmark */
  .icon-synced .check-circle {
    stroke-dasharray: 60;
    stroke-dashoffset: 60;
    transition: stroke-dashoffset 0.4s var(--ease-out) 0.1s;
  }

  .icon-synced .check-mark {
    stroke-dasharray: 20;
    stroke-dashoffset: 20;
    transition: stroke-dashoffset 0.3s var(--ease-out) 0.35s;
  }

  .icon-synced.active .check-circle {
    stroke-dashoffset: 0;
  }

  .icon-synced.active .check-mark {
    stroke-dashoffset: 0;
  }

  /* Morph-in animation from spinner to checkmark */
  .icon-synced.morph-in {
    animation: morphInSuccess 0.5s var(--ease-spring);
  }

  @keyframes morphInSuccess {
    0% {
      transform: scale(0.8) rotate(-180deg);
      opacity: 0;
    }
    50% {
      transform: scale(1.1) rotate(10deg);
      opacity: 1;
    }
    100% {
      transform: scale(1) rotate(0deg);
      opacity: 1;
    }
  }

  .sync-indicator.synced .indicator-ring {
    border-color: rgba(38, 222, 129, 0.2);
    animation: ringPulseGreen 3s ease-in-out infinite;
  }

  @keyframes ringPulseGreen {
    0%,
    100% {
      transform: scale(1);
      opacity: 1;
      border-color: rgba(38, 222, 129, 0.2);
    }
    50% {
      transform: scale(1.15);
      opacity: 0;
      border-color: rgba(38, 222, 129, 0.4);
    }
  }

  /* ═══ Error State — Shake + Draw Animation ═══ */

  .sync-indicator.error {
    border-color: rgba(255, 107, 107, 0.5);
  }

  .icon-error {
    color: var(--color-red);
  }

  /* SVG stroke-dash draw-in for error icon parts */
  .icon-error .error-circle {
    stroke-dasharray: 60;
    stroke-dashoffset: 60;
    transition: stroke-dashoffset 0.4s var(--ease-out) 0.1s;
  }

  .icon-error .error-line {
    stroke-dasharray: 10;
    stroke-dashoffset: 10;
    transition: stroke-dashoffset 0.2s var(--ease-out) 0.35s;
  }

  .icon-error .error-dot {
    opacity: 0;
    transition: opacity 0.2s var(--ease-out) 0.5s;
  }

  .icon-error.active .error-circle {
    stroke-dashoffset: 0;
  }

  .icon-error.active .error-line {
    stroke-dashoffset: 0;
  }

  .icon-error.active .error-dot {
    opacity: 1;
  }

  /* Morph-in animation from spinner to error */
  .icon-error.morph-in {
    animation: morphInError 0.5s var(--ease-spring);
  }

  @keyframes morphInError {
    0% {
      transform: scale(0.8) rotate(180deg);
      opacity: 0;
    }
    40% {
      transform: scale(1.15) rotate(-10deg);
      opacity: 1;
    }
    60% {
      transform: scale(1) rotate(5deg);
    }
    80% {
      transform: scale(1.05) rotate(-3deg);
    }
    100% {
      transform: scale(1) rotate(0deg);
      opacity: 1;
    }
  }

  .sync-indicator.error .indicator-ring {
    border-color: rgba(255, 107, 107, 0.3);
    animation: ringPulseRed 1.5s ease-in-out infinite;
  }

  @keyframes ringPulseRed {
    0%,
    100% {
      transform: scale(1);
      opacity: 1;
    }
    50% {
      transform: scale(1.2);
      opacity: 0;
    }
  }

  /* ═══ Pending State ═══ */

  .sync-indicator.pending {
    border-color: rgba(108, 92, 231, 0.4);
  }

  .icon-pending {
    color: var(--color-primary-light);
  }

  .sync-indicator.pending:not(:disabled):hover {
    box-shadow: 0 0 25px var(--color-primary-glow);
  }

  /* Pending count badge (top-right) */
  .pending-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    background: var(--gradient-primary);
    color: white;
    font-size: 10px;
    font-weight: 700;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px var(--color-primary-glow);
    animation: badgePop 0.3s var(--ease-spring);
  }

  @keyframes badgePop {
    0% {
      transform: scale(0);
    }
    70% {
      transform: scale(1.2);
    }
    100% {
      transform: scale(1);
    }
  }

  /* ═══ Offline State ═══ */

  .sync-indicator.offline {
    border-color: rgba(255, 217, 61, 0.4);
  }

  .icon-offline {
    color: var(--color-yellow);
  }

  .sync-indicator.offline .indicator-ring {
    border-color: rgba(255, 217, 61, 0.2);
    animation: ringPulseYellow 2s ease-in-out infinite;
  }

  @keyframes ringPulseYellow {
    0%,
    100% {
      transform: scale(1);
      opacity: 1;
      border-color: rgba(255, 217, 61, 0.2);
    }
    50% {
      transform: scale(1.15);
      opacity: 0.3;
      border-color: rgba(255, 217, 61, 0.4);
    }
  }

  /* ═══ Live Indicator (realtime connection dot) ═══ */

  .live-indicator {
    position: absolute;
    bottom: -7px;
    right: -7px;
    width: 14px;
    height: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0;
    transform: scale(0) rotate(-90deg);
    transition:
      opacity 0.4s var(--ease-spring),
      transform 0.5s var(--ease-spring);
  }

  .live-indicator.active {
    opacity: 1;
    transform: scale(1) rotate(0deg);
  }

  .live-indicator.connecting {
    opacity: 0.6;
    transform: scale(0.9) rotate(0deg);
  }

  .live-indicator.transitioning {
    animation: liveIndicatorPop 0.5s var(--ease-spring);
  }

  @keyframes liveIndicatorPop {
    0% {
      transform: scale(0.6) rotate(-45deg);
    }
    50% {
      transform: scale(1.2) rotate(10deg);
    }
    100% {
      transform: scale(1) rotate(0deg);
    }
  }

  /* Green dot */
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: linear-gradient(135deg, #10b981 0%, #34d399 100%);
    box-shadow:
      0 0 4px rgba(16, 185, 129, 0.6),
      0 0 8px rgba(16, 185, 129, 0.3);
    position: relative;
    z-index: 2;
  }

  .live-indicator.active .live-dot {
    animation: liveDotPulse 3s ease-in-out infinite;
  }

  .live-indicator.connecting .live-dot {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    box-shadow:
      0 0 4px rgba(99, 102, 241, 0.6),
      0 0 8px rgba(99, 102, 241, 0.3);
    animation: liveDotConnecting 1s ease-in-out infinite;
  }

  @keyframes liveDotPulse {
    0%,
    100% {
      transform: scale(1);
      box-shadow:
        0 0 4px rgba(16, 185, 129, 0.6),
        0 0 8px rgba(16, 185, 129, 0.3);
    }
    50% {
      transform: scale(1.1);
      box-shadow:
        0 0 6px rgba(16, 185, 129, 0.8),
        0 0 12px rgba(16, 185, 129, 0.4);
    }
  }

  @keyframes liveDotConnecting {
    0%,
    100% {
      opacity: 0.4;
      transform: scale(0.9);
    }
    50% {
      opacity: 1;
      transform: scale(1.1);
    }
  }

  /* Expanding ring around the live dot */
  .live-ring {
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    border: 1.5px solid rgba(16, 185, 129, 0.4);
    opacity: 0;
    transform: scale(0.8);
  }

  .live-indicator.active .live-ring {
    animation: liveRingPulse 3s ease-out infinite;
  }

  @keyframes liveRingPulse {
    0% {
      opacity: 0.6;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(2);
    }
  }

  /* ═══ Tooltip ═══ */

  .tooltip {
    position: absolute;
    top: calc(100% + 12px);
    right: 0;
    z-index: 1000;
    pointer-events: auto;
    animation: tooltipFadeIn 0.25s var(--ease-spring);
  }

  @keyframes tooltipFadeIn {
    from {
      opacity: 0;
      transform: translateY(-8px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  /* Arrow pointing up from tooltip to indicator */
  .tooltip-arrow {
    position: absolute;
    top: -6px;
    right: 16px;
    width: 12px;
    height: 12px;
    background: rgba(20, 20, 35, 0.98);
    border: 1px solid rgba(108, 92, 231, 0.2);
    border-bottom: none;
    border-right: none;
    transform: rotate(45deg);
    border-radius: 2px 0 0 0;
  }

  .tooltip.error .tooltip-arrow {
    border-color: rgba(255, 107, 107, 0.3);
  }

  .tooltip-content {
    min-width: 240px;
    max-width: 340px;
    padding: 14px 16px;
    background: linear-gradient(145deg, rgba(20, 20, 35, 0.98) 0%, rgba(15, 15, 28, 0.99) 100%);
    border: 1px solid rgba(108, 92, 231, 0.2);
    border-radius: 16px;
    backdrop-filter: blur(40px) saturate(180%);
    -webkit-backdrop-filter: blur(40px) saturate(180%);
    box-shadow:
      0 4px 24px rgba(0, 0, 0, 0.4),
      0 0 0 1px rgba(255, 255, 255, 0.03) inset,
      0 1px 0 rgba(255, 255, 255, 0.05) inset;
  }

  .tooltip.error .tooltip-content {
    border-color: rgba(255, 107, 107, 0.3);
    background: linear-gradient(145deg, rgba(35, 18, 22, 0.98) 0%, rgba(25, 15, 18, 0.99) 100%);
  }

  .tooltip.has-errors .tooltip-content {
    max-width: 380px;
  }

  /* ═══ Tooltip Header ═══ */

  .tooltip-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }

  /* Status dot inside the tooltip header */
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--color-text-muted);
    flex-shrink: 0;
    transition: all 0.3s var(--ease-spring);
  }

  .status-dot.synced {
    background: var(--color-green);
    box-shadow: 0 0 8px rgba(38, 222, 129, 0.5);
  }

  .status-dot.syncing {
    background: var(--color-primary);
    box-shadow: 0 0 8px var(--color-primary-glow);
    animation: dotPulse 1s ease-in-out infinite;
  }

  @keyframes dotPulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.6;
      transform: scale(0.85);
    }
  }

  .status-dot.error {
    background: var(--color-red);
    box-shadow: 0 0 8px rgba(255, 107, 107, 0.5);
  }

  .status-dot.pending {
    background: var(--color-primary);
    box-shadow: 0 0 8px var(--color-primary-glow);
  }

  .status-dot.offline {
    background: var(--color-yellow);
    box-shadow: 0 0 8px rgba(255, 217, 61, 0.5);
  }

  .status-label {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--color-text);
    letter-spacing: -0.01em;
  }

  .last-sync {
    margin-left: auto;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--color-text-muted);
    opacity: 0.7;
  }

  /* ═══ Realtime Badge (in tooltip) ═══ */

  .realtime-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    background: rgba(100, 100, 120, 0.2);
    color: var(--color-text-muted);
    transition: all 0.4s var(--ease-spring);
  }

  .realtime-badge.live {
    background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(52, 211, 153, 0.1) 100%);
    color: #34d399;
    box-shadow: 0 0 12px rgba(16, 185, 129, 0.15);
  }

  .realtime-badge.connecting {
    background: rgba(99, 102, 241, 0.15);
    color: #a5b4fc;
  }

  .realtime-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #10b981;
    animation: realtimeDotPulse 1.5s ease-in-out infinite;
  }

  @keyframes realtimeDotPulse {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.6;
      transform: scale(0.85);
    }
  }

  /* ═══ Tooltip Description ═══ */

  .tooltip-description {
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--color-text-muted);
    margin: 0;
  }

  .tooltip.error .tooltip-description {
    color: rgba(255, 150, 150, 0.9);
  }

  /* ═══ Tooltip Action Hint ═══ */

  .tooltip-action {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid rgba(108, 92, 231, 0.15);
  }

  .tooltip.error .tooltip-action {
    border-top-color: rgba(255, 107, 107, 0.2);
  }

  .action-hint {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--color-primary-light);
    letter-spacing: 0.01em;
  }

  .tooltip.error .action-hint {
    color: rgba(255, 150, 150, 0.9);
  }

  .tooltip-action svg {
    color: var(--color-primary-light);
    opacity: 0.7;
  }

  .tooltip.error .tooltip-action svg {
    color: rgba(255, 150, 150, 0.9);
  }

  /* ═══ Error Details Panel ═══ */

  .details-toggle {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 10px;
    padding: 6px 10px;
    background: rgba(255, 107, 107, 0.1);
    border: 1px solid rgba(255, 107, 107, 0.2);
    border-radius: 8px;
    font-size: 0.75rem;
    font-weight: 600;
    color: rgba(255, 150, 150, 0.9);
    cursor: pointer;
    transition: all 0.2s;
    width: 100%;
    justify-content: center;
  }

  .details-toggle:hover {
    background: rgba(255, 107, 107, 0.15);
    border-color: rgba(255, 107, 107, 0.3);
    color: rgba(255, 180, 180, 1);
  }

  .chevron {
    transition: transform 0.2s var(--ease-out);
  }

  .chevron.expanded {
    transform: rotate(180deg);
  }

  .error-details-panel {
    margin-top: 10px;
    animation: detailsSlideIn 0.25s var(--ease-out);
  }

  @keyframes detailsSlideIn {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* ═══ Error List (scrollable) ═══ */

  .error-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 200px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .error-list::-webkit-scrollbar {
    width: 4px;
  }

  .error-list::-webkit-scrollbar-track {
    background: rgba(255, 255, 255, 0.05);
    border-radius: 2px;
  }

  .error-list::-webkit-scrollbar-thumb {
    background: rgba(255, 107, 107, 0.3);
    border-radius: 2px;
  }

  /* ═══ Individual Error Card ═══ */

  .error-item {
    padding: 10px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 107, 107, 0.15);
    border-radius: 10px;
    animation: errorItemFadeIn 0.3s var(--ease-out) backwards;
  }

  @keyframes errorItemFadeIn {
    from {
      opacity: 0;
      transform: translateX(-8px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .error-item-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }

  .error-operation {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 4px;
  }

  .error-table {
    font-size: 0.75rem;
    font-weight: 600;
    color: rgba(255, 200, 200, 0.9);
  }

  .error-message {
    margin-bottom: 6px;
  }

  .error-message code {
    display: block;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.6875rem;
    line-height: 1.5;
    color: rgba(255, 180, 180, 0.95);
    word-break: break-word;
    white-space: pre-wrap;
    padding: 6px 8px;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 6px;
    border-left: 2px solid rgba(255, 107, 107, 0.4);
  }

  .error-meta {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .error-entity {
    font-size: 0.625rem;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    color: rgba(255, 150, 150, 0.6);
    cursor: help;
  }

  /* ═══ Error Fallback (raw text) ═══ */

  .error-fallback {
    padding: 10px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 107, 107, 0.2);
    border-radius: 8px;
  }

  .error-fallback code {
    display: block;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.6875rem;
    line-height: 1.5;
    color: rgba(255, 180, 180, 0.9);
    word-break: break-word;
    white-space: pre-wrap;
  }

  /* ═══ Mobile Adjustments ═══ */

  @media (max-width: 640px) {
    .sync-indicator {
      width: 40px;
      height: 40px;
    }

    .tooltip {
      right: -8px;
      min-width: 280px;
    }

    .tooltip.has-errors {
      min-width: 300px;
      max-width: calc(100vw - 32px);
    }

    .tooltip-arrow {
      right: 20px;
    }

    .tooltip-content {
      padding: 12px 14px;
    }

    .error-list {
      max-height: 160px;
    }
  }

  /* ═══ Reduced Motion ═══ */

  @media (prefers-reduced-motion: reduce) {
    .tooltip {
      animation: none;
    }

    .status-dot.syncing {
      animation: none;
    }

    .sync-indicator.syncing .indicator-ring,
    .sync-indicator.synced .indicator-ring,
    .sync-indicator.error .indicator-ring,
    .sync-indicator.pending .indicator-ring,
    .sync-indicator.offline .indicator-ring {
      animation: none;
    }

    .icon-syncing.active {
      animation: none;
    }

    .icon-synced.morph-in,
    .icon-error.morph-in {
      animation: none;
    }

    .indicator-core.transitioning {
      animation: none;
    }

    .icon {
      transition: opacity 0.2s ease;
      transform: scale(1) rotate(0deg);
    }

    .icon.active {
      transform: scale(1) rotate(0deg);
    }

    .error-item {
      animation: none;
    }

    .error-details-panel {
      animation: none;
    }

    .live-indicator {
      transition: opacity 0.2s ease;
      transform: scale(1) rotate(0deg);
    }

    .live-indicator.transitioning {
      animation: none;
    }

    .live-dot,
    .live-ring,
    .realtime-dot {
      animation: none;
    }
  }
</style>
