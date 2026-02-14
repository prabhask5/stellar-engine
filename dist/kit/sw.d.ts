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
 * import { monitorSwLifecycle, handleSwUpdate } from 'stellar-engine/kit/sw';
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
export declare function pollForNewServiceWorker(options?: PollOptions): () => void;
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
export declare function handleSwUpdate(): Promise<void>;
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
export declare function monitorSwLifecycle(callbacks: SwLifecycleCallbacks): () => void;
//# sourceMappingURL=sw.d.ts.map