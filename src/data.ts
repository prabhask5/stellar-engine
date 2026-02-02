/**
 * Generic CRUD and Query Operations
 *
 * Replaces repository infrastructure boilerplate.
 * Uses Supabase table names as the API surface, internally resolves to Dexie table names.
 */

import { getTableMap, getTableColumns } from './config';
import { getDb } from './database';
import { queueCreateOperation, queueDeleteOperation, queueSyncOperation } from './queue';
import { markEntityModified, scheduleSyncPush } from './engine';
import { generateId, now } from './utils';
import { debugError } from './debug';
import { supabase } from './supabase/client';

// ============================================================
// HELPERS
// ============================================================

function getDexieTableName(supabaseName: string): string {
  const map = getTableMap();
  return map[supabaseName] || supabaseName;
}

// ============================================================
// SINGLE-ENTITY WRITE OPERATIONS
// ============================================================

/**
 * Create a new entity. Auto: transaction + queue + markModified + schedulePush.
 * Caller provides all fields including id, timestamps, etc.
 */
export async function engineCreate(
  table: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const db = getDb();
  const dexieTable = getDexieTableName(table);
  const entityId = (data.id as string) || generateId();
  const payload = { ...data, id: entityId };

  // Separate out id for the queue payload (queue stores id separately)
  const { id: _id, ...queuePayload } = payload;

  await db.transaction('rw', [db.table(dexieTable), db.table('syncQueue')], async () => {
    await db.table(dexieTable).add(payload);
    await queueCreateOperation(table, entityId, queuePayload);
  });

  markEntityModified(entityId);
  scheduleSyncPush();

  return payload;
}

/**
 * Update an entity's fields. Auto-sets updated_at, queues sync, marks modified.
 */
export async function engineUpdate(
  table: string,
  id: string,
  fields: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const db = getDb();
  const dexieTable = getDexieTableName(table);
  const timestamp = now();
  const updateFields = { ...fields, updated_at: timestamp };

  let updated: Record<string, unknown> | undefined;
  await db.transaction('rw', [db.table(dexieTable), db.table('syncQueue')], async () => {
    await db.table(dexieTable).update(id, updateFields);
    updated = await db.table(dexieTable).get(id);
    if (updated) {
      await queueSyncOperation({
        table,
        entityId: id,
        operationType: 'set',
        value: updateFields
      });
    }
  });

  if (updated) {
    markEntityModified(id);
    scheduleSyncPush();
  }

  return updated;
}

/**
 * Soft-delete an entity. Sets deleted=true, queues delete op.
 */
export async function engineDelete(table: string, id: string): Promise<void> {
  const db = getDb();
  const dexieTable = getDexieTableName(table);
  const timestamp = now();

  await db.transaction('rw', [db.table(dexieTable), db.table('syncQueue')], async () => {
    await db.table(dexieTable).update(id, { deleted: true, updated_at: timestamp });
    await queueDeleteOperation(table, id);
  });

  markEntityModified(id);
  scheduleSyncPush();
}

// ============================================================
// BATCH WRITE OPERATION
// ============================================================

export type BatchOperation =
  | { type: 'create'; table: string; data: Record<string, unknown> }
  | { type: 'update'; table: string; id: string; fields: Record<string, unknown> }
  | { type: 'delete'; table: string; id: string };

/**
 * Execute multiple write operations in a single atomic transaction.
 * All ops succeed or all roll back.
 */
