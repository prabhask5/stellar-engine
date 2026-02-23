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
import { supabase } from '../supabase/client';
import { getDeviceId } from '../deviceId';
import { debugLog, debugWarn } from '../debug';
import { getCRDTConfig } from './config';
import { clearPendingUpdates, saveDocumentState, loadDocumentState } from './store';
import { getActiveProvider } from './provider';
// =============================================================================
//  Binary ↔ Base64 Encoding
// =============================================================================
/**
 * Encode a `Uint8Array` to a base64 string for Supabase REST transport.
 */
function uint8ToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
/**
 * Decode a base64 string back to a `Uint8Array`.
 */
function base64ToUint8(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}
// =============================================================================
//  Supabase Persistence
// =============================================================================
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
export async function persistDocument(documentId, doc) {
    const config = getCRDTConfig();
    const state = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);
    const deviceId = getDeviceId();
    /* Find the pageId from the active provider. */
    const provider = getActiveProvider(documentId);
    if (!provider) {
        debugWarn(`[CRDT] Document ${documentId}: cannot persist — no active provider`);
        return;
    }
    debugLog(`[CRDT] Document ${documentId}: persisting to Supabase (${state.byteLength} bytes)`);
    const payload = {
        state: uint8ToBase64(state),
        state_vector: uint8ToBase64(stateVector),
        state_size: state.byteLength,
        device_id: deviceId
    };
    /* Select-then-insert/update: works whether or not the composite unique index
     * exists yet (e.g. local dev without DATABASE_URL schema push).
     * RLS scopes to the current user, so page_id is effectively unique per user. */
    const { data: existing } = await supabase
        .from(config.supabaseTable)
        .select('id')
        .eq('page_id', provider.pageId)
        .maybeSingle();
    let error;
    if (existing) {
        ({ error } = await supabase.from(config.supabaseTable).update(payload).eq('id', existing.id));
    }
    else {
        ({ error } = await supabase
            .from(config.supabaseTable)
            .insert({ ...payload, page_id: provider.pageId }));
    }
    if (error) {
        debugWarn(`[CRDT] Document ${documentId}: Supabase persist failed: ${error.message}`);
        throw error;
    }
    /* Clear pending updates from IndexedDB (now captured in Supabase). */
    const cleared = await clearPendingUpdates(documentId);
    debugLog(`[CRDT] Document ${documentId}: Supabase persist success (cleared ${cleared} pending updates)`);
    /* Update lastPersistedAt in IndexedDB. */
    const localRecord = await loadDocumentState(documentId);
    if (localRecord) {
        localRecord.lastPersistedAt = new Date().toISOString();
        await saveDocumentState(localRecord);
    }
}
/**
 * Persist all active dirty documents to Supabase.
 *
 * Iterates all active providers, checks if they are dirty, and persists
 * each one. Errors are caught per-document to avoid one failure blocking others.
 *
 * Useful as a manual "save all" action or for pre-close cleanup.
 */
export async function persistAllDirty() {
    /*
     * Dynamic import to avoid circular dependency at module load time.
     * The provider module imports from persistence (this file), so we cannot
     * statically import the provider registry here. Dynamic import breaks the cycle.
     */
    const { getActiveProviderEntries } = await import('./provider');
    const entries = getActiveProviderEntries();
    let persisted = 0;
    for (const [documentId, provider] of entries) {
        if (!provider.isDirty)
            continue;
        try {
            await persistDocument(documentId, provider.doc);
            persisted++;
        }
        catch (e) {
            debugWarn(`[CRDT] persistAllDirty: failed for document ${documentId}:`, e);
        }
    }
    debugLog(`[CRDT] persistAllDirty: persisted ${persisted} documents`);
}
// =============================================================================
//  Supabase Delete
// =============================================================================
/**
 * Delete a CRDT document from Supabase by page ID.
 *
 * Removes the row from the `crdt_documents` table. RLS scopes the delete
 * to the current user's row. No-op if the row doesn't exist.
 *
 * @param pageId - The page/entity ID whose CRDT document should be deleted.
 */
export async function deleteRemoteDocument(pageId) {
    const config = getCRDTConfig();
    const { error } = await supabase.from(config.supabaseTable).delete().eq('page_id', pageId);
    if (error) {
        debugWarn(`[CRDT] Failed to delete remote document for page ${pageId}: ${error.message}`);
        return;
    }
    debugLog(`[CRDT] Deleted remote document for page ${pageId}`);
}
// =============================================================================
//  Supabase Fetch
// =============================================================================
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
export async function fetchRemoteState(pageId) {
    const config = getCRDTConfig();
    const { data, error } = await supabase
        .from(config.supabaseTable)
        .select('state')
        .eq('page_id', pageId)
        .maybeSingle();
    if (error) {
        debugWarn(`[CRDT] Failed to fetch remote state for page ${pageId}: ${error.message}`);
        return null;
    }
    if (!data?.state) {
        return null;
    }
    const state = base64ToUint8(data.state);
    debugLog(`[CRDT] Fetched remote state for page ${pageId} (${state.byteLength} bytes)`);
    return state;
}
//# sourceMappingURL=persistence.js.map