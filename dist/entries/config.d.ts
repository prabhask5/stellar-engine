/**
 * @fileoverview Config subpath barrel — `@prabhask5/stellar-engine/config`
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
export { initConfig, getConfig, setConfig } from '../runtime/runtimeConfig';
export type { AppConfig } from '../runtime/runtimeConfig';
//# sourceMappingURL=config.d.ts.map