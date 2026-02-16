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
export { openDocument, closeDocument, closeAllDocuments } from '../crdt/provider';
export type { CRDTProvider } from '../crdt/provider';
export { createSharedText, createSharedXmlFragment, createSharedArray, createSharedMap, createBlockDocument } from '../crdt/helpers';
export { Doc as YDoc } from 'yjs';
export type { Text as YText, XmlFragment as YXmlFragment, Array as YArray, Map as YMap, XmlElement as YXmlElement } from 'yjs';
export { updateCursor, getCollaborators, onCollaboratorsChange, assignColor } from '../crdt/awareness';
export { enableOffline, disableOffline } from '../crdt/offline';
export { isOfflineEnabled, getOfflineDocuments, loadDocumentByPageId } from '../crdt/store';
export { persistDocument, persistAllDirty } from '../crdt/persistence';
export type { CRDTConfig, UserPresenceState, OpenDocumentOptions } from '../crdt/types';
//# sourceMappingURL=crdt.d.ts.map