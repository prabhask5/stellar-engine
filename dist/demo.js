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
import { getDb } from './database';
import { getEngineConfig, getDexieTableFor } from './config';
// =============================================================================
// Module State
// =============================================================================
/** The registered demo configuration (set via `registerDemoConfig`). */
let _demoConfig = null;
/** Whether demo data has been seeded in this page load (prevents re-seeding). */
let _demoSeeded = false;
/** The app prefix, used to namespace the localStorage demo flag. */
let _demoPrefix = '';
// =============================================================================
// Public API
// =============================================================================
/**
 * Check whether demo mode is currently active.
 *
 * SSR-safe: returns `false` on the server (no `localStorage` access).
 *
 * @returns `true` if the demo mode localStorage flag is set.
 */
export function isDemoMode() {
    if (typeof localStorage === 'undefined')
        return false;
    return localStorage.getItem(`${_demoPrefix}_demo_mode`) === 'true';
}
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
export function setDemoMode(enabled) {
    if (typeof localStorage === 'undefined')
        return;
    if (enabled) {
        localStorage.setItem(`${_demoPrefix}_demo_mode`, 'true');
    }
    else {
        localStorage.removeItem(`${_demoPrefix}_demo_mode`);
    }
}
/**
 * Register the demo configuration.
 *
 * Called by `initEngine()` when the consumer provides a `demo` config.
 *
 * @param config - The demo configuration from the consumer app.
 * @internal
 */
export function registerDemoConfig(config) {
    _demoConfig = config;
}
/**
 * Get the currently registered demo configuration.
 *
 * @returns The demo config, or `null` if none is registered.
 */
export function getDemoConfig() {
    return _demoConfig;
}
/**
 * Set the prefix used for the demo mode localStorage key.
 *
 * Called by `initEngine()` to propagate the app prefix.
 *
 * @param prefix - The application prefix (e.g. `'myapp'`).
 * @internal
 */
export function _setDemoPrefix(prefix) {
    _demoPrefix = prefix;
}
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
export async function seedDemoData() {
    if (_demoSeeded)
        return;
    if (!_demoConfig) {
        throw new Error('No demo config registered. Pass `demo` to initEngine().');
    }
    const db = getDb();
    const config = getEngineConfig();
    /* Clear all app tables */
    for (const table of config.tables) {
        const dexieName = getDexieTableFor(table);
        try {
            await db.table(dexieName).clear();
        }
        catch {
            /* Table may not exist in the demo DB — safe to ignore. */
        }
    }
    /* Clear system tables */
    for (const systemTable of ['syncQueue', 'conflictHistory']) {
        try {
            await db.table(systemTable).clear();
        }
        catch {
            /* Safe to ignore if table doesn't exist. */
        }
    }
    /* Call consumer's seed function */
    await _demoConfig.seedData(db);
    _demoSeeded = true;
}
/**
 * Delete the demo Dexie database entirely.
 *
 * Called when deactivating demo mode to clean up the sandboxed database.
 * The caller should trigger a full page reload after this.
 *
 * @param dbName - The name of the demo database to delete (e.g. `'myapp-db_demo'`).
 */
export async function cleanupDemoDatabase(dbName) {
    try {
        await Dexie.delete(dbName);
    }
    catch {
        /* Ignore deletion errors — the DB may not exist. */
    }
}
//# sourceMappingURL=demo.js.map