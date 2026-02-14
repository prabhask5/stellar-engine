/**
 * @fileoverview Service worker lifecycle helpers.
 *
 * Extracts SW monitoring and update logic so components and pages
 * can use clean APIs without duplicating browser-specific code.
 */

import { debug } from '../debug.js';

// =============================================================================
//  TYPES
// =============================================================================

/** Options for `pollForNewServiceWorker`. */
export interface PollOptions {
  /** Polling interval in milliseconds (default: 5000). */
  intervalMs?: number;
  /** Maximum number of polling attempts (default: 60). */
  maxAttempts?: number;
  /** Callback invoked when a new SW is detected in waiting state. */
  onFound?: () => void;
}

/** Callbacks for `monitorSwLifecycle`. */
export interface SwLifecycleCallbacks {
  /** Called whenever an update-available condition is detected. */
  onUpdateAvailable: () => void;
}

// =============================================================================
//  PUBLIC API
// =============================================================================

/**
 * Polls `registration.update()` until a new service worker is detected
 * in the waiting state. Useful after triggering a deployment to detect
 * when the new build is live.
 *
 * @returns A cleanup function that stops polling.
 */
export function pollForNewServiceWorker(options?: PollOptions): () => void {
  const intervalMs = options?.intervalMs ?? 5000;
  const maxAttempts = options?.maxAttempts ?? 60;
  let attempts = 0;
  let stopped = false;

  const poll = async () => {
    if (stopped || typeof navigator === 'undefined' || !navigator.serviceWorker) return;

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.update();
        if (registration.waiting) {
          debug('log', '[SW] New service worker found in waiting state');
          options?.onFound?.();
          stopped = true;
          return;
        }
      }
    } catch {
      // update() can throw if offline
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
 * Sends `SKIP_WAITING` to the waiting service worker, listens for
 * `controllerchange`, then reloads the page. Includes a double-reload guard.
 */
export async function handleSwUpdate(): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;

  const registration = await navigator.serviceWorker.getRegistration();
  if (registration?.waiting) {
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        window.location.reload();
      },
      { once: true }
    );

    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  } else {
    window.location.reload();
  }
}

/**
 * Comprehensive SW monitoring covering all detection strategies:
 *  1. Immediate check for waiting worker
 *  2. Delayed retries at 1s/3s (iOS PWA quirk)
 *  3. `SW_INSTALLED` message listener
 *  4. `updatefound` → `statechange` tracking
 *  5. `visibilitychange` re-check
 *  6. 2-minute polling interval
 *
 * @param callbacks - Object with `onUpdateAvailable` callback.
 * @returns A cleanup function that removes all listeners and intervals.
 */
export function monitorSwLifecycle(callbacks: SwLifecycleCallbacks): () => void {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    return () => {};
  }

  const intervals: ReturnType<typeof setInterval>[] = [];
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  const cleanups: (() => void)[] = [];

  function checkForWaitingWorker() {
    navigator.serviceWorker.getRegistration().then((registration) => {
      if (registration?.waiting) {
        debug('log', '[SW] Found waiting service worker');
        callbacks.onUpdateAvailable();
      }
    });
  }

  // Check immediately
  checkForWaitingWorker();

  // Retry after delays — iOS PWA sometimes needs extra time
  timeouts.push(setTimeout(checkForWaitingWorker, 1000));
  timeouts.push(setTimeout(checkForWaitingWorker, 3000));

  // Listen for messages from the service worker
  const onMessage = (event: MessageEvent) => {
    if (event.data?.type === 'SW_INSTALLED') {
      debug('log', '[SW] Received SW_INSTALLED message');
      timeouts.push(setTimeout(checkForWaitingWorker, 500));
    }
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  cleanups.push(() => navigator.serviceWorker.removeEventListener('message', onMessage));

  // Listen for new service worker becoming available
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
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            callbacks.onUpdateAvailable();
          }
        };
        newWorker.addEventListener('statechange', onStateChange);
      }
    };
    registration.addEventListener('updatefound', onUpdateFound);
  });

  // Re-check when app becomes visible — critical for iOS PWA resume
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

  // Periodic update check every 2 minutes
  const pollInterval = setInterval(
    () => {
      navigator.serviceWorker.ready.then((registration) => {
        registration.update();
      });
    },
    2 * 60 * 1000
  );
  intervals.push(pollInterval);

  // Force an update check on initial setup
  navigator.serviceWorker.ready.then((registration) => {
    registration.update();
  });

  // Return cleanup function
  return () => {
    for (const interval of intervals) clearInterval(interval);
    for (const timeout of timeouts) clearTimeout(timeout);
    for (const cleanup of cleanups) cleanup();
  };
}
