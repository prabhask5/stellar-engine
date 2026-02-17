/**
 * @fileoverview Single-User Authentication Module
 *
 * Provides the complete authentication lifecycle for single-user mode, where a
 * single user account is tied to the application instance. This module handles
 * setup, unlock (login), locking, gate (PIN/password) changes, email changes,
 * profile updates, multi-device linking, and full account reset.
 *
 * ## Architecture
 *
 * Authentication is backed by Supabase email/password auth, where the user's
 * PIN or password is padded (via {@link padPin}) to meet Supabase's minimum
 * password length requirement. A local IndexedDB config store
 * (`singleUserConfig` table) mirrors essential auth metadata for offline
 * fallback and fast reads.
 *
 * ## Auth Flow Summary
 *
 * 1. **Setup** ({@link setupSingleUser}): Creates a Supabase user with
 *    `signUp()`. Optionally requires email confirmation.
 * 2. **Unlock** ({@link unlockSingleUser}): Authenticates via
 *    `signInWithPassword()`. If device verification is enabled, untrusted
 *    devices are challenged with an OTP email before being granted a session.
 * 3. **Offline fallback**: When offline, credentials are verified against a
 *    locally-cached SHA-256 hash of the gate. A cached Supabase session is
 *    restored if available; otherwise, a synthetic offline session is created.
 * 4. **Lock** ({@link lockSingleUser}): Stops the sync engine and clears
 *    in-memory auth state, but preserves the Supabase session and local data.
 *
 * ## Security Considerations
 *
 * - **PIN padding**: PINs are short by design. The {@link padPin} function
 *   appends an app-specific suffix to meet Supabase's 6-character minimum,
 *   but the effective entropy remains that of the original PIN.
 * - **Offline hash**: The gate hash stored in IndexedDB uses SHA-256 via the
 *   Web Crypto API. This is a convenience fallback, NOT a substitute for
 *   server-side verification. An attacker with IndexedDB access could
 *   brute-force a short PIN.
 * - **Rate limiting**: The {@link preCheckLogin} guard provides client-side
 *   rate limiting to slow down brute-force attempts. Server-side rate limiting
 *   is handled by Supabase.
 * - **Device verification**: When enabled, untrusted devices must verify via
 *   an email OTP before a session is granted. See {@link deviceVerification}.
 *
 * @module singleUser
 * @see {@link deviceVerification} for the device trust and OTP verification layer
 * @see {@link offlineCredentials} for cached credential management
 * @see {@link offlineSession} for synthetic offline session creation
 * @see {@link loginGuard} for pre-check rate limiting
 */

import type { SingleUserConfig } from '../types';
import { getEngineConfig } from '../config';
import { supabase } from '../supabase/client';
import { hashValue } from './crypto';
import { cacheOfflineCredentials } from './offlineCredentials';
import { createOfflineSession } from './offlineSession';
import {
  isDeviceTrusted,
  trustCurrentDevice,
  touchTrustedDevice,
  sendDeviceVerification,
  maskEmail
} from './deviceVerification';
import { authState } from '../stores/authState';
import { syncStatusStore } from '../stores/sync';
import { getSession } from '../supabase/auth';
import { debugLog, debugWarn, debugError } from '../debug';
import { preCheckLogin, onLoginSuccess, onLoginFailure } from './loginGuard';
import { isDemoMode } from '../demo';
import type { PreCheckStrategy } from './loginGuard';

/** Constant key used for the single config record in IndexedDB. */
const CONFIG_ID = 'config';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Retrieve the Dexie database instance from the engine configuration.
 *
 * @returns The initialized Dexie database instance.
 * @throws {Error} If the database has not been initialized yet (engine not started).
 */
function getDb() {
  const db = getEngineConfig().db;
  if (!db) throw new Error('Database not initialized.');
  return db;
}

/**
 * Pad a PIN to meet Supabase's minimum password length.
 *
 * Supabase requires passwords of at least 6 characters. Since PINs can be as
 * short as 4 digits, this function appends an app-specific prefix as a suffix
 * to reach a safe length.
 *
 * @param pin - The raw PIN/password entered by the user.
 * @returns The padded string suitable for use as a Supabase password.
 *
 * @example
 * ```ts
 * // With default prefix 'app':
 * padPin('1234'); // => '1234_app'
 *
 * // With custom prefix 'stellar':
 * padPin('1234'); // => '1234_stellar'
 * ```
 *
 * @security The padding increases character length but does NOT increase
 *   entropy. The suffix is deterministic and app-wide.
 */
export function padPin(pin: string): string {
  const prefix = getEngineConfig().prefix || 'app';
  return `${pin}_${prefix}`;
}

/**
 * Build the full redirect URL for email confirmation flows.
 *
 * Uses `window.location.origin` combined with the configured
 * `confirmRedirectPath` (defaults to `/confirm`). Falls back to a relative
 * `/confirm` path in non-browser environments (e.g., SSR).
 *
 * @returns The absolute URL to redirect to after email confirmation.
 */
function getConfirmRedirectUrl(): string {
  if (typeof window !== 'undefined') {
    const path = getEngineConfig().auth?.confirmRedirectPath || '/confirm';
    return `${window.location.origin}${path}`;
  }
  return '/confirm';
}

/**
 * Read the single-user configuration record from IndexedDB.
 *
 * @returns The stored config, or `null` if no config exists (not yet set up).
 */
async function readConfig(): Promise<SingleUserConfig | null> {
  const db = getDb();
  const record = await db.table('singleUserConfig').get(CONFIG_ID);
  return record as SingleUserConfig | null;
}

