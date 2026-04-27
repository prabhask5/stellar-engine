/**
 * @fileoverview Device Verification Module
 *
 * Manages the trusted device registry and email-based OTP verification flow.
 * When device verification is
 * enabled, only devices present in the Supabase `trusted_devices` table (with
 * a recent `last_used_at` timestamp) are allowed to proceed after
 * authentication. Untrusted devices must complete an email OTP challenge.
 *
 * ## Architecture
 *
 * - **Device identification**: Each browser/device is assigned a persistent
 *   unique ID via {@link getDeviceId} (stored in localStorage). This ID is
 *   used as the key in the `trusted_devices` table.
 * - **Trust expiry**: Trusted devices expire after a configurable number of
 *   days (default: 90). The `last_used_at` column is refreshed on each
 *   successful login via {@link touchTrustedDevice}.
 * - **OTP flow**: Uses Supabase `signInWithOtp()` with `shouldCreateUser: false`
 *   to send a magic link email. The originating device's ID and label are
 *   embedded directly in the `emailRedirectTo` URL as query params
 *   (`pending_device_id`, `pending_device_label`). The confirm page reads them
 *   from the URL and trusts exactly that device — no shared mutable state.
 * - **Cross-device verification**: Because the device ID travels inside the
 *   email link itself, each OTP is 1:1 with its originating device. Concurrent
 *   OTPs from multiple devices are fully isolated with no race condition.
 *
 * ## Database Schema
 *
 * The `trusted_devices` table has a unique constraint on `(user_id, device_id, app_prefix)`:
 *
 * | Column       | Type      | Description                           |
 * |-------------|-----------|---------------------------------------|
 * | id          | uuid      | Primary key                           |
 * | user_id     | uuid      | FK to auth.users                      |
 * | device_id   | text      | Persistent browser/device identifier  |
 * | device_label| text      | Human-readable label (e.g., "Chrome on macOS") |
 * | app_prefix  | text      | App prefix for multi-tenant isolation  |
 * | trusted_at  | timestamp | When the device was first trusted     |
 * | last_used_at| timestamp | Last successful login from this device |
 *
 * ## Security Considerations
 *
 * - **Device ID spoofing**: The device ID is stored in localStorage and can be
 *   copied. This provides convenience-level trust, not cryptographic assurance.
 *   An attacker who clones localStorage can impersonate a trusted device.
 * - **OTP security**: OTP tokens are single-use and time-limited (configured
 *   in Supabase). The `shouldCreateUser: false` flag prevents account creation
 *   via the OTP endpoint.
 * - **Trust duration**: The default 90-day trust window balances convenience
 *   and security. Reduce this for higher-security applications.
 * - **RLS**: The `trusted_devices` table should have Row Level Security
 *   policies ensuring users can only read/write their own device records.
 * - **URL param trust**: `pending_device_id` travels in the email link URL.
 *   It controls only which device is trusted after a valid `token_hash`
 *   verification — not whether trust is granted at all. Tampering with this
 *   param requires intercepting the email delivery chain, which already gives
 *   full account compromise via the token itself. `pending_device_label` is
 *   capped at 100 characters before storage to prevent oversized DB writes.
 *
 * @module deviceVerification
 * @see {@link singleUser} for how device verification integrates into the auth flow
 */
import type { TrustedDevice } from '../types';
/**
 * Generate a human-readable device label from the browser's User-Agent string.
 *
 * Detects common browsers (Chrome, Firefox, Edge, Safari) and operating systems
 * (macOS, Windows, Linux, iOS, Android, ChromeOS). Returns a combined label
 * like "Chrome on macOS" for display in device management UIs.
 *
 * @returns A human-readable label describing the current browser and OS, or
 *   "Unknown device" in non-browser environments.
 *
 * @example
 * ```ts
 * getDeviceLabel(); // => "Chrome on macOS"
 * getDeviceLabel(); // => "Safari on iOS"
 * getDeviceLabel(); // => "Firefox on Linux"
 * ```
 */
