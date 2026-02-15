/**
 * @fileoverview Demo Mode State Module
 *
 * Provides a completely isolated sandbox for consumer PWA apps. When demo mode
 * is active, the app uses a separate Dexie database (`${name}_demo`), makes
 * zero Supabase connections, and skips all sync/auth/email/device-verification
 * flows. Writes go to the sandboxed DB and are dropped on page refresh (mock
 * data is re-seeded).
 *
 * **Security model:**
 * Demo mode does NOT "bypass" auth — it replaces the entire data layer.
 * The real database is never opened. No Supabase client is created. If someone
 * manually sets the localStorage flag on a real instance, they see an empty or
 * seeded demo DB — there is no path to real user data.
 *
 * Callers of `setDemoMode()` must trigger a **full page reload**
 * (`window.location.href`) to ensure complete engine teardown and
 * reinitialization with the correct database.
 *
 * @module demo
 * @see {@link config.ts} for demo DB name switching in `initEngine()`
 * @see {@link engine.ts} for sync guards that check `isDemoMode()`
 */
import Dexie from 'dexie';
/**
 * Configuration for demo mode, provided by the consumer app.
 *
 * Contains a callback to seed mock data and a mock user profile for the
 * demo session. Registered via `initEngine({ demo: demoConfig })`.
 *
 * @example
 * ```ts
 * const demoConfig: DemoConfig = {
 *   seedData: async (db) => {
 *     await db.table('items').bulkPut([
 *       { id: '1', name: 'Sample Item', ... },
 *     ]);
 *   },
 *   mockProfile: {
 *     email: 'demo@example.com',
 *     firstName: 'Demo',
 *     lastName: 'User',
 *   },
 * };
 * ```
 */
export interface DemoConfig {
    /** Consumer callback that populates the demo Dexie DB with mock data. */
    seedData: (db: Dexie) => Promise<void>;
    /** Mock user profile for the demo session. */
    mockProfile: {
        email: string;
        firstName: string;
        lastName: string;
        [key: string]: unknown;
    };
}
/**
 * Check whether demo mode is currently active.
 *
 * SSR-safe: returns `false` on the server (no `localStorage` access).
 *
 * @returns `true` if the demo mode localStorage flag is set.
 */
export declare function isDemoMode(): boolean;
/**
 * Activate or deactivate demo mode.
 *
 * Sets a localStorage flag that is read during engine initialization.
 * **The caller must trigger a full page reload** after calling this
 * to ensure the engine reinitializes with the correct (demo or real) database.
 *
 * @param enabled - `true` to enter demo mode, `false` to exit.
 *
 * @example
 * ```ts
 * setDemoMode(true);
 * window.location.href = '/';
 * ```
 */
export declare function setDemoMode(enabled: boolean): void;
/**
 * Register the demo configuration.
 *
 * Called by `initEngine()` when the consumer provides a `demo` config.
 *
 * @param config - The demo configuration from the consumer app.
 * @internal
 */
export declare function registerDemoConfig(config: DemoConfig): void;
/**
 * Get the currently registered demo configuration.
 *
 * @returns The demo config, or `null` if none is registered.
 */
export declare function getDemoConfig(): DemoConfig | null;
/**
 * Set the prefix used for the demo mode localStorage key.
 *
 * Called by `initEngine()` to propagate the app prefix.
 *
 * @param prefix - The application prefix (e.g. `'myapp'`).
 * @internal
 */
export declare function _setDemoPrefix(prefix: string): void;
/**
 * Seed the demo database with mock data.
 *
 * Idempotent per page load: no-ops if data has already been seeded
 * (prevents re-seeding on SvelteKit client-side navigations).
 *
 * Steps:
 * 1. Check `_demoSeeded` flag — return if already seeded.
 * 2. Clear all app tables (using engine config's table definitions).
 * 3. Clear system tables (`syncQueue`, `conflictHistory`).
 * 4. Call the consumer's `seedData(db)` callback.
 * 5. Set `_demoSeeded = true`.
 *
 * @throws {Error} If no demo config is registered.
 */
export declare function seedDemoData(): Promise<void>;
/**
 * Delete the demo Dexie database entirely.
 *
 * Called when deactivating demo mode to clean up the sandboxed database.
 * The caller should trigger a full page reload after this.
 *
 * @param dbName - The name of the demo database to delete (e.g. `'myapp-db_demo'`).
 */
export declare function cleanupDemoDatabase(dbName: string): Promise<void>;
//# sourceMappingURL=demo.d.ts.map