/**
 * Write (create or update) the single-user configuration record in IndexedDB.
 *
 * @param config - The complete configuration object to persist. Must include
 *   `id: 'config'` to match the constant key.
 */
async function writeConfig(config: SingleUserConfig): Promise<void> {
  const db = getDb();
  await db.table('singleUserConfig').put(config);
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Check if single-user mode has been set up (config exists in IndexedDB).
 *
 * This is a lightweight read used by the UI to decide whether to show the
 * setup screen or the unlock screen.
 *
 * @returns `true` if a single-user config record exists, `false` otherwise.
 *
 * @example
 * ```ts
 * if (await isSingleUserSetUp()) {
 *   showUnlockScreen();
 * } else {
 *   showSetupScreen();
 * }
 * ```
 */
export async function isSingleUserSetUp(): Promise<boolean> {
  try {
    const config = await readConfig();
    return config !== null;
  } catch {
    return false;
  }
}

/**
 * Get non-sensitive display info about the single user.
 *
 * Returns profile data, gate type, code length, and a masked email suitable
 * for display in the UI. Does NOT return the gate hash or any secrets.
 *
 * @returns An object with display-safe user info, or `null` if not set up.
 *
 * @example
 * ```ts
 * const info = await getSingleUserInfo();
 * if (info) {
 *   console.log(info.maskedEmail); // "pr••••@gmail.com"
 *   console.log(info.gateType);    // "code"
 * }
 * ```
 */
export async function getSingleUserInfo(): Promise<{
  /** Arbitrary user profile data (name, avatar, etc.). */
  profile: Record<string, unknown>;
  /** The type of gate: 'code' for numeric PIN, 'password' for freeform. */
  gateType: SingleUserConfig['gateType'];
  /** Length of the numeric code (4 or 6), if gateType is 'code'. */
  codeLength?: 4 | 6;
  /** The raw email address (included for internal use). */
  email?: string;
  /** The masked email for safe display (e.g. "pr••••@gmail.com"). */
  maskedEmail?: string;
} | null> {
  const config = await readConfig();
  if (!config) return null;
  return {
    profile: config.profile,
    gateType: config.gateType,
    codeLength: config.codeLength,
    email: config.email,
    maskedEmail: config.email ? maskEmail(config.email) : undefined
  };
}

/**
 * First-time setup: create a Supabase user with email/password auth.
 *
 * This is the entry point for new users. It creates a Supabase account using
 * `signUp()`, stores a local config in IndexedDB, and optionally requires
 * email confirmation before granting a session.
 *
 * ## Online vs Offline
 *
 * - **Online**: Creates a real Supabase user, caches offline credentials,
 *   trusts the current device, and sets up the auth state.
 * - **Offline**: Creates a temporary local-only setup with a random UUID as
 *   the user ID. The real Supabase account will be created when the user
 *   comes back online (handled by the sync engine).
 *
 * @param gate - The PIN or password chosen by the user.
 * @param profile - Arbitrary profile data (e.g., `{ name: 'Alice' }`).
 * @param email - The user's email address for Supabase auth.
 * @returns An object with `error` (string or null) and `confirmationRequired`
 *   (true if the caller should show a "check your email" modal).
 *
 * @throws Never throws directly; all errors are caught and returned in the
 *   `error` field.
 *
 * @example
 * ```ts
 * const result = await setupSingleUser('1234', { name: 'Alice' }, 'alice@example.com');
 * if (result.error) {
 *   showError(result.error);
 * } else if (result.confirmationRequired) {
 *   showEmailConfirmationModal();
 * } else {
 *   navigateToHome();
 * }
 * ```
 *
 * @see {@link completeSingleUserSetup} for finalizing after email confirmation
 */
export async function setupSingleUser(
  gate: string,
  profile: Record<string, unknown>,
  email: string
): Promise<{ error: string | null; confirmationRequired: boolean }> {
  if (isDemoMode()) return { error: null, confirmationRequired: false };
  try {
    const engineConfig = getEngineConfig();
    const singleUserOpts = engineConfig.auth?.singleUser;
    const gateType = singleUserOpts?.gateType || 'code';
    const codeLength = singleUserOpts?.codeLength;
    const emailConfirmationEnabled = engineConfig.auth?.emailConfirmation?.enabled ?? false;

    const paddedPassword = padPin(gate);
    const gateHash = await hashValue(gate); /* Keep hash for offline fallback */
    const now = new Date().toISOString();
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

    /* Build profile metadata for Supabase user_metadata — allows the host app
       to transform profile fields into a Supabase-friendly shape */
    const profileToMetadata = engineConfig.auth?.profileToMetadata;
    const metadata = {
      ...(profileToMetadata ? profileToMetadata(profile) : profile),
      code_length: codeLength ?? 6
    };

    if (!isOffline) {
      // --- ONLINE SETUP ---
      const { data, error } = await supabase.auth.signUp({
        email,
        password: paddedPassword,
        options: {
          emailRedirectTo: getConfirmRedirectUrl(),
          data: metadata
        }
      });

      if (error) {
        debugError('[SingleUser] signUp failed:', error.message);
        return { error: `Setup failed: ${error.message}`, confirmationRequired: false };
      }

      const user = data.user!;
      const session = data.session; /* null if email confirmation is required */

      /* Persist config to IndexedDB so subsequent unlocks can work offline */
      const config: SingleUserConfig = {
        id: CONFIG_ID,
        gateType,
        codeLength,
        gateHash,
        email,
        profile,
        supabaseUserId: user.id,
        setupAt: now,
        updatedAt: now
      };
      await writeConfig(config);

      /* If email confirmation is required, session will be null.
         The caller should show a "check your email" modal and wait for
         the AUTH_CONFIRMED BroadcastChannel message. */
      if (emailConfirmationEnabled && !session) {
        debugLog('[SingleUser] Setup initiated, awaiting email confirmation for:', email);
        return { error: null, confirmationRequired: true };
      }

      /* No confirmation needed (or already confirmed) — proceed immediately */
      if (session) {
        /* Cache offline credentials — non-fatal if this fails */
        try {
          await cacheOfflineCredentials(email, gate, user, session);
        } catch (e) {
          debugWarn('[SingleUser] Failed to cache offline credentials:', e);
        }

        /* Create offline session for future offline unlocks */
        try {
          await createOfflineSession(user.id);
        } catch (e) {
          debugWarn('[SingleUser] Failed to create offline session:', e);
        }

        /* Auto-trust current device so the user is not immediately challenged
           with device verification on the device they just set up */
        try {
          await trustCurrentDevice(user.id);
        } catch (e) {
          debugWarn('[SingleUser] Failed to trust device:', e);
        }

        authState.setSupabaseAuth(session);
        debugLog('[SingleUser] Setup complete (online, no confirmation needed), userId:', user.id);
      }

      return { error: null, confirmationRequired: false };
    } else {
      // --- OFFLINE SETUP ---
      /* Generate a temporary UUID for the user. This will be replaced with the
         real Supabase user ID once the device comes online and syncs. */
      const tempUserId = crypto.randomUUID();

      const config: SingleUserConfig = {
        id: CONFIG_ID,
        gateType,
        codeLength,
        gateHash,
        email,
        profile,
        setupAt: now,
        updatedAt: now
      };
      await writeConfig(config);

      await createOfflineSession(tempUserId);

      const offlineProfile = {
        id: 'current_user',
        userId: tempUserId,
        email,
        password: gateHash,
        profile,
        cachedAt: now
      };
      authState.setOfflineAuth(offlineProfile);
      debugLog('[SingleUser] Setup complete (offline), temp userId:', tempUserId);

      return { error: null, confirmationRequired: false };
    }
  } catch (e) {
    debugError('[SingleUser] Setup error:', e);
    return { error: e instanceof Error ? e.message : 'Setup failed', confirmationRequired: false };
  }
}

/**
 * Complete setup after email confirmation succeeds.
 *
 * Called when the original tab receives an `AUTH_CONFIRMED` message via
 * BroadcastChannel. At this point, Supabase has confirmed the email and a
 * session should be available. This function caches offline credentials,
 * creates an offline session, and trusts the current device.
 *
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @see {@link setupSingleUser} for the initial setup that triggers confirmation
 */
export async function completeSingleUserSetup(): Promise<{ error: string | null }> {
  if (isDemoMode()) return { error: null };
  try {
    const config = await readConfig();
    if (!config) {
      return { error: 'Single-user config not found' };
    }

    /* After email confirmation, the session should now be available
       in Supabase's internal storage (localStorage) */
    const {
      data: { session },
      error: sessionError
    } = await supabase.auth.getSession();
    if (sessionError || !session) {
      debugError('[SingleUser] No session after confirmation:', sessionError?.message);
      return { error: 'Session not found after confirmation. Please try logging in.' };
    }

    const user = session.user;

    /* Update config with real Supabase user ID if it was missing
       (e.g., offline setup that was later confirmed) */
    if (!config.supabaseUserId) {
      config.supabaseUserId = user.id;
      config.updatedAt = new Date().toISOString();
      await writeConfig(config);
    }

    /* Cache offline credentials — uses gateHash as password fallback
       since we no longer have the raw gate at this point */
    try {
      await cacheOfflineCredentials(config.email || '', config.gateHash || '', user, session);
    } catch (e) {
      debugWarn('[SingleUser] Failed to cache offline credentials after confirmation:', e);
    }

    /* Create offline session */
    try {
      await createOfflineSession(user.id);
    } catch (e) {
      debugWarn('[SingleUser] Failed to create offline session after confirmation:', e);
    }

    /* Auto-trust current device */
    try {
      await trustCurrentDevice(user.id);
    } catch (e) {
      debugWarn('[SingleUser] Failed to trust device after confirmation:', e);
    }

    authState.setSupabaseAuth(session);
    debugLog('[SingleUser] Setup completed after email confirmation, userId:', user.id);

    return { error: null };
  } catch (e) {
    debugError('[SingleUser] Complete setup error:', e);
    return { error: e instanceof Error ? e.message : 'Failed to complete setup' };
  }
}

/**
 * Unlock (login) the single-user account by verifying the PIN/password.
 *
 * ## Online Flow
 *
 * 1. Pre-check via {@link preCheckLogin} (client-side rate limiting).
 * 2. Authenticate with Supabase `signInWithPassword()`.
 * 3. If device verification is enabled and this device is untrusted, trigger
 *    an OTP email and return `deviceVerificationRequired: true`.
 * 4. Otherwise, cache credentials, update offline session, refresh the local
 *    gate hash, and set auth state.
 *
 * ## Offline Flow
 *
 * 1. Verify the gate against the locally-stored SHA-256 hash.
 * 2. Attempt to restore a cached Supabase session.
 * 3. If no cached session, create a synthetic offline session.
 *
 * @param gate - The PIN or password entered by the user.
 * @returns An object containing:
 *   - `error`: Error message or null on success.
 *   - `deviceVerificationRequired`: True if the UI should show OTP verification.
 *   - `maskedEmail`: Masked email for display during device verification.
 *   - `retryAfterMs`: Milliseconds to wait before retrying (rate-limited).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @example
 * ```ts
 * const result = await unlockSingleUser('1234');
 * if (result.error) {
 *   showError(result.error);
 * } else if (result.deviceVerificationRequired) {
 *   showDeviceVerificationModal(result.maskedEmail);
 * } else {
 *   navigateToHome();
 * }
 * ```
 *
 * @see {@link completeDeviceVerification} for finishing the OTP flow
 * @see {@link lockSingleUser} for the reverse operation
 */
export async function unlockSingleUser(gate: string): Promise<{
  error: string | null;
  deviceVerificationRequired?: boolean;
  maskedEmail?: string;
  retryAfterMs?: number;
}> {
  if (isDemoMode()) return { error: null };
  try {
    const config = await readConfig();
    if (!config) {
      return { error: 'Single-user mode is not set up' };
    }

    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    const engineConfig = getEngineConfig();

    if (!isOffline && config.email) {
      // --- ONLINE UNLOCK via Supabase signInWithPassword ---

      /* Pre-check credentials locally before calling Supabase to enforce
         client-side rate limiting and avoid unnecessary network requests */
      const preCheck = await preCheckLogin(gate);
      if (!preCheck.proceed) {
        return { error: preCheck.error, retryAfterMs: preCheck.retryAfterMs };
      }

      const strategy: PreCheckStrategy = preCheck.strategy;
      const paddedPassword = padPin(gate);

      const { data, error } = await supabase.auth.signInWithPassword({
        email: config.email,
        password: paddedPassword
      });

      if (error) {
        await onLoginFailure(strategy);
        debugWarn('[SingleUser] signInWithPassword failed:', error.message);
        /* Return generic error to avoid leaking whether the account exists */
        return { error: 'Incorrect code' };
      }

      /* Successful Supabase login — reset rate-limit counters */
      onLoginSuccess();

      const session = data.session!;
      const user = data.user!;

      /* Sync the Supabase user ID into local config if it changed
         (e.g., after account migration or re-creation) */
      if (config.supabaseUserId !== user.id) {
        config.supabaseUserId = user.id;
        config.updatedAt = new Date().toISOString();
        await writeConfig(config);
      }

      /* Device verification gate: if enabled, check whether this device
         is in the trusted_devices table before granting access */
      const deviceVerificationEnabled = engineConfig.auth?.deviceVerification?.enabled ?? false;
      if (deviceVerificationEnabled) {
        const trusted = await isDeviceTrusted(user.id);
        if (!trusted) {
          /* Untrusted device — send OTP email and signal the UI to show
             the verification prompt. The session remains valid but the
             user cannot proceed until the device is verified. */
          debugLog('[SingleUser] Untrusted device detected, sending OTP');
          const { error: otpError } = await sendDeviceVerification(config.email);
          if (otpError) {
            debugError('[SingleUser] Failed to send device verification:', otpError);
          }
          return {
            error: null,
            deviceVerificationRequired: true,
            maskedEmail: maskEmail(config.email)
          };
        }

        /* Trusted device — refresh the last_used_at timestamp to extend
           the trust window */
        await touchTrustedDevice(user.id);
      }

      /* Re-apply profile to user_metadata on each login to keep Supabase
         in sync with any local profile changes made while offline */
      const profileToMetadata = engineConfig.auth?.profileToMetadata;
      const metadata = profileToMetadata ? profileToMetadata(config.profile) : config.profile;
      await supabase.auth.updateUser({ data: metadata }).catch((e: unknown) => {
        debugWarn('[SingleUser] Failed to update user_metadata on unlock:', e);
      });

      /* Cache offline credentials for future offline unlocks */
      try {
        await cacheOfflineCredentials(config.email, gate, user, session);
      } catch (e) {
        debugWarn('[SingleUser] Failed to update offline credentials:', e);
      }

      /* Update offline session */
      try {
        await createOfflineSession(user.id);
      } catch (e) {
        debugWarn('[SingleUser] Failed to update offline session:', e);
      }

      /* Update the local gate hash in case the user changed their PIN
         on another device — keeps offline verification in sync */
      const newHash = await hashValue(gate);
      if (config.gateHash !== newHash) {
        config.gateHash = newHash;
        config.updatedAt = new Date().toISOString();
        await writeConfig(config);
      }

      authState.setSupabaseAuth(session);
      debugLog('[SingleUser] Unlocked online, userId:', user.id);

      return { error: null };
    } else {
      // --- OFFLINE UNLOCK ---
      /* Fall back to local hash verification when offline */
      const inputHash = await hashValue(gate);
      if (config.gateHash && inputHash !== config.gateHash) {
        return { error: 'Incorrect code' };
      }

      /* Try to restore a cached Supabase session from the Supabase client's
         internal storage — this may still be valid if the token hasn't expired */
      const cachedSession = await getSession();
      if (cachedSession) {
        authState.setSupabaseAuth(cachedSession);
        debugLog('[SingleUser] Unlocked offline with cached Supabase session');
        return { error: null };
      }

      /* No cached session available — create a synthetic offline session
         so the app can function in read/write-locally mode */
      const userId = config.supabaseUserId || crypto.randomUUID();
      await createOfflineSession(userId);

      const offlineProfile = {
        id: 'current_user',
        userId,
        email: config.email || '',
        password: config.gateHash || inputHash,
        profile: config.profile,
        cachedAt: new Date().toISOString()
      };
      authState.setOfflineAuth(offlineProfile);
      debugLog('[SingleUser] Unlocked offline with offline session');

      return { error: null };
    }
  } catch (e) {
    debugError('[SingleUser] Unlock error:', e);
    return { error: e instanceof Error ? e.message : 'Unlock failed' };
  }
}

/**
 * Complete device verification after the OTP email link is clicked.
 *
 * This can be called in two scenarios:
 * 1. **From the confirm page** (with `tokenHash`): Verifies the OTP token,
 *    then establishes the session.
 * 2. **From the original tab** (without `tokenHash`): The confirm page has
 *    already verified the OTP and sent `AUTH_CONFIRMED` via BroadcastChannel.
 *    This function just picks up the now-available session.
 *
 * After verification, the current device is trusted, offline credentials are
 * cached, and auth state is set.
 *
 * @param tokenHash - Optional OTP token hash from the email link URL. If
 *   provided, the token is verified against Supabase before proceeding.
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @see {@link unlockSingleUser} which triggers device verification
 * @see {@link pollDeviceVerification} for polling-based completion
 */
export async function completeDeviceVerification(
  tokenHash?: string
): Promise<{ error: string | null }> {
  if (isDemoMode()) return { error: null };
  try {
    /* If tokenHash is provided, verify it first (called from the confirm page).
       Uses dynamic import to avoid circular dependency issues. */
    if (tokenHash) {
      const { verifyDeviceCode } = await import('./deviceVerification');
      const { error } = await verifyDeviceCode(tokenHash);
      if (error) return { error };
    }

    /* After OTP verification, the Supabase session should be available */
    const {
      data: { session },
      error: sessionError
    } = await supabase.auth.getSession();
    if (sessionError || !session) {
      return { error: 'Session not found after verification' };
    }

    const user = session.user;

    /* Trust the device now that verification is complete */
    await trustCurrentDevice(user.id);

    /* Cache credentials for offline use */
    const config = await readConfig();
    if (config?.email) {
      try {
        await cacheOfflineCredentials(config.email, config.gateHash || '', user, session);
      } catch (e) {
        debugWarn('[SingleUser] Failed to cache credentials after device verification:', e);
      }
    }

    /* Create offline session */
    try {
      await createOfflineSession(user.id);
    } catch (e) {
      debugWarn('[SingleUser] Failed to create offline session after device verification:', e);
    }

    authState.setSupabaseAuth(session);
    debugLog('[SingleUser] Device verification complete, userId:', user.id);

    return { error: null };
  } catch (e) {
    debugError('[SingleUser] Device verification error:', e);
    return { error: e instanceof Error ? e.message : 'Device verification failed' };
  }
}

/**
 * Poll whether this device has been trusted after OTP verification.
 *
 * Used by the UI to detect when device verification has been completed on
 * another device (e.g., the user opened the OTP link on their phone). The
 * confirm page calls {@link trustPendingDevice}, which trusts the originating
 * device. Once that happens, this poll returns `true`.
 *
 * Requires an active session — {@link sendDeviceVerification} keeps the
 * session alive specifically for this purpose.
 *
 * @returns `true` if the current device is now trusted, `false` otherwise.
 *
 * @example
 * ```ts
 * const interval = setInterval(async () => {
 *   if (await pollDeviceVerification()) {
 *     clearInterval(interval);
 *     await completeDeviceVerification();
 *   }
 * }, 3000);
 * ```
 */
export async function pollDeviceVerification(): Promise<boolean> {
  if (isDemoMode()) return false;
  try {
    const {
      data: { user },
      error
    } = await supabase.auth.getUser();
    if (error || !user) return false;
    return isDeviceTrusted(user.id);
  } catch {
    return false;
  }
}

/**
 * Lock the application: stop the sync engine and reset auth state to 'none'.
 *
 * This is a "soft lock" — it does NOT destroy the Supabase session, clear
 * local data, or sign out. The user can unlock again with their PIN without
 * needing network access (if offline credentials are cached).
 *
 * @example
 * ```ts
 * await lockSingleUser();
 * navigateToLockScreen();
 * ```
 *
 * @see {@link unlockSingleUser} for the reverse operation
 * @see {@link resetSingleUser} for a full destructive reset
 */
export async function lockSingleUser(): Promise<void> {
  try {
    /* Dynamic import to avoid circular dependency with the engine module */
    const { stopSyncEngine } = await import('../engine');
    await stopSyncEngine();
  } catch (e) {
    debugError('[SingleUser] Failed to stop sync engine on lock:', e);
  }

  syncStatusStore.reset();
  authState.setNoAuth();
  debugLog('[SingleUser] Locked');
}

/**
 * Change the gate (PIN/password) for the single-user account.
 *
 * Verifies the old gate before accepting the new one. When online, the
 * password is also updated in Supabase. When offline, only the local hash
 * is updated (Supabase will be out of sync until the next online login).
 *
 * @param oldGate - The current PIN/password for verification.
 * @param newGate - The new PIN/password to set.
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @security The old gate is verified either via local hash comparison or
 *   Supabase `signInWithPassword()` before the change is applied. This
 *   prevents unauthorized changes if the device is left unlocked.
 *
 * @example
 * ```ts
 * const result = await changeSingleUserGate('1234', '5678');
 * if (result.error) {
 *   showError(result.error);
 * } else {
 *   showSuccess('Code changed successfully');
 * }
 * ```
 */
export async function changeSingleUserGate(
  oldGate: string,
  newGate: string
): Promise<{ error: string | null }> {
  if (isDemoMode()) return { error: null };
  try {
    const config = await readConfig();
    if (!config) {
      return { error: 'Single-user mode is not set up' };
    }

    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

    if (!isOffline && config.email) {
      /* Online: verify old gate locally first (faster, avoids network round-trip).
         Fall back to Supabase verification if no local hash is available. */
      if (config.gateHash) {
        /* Local hash check — preferred path */
        const oldHash = await hashValue(oldGate);
        if (oldHash !== config.gateHash) {
          return { error: 'Current code is incorrect' };
        }
      } else {
        /* No local hash — fall back to Supabase verification.
           This can happen after a migration from an older schema. */
        const { error: verifyError } = await supabase.auth.signInWithPassword({
          email: config.email,
          password: padPin(oldGate)
        });

        if (verifyError) {
          return { error: 'Current code is incorrect' };
        }
      }

      /* Update password in Supabase so all devices use the new gate */
      const { error: updateError } = await supabase.auth.updateUser({
        password: padPin(newGate)
      });

      if (updateError) {
        return { error: `Failed to update code: ${updateError.message}` };
      }
    } else {
      /* Offline: can only verify against the local hash */
      const oldHash = await hashValue(oldGate);
      if (config.gateHash && oldHash !== config.gateHash) {
        return { error: 'Current code is incorrect' };
      }
    }

    /* Update local hash regardless of online/offline status */
    const newHash = await hashValue(newGate);
    config.gateHash = newHash;
    config.updatedAt = new Date().toISOString();
    await writeConfig(config);

    /* Update offline credentials cache to match the new gate */
    try {
      const db = getDb();
      const creds = await db.table('offlineCredentials').get('current_user');
      if (creds) {
        await db.table('offlineCredentials').update('current_user', {
          password: newHash,
          cachedAt: new Date().toISOString()
        });
      }
    } catch (e) {
      debugWarn('[SingleUser] Failed to update offline credentials after gate change:', e);
    }

    debugLog('[SingleUser] Gate changed successfully');
    return { error: null };
  } catch (e) {
    debugError('[SingleUser] Gate change error:', e);
    return { error: e instanceof Error ? e.message : 'Failed to change code' };
  }
}

/**
 * Update the user's profile in both IndexedDB and Supabase `user_metadata`.
 *
 * When online, the profile is pushed to Supabase so it's available on all
 * devices. When offline, only the local config is updated (Supabase will be
 * synced on the next online login via {@link unlockSingleUser}).
 *
 * @param profile - The new profile data to store (replaces the existing profile entirely).
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @example
 * ```ts
 * const result = await updateSingleUserProfile({ name: 'Bob', avatar: 'cat' });
 * if (result.error) {
 *   showError(result.error);
 * }
 * ```
 */
export async function updateSingleUserProfile(
  profile: Record<string, unknown>
): Promise<{ error: string | null }> {
  if (isDemoMode()) return { error: null };
  try {
    const config = await readConfig();
    if (!config) {
      return { error: 'Single-user mode is not set up' };
    }

    config.profile = profile;
    config.updatedAt = new Date().toISOString();
    await writeConfig(config);

    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    if (!isOffline) {
      /* Transform profile into Supabase metadata format using the host
         app's custom transformer, if provided */
      const engineConfig = getEngineConfig();
      const profileToMetadata = engineConfig.auth?.profileToMetadata;
      const metadata = profileToMetadata ? profileToMetadata(profile) : profile;

      const { error } = await supabase.auth.updateUser({ data: metadata });
      if (error) {
        debugWarn('[SingleUser] Failed to update Supabase profile:', error.message);
      } else {
        authState.updateUserProfile(metadata);
      }
    }

    /* Update offline credentials cache with the new profile */
    try {
      const db = getDb();
      const creds = await db.table('offlineCredentials').get('current_user');
      if (creds) {
        await db.table('offlineCredentials').update('current_user', {
          profile,
          cachedAt: new Date().toISOString()
        });
      }
    } catch (e) {
      debugWarn('[SingleUser] Failed to update offline credentials profile:', e);
    }

    debugLog('[SingleUser] Profile updated');
    return { error: null };
  } catch (e) {
    debugError('[SingleUser] Profile update error:', e);
    return { error: e instanceof Error ? e.message : 'Failed to update profile' };
  }
}

/**
 * Initiate an email change for the single-user account.
 *
 * Requires an active internet connection. Supabase sends a confirmation email
 * to the new address. The change is not applied until the user clicks the
 * confirmation link and {@link completeSingleUserEmailChange} is called.
 *
 * @param newEmail - The new email address to change to.
 * @returns An object with `error` (string or null) and `confirmationRequired`
 *   (true if the caller should show a "check your email" prompt).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @see {@link completeSingleUserEmailChange} for finalizing the change
 */
export async function changeSingleUserEmail(
  newEmail: string
): Promise<{ error: string | null; confirmationRequired: boolean }> {
  if (isDemoMode()) return { error: null, confirmationRequired: false };
  try {
    const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
    if (isOffline) {
      return { error: 'Email change requires an internet connection', confirmationRequired: false };
    }

    const config = await readConfig();
    if (!config) {
      return { error: 'Single-user mode is not set up', confirmationRequired: false };
    }

    const { error } = await supabase.auth.updateUser({ email: newEmail });

    if (error) {
      debugError('[SingleUser] Email change failed:', error.message);
      return { error: `Email change failed: ${error.message}`, confirmationRequired: false };
    }

    debugLog('[SingleUser] Email change initiated, confirmation required for:', newEmail);
    return { error: null, confirmationRequired: true };
  } catch (e) {
    debugError('[SingleUser] Email change error:', e);
    return {
      error: e instanceof Error ? e.message : 'Email change failed',
      confirmationRequired: false
    };
  }
}

/**
 * Complete an email change after the user confirms via the email link.
 *
 * Called when the original tab receives `AUTH_CONFIRMED` with type
 * `email_change`. Refreshes the Supabase session to pick up the new email,
 * then updates IndexedDB config and offline credentials.
 *
 * @returns An object with `error` (string or null) and `newEmail` (the
 *   confirmed new email, or null on error).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @see {@link changeSingleUserEmail} for initiating the change
 */
export async function completeSingleUserEmailChange(): Promise<{
  error: string | null;
  newEmail: string | null;
}> {
  if (isDemoMode()) return { error: null, newEmail: null };
  try {
    /* Refresh session to get updated user data with the new email */
    const { data, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError || !data.session) {
      debugError(
        '[SingleUser] Failed to refresh session after email change:',
        refreshError?.message
      );
      return { error: 'Failed to refresh session after email change', newEmail: null };
    }

    const session = data.session;
    const newEmail = session.user.email;
    if (!newEmail) {
      return { error: 'No email found in updated session', newEmail: null };
    }

    /* Update local IndexedDB config with the confirmed new email */
    const config = await readConfig();
    if (config) {
      config.email = newEmail;
      config.updatedAt = new Date().toISOString();
      await writeConfig(config);
    }

    /* Update offline credentials cache with the new email */
    try {
      const db = getDb();
      const creds = await db.table('offlineCredentials').get('current_user');
      if (creds) {
        await db.table('offlineCredentials').update('current_user', {
          email: newEmail,
          cachedAt: new Date().toISOString()
        });
      }
    } catch (e) {
      debugWarn('[SingleUser] Failed to update offline credentials after email change:', e);
    }

    authState.setSupabaseAuth(session);
    debugLog('[SingleUser] Email change completed, new email:', newEmail);

    return { error: null, newEmail };
  } catch (e) {
    debugError('[SingleUser] Complete email change error:', e);
    return {
      error: e instanceof Error ? e.message : 'Failed to complete email change',
      newEmail: null
    };
  }
}

/**
 * Full reset: clear config, sign out of Supabase, and clear all local data.
 *
 * This is a destructive operation that removes the single-user config from
 * IndexedDB and signs out of Supabase (which clears the session and all
 * local auth state). After this, the app returns to the initial setup state.
 *
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @security This clears auth state but does NOT delete the Supabase user
 *   account or any server-side data. Use {@link resetSingleUserRemote} for
 *   a full server-side reset.
 *
 * @see {@link resetSingleUserRemote} for server-side account deletion
 */
export async function resetSingleUser(): Promise<{ error: string | null }> {
  if (isDemoMode()) return { error: null };
  try {
    const { signOut } = await import('../supabase/auth');
    const result = await signOut();

    try {
      const db = getDb();
      await db.table('singleUserConfig').delete(CONFIG_ID);
    } catch (e) {
      debugWarn('[SingleUser] Failed to clear config on reset:', e);
    }

    debugLog('[SingleUser] Reset complete');
    return { error: result.error };
  } catch (e) {
    debugError('[SingleUser] Reset error:', e);
    return { error: e instanceof Error ? e.message : 'Reset failed' };
  }
}

// =============================================================================
// MULTI-DEVICE + EXTENSION SUPPORT
// =============================================================================

/**
 * Fetch remote gate configuration via the `get_extension_config()` Supabase RPC.
 *
 * Returns user info if a user exists in the Supabase project, `null` otherwise.
 * This is used by browser extensions and new devices to discover the existing
 * account before linking. Works without authentication (uses the publishable key).
 *
 * @returns An object with `email`, `gateType`, `codeLength`, and `profile`,
 *   or `null` if no user exists or the RPC fails.
 *
 * @example
 * ```ts
 * const remote = await fetchRemoteGateConfig();
 * if (remote) {
 *   // Account exists — show link-device screen
 *   showLinkDeviceScreen(remote.email, remote.gateType);
 * } else {
 *   // No account — show setup screen
 *   showSetupScreen();
 * }
 * ```
 *
 * @see {@link linkSingleUserDevice} for linking after discovery
 */
export async function fetchRemoteGateConfig(): Promise<{
  /** The user's email address. */
  email: string;
  /** The gate type ('code' or 'password'). */
  gateType: string;
  /** The numeric code length (4 or 6). */
  codeLength: number;
  /** The user's profile metadata. */
  profile: Record<string, unknown>;
} | null> {
  if (isDemoMode()) return null;
  try {
    const { data, error } = await supabase.rpc('get_extension_config');
    if (error) {
      debugWarn('[SingleUser] fetchRemoteGateConfig RPC error:', error.message);
      return null;
    }
    if (!data || !data.email) {
      return null;
    }
    return {
      email: data.email,
      gateType: data.gateType || 'code',
      codeLength: data.codeLength || 6,
      profile: data.profile || {}
    };
  } catch (e) {
    debugError('[SingleUser] fetchRemoteGateConfig error:', e);
    return null;
  }
}

/**
 * Link a new device to an existing single-user account.
 *
 * Signs in with the provided email and PIN via Supabase `signInWithPassword()`,
 * then builds and stores a local config from the user's `user_metadata`. If
 * device verification is enabled, untrusted devices are challenged with an OTP.
 *
 * This is the multi-device counterpart to {@link setupSingleUser}: setup
 * creates the account, while link joins an existing one from a new device.
 *
 * @param email - The email address of the existing account.
 * @param pin - The PIN/password to authenticate with.
 * @returns An object containing:
 *   - `error`: Error message or null on success.
 *   - `deviceVerificationRequired`: True if OTP verification is needed.
 *   - `maskedEmail`: Masked email for display during device verification.
 *   - `retryAfterMs`: Milliseconds to wait before retrying (rate-limited).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @example
 * ```ts
 * const result = await linkSingleUserDevice('alice@example.com', '1234');
 * if (result.deviceVerificationRequired) {
 *   showOtpModal(result.maskedEmail);
 * }
 * ```
 *
 * @see {@link fetchRemoteGateConfig} for discovering the account to link to
 */
export async function linkSingleUserDevice(
  email: string,
  pin: string
): Promise<{
  error: string | null;
  deviceVerificationRequired?: boolean;
  maskedEmail?: string;
  retryAfterMs?: number;
}> {
  if (isDemoMode()) return { error: null };
  try {
    const engineConfig = getEngineConfig();
    const singleUserOpts = engineConfig.auth?.singleUser;
    const gateType = singleUserOpts?.gateType || 'code';
    const codeLength = singleUserOpts?.codeLength;

    /* Pre-check with rate limiting. New devices always use the 'no-cache'
       strategy since there are no local credentials to compare against. */
    const preCheck = await preCheckLogin(pin);
    if (!preCheck.proceed) {
      return { error: preCheck.error, retryAfterMs: preCheck.retryAfterMs };
    }

    const paddedPassword = padPin(pin);

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password: paddedPassword
    });

    if (error) {
      await onLoginFailure('no-cache');
      debugWarn('[SingleUser] linkSingleUserDevice signIn failed:', error.message);
      return { error: 'Incorrect code' };
    }

    /* Successful Supabase login — reset rate-limit counters */
    onLoginSuccess();

    const session = data.session!;
    const user = data.user!;

    /* Build profile from user_metadata using the host app's reverse
       transformer (profileExtractor is the inverse of profileToMetadata) */
    const profileExtractor = engineConfig.auth?.profileExtractor;
    const userMeta = user.user_metadata || {};
    const profile = profileExtractor ? profileExtractor(userMeta) : userMeta;

    /* Build and write local config — this is the first time this device
       has any knowledge of the account */
    const gateHash = await hashValue(pin);
    const now = new Date().toISOString();

    const config: SingleUserConfig = {
      id: CONFIG_ID,
      gateType,
      codeLength,
      gateHash,
      email,
      profile,
      supabaseUserId: user.id,
      setupAt: now,
      updatedAt: now
    };
    await writeConfig(config);

    /* Check device verification */
    const deviceVerificationEnabled = engineConfig.auth?.deviceVerification?.enabled ?? false;
    if (deviceVerificationEnabled) {
      const trusted = await isDeviceTrusted(user.id);
      if (!trusted) {
        debugLog('[SingleUser] linkSingleUserDevice: untrusted device, sending OTP');
        const { error: otpError } = await sendDeviceVerification(email);
        if (otpError) {
          debugError('[SingleUser] Failed to send device verification:', otpError);
        }
        return {
          error: null,
          deviceVerificationRequired: true,
          maskedEmail: maskEmail(email)
        };
      }
      await touchTrustedDevice(user.id);
    }

    /* Cache offline credentials */
    try {
      await cacheOfflineCredentials(email, pin, user, session);
    } catch (e) {
      debugWarn('[SingleUser] Failed to cache offline credentials on link:', e);
    }

    /* Create offline session */
    try {
      await createOfflineSession(user.id);
    } catch (e) {
      debugWarn('[SingleUser] Failed to create offline session on link:', e);
    }

    authState.setSupabaseAuth(session);
    debugLog('[SingleUser] Device linked successfully, userId:', user.id);

    return { error: null };
  } catch (e) {
    debugError('[SingleUser] linkSingleUserDevice error:', e);
    return { error: e instanceof Error ? e.message : 'Failed to link device' };
  }
}

