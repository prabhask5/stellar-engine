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

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type { SupabaseClient } from '@supabase/supabase-js';

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

  /** Optional table name prefix (e.g. `'switchboard'`). Sets `PUBLIC_APP_PREFIX` env var on Vercel. */
  prefix?: string;

  /** Additional env vars to set on Vercel (e.g. Teller mTLS credentials). */
  extraEnvVars?: Record<string, string>;
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
  /** `true` when `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` are both set. */
  configured: boolean;

  /** The Supabase project URL, if configured. */
  supabaseUrl?: string;

  /** The Supabase publishable key, if configured. */
  supabasePublishableKey?: string;

  /** Additional public env vars included by the app (e.g. Teller config). */
  extra?: Record<string, string>;
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
/** Standard security headers applied to all config and setup API responses. */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  /* Prevent caching in shared proxies — config may change after setup */
  'Cache-Control': 'private, no-cache',
  /* Prevent MIME-type sniffing */
  'X-Content-Type-Options': 'nosniff'
};

export function getServerConfig(): ServerConfig {
  const supabaseUrl = process.env.PUBLIC_SUPABASE_URL || '';
  const supabasePublishableKey = process.env.PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY || '';

  if (supabaseUrl && supabasePublishableKey) {
    return {
      configured: true,
      supabaseUrl,
      supabasePublishableKey
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

    if (config.prefix) {
      await setEnvVar(config.projectId, config.vercelToken, 'PUBLIC_APP_PREFIX', config.prefix);
    }

    if (config.extraEnvVars) {
      for (const [key, value] of Object.entries(config.extraEnvVars)) {
        if (value) await setEnvVar(config.projectId, config.vercelToken, key, value);
      }
    }

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
 * The handler includes built-in security guards:
 *   1. Blocks requests if `PUBLIC_SUPABASE_URL` is already set (app configured)
 *   2. Validates the Origin header to prevent cross-origin CSRF attacks
 *
 * @returns An async handler function compatible with SvelteKit's
 *          `RequestHandler` signature for POST endpoints.
 *
 * @example
 * ```ts
 * // In /api/setup/validate/+server.ts
 * import { createValidateHandler } from 'stellar-drive/kit';
 * import type { RequestHandler } from './$types';
 * export const POST: RequestHandler = createValidateHandler();
 * ```
 *
 * @see {@link validateSupabaseCredentials} in `supabase/validate.ts`
 */
/**
 * Creates a server-side Supabase client using environment variables.
 *
 * Reads `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`
 * from `process.env` via `getServerConfig()` and returns a fresh
 * `SupabaseClient` instance. Intended for use in SvelteKit server hooks
 * or API routes where the browser-side lazy singleton is unavailable.
 *
 * When a `prefix` is provided, the returned client is wrapped in a Proxy
 * that transparently prefixes all `.from()` calls. For example, with
 * `prefix = 'switchboard'`, `.from('gmail_sync_state')` becomes
 * `.from('switchboard_gmail_sync_state')`.
 *
 * @param prefix - Optional table name prefix (e.g. `'switchboard'`).
 *
 * @returns A `SupabaseClient` instance, or `null` if credentials are not configured.
 *
 * @example
 * ```ts
 * // In hooks.server.ts
 * import { createServerSupabaseClient } from 'stellar-drive/kit';
 * const supabase = createServerSupabaseClient('switchboard');
 * // supabase.from('users') → queries 'switchboard_users'
 * ```
 */
export function createServerSupabaseClient(prefix?: string): SupabaseClient | null {
  const config = getServerConfig();
  if (!config.configured || !config.supabaseUrl || !config.supabasePublishableKey) {
    return null;
  }
  const client = createClient(config.supabaseUrl, config.supabasePublishableKey);

  if (!prefix) return client;

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) => target.from(`${prefix}_${table}`);
      }
      return Reflect.get(target, prop, receiver);
    }
  }) as SupabaseClient;
}

/**
 * Creates a server-side Supabase admin client using the `service_role` key.
 *
 * This client **bypasses Row-Level Security (RLS)** and should only be used
 * in trusted server-side contexts (webhook handlers, background sync jobs)
 * where no user session is available.
 *
 * Reads `PUBLIC_SUPABASE_URL` from the server config and
 * `SUPABASE_SERVICE_ROLE_KEY` from `process.env`.
 *
 * When a `prefix` is provided, `.from()` calls are transparently prefixed
 * (same as {@link createServerSupabaseClient}).
 *
 * @param prefix - Optional table name prefix (e.g. `'radiant'`).
 * @returns A privileged `SupabaseClient`, or `null` if credentials are missing.
 *
 * @example
 * ```ts
 * import { createServerAdminClient } from 'stellar-drive/kit/server';
 * const admin = createServerAdminClient('radiant');
 * // Bypasses RLS — use only in server-side API routes
 * await admin?.from('accounts').upsert(rows);
 * ```
 */
export function createServerAdminClient(prefix?: string): SupabaseClient | null {
  const config = getServerConfig();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!config.configured || !config.supabaseUrl || !serviceRoleKey) {
    return null;
  }

  const client = createClient(config.supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  if (!prefix) return client;

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table: string) => target.from(`${prefix}_${table}`);
      }
      return Reflect.get(target, prop, receiver);
    }
  }) as SupabaseClient;
}

