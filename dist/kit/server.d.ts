/**
 * @fileoverview Server-side API helpers for SvelteKit route handlers.
 *
 * This module extracts reusable backend logic so scaffolded API routes can be
 * thin wrappers around these helpers. It provides three main capabilities:
 *
 *   - **Server config reading** — reads Supabase credentials from environment
 *     variables at runtime (`getServerConfig`)
 *   - **Vercel deployment** — upserts env vars and triggers production
 *     redeployments via the Vercel REST API (`deployToVercel`)
 *   - **Credential validation** — factory for a SvelteKit POST handler that
 *     validates Supabase credentials (`createValidateHandler`)
 *
 * All Vercel API interactions use a create-or-update (upsert) strategy for
 * environment variables, and support both git-based and clone-based
 * redeployment strategies for maximum compatibility.
 *
 * @module kit/server
 *
 * @example
 * ```ts
 * // In /api/config/+server.ts
 * import { getServerConfig } from 'stellar-drive/kit/server';
 * export function GET() {
 *   return new Response(JSON.stringify(getServerConfig()));
 * }
 * ```
 *
 * @see {@link https://vercel.com/docs/rest-api} for Vercel API reference
 * @see {@link validateSupabaseCredentials} in `supabase/validate.ts`
 */
/**
 * Configuration for deploying Supabase credentials to Vercel.
 *
 * Contains all the information needed to authenticate with Vercel,
 * identify the target project, and set the Supabase connection values.
 */
export interface DeployConfig {
    /** Vercel personal access token or team token for API authentication. */
    vercelToken: string;
    /** The Vercel project ID (found in project settings). */
    projectId: string;
    /** The Supabase project URL (e.g. `https://abc.supabase.co`). */
    supabaseUrl: string;
    /** The Supabase anonymous/public key for client-side access. */
    supabaseAnonKey: string;
}
/**
 * Result of a Vercel deployment attempt.
 *
 * On success, includes the deployment URL. On failure, includes
 * the error message from the Vercel API or internal exception.
 */
export interface DeployResult {
    /** Whether the env var upsert and redeployment completed without errors. */
    success: boolean;
    /**
     * The Vercel deployment URL for the triggered build.
     * Only present when `success` is `true` and Vercel returns a URL.
     */
    deploymentUrl?: string;
    /**
     * Error message describing what went wrong.
     * Only present when `success` is `false`.
     */
    error?: string;
}
/**
 * Server config status returned by `getServerConfig()`.
 *
 * Indicates whether the required Supabase environment variables are
 * present in the server's runtime environment.
 */
export interface ServerConfig {
    /** `true` when both `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` are set. */
    configured: boolean;
    /** The Supabase project URL, if configured. */
    supabaseUrl?: string;
    /** The Supabase anonymous key, if configured. */
    supabaseAnonKey?: string;
}
/**
 * Reads Supabase configuration from `process.env` at runtime.
 *
 * Checks for the presence of both `PUBLIC_SUPABASE_URL` and
 * `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` environment variables.
 * Returns `{ configured: true }` with the values when both exist,
 * or `{ configured: false }` otherwise.
 *
 * This is intended for use in SvelteKit server routes (e.g. `+server.ts`)
 * to report configuration status to the client during the setup flow.
 *
 * @returns The server config status with optional Supabase credentials.
 *
 * @example
 * ```ts
 * // In /api/config/+server.ts
 * import { getServerConfig } from 'stellar-drive/kit/server';
 * export function GET() {
 *   return new Response(JSON.stringify(getServerConfig()), {
 *     headers: { 'Content-Type': 'application/json' }
 *   });
 * }
 * ```
 *
 * @see {@link ServerConfig} for the return type shape
 */
export declare function getServerConfig(): ServerConfig;
/**
 * Full Vercel deployment flow: upserts Supabase environment variables,
 * then triggers a production redeployment.
 *
 * The deployment uses a two-strategy approach:
 *   - **Strategy A (preferred)**: Git-based redeployment using the repo
 *     metadata from Vercel's environment (`VERCEL_GIT_REPO_SLUG`, etc.).
 *     This triggers a fresh build from the source branch.
 *   - **Strategy B (fallback)**: Clone-based redeployment using an existing
 *     deployment ID (`VERCEL_DEPLOYMENT_ID` or `VERCEL_URL`). This
 *     reuses the last build artifacts with updated env vars.
 *
 * Both strategies target the `production` environment.
 *
 * @param config - The deployment configuration containing Vercel auth
 *                 credentials, project ID, and Supabase connection values.
 *
 * @returns A result object indicating success/failure with an optional
 *          deployment URL or error message.
 *
 * @example
 * ```ts
 * const result = await deployToVercel({
 *   vercelToken: 'tok_...',
 *   projectId: 'prj_...',
 *   supabaseUrl: 'https://abc.supabase.co',
 *   supabaseAnonKey: 'eyJ...'
 * });
 * if (!result.success) console.error(result.error);
 * ```
 *
 * @see {@link DeployConfig} for the input configuration shape
 * @see {@link DeployResult} for the return type shape
 * @see {@link setEnvVar} for the upsert strategy used for env vars
 */
export declare function deployToVercel(config: DeployConfig): Promise<DeployResult>;
/**
 * Factory returning a SvelteKit POST handler that validates Supabase
 * credentials by attempting to connect to the provided Supabase instance.
 *
 * The returned handler:
 *   1. Parses the JSON request body for `supabaseUrl` and `supabaseAnonKey`
 *   2. Validates that both fields are present (returns 400 if not)
 *   3. Delegates to `validateSupabaseCredentials` for the actual check
 *   4. Returns a JSON response with the validation result
 *
 * The `validateSupabaseCredentials` import is dynamic (`await import(...)`)
 * to keep this module's dependency footprint minimal — the validation logic
 * and its Supabase client dependency are only loaded when the endpoint is
 * actually called.
 *
 * @returns An async handler function compatible with SvelteKit's
 *          `RequestHandler` signature for POST endpoints.
 *
 * @example
 * ```ts
 * // In /api/validate-supabase/+server.ts
 * import { createValidateHandler } from 'stellar-drive/kit/server';
 * export const POST = createValidateHandler();
 * ```
 *
 * @see {@link validateSupabaseCredentials} in `supabase/validate.ts`
 */
export declare function createValidateHandler(): ({ request }: {
    request: Request;
}) => Promise<Response>;
//# sourceMappingURL=server.d.ts.map