export declare function getDeviceLabel(): string;
/**
 * Mask an email address for safe display in the UI.
 *
 * Shows the first 2 characters of the local part, replaces the rest with
 * bullet characters, and preserves the full domain. This prevents shoulder-
 * surfing while still letting the user confirm it's the right email.
 *
 * @param email - The full email address to mask.
 * @returns The masked email string (e.g., "pr\u2022\u2022\u2022\u2022@gmail.com").
 *
 * @example
 * ```ts
 * maskEmail('prabhask@gmail.com');  // => "pr••••••@gmail.com"
 * maskEmail('ab@example.com');      // => "ab@example.com"
 * maskEmail('a@test.io');           // => "a•@test.io"
 * ```
 *
 * @security This is a display-only mask. The original email should never be
 *   exposed in logs or error messages shown to untrusted contexts.
 */
export declare function maskEmail(email: string): string;
/**
 * Check if the current device is trusted for a given user.
 *
 * Queries the `trusted_devices` table for a record matching the current
 * device ID and user ID, with `last_used_at` within the configured trust
 * duration window. Returns `false` on any error (fail-closed).
 *
 * @param userId - The Supabase user ID to check trust for.
 * @returns `true` if the device is trusted and not expired, `false` otherwise.
 *
 * @example
 * ```ts
 * if (await isDeviceTrusted(user.id)) {
 *   grantAccess();
 * } else {
 *   challengeWithOtp();
 * }
 * ```
 *
 * @security Fails closed: any error (network, RLS, etc.) returns `false`,
 *   forcing the device verification flow rather than granting access.
 */
export declare function isDeviceTrusted(userId: string): Promise<boolean>;
/**
 * Trust the current device for a user.
 *
 * Creates or updates a record in the `trusted_devices` table using upsert on
 * the `(user_id, device_id)` unique constraint. Both `trusted_at` and
 * `last_used_at` are set to the current time.
 *
 * @param userId - The Supabase user ID to associate the trust record with.
 *
 * @example
 * ```ts
 * // After successful OTP verification:
 * await trustCurrentDevice(user.id);
 * ```
 *
 * @see {@link trustPendingDevice} for trusting the originating device after OTP confirmation
 */
export declare function trustCurrentDevice(userId: string): Promise<void>;
/**
 * Update `last_used_at` for the current device (called on each successful login).
 *
 * This extends the trust window so that frequently-used devices do not expire.
 * Also refreshes the device label in case the browser or OS was updated.
 *
 * @param userId - The Supabase user ID whose device record to update.
 *
 * @see {@link isDeviceTrusted} which checks the `last_used_at` timestamp
 */
export declare function touchTrustedDevice(userId: string): Promise<void>;
/**
 * Get all trusted devices for a user, ordered by most recently used first.
 *
 * Used by device management UIs to display a list of trusted devices with
 * options to revoke trust.
 *
 * @param userId - The Supabase user ID to fetch devices for.
 * @returns An array of {@link TrustedDevice} objects, or an empty array on error.
 *
 * @example
 * ```ts
 * const devices = await getTrustedDevices(user.id);
 * devices.forEach(d => {
 *   console.log(`${d.deviceLabel} — last used ${d.lastUsedAt}`);
 * });
 * ```
 *
 * @see {@link removeTrustedDevice} for revoking trust on a specific device
 */
export declare function getTrustedDevices(userId: string): Promise<TrustedDevice[]>;
/**
 * Remove a trusted device by its primary key ID.
 *
 * Used by the device management UI to allow users to revoke trust on devices
 * they no longer control (e.g., lost phone, sold laptop). After removal, the
 * device will be challenged with OTP verification on its next login.
 *
 * @param id - The UUID primary key of the `trusted_devices` row to delete.
 *
 * @example
 * ```ts
 * // Revoke trust on a specific device:
 * await removeTrustedDevice('550e8400-e29b-41d4-a716-446655440000');
 * ```
 *
 * @security Ensure RLS policies restrict deletion to the owning user.
 */
