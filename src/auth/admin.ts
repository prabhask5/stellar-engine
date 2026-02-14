/**
 * @fileoverview Admin Privilege Resolution
 *
 * Provides a single entry point for determining whether a given Supabase user
 * holds administrative privileges within the application.
 *
 * Architecture:
 * - Delegates entirely to the host application's `config.auth.adminCheck` callback.
 * - In single-user mode, every authenticated user is implicitly an admin (there is
 *   only one user, so restricting admin access would be meaningless).
 * - If the engine has not been initialized yet (e.g., during early bootstrap),
 *   the function silently returns `false` rather than throwing, ensuring safe
 *   usage in guards and UI conditionals before full initialization.
 *
 * Security considerations:
 * - This is a **client-side convenience check** only. It must NOT be relied upon
 *   as an authorization boundary -- server-side RLS policies and edge-function
 *   guards are the true security layer.
 * - The `adminCheck` callback is provided by the host app and can inspect any
 *   property on the Supabase `User` object (e.g., `app_metadata.role`).
 *
 * @module auth/admin
 */

import type { User } from '@supabase/supabase-js';
import { getEngineConfig } from '../config';

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Check if a user has admin privileges.
 *
 * Uses the `adminCheck` function from engine config if provided.
 * Falls back to `false` when no check is configured or the engine
 * is not yet initialized.
 *
 * @param user - The Supabase user object to evaluate, or `null` if no user
 *               is currently authenticated.
 * @returns `true` if the user is considered an admin, `false` otherwise.
 *
 * @example
 * ```ts
 * import { isAdmin } from 'stellar-engine/auth/admin';
 *
 * const admin = isAdmin(currentUser);
 * if (admin) {
 *   showAdminPanel();
 * }
 * ```
 *
 * @see {@link getEngineConfig} for how the admin check callback is registered.
 */
export function isAdmin(user: User | null): boolean {
  try {
    const config = getEngineConfig();

    /* Single-user mode: the sole user owns everything, so admin is implicit. */
    if (config.auth?.mode === 'single-user') return true;

    if (config.auth?.adminCheck) {
      return config.auth.adminCheck(user);
    }
  } catch {
    /* Engine not initialized yet -- safe to swallow; callers expect a boolean. */
  }
  return false;
}
