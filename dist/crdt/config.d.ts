/**
 * @fileoverview CRDT Configuration Singleton
 *
 * Manages the resolved CRDT configuration singleton. The raw {@link CRDTConfig}
 * (with optional fields) is provided by the consumer via `initEngine({ crdt: ... })`.
 * This module applies sensible defaults and stores the result as a
 * {@link ResolvedCRDTConfig} singleton, accessible to all other CRDT modules
 * via {@link getCRDTConfig}.
 *
 * Initialization flow:
 *   1. Consumer calls `initEngine({ crdt: { ... } })`
 *   2. `config.ts#initEngine` calls `_initCRDT(rawConfig, prefix)`
 *   3. This module merges defaults → stores singleton
 *   4. Other CRDT modules call `getCRDTConfig()` to read the resolved config
 *
 * If `initEngine()` is called without a `crdt` field, the singleton remains
 * `null` and `getCRDTConfig()` throws with a descriptive error message.
 *
 * @see {@link ../config.ts} for the `initEngine()` entry point
 * @see {@link ./types.ts} for the config interfaces
 */
import type { CRDTConfig, ResolvedCRDTConfig } from './types';
/**
 * Initialize the CRDT configuration singleton.
 *
 * Called internally by {@link ../config.ts#initEngine} when `config.crdt` is
 * provided. Merges user-provided values with defaults and stores the result.
 *
 * @param rawConfig - The user-provided CRDT config (with optional fields).
 * @param prefix - The application prefix from `SyncEngineConfig.prefix`.
 * @internal
 */
export declare function _initCRDT(rawConfig: CRDTConfig, prefix: string): void;
/**
 * Get the resolved CRDT configuration.
 *
 * @throws {Error} If CRDT was not configured in `initEngine()`.
 * @returns The fully resolved {@link ResolvedCRDTConfig} with all defaults applied.
 */
export declare function getCRDTConfig(): ResolvedCRDTConfig;
/**
 * Get the application prefix for use in channel naming and storage keys.
 *
 * @throws {Error} If CRDT was not configured in `initEngine()`.
 * @returns The prefix string (e.g., `'myapp'`).
 */
export declare function getCRDTPrefix(): string;
/**
 * Check whether the CRDT subsystem has been initialized.
 *
 * Unlike {@link getCRDTConfig}, this does not throw — it returns a boolean.
 * Used by conditional code paths that need to check CRDT availability
 * without triggering an error (e.g., sign-out cleanup).
 *
 * @returns `true` if `_initCRDT()` has been called.
 */
export declare function isCRDTEnabled(): boolean;
//# sourceMappingURL=config.d.ts.map