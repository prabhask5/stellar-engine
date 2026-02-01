/**
 * Supabase Client - Lazy Initialization via Proxy
 *
 * Uses runtime config instead of build-time $env/static/public.
 * The Proxy pattern preserves the exact same API surface.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../runtime/runtimeConfig';
import { debugLog, debugWarn, debugError } from '../debug';

let _prefix = 'stellar';

export function _setClientPrefix(prefix: string) {
  _prefix = prefix;
}

// Clear corrupted Supabase auth data from localStorage if it exists
// This prevents "can't access property 'hash'" errors during initialization
function clearCorruptedAuthData(): void {
  if (typeof localStorage === 'undefined') return;

  try {
    // Supabase stores auth data with keys starting with 'sb-'
    const keysToCheck = Object.keys(localStorage).filter((key) => key.startsWith('sb-'));

    for (const key of keysToCheck) {
      const value = localStorage.getItem(key);
      if (value) {
        try {
          const parsed = JSON.parse(value);
          // Validate the parsed data has expected structure
          if (parsed && typeof parsed === 'object') {
            // Check for signs of corruption
            const hasCorruptedSession =
              // currentSession exists but missing required fields
              (parsed.currentSession && typeof parsed.currentSession !== 'object') ||
              // access_token exists but is not a string
              (parsed.access_token !== undefined && typeof parsed.access_token !== 'string') ||
              // expires_at exists but is not a number
              (parsed.expires_at !== undefined && typeof parsed.expires_at !== 'number');

            if (hasCorruptedSession) {
              debugWarn('[Auth] Clearing corrupted session data:', key);
              localStorage.removeItem(key);
            }
          }
        } catch {
          // JSON parse failed - data is corrupted
          debugWarn('[Auth] Clearing malformed session data:', key);
          localStorage.removeItem(key);
        }
      }
    }
  } catch (e) {
    debugError('[Auth] Error checking localStorage:', e);
  }
}

// Add global handler for unhandled Supabase auth errors
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    // Check if this is a Supabase auth error
    if (reason && typeof reason === 'object' && 'message' in reason) {
      const message = String(reason.message || '');
      if (message.includes('hash') || message.includes("can't access property")) {
        debugWarn('[Auth] Caught unhandled auth error, clearing storage');
        event.preventDefault(); // Prevent the error from showing in console
        // Clear Supabase storage
        try {
          const keys = Object.keys(localStorage).filter((k) => k.startsWith('sb-'));
          keys.forEach((k) => localStorage.removeItem(k));
          // Reload the page to get a fresh state
          window.location.reload();
        } catch {
          // Ignore storage errors
        }
      }
    }
  });
}

// Run cleanup before creating client
clearCorruptedAuthData();

// Detect if running as iOS PWA (standalone mode)
const isIOSPWA =
  typeof window !== 'undefined' &&
  // @ts-expect-error - navigator.standalone is iOS-specific
  (window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches);

if (isIOSPWA) {
  debugLog('[Auth] Running as iOS PWA - using enhanced auth persistence');
}

// Lazy singleton: actual client is created on first access
let realClient: SupabaseClient | null = null;

function getOrCreateClient(): SupabaseClient {
  if (realClient) return realClient;

  const config = getConfig();
  const url = config?.supabaseUrl || 'https://placeholder.supabase.co';
  const key = config?.supabaseAnonKey || 'placeholder';

  if (!config) {
    debugWarn(
      'Supabase config not loaded yet. Call initConfig() before using supabase client.'
    );
  }

  realClient = createClient(url, key, {
    auth: {
      // Use localStorage for persistence (default, but explicit for clarity)
      persistSession: true,
      // Auto-refresh tokens before they expire
      autoRefreshToken: true,
      // Detect session from URL (for OAuth redirects)
      detectSessionInUrl: true,
      // Storage key prefix
      storageKey: `${_prefix}-auth`,
      // Flow type - PKCE is more secure and works better with PWAs
      flowType: 'pkce'
    },
    global: {
      // Add custom headers to help debug PWA issues
      headers: {
        'x-client-info': isIOSPWA ? `${_prefix}-ios-pwa` : `${_prefix}-web`
      }
    }
  });

  // Set up auth state change listener to log auth events (helps debug PWA issues)
  if (typeof window !== 'undefined') {
    realClient.auth.onAuthStateChange((event, session) => {
      debugLog(
        `[Auth] State change: ${event}`,
        session ? `User: ${session.user?.id}` : 'No session'
      );

      // If session is lost unexpectedly, this helps identify the issue
      if (event === 'SIGNED_OUT' && isIOSPWA) {
        debugWarn('[Auth] Signed out on iOS PWA - session may have been evicted');
      }

      if (event === 'TOKEN_REFRESHED') {
        debugLog('[Auth] Token refreshed successfully');
      }
    });
  }

  return realClient;
}

/**
 * Proxy-based lazy singleton.
 * Delegates all property access to the real SupabaseClient,
 * which is created on first access using getConfig().
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getOrCreateClient();
    const value = Reflect.get(client, prop, receiver);
    if (typeof value === 'function') {
      return value.bind(client);
    }
    return value;
  }
});

