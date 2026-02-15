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
/**
 * Configuration for creating a collection store.
 *
 * @typeParam T - The entity type stored in the collection.
 */
export interface CollectionStoreConfig<T> {
    /** Async function that fetches the full collection (e.g., from local DB). */
    load: () => Promise<T[]>;
}
/**
 * A reactive store managing a collection of entities with loading state,
 * sync-complete auto-refresh, and optimistic mutation support.
 *
 * @typeParam T - The entity type stored in the collection.
 */
export interface CollectionStore<T> {
    /** Standard Svelte store subscribe method. */
    subscribe: (run: (value: T[]) => void) => () => void;
    /** Read-only loading sub-store. */
    loading: {
        subscribe: (run: (value: boolean) => void) => () => void;
    };
    /**
     * Initial load: fetches data, sets loading state, and registers a
     * sync-complete listener for automatic refresh on future syncs.
     */
    load(): Promise<void>;
    /** Re-fetch data without toggling the loading flag. */
    refresh(): Promise<void>;
    /** Replace the store's data directly. */
    set(data: T[]): void;
    /** Apply an optimistic mutation to the current data. */
    mutate(fn: (items: T[]) => T[]): void;
}
/**
 * Configuration for creating a detail store.
 *
 * @typeParam T - The entity type for the detail view.
 */
export interface DetailStoreConfig<T> {
    /** Async function that fetches a single entity by ID. */
    load: (id: string) => Promise<T | null>;
}
/**
 * A reactive store managing a single entity with loading state,
 * sync-complete auto-refresh, and ID tracking.
 *
 * @typeParam T - The entity type for the detail view.
 */
export interface DetailStore<T> {
    /** Standard Svelte store subscribe method. */
    subscribe: (run: (value: T | null) => void) => () => void;
    /** Read-only loading sub-store. */
    loading: {
        subscribe: (run: (value: boolean) => void) => () => void;
    };
    /**
     * Load a single entity by ID. Registers a sync-complete listener that
     * auto-refreshes the same entity on future syncs.
     */
    load(id: string): Promise<void>;
    /** Reset the store to null and clear the tracked ID. */
    clear(): void;
    /** Replace the store's data directly. */
    set(data: T | null): void;
    /** Get the currently tracked entity ID, or null if none loaded. */
    getCurrentId(): string | null;
}
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
 * stellar-engine is a library (not tied to SvelteKit's `browser` export).
 *
 * @typeParam T - The entity type stored in the collection.
 * @param config - Configuration with a `load` function.
 * @returns A `CollectionStore<T>` instance.
 *
 * @example
 * ```ts
 * import { createCollectionStore } from '@prabhask5/stellar-engine/stores';
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
export declare function createCollectionStore<T>(config: CollectionStoreConfig<T>): CollectionStore<T>;
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
 * import { createDetailStore } from '@prabhask5/stellar-engine/stores';
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
export declare function createDetailStore<T>(config: DetailStoreConfig<T>): DetailStore<T>;
//# sourceMappingURL=factories.d.ts.map