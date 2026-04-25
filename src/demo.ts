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
import { writable } from 'svelte/store';
import { getDb, TABLE } from './database';
import { getEngineConfig, getDexieTableFor } from './config';
import type { TrustedDevice } from './types';

// =============================================================================
// Types
// =============================================================================

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

  /**
   * Mock trusted devices shown in the profile page when in demo mode.
   * If omitted, the profile page shows an empty device list.
   * Use {@link createMockDevices} to generate the canonical demo set.
   */
  mockDevices?: TrustedDevice[];
}

// =============================================================================
// Mock Device Factory
// =============================================================================

/**
 * Returns the canonical set of mock trusted devices for demo mode.
 *
 * Covers every UI state in the profile device list:
 * - `demo-device`   → the current device (shows "This device" badge, no remove button)
 * - `demo-device-2` → a recent mobile device (shows remove button)
 * - `demo-device-3` → an older desktop device (shows remove button)
 *
 * @param appPrefix - The app's prefix (e.g. `'stellar'`, `'radiant'`).
 */
function createMockDevices(appPrefix: string): TrustedDevice[] {
  const now = Date.now();
  return [
    {
      id: 'demo-td-1',
      userId: 'demo-user',
      deviceId: 'demo-device',
      deviceLabel: 'Chrome on macOS',
      appPrefix,
      trustedAt: new Date(now - 7 * 86400000).toISOString(),
      lastUsedAt: new Date(now).toISOString()
    },
    {
      id: 'demo-td-2',
      userId: 'demo-user',
      deviceId: 'demo-device-2',
      deviceLabel: 'Safari on iPhone 15 Pro',
      appPrefix,
      trustedAt: new Date(now - 14 * 86400000).toISOString(),
      lastUsedAt: new Date(now - 2 * 86400000).toISOString()
    },
    {
      id: 'demo-td-3',
      userId: 'demo-user',
      deviceId: 'demo-device-3',
      deviceLabel: 'Firefox on Windows 11',
      appPrefix,
      trustedAt: new Date(now - 30 * 86400000).toISOString(),
      lastUsedAt: new Date(now - 10 * 86400000).toISOString()
    }
  ];
}

// =============================================================================
// Demo Blocked Message Store
// =============================================================================

/**
 * Store that drives the DemoBlockedMessage overlay.
 *
 * `null` = hidden. A non-null string = the message to display.
 *
 * @internal — prefer `showDemoBlocked()` over writing to this store directly.
 */
export const _demoBlockedStore = writable<string | null>(null);

/**
 * Show a center-screen "not available in demo mode" message overlay.
 *
 * Requires `<DemoBlockedMessage />` to be mounted in the app root layout.
 * The overlay auto-dismisses after 3 seconds. Tapping the backdrop dismisses
 * it immediately.
 *
 * @param message - Short description of the blocked action
 *   (e.g. `'Not available in demo mode'`).
 *
 * @example
 * ```ts
 * import { showDemoBlocked } from 'stellar-drive/demo';
 *
 * if (isDemoMode()) {
 *   showDemoBlocked('Not available in demo mode');
 *   return;
 * }
 * ```
 */
export function showDemoBlocked(message: string): void {
  _demoBlockedStore.set(message);
}

// =============================================================================
// Module State
// =============================================================================

/** The registered demo configuration (set via `registerDemoConfig`). */
let _demoConfig: DemoConfig | null = null;

/** Whether demo data has been seeded in this page load (prevents re-seeding). */
let _demoSeeded = false;

/** The app prefix, used to namespace the localStorage demo flag. */
let _demoPrefix = '';

/** Shared BroadcastChannel instance — reused for both send and receive so the sender tab is exempt from its own messages. */
let _demoChannel: BroadcastChannel | null = null;

/**
 * Snapshot of the demo mode state, captured once at engine init.
 *
 * After init, `isDemoMode()` returns this cached value instead of reading
 * live from localStorage. This prevents other tabs toggling demo mode from
 * poisoning an already-running session (which would cause the sync engine
 * to push demo data to Supabase — catastrophic data leak).
 *
 * `null` means the engine hasn't initialized yet — fall back to localStorage.
 */
let _demoModeSnapshot: boolean | null = null;

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
export function isDemoMode(): boolean {
  if (_demoModeSnapshot !== null) return _demoModeSnapshot;
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(`${_demoPrefix}_demo_mode`) === 'true';
}

/**
 * Activate or deactivate demo mode.
 *
 * Sets a localStorage flag that is read during engine initialization,
 * then broadcasts the change to all other tabs so they force-reload
 * into the correct mode. **The caller must trigger a full page reload**
 * after calling this to reinitialize the current tab's engine.
 *
 * @param enabled - `true` to enter demo mode, `false` to exit.
 *
 * @example
 * ```ts
 * setDemoMode(true);
 * window.location.href = '/';
 * ```
 */
export function setDemoMode(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  if (enabled) {
    localStorage.setItem(`${_demoPrefix}_demo_mode`, 'true');
  } else {
    localStorage.removeItem(`${_demoPrefix}_demo_mode`);
  }

  // Broadcast to all other tabs so they reload into the correct mode.
  // We reuse the shared channel instance so the sending tab is exempt from
  // receiving its own message (BroadcastChannel exempts the sender *object*,
  // not the sender tab — creating a new instance would lose that exemption).
  _demoChannel?.postMessage({ type: 'DEMO_MODE_CHANGED', enabled });
}

/**
 * Register the demo configuration.
 *
 * Called by `initEngine()` when the consumer provides a `demo` config.
 *
 * @param config - The demo configuration from the consumer app.
 * @internal
 */
export function registerDemoConfig(config: DemoConfig): void {
  _demoConfig = {
    ...config,
    mockDevices: config.mockDevices ?? createMockDevices(_demoPrefix)
  };
}

/**
 * Get the currently registered demo configuration.
 *
 * @returns The demo config, or `null` if none is registered.
 */
export function getDemoConfig(): DemoConfig | null {
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
export function _setDemoPrefix(prefix: string): void {
  _demoPrefix = prefix;

  // Snapshot the demo mode state at init time so it's locked for this session.
  if (typeof localStorage !== 'undefined') {
    _demoModeSnapshot = localStorage.getItem(`${prefix}_demo_mode`) === 'true';
  } else {
    _demoModeSnapshot = false;
  }

  // Listen for demo mode changes from other tabs and force-reload.
  // This ensures all tabs reinitialize with the correct database immediately.
  // The same instance is reused by setDemoMode() for posting so the sender
  // tab is exempt and won't reload itself.
  if (typeof BroadcastChannel !== 'undefined') {
    _demoChannel = new BroadcastChannel(`${prefix}-demo-mode`);
    _demoChannel.onmessage = (event) => {
      if (event.data?.type === 'DEMO_MODE_CHANGED') {
        window.location.reload();
      }
    };
  }
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
export async function seedDemoData(): Promise<void> {
  if (_demoSeeded) return;
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
    } catch {
      /* Table may not exist in the demo DB — safe to ignore. */
    }
  }

  /* Clear system tables */
  for (const systemTable of ['syncQueue', TABLE.CONFLICT_HISTORY]) {
    try {
      await db.table(systemTable).clear();
    } catch {
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
export async function cleanupDemoDatabase(dbName: string): Promise<void> {
  try {
    await Dexie.delete(dbName);
  } catch {
    /* Ignore deletion errors — the DB may not exist. */
  }
}
