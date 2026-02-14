/**
 * @fileoverview Core Type Definitions for the Stellar Sync Engine
 *
 * Defines the foundational TypeScript types used throughout the engine:
 * - Intent-based sync operation types (preserving operation semantics)
 * - Offline authentication types (credential caching, session tokens)
 * - Conflict resolution types (field-level history tracking)
 * - Single-user authentication types (PIN/password gate)
 * - Device trust types (multi-device verification)
 *
 * Architecture note:
 *   Operations use an intent-based model (e.g., "increment by 1") rather than
 *   final-state snapshots (e.g., "current_value: 50"). This enables local
 *   coalescing (50 rapid +1s become a single +50) and smarter conflict
 *   resolution. See {@link queue.ts} for the coalescing implementation.
 */
export {};
//# sourceMappingURL=types.js.map