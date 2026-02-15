/**
 * @fileoverview Network Connectivity Store
 *
 * Provides a reactive boolean store (`isOnline`) that tracks whether the browser
 * currently has network connectivity. Components subscribe to this store to
 * conditionally enable/disable features that require a network connection
 * (e.g., sync, realtime subscriptions, remote API calls).
 *
 * **Svelte Store Pattern:**
 * Uses a custom writable store that exposes the standard `subscribe` method
 * (making it a valid Svelte `Readable<boolean>`) plus imperative methods for
 * initialization and callback registration. The store value is a simple boolean:
 * `true` = online, `false` = offline.
 *
 * **Reactive Architecture:**
 * The store listens to three browser events for comprehensive coverage:
 *   1. `online` / `offline` - Standard connectivity events (works on desktop browsers)
 *   2. `visibilitychange` - Catches iOS PWA edge cases where online/offline events
 *      do not fire reliably when the app returns from background
 *
 * Registered callbacks (via `onReconnect` / `onDisconnect`) are executed sequentially
 * to ensure ordering guarantees (e.g., auth validation must complete before sync).
 *
 * @see {@link ./sync} for the sync store that depends on network state
 * @see {@link ./authState} for auth state that may need revalidation on reconnect
 */
import { writable } from 'svelte/store';
const browser = typeof window !== 'undefined';
import { debugError, debugLog } from '../debug';
// =============================================================================
// Store Factory
// =============================================================================
/**
 * Creates the singleton network connectivity store.
 *
 * The store must be explicitly initialized via `init()` to attach browser event
 * listeners. This is intentional: it allows server-side rendering (SSR) contexts
 * to import the store without triggering browser API calls.
 *
 * @returns A Svelte-readable boolean store extended with `init`, `onReconnect`,
 *          and `onDisconnect` methods
 *
 * @example
 * ```ts
 * // During app initialization:
 * isOnline.init();
 *
 * // Register a reconnect handler (returns an unsubscribe function):
 * const unsub = isOnline.onReconnect(async () => {
 *   await revalidateAuth();
 *   await triggerSync();
 * });
 *
 * // In a Svelte component:
 * $: if ($isOnline) { enableRealtimeFeatures(); }
 * ```
 */
