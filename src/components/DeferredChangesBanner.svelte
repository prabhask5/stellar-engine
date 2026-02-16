<script lang="ts">
  /**
   * @fileoverview DeferredChangesBanner — notification banner for cross-device data conflicts.
   *
   * When another device pushes a change to an entity (e.g. a goal or project) via
   * realtime sync, but the user is currently editing that entity, this banner
   * appears to let them choose:
   *   - **Update** — overwrite local form state with the remote values
   *   - **Dismiss** — keep local edits and discard the remote notification
   *   - **Show/Hide changes** — expand a diff preview showing field-by-field
   *     old → new values
   *
   * The banner polls `remoteChangesStore` every 500ms to detect deferred changes,
   * and uses a CSS `grid-template-rows` transition for smooth expand/collapse.
   */

  // =============================================================================
  //  Imports
  // =============================================================================

  import { remoteChangesStore } from 'stellar-drive/stores';
  import { onMount, onDestroy } from 'svelte';

  // =============================================================================
  //  Props Interface
  // =============================================================================

  interface Props {
    /** Unique identifier of the entity being edited */
    entityId: string;
    /** Entity collection name (e.g. `'goals'`, `'projects'`) */
    entityType: string;
    /** Remote (latest) data snapshot — `null` when no diff exists */
    remoteData: Record<string, unknown> | null;
    /** Current local form data to compare against */
    localData: Record<string, unknown>;
    /** Map of field keys → human-readable labels (e.g. `{ name: 'Name' }`) */
    fieldLabels: Record<string, string>;
    /** Optional custom formatter for display values — receives `(fieldKey, rawValue)` */
    formatValue?: (field: string, value: unknown) => string;
    /** Callback to apply the remote data into the local form */
    onLoadRemote: () => void;
    /** Callback to silently discard the remote notification */
    onDismiss: () => void;
  }

  // =============================================================================
  //  Component State
  // =============================================================================

  let {
    entityId,
    entityType,
    remoteData,
    localData,
    fieldLabels,
    formatValue,
    onLoadRemote,
    onDismiss
  }: Props = $props();

  /** Controls the banner's visibility (drives CSS transition) */
  let showBanner = $state(false);

  /** Whether the diff-preview section is expanded */
  let showPreview = $state(false);

  /** Interval handle for polling deferred changes */
  let checkInterval: ReturnType<typeof setInterval> | null = null;

  // =============================================================================
  //  Diff Calculation
  // =============================================================================

  /** Shape of a single field difference */
  interface FieldDiff {
    field: string;
    label: string;
    oldValue: string;
    newValue: string;
  }

  /**
   * Computes an array of `FieldDiff` objects by comparing `localData` against
   * `remoteData` for every key listed in `fieldLabels`. Uses JSON.stringify
   * for deep equality (handles arrays, nested objects).
   */
  const diffs = $derived.by(() => {
    if (!remoteData) return [] as FieldDiff[];
    const result: FieldDiff[] = [];
    for (const [field, label] of Object.entries(fieldLabels)) {
      const local = localData[field];
      const remote = remoteData[field];
      if (remote !== undefined && JSON.stringify(local) !== JSON.stringify(remote)) {
        const fmt = formatValue || defaultFormat;
        result.push({
          field,
          label,
          oldValue: fmt(field, local),
          newValue: fmt(field, remote)
        });
      }
    }
    return result;
  });

  // =============================================================================
  //  Utility Functions
  // =============================================================================

  /**
   * Default value formatter — converts booleans, nulls, arrays, and
   * other types to human-readable strings.
   *
   * @param {string}  _field — the field key (unused in default formatter)
   * @param {unknown} value  — the raw field value
   * @returns {string} formatted string representation
   */
  function defaultFormat(_field: string, value: unknown): string {
    if (typeof value === 'boolean') return value ? 'On' : 'Off';
    if (value === null || value === undefined) return 'None';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  }

  /**
   * Checks the remote changes store for deferred changes targeting this entity.
   * Shows the banner if changes are found.
   */
  function checkDeferred() {
    const has = remoteChangesStore.hasDeferredChanges(entityId, entityType);
    if (has && !showBanner) {
      showBanner = true;
    }
  }

  // =============================================================================
  //  Lifecycle
  // =============================================================================

  onMount(() => {
    checkDeferred();
    /* Poll every 500ms — lightweight check against in-memory store */
    checkInterval = setInterval(checkDeferred, 500);
  });

  onDestroy(() => {
    if (checkInterval) clearInterval(checkInterval);
  });

  // =============================================================================
  //  Action Handlers
  // =============================================================================

  /**
   * Applies remote data into the form and clears the deferred-change
   * record so polling does not re-show the banner.
   */
  function handleLoadRemote() {
    remoteChangesStore.clearDeferredChanges(entityId, entityType);
    showBanner = false;
    showPreview = false;
    onLoadRemote();
  }

  /**
   * Silently dismisses the banner and clears the deferred-change record.
   */
  function handleDismiss() {
    remoteChangesStore.clearDeferredChanges(entityId, entityType);
    showBanner = false;
    showPreview = false;
    onDismiss();
  }
</script>

