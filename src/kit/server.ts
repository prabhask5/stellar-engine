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

// =============================================================================
//  TYPES
// =============================================================================

/**
 * Shape of a single environment variable returned by the Vercel API.
 *
 * Used internally when listing existing env vars to find an entry's ID
 * for the update (PATCH) operation.
 */
interface VercelEnvVar {
  /** Unique identifier for this env var entry. */
  id: string;

  /** The environment variable name (e.g. `PUBLIC_SUPABASE_URL`). */
  key: string;

  /** The environment variable value. */
  value: string;

  /** Deployment targets this var applies to (e.g. `['production', 'preview']`). */
  target: string[];

  /** The variable type (`'plain'`, `'encrypted'`, `'secret'`, etc.). */
  type: string;
}

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

  /** The Supabase publishable key for client-side access. */
  supabasePublishableKey: string;

  /** Production domain (e.g., `https://stellar.example.com`). Set as `PUBLIC_APP_DOMAIN` env var. */
  appDomain: string;
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
  /** `true` when `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, and `PUBLIC_APP_DOMAIN` are all set. */
  configured: boolean;

  /** The Supabase project URL, if configured. */
  supabaseUrl?: string;

  /** The Supabase publishable key, if configured. */
  supabasePublishableKey?: string;

  /** Production domain (e.g., `https://stellar.example.com`). */
  appDomain?: string;
}

// =============================================================================
//  HELPERS — Vercel API Utilities
// =============================================================================

/**
 * Low-level wrapper around the Vercel REST API.
 *
 * Handles authentication headers and JSON body serialization for all
 * Vercel API calls. This is an internal helper — not exported.
 *
 * @param path   - The API path (appended to `https://api.vercel.com`).
 * @param token  - The Vercel bearer token for authorization.
 * @param method - HTTP method (defaults to `'GET'`).
 * @param body   - Optional request body, serialized to JSON.
 *
 * @returns The raw `Response` from the Vercel API.
 *
 * @throws {TypeError} If the `fetch` call itself fails (e.g. network error).
 */
