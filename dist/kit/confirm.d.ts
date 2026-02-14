/**
 * @fileoverview Email confirmation helpers for the `/confirm` route.
 *
 * This module extracts the OTP verification, device trust, error translation,
 * and cross-tab broadcast logic so that the scaffolded confirmation page can
 * focus purely on UI rendering. It handles the full lifecycle of an email
 * confirmation link click:
 *
 *   1. Verify the OTP token hash with Supabase
 *   2. Trust the originating device (for device-verification flows)
 *   3. Translate raw Supabase errors into user-friendly messages
 *   4. Broadcast the confirmation to other open tabs via BroadcastChannel
 *   5. Attempt to auto-close the confirmation tab
 *
 * @module kit/confirm
 *
 * @example
 * ```ts
 * // In /confirm/+page.svelte onMount
 * const result = await handleEmailConfirmation(tokenHash, type);
 * if (result.success) {
 *   await broadcastAuthConfirmed('auth-channel', type);
 * }
 * ```
 *
 * @see {@link verifyOtp} in `supabase/auth.ts` for the underlying OTP call
 * @see {@link trustPendingDevice} in `auth/deviceVerification.ts` for device trust logic
 */
/**
 * Result of an email confirmation attempt.
 *
 * Provides a simple success/failure discriminator with an optional
 * user-friendly error message when the confirmation fails.
 */
export interface ConfirmResult {
    /** Whether the OTP verification completed successfully. */
    success: boolean;
    /**
     * A user-facing error message explaining why confirmation failed.
     * Only present when `success` is `false`.
     */
    error?: string;
}
/**
 * Handles the full email confirmation flow: verifies the OTP token hash,
 * optionally trusts the pending device, and translates Supabase error
 * messages into user-friendly strings.
 *
 * The function normalizes the `type` parameter before passing it to Supabase
 * (e.g. `'magiclink'` maps to `'email'` for OTP verification purposes) and
 * applies a tiered error classification to produce contextual error messages.
 *
 * @param tokenHash - The `token_hash` extracted from the confirmation URL
 *                    query parameters (provided by Supabase in the email link).
 * @param type      - The verification type from Supabase, indicating what kind
 *                    of email action triggered the confirmation. One of:
 *                    - `'signup'` — new account registration
 *                    - `'email'` — email change or device verification
 *                    - `'email_change'` — explicit email address change
 *                    - `'magiclink'` — passwordless login link
 *
 * @returns A promise resolving to `{ success: true }` on successful
 *          verification, or `{ success: false, error: string }` on failure
 *          with a translated error message.
 *
 * @example
 * ```ts
 * const result = await handleEmailConfirmation(tokenHash, 'signup');
 * if (!result.success) {
 *   showError(result.error);
 * }
 * ```
 *
 * @see {@link ConfirmResult} for the return type shape
 * @see {@link verifyOtp} for the underlying Supabase OTP verification
 */
export declare function handleEmailConfirmation(tokenHash: string, type: 'signup' | 'email' | 'email_change' | 'magiclink'): Promise<ConfirmResult>;
/**
 * Broadcasts an auth confirmation event via `BroadcastChannel` so other
 * open tabs (e.g. the login page that initiated the email flow) can detect
 * the completed authentication and update their UI accordingly.
 *
 * After broadcasting, the function waits briefly for the receiving tab to
 * process the message, then attempts to auto-close this confirmation tab.
 * If the browser blocks `window.close()` (common for tabs not opened via
 * `window.open()`), the function returns `'can_close'` so the UI can show
 * a "you may close this tab" message instead.
 *
 * @param channelName - The `BroadcastChannel` name. Must match the channel
 *                      name used by the login page listener.
 * @param type        - The verification type to include in the broadcast
 *                      message payload, so the receiver knows which flow
 *                      completed.
 *
 * @returns A promise resolving to one of:
 *   - `'closed'`       — tab was successfully closed (caller won't see this)
 *   - `'can_close'`    — broadcast sent but tab could not auto-close
 *   - `'no_broadcast'` — BroadcastChannel API not available (SSR or old browser)
 *
 * @example
 * ```ts
 * const status = await broadcastAuthConfirmed('stellar-auth', 'signup');
 * if (status === 'can_close') {
 *   showMessage('You can close this tab.');
 * }
 * ```
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel}
 */
export declare function broadcastAuthConfirmed(channelName: string, type: string): Promise<'closed' | 'can_close' | 'no_broadcast'>;
//# sourceMappingURL=confirm.d.ts.map