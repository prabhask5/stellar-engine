/**
 * @fileoverview Stable Device Identifier Management
 *
 * Generates and persists a unique device identifier in localStorage. The ID
 * survives page reloads and browser restarts, providing a stable "fingerprint"
 * for the current browser profile.
 *
 * The device ID serves two critical roles in the sync engine:
 *   1. **Echo suppression** — Realtime subscription payloads include `device_id`,
 *      allowing the engine to skip changes that originated from this device.
 *   2. **Deterministic conflict tiebreaker** — When two operations have identical
 *      timestamps, the lexicographically lower `device_id` wins. This ensures
 *      all devices resolve the same conflict the same way.
 *
 * The localStorage key is prefixed (e.g., `myapp_device_id`) so multiple engine
 * instances on the same origin don't collide.
 *
 * ## localStorage Clearing Resilience
 *
 * Some privacy-oriented browsers (e.g., Firefox with "Delete cookies and site
 * data when Firefox is closed") wipe localStorage on exit. To survive this, the
 * device ID is also backed up to a separate raw IndexedDB database named
 * `{prefix}_device_store`. On startup, `_initDeviceId()` checks both stores:
 *
 * - If localStorage has the ID → sync it to IndexedDB for backup.
 * - If localStorage was cleared but IndexedDB still has the ID → recover it
 *   back into localStorage so the device isn't treated as a new device.
 * - If neither has the ID → a fresh UUID is generated on the first
 *   {@link getDeviceId} call (same as before).
 *
 * Callers that make trust decisions (e.g., {@link isDeviceTrusted}) must
 * `await waitForDeviceId()` before calling {@link getDeviceId} to ensure
 * the recovery attempt has completed.
 *
 * @see {@link conflicts.ts#resolveByTimestamp} for the tiebreaker logic
 * @see {@link realtime.ts#isOwnDeviceChange} for echo suppression
 */

// =============================================================================
// Internal State
// =============================================================================

/** Configurable prefix for the localStorage key (default: `'stellar'`). */
let _deviceIdPrefix = 'stellar';

/** In-memory cache to avoid repeated localStorage reads. */
let _cachedDeviceId: string | null = null;

/** Resolves once the async IDB sync/recovery has finished (or been skipped). */
let _deviceIdReady: Promise<void> = Promise.resolve();

// =============================================================================
// Raw IndexedDB Helpers
// =============================================================================
//
// We use the raw IDB API (not Dexie) to avoid pulling the Dexie dependency into
// this low-level module and to keep the backup store completely separate from
// the main app database.

const _IDB_STORE = 'kv';

function _idbName(): string {
  return `${_deviceIdPrefix}_device_store`;
}

function _openDeviceIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_idbName(), 1);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(_IDB_STORE)) {
        db.createObjectStore(_IDB_STORE);
      }
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = () => reject(req.error);
  });
}

function _idbGet(db: IDBDatabase, key: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB_STORE, 'readonly');
    const req = tx.objectStore(_IDB_STORE).get(key);
    req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

