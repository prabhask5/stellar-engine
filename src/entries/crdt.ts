// CRDT subpath barrel – @prabhask5/stellar-engine/crdt
export {
  // Yjs re-exports
  YDoc,
  YArray,
  YMap,
  YText,
  Y,

  // Document lifecycle
  initCrdtDoc,
  getCrdtDoc,
  destroyCrdtDoc,
  waitForCrdtSync,
  getActiveCrdtDocIds,

  // Realtime sync
  connectCrdtRealtime,
  disconnectCrdtRealtime,
  saveCrdtCheckpoint,
  loadCrdtFromRemote,
  getCrdtSyncState,
  isCrdtRealtimeConnected,

  // Awareness (presence)
  initAwareness,
  getAwareness,
  destroyAwareness,
  updateAwarenessCursor,
  getRemoteAwarenessUsers,
  Awareness,

  // Offline cache
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
} from '../crdt/index';

export type {
  CrdtDocConfig,
  AwarenessUser,
  AwarenessRole,
  AwarenessScope,
  RemoteUser,
  CrdtSyncState,
  CrdtBroadcastPayload
} from '../crdt/types';
