/**
 * @fileoverview Server-side API helpers for SvelteKit route handlers.
 *
 * Extracts reusable backend logic so scaffolded API routes can be thin wrappers.
 */

// =============================================================================
//  TYPES
// =============================================================================

/** Shape of a single environment variable returned by the Vercel API. */
interface VercelEnvVar {
  id: string;
  key: string;
  value: string;
  target: string[];
  type: string;
}

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

// =============================================================================
//  HELPERS — Vercel API Utilities
// =============================================================================

/**
 * Low-level wrapper around the Vercel REST API.
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
 * Strategy:
 *  1. Attempt to create via `POST /v10/projects/:id/env`.
 *  2. If `ENV_ALREADY_EXISTS`, list all env vars to find the existing
 *     entry's ID, then patch it with the new value.
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

  if (errorCode === 'ENV_ALREADY_EXISTS' || errorMessage.includes('already exists')) {
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
 * Returns `{ configured: true, supabaseUrl, supabaseAnonKey }` when both
 * env vars exist, or `{ configured: false }` otherwise.
 */
export function getServerConfig(): ServerConfig {
  const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || '';
  const supabaseAnonKey = process.env.PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || '';

  if (supabaseUrl && supabaseAnonKey) {
    return { configured: true, supabaseUrl, supabaseAnonKey };
  }
  return { configured: false };
}

/**
 * Full Vercel deployment flow: upsert env vars, then trigger a production
 * redeployment via git-based or clone-based strategy.
 */
export async function deployToVercel(config: DeployConfig): Promise<DeployResult> {
  try {
    // Phase 1 — Upsert environment variables
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
      config.supabaseAnonKey
    );

    // Phase 2 — Trigger production redeployment
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_URL;
    const gitRepo = process.env.VERCEL_GIT_REPO_SLUG;
    const gitOwner = process.env.VERCEL_GIT_REPO_OWNER;
    const gitRef = process.env.VERCEL_GIT_COMMIT_REF || 'main';

    let deploymentUrl = '';

    // Strategy A — Git-based redeployment (preferred)
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

    // Strategy B — Clone current deployment (fallback)
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
 * Factory returning a SvelteKit POST handler that validates Supabase credentials.
 * The handler parses the request body and delegates to `validateSupabaseCredentials`.
 */
export function createValidateHandler() {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const { validateSupabaseCredentials } = await import('../supabase/validate.js');
    try {
      const { supabaseUrl, supabaseAnonKey } = await request.json();

      if (!supabaseUrl || !supabaseAnonKey) {
        return new Response(
          JSON.stringify({ valid: false, error: 'Supabase URL and Anon Key are required' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const result = await validateSupabaseCredentials(supabaseUrl, supabaseAnonKey);
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
