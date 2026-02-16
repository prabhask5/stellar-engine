/**
 * @fileoverview Config subpath barrel — `stellar-drive/config`
 *
 * Provides runtime configuration management for the application. The config
 * system allows apps to store, retrieve, and update key-value settings that
 * persist across sessions (e.g. theme preference, feature flags, locale).
 *
 * - `initConfig` — initializes the config store with default values on app boot.
 * - `getConfig` — retrieves the current configuration snapshot.
 * - `setConfig` — merges partial updates into the active configuration.
 * - `AppConfig` — TypeScript interface describing the configuration shape.
 */
// =============================================================================
//  Runtime Configuration
// =============================================================================
// Central key-value configuration store that is initialized once at app startup
// and can be read or patched anywhere in the application. Backed by the
// `runtimeConfig` module which handles persistence and reactivity.
export { initConfig, getConfig, setConfig } from '../runtime/runtimeConfig';
//# sourceMappingURL=config.js.map