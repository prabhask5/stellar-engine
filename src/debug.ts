/**
 * @fileoverview Debug Logging Utilities
 *
 * Provides opt-in debug logging gated by a localStorage flag. When debug
 * mode is enabled (`localStorage.<prefix>_debug_mode === 'true'`), all
 * debug calls forward to the browser console. When disabled, they are
 * silently dropped — zero runtime cost.
 *
 * The prefix is configurable via {@link _setDebugPrefix} (set by
 * {@link config.ts#initEngine}) so multiple engine instances on the same
 * origin don't collide.
 *
 * @example
 * // Enable debug mode from the browser console:
 * localStorage.setItem('myapp_debug_mode', 'true');
 *
 * // Or programmatically:
 * import { setDebugMode } from 'stellar-drive';
 * setDebugMode(true);
 */

// =============================================================================
// Internal State
// =============================================================================

/** Cached result of the localStorage check (avoids repeated reads). */
let debugEnabled: boolean | null = null;

/** Configurable prefix for the localStorage key (default: `'stellar'`). */
let debugPrefix = 'stellar';

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Set the prefix used for the localStorage debug flag key.
 *
 * Called internally by {@link config.ts#initEngine} — not part of the
 * public API.
 *
 * @param prefix - Application-specific prefix (e.g., `'myapp'`).
 * @internal
 */
export function _setDebugPrefix(prefix: string) {
  debugPrefix = prefix;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Check whether debug mode is currently enabled.
 *
 * Reads `localStorage.<prefix>_debug_mode` on the first call and caches
 * the result for subsequent calls. Returns `false` in SSR environments
 * where `localStorage` is unavailable.
 *
 * @returns `true` if debug logging is active.
 */
export function isDebugMode(): boolean {
  if (debugEnabled !== null) return debugEnabled;
  debugEnabled =
    typeof localStorage !== 'undefined' &&
    localStorage.getItem(`${debugPrefix}_debug_mode`) === 'true';
  return debugEnabled;
}

/**
 * Enable or disable debug mode at runtime.
 *
 * Persists the setting to localStorage so it survives page reloads.
 *
 * @param enabled - `true` to enable debug logging, `false` to disable.
 */
export function setDebugMode(enabled: boolean) {
  debugEnabled = enabled;
  localStorage.setItem(`${debugPrefix}_debug_mode`, enabled ? 'true' : 'false');
}

/**
 * Log a debug message at the `console.log` level.
 *
 * No-op when debug mode is disabled.
 *
 * @param args - Arguments forwarded to `console.log`.
 */
export function debugLog(...args: unknown[]) {
  if (isDebugMode()) console.log(...args);
}

/**
 * Log a debug message at the `console.warn` level.
 *
 * No-op when debug mode is disabled.
 *
 * @param args - Arguments forwarded to `console.warn`.
 */
export function debugWarn(...args: unknown[]) {
  if (isDebugMode()) console.warn(...args);
}

/**
 * Log a debug message at the `console.error` level.
 *
 * No-op when debug mode is disabled.
 *
 * @param args - Arguments forwarded to `console.error`.
 */
export function debugError(...args: unknown[]) {
  if (isDebugMode()) console.error(...args);
}

/**
 * Unified debug logging function with configurable severity level.
 *
 * Replaces the individual `debugLog` / `debugWarn` / `debugError` calls
 * when a single import is preferred.
 *
 * @param level - Console severity: `'log'`, `'warn'`, or `'error'`.
 * @param args  - Arguments forwarded to the corresponding `console` method.
 *
 * @example
 * debug('log', '[SYNC] Starting push...');
 * debug('error', '[SYNC] Push failed:', error);
 */
export function debug(level: 'log' | 'warn' | 'error', ...args: unknown[]): void {
  if (!isDebugMode()) return;
  switch (level) {
    case 'log':
      console.log(...args);
      break;
    case 'warn':
      console.warn(...args);
      break;
    case 'error':
      console.error(...args);
      break;
  }
}