async function vercelApi(path: string, token: string, method = 'GET', body?: unknown) {
  return fetch(`https://api.vercel.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

/**
 * Creates or updates a single environment variable on a Vercel project.
 *
 * Implements an upsert strategy:
 *   1. Attempt to create via `POST /v10/projects/:id/env`.
 *   2. If Vercel returns `ENV_ALREADY_EXISTS`, list all env vars to find
 *      the existing entry's ID, then patch it with the new value.
 *
 * This two-step approach is necessary because Vercel's create endpoint
 * does not support an "upsert" mode — it always fails if the key exists.
 *
 * @param projectId - The Vercel project ID.
 * @param token     - The Vercel bearer token.
 * @param key       - The environment variable name to set.
 * @param value     - The environment variable value.
 *
 * @throws {Error} If the create fails for a reason other than already-exists,
 *                 or if the list/patch fallback also fails.
 */
async function setEnvVar(
  projectId: string,
  token: string,
  key: string,
  value: string
): Promise<void> {
  const createRes = await vercelApi(`/v10/projects/${projectId}/env`, token, 'POST', {
    key,
    value,
    target: ['production', 'preview', 'development'],
    type: 'plain'
  });

  if (createRes.ok) return;

  const createData = await createRes.json();
  const errorCode = createData.error?.code || '';
  const errorMessage = createData.error?.message || '';

  /* If the variable already exists, fall through to the update path.
     Vercel may report this via error code or message text depending
     on the API version, so we check both. */
  if (errorCode === 'ENV_ALREADY_EXISTS' || errorMessage.includes('already exists')) {
    /* List all env vars to find the existing entry's ID — Vercel requires
       the entry ID for PATCH operations, not the key name. */
    const listRes = await vercelApi(`/v9/projects/${projectId}/env`, token);
    if (!listRes.ok) {
      throw new Error(`Failed to list env vars: ${listRes.statusText}`);
    }
    const listData = await listRes.json();
    const existing = listData.envs?.find((e: VercelEnvVar) => e.key === key);

    if (existing) {
      const updateRes = await vercelApi(
        `/v9/projects/${projectId}/env/${existing.id}`,
        token,
        'PATCH',
        { value }
      );
      if (!updateRes.ok) {
        throw new Error(`Failed to update env var ${key}: ${updateRes.statusText}`);
      }
    } else {
      /* Edge case: Vercel says the var exists but it's not in the list.
         This can happen with env var scoping issues. */
      throw new Error(`Env var ${key} reported as existing but not found in list`);
    }
  } else {
    throw new Error(
      `Failed to create env var ${key}: ${createData.error?.message || createRes.statusText}`
    );
  }
}

// =============================================================================
//  PUBLIC API
// =============================================================================

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
export function getServerConfig(): ServerConfig {
  const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || '';
  const supabasePublishableKey = process.env.PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || '';
  const appDomain = process.env.PUBLIC_APP_DOMAIN || '';

  if (supabaseUrl && supabasePublishableKey && appDomain) {
    return {
      configured: true,
      supabaseUrl,
      supabasePublishableKey,
      appDomain
    };
  }
  return { configured: false };
}

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
 *   supabasePublishableKey: 'eyJ...'
 * });
 * if (!result.success) console.error(result.error);
 * ```
 *
 * @see {@link DeployConfig} for the input configuration shape
 * @see {@link DeployResult} for the return type shape
 * @see {@link setEnvVar} for the upsert strategy used for env vars
 */
export async function deployToVercel(config: DeployConfig): Promise<DeployResult> {
  try {
    // -------------------------------------------------------------------------
    //  Phase 1 — Upsert environment variables
    // -------------------------------------------------------------------------
    await setEnvVar(
      config.projectId,
      config.vercelToken,
      'PUBLIC_SUPABASE_URL',
      config.supabaseUrl
    );
    await setEnvVar(
      config.projectId,
      config.vercelToken,
      'PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY',
      config.supabasePublishableKey
    );

    await setEnvVar(config.projectId, config.vercelToken, 'PUBLIC_APP_DOMAIN', config.appDomain);

    // -------------------------------------------------------------------------
    //  Phase 2 — Trigger production redeployment
    // -------------------------------------------------------------------------
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL;
    const gitRepo = process.env.VERCEL_GIT_REPO_SLUG;
    const gitOwner = process.env.VERCEL_GIT_REPO_OWNER;
    const gitRef = process.env.VERCEL_GIT_COMMIT_REF || 'main';

    let deploymentUrl = '';

    /* Strategy A — Git-based redeployment (preferred).
       Uses the connected GitHub repo to trigger a fresh build from source.
       Only available when Vercel has git integration metadata. */
    if (gitRepo && gitOwner) {
      const deployRes = await vercelApi(`/v13/deployments`, config.vercelToken, 'POST', {
        name: config.projectId,
        project: config.projectId,
        target: 'production',
        gitSource: {
          type: 'github',
          repoId: `${gitOwner}/${gitRepo}`,
          ref: gitRef
        }
      });

      if (deployRes.ok) {
        const deployData = await deployRes.json();
        deploymentUrl = deployData.url || '';
      }
    }

    /* Strategy B — Clone current deployment (fallback).
       Reuses the most recent deployment's build output with the newly
       updated env vars. Used when git metadata is unavailable (e.g.
       manual deploys or Vercel CLI uploads). */
    if (!deploymentUrl && deploymentId) {
      const redeployRes = await vercelApi(`/v13/deployments`, config.vercelToken, 'POST', {
        name: config.projectId,
        project: config.projectId,
        target: 'production',
        deploymentId
      });

      if (redeployRes.ok) {
        const redeployData = await redeployRes.json();
        deploymentUrl = redeployData.url || '';
      }
    }

    return { success: true, deploymentUrl };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Factory returning a SvelteKit POST handler that validates Supabase
 * credentials by attempting to connect to the provided Supabase instance.
 *
 * The returned handler:
 *   1. Parses the JSON request body for `supabaseUrl` and `supabasePublishableKey`
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
export function createValidateHandler() {
  return async ({ request }: { request: Request }): Promise<Response> => {
    /* Dynamic import keeps the Supabase client out of the module graph
       until this handler is actually invoked — reduces cold start time
       for routes that don't need validation. */
    const { validateSupabaseCredentials } = await import('../supabase/validate.js');
    try {
      const { supabaseUrl, supabasePublishableKey } = await request.json();

      if (!supabaseUrl || !supabasePublishableKey) {
        return new Response(
          JSON.stringify({ valid: false, error: 'Supabase URL and Publishable Key are required' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const result = await validateSupabaseCredentials(supabaseUrl, supabasePublishableKey);
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      return new Response(
        JSON.stringify({ valid: false, error: `Could not connect to Supabase: ${message}` }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }
  };
}
