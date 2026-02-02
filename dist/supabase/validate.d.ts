/**
 * Supabase Credential Validation
 *
 * Tests connectivity to a Supabase project using provided credentials.
 * Used during setup flows to verify user-inputted URL and anon key.
 */
export declare function validateSupabaseCredentials(url: string, anonKey: string, testTable?: string): Promise<{
    valid: boolean;
    error?: string;
}>;
//# sourceMappingURL=validate.d.ts.map