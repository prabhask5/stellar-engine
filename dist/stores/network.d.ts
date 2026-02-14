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
import { type Readable } from 'svelte/store';
/**
 * Callback function registered for network state transitions.
 * May be synchronous or asynchronous; async callbacks are properly awaited
 * before the next callback in the sequence executes.
 */
type NetworkCallback = () => void | Promise<void>;
/**
 * Singleton network connectivity store.
 *
 * Readable as a boolean (`true` = online, `false` = offline) and provides
 * methods for initialization and callback registration.
 *
 * @see {@link createNetworkStore} for implementation details
 */
export declare const isOnline: Readable<boolean> & {
    init: () => void;
    onReconnect: (callback: NetworkCallback) => () => void;
    onDisconnect: (callback: NetworkCallback) => () => void;
};
export {};
//# sourceMappingURL=network.d.ts.map