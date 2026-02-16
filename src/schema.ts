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
  /** Include CRDT document storage table. @default false */
  includeCRDT?: boolean;
  /** Include trusted_devices table. @default true */
  includeDeviceVerification?: boolean;
  /** Include helper functions (set_user_id, update_updated_at). @default true */
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
        /* Deduplicate enums by name. */
        if (!enums.some((e) => e.name === enumDef.name)) {
          enums.push(enumDef);
        }
      }

      fieldEntries.push({ name: fieldName, type: tsType, optional: false });
    }

    interfaces.push({ name: interfaceName, fields: fieldEntries });
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

  /* System columns first (always present on every sync table). */
  for (const [colName, colDef] of SYSTEM_COLUMNS) {
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

  lines.push(`create table ${tableName} (`);
  lines.push(columnDefs.join(',\n'));
  lines.push(');');
  lines.push('');

  /* ---- ROW LEVEL SECURITY ---- */

  lines.push(`alter table ${tableName} enable row level security;`);
  lines.push(
    `create policy "Users can manage own ${tableName}" on ${tableName} for all using (auth.uid() = user_id);`
  );
  lines.push('');

  /* ---- TRIGGERS ---- */

  lines.push(
    `create trigger set_user_id_${tableName} before insert on ${tableName} for each row execute function set_user_id();`
  );
  lines.push(
    `create trigger update_${tableName}_updated_at before update on ${tableName} for each row execute function update_updated_at_column();`
  );
  lines.push('');

  /* ---- INDEXES ---- */

  lines.push(`create index idx_${tableName}_user_id on ${tableName}(user_id);`);
  lines.push(`create index idx_${tableName}_updated_at on ${tableName}(updated_at);`);
  lines.push(
    `create index idx_${tableName}_deleted on ${tableName}(deleted) where deleted = false;`
  );
  lines.push('');

  /* ---- REALTIME ---- */

  lines.push(`alter publication supabase_realtime add table ${tableName};`);

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
 * @see {@link generateMigrationSQL} for incremental schema changes
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

    parts.push('-- Function to execute migration SQL via RPC (service_role only)');
    parts.push('-- Used by the Vite plugin to auto-push schema migrations during dev.');
    parts.push('create or replace function stellar_engine_migrate(sql_text text)');
    parts.push('returns void as $$');
    parts.push('begin');
    parts.push(
      "  if current_setting('request.jwt.claims', true)::json->>'role' != 'service_role' then"
    );
    parts.push("    raise exception 'Unauthorized: stellar_engine_migrate requires service_role';");
    parts.push('  end if;');
    parts.push('  execute sql_text;');
    parts.push('end;');
    parts.push("$$ language plpgsql security definer set search_path = '';");
    parts.push('');
  }

  /* ---- App Tables ---- */

  parts.push('-- ============================================================');
  parts.push('-- APPLICATION TABLES');
  parts.push('-- ============================================================');
  parts.push('');

  for (const [tableName, definition] of Object.entries(schema)) {
    /* Normalize string shorthand to object form. */
    const config: SchemaTableConfig =
      typeof definition === 'string' ? { indexes: definition } : definition;

    parts.push(generateTableSQL(tableName, config, options));
    parts.push('');
  }

  /* ---- Trusted Devices ---- */

  if (includeDeviceVerification) {
    parts.push('-- ============================================================');
    parts.push('-- TRUSTED DEVICES (required for device verification)');
    parts.push('-- ============================================================');
    parts.push('');
    parts.push('create table trusted_devices (');
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
      'create policy "Users can manage own devices" on trusted_devices for all using (auth.uid() = user_id);'
    );
    parts.push('');
    parts.push(
      'create trigger set_user_id_trusted_devices before insert on trusted_devices for each row execute function set_user_id();'
    );
    parts.push(
      'create trigger update_trusted_devices_updated_at before update on trusted_devices for each row execute function update_updated_at_column();'
    );
    parts.push('');
    parts.push('create index idx_trusted_devices_user_id on trusted_devices(user_id);');
    parts.push('');
    parts.push('alter publication supabase_realtime add table trusted_devices;');
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
    parts.push('create table crdt_documents (');
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
    parts.push('create policy "Users can manage own CRDT documents"');
    parts.push('  on crdt_documents for all');
    parts.push('  using (auth.uid() = user_id);');
    parts.push('');
    parts.push('create trigger set_crdt_documents_user_id');
    parts.push('  before insert on crdt_documents');
    parts.push('  for each row execute function set_user_id();');
    parts.push('');
    parts.push('create trigger update_crdt_documents_updated_at');
    parts.push('  before update on crdt_documents');
    parts.push('  for each row execute function update_updated_at_column();');
    parts.push('');
    parts.push('create index idx_crdt_documents_page_id on crdt_documents(page_id);');
    parts.push('create index idx_crdt_documents_user_id on crdt_documents(user_id);');
    parts.push('');
    parts.push('-- Unique constraint per page per user (upsert target for persistence)');
    parts.push(
      'create unique index idx_crdt_documents_page_user on crdt_documents(page_id, user_id);'
    );
    parts.push('');
  }

  /* ---- Realtime Reminder ---- */

  parts.push('-- ============================================================');
  parts.push('-- REALTIME: All tables above have been added to supabase_realtime');
  parts.push('-- ============================================================');

  return parts.join('\n');
}

