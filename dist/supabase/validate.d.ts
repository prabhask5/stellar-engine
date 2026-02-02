/**
 * Supabase Validation
 *
 * 1. Credential validation: Tests connectivity using provided credentials (setup flows).
 * 2. Schema validation: Verifies that all configured Supabase tables exist and are accessible.
 */
export declare function validateSupabaseCredentials(url: string, anonKey: string, testTable?: string): Promise<{
    valid: boolean;
    error?: string;
}>;
/**
 * Validates that all configured Supabase tables exist and are accessible.
 *
 * Fires `SELECT id FROM <table> LIMIT 0` per table — returns zero rows (no data egress)
 * but validates the table exists and RLS allows access.
 *
 * If device verification is enabled, also validates the `trusted_devices` table.
 */
export declare function validateSchema(): Promise<{
    valid: boolean;
    missingTables: string[];
    errors: string[];
}>;
//# sourceMappingURL=validate.d.ts.map