export async function engineBatchWrite(operations: BatchOperation[]): Promise<void> {
  const db = getDb();
  const timestamp = now();

  // Collect all unique Dexie table names needed for the transaction scope
  const tableNames = new Set<string>();
  tableNames.add('syncQueue');
  for (const op of operations) {
    tableNames.add(getDexieTableName(op.table));
  }

  const tables = Array.from(tableNames).map(name => db.table(name));
  const modifiedIds: string[] = [];

  await db.transaction('rw', tables, async () => {
    for (const op of operations) {
      const dexieTable = getDexieTableName(op.table);

      switch (op.type) {
        case 'create': {
          const entityId = (op.data.id as string) || generateId();
          const payload = { ...op.data, id: entityId };
          const { id: _id, ...queuePayload } = payload;
          await db.table(dexieTable).add(payload);
          await queueCreateOperation(op.table, entityId, queuePayload);
          modifiedIds.push(entityId);
          break;
        }
        case 'update': {
          const updateFields = { ...op.fields, updated_at: timestamp };
          await db.table(dexieTable).update(op.id, updateFields);
          await queueSyncOperation({
            table: op.table,
            entityId: op.id,
            operationType: 'set',
            value: updateFields
          });
          modifiedIds.push(op.id);
          break;
        }
        case 'delete': {
          await db.table(dexieTable).update(op.id, { deleted: true, updated_at: timestamp });
          await queueDeleteOperation(op.table, op.id);
          modifiedIds.push(op.id);
          break;
        }
      }
    }
  });

  for (const id of modifiedIds) {
    markEntityModified(id);
  }
  scheduleSyncPush();
}

// ============================================================
// INCREMENT OPERATION
// ============================================================

/**
 * Increment a numeric field on an entity, preserving increment intent for conflict resolution.
 * Uses increment operationType in the sync queue so multi-device increments are additive.
 * Optionally sets additional fields (e.g., completed, updated_at) alongside the increment.
 */
export async function engineIncrement(
  table: string,
  id: string,
  field: string,
  amount: number,
  additionalFields?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const db = getDb();
  const dexieTable = getDexieTableName(table);
  const timestamp = now();

  let updated: Record<string, unknown> | undefined;
  await db.transaction('rw', [db.table(dexieTable), db.table('syncQueue')], async () => {
    // Read current value inside transaction to prevent TOCTOU race
    const current = await db.table(dexieTable).get(id);
    if (!current) return;

    const currentValue = (current[field] as number) || 0;
    const newValue = currentValue + amount;
    const updateFields: Record<string, unknown> = {
      [field]: newValue,
      updated_at: timestamp,
      ...additionalFields
    };

    await db.table(dexieTable).update(id, updateFields);
    updated = await db.table(dexieTable).get(id);
    if (updated) {
      await queueSyncOperation({
        table,
        entityId: id,
        operationType: 'increment',
        field,
        value: amount
      });
      // Queue additional fields as a separate set operation if present
      if (additionalFields && Object.keys(additionalFields).length > 0) {
        await queueSyncOperation({
          table,
          entityId: id,
          operationType: 'set',
          value: { ...additionalFields, updated_at: timestamp }
        });
      }
    }
  });

  if (updated) {
    markEntityModified(id);
    scheduleSyncPush();
  }

  return updated;
}

// ============================================================
// QUERY OPERATIONS
// ============================================================

/**
 * Get a single entity by ID. Optional remote fallback if not found locally.
 */
export async function engineGet(
  table: string,
  id: string,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const dexieTable = getDexieTableName(table);

  const local = await db.table(dexieTable).get(id);
  if (local) return local as Record<string, unknown>;

  if (opts?.remoteFallback && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const columns = getTableColumns(table);
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .eq('id', id)
        .or('deleted.is.null,deleted.eq.false')
        .maybeSingle();

      if (!error && data) {
        await db.table(dexieTable).put(data);
        return data as unknown as Record<string, unknown>;
      }
    } catch (e) {
      debugError(`[Data] Remote fallback failed for ${table}/${id}:`, e);
    }
  }

  return null;
}

/**
 * Get all entities from a table. Optional ordering and remote fallback.
 */
