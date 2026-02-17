/**
 * @fileoverview Supabase SQL Generation from Schema Definitions
 *
 * Generates complete Supabase SQL (CREATE TABLE, RLS, triggers, indexes,
 * realtime subscriptions) from a declarative {@link SchemaDefinition}.
 * This eliminates the need for consumers to hand-write SQL — the schema
 * in code becomes the single source of truth.
 *
 * The generation flow:
 *   1. Schema string fields → Supabase SQL columns (with inferred types)
 *   2. `sqlColumns` (object form) → Supabase SQL columns (explicit types)
 *   3. System columns (auto) → Both Supabase + Dexie
 *
 * Column types are inferred from field naming conventions:
 *   - `*_id` → `uuid` (foreign key)
 *   - `*_at` → `timestamptz`
 *   - `order` → `double precision default 0`
 *   - `*_count`, `*_value`, etc. → `integer default 0`
 *   - Boolean patterns (`is_*`, `completed`, etc.) → `boolean default false`
 *   - Everything else → `text`
 *
 * @see {@link config.ts#initEngine} for schema-driven initialization
 * @see {@link sw/build/vite-plugin.ts} for the Vite plugin that auto-applies generated SQL
 */
import type { SchemaDefinition } from './types';
/**
 * Options for controlling SQL generation output.
 *
 * All fields are optional with sensible defaults. The most common use case
 * is to just call `generateSupabaseSQL(schema)` with no options.
 *
 * @example
 * generateSupabaseSQL(schema, {
 *   appName: 'Stellar',
 *   includeCRDT: true,
 *   includeDeviceVerification: true,
 * });
 */
export interface SQLGenerationOptions {
    /** Application name for SQL comments. */
    appName?: string;
    /** Include CRDT document storage table. @default false */
    includeCRDT?: boolean;
    /** Include trusted_devices table. @default true */
    includeDeviceVerification?: boolean;
    /** Include helper trigger functions (set_user_id, update_updated_at_column). @default true */
    includeHelperFunctions?: boolean;
}
/**
 * Options for controlling TypeScript interface generation.
 */
export interface TypeScriptGenerationOptions {
    /** Header comment at the top of the generated file. */
    header?: string;
    /** Whether to include system columns in generated interfaces. @default true */
    includeSystemColumns?: boolean;
}
/**
 * Infer a SQL column type from a field name using naming conventions.
 *
 * The engine uses consistent field naming patterns across all apps, so the
 * column type can be reliably determined from the field suffix or exact name.
 * Consumers can override any inference via `sqlColumns` in the schema config.
 *
 * @param fieldName - The snake_case field name (e.g., `'goal_list_id'`, `'order'`).
 * @returns The SQL type with optional default (e.g., `'uuid'`, `'boolean default false'`).
 *
 * @example
 * inferColumnType('goal_list_id');  // → 'uuid'
 * inferColumnType('completed_at');  // → 'timestamptz'
 * inferColumnType('order');         // → 'double precision default 0'
 * inferColumnType('is_active');     // → 'boolean default false'
 * inferColumnType('title');         // → 'text'
 *
 * @see {@link SchemaTableConfig.sqlColumns} for explicit type overrides
 */
export declare function inferColumnType(fieldName: string): string;
/**
 * Generate TypeScript interfaces and enum types from a schema definition.
 *
 * Only tables with a `fields` property are included. Tables without `fields`
 * are silently skipped (backward-compatible).
 *
 * @param schema - The declarative schema definition.
 * @param options - Optional generation options.
 * @returns The generated TypeScript source string.
 */
export declare function generateTypeScript(schema: SchemaDefinition, options?: TypeScriptGenerationOptions): string;
/**
 * Generate the complete Supabase SQL from a declarative schema definition.
 *
 * This is the main entry point for SQL generation. It produces a single SQL
 * file that can be pasted directly into the Supabase SQL Editor to bootstrap
 * the entire database.
 *
 * The generated SQL includes (in order):
 *   1. Extensions (`uuid-ossp`)
 *   2. Helper functions (`set_user_id`, `update_updated_at_column`)
 *   3. One `CREATE TABLE` block per schema table
 *   4. `trusted_devices` table (unless `includeDeviceVerification` is `false`)
 *   5. `crdt_documents` table (only if `includeCRDT` is `true`)
 *
 * @param schema - The declarative schema definition.
 * @param options - Optional generation options.
 * @returns The complete SQL string ready for execution.
 *
 * @example
 * const sql = generateSupabaseSQL({
 *   goals: 'goal_list_id, order',
 *   goal_lists: { indexes: 'order', sqlColumns: { name: 'text not null' } },
 *   focus_settings: { singleton: true },
 * }, { appName: 'Stellar' });
 *
 * // Write to file or paste into Supabase SQL Editor
 * fs.writeFileSync('supabase-schema.sql', sql);
 *
 * @see {@link SchemaDefinition} for the schema format
 * @see {@link generateMigrationSQL} for incremental schema changes
 */
export declare function generateSupabaseSQL(schema: SchemaDefinition, options?: SQLGenerationOptions): string;
/**
 * Generate migration SQL by diffing two schema definitions.
 *
 * Compares the current (deployed) schema against the new (desired) schema
 * and produces `ALTER TABLE` statements for the differences:
 *   - **New tables** → full `CREATE TABLE` (via {@link generateTableSQL})
 *   - **Removed tables** → commented-out `DROP TABLE` (safety: requires manual review)
 *   - **New columns** → `ALTER TABLE ... ADD COLUMN`
 *   - **Removed columns** → commented-out `ALTER TABLE ... DROP COLUMN`
 *
 * This function intentionally does NOT handle column type changes — those
 * require careful manual migration (data conversion, backfill, etc.).
 *
 * @param currentSchema - The currently deployed schema definition.
 * @param newSchema - The desired (target) schema definition.
 * @returns The migration SQL string. Empty string if no changes detected.
 *
 * @example
 * const migration = generateMigrationSQL(
 *   { goals: 'goal_list_id, order' },
 *   {
 *     goals: 'goal_list_id, order, priority',  // added column
 *     tags: 'name',                              // new table
 *   }
 * );
 *
 * @see {@link generateSupabaseSQL} for generating the initial schema
 */
export declare function generateMigrationSQL(currentSchema: SchemaDefinition, newSchema: SchemaDefinition): string;
//# sourceMappingURL=schema.d.ts.map