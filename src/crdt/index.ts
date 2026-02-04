/**
 * CRDT Module Barrel Export
 *
 * Provides complete Yjs/CRDT management for collaborative editing.
 * Apps should import everything from this module and never import
 * yjs or y-indexeddb directly.
 */

// Re-export Y for type access (apps need Y.Array, Y.Map, Y.Text, etc.)
export { Doc as YDoc, Array as YArray, Map as YMap, Text as YText } from 'yjs';
export * as Y from 'yjs';

// Document lifecycle
export {
  initCrdtDoc,
  getCrdtDoc,
  destroyCrdtDoc,
  waitForCrdtSync,
  getActiveCrdtDocIds
} from './doc';

// Realtime sync
export {
  connectCrdtRealtime,
  disconnectCrdtRealtime,
  saveCrdtCheckpoint,
  loadCrdtFromRemote,
  getCrdtSyncState,
  isCrdtRealtimeConnected
} from './sync';

// Awareness (presence)
export {
  initAwareness,
  getAwareness,
  destroyAwareness,
  updateAwarenessCursor,
  getRemoteAwarenessUsers
} from './awareness';
export { Awareness } from 'y-protocols/awareness';

// Offline cache
export {
  cacheCrdtForOffline,
  removeCrdtOfflineCache,
  isCrdtCachedOffline,
  loadCrdtFromOfflineCache,
  ensureCrdtOfflineData,
  getCrdtOfflineCacheSize,
  getActiveCrdtDocSize,
  getOfflineCacheStats,
  getStorageEstimate,
  formatBytes
} from './offline';
