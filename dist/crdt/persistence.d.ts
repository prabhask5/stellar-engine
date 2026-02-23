/**
 * @fileoverview CRDT Supabase Persistence
 *
 * Handles durable persistence of Yjs document state to the Supabase
 * `crdt_documents` table. This is the long-term storage layer — the
 * "source of truth" that survives device loss, browser data clearing,
 * and cross-device sync.
 *
 * Key behaviors:
 *   - {@link persistDocument} — Upserts full Yjs state to Supabase
 *   - {@link persistAllDirty} — Persists all active dirty documents
 *   - {@link fetchRemoteState} — Fetches latest state for initial load / sync
 *   - Binary state is base64-encoded for Supabase REST transport
 *   - Skips unchanged documents (compares state vectors)
 *   - Updates `lastPersistedAt` in IndexedDB on success
 *   - Clears pending updates after successful persist
 *
 * Timing:
 *   - Periodic persist: every `persistIntervalMs` (default 30s)
 *   - On document close (if dirty and online)
 *   - On offline → online reconnection (immediate)
 *
 * @see {@link ./provider.ts} for the timer that triggers periodic persists
 * @see {@link ./store.ts} for IndexedDB operations
 * @see {@link ./config.ts} for timing configuration
 */
import * as Y from 'yjs';
/**
 * Persist a Yjs document's full state to Supabase.
 *
 * Performs an upsert: if a row for this `page_id` already exists, it is
 * updated; otherwise a new row is created. The upsert key is `page_id`
 * (unique per user via RLS).
 *
 * On success:
 *   - Clears `crdtPendingUpdates` for this document in IndexedDB
 *   - Updates `lastPersistedAt` in the local `crdtDocuments` record
 *
 * @param documentId - The document identifier (for logging and IndexedDB updates).
 * @param doc - The Yjs document to persist.
 *
 * @throws {Error} If the Supabase upsert fails.
 */
export declare function persistDocument(documentId: string, doc: Y.Doc): Promise<void>;
/**
 * Persist all active dirty documents to Supabase.
 *
 * Iterates all active providers, checks if they are dirty, and persists
 * each one. Errors are caught per-document to avoid one failure blocking others.
 *
 * Useful as a manual "save all" action or for pre-close cleanup.
 */
export declare function persistAllDirty(): Promise<void>;
/**
 * Delete a CRDT document from Supabase by page ID.
 *
 * Removes the row from the `crdt_documents` table. RLS scopes the delete
 * to the current user's row. No-op if the row doesn't exist.
 *
 * @param pageId - The page/entity ID whose CRDT document should be deleted.
 */
export declare function deleteRemoteDocument(pageId: string): Promise<void>;
/**
 * Fetch the latest CRDT document state from Supabase by page ID.
 *
 * Used during `openDocument` when no local state exists and the device is
 * online. Returns the raw Yjs binary state ready to be applied via
 * `Y.applyUpdate(doc, state)`.
 *
 * @param pageId - The page/entity ID to fetch the document for.
 * @returns The Yjs state as a `Uint8Array`, or `null` if no document exists.
 */
export declare function fetchRemoteState(pageId: string): Promise<Uint8Array | null>;
//# sourceMappingURL=persistence.d.ts.map