/**
 * CRDT Document Lifecycle Management
 *
 * Creates, manages, and destroys Yjs Y.Doc instances with y-indexeddb persistence.
 * The engine fully owns all Yjs and y-indexeddb -- apps never import these directly.
 */

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { debugLog, debugWarn } from '../debug';
import { getEngineConfig } from '../config';
import type { CrdtDocConfig, CrdtDocState } from './types';

/** Active documents map: docId → { doc, persistence, state } */
const activeDocs: Map<
  string,
  { doc: Y.Doc; persistence: IndexeddbPersistence; state: CrdtDocState }
> = new Map();

function getDbName(docId: string, config?: CrdtDocConfig): string {
  const prefix = config?.dbPrefix || getEngineConfig().prefix;
  return `${prefix}_crdt_${docId}`;
}

/**
 * Initialize a CRDT document with local IndexedDB persistence.
 *
 * Creates a Y.Doc and attaches IndexeddbPersistence for local durability.
 * If the document already exists, returns the existing instance.
 *
 * @param docId - Unique identifier for the document (typically note ID)
 * @param config - Optional configuration
 * @returns The Y.Doc instance
 */
export function initCrdtDoc(docId: string, config?: CrdtDocConfig): Y.Doc {
  const existing = activeDocs.get(docId);
  if (existing) {
    debugLog('[CRDT] Doc already initialized:', docId);
    return existing.doc;
  }

  debugLog('[CRDT] Initializing doc:', docId);

  const doc = new Y.Doc();
  const dbName = getDbName(docId, config);
  const persistence = new IndexeddbPersistence(dbName, doc);
  const cleanup: (() => void)[] = [];

  const state: CrdtDocState = {
    docId,
    cleanup
  };

  // Log when persistence is synced from IndexedDB
  const onSynced = () => {
    debugLog('[CRDT] IndexedDB synced for doc:', docId);
  };
  persistence.on('synced', onSynced);
  cleanup.push(() => persistence.off('synced', onSynced));

  activeDocs.set(docId, { doc, persistence, state });

  return doc;
}

/**
 * Get an active CRDT document by ID.
 *
 * @param docId - Document identifier
 * @returns The Y.Doc if it exists, undefined otherwise
 */
export function getCrdtDoc(docId: string): Y.Doc | undefined {
  return activeDocs.get(docId)?.doc;
}

/**
 * Wait for a document's IndexedDB persistence to finish syncing.
 * Resolves immediately if already synced.
 *
 * @param docId - Document identifier
 */
export async function waitForCrdtSync(docId: string): Promise<void> {
  const entry = activeDocs.get(docId);
  if (!entry) {
    debugWarn('[CRDT] Cannot wait for sync - doc not initialized:', docId);
    return;
  }

  if (entry.persistence.synced) return;

  return new Promise<void>((resolve) => {
    const handler = () => {
      entry.persistence.off('synced', handler);
      resolve();
    };
    entry.persistence.on('synced', handler);
  });
}

/**
 * Destroy a CRDT document and clean up all resources.
 *
 * Closes IndexedDB persistence, runs cleanup callbacks, and removes from active map.
 *
 * @param docId - Document identifier
 */
export async function destroyCrdtDoc(docId: string): Promise<void> {
  const entry = activeDocs.get(docId);
  if (!entry) {
    debugLog('[CRDT] Doc not found for destroy:', docId);
    return;
  }

  debugLog('[CRDT] Destroying doc:', docId);

  // Run cleanup callbacks (removes event listeners)
  for (const fn of entry.state.cleanup) {
    try {
      fn();
    } catch (e) {
      debugWarn('[CRDT] Cleanup error for doc:', docId, e);
    }
  }

  // Close IndexedDB persistence
  try {
    await entry.persistence.destroy();
  } catch (e) {
    debugWarn('[CRDT] Error closing persistence for doc:', docId, e);
  }

  // Destroy the Y.Doc
  entry.doc.destroy();

  activeDocs.delete(docId);
  debugLog('[CRDT] Doc destroyed:', docId);
}

/**
 * Get the internal state for a document (used by other CRDT modules).
 * @internal
 */
export function _getDocEntry(docId: string) {
  return activeDocs.get(docId);
}

/**
 * Get all active document IDs.
 */
export function getActiveCrdtDocIds(): string[] {
  return Array.from(activeDocs.keys());
}
