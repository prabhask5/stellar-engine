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

import type { SchemaDefinition, SchemaTableConfig, FieldType } from './types';

// =============================================================================
// Types
// =============================================================================

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
  /**
   * App prefix for multi-tenant table name prefixing.
   * When set, all app tables are prefixed (e.g., `stellar_goals`).
   * Shared tables (`trusted_devices`, `crdt_documents`) remain unprefixed.
   */
  prefix?: string;
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

// =============================================================================
// Constants
// =============================================================================

/**
 * SQL reserved words that must be double-quoted when used as column names.
 *
 * PostgreSQL treats these as keywords, so bare usage in DDL/DML will cause
 * syntax errors. The generator wraps them in `"..."` automatically.
 */
const SQL_RESERVED_WORDS = new Set(['order', 'type', 'section', 'status', 'date', 'name', 'value']);

/**
 * System columns automatically added to every sync-enabled table.
 *
 * These columns power the sync engine's core features:
 * - `id` — Primary key (UUID)
 * - `user_id` — Row ownership with cascading delete
 * - `created_at` / `updated_at` — Timestamps for sync ordering
 * - `deleted` — Soft-delete flag (tombstone)
 * - `_version` — Optimistic concurrency control
 * - `device_id` — Echo suppression for realtime updates
 */
const SYSTEM_COLUMNS: Array<[name: string, definition: string]> = [
  ['id', 'uuid default gen_random_uuid() primary key'],
  ['user_id', 'uuid not null references auth.users(id) on delete cascade'],
  ['created_at', 'timestamptz not null default now()'],
  ['updated_at', 'timestamptz not null default now()'],
  ['deleted', 'boolean not null default false'],
  ['_version', 'integer not null default 1'],
  ['device_id', 'text']
];

// =============================================================================
// Column Type Inference
// =============================================================================

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
export function inferColumnType(fieldName: string): string {
  /* UUID foreign key references. */
  if (fieldName.endsWith('_id')) return 'uuid';

  /* Timestamp fields. */
  if (fieldName.endsWith('_at')) return 'timestamptz';

  /* Sort order — double precision for fractional ordering. */
  if (fieldName === 'order') return 'double precision default 0';

  /* Boolean flags — common patterns across both apps. */
  if (
    fieldName === 'completed' ||
    fieldName === 'deleted' ||
    fieldName === 'active' ||
    fieldName.startsWith('is_')
  ) {
    return 'boolean default false';
  }

  /* Version counter — starts at 1 (first write is version 1). */
  if (fieldName === '_version') return 'integer default 1';

  /* Date fields (without time component). */
  if (fieldName === 'date') return 'date';

  /* Numeric counter/measurement fields. */
  if (
    fieldName.endsWith('_count') ||
    fieldName.endsWith('_value') ||
    fieldName.endsWith('_size') ||
    fieldName.endsWith('_ms') ||
    fieldName.endsWith('_duration')
  ) {
    return 'integer default 0';
  }

  /* Enum-like text fields — no special type, but recognized for documentation. */
  if (fieldName === 'status' || fieldName === 'type' || fieldName === 'section') {
    return 'text';
  }

  /* Default: plain text. */
  return 'text';
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Quote a column name if it is a SQL reserved word.
 *
 * @param name - The column name to potentially quote.
 * @returns The column name, wrapped in double quotes if reserved.
 */
function quoteIfReserved(name: string): string {
  return SQL_RESERVED_WORDS.has(name) ? `"${name}"` : name;
}

/**
 * Parse a Dexie-style index string into individual field names.
 *
 * Splits on commas, trims whitespace, and skips compound indexes in
 * brackets (`[field1+field2]`) which are Dexie-specific and have no
 * SQL equivalent.
 *
 * @param indexes - The raw index string (e.g., `'goal_list_id, order, [foo+bar]'`).
 * @returns An array of individual field names.
 *
 * @example
 * parseIndexFields('goal_list_id, order');
 * // → ['goal_list_id', 'order']
 *
 * parseIndexFields('daily_routine_goal_id, date, [daily_routine_goal_id+date]');
 * // → ['daily_routine_goal_id', 'date']
 */
function parseIndexFields(indexes: string): string[] {
  if (!indexes.trim()) return [];

  return indexes
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && !f.startsWith('['));
}

