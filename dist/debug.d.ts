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
 * import { setDebugMode } from '@prabhask5/stellar-engine';
 * setDebugMode(true);
 */
/**
 * Set the prefix used for the localStorage debug flag key.
 *
 * Called internally by {@link config.ts#initEngine} — not part of the
 * public API.
 *
 * @param prefix - Application-specific prefix (e.g., `'myapp'`).
 * @internal
 */
export declare function _setDebugPrefix(prefix: string): void;
/**
 * Check whether debug mode is currently enabled.
 *
 * Reads `localStorage.<prefix>_debug_mode` on the first call and caches
 * the result for subsequent calls. Returns `false` in SSR environments
 * where `localStorage` is unavailable.
 *
 * @returns `true` if debug logging is active.
 */
export declare function isDebugMode(): boolean;
/**
 * Enable or disable debug mode at runtime.
 *
 * Persists the setting to localStorage so it survives page reloads.
 *
 * @param enabled - `true` to enable debug logging, `false` to disable.
 */
export declare function setDebugMode(enabled: boolean): void;
/**
 * Log a debug message at the `console.log` level.
 *
 * No-op when debug mode is disabled.
 *
 * @param args - Arguments forwarded to `console.log`.
 */
export declare function debugLog(...args: unknown[]): void;
/**
 * Log a debug message at the `console.warn` level.
 *
 * No-op when debug mode is disabled.
 *
 * @param args - Arguments forwarded to `console.warn`.
 */
export declare function debugWarn(...args: unknown[]): void;
/**
 * Log a debug message at the `console.error` level.
 *
 * No-op when debug mode is disabled.
 *
 * @param args - Arguments forwarded to `console.error`.
 */
export declare function debugError(...args: unknown[]): void;
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
export declare function debug(level: 'log' | 'warn' | 'error', ...args: unknown[]): void;
//# sourceMappingURL=debug.d.ts.map