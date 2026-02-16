/**
 * @fileoverview Service worker lifecycle helpers.
 *
 * This module extracts SW monitoring and update logic so components and pages
 * can use clean APIs without duplicating browser-specific service worker code.
 * It provides three main functions:
 *
 *   - `pollForNewServiceWorker` — active polling for a new SW after a
 *     deployment, useful for "checking for updates..." UI flows
 *   - `handleSwUpdate`         — triggers `SKIP_WAITING` on a waiting SW
 *     and reloads the page when the new controller activates
 *   - `monitorSwLifecycle`     — comprehensive passive monitoring that covers
 *     six different detection strategies for maximum reliability across
 *     browsers and platforms (including iOS PWA quirks)
 *
 * All functions include SSR guards (`typeof navigator === 'undefined'`) so
 * they can be safely imported in universal (shared) SvelteKit code without
 * causing server-side errors.
 *
 * @module kit/sw
 *
 * @example
 * ```ts
 * // In a Svelte component
 * import { monitorSwLifecycle, handleSwUpdate } from 'stellar-drive/kit/sw';
 *
 * let showBanner = $state(false);
 * const cleanup = monitorSwLifecycle({
 *   onUpdateAvailable: () => { showBanner = true; }
 * });
 * // When user clicks "Update Now":
 * await handleSwUpdate();
 * ```
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API}
 * @see {@link debug} in `debug.ts` for the logging utility used throughout
 */

import { debug } from '../debug.js';

// =============================================================================
//  TYPES
// =============================================================================

/**
 * Options for `pollForNewServiceWorker`.
 *
 * All fields are optional with sensible defaults for typical deployment
 * detection scenarios.
 */
export interface PollOptions {
  /**
   * Polling interval in milliseconds.
   * @default 5000
   */
  intervalMs?: number;

  /**
   * Maximum number of polling attempts before giving up.
   * With the default interval of 5s and 60 attempts, polling runs for ~5 minutes.
   * @default 60
   */
  maxAttempts?: number;

  /**
   * Callback invoked when a new service worker is detected in the
   * `waiting` state. Called exactly once, then polling stops automatically.
   */
  onFound?: () => void;
}

/**
 * Callbacks for `monitorSwLifecycle`.
 *
 * Provides hooks into the service worker lifecycle events that the
 * monitoring system detects.
 */
export interface SwLifecycleCallbacks {
  /**
   * Called whenever an update-available condition is detected through
   * any of the six monitoring strategies. May be called multiple times
   * if different strategies detect the same update independently.
   */
  onUpdateAvailable: () => void;
}

// =============================================================================
//  PUBLIC API
// =============================================================================

/**
 * Polls `registration.update()` until a new service worker is detected
 * in the `waiting` state. Useful after triggering a deployment to detect
 * when the new build is live and ready to activate.
 *
 * The polling loop calls `registration.update()` on each tick, which
 * forces the browser to check the server for a new SW script. When a
 * waiting worker is found, the `onFound` callback fires and polling
 * stops automatically.
 *
 * @param options - Optional configuration for interval, max attempts,
 *                  and the detection callback.
 *
 * @returns A cleanup function that stops polling when called. Useful
 *          for cleanup in Svelte's `onDestroy` or `$effect` teardown.
 *
 * @example
 * ```ts
 * const stopPolling = pollForNewServiceWorker({
 *   intervalMs: 3000,
 *   maxAttempts: 100,
 *   onFound: () => showUpdateBanner()
 * });
 *
 * // Later, to stop polling early:
 * stopPolling();
 * ```
 *
 * @see {@link handleSwUpdate} for activating the waiting SW once found
 */
export function pollForNewServiceWorker(options?: PollOptions): () => void {
  const intervalMs = options?.intervalMs ?? 5000;
  const maxAttempts = options?.maxAttempts ?? 60;
  let attempts = 0;
  let stopped = false;

  const poll = async () => {
    /* SSR guard — service workers don't exist on the server */
    if (stopped || typeof navigator === 'undefined' || !navigator.serviceWorker) return;

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        /* Force the browser to check the server for a newer SW script;
           without this call the browser would only check on navigation. */
        await registration.update();
        if (registration.waiting) {
          debug('log', '[SW] New service worker found in waiting state');
          options?.onFound?.();
          stopped = true;
          return;
        }
      }
    } catch {
      /* update() can throw if offline — silently retry on next tick */
    }

    attempts++;
    if (attempts < maxAttempts && !stopped) {
      setTimeout(poll, intervalMs);
    }
  };

  poll();
  return () => {
    stopped = true;
  };
}

