/**
 * @fileoverview Utils subpath barrel — `stellar-drive/utils`
 *
 * Re-exports general-purpose utility functions, debug tooling, and the
 * unified diagnostics API. These helpers are framework-agnostic and can
 * be used anywhere in the application.
 */

// =============================================================================
//  General Utilities
// =============================================================================
// Pure helper functions for common operations:
// - `generateId` — produces a unique identifier (UUID v4 or similar).
// - `now` — returns the current ISO 8601 timestamp string.
// - `calculateNewOrder` — computes a fractional order value for reorderable
//   lists (inserts between two adjacent items without reindexing).
// - `snakeToCamel` — converts a `snake_case` string to `camelCase`.
// - `formatBytes` — formats a byte count into a human-readable string.

export { generateId, now, calculateNewOrder, snakeToCamel, formatBytes } from '../utils';

// =============================================================================
//  Debug Utilities
// =============================================================================
// Development-time logging and debug mode management:
// - `debug` — conditional logger that only outputs when debug mode is active.
// - `isDebugMode` — returns whether debug mode is currently enabled.
// - `setDebugMode` — enables or disables debug mode at runtime.

export { debug, isDebugMode, setDebugMode } from '../debug';

// =============================================================================
//  Diagnostics
// =============================================================================
// Unified diagnostics API for inspecting sync engine internal state:
// - `getDiagnostics` — returns a comprehensive JSON snapshot of all engine state.
// - Sub-category functions for lightweight access to specific sections.

export {
  getDiagnostics,
  getSyncDiagnostics,
  getRealtimeDiagnostics,
  getQueueDiagnostics,
  getConflictDiagnostics,
  getEngineDiagnostics,
  getNetworkDiagnostics,
  getErrorDiagnostics
} from '../diagnostics';

// =============================================================================
//  SQL Generation
// =============================================================================
// Generate complete Supabase SQL from a declarative schema definition:
// - `generateSupabaseSQL` — produces CREATE TABLE, RLS, triggers, indexes.
// - `inferColumnType` — maps field names to SQL types via naming conventions.
// - `generateMigrationSQL` — diffs two schemas and produces ALTER statements.

export {
  generateSupabaseSQL,
  inferColumnType,
  generateMigrationSQL,
  generateTypeScript
} from '../schema';
