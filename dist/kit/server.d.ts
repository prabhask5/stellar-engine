/**
 * @fileoverview Server-side API helpers for SvelteKit route handlers.
 *
 * Extracts reusable backend logic so scaffolded API routes can be thin wrappers.
 */
/** Configuration for deploying Supabase credentials to Vercel. */
export interface DeployConfig {
    vercelToken: string;
    projectId: string;
    supabaseUrl: string;
    supabaseAnonKey: string;
}
/** Result of a Vercel deployment attempt. */
export interface DeployResult {
    success: boolean;
    deploymentUrl?: string;
    error?: string;
}
/** Server config status returned by `getServerConfig()`. */
export interface ServerConfig {
    configured: boolean;
    supabaseUrl?: string;
    supabaseAnonKey?: string;
}
/**
 * Reads Supabase configuration from `process.env` at runtime.
 * Returns `{ configured: true, supabaseUrl, supabaseAnonKey }` when both
 * env vars exist, or `{ configured: false }` otherwise.
 */
export declare function getServerConfig(): ServerConfig;
/**
 * Full Vercel deployment flow: upsert env vars, then trigger a production
 * redeployment via git-based or clone-based strategy.
 */
export declare function deployToVercel(config: DeployConfig): Promise<DeployResult>;
/**
 * Factory returning a SvelteKit POST handler that validates Supabase credentials.
 * The handler parses the request body and delegates to `validateSupabaseCredentials`.
 */
export declare function createValidateHandler(): ({ request }: {
    request: Request;
}) => Promise<Response>;
//# sourceMappingURL=server.d.ts.map