export declare function removeTrustedDevice(id: string): Promise<void>;
/**
 * Send a device verification OTP email to the user.
 *
 * Builds an `emailRedirectTo` URL containing the originating device's ID and
 * label as query params (`pending_device_id`, `pending_device_label`), then
 * sends an OTP email via `signInWithOtp()` with `shouldCreateUser: false` to
 * prevent account creation through this endpoint.
 *
 * Each email is 1:1 with the device that sent it — no shared `user_metadata`
 * field, so concurrent OTPs from multiple devices cannot interfere.
 *
 * The existing session is intentionally kept alive so that
 * {@link pollDeviceVerification} can continue checking trust status.
 *
 * @param email - The user's email address to send the OTP to.
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @security The `shouldCreateUser: false` flag prevents this endpoint from
 *   being abused to create new accounts. The OTP is time-limited and
 *   single-use (configured in Supabase dashboard).
 *
 * @see {@link verifyDeviceCode} for verifying the OTP token
 * @see {@link trustPendingDevice} for trusting the originating device from the confirm page
 */
export declare function sendDeviceVerification(email: string): Promise<{
    error: string | null;
}>;
/**
 * Trust the device that originated a verification OTP.
 *
 * Called from the confirm page after a device OTP is verified. Accepts the
 * originating device ID and label directly from the email redirect URL — no
 * shared `user_metadata` field, so concurrent OTPs from multiple devices
 * each trust only their own originating device.
 *
 * ## Cross-Device Flow
 *
 * 1. Device A sends OTP → redirect URL contains Device A's ID as query params.
 * 2. User opens the link (on Device A or Device B).
 * 3. Confirm page passes `pendingDeviceId` / `pendingDeviceLabel` here.
 * 4. This function upserts only Device A into `trusted_devices`.
 * 5. Device A polls via {@link pollDeviceVerification} and discovers it's now trusted.
 *
 * If `pendingDeviceId` is not provided (edge case: old-format links), falls
 * back to trusting the current device.
 *
 * @param pendingDeviceId    - Device ID from the email redirect URL query param.
 * @param pendingDeviceLabel - Device label from the email redirect URL query param.
 *
 * @example
 * ```ts
 * // Called from the /confirm page after OTP verification:
 * await trustPendingDevice(pendingDeviceId, pendingDeviceLabel);
 * ```
 *
 * @see {@link sendDeviceVerification} which embeds the device ID in the redirect URL
 */
export declare function trustPendingDevice(pendingDeviceId?: string, pendingDeviceLabel?: string): Promise<void>;
/**
 * Verify a device verification OTP token hash from an email link.
 *
 * Called from the confirm page with the `token_hash` query parameter extracted
 * from the magic link URL. On success, Supabase establishes a session for the
 * user, which enables subsequent calls to trust devices.
 *
 * @param tokenHash - The token hash from the email link's URL query parameters.
 * @returns An object with `error` (string or null).
 *
 * @throws Never throws directly; all errors are caught and returned.
 *
 * @example
 * ```ts
 * // On the /confirm page:
 * const params = new URLSearchParams(window.location.search);
 * const tokenHash = params.get('token_hash');
 * if (tokenHash) {
 *   const result = await verifyDeviceCode(tokenHash);
 *   if (!result.error) {
 *     await trustPendingDevice();
 *   }
 * }
 * ```
 *
 * @see {@link sendDeviceVerification} which sends the OTP email
 * @see {@link trustPendingDevice} which should be called after successful verification
 */
export declare function verifyDeviceCode(tokenHash: string): Promise<{
    error: string | null;
}>;
/**
 * Get the current device's persistent unique identifier.
 *
 * Exposed as a convenience for consumers who need to reference the device ID
 * (e.g., for display in a device management UI or for debugging).
 *
 * @returns The persistent device ID string from localStorage.
 *
 * @see {@link getDeviceId} from the `deviceId` module for the underlying implementation
 */
export declare function getCurrentDeviceId(): string;
//# sourceMappingURL=deviceVerification.d.ts.map