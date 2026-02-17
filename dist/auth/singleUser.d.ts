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
export declare function padPin(pin: string): string;
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
export declare function isSingleUserSetUp(): Promise<boolean>;
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
export declare function getSingleUserInfo(): Promise<{
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
} | null>;
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
export declare function setupSingleUser(gate: string, profile: Record<string, unknown>, email: string): Promise<{
    error: string | null;
    confirmationRequired: boolean;
}>;
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
export declare function completeSingleUserSetup(): Promise<{
    error: string | null;
}>;
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
export declare function unlockSingleUser(gate: string): Promise<{
    error: string | null;
    deviceVerificationRequired?: boolean;
    maskedEmail?: string;
    retryAfterMs?: number;
}>;
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
export declare function completeDeviceVerification(tokenHash?: string): Promise<{
    error: string | null;
}>;
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
export declare function pollDeviceVerification(): Promise<boolean>;
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
export declare function lockSingleUser(): Promise<void>;
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
export declare function changeSingleUserGate(oldGate: string, newGate: string): Promise<{
    error: string | null;
}>;
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
export declare function updateSingleUserProfile(profile: Record<string, unknown>): Promise<{
    error: string | null;
}>;
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
export declare function changeSingleUserEmail(newEmail: string): Promise<{
    error: string | null;
    confirmationRequired: boolean;
}>;
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
export declare function completeSingleUserEmailChange(): Promise<{
    error: string | null;
    newEmail: string | null;
}>;
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
export declare function resetSingleUser(): Promise<{
    error: string | null;
}>;
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
export declare function fetchRemoteGateConfig(): Promise<{
    /** The user's email address. */
    email: string;
    /** The gate type ('code' or 'password'). */
    gateType: string;
    /** The numeric code length (4 or 6). */
    codeLength: number;
    /** The user's profile metadata. */
    profile: Record<string, unknown>;
} | null>;
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
export declare function linkSingleUserDevice(email: string, pin: string): Promise<{
    error: string | null;
    deviceVerificationRequired?: boolean;
    maskedEmail?: string;
    retryAfterMs?: number;
}>;
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
export declare function resetSingleUserRemote(): Promise<{
    error: string | null;
}>;
//# sourceMappingURL=singleUser.d.ts.map