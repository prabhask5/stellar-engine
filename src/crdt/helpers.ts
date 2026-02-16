/**
 * @fileoverview CRDT Document Type Factories and Yjs Re-exports
 *
 * Provides convenience factory functions for creating shared data types within
 * a Yjs document. Consumers use these instead of importing `yjs` directly,
 * which keeps `yjs` as an internal dependency of the engine.
 *
 * Each factory function takes a `Y.Doc` and a type name, and returns the
 * corresponding shared type instance. If the type already exists in the doc
 * (e.g., from a previous session or a remote peer), the existing instance is
 * returned — Yjs shared types are singletons keyed by name within a doc.
 *
 * The "block document" factory ({@link createBlockDocument}) sets up a standard
 * structure for Notion-style block editors: an `XmlFragment` for the content
 * tree and a `Map` for per-block metadata.
 *
 * @see {@link ./provider.ts} for the orchestrator that creates Y.Doc instances
 * @see {@link ./types.ts} for the TypeScript types
 *
 * @example
 * import { openDocument, createSharedText } from 'stellar-drive/crdt';
 *
 * const provider = await openDocument('doc-1', 'page-1');
 * const title = createSharedText(provider.doc, 'title');
 * title.insert(0, 'Hello, World!');
 */

import * as Y from 'yjs';

// =============================================================================
//  Shared Type Factories
// =============================================================================

/**
 * Get or create a shared `Y.Text` within a Yjs document.
 *
 * `Y.Text` supports rich text with formatting attributes (bold, italic, etc.)
 * and is the standard type for collaborative text editors.
 *
 * @param doc - The Yjs document instance.
 * @param name - The shared type name (unique within the document). Default: `'text'`.
 * @returns The `Y.Text` instance, either existing or newly created.
 *
 * @example
 * const text = createSharedText(doc, 'title');
 * text.insert(0, 'My Page Title');
 */
export function createSharedText(doc: Y.Doc, name = 'text'): Y.Text {
  return doc.getText(name);
}

/**
 * Get or create a shared `Y.XmlFragment` within a Yjs document.
 *
 * `Y.XmlFragment` is the standard container for block-based editors
 * (Prosemirror, Tiptap, BlockNote). It represents a tree of XML elements
 * that maps to the editor's document model.
 *
 * @param doc - The Yjs document instance.
 * @param name - The shared type name. Default: `'content'`.
 * @returns The `Y.XmlFragment` instance.
 *
 * @example
 * const content = createSharedXmlFragment(doc, 'content');
 * // Use with Tiptap: new Editor({ extensions: [Collaboration.configure({ fragment: content })] })
 */
export function createSharedXmlFragment(doc: Y.Doc, name = 'content'): Y.XmlFragment {
  return doc.getXmlFragment(name);
}

/**
 * Get or create a shared `Y.Array` within a Yjs document.
 *
 * `Y.Array` is a CRDT list type suitable for ordered collections
 * (e.g., a list of block IDs, kanban columns, or comment threads).
 *
 * @param doc - The Yjs document instance.
 * @param name - The shared type name. Default: `'array'`.
 * @returns The `Y.Array` instance.
 */
export function createSharedArray<T>(doc: Y.Doc, name = 'array'): Y.Array<T> {
  return doc.getArray<T>(name);
}

/**
 * Get or create a shared `Y.Map` within a Yjs document.
 *
 * `Y.Map` is a CRDT key-value map suitable for document metadata,
 * settings, or per-block properties.
 *
 * @param doc - The Yjs document instance.
 * @param name - The shared type name. Default: `'map'`.
 * @returns The `Y.Map` instance.
 */
export function createSharedMap<T>(doc: Y.Doc, name = 'map'): Y.Map<T> {
  return doc.getMap<T>(name);
}

/**
 * Set up a standard "block document" structure within a Yjs document.
 *
 * Creates two shared types commonly used by Notion-style block editors:
 *   - `content` (`Y.XmlFragment`) — The block tree (paragraphs, headings, lists, etc.)
 *   - `meta` (`Y.Map`) — Per-document metadata (title, icon, cover, properties, etc.)
 *
 * This is a convenience function — consumers can also create these types
 * individually using the other factory functions.
 *
 * @param doc - The Yjs document instance.
 * @returns An object with `content` and `meta` shared types.
 *
 * @example
 * const provider = await openDocument('doc-1', 'page-1');
 * const { content, meta } = createBlockDocument(provider.doc);
 * meta.set('title', 'My Page');
 * // Pass `content` to your block editor's collaboration extension
 */
export function createBlockDocument(doc: Y.Doc): {
  content: Y.XmlFragment;
  meta: Y.Map<unknown>;
} {
  return {
    content: doc.getXmlFragment('content'),
    meta: doc.getMap('meta')
  };
}
