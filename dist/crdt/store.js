/**
 * @fileoverview CRDT IndexedDB Persistence Layer
 *
 * Provides CRUD operations for the two CRDT-specific IndexedDB tables:
 *   - `crdtDocuments` — Full Yjs document state snapshots
 *   - `crdtPendingUpdates` — Incremental Yjs update deltas for crash recovery
 *
 * These tables are conditionally created by {@link ../database.ts#buildDexie}
 * only when `crdt` config is provided to `initEngine()`.
 *
 * This module also exposes offline management query functions:
 *   - {@link isOfflineEnabled} — check if a document is stored for offline
 *   - {@link getOfflineDocuments} — list all offline-enabled documents
 *   - {@link getOfflineDocumentCount} — count for limit enforcement
 *
 * All functions access Dexie via the engine-managed instance from
 * {@link ../database.ts#getDb}. Binary Yjs state is stored directly as
 * `Uint8Array` — Dexie/IndexedDB handles binary data natively.
 *
 * @see {@link ./types.ts} for record shapes (CRDTDocumentRecord, CRDTPendingUpdate)
 * @see {@link ./provider.ts} for the orchestrator that calls these functions
 * @see {@link ../database.ts} for conditional CRDT table creation
 */
import { getDb } from '../database';
import { debugLog } from '../debug';
// =============================================================================
//  Document State CRUD
// =============================================================================
/**
 * Load a CRDT document record from IndexedDB.
 *
 * @param documentId - The unique document identifier.
 * @returns The document record, or `undefined` if not found.
 */
export async function loadDocumentState(documentId) {
    const db = getDb();
    return db.table('crdtDocuments').get(documentId);
}
/**
 * Save a full CRDT document state snapshot to IndexedDB.
 *
 * Uses Dexie's `put()` for upsert semantics — creates a new record if the
 * document doesn't exist, or overwrites the existing one.
 *
 * @param record - The full document record to persist.
 */
export async function saveDocumentState(record) {
    const db = getDb();
    await db.table('crdtDocuments').put(record);
    debugLog(`[CRDT] Document ${record.documentId}: local save (${record.stateSize} bytes to IndexedDB)`);
}
/**
 * Delete a CRDT document record from IndexedDB.
 *
 * Also clears all associated pending updates for the document.
 *
 * @param documentId - The document to delete.
 */
export async function deleteDocumentState(documentId) {
    const db = getDb();
    await db.table('crdtDocuments').delete(documentId);
    await clearPendingUpdates(documentId);
}
/**
 * Load a CRDT document record by page ID.
 *
 * Pages may have at most one CRDT document. Returns the first match.
 *
 * @param pageId - The page/entity ID to look up.
 * @returns The document record, or `undefined` if not found.
 */
export async function loadDocumentByPageId(pageId) {
    const db = getDb();
    return db.table('crdtDocuments').where('pageId').equals(pageId).first();
}
// =============================================================================
//  Pending Updates (Crash Recovery)
// =============================================================================
/**
 * Append an incremental Yjs update to the pending updates table.
 *
 * Called on every `doc.on('update')` event for crash safety. If the browser
 * crashes between full-state saves (every 5s), these deltas can be replayed
 * to recover the document.
 *
 * @param documentId - The document this update belongs to.
 * @param update - The incremental Yjs update delta.
 */
export async function appendPendingUpdate(documentId, update) {
    const db = getDb();
    const record = {
        documentId,
        update,
        timestamp: new Date().toISOString()
    };
    await db.table('crdtPendingUpdates').add(record);
}
/**
 * Load all pending updates for a specific document, ordered by ID (insertion order).
 *
 * Used during document opening to replay any updates that weren't captured
 * in the last full-state save.
 *
 * @param documentId - The document to load updates for.
 * @returns Array of pending update records, oldest first.
 */
export async function loadPendingUpdates(documentId) {
    const db = getDb();
    return db.table('crdtPendingUpdates').where('documentId').equals(documentId).sortBy('id');
}
/**
 * Clear all pending updates for a document.
 *
 * Called after a successful full-state save to IndexedDB or Supabase persist,
 * since the updates have been captured in the full state snapshot.
 *
 * @param documentId - The document to clear updates for.
 * @returns The number of updates cleared.
 */
export async function clearPendingUpdates(documentId) {
    const db = getDb();
    return db.table('crdtPendingUpdates').where('documentId').equals(documentId).delete();
}
// =============================================================================
//  Offline Management Queries
// =============================================================================
/**
 * Check whether a specific document is stored for offline access.
 *
 * @param documentId - The document to check.
 * @returns `true` if the document has `offlineEnabled: 1` in IndexedDB.
 */
export async function isOfflineEnabled(documentId) {
    const record = await loadDocumentState(documentId);
    return record?.offlineEnabled === 1;
}
/**
 * Get all documents that are stored for offline access.
 *
 * @returns Array of document records with `offlineEnabled: 1`.
 */
export async function getOfflineDocuments() {
    const db = getDb();
    return db.table('crdtDocuments').where('offlineEnabled').equals(1).toArray();
}
/**
 * Count the number of documents currently stored for offline access.
 *
 * Used by {@link ./offline.ts#enableOffline} to enforce the
 * `maxOfflineDocuments` limit.
 *
 * @returns The number of offline-enabled documents.
 */
export async function getOfflineDocumentCount() {
    const db = getDb();
    return db.table('crdtDocuments').where('offlineEnabled').equals(1).count();
}
//# sourceMappingURL=store.js.map