<!-- Always rendered; CSS controls visibility via grid-template-rows transition -->
<div class="deferred-banner-wrapper" class:show={showBanner}>
  <div class="deferred-banner">
    <!-- ═══ Banner Header ═══ -->
    <div class="banner-header">
      <span class="banner-icon">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          width="16"
          height="16"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </span>
      <span class="banner-text">Changes were made on another device</span>
    </div>

    <!-- ═══ Banner Actions ═══ -->
    <div class="banner-actions">
      <button class="banner-btn update-btn" onclick={handleLoadRemote} type="button">
        Update
      </button>
      <button class="banner-btn dismiss-btn" onclick={handleDismiss} type="button">
        Dismiss
      </button>
      <!-- Toggle to show/hide field-by-field diff preview -->
      {#if diffs.length > 0}
        <button class="toggle-preview" onclick={() => (showPreview = !showPreview)} type="button">
          {showPreview ? 'Hide' : 'Show'} changes
          <svg
            class="chevron"
            class:expanded={showPreview}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            width="14"
            height="14"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      {/if}
    </div>

    <!-- ═══ Diff Preview (expandable) ═══ -->
    {#if showPreview && diffs.length > 0}
      <div class="diff-preview">
        {#each diffs as diff (diff.label)}
          <div class="diff-row">
            <span class="diff-label">{diff.label}:</span>
            <span class="diff-old">{diff.oldValue}</span>
            <span class="diff-arrow">&rarr;</span>
            <span class="diff-new">{diff.newValue}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  /* ═══ Banner Wrapper (animated visibility) ═══ */

  /*
   * Uses `grid-template-rows: 0fr → 1fr` for smooth height animation.
   * This avoids the need for explicit height values or JS measurement.
   */
  .deferred-banner-wrapper {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows 0.4s var(--ease-spring),
      opacity 0.3s var(--ease-out);
  }

  .deferred-banner-wrapper.show {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  /* Overflow hidden on the inner element enables the grid-row trick */
  .deferred-banner-wrapper > .deferred-banner {
    overflow: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    .deferred-banner-wrapper {
      transition: none;
    }
  }

  /* ═══ Banner Container ═══ */

  .deferred-banner {
    background: linear-gradient(135deg, rgba(255, 165, 2, 0.12) 0%, rgba(255, 165, 2, 0.06) 100%);
    border: 1px solid rgba(255, 165, 2, 0.3);
    border-radius: var(--radius-lg);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    animation: bannerGlow 3s ease-in-out infinite;
  }

  /* Subtle pulsing glow to draw attention */
  @keyframes bannerGlow {
    0%,
    100% {
      box-shadow: 0 0 8px rgba(255, 165, 2, 0.15);
    }
    50% {
      box-shadow: 0 0 16px rgba(255, 165, 2, 0.25);
    }
  }

  /* ═══ Header ═══ */

  .banner-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .banner-icon {
    color: var(--color-orange);
    flex-shrink: 0;
    display: flex;
    align-items: center;
  }

  .banner-text {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--color-orange);
    white-space: nowrap;
  }

  /* ═══ Actions Row ═══ */

  .banner-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  /* "Show changes" toggle — pushed to the right via `margin-left: auto` */
  .toggle-preview {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--color-text-muted);
    background: none;
    border: none;
    padding: 0.125rem 0.375rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color 0.2s;
    white-space: nowrap;
    margin-left: auto;
  }

  .toggle-preview:hover {
    color: var(--color-text);
  }

  /* Chevron rotates 180deg when expanded */
  .chevron {
    transition: transform 0.2s var(--ease-smooth);
  }

  .chevron.expanded {
    transform: rotate(180deg);
  }

  /* ═══ Action Buttons ═══ */

  .banner-btn {
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: all 0.2s var(--ease-smooth);
    border: none;
    white-space: nowrap;
  }

  /* Update button — orange theme to match the warning banner */
  .update-btn {
    background: rgba(255, 165, 2, 0.2);
    color: var(--color-orange);
    border: 1px solid rgba(255, 165, 2, 0.3);
  }

  .update-btn:hover {
    background: rgba(255, 165, 2, 0.3);
    box-shadow: 0 0 12px rgba(255, 165, 2, 0.2);
  }

  /* Dismiss button — neutral / muted */
  .dismiss-btn {
    background: rgba(255, 255, 255, 0.05);
    color: var(--color-text-muted);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .dismiss-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--color-text);
  }

  /* ═══ Diff Preview ═══ */

  .diff-preview {
    margin-top: 0.625rem;
    padding-top: 0.625rem;
    border-top: 1px solid rgba(255, 165, 2, 0.15);
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .diff-row {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    flex-wrap: wrap;
  }

  .diff-label {
    color: var(--color-text-secondary);
    font-weight: 600;
  }

  /* Strikethrough on old value to visually indicate replacement */
  .diff-old {
    color: var(--color-text-muted);
    text-decoration: line-through;
    opacity: 0.7;
  }

  .diff-arrow {
    color: var(--color-text-muted);
    font-size: 0.625rem;
  }

  /* New value highlighted in orange to match the banner theme */
  .diff-new {
    color: var(--color-orange);
    font-weight: 600;
  }

  /* ═══ Mobile Responsive ═══ */

  @media (max-width: 480px) {
    .deferred-banner {
      padding: 0.5rem 0.75rem;
    }

    .banner-header {
      margin-bottom: 0.125rem;
    }

    .banner-actions {
      flex-wrap: wrap;
      gap: 0.375rem;
      margin-top: 0.375rem;
    }

    .banner-btn {
      text-align: center;
    }

    /* Full-width toggle on mobile for easier tap target */
    .toggle-preview {
      flex-basis: 100%;
      justify-content: center;
      margin-left: 0;
      padding: 0.25rem 0;
    }
  }

  /* ═══ Tablet ═══ */

  @media (min-width: 481px) and (max-width: 900px) {
    .deferred-banner {
      padding: 0.625rem 0.875rem;
    }
  }
</style>
