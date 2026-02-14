/**
 * @fileoverview Supabase Client — Lazy Initialization via ES Proxy
 *
 * This module exports a single `supabase` constant that looks and behaves
 * exactly like a `SupabaseClient` instance, but is actually an ES `Proxy`
 * that defers client creation until the **first property access**. This
 * "lazy singleton" pattern solves a critical bootstrapping problem:
 *
 *   The Supabase URL and anon key are loaded at **runtime** (via
 *   `getConfig()` from `../runtime/runtimeConfig`), not at build time.
 *   Modules that `import { supabase }` at the top level would otherwise
 *   crash because the config has not been initialized yet when the import
 *   executes.
 *
 * How the Proxy pattern works:
 *   1. `supabase` is exported as `new Proxy({} as SupabaseClient, handler)`.
 *   2. The handler's `get` trap intercepts every property access (e.g.
 *      `supabase.auth`, `supabase.from(...)`).
 *   3. On first access, `getOrCreateClient()` reads the runtime config and
 *      calls `createClient(url, key, options)` to build the real client.
 *   4. The real client is cached in a module-level `realClient` variable;
 *      subsequent accesses reuse it (standard singleton).
 *   5. Function values are `.bind(client)` to preserve `this` context.
 *
 * Additional responsibilities:
 *   - **Corrupted session cleanup**: Before the client is created, any
 *     malformed `sb-*` entries in localStorage are detected and removed to
 *     prevent "can't access property 'hash'" runtime errors.
 *   - **Unhandled rejection handler**: A global listener catches Supabase
 *     auth errors that escape normal error handling, clears storage, and
 *     performs a single guarded page reload to recover.
 *   - **iOS PWA detection**: The client sends a custom `x-client-info`
 *     header indicating whether it is running as a standalone PWA on iOS,
 *     which helps with server-side debugging of session eviction issues.
 *
 * Security considerations:
 *   - The anon key is a **public** key (safe to include in client bundles).
 *   - PKCE flow is used instead of the implicit flow for stronger OAuth
 *     security and better compatibility with PWA environments.
 *   - Session persistence uses localStorage; the module proactively scrubs
 *     corrupted entries to prevent denial-of-service via bad local state.
 *
 * @module supabase/client
 */
import { type SupabaseClient } from '@supabase/supabase-js';
/**
 * Override the storage key prefix used by the Supabase client.
 *
 * Must be called **before** the first access to the `supabase` export,
 * since the prefix is baked into the client options at creation time.
 *
 * @param prefix - The new prefix string (e.g. the app's name).
 *
 * @example
 * ```ts
 * _setClientPrefix('myapp');
 * // Later accesses will use storageKey 'myapp-auth'
 * ```
 */
export declare function _setClientPrefix(prefix: string): void;
/**
 * The public Supabase client — a Proxy-based lazy singleton.
 *
 * **Why a Proxy?**
 * The Supabase URL and anon key are not available at import time (they come
 * from a runtime config that is loaded asynchronously). A Proxy lets every
 * module `import { supabase }` at the top level without worrying about
 * initialization order. The real client is created transparently on first
 * property access.
 *
 * **How it works:**
 * - The `get` trap intercepts every property read (e.g. `supabase.auth`,
 *   `supabase.from`).
 * - It calls `getOrCreateClient()` to ensure the real client exists.
 * - It forwards the property access via `Reflect.get`.
 * - Function values are `.bind(client)` to keep `this` correct when the
 *   caller destructures methods (e.g. `const { from } = supabase`).
 *
 * @example
 * ```ts
 * import { supabase } from './client';
 *
 * // Works immediately — the Proxy defers creation until this line runs:
 * const { data } = await supabase.from('users').select('*');
 * ```
 */
export declare const supabase: SupabaseClient;
//# sourceMappingURL=client.d.ts.map