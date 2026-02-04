/**
 * CRDT Module Barrel Export
 *
 * Provides complete Yjs/CRDT management for collaborative editing.
 * Apps should import everything from this module and never import
 * yjs or y-indexeddb directly.
 */
export { Doc as YDoc, Array as YArray, Map as YMap, Text as YText } from 'yjs';
export * as Y from 'yjs';
export { initCrdtDoc, getCrdtDoc, destroyCrdtDoc, waitForCrdtSync, getActiveCrdtDocIds } from './doc';
export { connectCrdtRealtime, disconnectCrdtRealtime, saveCrdtCheckpoint, loadCrdtFromRemote, getCrdtSyncState, isCrdtRealtimeConnected } from './sync';
export { initAwareness, getAwareness, destroyAwareness, updateAwarenessCursor, getRemoteAwarenessUsers } from './awareness';
export { Awareness } from 'y-protocols/awareness';
export { cacheCrdtForOffline, removeCrdtOfflineCache, isCrdtCachedOffline, loadCrdtFromOfflineCache, ensureCrdtOfflineData, getCrdtOfflineCacheSize, getActiveCrdtDocSize, getOfflineCacheStats, getStorageEstimate, formatBytes } from './offline';
//# sourceMappingURL=index.d.ts.map