/**
 * Sends `SKIP_WAITING` to the waiting service worker, listens for the
 * `controllerchange` event, then reloads the page to activate the new
 * version.
 *
 * If no waiting worker is found (e.g. the update was already applied),
 * falls back to a simple page reload. The `{ once: true }` listener
 * option acts as a double-reload guard — the handler fires exactly once
 * even if `controllerchange` is emitted multiple times during activation.
 *
 * @returns A promise that resolves just before the page reloads.
 *          In practice, the caller won't observe the resolution since
 *          `window.location.reload()` interrupts execution.
 *
 * @example
 * ```ts
 * // In an "Update Now" button handler
 * async function onUpdateClick() {
 *   await handleSwUpdate();
 *   // Page will have reloaded by this point
 * }
 * ```
 *
 * @see {@link pollForNewServiceWorker} for detecting when an update is available
 * @see {@link monitorSwLifecycle} for passive update detection
 */
export async function handleSwUpdate(): Promise<void> {
  /* SSR guard — no service worker API on the server */
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;

  const registration = await navigator.serviceWorker.getRegistration();
  if (registration?.waiting) {
    /* Listen for the moment the new SW takes control — this fires after
       the waiting worker calls `self.skipWaiting()` and becomes active. */
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        window.location.reload();
      },
      { once: true }
    );

    /* Tell the waiting SW to skip the waiting phase and activate immediately */
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  } else {
    /* No waiting worker — the update may have already been applied;
       reload to pick up any cached asset changes. */
    window.location.reload();
  }
}

/**
 * Comprehensive service worker monitoring covering all detection strategies
 * for maximum reliability across browsers and platforms:
 *
 *   1. **Immediate check** — inspects the current registration for a
 *      waiting worker right away
 *   2. **Delayed retries at 1s/3s** — iOS PWA sometimes needs extra time
 *      after app launch before the SW registration is fully populated
 *   3. **`SW_INSTALLED` message listener** — listens for a custom message
 *      from the SW itself, posted after the `install` event completes
 *   4. **`updatefound` + `statechange` tracking** — monitors the standard
 *      SW lifecycle events for newly installing workers
 *   5. **`visibilitychange` re-check** — triggers an update check when the
 *      app resumes from the background (critical for iOS PWA resume)
 *   6. **2-minute polling interval** — periodic fallback for long-running
 *      sessions where none of the event-based strategies would fire
 *
 * @param callbacks - Object containing the `onUpdateAvailable` callback,
 *                    which fires whenever any strategy detects a waiting
 *                    service worker.
 *
 * @returns A cleanup function that removes all event listeners, clears all
 *          intervals and timeouts, and stops monitoring. Should be called
 *          in Svelte's `onDestroy` or `$effect` teardown to prevent leaks.
 *
 * @example
 * ```ts
 * // In a Svelte component's $effect
 * $effect(() => {
 *   const cleanup = monitorSwLifecycle({
 *     onUpdateAvailable: () => {
 *       updateAvailable = true;
 *     }
 *   });
 *   return cleanup;
 * });
 * ```
 *
 * @see {@link handleSwUpdate} for activating the detected update
 * @see {@link SwLifecycleCallbacks} for the callback interface
 */
