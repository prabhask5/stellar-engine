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
/**
 * Cache a CRDT document for offline access.
 *
 * Serializes the current Yjs state and stores it in IndexedDB.
 * If the document is currently active, uses its live state.
 * Otherwise, fetches the state from Supabase.
 *
 * @param docId - Document/note ID
 */
export declare function cacheCrdtForOffline(docId: string): Promise<void>;
/**
 * Remove a document from the offline cache.
 *
 * @param docId - Document/note ID
 */
export declare function removeCrdtOfflineCache(docId: string): Promise<void>;
/**
 * Check if a document is cached for offline access.
 *
 * @param docId - Document/note ID
 * @returns true if the document is cached
 */
export declare function isCrdtCachedOffline(docId: string): Promise<boolean>;
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
export declare function ensureCrdtOfflineData(docId: string): Promise<boolean>;
/**
 * Get the byte size of a single cached note's CRDT data. Returns 0 if not cached.
 */
export declare function getCrdtOfflineCacheSize(docId: string): Promise<number>;
/**
 * Get the byte size of the CRDT doc currently active (for the note the user is viewing).
 */
export declare function getActiveCrdtDocSize(docId: string): number;
/**
 * Get all cached documents with their sizes.
 */
export declare function getOfflineCacheStats(): Promise<{
    entries: Array<{
        id: string;
        sizeBytes: number;
        cachedAt: string;
    }>;
    totalBytes: number;
}>;
/**
 * Get device storage estimate (IndexedDB quota and usage).
 */
export declare function getStorageEstimate(): Promise<{
    usage: number;
    quota: number;
    percentUsed: number;
} | null>;
/**
 * Format byte count to human-readable string.
 */
export declare function formatBytes(bytes: number): string;
export declare function loadCrdtFromOfflineCache(docId: string): Promise<Y.Doc | null>;
/**
 * Extract plain text from a note's CRDT blocks.
 *
 * Reads block content from the active doc, offline cache, or Supabase remote.
 * Returns concatenated text content with HTML tags stripped.
 *
 * @param docId - Document/note ID
 * @returns Plain text content of all blocks, or empty string
 */
export declare function extractCrdtText(docId: string): Promise<string>;
//# sourceMappingURL=offline.d.ts.map