// CRDT subpath barrel – @prabhask5/stellar-engine/crdt
export { 
// Yjs re-exports
YDoc, YArray, YMap, YText, Y, 
// Document lifecycle
initCrdtDoc, getCrdtDoc, destroyCrdtDoc, waitForCrdtSync, getActiveCrdtDocIds, 
// Realtime sync
connectCrdtRealtime, disconnectCrdtRealtime, saveCrdtCheckpoint, loadCrdtFromRemote, getCrdtSyncState, isCrdtRealtimeConnected, 
// Awareness (presence)
initAwareness, getAwareness, destroyAwareness, Awareness, 
// Offline cache
cacheCrdtForOffline, removeCrdtOfflineCache, isCrdtCachedOffline, loadCrdtFromOfflineCache, ensureCrdtOfflineData, getCrdtOfflineCacheSize, getActiveCrdtDocSize, getOfflineCacheStats, getStorageEstimate, formatBytes } from '../crdt/index';
//# sourceMappingURL=crdt.js.map