function _idbPut(db: IDBDatabase, key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    const req = tx.objectStore(_IDB_STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Build the full localStorage key for the device ID.
 *
 * @returns The prefixed key string (e.g., `'myapp_device_id'`).
 */
function getDeviceIdKey(): string {
  return `${_deviceIdPrefix}_device_id`;
}

/**
 * Sync the device ID between localStorage and IndexedDB.
 *
 * - If localStorage has the ID, write it to IDB (backup).
 * - If localStorage is empty but IDB has it, restore it to localStorage
 *   (recovery after browser privacy wipe).
 * - If neither has it, do nothing — the first {@link getDeviceId} call will
 *   generate a fresh UUID and trigger its own IDB write.
 *
 * Never throws; IDB errors are swallowed since the fallback (generating a new
 * UUID) is acceptable.
 */
async function _initDeviceId(): Promise<void> {
  try {
    if (typeof localStorage === 'undefined' || typeof indexedDB === 'undefined') return;

    const lsKey = getDeviceIdKey();
    const lsValue = localStorage.getItem(lsKey);

    const db = await _openDeviceIDB();
    try {
      const idbValue = await _idbGet(db, 'device_id');

      if (lsValue) {
        /* localStorage has the ID — cache it and keep IDB in sync. */
        _cachedDeviceId = lsValue;
        if (idbValue !== lsValue) {
          await _idbPut(db, 'device_id', lsValue);
        }
      } else if (idbValue) {
        /* localStorage was cleared — recover the old UUID from IDB so the
           device isn't re-registered as a brand-new unknown device. */
        _cachedDeviceId = idbValue;
        localStorage.setItem(lsKey, idbValue);
      }
      /* If neither has an ID: first getDeviceId() call handles generation. */
    } finally {
      db.close();
    }
  } catch {
    /* IDB unavailable, blocked, or in a private-browsing context — not fatal.
       The device ID will still work via localStorage alone. */
  }
}

/**
 * Set the prefix used for the localStorage device ID key.
 *
 * Called internally by {@link config.ts#initEngine} — not part of the
 * public API. Kicks off the async IDB sync/recovery as a fire-and-forget
 * operation whose completion can be awaited via {@link waitForDeviceId}.
 *
 * @param prefix - Application-specific prefix (e.g., `'myapp'`).
 * @internal
 */
export function _setDeviceIdPrefix(prefix: string): void {
  _deviceIdPrefix = prefix;
  _cachedDeviceId = null;
  _deviceIdReady = _initDeviceId();
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Wait for the async device ID initialisation (IndexedDB sync/recovery) to
 * complete before reading the device ID.
 *
 * Must be awaited by any caller that makes a trust decision based on the
 * device ID, to ensure that a localStorage-cleared UUID is recovered from
 * IndexedDB before a new one is generated and persisted.
 *
 * Returns immediately (`Promise.resolve()`) if `_setDeviceIdPrefix` has not
 * been called yet (i.e., in SSR or before `initEngine()`).
 *
 * @returns A promise that resolves once recovery has completed or been skipped.
 */
export function waitForDeviceId(): Promise<void> {
  return _deviceIdReady;
}

/**
 * Get or create a stable device identifier for this browser/device.
 *
 * Returns the in-memory cached value if available. Otherwise reads from
 * localStorage, generating and persisting a new UUID v4 if none exists.
 * Newly generated IDs are also written to IndexedDB asynchronously so they
 * can be recovered if localStorage is later cleared.
 *
 * Returns `'ssr-placeholder'` in SSR contexts (no localStorage) — the
 * placeholder is never used for real sync operations since the engine
 * only runs client-side.
 *
 * **Callers that make trust decisions** should `await waitForDeviceId()`
 * before calling this function.
 *
 * @returns A UUID v4 string identifying this device.
 *
 * @example
 * const id = getDeviceId(); // e.g., "a3f2b1c4-..."
 */
export function getDeviceId(): string {
  if (typeof localStorage === 'undefined') {
    /* SSR context — return a placeholder that won't be used for sync. */
    return 'ssr-placeholder';
  }

  if (_cachedDeviceId) return _cachedDeviceId;

  let deviceId = localStorage.getItem(getDeviceIdKey());

  if (!deviceId) {
    deviceId = generateUUID();
    localStorage.setItem(getDeviceIdKey(), deviceId);
    _cachedDeviceId = deviceId;

    /* Persist to IDB so future recovery works even if localStorage is cleared. */
    if (typeof indexedDB !== 'undefined') {
      _openDeviceIDB()
        .then((db) => _idbPut(db, 'device_id', deviceId!).finally(() => db.close()))
        .catch(() => {});
    }
  } else {
    _cachedDeviceId = deviceId;
  }

  return deviceId;
}

// =============================================================================
// UUID Generation
// =============================================================================

/**
 * Generate a UUID v4 (random UUID).
 *
 * Prefers the native `crypto.randomUUID()` API (available in modern browsers
 * and Node 19+). Falls back to a manual implementation using `Math.random()`
 * for older environments.
 *
 * @returns A lowercase UUID v4 string (e.g., `"550e8400-e29b-41d4-a716-446655440000"`).
 */
function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  /*
   * Fallback for older browsers that lack crypto.randomUUID().
   * Replaces 'x' with a random hex digit and 'y' with a digit
   * constrained to the UUID v4 variant bits (8, 9, a, or b).
   */
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
