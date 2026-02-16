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
// =============================================================================
//  Default Values
// =============================================================================
/**
 * Default values for all optional CRDT configuration fields.
 *
 * These defaults are tuned for a typical collaborative document editor:
 * - 30s persist interval balances durability vs. Supabase write costs
 * - 100ms broadcast debounce merges rapid keystrokes without noticeable lag
 * - 5s local save debounce provides crash recovery with minimal IndexedDB churn
 * - 50ms cursor debounce keeps presence smooth without flooding the channel
 * - 250KB chunk threshold stays well below Supabase's ~1MB Broadcast limit
 */
const DEFAULTS = {
    supabaseTable: 'crdt_documents',
    columns: 'id,page_id,state,state_vector,state_size,device_id,updated_at,created_at',
    persistIntervalMs: 30000,
    broadcastDebounceMs: 100,
    localSaveDebounceMs: 5000,
    cursorDebounceMs: 50,
    maxOfflineDocuments: 50,
    maxBroadcastPayloadBytes: 250000,
    syncPeerTimeoutMs: 3000,
    maxReconnectAttempts: 5,
    reconnectBaseDelayMs: 1000
};
// =============================================================================
//  Module State
// =============================================================================
/** The resolved config singleton (set by {@link _initCRDT}). */
let resolvedConfig = null;
/** The application prefix (e.g., 'myapp'), used for channel naming. */
let crdtPrefix = '';
// =============================================================================
//  Initialization
// =============================================================================
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
export function _initCRDT(rawConfig, prefix) {
    crdtPrefix = prefix;
    resolvedConfig = {
        supabaseTable: rawConfig.supabaseTable ?? DEFAULTS.supabaseTable,
        columns: rawConfig.columns ?? DEFAULTS.columns,
        persistIntervalMs: rawConfig.persistIntervalMs ?? DEFAULTS.persistIntervalMs,
        broadcastDebounceMs: rawConfig.broadcastDebounceMs ?? DEFAULTS.broadcastDebounceMs,
        localSaveDebounceMs: rawConfig.localSaveDebounceMs ?? DEFAULTS.localSaveDebounceMs,
        cursorDebounceMs: rawConfig.cursorDebounceMs ?? DEFAULTS.cursorDebounceMs,
        maxOfflineDocuments: rawConfig.maxOfflineDocuments ?? DEFAULTS.maxOfflineDocuments,
        maxBroadcastPayloadBytes: rawConfig.maxBroadcastPayloadBytes ?? DEFAULTS.maxBroadcastPayloadBytes,
        syncPeerTimeoutMs: rawConfig.syncPeerTimeoutMs ?? DEFAULTS.syncPeerTimeoutMs,
        maxReconnectAttempts: rawConfig.maxReconnectAttempts ?? DEFAULTS.maxReconnectAttempts,
        reconnectBaseDelayMs: rawConfig.reconnectBaseDelayMs ?? DEFAULTS.reconnectBaseDelayMs
    };
}
// =============================================================================
//  Accessors
// =============================================================================
/**
 * Get the resolved CRDT configuration.
 *
 * @throws {Error} If CRDT was not configured in `initEngine()`.
 * @returns The fully resolved {@link ResolvedCRDTConfig} with all defaults applied.
 */
export function getCRDTConfig() {
    if (!resolvedConfig) {
        throw new Error('CRDT not configured. Add crdt to your initEngine() config.');
    }
    return resolvedConfig;
}
/**
 * Get the application prefix for use in channel naming and storage keys.
 *
 * @throws {Error} If CRDT was not configured in `initEngine()`.
 * @returns The prefix string (e.g., `'myapp'`).
 */
export function getCRDTPrefix() {
    if (!resolvedConfig) {
        throw new Error('CRDT not configured. Add crdt to your initEngine() config.');
    }
    return crdtPrefix;
}
/**
 * Check whether the CRDT subsystem has been initialized.
 *
 * Unlike {@link getCRDTConfig}, this does not throw — it returns a boolean.
 * Used by conditional code paths that need to check CRDT availability
 * without triggering an error (e.g., sign-out cleanup).
 *
 * @returns `true` if `_initCRDT()` has been called.
 */
export function isCRDTEnabled() {
    return resolvedConfig !== null;
}
//# sourceMappingURL=config.js.map