/**
 * Reset the remote single-user account via the `reset_single_user()` Supabase RPC.
 *
 * This is a full destructive reset that:
 * 1. Calls the server-side `reset_single_user()` RPC to delete the user account.
 * 2. Signs out of Supabase to clear the in-memory session.
 * 3. Clears all local IndexedDB state (config, offline credentials, offline session).
 * 4. Removes Supabase session tokens from localStorage.
 *
 * After this, the app returns to its initial un-configured state on all devices.
 *
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @security This permanently deletes the Supabase user account. The operation
 *   cannot be undone. The RPC should be secured with appropriate RLS policies.
 *
 * @see {@link resetSingleUser} for a local-only reset that preserves the server account
 */
export async function resetSingleUserRemote(): Promise<{ error: string | null }> {
  if (isDemoMode()) return { error: null };
  try {
    const { error } = await supabase.rpc('reset_single_user');
    if (error) {
      debugError('[SingleUser] resetSingleUserRemote RPC error:', error.message);
      return { error: error.message };
    }

    /* Sign out to clear in-memory session and persisted auth tokens */
    try {
      await supabase.auth.signOut();
    } catch {
      /* Ignore — session may already be invalid after account deletion */
    }

    /* Clear local IndexedDB state: config, offline credentials, offline session */
    try {
      const db = getDb();
      await db.table('singleUserConfig').delete(CONFIG_ID);
      await db.table('offlineCredentials').delete('current_user');
      await db.table('offlineSession').delete('current_session');
    } catch (e) {
      debugWarn('[SingleUser] Failed to clear local state on remote reset:', e);
    }

    /* Clear any remaining Supabase session tokens from localStorage.
       Supabase stores tokens under keys prefixed with 'sb-'. */
    try {
      if (typeof localStorage !== 'undefined') {
        const keys = Object.keys(localStorage).filter((k) => k.startsWith('sb-'));
        keys.forEach((k) => localStorage.removeItem(k));
      }
    } catch {
      /* Ignore storage errors (e.g., in SSR or restricted environments) */
    }

    debugLog('[SingleUser] Remote reset complete');
    return { error: null };
  } catch (e) {
    debugError('[SingleUser] resetSingleUserRemote error:', e);
    return { error: e instanceof Error ? e.message : 'Remote reset failed' };
  }
}
