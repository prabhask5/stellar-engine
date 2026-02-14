/**
 * @fileoverview Service worker lifecycle helpers.
 *
 * Extracts SW monitoring and update logic so components and pages
 * can use clean APIs without duplicating browser-specific code.
 */
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
/**
 * Polls `registration.update()` until a new service worker is detected
 * in the waiting state. Useful after triggering a deployment to detect
 * when the new build is live.
 *
 * @returns A cleanup function that stops polling.
 */
export declare function pollForNewServiceWorker(options?: PollOptions): () => void;
/**
 * Sends `SKIP_WAITING` to the waiting service worker, listens for
 * `controllerchange`, then reloads the page. Includes a double-reload guard.
 */
export declare function handleSwUpdate(): Promise<void>;
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
export declare function monitorSwLifecycle(callbacks: SwLifecycleCallbacks): () => void;
//# sourceMappingURL=sw.d.ts.map