// =============================================================================
// Migration SQL Generation
// =============================================================================

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
export function generateMigrationSQL(
  currentSchema: SchemaDefinition,
  newSchema: SchemaDefinition
): string {
  const parts: string[] = [];

  parts.push('-- Migration SQL');
  parts.push(`-- Generated at ${new Date().toISOString()}`);
  parts.push('');

  const currentTables = Object.keys(currentSchema);
  const newTables = Object.keys(newSchema);

  /*
   * Build a set of old table names that are being renamed so they are NOT
   * treated as "removed tables" in the diff below.
   */
  const renamedFromSet = new Set<string>();
  for (const [, def] of Object.entries(newSchema)) {
    const config: SchemaTableConfig = typeof def === 'string' ? { indexes: def } : def;
    if (config.renamedFrom) renamedFromSet.add(config.renamedFrom);
  }

  /* ---- Table Renames ---- */

  const renameStatements: string[] = [];

  for (const [tableName, definition] of Object.entries(newSchema)) {
    const config: SchemaTableConfig =
      typeof definition === 'string' ? { indexes: definition } : definition;

    if (!config.renamedFrom || !currentTables.includes(config.renamedFrom)) continue;

    const oldName = config.renamedFrom;

    /* Rename the table itself. */
    renameStatements.push(`alter table ${oldName} rename to ${tableName};`);

    /* Rename associated triggers. */
    renameStatements.push(
      `alter trigger set_user_id_${oldName} on ${tableName} rename to set_user_id_${tableName};`
    );
    renameStatements.push(
      `alter trigger update_${oldName}_updated_at on ${tableName} rename to update_${tableName}_updated_at;`
    );

    /* Rename associated RLS policy. */
    renameStatements.push(
      `alter policy "Users can manage own ${oldName}" on ${tableName} rename to "Users can manage own ${tableName}";`
    );

    /* Rename associated indexes. */
    renameStatements.push(`alter index idx_${oldName}_user_id rename to idx_${tableName}_user_id;`);
    renameStatements.push(
      `alter index idx_${oldName}_updated_at rename to idx_${tableName}_updated_at;`
    );
    renameStatements.push(`alter index idx_${oldName}_deleted rename to idx_${tableName}_deleted;`);

    /* Rename columns if specified. */
    if (config.renamedColumns) {
      for (const [newCol, oldCol] of Object.entries(config.renamedColumns)) {
        const quotedOld = quoteIfReserved(oldCol);
        const quotedNew = quoteIfReserved(newCol);
        renameStatements.push(
          `alter table ${tableName} rename column ${quotedOld} to ${quotedNew};`
        );
      }
    }

    /* Update realtime publication (remove old, add new). */
    renameStatements.push(`alter publication supabase_realtime drop table ${oldName};`);
    renameStatements.push(`alter publication supabase_realtime add table ${tableName};`);
  }

  if (renameStatements.length > 0) {
    parts.push('-- ============================================================');
    parts.push('-- TABLE RENAMES');
    parts.push('-- ============================================================');
    parts.push('');
    parts.push(...renameStatements);
    parts.push('');
  }

  /* ---- New tables (in new schema but not current, excluding renames) ---- */

  const addedTables = newTables.filter((t) => {
    if (currentTables.includes(t)) return false;
    /* If this table has a renamedFrom that exists in current, it's a rename, not new. */
    const def = newSchema[t];
    const config: SchemaTableConfig = typeof def === 'string' ? { indexes: def } : def;
    if (config.renamedFrom && currentTables.includes(config.renamedFrom)) return false;
    return true;
  });

  if (addedTables.length > 0) {
    parts.push('-- ============================================================');
    parts.push('-- NEW TABLES');
    parts.push('-- ============================================================');
    parts.push('');

    for (const tableName of addedTables) {
      const definition = newSchema[tableName];
      const config: SchemaTableConfig =
        typeof definition === 'string' ? { indexes: definition } : definition;
      parts.push(generateTableSQL(tableName, config));
      parts.push('');
    }
  }

  /* ---- Removed tables (in current but not new, excluding renamed-from tables) ---- */

  const removedTables = currentTables.filter(
    (t) => !newTables.includes(t) && !renamedFromSet.has(t)
  );

  if (removedTables.length > 0) {
    parts.push('-- ============================================================');
    parts.push('-- REMOVED TABLES (commented out for safety — review before uncommenting)');
    parts.push('-- ============================================================');
    parts.push('');

    for (const tableName of removedTables) {
      parts.push(`-- drop table if exists ${tableName} cascade;`);
    }
    parts.push('');
  }

  /* ---- Column-level changes for tables that exist in both schemas ---- */

  const sharedTables = newTables.filter((t) => currentTables.includes(t));
  const columnChanges: string[] = [];

  for (const tableName of sharedTables) {
    const currentDef = currentSchema[tableName];
    const newDef = newSchema[tableName];

    const currentConfig: SchemaTableConfig =
      typeof currentDef === 'string' ? { indexes: currentDef } : currentDef;
    const newConfig: SchemaTableConfig = typeof newDef === 'string' ? { indexes: newDef } : newDef;

    /* Collect all columns from each schema version (indexes + sqlColumns). */
    const currentFields = collectFields(currentConfig);
    const newFields = collectFields(newConfig);

    /*
     * Build a reverse rename map for this table so that a renamed column
     * is not treated as both "removed" and "added".
     */
    const renamedNewToOld = newConfig.renamedColumns || {};
    const renamedOldNames = new Set(Object.values(renamedNewToOld));
    const renamedNewNames = new Set(Object.keys(renamedNewToOld));

    /* New columns → ALTER TABLE ADD COLUMN (skip renamed columns). */
    for (const field of newFields) {
      if (renamedNewNames.has(field)) continue;
      if (!currentFields.has(field)) {
        const sqlType = resolveColumnType(newConfig, field);
        const quotedName = quoteIfReserved(field);
        columnChanges.push(`alter table ${tableName} add column ${quotedName} ${sqlType};`);
      }
    }

    /* Removed columns → commented-out ALTER TABLE DROP COLUMN (skip renamed columns). */
    for (const field of currentFields) {
      if (renamedOldNames.has(field)) continue;
      if (!newFields.has(field)) {
        const quotedName = quoteIfReserved(field);
        columnChanges.push(`-- alter table ${tableName} drop column ${quotedName};`);
      }
    }

    /* Column renames on shared tables (table name unchanged but columns renamed). */
    if (newConfig.renamedColumns) {
      for (const [newCol, oldCol] of Object.entries(newConfig.renamedColumns)) {
        if (currentFields.has(oldCol)) {
          const quotedOld = quoteIfReserved(oldCol);
          const quotedNew = quoteIfReserved(newCol);
          columnChanges.push(
            `alter table ${tableName} rename column ${quotedOld} to ${quotedNew};`
          );
        }
      }
    }
  }

  if (columnChanges.length > 0) {
    parts.push('-- ============================================================');
    parts.push('-- COLUMN CHANGES');
    parts.push('-- ============================================================');
    parts.push('');
    parts.push(...columnChanges);
    parts.push('');
  }

  /* If no changes were detected, return an empty string. */
  const hasChanges =
    renameStatements.length > 0 ||
    addedTables.length > 0 ||
    removedTables.length > 0 ||
    columnChanges.length > 0;

  if (!hasChanges) {
    return '';
  }

  return parts.join('\n');
}

