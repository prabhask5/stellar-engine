/**
 * Supabase Validation
 *
 * 1. Credential validation: Tests connectivity using provided credentials (setup flows).
 * 2. Schema validation: Verifies that all configured Supabase tables exist and are accessible.
 */

import { createClient } from '@supabase/supabase-js';
import { getEngineConfig } from '../config';
import { supabase } from './client';
import { debugError, debugLog } from '../debug';

export async function validateSupabaseCredentials(
  url: string,
  anonKey: string,
  testTable?: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    new URL(url);
  } catch {
    return { valid: false, error: 'Invalid Supabase URL format' };
  }

  try {
    const tempClient = createClient(url, anonKey);

    // Test REST API reachability by attempting a simple query
    const { error } = await tempClient.from(testTable || '_health_check').select('id').limit(1);

    if (error) {
      // Bad credentials
      if (error.message?.includes('Invalid API key') || error.code === 'PGRST301') {
        return { valid: false, error: 'Invalid Supabase credentials. Check your URL and Anon Key.' };
      }
      // Table doesn't exist but API is reachable — credentials work, schema not set up yet
      if (error.message?.includes('relation') && error.message?.includes('does not exist')) {
        return { valid: true };
      }
      // Any other error
      return { valid: false, error: `Supabase responded with an error: ${error.message}` };
    }

    return { valid: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { valid: false, error: `Could not connect to Supabase: ${message}` };
  }
}

/**
 * Validates that all configured Supabase tables exist and are accessible.
 *
 * Fires `SELECT id FROM <table> LIMIT 0` per table — returns zero rows (no data egress)
 * but validates the table exists and RLS allows access.
 *
 * If `auth.mode === 'single-user'`, also validates the `single_user_config` table.
 */
export async function validateSchema(): Promise<{ valid: boolean; missingTables: string[]; errors: string[] }> {
  const config = getEngineConfig();
  const tableNames = config.tables.map(t => t.supabaseName);

  // single-user mode requires the single_user_config table
  if (config.auth?.mode === 'single-user') {
    tableNames.push('single_user_config');
  }

  const missingTables: string[] = [];
  const errors: string[] = [];

  for (const tableName of tableNames) {
    try {
      const { error } = await supabase.from(tableName).select('id').limit(0);
      if (error) {
        if (error.message?.includes('relation') && error.message?.includes('does not exist')) {
          missingTables.push(tableName);
          errors.push(`Table "${tableName}" does not exist`);
        } else if (error.message?.includes('permission denied') || error.code === '42501') {
          errors.push(`Table "${tableName}" exists but is not accessible (RLS or permissions error): ${error.message}`);
        } else {
          errors.push(`Table "${tableName}": ${error.message}`);
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      errors.push(`Table "${tableName}": ${message}`);
    }
  }

  const valid = missingTables.length === 0 && errors.length === 0;

  if (valid) {
    debugLog('[Schema] All configured tables validated successfully');
  } else {
    for (const err of errors) {
      debugError('[Schema]', err);
    }
  }

  return { valid, missingTables, errors };
}