export async function engineGetAll(
  table: string,
  opts?: { orderBy?: string; remoteFallback?: boolean }
): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const dexieTable = getDexieTableName(table);

  let results: Record<string, unknown>[];
  if (opts?.orderBy) {
    results = await db.table(dexieTable).orderBy(opts.orderBy).toArray();
  } else {
    results = await db.table(dexieTable).toArray();
  }

  if (results.length === 0 && opts?.remoteFallback && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const columns = getTableColumns(table);
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .or('deleted.is.null,deleted.eq.false');

      if (!error && data && data.length > 0) {
        await db.table(dexieTable).bulkPut(data);
        if (opts?.orderBy) {
          results = await db.table(dexieTable).orderBy(opts.orderBy).toArray();
        } else {
          results = data as unknown as Record<string, unknown>[];
        }
      }
    } catch (e) {
      debugError(`[Data] Remote fallback failed for ${table}:`, e);
    }
  }

  return results;
}

/**
 * Query entities by index value (WHERE index = value).
 */
export async function engineQuery(
  table: string,
  index: string,
  value: unknown,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const dexieTable = getDexieTableName(table);

  let results = await db.table(dexieTable).where(index).equals(value as string).toArray();

  if (results.length === 0 && opts?.remoteFallback && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const columns = getTableColumns(table);
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .eq(index, value as string)
        .or('deleted.is.null,deleted.eq.false');

      if (!error && data && data.length > 0) {
        await db.table(dexieTable).bulkPut(data);
        results = data as unknown as Record<string, unknown>[];
      }
    } catch (e) {
      debugError(`[Data] Remote query fallback failed for ${table}.${index}:`, e);
    }
  }

  return results;
}

/**
 * Range query (WHERE index BETWEEN lower AND upper).
 */
export async function engineQueryRange(
  table: string,
  index: string,
  lower: unknown,
  upper: unknown,
  opts?: { remoteFallback?: boolean }
): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const dexieTable = getDexieTableName(table);

  let results = await db.table(dexieTable).where(index).between(lower, upper, true, true).toArray();

  if (results.length === 0 && opts?.remoteFallback && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const columns = getTableColumns(table);
      const { data, error } = await supabase
        .from(table)
        .select(columns)
        .gte(index, lower as string)
        .lte(index, upper as string)
        .or('deleted.is.null,deleted.eq.false');

      if (!error && data && data.length > 0) {
        await db.table(dexieTable).bulkPut(data);
        results = data as unknown as Record<string, unknown>[];
      }
    } catch (e) {
      debugError(`[Data] Remote range query fallback failed for ${table}.${index}:`, e);
    }
  }

  return results;
}

/**
 * Singleton get-or-create with optional remote check.
 * Used for patterns like focus_settings where one record per user exists.
 */
export async function engineGetOrCreate(
  table: string,
  index: string,
  value: unknown,
  defaults: Record<string, unknown>,
  opts?: { checkRemote?: boolean }
): Promise<Record<string, unknown>> {
  const db = getDb();
  const dexieTable = getDexieTableName(table);

  // Check local first
  const localResults = await db.table(dexieTable).where(index).equals(value as string).toArray();
  const existing = localResults.find((r: Record<string, unknown>) => !r.deleted);
  if (existing) return existing as Record<string, unknown>;

  // Check remote if requested
  if (opts?.checkRemote && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const columns = getTableColumns(table);
      const { data } = await supabase
        .from(table)
        .select(columns)
        .eq(index, value as string)
        .is('deleted', null)
        .maybeSingle();

      if (data) {
        await db.table(dexieTable).put(data);
        return data as unknown as Record<string, unknown>;
      }
    } catch {
      // Offline or network error - fall through to local create
    }
  }

  // Create new
  const entityId = generateId();
  const timestamp = now();
  const payload = {
    id: entityId,
    ...defaults,
    created_at: timestamp,
    updated_at: timestamp
  };

  const { id: _id, ...queuePayload } = payload;

  await db.transaction('rw', [db.table(dexieTable), db.table('syncQueue')], async () => {
    await db.table(dexieTable).add(payload);
    await queueCreateOperation(table, entityId, queuePayload);
  });

  markEntityModified(entityId);
  scheduleSyncPush();

  return payload;
}