export function monitorSwLifecycle(callbacks: SwLifecycleCallbacks): () => void {
  /* SSR guard — return a no-op cleanup if not in a browser context */
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    return () => {};
  }

  /* Collect all async handles so the cleanup function can tear down
     everything in one pass — prevents memory leaks in SPA navigation. */
  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const cleanups: (() => void)[] = [];

  /**
   * Checks whether a waiting service worker exists on the current
   * registration and fires the callback if found.
   *
   * This is the core detection primitive used by multiple strategies.
   */
  function checkForWaitingWorker() {
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration?.waiting) {
        debug('log', '[SW] Found waiting service worker');
        callbacks.onUpdateAvailable();
      }
    });
  }

  // ---------------------------------------------------------------------------
  //  Strategy 1 — Immediate check
  // ---------------------------------------------------------------------------
  checkForWaitingWorker();

  // ---------------------------------------------------------------------------
  //  Strategy 2 — Delayed retries (iOS PWA quirk)
  // ---------------------------------------------------------------------------
  /* iOS PWA sometimes reports no waiting worker immediately after launch
     but finds one after a brief delay — 1s and 3s cover the typical range. */
  timeouts.push(setTimeout(checkForWaitingWorker, 1000));
  timeouts.push(setTimeout(checkForWaitingWorker, 3000));

  // ---------------------------------------------------------------------------
  //  Strategy 3 — SW_INSTALLED message listener
  // ---------------------------------------------------------------------------
  /* The service worker can post a custom 'SW_INSTALLED' message after its
     install event completes — this is the fastest path for detecting a
     new SW that was installed while the page was already open. */
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === 'SW_INSTALLED') {
      debug('log', '[SW] Received SW_INSTALLED message');
      /* Small delay to ensure the SW has transitioned to 'waiting' state
         before we check — the message fires during install, but the
         waiting state is set shortly after. */
      timeouts.push(setTimeout(checkForWaitingWorker, 500));
    }
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  cleanups.push(() => navigator.serviceWorker.removeEventListener('message', onMessage));

  // ---------------------------------------------------------------------------
  //  Strategy 4 — updatefound + statechange tracking
  // ---------------------------------------------------------------------------
  /* Standard SW lifecycle: when the browser detects a new SW script,
     it fires 'updatefound' on the registration. We then track the
     installing worker's state changes until it reaches 'installed'. */
  navigator.serviceWorker.ready.then((registration) => {
    if (registration.waiting) {
      debug('log', '[SW] Waiting worker found on ready');
      callbacks.onUpdateAvailable();
    }

    const onUpdateFound = () => {
      debug('log', '[SW] Update found');
      const newWorker = registration.installing;
      if (newWorker) {
        const onStateChange = () => {
          debug('log', '[SW] New worker state:', newWorker.state);
          /* Only fire when the new SW is 'installed' AND there's already
             an active controller — this means it's a true update, not
             the very first SW installation. */
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            callbacks.onUpdateAvailable();
          }
        };
        newWorker.addEventListener('statechange', onStateChange);
      }
    };
    registration.addEventListener('updatefound', onUpdateFound);
  });

  // ---------------------------------------------------------------------------
  //  Strategy 5 — visibilitychange re-check
  // ---------------------------------------------------------------------------
  /* When the app resumes from the background (especially on iOS PWA where
     the SW may have been terminated), trigger a fresh update check. */
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      debug('log', '[SW] App became visible, checking for updates');
      navigator.serviceWorker.ready.then((registration) => {
        registration.update();
      });
      timeouts.push(setTimeout(checkForWaitingWorker, 1000));
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibilityChange));

  // ---------------------------------------------------------------------------
  //  Strategy 6 — Periodic polling (2-minute interval)
  // ---------------------------------------------------------------------------
  /* Long-running sessions may miss event-based updates if the user never
     navigates or switches tabs. A 2-minute poll is a lightweight fallback. */
  const pollInterval = setInterval(
    () => {
      navigator.serviceWorker.ready.then((registration) => {
        registration.update();
      });
    },
    2 * 60 * 1000
  );
  intervals.push(pollInterval);

  /* Force an update check on initial setup — ensures the browser has the
     latest SW script knowledge from the very start of monitoring. */
  navigator.serviceWorker.ready.then((registration) => {
    registration.update();
  });

  // ---------------------------------------------------------------------------
  //  Cleanup — tear down all listeners, intervals, and timeouts
  // ---------------------------------------------------------------------------
  return () => {
    for (const interval of intervals) clearInterval(interval);
    for (const timeout of timeouts) clearTimeout(timeout);
    for (const cleanup of cleanups) cleanup();
  };
}
