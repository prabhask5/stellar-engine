/**
 * @fileoverview CRDT Document Provider — Per-Document Lifecycle Manager
 *
 * The `CRDTProvider` is the central orchestrator for a single collaborative
 * document. It manages:
 *   - Yjs `Y.Doc` creation and state loading (from IndexedDB or Supabase)
 *   - Wiring `doc.on('update')` to persistence, broadcast, and crash recovery
 *   - Supabase Broadcast channel for real-time update distribution
 *   - Periodic Supabase persistence timer
 *   - Local IndexedDB full-state saves (debounced)
 *   - Document lifecycle (open → edit → close → destroy)
 *
 * Module-level `Map<string, CRDTProvider>` tracks all active providers.
 * Factory functions {@link openDocument} / {@link closeDocument} manage the lifecycle.
 *
 * @see {@link ./channel.ts} for Broadcast channel management
 * @see {@link ./store.ts} for IndexedDB persistence
 * @see {@link ./persistence.ts} for Supabase persistence
 * @see {@link ./awareness.ts} for cursor/presence management
 *
 * @example
 * import { openDocument, closeDocument } from '@prabhask5/stellar-engine/crdt';
 *
 * const provider = await openDocument('doc-1', 'page-1', { offlineEnabled: true });
 * // provider.doc is a Y.Doc — use with your editor
 * // ...
 * await closeDocument('doc-1');
 */
import * as Y from 'yjs';
import type { CRDTConnectionState, OpenDocumentOptions } from './types';
/**
 * Public interface for a CRDT document provider.
 *
 * Consumers receive this from {@link openDocument}. All mutable state
 * (timers, channels, pending updates) is hidden in the implementation.
 */
export interface CRDTProvider {
    /** The Yjs document instance — use with your editor. */
    readonly doc: Y.Doc;
    /** Unique document identifier. */
    readonly documentId: string;
    /** The page/entity this document belongs to. */
    readonly pageId: string;
    /** Current Broadcast channel connection state. */
    readonly connectionState: CRDTConnectionState;
    /** Whether the document has unsaved changes. */
    readonly isDirty: boolean;
    /** Destroy this provider and release all resources. */
    destroy(): Promise<void>;
}
/**
 * Open a collaborative CRDT document.
 *
 * Creates a new `CRDTProvider` for the document, loads its initial state
 * (from IndexedDB or Supabase), wires update handlers, joins the Broadcast
 * channel, and starts the periodic persist timer.
 *
 * **Idempotent:** If the document is already open, returns the existing provider.
 *
 * @param documentId - Unique identifier for the document.
 * @param pageId - The page/entity this document belongs to.
 * @param options - Optional configuration (offline mode, initial presence).
 * @returns The active `CRDTProvider` for this document.
 *
 * @throws {Error} If CRDT is not configured in `initEngine()`.
 *
 * @example
 * const provider = await openDocument('doc-1', 'page-1', {
 *   offlineEnabled: true,
 *   initialPresence: { name: 'Alice' },
 * });
 * const text = provider.doc.getText('content');
 */
export declare function openDocument(documentId: string, pageId: string, options?: OpenDocumentOptions): Promise<CRDTProvider>;
/**
 * Close a specific CRDT document.
 *
 * Saves final state, persists to Supabase if dirty, leaves the Broadcast
 * channel, and destroys the Y.Doc.
 *
 * @param documentId - The document to close.
 */
export declare function closeDocument(documentId: string): Promise<void>;
/**
 * Close all active CRDT documents.
 *
 * Called during sign-out to ensure all documents are properly saved and
 * all channels are cleaned up. Each document is closed in parallel.
 */
export declare function closeAllDocuments(): Promise<void>;
/**
 * Get the active provider for a document, if open.
 *
 * @param documentId - The document to look up.
 * @returns The active provider, or `undefined` if not open.
 * @internal
 */
export declare function getActiveProvider(documentId: string): CRDTProvider | undefined;
/**
 * Get all active provider entries for iteration.
 *
 * Used by {@link persistence.ts#persistAllDirty} to iterate and persist
 * all dirty documents. Returns `[documentId, provider]` pairs.
 *
 * @returns Iterator of `[documentId, CRDTProvider]` entries.
 * @internal
 */
export declare function getActiveProviderEntries(): IterableIterator<[string, CRDTProvider]>;
//# sourceMappingURL=provider.d.ts.map