// =============================================================================
// TypeScript Generation Helpers
// =============================================================================

/** Mass nouns that should not be singularized. */
const MASS_NOUNS = new Set([
  'progress',
  'status',
  'settings',
  'news',
  'focus',
  'agenda',
  'data',
  'media',
  'metadata',
  'analytics',
  'feedback',
  'info'
]);

/**
 * Convert a snake_case string to PascalCase.
 *
 * @example snakeToPascal('goal_lists') → 'GoalLists'
 */
function snakeToPascal(s: string): string {
  return s
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/**
 * Convert a PascalCase field name to PascalCase (from snake_case).
 */
function fieldToPascal(s: string): string {
  return snakeToPascal(s);
}

/**
 * Singularize a table name: PascalCase the snake_case name, then
 * singularize the last word using basic English rules.
 *
 * @example singularize('goal_lists') → 'GoalList'
 * @example singularize('task_categories') → 'TaskCategory'
 * @example singularize('daily_goal_progress') → 'DailyGoalProgress'
 */
function singularize(tableName: string): string {
  const pascal = snakeToPascal(tableName);
  const parts = tableName.split('_');
  const lastWord = parts[parts.length - 1].toLowerCase();

  if (MASS_NOUNS.has(lastWord)) return pascal;

  /* PascalCase the name, then singularize the trailing portion. */
  if (pascal.endsWith('ies')) {
    return pascal.slice(0, -3) + 'y';
  }
  if (pascal.endsWith('ses') || pascal.endsWith('zes') || pascal.endsWith('xes')) {
    return pascal.slice(0, -2);
  }
  if (pascal.endsWith('s') && !pascal.endsWith('ss')) {
    return pascal.slice(0, -1);
  }

  return pascal;
}

/**
 * Map a {@link FieldType} to its TypeScript type string.
 * Returns `[tsType, enumDef]` where `enumDef` is set when the field
 * declares an enum (union type alias).
 */
function mapFieldToTS(
  field: FieldType,
  enumTypeName: string
): { tsType: string; enumDef?: { name: string; values: string[] } } {
  /* Enum — array form */
  if (Array.isArray(field)) {
    return {
      tsType: enumTypeName,
      enumDef: { name: enumTypeName, values: field }
    };
  }

  /* Enum — object form */
  if (typeof field === 'object' && field !== null) {
    const name = field.enumName || enumTypeName;
    const tsType = field.nullable ? `${name} | null` : name;
    return {
      tsType,
      enumDef: { name, values: field.enum }
    };
  }

  /* String shorthand */
  const nullable = field.endsWith('?');
  const base = nullable ? field.slice(0, -1) : field;

  const typeMap: Record<string, string> = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    uuid: 'string',
    date: 'string',
    timestamp: 'string',
    json: 'unknown'
  };

  const tsBase = typeMap[base] ?? 'string';
  return { tsType: nullable ? `${tsBase} | null` : tsBase };
}

/**
 * Map a {@link FieldType} to a SQL column type string.
 *
 * When `fields` is present on a table config, this is used instead of
 * the name-based {@link inferColumnType}.
 */
