/**
 * CRDT Offline Cache Management
 *
 * Manages selective offline caching of Yjs document state.
 * Uses a dedicated IndexedDB store separate from y-indexeddb persistence.
 *
 * The active y-indexeddb persistence (from doc.ts) handles documents that are
 * currently open. This module handles explicit offline download/caching for
 * documents the user wants available offline even when not actively editing.
 */
import * as Y from 'yjs';
import { debugLog, debugWarn, debugError } from '../debug';
import { getEngineConfig } from '../config';
import { getCrdtDoc } from './doc';
import { supabase } from '../supabase/client';
function getOfflineDbName() {
    return `${getEngineConfig().prefix}_offline_crdt`;
}
function getObjectStoreName() {
    return 'cached_docs';
}
/**
 * Open the offline cache IndexedDB database.
 * Creates the object store if it doesn't exist.
 */
function openOfflineDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(getOfflineDbName(), 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(getObjectStoreName())) {
                db.createObjectStore(getObjectStoreName(), { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
/**
 * Cache a CRDT document for offline access.
 *
 * Serializes the current Yjs state and stores it in IndexedDB.
 * If the document is currently active, uses its live state.
 * Otherwise, fetches the state from Supabase.
 *
 * @param docId - Document/note ID
 */
export async function cacheCrdtForOffline(docId) {
    try {
        debugLog('[CRDT Offline] Caching for offline:', docId);
        let state;
        // Prefer live doc state if available
        const doc = getCrdtDoc(docId);
        if (doc) {
            state = Y.encodeStateAsUpdate(doc);
        }
        else {
            // Fetch from Supabase
            const { data, error } = await supabase
                .from('note_content')
                .select('yjs_state')
                .eq('note_id', docId)
                .eq('deleted', false)
                .maybeSingle();
            if (error) {
                debugError('[CRDT Offline] Failed to fetch state:', error);
                return;
            }
            if (!data?.yjs_state) {
                debugLog('[CRDT Offline] No state to cache for:', docId);
                // Store an empty doc state
                const emptyDoc = new Y.Doc();
                state = Y.encodeStateAsUpdate(emptyDoc);
                emptyDoc.destroy();
            }
            else {
                // Decode base64
                const binary = atob(data.yjs_state);
                state = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) {
                    state[i] = binary.charCodeAt(i);
                }
            }
        }
        // Store in offline cache
        const db = await openOfflineDb();
        const tx = db.transaction(getObjectStoreName(), 'readwrite');
        const store = tx.objectStore(getObjectStoreName());
        store.put({
            id: docId,
            yjs_state: Array.from(state), // Store as regular array for IndexedDB compatibility
            cached_at: new Date().toISOString()
        });
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
        debugLog('[CRDT Offline] Cached for offline:', docId, `(${state.length} bytes)`);
    }
    catch (e) {
        debugError('[CRDT Offline] Cache error:', e);
    }
}
/**
 * Remove a document from the offline cache.
 *
 * @param docId - Document/note ID
 */
export async function removeCrdtOfflineCache(docId) {
    try {
        debugLog('[CRDT Offline] Removing cache for:', docId);
        const db = await openOfflineDb();
        const tx = db.transaction(getObjectStoreName(), 'readwrite');
        const store = tx.objectStore(getObjectStoreName());
        store.delete(docId);
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
        db.close();
    }
    catch (e) {
        debugError('[CRDT Offline] Remove cache error:', e);
    }
}
/**
 * Check if a document is cached for offline access.
 *
 * @param docId - Document/note ID
 * @returns true if the document is cached
 */
export async function isCrdtCachedOffline(docId) {
    try {
        const db = await openOfflineDb();
        const tx = db.transaction(getObjectStoreName(), 'readonly');
        const store = tx.objectStore(getObjectStoreName());
        const result = await new Promise((resolve, reject) => {
            const request = store.get(docId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        db.close();
        return !!result;
    }
    catch (e) {
        debugWarn('[CRDT Offline] Check cache error:', e);
        return false;
    }
}
/**
 * Load a cached CRDT document state from offline storage.
 *
 * Creates a new Y.Doc and applies the cached state to it.
 * The caller is responsible for destroying the returned doc.
 *
 * @param docId - Document/note ID
 * @returns A Y.Doc with the cached state, or null if not cached
 */
/**
 * Bridge offline cache to active CRDT doc.
 * If the active doc is empty but we have cached data, apply the cached state.
 */
export async function ensureCrdtOfflineData(docId) {
    const doc = getCrdtDoc(docId);
    if (!doc)
        return false;
    const sv = Y.encodeStateVector(doc);
    if (sv.length > 1)
        return false; // Doc already has content
    const cachedDoc = await loadCrdtFromOfflineCache(docId);
    if (!cachedDoc)
        return false;
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(cachedDoc), 'offline-cache');
    cachedDoc.destroy();
    debugLog('[CRDT Offline] Bridged offline cache to active doc:', docId);
    return true;
}
/**
 * Get the byte size of a single cached note's CRDT data. Returns 0 if not cached.
 */
export async function getCrdtOfflineCacheSize(docId) {
    try {
        const db = await openOfflineDb();
        const tx = db.transaction(getObjectStoreName(), 'readonly');
        const store = tx.objectStore(getObjectStoreName());
        const result = await new Promise((resolve, reject) => {
            const request = store.get(docId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        db.close();
        return result?.yjs_state?.length ?? 0;
    }
    catch {
        return 0;
    }
}
/**
 * Get the byte size of the CRDT doc currently active (for the note the user is viewing).
 */
export function getActiveCrdtDocSize(docId) {
    const doc = getCrdtDoc(docId);
    if (!doc)
        return 0;
    return Y.encodeStateAsUpdate(doc).length;
}
/**
 * Get all cached documents with their sizes.
 */
export async function getOfflineCacheStats() {
    try {
        const db = await openOfflineDb();
        const tx = db.transaction(getObjectStoreName(), 'readonly');
        const store = tx.objectStore(getObjectStoreName());
        const entries = [];
        let totalBytes = 0;
        await new Promise((resolve, reject) => {
            const request = store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    const value = cursor.value;
                    const sizeBytes = value.yjs_state?.length ?? 0;
                    entries.push({ id: value.id, sizeBytes, cachedAt: value.cached_at });
                    totalBytes += sizeBytes;
                    cursor.continue();
                }
                else {
                    resolve();
                }
            };
            request.onerror = () => reject(request.error);
        });
        db.close();
        return { entries, totalBytes };
    }
    catch {
        return { entries: [], totalBytes: 0 };
    }
}
/**
 * Get device storage estimate (IndexedDB quota and usage).
 */
export async function getStorageEstimate() {
    if (!navigator.storage?.estimate)
        return null;
    const est = await navigator.storage.estimate();
    return {
        usage: est.usage ?? 0,
        quota: est.quota ?? 0,
        percentUsed: est.quota ? ((est.usage ?? 0) / est.quota) * 100 : 0
    };
}
/**
 * Format byte count to human-readable string.
 */
export function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export async function loadCrdtFromOfflineCache(docId) {
    try {
        const db = await openOfflineDb();
        const tx = db.transaction(getObjectStoreName(), 'readonly');
        const store = tx.objectStore(getObjectStoreName());
        const result = await new Promise((resolve, reject) => {
            const request = store.get(docId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        db.close();
        if (!result) {
            debugLog('[CRDT Offline] No cached state found for:', docId);
            return null;
        }
        const doc = new Y.Doc();
        const state = new Uint8Array(result.yjs_state);
        Y.applyUpdate(doc, state, 'offline-cache');
        debugLog('[CRDT Offline] Loaded from cache:', docId, `(cached at ${result.cached_at})`);
        return doc;
    }
    catch (e) {
        debugError('[CRDT Offline] Load cache error:', e);
        return null;
    }
}
//# sourceMappingURL=offline.js.map