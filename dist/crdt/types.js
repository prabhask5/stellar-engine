/**
 * @fileoverview CRDT Subsystem Type Definitions
 *
 * Defines all TypeScript interfaces and types used by the CRDT collaborative
 * editing subsystem. This includes:
 *   - {@link CRDTConfig} — configuration passed via `initEngine({ crdt: ... })`
 *   - {@link CRDTDocumentRecord} — IndexedDB record shape for persisted CRDT state
 *   - {@link CRDTPendingUpdate} — crash-safe incremental update records
 *   - {@link UserPresenceState} — per-user cursor/presence state for awareness
 *   - {@link OpenDocumentOptions} — options bag for `openDocument()`
 *   - {@link BroadcastMessage} — union of all Broadcast channel message types
 *
 * Architecture note:
 *   The CRDT subsystem is an optional layer on top of the existing sync engine.
 *   It uses Yjs for conflict-free document merging, Supabase Broadcast for
 *   real-time update distribution, Supabase Presence for cursor/awareness,
 *   and IndexedDB (via Dexie) for local persistence. Consumers never import
 *   yjs directly — all Yjs types are re-exported from the engine.
 *
 * @see {@link ./config.ts} for configuration singleton management
 * @see {@link ./provider.ts} for the per-document lifecycle orchestrator
 * @see {@link ./channel.ts} for Broadcast message handling
 * @see {@link ./awareness.ts} for Supabase Presence ↔ Yjs Awareness bridge
 */
export {};
//# sourceMappingURL=types.js.map