/**
 * Supabase Client - Lazy Initialization via Proxy
 *
 * Uses runtime config instead of build-time $env/static/public.
 * The Proxy pattern preserves the exact same API surface.
 */
import { type SupabaseClient } from '@supabase/supabase-js';
export declare function _setClientPrefix(prefix: string): void;
/**
 * Proxy-based lazy singleton.
 * Delegates all property access to the real SupabaseClient,
 * which is created on first access using getConfig().
 */
export declare const supabase: SupabaseClient;
/**
 * Get Supabase client asynchronously, waiting for config to load first.
 * Use this when config might not be loaded yet (e.g., in hooks.client.ts).
 */
export declare function getSupabaseAsync(): Promise<SupabaseClient>;
/**
 * Reset the Supabase client (for admin config updates).
 * Forces re-creation with new config on next access.
 */
export declare function resetSupabaseClient(): void;
//# sourceMappingURL=client.d.ts.map