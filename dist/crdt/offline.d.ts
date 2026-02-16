/**
 * @fileoverview CRDT Offline Document Management
 *
 * Controls which CRDT documents are available for offline access. Offline-enabled
 * documents have their full Yjs state persisted to IndexedDB, allowing editing
 * even without network connectivity.
 *
 * Key behaviors:
 *   - {@link enableOffline} — Mark a document for offline access (stores state locally)
 *   - {@link disableOffline} — Remove a document from offline storage
 *   - Enforces `maxOfflineDocuments` limit (default: 50)
 *   - If the document is currently open, saves its current state immediately
 *   - If not open but online, fetches from Supabase and saves locally
 *   - If not open and offline, returns an error (can't fetch remote state)
 *
 * Non-offline documents opened while offline return `null` from the provider,
 * signaling to the consumer app that the document is unavailable offline.
 * Non-offline documents opened while online exist only in memory (no IndexedDB).
 *
 * @see {@link ./store.ts} for IndexedDB CRUD and offline queries
 * @see {@link ./provider.ts} for document lifecycle
 * @see {@link ./config.ts} for `maxOfflineDocuments` configuration
 */
/**
 * Enable offline access for a CRDT document.
 *
 * Persists the document's current Yjs state to IndexedDB so it can be loaded
 * and edited without network connectivity. If the document is currently open
 * in a provider, its live state is saved. If not open but online, the state
 * is fetched from Supabase.
 *
 * @param pageId - The page/entity this document belongs to.
 * @param documentId - The unique document identifier.
 *
 * @throws {Error} If the offline document limit has been reached.
 * @throws {Error} If the document is not open and the device is offline.
 *
 * @example
 * await enableOffline('page-1', 'doc-1');
 * // Document is now available offline
 */
export declare function enableOffline(pageId: string, documentId: string): Promise<void>;
/**
 * Disable offline access for a CRDT document.
 *
 * Removes the document and all its pending updates from IndexedDB.
 * If the document is currently open in a provider, it continues to work
 * in memory but will no longer persist to IndexedDB.
 *
 * @param pageId - The page/entity this document belongs to (unused, kept for API consistency).
 * @param documentId - The document to remove from offline storage.
 *
 * @example
 * await disableOffline('page-1', 'doc-1');
 * // Document is no longer available offline
 */
export declare function disableOffline(_pageId: string, documentId: string): Promise<void>;
//# sourceMappingURL=offline.d.ts.map