function mapFieldToSQL(field: FieldType, fieldName: string): string {
  /* Enum → stored as text */
  if (Array.isArray(field)) return 'text not null';
  if (typeof field === 'object' && field !== null) {
    return field.nullable ? 'text' : 'text not null';
  }

  /* String shorthand */
  const nullable = field.endsWith('?');
  const base = nullable ? field.slice(0, -1) : field;

  const sqlMap: Record<string, string> = {
    string: 'text',
    uuid: 'uuid',
    date: 'date',
    timestamp: 'timestamptz',
    boolean: 'boolean',
    json: 'jsonb'
  };

  if (base === 'number') {
    /* Use name-based inference for integer vs double precision. */
    if (fieldName === 'order' || fieldName.endsWith('_order') || fieldName.endsWith('_position')) {
      return nullable ? 'double precision' : 'double precision not null default 0';
    }
    return nullable ? 'integer' : 'integer not null default 0';
  }

  if (base === 'boolean') {
    return nullable ? 'boolean' : 'boolean not null default false';
  }

  const sqlBase = sqlMap[base];
  if (sqlBase) {
    return nullable ? sqlBase : `${sqlBase} not null`;
  }

  /* Fallback */
  return nullable ? 'text' : 'text not null';
}

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
export function generateTypeScript(
  schema: SchemaDefinition,
  options?: TypeScriptGenerationOptions
): string {
  const lines: string[] = [];
  const includeSystem = options?.includeSystemColumns !== false;

  const header =
    options?.header ?? '/** AUTO-GENERATED by stellar-drive — do not edit manually. */';
  lines.push(header);
  lines.push('');

  /* First pass: collect all enum definitions. */
  const enums: { name: string; values: string[] }[] = [];
  /* Track interface generation data. */
  const interfaces: {
    name: string;
    fields: { name: string; type: string; optional: boolean }[];
    hasUserOwnership: boolean;
  }[] = [];

  for (const [tableName, definition] of Object.entries(schema)) {
    const config: SchemaTableConfig =
      typeof definition === 'string' ? { indexes: definition } : definition;

    if (!config.fields) continue;

    const interfaceName = config.typeName || singularize(tableName);

    const fieldEntries: { name: string; type: string; optional: boolean }[] = [];

    for (const [fieldName, fieldType] of Object.entries(config.fields)) {
      const enumTypeName = `${interfaceName}${fieldToPascal(fieldName)}`;
      const { tsType, enumDef } = mapFieldToTS(fieldType, enumTypeName);

      if (enumDef) {
        /* Deduplicate enums by name; warn on value mismatch. */
        const existing = enums.find((e) => e.name === enumDef.name);
        if (existing) {
          const oldValues = JSON.stringify(existing.values);
          const newValues = JSON.stringify(enumDef.values);
          if (oldValues !== newValues) {
            console.warn(
              `[stellar-drive] Enum name collision: "${enumDef.name}" is defined with different values.\n` +
                `  First:  ${oldValues}\n` +
                `  Second: ${newValues} (in ${tableName}.${fieldName})\n` +
                `  The first definition wins. Use "enumName" in the field config to disambiguate.`
            );
          }
        } else {
          enums.push(enumDef);
        }
      }

      fieldEntries.push({ name: fieldName, type: tsType, optional: false });
    }

    interfaces.push({
      name: interfaceName,
      fields: fieldEntries,
      hasUserOwnership: typeof config.ownership !== 'object'
    });
  }

  /* Emit enum type aliases. */
  if (enums.length > 0) {
    for (const e of enums) {
      const union = e.values.map((v) => `'${v}'`).join(' | ');
      lines.push(`export type ${e.name} = ${union};`);
    }
    lines.push('');
  }

  /* Emit interfaces. */
  for (const iface of interfaces) {
    lines.push(`export interface ${iface.name} {`);

    /* System columns first. */
    if (includeSystem) {
      lines.push('  id: string;');
      if (iface.hasUserOwnership) {
        lines.push('  user_id: string;');
      }
    }

    /* Business fields. */
    for (const f of iface.fields) {
      const suffix = f.optional ? '?' : '';
      lines.push(`  ${f.name}${suffix}: ${f.type};`);
    }

    /* System trailing columns. */
    if (includeSystem) {
      lines.push('  created_at: string;');
      lines.push('  updated_at: string;');
      lines.push('  deleted?: boolean;');
      lines.push('  _version?: number;');
      lines.push('  device_id?: string;');
    }

    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

// =============================================================================
// Single Table SQL Generation
// =============================================================================

/**
 * Generate the complete SQL for a single sync-enabled table.
 *
 * Produces a self-contained block of SQL that includes:
 *   1. `CREATE TABLE` with system columns + app-specific columns
 *   2. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`
 *   3. `CREATE POLICY` for user ownership (users can only access their own rows)
 *   4. Triggers for `set_user_id` (auto-populate on INSERT) and
 *      `update_updated_at` (auto-update on UPDATE)
 *   5. Indexes on `user_id`, `updated_at`, and `deleted` (partial index)
 *   6. `ALTER PUBLICATION` for Supabase realtime subscriptions
 *
 * @param tableName - The Supabase table name (snake_case).
 * @param config - The per-table configuration (parsed from schema).
 * @param options - Optional generation options.
 * @returns The SQL string for this table.
 *
 * @example
 * generateTableSQL('goals', {
 *   indexes: 'goal_list_id, order',
 *   sqlColumns: { title: 'text not null' },
 * });
 *
 * @see {@link generateSupabaseSQL} which calls this for each table
 */
function generateTableSQL(
  tableName: string,
  config: SchemaTableConfig,
  options?: SQLGenerationOptions
): string {
  const lines: string[] = [];
  const appName = options?.appName || '';
  const tableLabel = appName ? `${appName} — ${tableName}` : tableName;

  lines.push(`-- ${tableLabel}`);

  /* ---- CREATE TABLE ---- */

  const columnDefs: string[] = [];

  /* System columns first (always present on every sync table).
     Child tables (ownership: { parent, fk }) skip user_id — they inherit
     ownership through RLS policies on the parent table's FK. */
  const isChildTable = typeof config.ownership === 'object';
  for (const [colName, colDef] of SYSTEM_COLUMNS) {
    if (colName === 'user_id' && isChildTable) continue;
    columnDefs.push(`  ${colName} ${colDef}`);
  }

  /* Track which fields have been emitted (to avoid duplicates). */
  const emittedFields = new Set<string>();

  if (config.fields) {
    /* ---- Primary column source: `fields` (with sqlColumns as override) ---- */
    for (const [field, fieldType] of Object.entries(config.fields)) {
      if (SYSTEM_COLUMNS.some(([name]) => name === field)) continue;

      /* sqlColumns override takes precedence over FieldType mapping. */
      const sqlType = config.sqlColumns?.[field] ?? mapFieldToSQL(fieldType, field);
      const quotedName = quoteIfReserved(field);
      columnDefs.push(`  ${quotedName} ${sqlType}`);
      emittedFields.add(field);
    }

    /* Additional sqlColumns not in fields (e.g., columns needed by SQL only). */
    if (config.sqlColumns) {
      for (const [field, sqlType] of Object.entries(config.sqlColumns)) {
        if (emittedFields.has(field)) continue;
        if (SYSTEM_COLUMNS.some(([name]) => name === field)) continue;
        const quotedName = quoteIfReserved(field);
        columnDefs.push(`  ${quotedName} ${sqlType}`);
        emittedFields.add(field);
      }
    }
  } else {
    /* ---- Legacy path: infer columns from indexes + sqlColumns ---- */
    const indexFields = parseIndexFields(config.indexes || '');

    for (const field of indexFields) {
      if (SYSTEM_COLUMNS.some(([name]) => name === field)) continue;
      const sqlType = config.sqlColumns?.[field] ?? inferColumnType(field);
      const quotedName = quoteIfReserved(field);
      columnDefs.push(`  ${quotedName} ${sqlType}`);
      emittedFields.add(field);
    }

    if (config.sqlColumns) {
      for (const [field, sqlType] of Object.entries(config.sqlColumns)) {
        if (emittedFields.has(field)) continue;
        if (SYSTEM_COLUMNS.some(([name]) => name === field)) continue;
        const quotedName = quoteIfReserved(field);
        columnDefs.push(`  ${quotedName} ${sqlType}`);
        emittedFields.add(field);
      }
    }
  }

  lines.push(`create table if not exists ${tableName} (`);
  lines.push(columnDefs.join(',\n'));
  lines.push(');');

  /* Ensure ALL columns exist on pre-existing tables. CREATE TABLE IF NOT
     EXISTS silently skips if the table already exists, so any columns added
     after the table was originally created would be missing. This makes the
     schema fully convergent — no matter what state the database is in, after
     running this SQL every table will have every column. */
  for (const colDef of columnDefs) {
    /* Each columnDef is e.g. "  id uuid default gen_random_uuid() primary key"
       Extract the column name (first token after trimming) and the rest as the type.
       Skip PRIMARY KEY columns — ADD COLUMN IF NOT EXISTS can't add a PK. */
    const trimmed = colDef.trim();
    if (trimmed.toLowerCase().includes('primary key')) continue;
    /* Split into name and type definition */
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) continue;
    const colName = trimmed.substring(0, firstSpace);
    const colType = trimmed.substring(firstSpace + 1);
    lines.push(`alter table ${tableName} add column if not exists ${colName} ${colType};`);
  }
  lines.push('');

  /* ---- ROW LEVEL SECURITY ---- */

  lines.push(`alter table ${tableName} enable row level security;`);
  if (isChildTable) {
    /* Child table — RLS via parent FK existence check.
       The parent name from schema config is the raw key — prefix it for multi-tenant. */
    const { parent, fk } = config.ownership as { parent: string; fk: string };
    const parentName = options?.prefix ? `${options.prefix}_${parent}` : parent;
    const check = `exists (select 1 from ${parentName} where id = ${tableName}.${fk} and user_id = auth.uid())`;
    lines.push(
      `do $$ begin create policy "Owner can view ${tableName}" on ${tableName} for select using (${check}); exception when duplicate_object then null; end $$;`
    );
    lines.push(
      `do $$ begin create policy "Owner can create ${tableName}" on ${tableName} for insert with check (${check}); exception when duplicate_object then null; end $$;`
    );
    lines.push(
      `do $$ begin create policy "Owner can update ${tableName}" on ${tableName} for update using (${check}); exception when duplicate_object then null; end $$;`
    );
    lines.push(
      `do $$ begin create policy "Owner can delete ${tableName}" on ${tableName} for delete using (${check}); exception when duplicate_object then null; end $$;`
    );
  } else {
    lines.push(
      `do $$ begin create policy "Users can manage own ${tableName}" on ${tableName} for all using (auth.uid() = user_id); exception when duplicate_object then null; end $$;`
    );
  }
  lines.push('');

  /* ---- TRIGGERS ---- */

  if (!isChildTable) {
    lines.push(`drop trigger if exists set_user_id_${tableName} on ${tableName};`);
    lines.push(
      `create trigger set_user_id_${tableName} before insert on ${tableName} for each row execute function set_user_id();`
    );
  }
  lines.push(`drop trigger if exists update_${tableName}_updated_at on ${tableName};`);
  lines.push(
    `create trigger update_${tableName}_updated_at before update on ${tableName} for each row execute function update_updated_at_column();`
  );
  lines.push('');

  /* ---- INDEXES ---- */

  if (!isChildTable) {
    lines.push(`create index if not exists idx_${tableName}_user_id on ${tableName}(user_id);`);
  }
  lines.push(`create index if not exists idx_${tableName}_updated_at on ${tableName}(updated_at);`);
  lines.push(
    `create index if not exists idx_${tableName}_deleted on ${tableName}(deleted) where deleted = false;`
  );
  lines.push('');

  /* ---- REALTIME ---- */

  lines.push(
    `do $$ begin alter publication supabase_realtime add table ${tableName}; exception when duplicate_object then null; end $$;`
  );

  return lines.join('\n');
}

// =============================================================================
// Full SQL Generation
// =============================================================================

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
 * @see {@link generateTableSQL} which generates SQL for individual tables
 */
export function generateSupabaseSQL(
  schema: SchemaDefinition,
  options?: SQLGenerationOptions
): string {
  const parts: string[] = [];
  const appName = options?.appName || 'App';
  const includeHelpers = options?.includeHelperFunctions !== false;
  const includeDeviceVerification = options?.includeDeviceVerification !== false;
  const includeCRDT = options?.includeCRDT === true;

  /* ---- Header ---- */

  parts.push(`-- ${appName} Database Schema for Supabase`);
  parts.push('-- Copy and paste this entire file into your Supabase SQL Editor');
  parts.push('');

  /* ---- Extensions ---- */

  parts.push('-- ============================================================');
  parts.push('-- EXTENSIONS');
  parts.push('-- ============================================================');
  parts.push('');
  parts.push('create extension if not exists "uuid-ossp";');
  parts.push('');

  /* ---- Helper Functions ---- */

  if (includeHelpers) {
    parts.push('-- ============================================================');
    parts.push('-- HELPER FUNCTIONS');
    parts.push('-- ============================================================');
    parts.push('');
    parts.push('-- Function to automatically set user_id on insert');
    parts.push('create or replace function set_user_id()');
    parts.push('returns trigger as $$');
    parts.push('begin');
    parts.push('  new.user_id := auth.uid();');
    parts.push('  return new;');
    parts.push('end;');
    parts.push("$$ language plpgsql security definer set search_path = '';");
    parts.push('');
    parts.push('-- Function to automatically update updated_at timestamp');
    parts.push('create or replace function update_updated_at_column()');
    parts.push('returns trigger as $$');
    parts.push('begin');
    parts.push("  new.updated_at = timezone('utc'::text, now());");
    parts.push('  return new;');
    parts.push('end;');
    parts.push("$$ language plpgsql set search_path = '';");
    parts.push('');
  }

  /* ---- App Tables ---- */

  parts.push('-- ============================================================');
  parts.push('-- APPLICATION TABLES');
  parts.push('-- ============================================================');
  parts.push('');

  const prefix = options?.prefix;

  /* ---- Auto-migration: rename legacy unprefixed tables if they exist ---- */
  if (prefix) {
    parts.push('-- ============================================================');
    parts.push('-- AUTO-MIGRATION: Rename legacy unprefixed tables');
    parts.push('-- ============================================================');
    parts.push('-- Safe: only renames if old table exists AND new table does not.');
    parts.push('-- Idempotent: running twice does nothing.');
    parts.push('');

    for (const tableName of Object.keys(schema)) {
      const prefixedName = `${prefix}_${tableName}`;
      parts.push(`DO $$ BEGIN`);
      parts.push(
        `  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${tableName}')`
      );
      parts.push(
        `  AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${prefixedName}') THEN`
      );
      parts.push(`    ALTER TABLE ${tableName} RENAME TO ${prefixedName};`);
      parts.push(`  END IF;`);
      parts.push(`END $$;`);
      /* Rename indexes to match the new table name. */
      parts.push(
        `ALTER INDEX IF EXISTS idx_${tableName}_user_id RENAME TO idx_${prefixedName}_user_id;`
      );
      parts.push(
        `ALTER INDEX IF EXISTS idx_${tableName}_updated_at RENAME TO idx_${prefixedName}_updated_at;`
      );
      parts.push(
        `ALTER INDEX IF EXISTS idx_${tableName}_deleted RENAME TO idx_${prefixedName}_deleted;`
      );
      parts.push('');
    }
  }

  for (const [tableName, definition] of Object.entries(schema)) {
    /* Normalize string shorthand to object form. */
    const config: SchemaTableConfig =
      typeof definition === 'string' ? { indexes: definition } : definition;

    /* Derive the actual Supabase table name (prefixed when multi-tenant). */
    const supaTableName = prefix ? `${prefix}_${tableName}` : tableName;

    parts.push(generateTableSQL(supaTableName, config, options));
    parts.push('');
  }

  /* ---- Trusted Devices ---- */

  if (includeDeviceVerification) {
    parts.push('-- ============================================================');
    parts.push('-- TRUSTED DEVICES (required for device verification)');
    parts.push('-- ============================================================');
    parts.push('');
    parts.push('create table if not exists trusted_devices (');
    parts.push('  id uuid default gen_random_uuid() primary key,');
    parts.push('  user_id uuid references auth.users(id) on delete cascade not null,');
    parts.push('  device_id text not null,');
    parts.push('  device_label text,');
    parts.push('  trusted_at timestamptz default now() not null,');
    parts.push('  last_used_at timestamptz default now() not null,');
    parts.push('  unique(user_id, device_id)');
    parts.push(');');
    parts.push('');
    parts.push('alter table trusted_devices enable row level security;');
    parts.push(
      'do $$ begin create policy "Users can manage own devices" on trusted_devices for all using (auth.uid() = user_id); exception when duplicate_object then null; end $$;'
    );
    parts.push('');
    parts.push('drop trigger if exists set_user_id_trusted_devices on trusted_devices;');
    parts.push(
      'create trigger set_user_id_trusted_devices before insert on trusted_devices for each row execute function set_user_id();'
    );
    parts.push('drop trigger if exists update_trusted_devices_updated_at on trusted_devices;');
    parts.push(
      'create trigger update_trusted_devices_updated_at before update on trusted_devices for each row execute function update_updated_at_column();'
    );
    parts.push('');
    parts.push(
      'create index if not exists idx_trusted_devices_user_id on trusted_devices(user_id);'
    );
    parts.push('');
    parts.push(
      'do $$ begin alter publication supabase_realtime add table trusted_devices; exception when duplicate_object then null; end $$;'
    );
    parts.push('');
  }

  /* ---- CRDT Documents ---- */

  if (includeCRDT) {
    parts.push('-- ============================================================');
    parts.push('-- CRDT DOCUMENT STORAGE (optional — only needed for collaborative editing)');
    parts.push('-- ============================================================');
    parts.push('-- Stores Yjs CRDT document state for collaborative real-time editing.');
    parts.push(
      '-- Each row represents the latest merged state of a single collaborative document.'
    );
    parts.push(
      '-- The engine persists full Yjs binary state periodically (every ~30s), not per keystroke.'
    );
    parts.push(
      '-- Real-time updates between clients are distributed via Supabase Broadcast (WebSocket),'
    );
    parts.push(
      '-- so this table is only for durable persistence and offline-to-online reconciliation.'
    );
    parts.push('--');
    parts.push('-- Key columns:');
    parts.push(
      '--   state        — Full Yjs document state (Y.encodeStateAsUpdate), base64 encoded'
    );
    parts.push(
      '--   state_vector — Yjs state vector (Y.encodeStateVector) for efficient delta computation'
    );
    parts.push(
      '--   state_size   — Byte size of state column, used for monitoring and compaction decisions'
    );
    parts.push(
      '--   device_id    — Identifies which device last persisted, used for echo suppression'
    );
    parts.push('');
    parts.push('create table if not exists crdt_documents (');
    parts.push('  id uuid primary key default gen_random_uuid(),');
    parts.push('  page_id uuid not null,');
    parts.push('  state text not null,');
    parts.push('  state_vector text not null,');
    parts.push('  state_size integer not null default 0,');
    parts.push('  user_id uuid not null references auth.users(id),');
    parts.push('  device_id text not null,');
    parts.push('  updated_at timestamptz not null default now(),');
    parts.push('  created_at timestamptz not null default now()');
    parts.push(');');
    parts.push('');
    parts.push('alter table crdt_documents enable row level security;');
    parts.push('');
    parts.push('do $$ begin create policy "Users can manage own CRDT documents"');
    parts.push('  on crdt_documents for all');
    parts.push(
      '  using (auth.uid() = user_id); exception when duplicate_object then null; end $$;'
    );
    parts.push('');
    parts.push('drop trigger if exists set_crdt_documents_user_id on crdt_documents;');
    parts.push('create trigger set_crdt_documents_user_id');
    parts.push('  before insert on crdt_documents');
    parts.push('  for each row execute function set_user_id();');
    parts.push('');
    parts.push('drop trigger if exists update_crdt_documents_updated_at on crdt_documents;');
    parts.push('create trigger update_crdt_documents_updated_at');
    parts.push('  before update on crdt_documents');
    parts.push('  for each row execute function update_updated_at_column();');
    parts.push('');
    parts.push('create index if not exists idx_crdt_documents_page_id on crdt_documents(page_id);');
    parts.push('create index if not exists idx_crdt_documents_user_id on crdt_documents(user_id);');
    parts.push('');
    parts.push('-- Unique constraint per page per user (upsert target for persistence)');
    parts.push(
      'create unique index if not exists idx_crdt_documents_page_user on crdt_documents(page_id, user_id);'
    );
    parts.push('');
  }

  /* ---- Realtime Reminder ---- */

  parts.push('-- ============================================================');
  parts.push('-- REALTIME: All tables above have been added to supabase_realtime');
  parts.push('-- ============================================================');

  return parts.join('\n');
}
