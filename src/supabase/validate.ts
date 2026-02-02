/**
 * Supabase Credential Validation
 *
 * Tests connectivity to a Supabase project using provided credentials.
 * Used during setup flows to verify user-inputted URL and anon key.
 */

import { createClient } from '@supabase/supabase-js';

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
