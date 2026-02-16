/**
 * @fileoverview CRDT subpath barrel — `@prabhask5/stellar-engine/crdt`
 *
 * Consumer-facing entry point for the CRDT collaborative editing subsystem.
 * Provides everything needed to add real-time collaborative document editing
 * to a PWA: document lifecycle, shared type factories, presence/cursor tracking,
 * offline management, and Yjs type re-exports.
 *
 * Consumers never need to install `yjs` directly — all necessary Yjs types
 * and constructors are re-exported from this module.
 *
 * @example
 * import {
 *   openDocument, closeDocument,
 *   createSharedText, createBlockDocument,
 *   updateCursor, getCollaborators, onCollaboratorsChange,
 *   enableOffline, disableOffline,
 *   type YDoc, type YText,
 * } from '@prabhask5/stellar-engine/crdt';
 */
// =============================================================================
//  Document Lifecycle
// =============================================================================
export { openDocument, closeDocument, closeAllDocuments } from '../crdt/provider';
// =============================================================================
//  Document Type Helpers
// =============================================================================
export { createSharedText, createSharedXmlFragment, createSharedArray, createSharedMap, createBlockDocument } from '../crdt/helpers';
// =============================================================================
//  Yjs Re-exports
// =============================================================================
// Consumers never install yjs directly — these re-exports provide everything
// needed to work with Yjs documents and shared types.
export { Doc as YDoc } from 'yjs';
// =============================================================================
//  Awareness / Presence
// =============================================================================
export { updateCursor, getCollaborators, onCollaboratorsChange, assignColor } from '../crdt/awareness';
// =============================================================================
//  Offline Management
// =============================================================================
export { enableOffline, disableOffline } from '../crdt/offline';
export { isOfflineEnabled, getOfflineDocuments, loadDocumentByPageId } from '../crdt/store';
// =============================================================================
//  Persistence (Advanced)
// =============================================================================
export { persistDocument, persistAllDirty } from '../crdt/persistence';
// =============================================================================
//  Diagnostics
// =============================================================================
export { getCRDTDiagnostics } from '../diagnostics';
//# sourceMappingURL=crdt.js.map