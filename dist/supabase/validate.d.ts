/**
 * @fileoverview Supabase Validation Module
 *
 * Provides two complementary validation capabilities:
 *
 * 1. **Credential validation** (`validateSupabaseCredentials`):
 *    Tests that a given Supabase URL and anon key are well-formed and can
 *    reach the Supabase REST API. Used during setup / onboarding flows
 *    where the user manually enters their project credentials.
 *
 * 2. **Schema validation** (`validateSchema`):
 *    Verifies that every table declared in the engine config actually exists
 *    in the Supabase project and is accessible under the current RLS policies.
 *    This is a "smoke test" that catches misconfiguration early, before the
 *    sync engine attempts real reads/writes and produces cryptic errors.
 *
 * Security considerations:
 *   - Credential validation creates a **temporary** `SupabaseClient` scoped
 *     to the function call; it does not leak into the module-level singleton.
 *   - Schema validation queries use `LIMIT 0`, so no user data is fetched —
 *     the query only confirms that the table exists and RLS allows access.
 *   - Error messages are deliberately generic to avoid leaking internal
 *     database structure to end users; detailed errors go to `debugError`.
 *
 * Integration patterns:
 *   - Called from setup wizards, admin panels, and health-check utilities.
 *   - `validateSchema` uses the shared `supabase` proxy from `./client.ts`,
 *     so it benefits from the same lazy-init and session management.
 *
 * @module supabase/validate
 */
/**
 * Validate Supabase credentials by attempting a lightweight API call.
 *
 * This function is designed for **setup flows** where a user provides their
 * Supabase URL and anon key and the app needs to verify them before saving.
 *
 * Validation steps:
 * 1. Parse the URL to ensure it is syntactically valid.
 * 2. Create a disposable `SupabaseClient` with the provided credentials.
 * 3. Issue a `SELECT id FROM <testTable> LIMIT 1` query.
 * 4. Interpret the response:
 *    - Success or "relation does not exist" => credentials are valid (the
 *      API responded, so URL + key are correct; the table simply may not
 *      have been created yet).
 *    - "Invalid API key" / PGRST301 => credentials are wrong.
 *    - Network error => Supabase is unreachable.
 *
 * @param url       - The Supabase project URL (e.g. `https://xyz.supabase.co`).
 * @param anonKey   - The project's anonymous (public) API key.
 * @param testTable - Optional table name to query. Defaults to `'_health_check'`.
 *                    Using a table that does not exist is fine — we only care
 *                    whether the API responds, not whether the table is present.
 * @returns An object with `valid: true` on success, or `valid: false` plus an
 *          `error` message describing what went wrong.
 *
 * @example
 * ```ts
 * const result = await validateSupabaseCredentials(
 *   'https://abc.supabase.co',
 *   'eyJhbGci...',
 *   'profiles'
 * );
 * if (!result.valid) {
 *   showError(result.error);
 * }
 * ```
 *
 * @see {@link validateSchema} — for post-setup table existence checks
 */
export declare function validateSupabaseCredentials(url: string, anonKey: string, testTable?: string): Promise<{
    valid: boolean;
    error?: string;
}>;
/**
 * Validate that all tables declared in the engine configuration exist in
 * Supabase and are accessible under the current RLS policies.
 *
 * For each table the function executes:
 * ```sql
 * SELECT id FROM <table> LIMIT 0
 * ```
 * This returns **zero rows** (no data egress, minimal latency) but still
 * exercises the full PostgREST pipeline — table lookup, RLS policy
 * evaluation, and column resolution. If any of these steps fail, the table
 * is flagged.
 *
 * When device verification is enabled in the engine config, the
 * `trusted_devices` table is automatically appended to the check list.
 *
 * Error categorization:
 * - **Missing table**: The relation does not exist in the database.
 * - **Permission denied (42501)**: The table exists but RLS or grants
 *   prevent the anon role from reading it.
 * - **Other**: Any unexpected PostgREST or network error.
 *
 * @returns An object containing:
 *   - `valid` — `true` when all tables pass, `false` otherwise.
 *   - `missingTables` — names of tables that do not exist at all.
 *   - `errors` — human-readable descriptions of every issue found.
 *
 * @example
 * ```ts
 * const { valid, missingTables, errors } = await validateSchema();
 * if (!valid) {
 *   console.error('Schema issues:', errors);
 *   // Prompt user to run migrations or fix RLS policies
 * }
 * ```
 *
 * @see {@link validateSupabaseCredentials} — for pre-setup credential checks
 */
export declare function validateSchema(): Promise<{
    valid: boolean;
    missingTables: string[];
    errors: string[];
}>;
//# sourceMappingURL=validate.d.ts.map