/**
 * @fileoverview Store Factory Functions
 *
 * Generic factory functions that create Svelte-compatible reactive stores for
 * common data-loading patterns. These eliminate the repetitive boilerplate that
 * every collection or detail store requires: loading state management,
 * sync-complete listener registration, and refresh logic.
 *
 * Both factories produce stores that follow the Svelte store contract
 * (`subscribe`/`unsubscribe`) and expose a read-only `loading` sub-store.
 *
 * @see {@link ../engine} for `onSyncComplete` lifecycle hook
 */
import { writable } from 'svelte/store';
import { onSyncComplete } from '../engine';
// =============================================================================
// Collection Store Factory
// =============================================================================
/**
 * Create a reactive collection store with built-in loading state and
 * sync-complete auto-refresh.
 *
 * The returned store follows the Svelte store contract and can be used with
 * the `$store` auto-subscription syntax. On the first `load()` call, a
 * sync-complete listener is registered so the collection automatically
 * refreshes whenever the sync engine completes a cycle.
 *
 * Uses `typeof window !== 'undefined'` for environment detection since
 * stellar-drive is a library (not tied to SvelteKit's `browser` export).
 *
 * @typeParam T - The entity type stored in the collection.
 * @param config - Configuration with a `load` function.
 * @returns A `CollectionStore<T>` instance.
 *
 * @example
 * ```ts
 * import { createCollectionStore } from 'stellar-drive/stores';
 *
 * const store = createCollectionStore<Task>({
 *   load: () => queryAll<Task>('tasks'),
 * });
 *
 * // In your component:
 * await store.load();
 * // $store is now Task[], $store.loading is boolean
 * ```
 */
export function createCollectionStore(config) {
    const { subscribe, set, update } = writable([]);
    const loading = writable(true);
    let syncUnsubscribe = null;
    return {
        subscribe,
        loading: { subscribe: loading.subscribe },
        async load() {
            loading.set(true);
            try {
                const data = await config.load();
                set(data);
                /* Register sync-complete listener once, only in the browser.
                   On each sync cycle, the collection auto-refreshes from local DB. */
                if (typeof window !== 'undefined' && !syncUnsubscribe) {
                    syncUnsubscribe = onSyncComplete(async () => {
                        const refreshed = await config.load();
                        set(refreshed);
                    });
                }
            }
            finally {
                loading.set(false);
            }
        },
        async refresh() {
            const data = await config.load();
            set(data);
        },
        set(data) {
            set(data);
        },
        mutate(fn) {
            update(fn);
        }
    };
}
// =============================================================================
// Detail Store Factory
// =============================================================================
/**
 * Create a reactive detail store for a single entity, with built-in loading
 * state, ID tracking, and sync-complete auto-refresh.
 *
 * The store tracks the currently loaded entity ID so that sync-complete
 * listeners can refresh the correct entity. Calling `load(id)` with a
 * different ID updates the tracked ID and fetches the new entity.
 *
 * @typeParam T - The entity type for the detail view.
 * @param config - Configuration with a `load` function that takes an entity ID.
 * @returns A `DetailStore<T>` instance.
 *
 * @example
 * ```ts
 * import { createDetailStore } from 'stellar-drive/stores';
 *
 * const store = createDetailStore<Task>({
 *   load: (id) => queryOne<Task>('tasks', id),
 * });
 *
 * // In your component:
 * await store.load(taskId);
 * // $store is now Task | null, $store.loading is boolean
 * ```
 */
export function createDetailStore(config) {
    const { subscribe, set, update } = writable(null);
    const loading = writable(true);
    let currentId = null;
    let syncUnsubscribe = null;
    return {
        subscribe,
        loading: { subscribe: loading.subscribe },
        async load(id) {
            currentId = id;
            loading.set(true);
            try {
                const data = await config.load(id);
                set(data);
                /* Register sync-complete listener once, only in the browser.
                   Uses the tracked `currentId` so it always refreshes the active entity. */
                if (typeof window !== 'undefined' && !syncUnsubscribe) {
                    syncUnsubscribe = onSyncComplete(async () => {
                        if (currentId) {
                            const refreshed = await config.load(currentId);
                            set(refreshed);
                        }
                    });
                }
            }
            finally {
                loading.set(false);
            }
        },
        clear() {
            currentId = null;
            set(null);
        },
        set(data) {
            set(data);
        },
        mutate(fn) {
            update(fn);
        },
        getCurrentId() {
            return currentId;
        }
    };
}
//# sourceMappingURL=factories.js.map