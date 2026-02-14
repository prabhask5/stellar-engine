/**
 * @fileoverview Email confirmation helpers for the `/confirm` route.
 *
 * Extracts the OTP verification + device trust + error translation logic
 * so the scaffolded confirm page can focus on UI.
 */
/** Result of an email confirmation attempt. */
export interface ConfirmResult {
    success: boolean;
    error?: string;
}
/**
 * Handles email confirmation: verifies the OTP token, trusts the pending
 * device for device-verification types, and translates Supabase error
 * messages to user-friendly strings.
 *
 * @param tokenHash - The `token_hash` from the confirmation URL query params.
 * @param type      - The verification type from Supabase (`signup`, `email`, `email_change`, `magiclink`).
 * @returns `{ success: true }` on success, or `{ success: false, error }` on failure.
 */
export declare function handleEmailConfirmation(tokenHash: string, type: 'signup' | 'email' | 'email_change' | 'magiclink'): Promise<ConfirmResult>;
/**
 * Broadcasts an auth confirmation event via `BroadcastChannel` so other
 * tabs (e.g. the login page) can pick up the auth state change.
 *
 * @param channelName - The BroadcastChannel name (must match the login page).
 * @param type        - The verification type to include in the message.
 */
export declare function broadcastAuthConfirmed(channelName: string, type: string): Promise<'closed' | 'can_close' | 'no_broadcast'>;
//# sourceMappingURL=confirm.d.ts.map