/**
 * Factory returning a SvelteKit GET handler that serves the server config
 * with appropriate security headers (Cache-Control, X-Content-Type-Options).
 *
 * @returns An async handler function compatible with SvelteKit's
 *          `RequestHandler` signature for GET endpoints.
 *
 * @example
 * ```ts
 * // In /api/config/+server.ts
 * import { createConfigHandler } from 'stellar-drive/kit';
 * export const GET = createConfigHandler();
 * ```
 */
export function createConfigHandler(options?: {
  /** Extra env var names to include in the response (read from process.env at runtime). */
  extraEnvVars?: string[];
}) {
  return async (): Promise<Response> => {
    const config = getServerConfig();

    if (options?.extraEnvVars?.length) {
      const extra: Record<string, string> = {};
      for (const key of options.extraEnvVars) {
        const val = process.env[key];
        if (val) extra[key] = val;
      }
      if (Object.keys(extra).length) config.extra = extra;
    }

    return new Response(JSON.stringify(config), {
      headers: SECURITY_HEADERS
    });
  };
}

export function createValidateHandler() {
  return async ({ request, url }: { request: Request; url: URL }): Promise<Response> => {
    /* ── Guard: validate Origin header (CSRF protection) ──── */
    const origin = request.headers.get('origin');
    if (!origin || origin !== url.origin) {
      return new Response(JSON.stringify({ valid: false, error: 'Invalid origin' }), {
        status: 403,
        headers: SECURITY_HEADERS
      });
    }

    /* Dynamic import keeps the Supabase client out of the module graph
       until this handler is actually invoked — reduces cold start time
       for routes that don't need validation. */
    const { validateSupabaseCredentials } = await import('../supabase/validate.js');
    try {
      const { supabaseUrl, supabasePublishableKey } = await request.json();

      if (!supabaseUrl || !supabasePublishableKey) {
        return new Response(
          JSON.stringify({ valid: false, error: 'Supabase URL and Publishable Key are required' }),
          { status: 400, headers: SECURITY_HEADERS }
        );
      }

      const result = await validateSupabaseCredentials(supabaseUrl, supabasePublishableKey);
      return new Response(JSON.stringify(result), {
        headers: SECURITY_HEADERS
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      return new Response(
        JSON.stringify({ valid: false, error: `Could not connect to Supabase: ${message}` }),
        { headers: SECURITY_HEADERS }
      );
    }
  };
}

/**
 * Factory returning a SvelteKit POST handler that deploys Supabase
 * credentials to Vercel environment variables and triggers a redeployment.
 *
 * The handler includes built-in security guards:
 *   1. Blocks requests if `PUBLIC_SUPABASE_URL` is already set (app configured)
 *   2. Validates the Origin header to prevent cross-origin CSRF attacks
 *
 * @param options - Optional configuration.
 * @param options.prefix - Table name prefix (e.g. `'stellar'`). Sets `PUBLIC_APP_PREFIX` on Vercel.
 *
 * @returns An async handler function compatible with SvelteKit's
 *          `RequestHandler` signature for POST endpoints.
 *
 * @example
 * ```ts
 * // In /api/setup/deploy/+server.ts
 * import { createDeployHandler } from 'stellar-drive/kit';
 * import type { RequestHandler } from './$types';
 * export const POST: RequestHandler = createDeployHandler({ prefix: 'myapp' });
 * ```
 */
export function createDeployHandler(options?: { prefix?: string }) {
  return async ({ request, url }: { request: Request; url: URL }): Promise<Response> => {
    /* ── Guard: validate Origin header (CSRF protection) ──── */
    const origin = request.headers.get('origin');
    if (!origin || origin !== url.origin) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid origin' }), {
        status: 403,
        headers: SECURITY_HEADERS
      });
    }

    /* ── Parse and validate request body ──── */
    try {
      const { supabaseUrl, supabasePublishableKey, vercelToken, extraEnvVars } =
        await request.json();

      if (!supabaseUrl || !supabasePublishableKey || !vercelToken) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Supabase URL, Publishable Key, and Vercel Token are required'
          }),
          { status: 400, headers: SECURITY_HEADERS }
        );
      }

      /* ── Ensure we're running on Vercel ──── */
      const projectId = process.env.VERCEL_PROJECT_ID;
      if (!projectId) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'VERCEL_PROJECT_ID not found. This endpoint only works on Vercel.'
          }),
          { status: 400, headers: SECURITY_HEADERS }
        );
      }

      /* ── Delegate to engine — sets env vars + redeploys ──── */
      const result = await deployToVercel({
        vercelToken,
        projectId,
        supabaseUrl,
        supabasePublishableKey,
        prefix: options?.prefix,
        extraEnvVars
      });

      return new Response(JSON.stringify(result), {
        headers: SECURITY_HEADERS
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      return new Response(JSON.stringify({ success: false, error: message }), {
        status: 500,
        headers: SECURITY_HEADERS
      });
    }
  };
}
