/**
 * Admin Check
 *
 * Delegates to config.auth.adminCheck or returns false.
 */

import type { User } from '@supabase/supabase-js';
import { getEngineConfig } from '../config';

/**
 * Check if a user has admin privileges.
 * Uses the adminCheck function from engine config if provided.
 */
export function isAdmin(user: User | null): boolean {
  try {
    const config = getEngineConfig();
    // Single-user mode: always admin
    if (config.auth?.mode === 'single-user') return true;
    if (config.auth?.adminCheck) {
      return config.auth.adminCheck(user);
    }
  } catch {
    // Engine not initialized yet
  }
  return false;
}