function createNetworkStore() {
    const { subscribe, set } = writable(true);
    /** Set of callbacks to invoke when connectivity is restored */
    const reconnectCallbacks = new Set();
    /** Set of callbacks to invoke when connectivity is lost */
    const disconnectCallbacks = new Set();
    /** Tracks whether we were offline so reconnect callbacks only fire on actual transitions */
    let wasOffline = false;
    /** Tracks current value to prevent redundant store updates and re-renders */
    let currentValue = true;
    /** Guards against double-initialization (e.g., HMR in development) */
    let initialized = false;
    /**
     * Guards against duplicate reconnect callback invocations.
     * iOS PWAs can fire both `online` and `visibilitychange` events simultaneously
     * when returning from background, which would otherwise trigger reconnect
     * callbacks twice.
     */
    let reconnectPending = false;
    // ---------------------------------------------------------------------------
    // Internal Helpers
    // ---------------------------------------------------------------------------
    /**
     * Conditionally updates the store value only when it actually changes.
     * Prevents unnecessary Svelte re-renders for redundant state transitions.
     *
     * @param value - The new online/offline boolean state
     */
    function setIfChanged(value) {
        if (value !== currentValue) {
            currentValue = value;
            set(value);
        }
    }
    /**
     * Executes a set of callbacks one-by-one, awaiting each before proceeding.
     *
     * Sequential execution is critical here: for example, the auth revalidation
     * callback must complete before the sync callback fires, since sync depends
     * on a valid session token.
     *
     * @param callbacks - The set of callbacks to execute in registration order
     * @param label - A human-readable label for error logging (e.g., 'Reconnect', 'Disconnect')
     */
    async function runCallbacksSequentially(callbacks, label) {
        for (const callback of callbacks) {
            try {
                await callback();
            }
            catch (e) {
                debugError(`[Network] ${label} callback error:`, e);
            }
        }
    }
    // ---------------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------------
    /**
     * Attach browser event listeners for connectivity tracking.
     *
     * Must be called once during app startup (client-side only). Subsequent
     * calls are no-ops to ensure idempotency.
     *
     * @see {@link createNetworkStore} for the full lifecycle description
     */
    function init() {
        if (!browser)
            return;
        if (initialized)
            return; /* Idempotent - safe to call multiple times */
        initialized = true;
        /* Set initial state from the browser's navigator.onLine property */
        const initiallyOnline = navigator.onLine;
        currentValue = initiallyOnline;
        set(initiallyOnline);
        wasOffline = !initiallyOnline;
        // -------------------------------------------------------------------------
        // Event: Going Offline
        // -------------------------------------------------------------------------
        window.addEventListener('offline', () => {
            const wasOnline = currentValue;
            wasOffline = true;
            setIfChanged(false);
            /* Only fire disconnect callbacks on an actual online->offline transition */
            if (wasOnline) {
                runCallbacksSequentially(disconnectCallbacks, 'Disconnect');
            }
        });
        // -------------------------------------------------------------------------
        // Event: Coming Back Online
        // -------------------------------------------------------------------------
        window.addEventListener('online', () => {
            setIfChanged(true);
            /* Guard against duplicate firing (iOS PWA fires both online + visibilitychange) */
            if (wasOffline && reconnectPending) {
                debugLog('[Network] Reconnect suppressed: callback already pending (duplicate guard)');
            }
            if (wasOffline && !reconnectPending) {
                wasOffline = false;
                reconnectPending = true;
                /* Small delay (500ms) to ensure the network connection has stabilized
                 * before triggering potentially expensive operations like sync */
                setTimeout(() => {
                    reconnectPending = false;
                    runCallbacksSequentially(reconnectCallbacks, 'Reconnect');
                }, 500);
            }
        });
        // -------------------------------------------------------------------------
        // Event: Visibility Change (iOS PWA Workaround)
        // -------------------------------------------------------------------------
        /* iOS PWAs often do not fire online/offline events when the app is
         * backgrounded and resumed. The visibilitychange event catches these
         * cases and ensures the store reflects the actual connectivity state. */
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                const nowOnline = navigator.onLine;
                setIfChanged(nowOnline); /* Only triggers a store update if value actually changed */
                /* If we're coming back online after being hidden (guard against duplicate firing) */
                if (nowOnline && wasOffline && reconnectPending) {
                    debugLog('[Network] Visibility reconnect suppressed: callback already pending (duplicate guard)');
                }
                if (nowOnline && wasOffline && !reconnectPending) {
                    wasOffline = false;
                    reconnectPending = true;
                    setTimeout(() => {
                        reconnectPending = false;
                        runCallbacksSequentially(reconnectCallbacks, 'Reconnect');
                    }, 500);
                }
            }
            else {
                /* When going to background, conservatively mark as potentially offline
                 * so that reconnect callbacks fire if needed when the tab becomes visible again */
                wasOffline = !navigator.onLine;
            }
        });
    }
    /**
     * Register a callback to be invoked when network connectivity is restored.
     *
     * Callbacks are executed sequentially in registration order and properly
     * awaited if async. Use this for operations that must happen on reconnect
     * (auth revalidation, sync trigger, realtime re-subscription).
     *
     * @param callback - The function to call on reconnect (may be sync or async)
     * @returns An unsubscribe function that removes the callback from the set
     *
     * @example
     * ```ts
     * const unsub = isOnline.onReconnect(async () => {
     *   await authState.revalidate();
     *   await syncEngine.pushPendingChanges();
     * });
     * // Later, to stop listening:
     * unsub();
     * ```
     */
    function onReconnect(callback) {
        reconnectCallbacks.add(callback);
        return () => reconnectCallbacks.delete(callback);
    }
    /**
     * Register a callback to be invoked when network connectivity is lost.
     *
     * Callbacks are executed sequentially in registration order and properly
     * awaited if async. Use this for graceful degradation (pausing sync,
     * switching to offline mode, showing offline indicators).
     *
     * @param callback - The function to call on disconnect (may be sync or async)
     * @returns An unsubscribe function that removes the callback from the set
     *
     * @example
     * ```ts
     * const unsub = isOnline.onDisconnect(() => {
     *   realtimeChannel.unsubscribe();
     *   showOfflineBanner();
     * });
     * ```
     */
    function onDisconnect(callback) {
        disconnectCallbacks.add(callback);
        return () => disconnectCallbacks.delete(callback);
    }
    return {
        subscribe,
        init,
        onReconnect,
        onDisconnect
    };
}
// =============================================================================
// Singleton Store Instance
// =============================================================================
/**
 * Singleton network connectivity store.
 *
 * Readable as a boolean (`true` = online, `false` = offline) and provides
 * methods for initialization and callback registration.
 *
 * @see {@link createNetworkStore} for implementation details
 */
export const isOnline = createNetworkStore();
//# sourceMappingURL=network.js.map