/**
 * Resolve the SQL column type for a field, checking `fields` first, then
 * `sqlColumns`, then falling back to name-based inference.
 *
 * @param config - The per-table configuration.
 * @param fieldName - The column name.
 * @returns The SQL type string.
 */
function resolveColumnType(config: SchemaTableConfig, fieldName: string): string {
  if (config.fields?.[fieldName]) {
    return config.sqlColumns?.[fieldName] ?? mapFieldToSQL(config.fields[fieldName], fieldName);
  }
  return config.sqlColumns?.[fieldName] ?? inferColumnType(fieldName);
}

/**
 * Collect all app-specific field names from a table config.
 *
 * Combines fields from the index string and the `sqlColumns` map, excluding
 * system columns (which are always present and never user-managed).
 *
 * @param config - The per-table configuration.
 * @returns A set of field names.
 */
function collectFields(config: SchemaTableConfig): Set<string> {
  const systemColumnNames = new Set(SYSTEM_COLUMNS.map(([name]) => name));
  const fields = new Set<string>();

  /* Fields from the declarative `fields` map. */
  if (config.fields) {
    for (const field of Object.keys(config.fields)) {
      if (!systemColumnNames.has(field)) {
        fields.add(field);
      }
    }
  }

  /* Fields from the index string. */
  for (const field of parseIndexFields(config.indexes || '')) {
    if (!systemColumnNames.has(field)) {
      fields.add(field);
    }
  }

  /* Fields from explicit sqlColumns. */
  if (config.sqlColumns) {
    for (const field of Object.keys(config.sqlColumns)) {
      if (!systemColumnNames.has(field)) {
        fields.add(field);
      }
    }
  }

  return fields;
}
